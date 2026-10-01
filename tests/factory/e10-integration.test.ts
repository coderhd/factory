import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildGitHubAdapter, buildServerDeps, runCli, type CliIO } from '../../src/cli/factory';
import { createFactoryClient } from '../../src/factory/api/client';
import { createApiHandler, startFactoryServer } from '../../src/factory/api/server';
import {
  DEFAULT_FACTORY_CONFIG,
  parseFactoryConfig,
  resolveFactoryConfig,
  serializeFactoryConfig,
  type FactoryDesiredConfig,
} from '../../src/factory/config/factoryConfig';
import { createEmptyEvidenceReadPort } from '../../src/factory/observatory/observatory';
import { openEventLog } from '../../src/factory/events/log';
import { circuitSnapshot } from '../../src/factory/recovery/circuitBreaker';
import { taskWorktreeBranch } from '../../src/factory/worktrees/worktree';
import { check as policyCheck } from '../../src/factory/policy/policy';
import type {
  CreateBranchInput,
  CreatePullRequestInput,
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDetail,
  GitHubTransport,
  GitHubMergeResult,
  IssueRef,
  MergePullRequestInput,
  PullRequestRef,
} from '../../src/factory/github/adapter';
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
import { RECOVERY_PARKED } from '../../src/factory/scheduler/scheduler';
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

  it('park a second same-class failure (REASSIGN) loudly: durable event + status, no new Attempt, no silent stall', async () => {
    const h = producerHarness();
    // The escalation is expected to be loud (console.error); capture it so the
    // run stays pristine and assert the operator-facing message is emitted.
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      const { wo, task } = seedExecuting(h.deps);
      await h.until('running', () => taskById(h.deps.store, task.id).state === 'RUNNING');
      const attemptA = attemptsFor(h.deps.store, task.id)[0]!;

      // First live failure → RETRY_NEW_ATTEMPT re-dispatch (the happy path).
      h.adapterForAttempt(attemptA.id).release(failedResult('worker blew up'));
      await h.until('re-dispatched', () => attemptsFor(h.deps.store, task.id).length === 2);
      const attemptB = attemptsFor(h.deps.store, task.id).find((a) => a.id !== attemptA.id)!;

      // Second same-class live failure: sameClassCount reaches the per-class
      // budget, so E7's ladder walks to REASSIGN — which the live scheduler has
      // no executor for (RF7). Without the park it would stall silently.
      h.adapterForAttempt(attemptB.id).release(failedResult('worker blew up again'));
      await h.until('parked', () =>
        h.deps.events
          .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
          .some((event) => event.type === RECOVERY_PARKED),
      );

      // Loud escalation: a durable recovery.parked event carrying the action…
      const parked = h.deps.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .filter((event) => event.type === RECOVERY_PARKED);
      expect(parked).toHaveLength(1);
      expect(parked[0]!.payload).toMatchObject({ kind: 'REASSIGN', taskId: task.id });
      // …and the same park surfaced by status().
      expect(h.deps.scheduler!.status().queue.parkedRecovery).toContainEqual(
        expect.objectContaining({ taskId: task.id, kind: 'REASSIGN' }),
      );
      // …and surfaced to the operator as a loud line naming the missing executor.
      expect(errors.some((line) => /parked on recovery action REASSIGN/.test(line))).toBe(true);

      // Bounded and non-minting: the REASSIGN mints no Attempt, and no further
      // tick re-drives the parked failure (no silent loop, no third Attempt).
      expect(attemptsFor(h.deps.store, task.id)).toHaveLength(2);
      await h.tickAndSettle();
      await h.tickAndSettle();
      expect(attemptsFor(h.deps.store, task.id)).toHaveLength(2);
      expect(
        h.deps.events
          .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
          .filter((event) => event.type === RECOVERY_PARKED),
      ).toHaveLength(1);

      // Invariant 9: RUNNING, parked loudly — neither FAILED nor silently stuck.
      expect(taskById(h.deps.store, task.id).state).toBe('RUNNING');
    } finally {
      console.error = originalError;
      h.deps.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E10.3 (#37) — the circuit live producer
// ---------------------------------------------------------------------------

/**
 * The E10.3 circuit producer harness. A live worker reports a failure whose
 * detail already carries the §9.1 class prefix; the scheduler must classify it
 * (not flatten it to WORKER_FAILURE), feed `recover()` and so open the circuit
 * from real load. Two independent Tasks with `maxConcurrentTasks: 2` keep one
 * live Attempt across the outage, so a successful completion is the evidence
 * that closes a recovered circuit. A controllable clock crosses the reset window
 * deterministically.
 */
function circuitHarness(): ProducerHarness & {
  clock: { advance(ms: number): void };
} {
  const text = serializeFactoryConfig({
    ...DEFAULT_FACTORY_CONFIG,
    repository: { path: repoPath },
    verification: VERIFICATION,
    scheduler: { ...DEFAULT_FACTORY_CONFIG.scheduler, maxConcurrentTasks: 2 },
  });
  const runtime = runtimeFrom(text);
  const adapters: ScriptedHerdr[] = [];
  let t = Date.parse('2026-10-01T00:00:00.000Z');
  const clock = {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms;
    },
  };
  const deps = buildServerDeps(runtime, {
    spawn: () => {
      const adapter = new ScriptedHerdr();
      adapters.push(adapter);
      return adapter;
    },
    now: clock.now,
    verification: { judge: passingJudge(), runCommand: passingRunner() },
    // A small, deterministic circuit: two consecutive failures trip it; a 1s
    // reset window opens the half-open probe without a real-time wait.
    circuit: { failureThreshold: 2, resetTimeoutMs: 1_000, probeTimeoutMs: 500 },
  });
  const tickAndSettle = async (): Promise<void> => {
    deps.scheduler!.tick();
    await new Promise((resolve) => setTimeout(resolve, 1));
  };
  return {
    runtime,
    deps,
    adapters,
    clock,
    tickAndSettle,
    async until(label, predicate, maxTicks = 30): Promise<void> {
      for (let i = 0; i < maxTicks; i += 1) {
        await tickAndSettle();
        if (predicate()) return;
        await tickAndSettle();
        if (predicate()) return;
      }
      throw new Error(`E10.3: "${label}" was not reached within the tick budget`);
    },
    adapterForAttempt(attemptId): ScriptedHerdr {
      const adapter = adapters.find((candidate) => candidate.envelope?.attemptId === attemptId);
      if (!adapter) throw new Error(`no adapter dispatched for attempt ${attemptId}`);
      return adapter;
    },
  };
}

/** Seed an EXECUTING Work Order with two independent nodes (two Tasks). */
function seedTwoExecuting(deps: {
  store: ReturnType<typeof buildServerDeps>['store'];
  events: ReturnType<typeof buildServerDeps>['events'];
}): { wo: WorkOrder; tasks: Task[] } {
  const wo = createWorkOrder(deps, { intent: 'E10.3 circuit subject', acceptanceCriteria: ['accepted'] });
  for (const to of ['READY', 'PLANNING'] as const) transitionWorkOrder(deps, wo.id, { to });
  const dag = commitDAG(deps, wo.id, {
    nodes: [
      { nodeId: 'a', title: 'A' },
      { nodeId: 'b', title: 'B' },
    ],
  });
  transitionWorkOrder(deps, wo.id, { to: 'EXECUTING' });
  return { wo, tasks: dag.nodes.map((node) => deps.store.get<Task>('tasks', node.taskId)!) };
}

const resourceUnavailableEvents = (
  deps: ReturnType<typeof buildServerDeps>,
  workOrderId: string,
): Array<{ resource?: string }> =>
  deps.events
    .readEvents({ aggregateType: 'work_order', aggregateId: workOrderId })
    .filter((event) => event.type === RESOURCE_UNAVAILABLE)
    .map((event) => event.payload as { resource?: string });

const runningTasks = (
  store: ReturnType<typeof buildServerDeps>['store'],
  tasks: Task[],
): Task[] => tasks.filter((task) => taskById(store, task.id).state === 'RUNNING');

describe('E10.3 circuit live producer (spec §18.9)', () => {
  it('a live dependency failure opens the circuit and sheds (WAITING_RESOURCE, no budget spent); a circuit-admitted success closes it', async () => {
    const h = circuitHarness();
    try {
      const { wo, tasks } = seedTwoExecuting(h.deps);
      await h.until('two running', () => runningTasks(h.deps.store, tasks).length === 2);
      const runners = runningTasks(h.deps.store, tasks);
      const [runnerA, runnerB] = runners as [Task, Task];
      const attemptA1 = attemptsFor(h.deps.store, runnerA.id)[0]!;
      const model = attemptA1.model!;
      expect(model).toBeString();
      expect(attemptsFor(h.deps.store, runnerB.id)[0]!.model).toBe(model);

      // The first live dependency outage is classified (not flattened to
      // WORKER_FAILURE) and feeds the circuit (failure 1 of 2). E7 mints a
      // clean-baseline retry, which the live re-dispatcher re-opens: Attempt A2
      // stays live across the outage.
      h.adapterForAttempt(attemptA1.id).release(
        failedResult('DEPENDENCY_UNAVAILABLE: provider timed out'),
      );
      await h.until('A2 redispatched', () => attemptsFor(h.deps.store, runnerA.id).length === 2);
      const attemptA2 = attemptsFor(h.deps.store, runnerA.id)[1]!;
      await h.until('A2 live', () => Boolean(h.adapterForAttempt(attemptA2.id)));
      expect(circuitSnapshot(h.deps, model).consecutiveFailures).toBe(1);
      // The durable failure record names the real class (evidence-preserving).
      expect(
        h.deps.store.get<Attempt>('attempts', attemptA1.id)!.failureHistory[0]!.failure,
      ).toContain('DEPENDENCY_UNAVAILABLE');

      // The second live dependency failure reaches the threshold and opens the
      // circuit. The opening failure is a shed: WAITING_RESOURCE, no new Attempt.
      const attemptB1 = attemptsFor(h.deps.store, runnerB.id)[0]!;
      h.adapterForAttempt(attemptB1.id).release(
        failedResult('DEPENDENCY_UNAVAILABLE: provider timed out'),
      );
      await h.until('circuit open', () => circuitSnapshot(h.deps, model).state === 'OPEN');
      expect(recoveryActions(h.deps, wo.id).at(-1)!.kind).toBe('WAITING_RESOURCE');
      expect(attemptsFor(h.deps.store, runnerB.id)).toHaveLength(1);
      // The shed is surfaced durably as a resource park for the dependency.
      expect(resourceUnavailableEvents(h.deps, wo.id).some((e) => e.resource === model)).toBe(true);

      // While OPEN, a live dependency failure is shed — WAITING_RESOURCE, no
      // third Attempt, no budget spent.
      await h.tickAndSettle();
      expect(attemptsFor(h.deps.store, runnerA.id)).toHaveLength(2);
      expect(taskById(h.deps.store, runnerA.id).state).toBe('RUNNING');

      // The circuit-admitted Attempt A2 (dispatched before the window) completes
      // successfully: live evidence that the dependency recovered closes it.
      h.clock.advance(1_000);
      h.adapterForAttempt(attemptA2.id).release({
        status: 'completed',
        commits: [],
        artifacts: [],
        interactions: [],
        observations: [],
        verificationRequests: [],
        diff: 'diff --git a/a b/a\n+probe succeeded',
        failure: null,
      });
      await h.until('circuit closed', () => circuitSnapshot(h.deps, model).state === 'CLOSED');
      expect(circuitSnapshot(h.deps, model)).toMatchObject({
        state: 'CLOSED',
        consecutiveFailures: 0,
        probeInFlight: false,
      });
    } finally {
      h.deps.store.close();
    }
  });

  it('settles a live HALF_OPEN probe: after the window a dependency failure is admitted as the probe and re-opens it', async () => {
    const h = circuitHarness();
    try {
      const { tasks } = seedTwoExecuting(h.deps);
      await h.until('two running', () => runningTasks(h.deps.store, tasks).length === 2);
      const runners = runningTasks(h.deps.store, tasks);
      const [runnerA, runnerB] = runners as [Task, Task];
      const attemptA1 = attemptsFor(h.deps.store, runnerA.id)[0]!;
      const model = attemptA1.model!;

      // Open the circuit with two live dependency failures, keeping A2 live.
      h.adapterForAttempt(attemptA1.id).release(failedResult('DEPENDENCY_UNAVAILABLE: provider timed out'));
      await h.until('A2 redispatched', () => attemptsFor(h.deps.store, runnerA.id).length === 2);
      const attemptA2 = attemptsFor(h.deps.store, runnerA.id)[1]!;
      await h.until('A2 live', () => Boolean(h.adapterForAttempt(attemptA2.id)));
      const attemptB1 = attemptsFor(h.deps.store, runnerB.id)[0]!;
      h.adapterForAttempt(attemptB1.id).release(failedResult('MODEL_UNAVAILABLE: model-x down'));
      await h.until('circuit open', () => circuitSnapshot(h.deps, model).state === 'OPEN');

      // After the reset window the next live dependency failure is admitted as
      // the single HALF_OPEN probe; because `recover()` is a failure delivery it
      // settles the probe immediately — a failed probe re-opens the circuit with
      // a fresh window and no dangling `probeInFlight`.
      h.clock.advance(1_000);
      h.adapterForAttempt(attemptA2.id).release(failedResult('MODEL_UNAVAILABLE: model-x down'));
      await h.until('probe settled', () => {
        const snapshot = circuitSnapshot(h.deps, model);
        return snapshot.state === 'OPEN' && snapshot.probeInFlight === false;
      });
      const settled = circuitSnapshot(h.deps, model);
      expect(settled.state).toBe('OPEN');
      expect(settled.probeInFlight).toBe(false);
      // The failed probe mints no retry: a shed is not evidence, and no budget
      // is spent.
      expect(attemptsFor(h.deps.store, runnerA.id)).toHaveLength(2);
    } finally {
      h.deps.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E10.3 (#37) — the GitHub adapter composed into a running process
// ---------------------------------------------------------------------------

/** A hermetic GitHub transport (Ruling R6): records calls, hits no network. */
class MockGitHub implements GitHubTransport {
  issues = new Map<string, GitHubIssue>();
  issueCalls: IssueRef[] = [];
  branchCalls: CreateBranchInput[] = [];
  prCalls: CreatePullRequestInput[] = [];
  private prNumber = 500;

  async getIssue(ref: IssueRef): Promise<GitHubIssue> {
    this.issueCalls.push({ ...ref });
    const issue = this.issues.get(`${ref.repository}#${ref.number}`);
    if (!issue) throw new Error(`no such issue: ${ref.repository}#${ref.number}`);
    return issue;
  }
  async createBranch(input: CreateBranchInput) {
    this.branchCalls.push({ ...input });
    return { repository: input.repository, name: input.branch, sha: 'sha_base' };
  }
  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    this.prCalls.push({ ...input });
    this.prNumber += 1;
    return {
      repository: input.repository,
      number: this.prNumber,
      url: `https://github.com/${input.repository}/pull/${this.prNumber}`,
      head: input.head,
      base: input.base,
    };
  }
  async getPullRequest(ref: PullRequestRef): Promise<GitHubPullRequestDetail> {
    throw new Error(`unexpected getPullRequest in this test: ${ref.repository}#${ref.number}`);
  }
  async mergePullRequest(input: MergePullRequestInput): Promise<GitHubMergeResult> {
    throw new Error(`unexpected mergePullRequest in this test: ${input.number}`);
  }
}
describe('E10.3 GitHub adapter composed into a running process (#37)', () => {
  it('buildServerDeps constructs the adapter against the live policy + durable evidence reader (transport mocked)', async () => {
    const transport = new MockGitHub();
    const runtime = runtimeFrom(configText(VERIFICATION));
    // No github override: the adapter must NOT be constructed.
    const bare = buildServerDeps(runtime, {
      spawn: () => new FakeHerdr(),
      reconcileOnBoot: false,
    });
    try {
      expect(bare.github).toBeUndefined();
    } finally {
      bare.store.close();
    }

    const runtimeWithGitHub = runtimeFrom(configText(VERIFICATION));
    const deps = buildServerDeps(runtimeWithGitHub, {
      spawn: () => new FakeHerdr(),
      reconcileOnBoot: false,
      github: { transport, factoryBaseUrl: 'http://factory.local:8787' },
    });
    try {
      expect(deps.github).toBeDefined();
      // The adapter's gates are wired to the Factory's *real* E7 policy and
      // durable evidence reader — the same store/events the server owns. An
      // import against a repository-less issue still routes through the live
      // policy path: proving the composition, not a detached adapter.
      expect(typeof deps.github!.importIssue).toBe('function');
      expect(typeof deps.github!.openPR).toBe('function');
      expect(typeof deps.github!.merge).toBe('function');
    } finally {
      deps.store.close();
    }
  });

  it('imports an issue and opens a PR through the server routes, gated by the live policy', async () => {
    const store = openStateStore(join(workDir, 'github-route.db'));
    const events = openEventLog(store.db);
    // The adapter's E2 client needs a live, loopback mutation authority. The e6
    // harness pattern: a real loopback server sharing the same store/events.
    const e2 = (await import('../../src/factory/api/server')).startFactoryServer(
      { store, events, evidence: createEmptyEvidenceReadPort() },
      { port: 0, hostname: '127.0.0.1' },
    );
    const transport = new MockGitHub();
    const issue: GitHubIssue = {
      repository: 'acme/widgets',
      number: 77,
      title: 'Add the circuit widget',
      body: 'Acceptance:\n- [ ] widget works',
      labels: ['enhancement'],
      url: 'https://github.com/acme/widgets/issues/77',
    };
    transport.issues.set('acme/widgets#77', issue);

    const client = createFactoryClient({ baseUrl: e2.url });
    const adapter = buildGitHubAdapter({
      transport,
      client,
      factoryBaseUrl: 'http://factory.local:8787',
      store,
      events,
    });
    const handler = createApiHandler({
      store,
      events,
      evidence: createEmptyEvidenceReadPort(),
      github: adapter,
    });
    try {
      // import → WO through the route.
      const imported = await handler(
        new Request('http://factory.local/api/github/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repository: 'acme/widgets', number: 77 }),
        }),
      );
      expect(imported.status).toBe(201);
      const importedBody = (await imported.json()) as { workOrder: WorkOrder; created: boolean };
      expect(importedBody.created).toBe(true);
      expect(importedBody.workOrder.repository).toBe('acme/widgets');
      expect(transport.issueCalls).toHaveLength(1);

      // Persist the durable Evidence Bundle the PR must link (E9.4 receipt).
      const bundle = {
        id: 'eb_route_1',
        workOrderId: importedBody.workOrder.id,
        complete: true,
        gates: { deterministic: true, behavioral: true, semantic: true, run: true },
      };
      store.set('evidence_bundles', bundle.id, bundle);

      const opened = await handler(
        new Request('http://factory.local/api/github/pull-requests', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ evidenceBundleId: bundle.id }),
        }),
      );
      expect(opened.status).toBe(201);
      const pr = (await opened.json()) as GitHubPullRequest;
      expect(transport.prCalls).toHaveLength(1);
      expect(transport.prCalls[0]!.body).toContain(`[${bundle.id}](http://factory.local:8787/api/observatory/work-orders/${importedBody.workOrder.id}/drill-down)`);
      expect(pr.head).toBe(`wo-${importedBody.workOrder.id}/task-${importedBody.workOrder.id.slice(0, 8)}`);

      // The gate ran against the live policy: an ALLOW decision is durable.
      expect(
        store
          .list<{ action: { capability: string }; decision: string }>('policy_decisions')
          .find((row) => row.action.capability === 'pr.create')?.decision,
      ).toBe('ALLOW');

      // A caller-fabricated receipt (no durable row) is refused — no PR.
      const forged = await handler(
        new Request('http://factory.local/api/github/pull-requests', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ evidenceBundleId: 'eb_not_persisted' }),
        }),
      );
      expect(forged.status).toBe(404);
      expect(transport.prCalls).toHaveLength(1);
    } finally {
      e2.stop();
      store.close();
    }
  });

  it('fails closed when no GitHub adapter is composed (no ungoverned route)', async () => {
    const store = openStateStore(join(workDir, 'github-absent.db'));
    const events = openEventLog(store.db);
    const handler = createApiHandler({ store, events, evidence: createEmptyEvidenceReadPort() });
    try {
      const response = await handler(
        new Request('http://factory.local/api/github/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repository: 'acme/widgets', number: 1 }),
        }),
      );
      expect(response.status).toBe(404);
    } finally {
      store.close();
    }
  });

  it('drives the operator CLI (`factory github import` / `github pr`) through the server', async () => {
    const store = openStateStore(join(workDir, 'github-cli.db'));
    const events = openEventLog(store.db);
    const e2 = startFactoryServer(
      { store, events, evidence: createEmptyEvidenceReadPort() },
      { port: 0, hostname: '127.0.0.1' },
    );
    const transport = new MockGitHub();
    transport.issues.set('acme/widgets#88', {
      repository: 'acme/widgets',
      number: 88,
      title: 'CLI subject',
      body: '- [ ] criterion',
      labels: [],
      url: 'https://github.com/acme/widgets/issues/88',
    });
    const adapter = buildGitHubAdapter({
      transport,
      client: createFactoryClient({ baseUrl: e2.url }),
      factoryBaseUrl: 'http://factory.local:8787',
      store,
      events,
    });
    const server = startFactoryServer(
      { store, events, evidence: createEmptyEvidenceReadPort(), github: adapter },
      { port: 0, hostname: '127.0.0.1' },
    );
    const capture = (): { io: CliIO; out: string[]; err: string[] } => {
      const out: string[] = [];
      const err: string[] = [];
      return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
    };
    try {
      // `factory github import` creates the Work Order through the server.
      const importCap = capture();
      const code = await runCli(
        ['github', 'import', '--repo', 'acme/widgets', '--issue', '88', '--url', server.url],
        importCap.io,
      );
      expect(code).toBe(0);
      const imported = JSON.parse(importCap.out[0]!) as { workOrder: WorkOrder; created: boolean };
      expect(imported.created).toBe(true);

      // `factory github pr` opens the PR from the durable bundle id.
      const bundle = {
        id: 'eb_cli_1',
        workOrderId: imported.workOrder.id,
        complete: true,
        gates: { deterministic: true, behavioral: true, semantic: true, run: true },
      };
      store.set('evidence_bundles', bundle.id, bundle);
      const prCap = capture();
      const prCode = await runCli(
        ['github', 'pr', '--bundle', bundle.id, '--url', server.url],
        prCap.io,
      );
      expect(prCode).toBe(0);
      const pr = JSON.parse(prCap.out[0]!) as GitHubPullRequest;
      expect(pr.head).toBe(`wo-${imported.workOrder.id}/task-${imported.workOrder.id.slice(0, 8)}`);
      expect(transport.prCalls).toHaveLength(1);

      // A bad invocation fails closed (usage error, no call).
      const badCap = capture();
      expect(await runCli(['github', 'import', '--repo', 'acme/widgets'], badCap.io)).toBe(1);
      expect(badCap.err.join('\n')).toContain('usage: factory github import');
    } finally {
      server.stop();
      e2.stop();
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E10.3 (#37) — E6 PR branch and E3 worktree branch: the aggregation model
// ---------------------------------------------------------------------------

/**
 * The PR branch is intentionally the **Work-Order-keyed aggregate** of the
 * Task-keyed worktree branches: E6 opens one PR per Work Order (aggregating its
 * Tasks), while E3's `taskWorktreeBranch` keys each Task's worktree branch on
 * the Task. Both share the `wo-<workOrderId>/task-<…>` namespace — and therefore
 * the E7 `wo-*` namespace `branch.create`/`repo.write` grant. This is the documented
 * model; the test proves the namespace is consistent and both shapes are
 * authorized by the live embedded policy, so the divergence is a declared leaf,
 * not a scope leak.
 */
describe('E10.3 PR branch / worktree branch aggregation namespace (#37)', () => {
  const prBranchFor = (workOrderId: string): string =>
    `wo-${workOrderId}/task-${workOrderId.slice(0, 8)}`;

  it('shares one namespace: both branches are `wo-<id>/task-<short>` and both are policy-authorized', () => {
    const store = openStateStore(join(workDir, 'branch-namespace.db'));
    const events = openEventLog(store.db);
    try {
      const wo = createWorkOrder({ store, events }, {
        intent: 'branch namespace subject',
        acceptanceCriteria: ['accepted'],
        repository: 'acme/widgets',
      });
      const taskBranch = taskWorktreeBranch('task_abcdef123456', wo.id);
      const prBranch = prBranchFor(wo.id);

      // Same namespace prefix: `wo-<workOrderId>/task-`.
      expect(taskBranch.startsWith(`wo-${wo.id}/task-`)).toBe(true);
      expect(prBranch.startsWith(`wo-${wo.id}/task-`)).toBe(true);

      // Both leaves are the deterministic short-id form; the PR leaf keys the
      // Work Order (the aggregate), the worktree leaf keys the Task (a member).
      expect(prBranch).toBe(`wo-${wo.id}/task-${wo.id.slice(0, 8)}`);
      expect(taskBranch).toBe(`wo-${wo.id}/task-task_abc`);

      // The live embedded E7 policy authorizes both the aggregate PR branch and
      // every member worktree branch under the same `wo-*/**` grant — so one PR
      // per Work Order never escapes the Factory's write scope.
      const subject = { taskId: null, workOrderId: wo.id };
      for (const branch of [prBranch, taskBranch]) {
        expect(
          policyCheck({ store, events }, subject, { capability: 'branch.create', resource: { branch } }),
        ).toBe('ALLOW');
        expect(
          policyCheck({ store, events }, subject, {
            capability: 'repo.write',
            resource: { branch, path: 'src/index.ts' },
          }),
        ).toBe('ALLOW');
      }
      // A branch outside the Factory namespace is denied: the shared prefix is
      // load-bearing, not cosmetic.
      expect(
        policyCheck({ store, events }, subject, {
          capability: 'branch.create',
          resource: { branch: 'someone-elses-branch' },
        }),
      ).toBe('DENY');
    } finally {
      store.close();
    }
  });
});
