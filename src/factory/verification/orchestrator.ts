import type { Attempt, Task, WorkOrder } from '../domain/workOrder';
import type { StateStore } from '../state/store';
import { buildEvidenceBundle, type EvidenceBundle } from '../evidence/bundle';
import {
  changeSetFromAttempt,
  VerificationConfigurationError,
  type CheckProvider,
  type FailureRecord,
  type VerificationEngine,
  type VerificationRun,
} from './engine';
import {
  createSemanticVerifier,
  modelKey,
  type ModelIdentity,
  type PromptProvenance,
  type SemanticFailure,
  type SemanticJudge,
} from './semantic';

/**
 * E9.4 (#30) verification + evidence orchestration (spec §9, §14).
 *
 * The E5 tiers are pure verification modules: the engine runs registered check
 * providers, the semantic verifier falsifies acceptance criteria from a fresh
 * context, and `buildEvidenceBundle` assembles the immutable receipt. Nothing
 * called them on the live task lifecycle. This module is the missing caller: it
 * runs both tiers against a Task's change set, assembles the Evidence Bundle,
 * and returns a structured outcome the scheduler routes.
 *
 * Writer ≠ Verifier (§9) is enforced live: the semantic verifier is built from
 * the generating Attempt's model. A judge carrying the same model identity is a
 * same-model self-sign-off and cannot produce a bundle — the outcome is a
 * rejection, never a pass. A verifier that cannot produce evidence also cannot
 * pass: every rejection and every failure is structured, and no rejection
 * yields a bundle.
 *
 * The verifier never mutates the implementation: it works on a change set
 * derived from the Attempt and hands the tiers private copies.
 */

/** The Task, Work Order and generating Attempt under verification. */
export interface VerificationSubject {
  workOrder: WorkOrder;
  task: Task;
  attempt: Attempt;
}

/**
 * The outcome of one live verification. Either a bundle was produced (pass or
 * fail, with structured failures) or verification was refused before a receipt
 * could exist (`rejection`), which is never a pass.
 */
export interface VerificationOutcome {
  /** The immutable receipt, or `null` when verification was rejected. */
  bundle: Readonly<EvidenceBundle> | null;
  /** True only when the bundle's `complete` gate passed. */
  passed: boolean;
  /** Every tier's structured failure (spec §14.4). Empty on a pass. */
  failures: FailureRecord[];
  /**
   * Set when no bundle could be produced — a writer ≠ verifier violation, a
   * misconfigured run, or a repository/model mismatch. Fail closed.
   */
  rejection: string | null;
}

/** The scheduler's seam over live verification: run E5 and return the outcome. */
export interface WorkVerifier {
  verify(subject: VerificationSubject): Promise<VerificationOutcome>;
}

export interface E5VerifierOptions {
  store: StateStore;
  engine: VerificationEngine;
  judge: SemanticJudge;
  prompt: PromptProvenance;
  rubric: string[];
  /** Provider label for the writer identity derived from the Attempt's model. */
  provider?: string;
  /** Optional clock override; defaults to now. */
  now?: () => string;
  /** Optional bundle-id override (tests); defaults to a generated `eb_` id. */
  bundleId?: () => string;
}

/**
 * Map every acceptance criterion to every registered check, unless the caller
 * registered a criterion-specific mapping. The default is deliberately
 * conservative: a criterion passes only when *all* checks pass, so no criterion
 * is silently `unmapped` and no single passing check certifies the others.
 */
function defaultCriterionChecks(
  engine: VerificationEngine,
  criteria: string[],
): Record<string, string[]> {
  const checkIds = engine.listChecks().map((check: CheckProvider) => check.id);
  const mapping: Record<string, string[]> = {};
  for (const criterion of criteria) mapping[criterion] = [...checkIds];
  return mapping;
}

function toFailure(record: SemanticFailure): FailureRecord {
  const evidence = record.evidence.artifacts
    ? { summary: record.evidence.summary, artifacts: [...record.evidence.artifacts] }
    : { summary: record.evidence.summary };
  return { ...record, evidence };
}

/**
 * Dress the raw `Attempt.model` as a {@link ModelIdentity}. A `ModelId` is
 * opaque and may be recorded as either a bare model name (`judge-1`) or a full
 * `provider/model` key (`judge-co/judge-1`). The semantic tier's Writer ≠
 * Verifier check compares `model` strings, so a verbatim `provider/model` would
 * slip a same-model sign-off through (the writer's model never equals the
 * judge's bare model). Splitting the qualified form makes the comparison match
 * the judge identity — and keeps the bundle's `modelKey` cross-check consistent.
 */
function generatorIdentity(attemptModel: string, fallbackProvider: string): ModelIdentity {
  const slash = attemptModel.indexOf('/');
  if (slash > 0 && slash < attemptModel.length - 1) {
    return { provider: attemptModel.slice(0, slash), model: attemptModel.slice(slash + 1) };
  }
  return { provider: fallbackProvider, model: attemptModel };
}

/**
 * A structured failure for a bundle that is not `complete` yet recorded no
 * check failure — a zero-provider run (every criterion `unmapped`), a YELLOW/
 * RED Work Order lacking behavioral proof, a RED Work Order without a security
 * check, or an empty criterion set. Without this the REWORK would carry an
 * empty failure list and no diagnosis. Fail closed, but explain why.
 */
function gateShortfall(
  workOrder: WorkOrder,
  bundle: EvidenceBundle,
  run: VerificationRun,
): FailureRecord | null {
  const requiresBehavioral = workOrder.riskTier === 'YELLOW' || workOrder.riskTier === 'RED';
  const hasSecurityCheck =
    run.deterministic.checks.some((check) => check.kind === 'security') ||
    run.behavioral.checks.some((check) => check.kind === 'security');
  if (workOrder.riskTier === 'RED' && !hasSecurityCheck) {
    return {
      category: 'deterministic',
      criterion: null,
      verifier: 'verification-gate',
      evidence: { summary: 'no security-kind check for a RED Work Order' },
      diagnosis: 'RED Work Orders require at least one security-kind check',
      action: 'register a security check (e.g. security) and re-run verification',
    };
  }
  if (bundle.gates.run && bundle.gates.semantic) {
    if (requiresBehavioral && !bundle.gates.behavioral) {
      return {
        category: 'behavioral',
        criterion: null,
        verifier: 'verification-gate',
        evidence: { summary: `no behavioral proof for a ${workOrder.riskTier} Work Order` },
        diagnosis: `${workOrder.riskTier} Work Orders require behavioral verification evidence`,
        action: 'add a behavioral check (e.g. playwright, api, e2e) and re-run verification',
      };
    }
    return null;
  }
  // No check failure but the run or semantic gate fell short (e.g. no providers,
  // an empty criterion set, or a vacuous tier).
  const uncovered = bundle.criteria.filter((criterion) => criterion.status !== 'pass');
  return {
    category: 'deterministic',
    criterion: uncovered[0]?.criterion ?? null,
    verifier: 'verification-gate',
    evidence: {
      summary:
        uncovered.length > 0
          ? `criteria not covered by passing proof: ${uncovered.map((c) => c.criterion).join(', ')}`
          : 'no acceptance criterion was verified',
    },
    diagnosis:
      uncovered.length > 0
        ? 'every acceptance criterion must map to passing proof before the bundle is complete'
        : 'the Work Order has no acceptance criterion verified by a check with usable evidence',
    action: 'register checks, map each acceptance criterion to them, and re-run verification',
  };
}

/**
 * Build the live E5-backed verifier. Each task execution gets a fresh semantic
 * verifier bound to that Attempt's model, so writer ≠ verifier is checked
 * against the identity that actually wrote the change.
 */
export function createE5Verifier(options: E5VerifierOptions): WorkVerifier {
  const { store, engine, judge, prompt, rubric } = options;
  const provider = options.provider ?? 'factory';
  const now = options.now ?? (() => new Date().toISOString());

  async function verify(subject: VerificationSubject): Promise<VerificationOutcome> {
    const { workOrder, task, attempt } = subject;

    if (!attempt.model || attempt.model.trim().length === 0) {
      return {
        bundle: null,
        passed: false,
        failures: [],
        rejection: `cannot verify "${task.id}": the generating Attempt records no model, so writer ≠ verifier cannot be proven`,
      };
    }

    const changeSet = changeSetFromAttempt(attempt);
    const criteria = [...workOrder.acceptanceCriteria];
    const writer = generatorIdentity(attempt.model, provider);
    // Normalize the judge's identity the same way, so a qualified judge model
    // (`provider/model`) cannot collide with, or dodge, the writer comparison.
    const judgeModel = generatorIdentity(judge.identity.model, judge.identity.provider);
    const verifierIdentity: ModelIdentity = {
      ...judge.identity,
      provider: judgeModel.provider,
      model: judgeModel.model,
    };

    try {
      const run = await engine.verify(changeSet, {
        criteria,
        criterionChecks: defaultCriterionChecks(engine, criteria),
      });

      const semanticVerifier = createSemanticVerifier({
        judge: { ...judge, identity: verifierIdentity },
        generator: writer,
        prompt,
        rubric,
      });
      const semantic = await semanticVerifier.verify({
        workOrder,
        changeSet,
        deterministic: run.deterministic,
        behavioral: run.behavioral,
        criteria,
      });

      const attempts = store
        .list<Attempt>('attempts')
        .filter((candidate) => candidate.taskId === task.id);
      const bundle = buildEvidenceBundle({
        workOrder,
        changeSet,
        run,
        semantic,
        attempts,
        ...(options.bundleId ? { id: options.bundleId() } : {}),
        now: now(),
      });

      const failures: FailureRecord[] = [...run.failures, ...semantic.failures.map(toFailure)];
      // A bundle can fall short of `complete` without any check failing (no
      // providers, a YELLOW/RED Work Order lacking behavioral proof, an empty
      // criterion set). REWORK must still carry a structured diagnosis.
      if (!bundle.complete && failures.length === 0) {
        const shortfall = gateShortfall(workOrder, bundle, run);
        if (shortfall) failures.push(shortfall);
      }

      return { bundle, passed: bundle.complete, failures, rejection: null };
    } catch (error) {
      if (!(error instanceof VerificationConfigurationError)) throw error;
      // A same-model self-sign-off, an unmapped criterion or a mis-attributed
      // generator is refused before a receipt can exist. The scheduler records
      // the refusal and drives REWORK; verification never writes a bundle.
      return {
        bundle: null,
        passed: false,
        failures: [],
        rejection: `verification refused for "${task.id}": writer "${modelKey(writer)}" vs verifier "${modelKey(verifierIdentity)}" — ${error.message}`,
      };
    }
  }

  return { verify };
}
