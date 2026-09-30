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
import { openStateStore } from '../../src/factory/state/store';
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
