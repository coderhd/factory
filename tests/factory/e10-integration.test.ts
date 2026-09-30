import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServerDeps } from '../../src/cli/factory';
import {
  DEFAULT_FACTORY_CONFIG,
  parseFactoryConfig,
  resolveFactoryConfig,
  serializeFactoryConfig,
  type FactoryDesiredConfig,
} from '../../src/factory/config/factoryConfig';
import {
  completeAttempt,
  createAttempt,
  createWorkOrder,
  transitionTask,
  transitionWorkOrder,
  type Attempt,
  type Task,
  type WorkOrder,
} from '../../src/factory/domain/workOrder';
import type { EvidenceBundle } from '../../src/factory/evidence/bundle';
import { commitDAG } from '../../src/factory/planning/dag';
import type { SemanticJudge } from '../../src/factory/verification/semantic';
import {
  createProductionVerifier,
  VerificationConfigurationError,
  type CommandRunner,
  type VerificationConfig,
} from '../../src/factory/verification/production';
import type { WorkerAdapter, WorkerStatus, ExecutionEnvelope, WorkerResult, WorkerAnswer } from '../../src/factory/workers/herdr';

/**
 * E10.1 (#39) — production verifier composition. These tests exercise the real
 * `buildServerDeps` composition path `factory start` uses (no injected
 * `WorkVerifier`): the verifier is composed from a validated `verification:`
 * config section, with the model judge and command executor supplied as
 * hermetic seams (Ruling R5 — no network, no real subprocess).
 */

let workDir: string;
let repoPath: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(root: string): string {
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' });
  git(['config', 'user.email', 'factory-test@example.com'], repo);
  git(['config', 'user.name', 'Factory Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  return repo;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'factory-e10-'));
  repoPath = initRepo(workDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake worker (Ruling R5 — never spawn a real runtime)
// ---------------------------------------------------------------------------

class FakeHerdr implements WorkerAdapter {
  async provision(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async status(): Promise<WorkerStatus> {
    return { state: 'running', lastHeartbeatAt: new Date().toISOString() };
  }
  async execute(_envelope: ExecutionEnvelope): Promise<void> {}
  async collectArtifacts(): Promise<WorkerResult> {
    return {
      status: 'failed',
      commits: [],
      artifacts: [],
      interactions: [],
      observations: [],
      verificationRequests: [],
      diff: null,
      failure: 'not run',
    };
  }
  async deliverAnswer(_answer: WorkerAnswer): Promise<void> {}
  async destroy(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Hermetic seams
// ---------------------------------------------------------------------------

/** A fake command runner: every configured check passes without a subprocess. */
function passingRunner(): CommandRunner {
  return async (input) => ({ exitCode: 0, stdout: `${input.command} ok`, stderr: '' });
}

/** A judge that falsifies nothing (independent from the writer). */
function passingJudge(model = 'judge-1'): SemanticJudge {
  return {
    identity: { provider: 'judge-co', model, family: 'judge-family' },
    falsify: (context) =>
      context.criteria.map((criterion) => ({
        criterion,
        falsified: false,
        evidence: { summary: `judge reviewed "${criterion}"` },
      })),
  };
}

const VERIFICATION: VerificationConfig = {
  judge: { provider: 'judge-co', model: 'judge-1', family: 'judge-family' },
  prompt: { id: 'factory-verify', version: '1' },
  rubric: ['Does the change set satisfy the criterion as written?'],
  checks: [
    { id: 'typecheck', category: 'deterministic', kind: 'typecheck', command: 'bun run typecheck' },
    { id: 'playwright', category: 'behavioral', kind: 'playwright', command: 'bun run e2e' },
  ],
};

/** A `factory.yaml` text with the fixture repo + an optional verification section. */
function configText(verification?: VerificationConfig): string {
  const withKeys: FactoryDesiredConfig = {
    ...DEFAULT_FACTORY_CONFIG,
    repository: { path: repoPath },
  };
  return verification
    ? serializeFactoryConfig({ ...withKeys, verification })
    : serializeFactoryConfig(withKeys);
}

function runtimeFrom(text: string): ReturnType<typeof resolveFactoryConfig> {
  const parsed = parseFactoryConfig(text);
  if (!parsed.ok) throw new Error(`fixture factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
  return resolveFactoryConfig(parsed.config, { baseDir: workDir });
}

/** Create a Work Order, commit a one-node DAG, move it to EXECUTING. */
function seedExecuting(deps: {
  store: ReturnType<typeof buildServerDeps>['store'];
  events: ReturnType<typeof buildServerDeps>['events'];
}): { wo: WorkOrder; task: Task } {
  const wo = createWorkOrder(deps, { intent: 'E10 subject', acceptanceCriteria: ['accepted'] });
  for (const to of ['READY', 'PLANNING'] as const) transitionWorkOrder(deps, wo.id, { to });
  const dag = commitDAG(deps, wo.id, { nodes: [{ nodeId: 'a', title: 'A' }] });
  transitionWorkOrder(deps, wo.id, { to: 'EXECUTING' });
  return { wo, task: deps.store.get<Task>('tasks', dag.nodes[0].taskId)! };
}

/** Drive a seeded Task to SUCCESS with a completed Attempt written by `model`. */
function driveToSuccess(
  deps: {
    store: ReturnType<typeof buildServerDeps>['store'];
    events: ReturnType<typeof buildServerDeps>['events'];
  },
  taskId: string,
  model: string,
): Attempt {
  const attempt = createAttempt(deps, { taskId, model });
  completeAttempt(deps, attempt.id, {
    outcome: 'success',
    diff: 'diff --git a/x b/x\n+export const x = 1;',
    artifactIds: ['art_1'],
  });
  for (const to of ['READY', 'ASSIGNED', 'RUNNING', 'SUCCESS'] as const) {
    transitionTask(deps, taskId, { to });
  }
  return deps.store.get<Attempt>('attempts', attempt.id)!;
}

/** Run a tick, let the async verification settle, then route it on the next tick. */
async function verifyTick(scheduler: NonNullable<ReturnType<typeof buildServerDeps>['scheduler']>): Promise<void> {
  scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  scheduler.tick();
}

// ---------------------------------------------------------------------------
// AC1 — the production composition drives a SUCCESS Task to HUMAN_GATE
// ---------------------------------------------------------------------------

describe('E10.1 production verifier composition', () => {
  it('composes the E5 verifier from config and drives a task through verification to HUMAN_GATE', async () => {
    const runtime = runtimeFrom(configText(VERIFICATION));
    // No `verifier` injected: `buildServerDeps` composes it from the config. The
    // judge + command executor are hermetic seams, not a verifier.
    const deps = buildServerDeps(runtime, {
      spawn: () => new FakeHerdr(),
      verification: { judge: passingJudge(), runCommand: passingRunner() },
    });
    try {
      const { wo, task } = seedExecuting(deps);
      driveToSuccess(deps, task.id, 'writer-xl');

      await verifyTick(deps.scheduler!);

      const bundles = deps.store.list<EvidenceBundle>('evidence_bundles');
      expect(bundles).toHaveLength(1);
      expect(bundles[0]!.complete).toBe(true);
      expect(bundles[0]!.workOrderId).toBe(wo.id);
      expect(deps.store.get<Task>('tasks', task.id)!.state).toBe('VERIFIED');
      expect(deps.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('HUMAN_GATE');
    } finally {
      deps.store.close();
    }
  });

  it('fails closed when the config has no verification section: the SUCCESS task parks, no bundle', async () => {
    const runtime = runtimeFrom(configText());
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      const deps = buildServerDeps(runtime, { spawn: () => new FakeHerdr() });
      try {
        const { wo, task } = seedExecuting(deps);
        driveToSuccess(deps, task.id, 'writer-xl');

        await verifyTick(deps.scheduler!);

        expect(deps.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
        expect(deps.store.get<Task>('tasks', task.id)!.state).toBe('SUCCESS');
        expect(deps.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('EXECUTING');
        expect(errors.some((line) => /verifier/i.test(line))).toBe(true);
      } finally {
        deps.store.close();
      }
    } finally {
      console.error = originalError;
    }
  });

  it('rejects same-model self-sign-off through the configured production judge: no bundle, REWORK', async () => {
    const sameModel: VerificationConfig = {
      ...VERIFICATION,
      judge: { ...VERIFICATION.judge, model: 'writer-xl' },
    };
    const runtime = runtimeFrom(configText(sameModel));
    const deps = buildServerDeps(runtime, {
      spawn: () => new FakeHerdr(),
      // The judge implementation must declare the configured identity; the
      // config names the judge as the writer's own model.
      verification: { judge: passingJudge('writer-xl'), runCommand: passingRunner() },
    });
    try {
      const { wo, task } = seedExecuting(deps);
      driveToSuccess(deps, task.id, 'writer-xl');

      await verifyTick(deps.scheduler!);

      expect(deps.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(deps.store.get<Task>('tasks', task.id)!.state).toBe('REWORK');
      const rejection = deps.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.rejected');
      expect((rejection!.payload as { diagnosis: string }).diagnosis).toMatch(/same-model self-sign-off/i);
    } finally {
      deps.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Config surface — validated, fail-closed
// ---------------------------------------------------------------------------

describe('E10.1 verification config surface', () => {
  it('round-trips a valid verification section through serialize → parse', () => {
    const parsed = parseFactoryConfig(configText(VERIFICATION));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.verification).toEqual(VERIFICATION);
  });

  it('serializes arbitrary-text commands and rubric items as safe YAML scalars', () => {
    const text = configText({
      ...VERIFICATION,
      rubric: ['Does the change satisfy: the criterion?'],
      checks: [
        {
          id: 'typecheck',
          category: 'deterministic',
          kind: 'typecheck',
          command: 'bun run typecheck && echo done: ok # not a comment',
        },
      ],
    });
    const parsed = parseFactoryConfig(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.verification!.checks[0]!.command).toBe(
        'bun run typecheck && echo done: ok # not a comment',
      );
      expect(parsed.config.verification!.rubric).toEqual(['Does the change satisfy: the criterion?']);
    }
  });

  it('rejects a verification section missing required fields with dotted paths', () => {
    const bad = configText().replace(
      'compose:',
      [
        'verification:',
        '  judge:',
        '    provider: ""',
        '    model: judge-1',
        '  prompt:',
        '    id: factory-verify',
        '    version: ""',
        '  rubric: []',
        '  checks:',
        '    - id: ""',
        '      category: deterministic',
        '      kind: unit',
        '      command: ""',
        '    - id: probe',
        '      category: deterministic',
        '      kind: playwright',
        '      command: bun test',
        'compose:',
      ].join('\n'),
    );
    const parsed = parseFactoryConfig(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const paths = parsed.issues.map((issue) => issue.path);
      expect(paths).toContain('verification.judge.provider');
      expect(paths).toContain('verification.prompt.version');
      expect(paths).toContain('verification.rubric');
      expect(paths).toContain('verification.checks[0].id');
      expect(paths).toContain('verification.checks[0].command');
      // A kind that belongs to the other category is refused.
      expect(paths).toContain('verification.checks[1].kind');
    }
  });

  it('createProductionVerifier refuses an invalid config (fail closed) and never fabricates a verifier', () => {
    const engineConfig: VerificationConfig = {
      ...VERIFICATION,
      checks: [{ id: 'dup', category: 'deterministic', kind: 'unit', command: 'bun test' }, { id: 'dup', category: 'deterministic', kind: 'unit', command: 'bun test' }],
    };
    expect(() =>
      createProductionVerifier({
        config: engineConfig,
        store: null as never,
        workingDirectory: repoPath,
        judge: passingJudge(),
        runCommand: passingRunner(),
      }),
    ).toThrow(VerificationConfigurationError);

    // Missing judge: refused, not silently parked as a green run.
    expect(() =>
      createProductionVerifier({
        config: VERIFICATION,
        store: null as never,
        workingDirectory: repoPath,
        runCommand: passingRunner(),
      }),
    ).toThrow(VerificationConfigurationError);
  });

  it('refuses a supplied judge whose identity does not match the configured identity', () => {
    expect(() =>
      createProductionVerifier({
        config: VERIFICATION,
        store: null as never,
        workingDirectory: repoPath,
        // The config names `judge-co/judge-1`; this implementation claims another.
        judge: passingJudge('some-other-model'),
        runCommand: passingRunner(),
      }),
    ).toThrow(/does not match the configured judge identity/);
  });

  it('the default config has no verification section (fail-closed is preserved by default)', () => {
    expect(DEFAULT_FACTORY_CONFIG.verification).toBeUndefined();
    const serialized = serializeFactoryConfig(DEFAULT_FACTORY_CONFIG);
    expect(serialized).not.toContain('verification:');
    const parsed = parseFactoryConfig(serialized);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.verification).toBeUndefined();
  });
});
