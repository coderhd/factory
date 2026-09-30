import type { StateStore } from '../state/store';
import type { VerificationDesired } from '../config/factoryConfig';
import {
  createVerificationEngine,
  VerificationConfigurationError,
  type CheckProvider,
} from './engine';
import { createE5Verifier, type WorkVerifier } from './orchestrator';
import type { SemanticJudge } from './semantic';

export { VerificationConfigurationError };

/**
 * E10.1 (#39) production verifier composition (spec §9, §14).
 *
 * `createE5Verifier` and the E5 engine existed but had no non-test caller, so a
 * real `factory start` wired no verifier and parked a SUCCESS Task forever. This
 * module is the missing production composition root: from a validated
 * `verification:` config it builds the E5 engine (registering the configured
 * command checks), binds the independent semantic judge, and returns a live
 * `WorkVerifier` — the exact seam the scheduler drives.
 *
 * The judge that actually calls a model and the subprocess that runs a command
 * are deployment seams, not this module's business: production supplies real
 * implementations, tests supply hermetic fakes. Composition itself is validated
 * here, defence-in-depth on top of `factoryConfig`'s parse gate — a misconfigured
 * verifier is refused loudly, never silently parked as a green run.
 */

/** The validated verification config consumed by production composition. */
export type VerificationConfig = VerificationDesired;

/**
 * The seam over process execution for a configured command check. Production
 * runs the command for real; tests inject a fake so the suite stays hermetic
 * (Ruling R5 — no subprocess, no network).
 */
export interface CommandRunner {
  (input: { command: string; cwd: string }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

/** Run a command through the shell, capturing its exit code and output. */
const defaultCommandRunner: CommandRunner = async ({ command, cwd }) => {
  const proc = Bun.spawn(['sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
};

/** Exit code is the check's verdict, but the evidence always carries output. */
function evidenceSummary(command: string, exitCode: number, stdout: string, stderr: string): string {
  const output = [stdout, stderr].filter((line) => line.length > 0).join(' | ');
  return output.length > 0
    ? `${command} exited ${exitCode}: ${output}`
    : `${command} exited ${exitCode}`;
}

/**
 * Build a command-backed {@link CheckProvider}: the configured command runs in
 * the deployment working directory, and its exit code is the pass/fail verdict.
 * A provider that cannot produce usable evidence cannot pass (the engine's own
 * rule) — a runner that throws surfaces as a structured check failure.
 */
function commandCheckProvider(
  check: VerificationConfig['checks'][number],
  workingDirectory: string,
  runCommand: CommandRunner,
): CheckProvider {
  return {
    id: check.id,
    category: check.category,
    kind: check.kind as CheckProvider['kind'],
    async run() {
      const result = await runCommand({ command: check.command, cwd: workingDirectory });
      const summary = evidenceSummary(check.command, result.exitCode, result.stdout, result.stderr);
      if (result.exitCode === 0) {
        return { passed: true, evidence: { summary } };
      }
      return {
        passed: false,
        evidence: { summary },
        diagnosis: `${check.id} check failed: ${check.command} exited ${result.exitCode}`,
        action: `fix the ${check.id} failure and re-run verification`,
      };
    },
  };
}

export interface ProductionVerifierOptions {
  config: VerificationConfig;
  store: StateStore;
  /** The deployment working directory command checks run in (the repository). */
  workingDirectory: string;
  /**
   * The independent semantic judge. Required: without a judge that can be proven
   * different from the writer, composition cannot produce a bundle, so a missing
   * judge is refused rather than wired as a vacuous pass.
   */
  judge?: SemanticJudge;
  /** Command executor seam; defaults to a real shell runner. */
  runCommand?: CommandRunner;
  /** Bundle-id seam (tests); defaults to a generated id. */
  bundleId?: () => string;
  now?: () => string;
}

/**
 * Compose a live {@link WorkVerifier} from validated config. Fails closed: any
 * invalid configuration (duplicate/unknown checks, missing judge) throws a
 * {@link VerificationConfigurationError} before a verifier is returned.
 */
export function createProductionVerifier(options: ProductionVerifierOptions): WorkVerifier {
  const { config, store, workingDirectory } = options;
  if (!config.judge || !config.judge.provider || !config.judge.model) {
    throw new VerificationConfigurationError(
      'production verifier requires a configured judge identity (provider + model)',
    );
  }
  if (!options.judge) {
    throw new VerificationConfigurationError(
      'production verifier requires a semantic judge implementation (the model-calling seam)',
    );
  }
  // The configured identity is authoritative provenance. A supplied judge that
  // declares a different provider/model is a misconfiguration — the bundle must
  // attest the model that actually ruled, and a mismatch would forge the
  // writer ≠ verifier attestation. Refuse it rather than record a false receipt.
  const declared = options.judge.identity;
  if (
    declared &&
    (declared.provider !== config.judge.provider || declared.model !== config.judge.model)
  ) {
    throw new VerificationConfigurationError(
      `production verifier judge identity "${declared.provider}/${declared.model}" does not match the configured judge identity "${config.judge.provider}/${config.judge.model}"`,
    );
  }
  const runCommand = options.runCommand ?? defaultCommandRunner;

  // `registerCheck` itself rejects duplicate ids and category/kind mismatches
  // (the same rules `factoryConfig` parses against), so composition inherits
  // the engine's configuration gate as the single source of truth.
  const engine = createVerificationEngine();
  for (const check of config.checks) {
    engine.registerCheck(commandCheckProvider(check, workingDirectory, runCommand));
  }

  // The configured judge identity is authoritative for provenance; only the
  // model-calling behavior comes from the deployment seam.
  const judge: SemanticJudge = {
    identity: {
      provider: config.judge.provider,
      model: config.judge.model,
      ...(config.judge.family ? { family: config.judge.family } : {}),
      ...(config.judge.version ? { version: config.judge.version } : {}),
    },
    falsify: (context) => options.judge!.falsify(context),
  };

  return createE5Verifier({
    store,
    engine,
    judge,
    prompt: { id: config.prompt.id, version: config.prompt.version },
    rubric: [...config.rubric],
    ...(options.bundleId ? { bundleId: options.bundleId } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
