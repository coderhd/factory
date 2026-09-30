import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  DEFAULT_RECOVERY_BUDGETS,
  RECOVERY_ACTION_APPLIED,
  RESOURCE_UNAVAILABLE,
} from '../../src/factory/recovery/recovery';
import { createArtifactStore, openStateStore } from '../../src/factory/state/store';
import type { SemanticJudge } from '../../src/factory/verification/semantic';
import {
  createProductionVerifier,
  defaultCommandRunner,
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

/**
 * Record a closed, terminal Assignment for a Task carrying its worktree path —
 * the durable row the scheduler resolves at verification time. Mirrors the
 * `AssignmentRecord` shape `assign()` writes (workers/manager.ts).
 */
function seedAssignment(
  store: ReturnType<typeof buildServerDeps>['store'],
  input: { taskId: string; worktreePath: string },
): void {
  const at = '2026-09-30T11:00:00.000Z';
  // The assignments FK requires a real worker + task row; seed a terminal IDLE
  // worker so the durable assignment is well-formed provenance.
  store.set('workers', 'worker_1', {
    id: 'worker_1',
    profile: 'herdr',
    runtimeState: 'IDLE',
    lease: null,
    provisionedAt: at,
    lastActiveAt: at,
    reclaimedAt: null,
  });
  store.set('assignments', `assignment_${input.taskId}`, {
    id: `assignment_${input.taskId}`,
    taskId: input.taskId,
    workerId: 'worker_1',
    branch: `wo-x/task-${input.taskId.slice(0, 8)}`,
    worktreePath: input.worktreePath,
    baseCommit: 'base',
    closedAt: at,
    model: 'writer-xl',
    createdAt: at,
    updatedAt: at,
  });
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

  it("runs a command check in the Attempt's worktree directory, not the repo root", async () => {
    const runtime = runtimeFrom(configText(VERIFICATION));
    // The worktree holds the change under verification; the repo checkout does
    // not. A check that only passes when run in the worktree proves the command
    // is pinned to the directory that actually carries the change.
    const worktreePath = join(workDir, 'attempt-worktree');
    const repoMarker = join(repoPath, 'CHANGE_PRESENT');
    const worktreeMarker = join(worktreePath, 'CHANGE_PRESENT');
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(worktreeMarker, 'present in the worktree\n');
    expect(existsSync(repoMarker)).toBe(false);

    const seenCwd: string[] = [];
    const deps = buildServerDeps(runtime, {
      spawn: () => new FakeHerdr(),
      verification: {
        judge: passingJudge(),
        // Passes only where the marker lives — i.e. only in the worktree.
        runCommand: async ({ cwd }) => {
          seenCwd.push(cwd);
          return existsSync(join(cwd, 'CHANGE_PRESENT'))
            ? { exitCode: 0, stdout: 'marker present', stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'marker absent' };
        },
      },
    });
    try {
      const { wo, task } = seedExecuting(deps);
      seedAssignment(deps.store, { taskId: task.id, worktreePath });
      driveToSuccess(deps, task.id, 'writer-xl');

      await verifyTick(deps.scheduler!);

      expect(seenCwd).toContain(worktreePath);
      expect(seenCwd).not.toContain(repoPath);
      expect(deps.store.get<Task>('tasks', task.id)!.state).toBe('VERIFIED');
      expect(deps.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('HUMAN_GATE');
    } finally {
      deps.store.close();
    }
  });

  it('falls back to the repository path when the Task has no worktree assignment', async () => {
    const runtime = runtimeFrom(configText(VERIFICATION));
    const seenCwd: string[] = [];
    const deps = buildServerDeps(runtime, {
      spawn: () => new FakeHerdr(),
      verification: {
        judge: passingJudge(),
        runCommand: async ({ cwd }) => {
          seenCwd.push(cwd);
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        },
      },
    });
    try {
      const { task } = seedExecuting(deps);
      driveToSuccess(deps, task.id, 'writer-xl');

      await verifyTick(deps.scheduler!);

      expect(seenCwd).toContain(repoPath);
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

  it('serializes arbitrary-text scalar values as safe YAML scalars', () => {
    const text = configText({
      ...VERIFICATION,
      judge: { provider: 'judge: co', model: 'model: 1', family: 'family: x' },
      prompt: { id: 'prompt: verify', version: '1' },
      rubric: ['Does the change satisfy: the criterion?'],
      checks: [
        {
          id: 'typecheck: strict',
          category: 'deterministic',
          kind: 'typecheck',
          command: 'bun run typecheck && echo done: ok # not a comment',
        },
      ],
    });
    const parsed = parseFactoryConfig(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const verification = parsed.config.verification!;
      expect(verification.judge).toEqual({
        provider: 'judge: co',
        model: 'model: 1',
        family: 'family: x',
      });
      expect(verification.prompt.id).toBe('prompt: verify');
      expect(verification.checks[0]!.id).toBe('typecheck: strict');
      expect(verification.checks[0]!.command).toBe(
        'bun run typecheck && echo done: ok # not a comment',
      );
      expect(verification.rubric).toEqual(['Does the change satisfy: the criterion?']);
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
    const store = openStateStore(join(workDir, 'invalid-config.db'));
    try {
      const engineConfig: VerificationConfig = {
        ...VERIFICATION,
        checks: [
          { id: 'dup', category: 'deterministic', kind: 'unit', command: 'bun test' },
          { id: 'dup', category: 'deterministic', kind: 'unit', command: 'bun test' },
        ],
      };
      expect(() =>
        createProductionVerifier({
          config: engineConfig,
          store,
          workingDirectory: repoPath,
          judge: passingJudge(),
          runCommand: passingRunner(),
        }),
      ).toThrow(VerificationConfigurationError);

      // Missing judge: refused, not silently parked as a green run.
      expect(() =>
        createProductionVerifier({
          config: VERIFICATION,
          store,
          workingDirectory: repoPath,
          runCommand: passingRunner(),
        }),
      ).toThrow(VerificationConfigurationError);
    } finally {
      store.close();
    }
  });

  it('refuses a supplied judge whose identity does not match the configured identity', () => {
    const store = openStateStore(join(workDir, 'judge-mismatch.db'));
    try {
      expect(() =>
        createProductionVerifier({
          config: VERIFICATION,
          store,
          workingDirectory: repoPath,
          // The config names `judge-co/judge-1`; this implementation claims another.
          judge: passingJudge('some-other-model'),
          runCommand: passingRunner(),
        }),
      ).toThrow(/does not match the configured judge identity/);
    } finally {
      store.close();
    }
  });

  it('refuses a supplied judge that declares no identity', () => {
    const store = openStateStore(join(workDir, 'judge-no-identity.db'));
    try {
      expect(() =>
        createProductionVerifier({
          config: VERIFICATION,
          store,
          workingDirectory: repoPath,
          // A judge with no identity cannot be checked against writer ≠ verifier.
          judge: { identity: undefined, falsify: () => [] } as unknown as SemanticJudge,
          runCommand: passingRunner(),
        }),
      ).toThrow(/declares an identity/);
    } finally {
      store.close();
    }
  });

  it('defaultCommandRunner runs a command in the given directory (Bun.spawn wiring)', async () => {
    const dir = join(workDir, 'command-runner');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'marker.txt'), 'present\n');

    const ok = await defaultCommandRunner({ command: 'cat marker.txt', cwd: dir });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe('present');
    expect(ok.stderr).toBe('');

    // A non-zero exit is reported, not thrown; output is captured.
    const bad = await defaultCommandRunner({ command: 'echo boom >&2; exit 3', cwd: dir });
    expect(bad.exitCode).toBe(3);
    expect(bad.stderr).toBe('boom');
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

// ---------------------------------------------------------------------------
// E10.2 (#38) — the live worker-failure re-dispatch producer
// ---------------------------------------------------------------------------

/**
 * A Herdr adapter whose report per assignment is released by the test. `execute`
 * records the envelope, `collectArtifacts` parks until `release(report)` supplies
 * the runtime's next report — so a task executes exactly once per released
 * report and the scheduler's collect can be sequenced deterministically.
 */
class ScriptedHerdr implements WorkerAdapter {
  envelope: ExecutionEnvelope | null = null;
  taskId: string | null = null;
  private waiter: ((result: WorkerResult) => void) | null = null;
  private readonly queued: WorkerResult[] = [];

  async provision(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async status(): Promise<WorkerStatus> {
    return { state: 'running', lastHeartbeatAt: new Date().toISOString() };
  }
  async execute(envelope: ExecutionEnvelope): Promise<void> {
    this.envelope = envelope;
    this.taskId = envelope.taskId;
  }
  async collectArtifacts(): Promise<WorkerResult> {
    if (this.queued.length > 0) return structuredClone(this.queued.shift()!);
    return new Promise<WorkerResult>((resolve) => {
      this.waiter = resolve;
    });
  }
  async deliverAnswer(_answer: WorkerAnswer): Promise<void> {}
  async destroy(): Promise<void> {}

  release(result: WorkerResult): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(structuredClone(result));
      return;
    }
    this.queued.push(structuredClone(result));
  }
}

function failedResult(failure: string, diff: string | null = null): WorkerResult {
  return {
    status: 'failed',
    commits: [],
    artifacts: [],
    interactions: [],
    observations: [],
    verificationRequests: [],
    diff,
    failure,
  };
}

interface ProducerHarness {
  runtime: ReturnType<typeof resolveFactoryConfig>;
  deps: ReturnType<typeof buildServerDeps>;
  adapters: ScriptedHerdr[];
  tickAndSettle(): Promise<void>;
  until(label: string, predicate: () => boolean, maxTicks?: number): Promise<void>;
  adapterForAttempt(attemptId: string): ScriptedHerdr;
}

function producerHarness(): ProducerHarness {
  const runtime = runtimeFrom(configText(VERIFICATION));
  const adapters: ScriptedHerdr[] = [];
  const deps = buildServerDeps(runtime, {
    spawn: () => {
      const adapter = new ScriptedHerdr();
      adapters.push(adapter);
      return adapter;
    },
    // A hermetic E5 verifier (fake judge, no subprocess) so a re-dispatched
    // Attempt that completes is verified for real without warning noise.
    verification: { judge: passingJudge(), runCommand: passingRunner() },
  });
  const tickAndSettle = async (): Promise<void> => {
    deps.scheduler!.tick();
    await new Promise((resolve) => setTimeout(resolve, 1));
  };
  return {
    runtime,
    deps,
    adapters,
    tickAndSettle,
    async until(label, predicate, maxTicks = 30): Promise<void> {
      for (let i = 0; i < maxTicks; i += 1) {
        await tickAndSettle();
        if (predicate()) return;
        await tickAndSettle();
        if (predicate()) return;
      }
      throw new Error(`E10.2: "${label}" was not reached within the tick budget`);
    },
    adapterForAttempt(attemptId): ScriptedHerdr {
      const adapter = adapters.find((candidate) => candidate.envelope?.attemptId === attemptId);
      if (!adapter) throw new Error(`no adapter dispatched for attempt ${attemptId}`);
      return adapter;
    },
  };
}

const taskById = (store: ReturnType<typeof buildServerDeps>['store'], id: string): Task =>
  store.get<Task>('tasks', id)!;

const attemptsFor = (store: ReturnType<typeof buildServerDeps>['store'], taskId: string): Attempt[] =>
  store
    .list<Attempt>('attempts')
    .filter((attempt) => attempt.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

const openAssignmentForTask = (
  store: ReturnType<typeof buildServerDeps>['store'],
  taskId: string,
): { id: string; workerId: string; closedAt: string | null } | undefined =>
  store
    .list<{ id: string; taskId: string; workerId: string; closedAt: string | null }>('assignments')
    .find((row) => row.taskId === taskId && row.closedAt === null);

const recoveryActions = (
  deps: ReturnType<typeof buildServerDeps>,
  workOrderId: string,
): Array<{ kind: string }> =>
  deps.events
    .readEvents({ aggregateType: 'work_order', aggregateId: workOrderId })
    .filter((event) => event.type === RECOVERY_ACTION_APPLIED)
    .map((event) => event.payload as { kind: string });

describe('E10.2 worker-failure re-dispatch producer', () => {
  it('re-dispatches a live worker failure as a fresh Assignment against E7’s clean-baseline Attempt (Task stays RUNNING), preserving the old diff as evidence', async () => {
    const h = producerHarness();
    try {
      const { wo, task } = seedExecuting(h.deps);
      // Kick execution: the Task is assigned and RUNNING on a live Attempt.
      await h.until('running', () => taskById(h.deps.store, task.id).state === 'RUNNING');
      const first = attemptsFor(h.deps.store, task.id);
      expect(first).toHaveLength(1);
      const attemptA = first[0]!;
      const adapterA = h.adapterForAttempt(attemptA.id);

      // The live worker fails with a partial diff left behind — the evidence to keep.
      const oldDiff = 'diff --git a/src/orders.ts b/src/orders.ts\n+partial work';
      adapterA.release(failedResult('worker blew up', oldDiff));

      await h.until('re-dispatched', () => attemptsFor(h.deps.store, task.id).length === 2);

      // The failed Attempt is settled, never a success, and keeps its diff.
      const failed = h.deps.store.get<Attempt>('attempts', attemptA.id)!;
      expect(failed.outcome).toBe('failed');
      expect(failed.outcome).not.toBe('success');
      expect(failed.diff).toContain('partial work');

      // The old diff is preserved as an immutable evidence artifact (§18.4).
      const artifacts = createArtifactStore(h.runtime.paths.artifacts);
      expect(Buffer.from(artifacts.get(`${attemptA.id}/diff.patch`)).toString('utf8')).toContain(
        'partial work',
      );

      // Exactly one NEW Attempt, opened by E7 from a clean baseline.
      const second = attemptsFor(h.deps.store, task.id);
      expect(second).toHaveLength(2);
      const attemptB = second.find((attempt) => attempt.id !== attemptA.id)!;
      expect(attemptB.outcome).toBeNull();
      expect(attemptB.environment).toBe('clean-worktree');
      expect(attemptB.context).toContain('clean-worktree');

      // E7's bounded recovery recorded the RETRY_NEW_ATTEMPT action.
      const actions = recoveryActions(h.deps, wo.id);
      expect(actions.map((action) => action.kind)).toContain('RETRY_NEW_ATTEMPT');

      // The producer re-opens execution: a fresh Assignment binds the new Attempt
      // to a live worker (lease.attemptId), and that worker is dispatched the
      // envelope for the clean-baseline Attempt.
      await h.until('fresh-assignment-dispatched', () => {
        const open = openAssignmentForTask(h.deps.store, task.id);
        if (!open) return false;
        const worker = h.deps.store.get<{ lease: { attemptId: string } | null }>(
          'workers',
          open.workerId,
        );
        return worker?.lease?.attemptId === attemptB.id;
      });
      const dispatched = h.adapterForAttempt(attemptB.id);
      expect(dispatched.envelope!.attemptId).toBe(attemptB.id);

      // Invariant 9 (controller ruling RF6): the Task stays RUNNING and now has a
      // live re-dispatch, so it does not dead-end.
      expect(taskById(h.deps.store, task.id).state).toBe('RUNNING');

      // No duplicate side effects: a replayed/continued poll mints no third Attempt.
      await h.tickAndSettle();
      await h.tickAndSettle();
      expect(attemptsFor(h.deps.store, task.id)).toHaveLength(2);
      expect(recoveryActions(h.deps, wo.id).filter((a) => a.kind === 'RETRY_NEW_ATTEMPT')).toHaveLength(1);
    } finally {
      h.deps.store.close();
    }
  });

  it('re-executes the re-dispatched Attempt under the fresh Assignment (the clean baseline runs, not the failed one)', async () => {
    const h = producerHarness();
    try {
      const { task } = seedExecuting(h.deps);
      await h.until('running', () => taskById(h.deps.store, task.id).state === 'RUNNING');
      const attemptA = attemptsFor(h.deps.store, task.id)[0]!;
      h.adapterForAttempt(attemptA.id).release(failedResult('worker blew up', 'diff --git a/x b/x\n+old'));

      await h.until('re-dispatched', () => attemptsFor(h.deps.store, task.id).length === 2);
      const attemptB = attemptsFor(h.deps.store, task.id).find((a) => a.id !== attemptA.id)!;
      await h.until('clean-dispatched', () => {
        const open = openAssignmentForTask(h.deps.store, task.id);
        return Boolean(open) && h.deps.store.get<{ lease: { attemptId: string } | null }>('workers', open!.workerId)?.lease?.attemptId === attemptB.id;
      });

      // The fresh worker reports completion with evidence: the re-dispatch really
      // re-runs the Task on the new Attempt (SUCCESS is governed by E3's gate).
      h.adapterForAttempt(attemptB.id).release({
        status: 'completed',
        commits: [],
        artifacts: [],
        interactions: [],
        observations: [],
        verificationRequests: [],
        diff: 'diff --git a/src/orders.ts b/src/orders.ts\n+fixed work',
        failure: null,
      });
      await h.until('success', () => taskById(h.deps.store, task.id).state === 'SUCCESS');
      // The re-dispatched Attempt completed with evidence on the fresh Assignment.
      expect(h.deps.store.get<Attempt>('attempts', attemptB.id)!.outcome).toBe('success');
      expect(h.deps.store.get<Attempt>('attempts', attemptA.id)!.outcome).toBe('failed');
      // The failed Attempt's diff is not overwritten: both are durable evidence.
      expect(h.deps.store.get<Attempt>('attempts', attemptA.id)!.diff).toContain('old');
    } finally {
      h.deps.store.close();
    }
  });

  it('is bounded: with the Work-Order recovery ceiling exhausted, a live worker failure escalates and mints no new Attempt', async () => {
    const h = producerHarness();
    try {
      const { wo, task } = seedExecuting(h.deps);
      await h.until('running', () => taskById(h.deps.store, task.id).state === 'RUNNING');
      const attemptA = attemptsFor(h.deps.store, task.id)[0]!;

      // Spend the Work-Order automatic-recovery ceiling before the failure lands.
      for (let i = 0; i < DEFAULT_RECOVERY_BUDGETS.workOrderCeiling; i += 1) {
        h.deps.events.appendEvent({
          type: RECOVERY_ACTION_APPLIED,
          aggregateType: 'work_order',
          aggregateId: wo.id,
          payload: { kind: 'RETRY_NEW_ATTEMPT' },
        });
      }

      h.adapterForAttempt(attemptA.id).release(failedResult('worker blew up'));

      await h.until('escalated', () =>
        recoveryActions(h.deps, wo.id).some((action) => action.kind === 'ESCALATE_HUMAN'),
      );

      // Bounded: no unbounded retry — the failed Attempt is the only one, and no
      // fresh Assignment re-opens execution.
      expect(attemptsFor(h.deps.store, task.id)).toHaveLength(1);
      expect(openAssignmentForTask(h.deps.store, task.id)).toBeUndefined();
      expect(recoveryActions(h.deps, wo.id).filter((a) => a.kind === 'ESCALATE_HUMAN')).toHaveLength(1);
      // Invariant 9: the Task is parked RUNNING (never silently failed), awaiting
      // the human escalation path — not looping.
      expect(taskById(h.deps.store, task.id).state).toBe('RUNNING');
      await h.tickAndSettle();
      await h.tickAndSettle();
      expect(attemptsFor(h.deps.store, task.id)).toHaveLength(1);
    } finally {
      h.deps.store.close();
    }
  });
});
