import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildGitHubAdapter, buildServerDeps, runCli, type CliIO, type ServerDepsOptions } from '../../src/cli/factory';
import { createFactoryClient, FactoryApiError } from '../../src/factory/api/client';
import { startFactoryServer } from '../../src/factory/api/server';
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
  type TaskDependency,
  type WorkOrder,
} from '../../src/factory/domain/workOrder';
import type { EvidenceBundle } from '../../src/factory/evidence/bundle';
import { openEventLog } from '../../src/factory/events/log';
import {
  createVerificationEngine,
  type FailureRecord,
} from '../../src/factory/verification/engine';
import {
  createE5Verifier,
  type SemanticJudge,
  type WorkVerifier,
} from '../../src/factory/verification/orchestrator';
import { buildEvidenceBundle } from '../../src/factory/evidence/bundle';
import { createSemanticVerifier } from '../../src/factory/verification/semantic';
import {
  createGitHubAdapter,
  type CreateBranchInput,
  type CreatePullRequestInput,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubPullRequestDetail,
  type GitHubTransport,
  type IssueRef,
  type MergePullRequestInput,
  type PullRequestRef,
} from '../../src/factory/github/adapter';
import { commitDAG, listDAGVersions } from '../../src/factory/planning/dag';
import { createEvidenceReadPort, createEmptyEvidenceReadPort, projectObservatory } from '../../src/factory/observatory/observatory';
import { answerApproval, changedPathsFromDiff, check, checkDetailed, emergencyStop, repoWriteGate } from '../../src/factory/policy/policy';
import { CAPABILITY_POOL } from '../../src/factory/routing/rules';
import type { BudgetState, RoutingDecisionRecord } from '../../src/factory/routing/decisionModel';
import {
  RECOVERY_ACTION_APPLIED,
  RESOURCE_UNAVAILABLE,
  recover,
  type FailureContext,
  type RecoveryBudgets,
  type RecoveryDeps,
} from '../../src/factory/recovery/recovery';
import {
  beforeDependencyRequest,
  circuitSnapshot,
  recordDependencyFailure,
  recordDependencySuccess,
} from '../../src/factory/recovery/circuitBreaker';
import { createScheduler, type SchedulerRouting } from '../../src/factory/scheduler/scheduler';
import { createArtifactStore, openStateStore } from '../../src/factory/state/store';
import type { ApprovalRecord } from '../../src/factory/policy/policy';
import {
  TELEMETRY_ATTEMPT_RECORDED,
  TELEMETRY_LAYERS,
  readAttemptTelemetry,
  recordAttemptTelemetry,
} from '../../src/factory/telemetry/telemetry';
import {
  type ExecutionEnvelope,
  type WorkerAdapter,
  type WorkerAnswer,
  type WorkerResult,
  type WorkerStatus,
} from '../../src/factory/workers/herdr';
import { createWorkerManager } from '../../src/factory/workers/manager';
import { createWorktreeManager } from '../../src/factory/worktrees/worktree';

/**
 * E9.1 (#27) — server orchestration spine. These tests exercise the exact
 * `buildServerDeps` wiring `factory start` uses, against a hermetic temp repo
 * (Ruling R5): `git init` fixture, OS temp dirs, a fake Herdr adapter, no
 * network, and no mutation of this repo's worktrees.
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
  workDir = mkdtempSync(join(tmpdir(), 'factory-e9-'));
  repoPath = initRepo(workDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake Herdr adapter (Ruling R5 — no live runtime)
// ---------------------------------------------------------------------------

class FakeHerdr implements WorkerAdapter {
  envelope: ExecutionEnvelope | null = null;
  delivered: WorkerAnswer[] = [];
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
  }
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
  async deliverAnswer(answer: WorkerAnswer): Promise<void> {
    this.delivered.push(answer);
  }
  async destroy(): Promise<void> {}
}

/** The branch the E3 worktree manager must now produce (policy Factory namespace). */
const expectedBranch = (workOrderId: string, taskId: string): string =>
  `wo-${workOrderId}/task-${taskId.slice(0, 8)}`;

/** A `factory.yaml` text with the E9.1 keys, pointed at the fixture repo. */
function configText(overrides: Partial<FactoryDesiredConfig> = {}): string {
  return serializeFactoryConfig({
    ...DEFAULT_FACTORY_CONFIG,
    repository: { path: repoPath },
    ...overrides,
  });
}

/** Build the resolved runtime the way `factory start` does from a `factory.yaml`. */
function runtimeFrom(text: string): ReturnType<typeof resolveFactoryConfig> {
  const parsed = parseFactoryConfig(text);
  if (!parsed.ok) throw new Error(`fixture factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
  return resolveFactoryConfig(parsed.config, { baseDir: workDir });
}

/** Create a Work Order, commit a one-node DAG, and move it to EXECUTING. */
function seedExecutingWorkOrder(
  store: ReturnType<typeof openStateStore>,
  events: ReturnType<typeof openEventLog>,
  options: { constraints?: string[] } = {},
): { wo: WorkOrder; task: Task } {
  const deps = { store, events };
  const wo = createWorkOrder(deps, {
    intent: 'E9 subject',
    acceptanceCriteria: ['accepted'],
    constraints: options.constraints,
  });
  for (const to of ['READY', 'PLANNING'] as const) {
    transitionWorkOrder(deps, wo.id, { to });
  }
  const dag = commitDAG(deps, wo.id, { nodes: [{ nodeId: 'a', title: 'A' }] });
  transitionWorkOrder(deps, wo.id, { to: 'EXECUTING' });
  const task = store.get<Task>('tasks', dag.nodes[0].taskId)!;
  return { wo, task };
}

function makeSpawn(adapters: FakeHerdr[]): ServerDepsOptions['spawn'] {
  return () => {
    const adapter = new FakeHerdr();
    adapters.push(adapter);
    return adapter;
  };
}

// ---------------------------------------------------------------------------
// AC1 — factory start assigns a READY task: RUNNING + worktree on disk
// ---------------------------------------------------------------------------

describe('E9.1 server orchestration spine — assignment', () => {
  it('moves a READY task to RUNNING and creates its worktree through the real server deps', async () => {
    const runtime = runtimeFrom(configText());
    const adapters: FakeHerdr[] = [];
    const deps = buildServerDeps(runtime, { spawn: makeSpawn(adapters) });
    try {
      const { wo, task } = seedExecutingWorkOrder(deps.store, deps.events);
      expect(task.state).toBe('PLANNED');

      deps.scheduler!.tick();
      // The dispatch is async (the adapter boot is awaited); let it settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const running = deps.store.get<Task>('tasks', task.id)!;
      expect(running.state).toBe('RUNNING');

      const assignment = deps.store
        .list<{ taskId: string; branch: string; worktreePath: string }>('assignments')
        .find((row) => row.taskId === task.id)!;
      expect(assignment).toBeDefined();
      expect(assignment.branch).toBe(expectedBranch(wo.id, task.id));
      expect(existsSync(assignment.worktreePath)).toBe(true);
      expect(assignment.worktreePath.startsWith(runtime.paths.root)).toBe(true);

      // The real policy ran: an ALLOW decision was recorded for the assignment.
      expect(deps.store.list<{ task: string | null; decision: string }>('policy_decisions').length).toBeGreaterThan(0);
      expect(adapters[0]?.envelope?.branch).toBe(expectedBranch(wo.id, task.id));
    } finally {
      deps.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — scheduler runs with the real E7 policy, and fails closed without one
// ---------------------------------------------------------------------------

describe('E9.1 server orchestration spine — policy', () => {
  it('binds the E7 repo.write gate to the task worktree branch (wo-* namespace + whole-worktree path)', () => {
    const runtime = runtimeFrom(configText());
    const adapters: FakeHerdr[] = [];
    const deps = buildServerDeps(runtime, { spawn: makeSpawn(adapters) });
    try {
      const { wo, task } = seedExecutingWorkOrder(deps.store, deps.events);

      const allowed = check(
        { store: deps.store, events: deps.events },
        { taskId: task.id, workOrderId: wo.id },
        { capability: 'repo.write', resource: { branch: expectedBranch(wo.id, task.id), path: '**' } },
      );
      expect(allowed).toBe('ALLOW');
    } finally {
      deps.store.close();
    }
  });

  it('fails closed: an unbound branch and a non-wo-* branch both resolve DENY (no bypass)', () => {
    const runtime = runtimeFrom(configText());
    const deps = buildServerDeps(runtime, { spawn: () => new FakeHerdr() });
    try {
      const { wo, task } = seedExecutingWorkOrder(deps.store, deps.events);
      const ref = { taskId: task.id, workOrderId: wo.id };

      // A branch binding is mandatory: `path: '**'` alone cannot satisfy the scope.
      expect(check({ store: deps.store, events: deps.events }, ref, {
        capability: 'repo.write',
        resource: { path: '**' },
      })).toBe('DENY');

      // A branch outside the Factory namespace is denied even with the path binding.
      expect(check({ store: deps.store, events: deps.events }, ref, {
        capability: 'repo.write',
        resource: { branch: 'main', path: '**' },
      })).toBe('DENY');
    } finally {
      deps.store.close();
    }
  });

  it('blocks assignment when the E7 verdict is DENY (a Work Order narrowing is enforced)', () => {
    const runtime = runtimeFrom(configText());
    const deps = buildServerDeps(runtime, { spawn: () => new FakeHerdr() });
    try {
      const { task } = seedExecutingWorkOrder(deps.store, deps.events, {
        constraints: ['policy:repo.write=deny'],
      });

      deps.scheduler!.tick();

      expect(deps.store.get<Task>('tasks', task.id)!.state).not.toBe('RUNNING');
      expect(deps.store.list<{ taskId: string }>('assignments')).toHaveLength(0);
      // The scheduler renders the blocking verdict, not a silent skip.
      expect(deps.scheduler!.status().queue.blockedPolicy.length).toBeGreaterThan(0);
    } finally {
      deps.store.close();
    }
  });

  it('blocks assignment loudly when no policy is wired (fail-closed default)', () => {
    const store = openStateStore(join(workDir, 'nopolicy.db'));
    const events = openEventLog(store.db);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      const workers = createWorkerManager({ store, events, spawn: () => new FakeHerdr() });
      const worktrees = createWorktreeManager({ rootDir: join(workDir, 'wt'), baseBranch: 'main' });
      const scheduler = createScheduler({ store, events, workers, worktrees, repoPath });
      const { task } = seedExecutingWorkOrder(store, events);

      scheduler.tick();

      expect(store.get<Task>('tasks', task.id)!.state).not.toBe('RUNNING');
      expect(store.list<{ taskId: string }>('assignments')).toHaveLength(0);
      expect(errors.some((line) => /policy/i.test(line))).toBe(true);
    } finally {
      console.error = originalError;
      store.close();
    }
  });

  it('warns once (not per tick) when no repoPath is wired and skips assignment', () => {
    const store = openStateStore(join(workDir, 'norepo.db'));
    const events = openEventLog(store.db);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      const workers = createWorkerManager({ store, events, spawn: () => new FakeHerdr() });
      const worktrees = createWorktreeManager({ rootDir: join(workDir, 'wt'), baseBranch: 'main' });
      const scheduler = createScheduler({
        store,
        events,
        workers,
        worktrees,
        policy: { canAssign: () => 'ALLOW' },
      });
      const { task } = seedExecutingWorkOrder(store, events);

      scheduler.tick();
      scheduler.tick();

      expect(store.get<Task>('tasks', task.id)!.state).not.toBe('RUNNING');
      expect(store.list<{ taskId: string }>('assignments')).toHaveLength(0);
      const repoWarnings = errors.filter((line) => /repoPath/.test(line));
      expect(repoWarnings).toHaveLength(1);
    } finally {
      console.error = originalError;
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — factory.yaml validates the new keys; a missing repo path fails loudly
// ---------------------------------------------------------------------------

describe('E9.1 factory.yaml — repository/worktrees/provisioning keys', () => {
  it('round-trips the default desired config and resolves the repo, worktree and provisioning keys', () => {
    const parsed = parseFactoryConfig(configText());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.repository.path).toBe(repoPath);
      expect(parsed.config.worktrees.baseBranch).toBeTruthy();
      expect(parsed.config.scheduler.provisioning.max).toBeGreaterThanOrEqual(1);
    }

    const runtime = runtimeFrom(configText());
    expect(runtime.repository.path).toBe(repoPath);
    expect(runtime.worktrees.rootDir.startsWith(runtime.paths.root)).toBe(true);
    expect(runtime.scheduler.provisioning.idleTimeoutMs).toBeGreaterThan(0);
  });

  it('rejects a config missing the repository path with a repository.path issue', () => {
    const withoutRepo = serializeFactoryConfig({
      ...DEFAULT_FACTORY_CONFIG,
      repository: { path: '' },
    });
    const parsed = parseFactoryConfig(withoutRepo);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.map((issue) => issue.path)).toContain('repository.path');
    }

    // A wholly absent repository block also fails loudly, not silently.
    const dropped = configText().replace(/repository:\n {2}path:.*\n/, '');
    expect(parseFactoryConfig(dropped).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Evidence read seam — store-backed, never fabricates
// ---------------------------------------------------------------------------

describe('E9.1 evidence read seam', () => {
  it('projects only durable complete bundles and never fabricates evidence', () => {
    const store = openStateStore(join(workDir, 'evidence.db'));
    try {
      store.set('work_orders', 'wo_1', { id: 'wo_1', state: 'MERGED' });
      store.set('tasks', 'task_1', { id: 'task_1', workOrderId: 'wo_1' });
      store.set('workers', 'worker_1', { id: 'worker_1' });
      store.set('attempts', 'attempt_1', {
        id: 'attempt_1',
        taskId: 'task_1',
        workerId: 'worker_1',
        model: 'model-x',
        diff: 'line one\nline two\n',
      });
      store.set('evidence_bundles', 'eb_complete', {
        id: 'eb_complete',
        workOrderId: 'wo_1',
        changeSetId: 'cs_attempt_1',
        createdAt: '2026-09-30T00:00:00.000Z',
        complete: true,
        attempts: [{ attemptId: 'attempt_1' }],
      });
      store.set('evidence_bundles', 'eb_incomplete', {
        id: 'eb_incomplete',
        workOrderId: 'wo_1',
        changeSetId: 'cs_attempt_1',
        createdAt: '2026-09-30T00:00:00.000Z',
        complete: false,
        attempts: [{ attemptId: 'attempt_1' }],
      });

      const port = createEvidenceReadPort(store);
      const changes = port.listVerifiedChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        id: 'eb_complete',
        workOrderId: 'wo_1',
        taskId: 'task_1',
        attemptId: 'attempt_1',
        linesChanged: 2,
        model: 'model-x',
        workerId: 'worker_1',
      });
      // An empty store yields no verified change (not a fabricated one).
      const empty = openStateStore(join(workDir, 'empty.db'));
      try {
        expect(projectObservatory(createEvidenceReadPort(empty)).verifiedPerDay).toEqual([]);
      } finally {
        empty.close();
      }
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E9.2 (#28) — DAG-commit API/CLI surface (import → plan → committed Task DAG)
// ---------------------------------------------------------------------------

interface DagHarness {
  store: ReturnType<typeof openStateStore>;
  events: ReturnType<typeof openEventLog>;
  server: ReturnType<typeof startFactoryServer>;
  client: ReturnType<typeof createFactoryClient>;
  url: string;
  stop(): void;
}

/**
 * A real server on real `buildServerDeps` wiring (hermetic: fake adapter,
 * temp-dir store, loopback only). This is the exact surface `factory serve`
 * exposes, so "the server is the sole mutation authority" is what is under test.
 */
function dagHarness(): DagHarness {
  const runtime = runtimeFrom(configText());
  const deps = buildServerDeps(runtime, { spawn: () => new FakeHerdr() });
  const server = startFactoryServer(deps);
  return {
    store: deps.store,
    events: deps.events,
    server,
    client: createFactoryClient({ baseUrl: server.url }),
    url: server.url,
    stop(): void {
      server.stop();
      deps.store.close();
    },
  };
}

interface Captured {
  io: CliIO;
  out(): string;
  err(): string;
}

function capture(cwd: string): Captured {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    io: {
      cwd,
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
    },
    out: () => outLines.join('\n'),
    err: () => errLines.join('\n'),
  };
}

/** Move a freshly-submitted DRAFT Work Order to the planning state over the API. */
async function advanceToPlanning(client: ReturnType<typeof createFactoryClient>, id: string): Promise<void> {
  for (const to of ['READY', 'PLANNING'] as const) {
    await client.transitionWorkOrder(id, { to });
  }
}

describe('E9.2 DAG-commit API surface', () => {
  it('commits a proposal as Tasks + dependency rows and a readable DAG v1', async () => {
    const h = dagHarness();
    try {
      const wo = await h.client.submitWorkOrder({ intent: 'import → plan', acceptanceCriteria: ['ok'] });
      await advanceToPlanning(h.client, wo.id);

      const result = await h.client.commitDag(wo.id, {
        rationale: 'two independent roots then a join',
        nodes: [
          { nodeId: 'a', title: 'Root A' },
          { nodeId: 'b', title: 'Root B' },
          { nodeId: 'c', title: 'Join', dependsOn: ['a', 'b'] },
        ],
      });

      expect(result.dag.version).toBe(1);
      expect(result.dag.workOrderId).toBe(wo.id);
      expect(result.dag.nodes).toHaveLength(3);

      // Tasks exist in durable state (server wrote them through E3, not the test).
      const tasks = h.store.list<Task>('tasks').filter((task) => task.workOrderId === wo.id);
      expect(tasks).toHaveLength(3);
      expect(tasks.map((task) => task.title).sort()).toEqual(['Join', 'Root A', 'Root B']);
      expect(tasks.every((task) => task.state === 'PLANNED')).toBe(true);

      // Dependency rows exist, and the join joins both roots.
      const deps = h.store.list<TaskDependency>('task_dependencies');
      const joinTask = tasks.find((task) => task.title === 'Join')!;
      const rootIds = tasks.filter((task) => task.title !== 'Join').map((task) => task.id);
      expect(deps.filter((edge) => edge.taskId === joinTask.id)).toHaveLength(2);
      expect(deps.map((edge) => edge.dependsOnTaskId).sort()).toEqual([...rootIds].sort());
      expect(joinTask.dependsOn.sort()).toEqual([...rootIds].sort());

      // v1 is durable and readable through the Work Order snapshot.
      const versions = listDAGVersions({ store: h.store, events: h.events }, wo.id);
      expect(versions.map((version) => version.version)).toEqual([1]);
      const snapshot = await h.client.getWorkOrder(wo.id);
      expect(snapshot.dag?.version).toBe(1);
      expect(snapshot.dag?.nodes).toHaveLength(3);
    } finally {
      h.stop();
    }
  });

  it('rejects an invalid DAG with DAG_INVALID and writes nothing; then v2 commits with v1 preserved', async () => {
    const h = dagHarness();
    try {
      const wo = await h.client.submitWorkOrder({ intent: 'replan' });
      await advanceToPlanning(h.client, wo.id);

      const v1 = await h.client.commitDag(wo.id, { nodes: [{ nodeId: 'a', title: 'A' }] });
      expect(v1.dag.version).toBe(1);

      // A replan requires EXECUTING (E3's REPLAN state guard); move there first.
      await h.client.transitionWorkOrder(wo.id, { to: 'EXECUTING' });

      // A cycle is rejected with a typed DAG_INVALID (422) and no partial write.
      const before = h.store.list<Task>('tasks').length;
      const cycleFailure = h.client.commitDag(wo.id, {
        nodes: [
          { nodeId: 'x', title: 'X', dependsOn: ['y'] },
          { nodeId: 'y', title: 'Y', dependsOn: ['x'] },
        ],
      });
      const error = await cycleFailure.catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(FactoryApiError);
      expect((error as FactoryApiError).code).toBe('DAG_INVALID');
      expect((error as FactoryApiError).status).toBe(422);
      expect((error as FactoryApiError).message).toMatch(/DAG_CYCLE/);
      expect(h.store.list<Task>('tasks')).toHaveLength(before);
      expect(listDAGVersions({ store: h.store, events: h.events }, wo.id).map((v) => v.version)).toEqual([1]);

      // An unknown dependency is rejected too, still writing nothing.
      const unknown = await h.client
        .commitDag(wo.id, { nodes: [{ nodeId: 'z', title: 'Z', dependsOn: ['ghost'] }] })
        .catch((thrown: unknown) => thrown);
      expect(unknown).toBeInstanceOf(FactoryApiError);
      expect((unknown as FactoryApiError).code).toBe('DAG_INVALID');
      expect((unknown as FactoryApiError).message).toMatch(/DAG_UNKNOWN_DEP/);
      expect(h.store.list<Task>('tasks')).toHaveLength(before);

      const v2 = await h.client.commitDag(wo.id, {
        nodes: [
          { nodeId: 'a2', title: 'A2' },
          { nodeId: 'b2', title: 'B2', dependsOn: ['a2'] },
        ],
      });
      expect(v2.dag.version).toBe(2);

      // Both versions remain readable and v1 is untouched.
      const versions = listDAGVersions({ store: h.store, events: h.events }, wo.id);
      expect(versions.map((version) => version.version)).toEqual([1, 2]);
      expect(versions[0]).toEqual(v1.dag);
      expect(versions[1]).toEqual(v2.dag);
      expect((await h.client.getWorkOrder(wo.id)).dag?.version).toBe(2);
    } finally {
      h.stop();
    }
  });

  it('rejects a first plan while the Work Order is not PLANNING (state guard surfaced)', async () => {
    const h = dagHarness();
    try {
      const wo = await h.client.submitWorkOrder({ intent: 'still draft' });
      const error = await h.client
        .commitDag(wo.id, { nodes: [{ nodeId: 'a', title: 'A' }] })
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(FactoryApiError);
      expect((error as FactoryApiError).code).toBe('DAG_INVALID');
      expect((error as FactoryApiError).status).toBe(422);
      expect((error as FactoryApiError).message).toMatch(/DRAFT; cannot propose DAG v1/);
      expect(h.store.list<Task>('tasks')).toHaveLength(0);
      expect(listDAGVersions({ store: h.store, events: h.events }, wo.id)).toEqual([]);
    } finally {
      h.stop();
    }
  });
});

describe('E9.2 DAG-commit CLI surface', () => {
  it('imports a Work Order and plans it with `factory wo plan <id> --dag <file>`', async () => {
    const h = dagHarness();
    try {
      const wo = await h.client.submitWorkOrder({ intent: 'cli plan' });
      await advanceToPlanning(h.client, wo.id);

      const dagFile = join(workDir, 'proposal.json');
      writeFileSync(
        dagFile,
        JSON.stringify({
          rationale: 'onboarding',
          nodes: [
            { nodeId: 'a', title: 'Scaffold' },
            { nodeId: 'b', title: 'Ship', dependsOn: ['a'] },
          ],
        }),
      );

      const cap = capture(workDir);
      expect(await runCli(['wo', 'plan', wo.id, '--dag', dagFile, '--url', h.url], cap.io)).toBe(0);
      const out = JSON.parse(cap.out()) as { dag: { version: number; nodes: Array<{ taskId: string }> } };
      expect(out.dag.version).toBe(1);
      expect(out.dag.nodes).toHaveLength(2);

      const tasks = h.store.list<Task>('tasks').filter((task) => task.workOrderId === wo.id);
      expect(tasks).toHaveLength(2);
      expect(h.store.list<TaskDependency>('task_dependencies')).toHaveLength(1);

      // A server rejection is surfaced as a non-zero exit + message (no shell mutation).
      const badFile = join(workDir, 'bad.json');
      writeFileSync(badFile, JSON.stringify({ nodes: [{ nodeId: 'loop', title: 'L', dependsOn: ['loop'] }] }));
      await h.client.transitionWorkOrder(wo.id, { to: 'EXECUTING' });
      const bad = capture(workDir);
      expect(await runCli(['wo', 'plan', wo.id, '--dag', badFile, '--url', h.url], bad.io)).toBe(1);
      expect(bad.err()).toMatch(/DAG_INVALID|DAG_SELF_DEP/);
      expect(h.store.list<Task>('tasks')).toHaveLength(2);
    } finally {
      h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// E9.3 (#29) — routing decision wired into assignment (Ruling RE7)
// ---------------------------------------------------------------------------

/**
 * A scheduler harness on real deps (temp store, fake Herdr, real worktree
 * manager) that lets a case inject the E4 routing gates (budget/unavailable)
 * and an ALLOW policy, so the routing path is exercised without E7 in the way.
 */
function routingHarness(routing?: SchedulerRouting) {
  const store = openStateStore(join(workDir, `routing-${crypto.randomUUID()}.db`));
  const events = openEventLog(store.db);
  const adapters: FakeHerdr[] = [];
  const workers = createWorkerManager({ store, events, spawn: makeSpawn(adapters) });
  const worktrees = createWorktreeManager({ rootDir: join(workDir, 'wt'), baseBranch: 'main' });
  const scheduler = createScheduler({
    store,
    events,
    workers,
    worktrees,
    repoPath,
    policy: { canAssign: () => 'ALLOW' },
    ...(routing ? { routing } : {}),
  });
  return { store, events, adapters, scheduler, close: () => store.close() };
}

describe('E9.3 routing → assignment', () => {
  it('records the routed model on the Attempt and a routing_decisions provenance row', async () => {
    const h = routingHarness();
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events);

      h.scheduler.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('RUNNING');

      const attempts = h.store.list<Attempt>('attempts').filter((a) => a.taskId === task.id);
      expect(attempts).toHaveLength(1);
      // Defaults (RE7(a)): task=implementation, complexity=normal, context=small,
      // risk medium (YELLOW) -> implementer, the first candidate.
      expect(attempts[0]!.model).toBe('implementer');

      const decisions = h.store.list<RoutingDecisionRecord>('routing_decisions');
      expect(decisions).toHaveLength(1);
      const decision = decisions[0]!;
      expect(decision.taskId).toBe(task.id);
      expect(decision.workOrderId).toBe(wo.id);
      expect(decision.source).toBe('rules');
      expect(decision.selected).toBe('implementer');
      expect(decision.task).toBe('implementation');
      expect(decision.complexity).toBe('normal');
      expect(decision.risk).toBe('medium');
      expect(decision.context).toBe('small');
      expect(decision.candidates).toContain('implementer');
      // RE7(a): the derivation provenance records that these came from defaults.
      expect(decision.derivedFrom).toEqual({
        task: 'default',
        complexity: 'default',
        context: 'default',
      });

      // The durable event carries the same record (provenance, not just a row).
      const recorded = h.events
        .readEvents()
        .filter((event) => event.type === 'routing.decision_recorded');
      expect(recorded).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('derives RouteInput from Work Order constraints and records the derivation in metadata', () => {
    const h = routingHarness();
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events, {
        constraints: ['route-task:code-review', 'route-complexity:complex', 'route-context:large'],
      });
      // A GREEN Work Order maps to low risk (RE7(a)); read the durable row so the
      // EXECUTING state is preserved.
      const executing = h.store.get<WorkOrder>('work_orders', wo.id)!;
      h.store.set('work_orders', wo.id, { ...executing, riskTier: 'GREEN' });

      h.scheduler.tick();

      const decision = h.store.list<RoutingDecisionRecord>('routing_decisions')[0]!;
      expect(decision.taskId).toBe(task.id);
      expect(decision.task).toBe('code-review');
      expect(decision.complexity).toBe('complex');
      expect(decision.risk).toBe('low');
      expect(decision.context).toBe('large');
      // code-review at low risk -> reviewer.
      expect(decision.selected).toBe('reviewer');
      // RE7(a): all three classified dimensions came from constraints.
      expect(decision.derivedFrom).toEqual({
        task: 'constraint',
        complexity: 'constraint',
        context: 'constraint',
      });
      expect(h.store.get<Attempt>('attempts', h.store.list<Attempt>('attempts')[0]!.id)!.model).toBe(
        'reviewer',
      );
    } finally {
      h.close();
    }
  });

  it('ignores an out-of-vocabulary constraint value and uses the documented default', () => {
    const h = routingHarness();
    try {
      const { task } = seedExecutingWorkOrder(h.store, h.events, {
        constraints: ['route-task:not-a-real-task', 'route-complexity:enormous', 'route-context:gigantic'],
      });
      // YELLOW (default tier) → medium risk.
      h.scheduler.tick();

      const decision = h.store.list<RoutingDecisionRecord>('routing_decisions')[0]!;
      expect(decision.taskId).toBe(task.id);
      expect(decision.task).toBe('implementation');
      expect(decision.complexity).toBe('normal');
      expect(decision.risk).toBe('medium');
      expect(decision.context).toBe('small');
      expect(decision.derivedFrom).toEqual({
        task: 'default',
        complexity: 'default',
        context: 'default',
      });
    } finally {
      h.close();
    }
  });

  it('parks a blocked route: Task stays READY, no Attempt, resource.unavailable + status blockedRouting', () => {
    // Every pool member unavailable => RoutingBlockedError (RE7(c)).
    const h = routingHarness({ unavailable: [...CAPABILITY_POOL] });
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events);

      h.scheduler.tick();
      // A second tick retries the READY Task; the park event is not re-appended
      // while the blocked set is unchanged (no event flood).
      h.scheduler.tick();

      // No substitution, no fabricated Attempt, no Task transition to ASSIGNED.
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('READY');
      expect(h.store.list<Attempt>('attempts')).toHaveLength(0);
      expect(h.store.list<{ taskId: string }>('assignments')).toHaveLength(0);

      // E7's resource-unavailable event is bound to the Work Order (durable park).
      const unavailable = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .filter((event) => event.type === RESOURCE_UNAVAILABLE);
      expect(unavailable).toHaveLength(1);

      // The scheduler surfaces the blocked route rather than silently skipping.
      const blocked = h.scheduler.status().queue.blockedRouting;
      expect(blocked).toHaveLength(1);
      expect(blocked[0]!.taskId).toBe(task.id);
      expect(blocked[0]!.unavailable).toEqual([...CAPABILITY_POOL]);
      expect(blocked[0]!.candidates.length).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  });

  it('honours a Work Order model:<id> override with source "override"', () => {
    const h = routingHarness();
    try {
      const { task } = seedExecutingWorkOrder(h.store, h.events, {
        constraints: ['model:frontier'],
      });

      h.scheduler.tick();

      const decision = h.store.list<RoutingDecisionRecord>('routing_decisions')[0]!;
      expect(decision.taskId).toBe(task.id);
      expect(decision.source).toBe('override');
      expect(decision.selected).toBe('frontier');
      const attempt = h.store.list<Attempt>('attempts')[0]!;
      expect(attempt.model).toBe('frontier');
    } finally {
      h.close();
    }
  });

  it('falls back to rules when the override names an unknown model (never invents a model)', () => {
    const h = routingHarness();
    try {
      const { task } = seedExecutingWorkOrder(h.store, h.events, {
        constraints: ['model:no-such-model'],
      });

      h.scheduler.tick();

      const attempt = h.store.list<Attempt>('attempts').find((a) => a.taskId === task.id)!;
      expect(attempt.model).toBe('implementer');
      const decision = h.store.list<RoutingDecisionRecord>('routing_decisions')[0]!;
      expect(decision.source).toBe('rules');
      expect(decision.selected).toBe('implementer');
    } finally {
      h.close();
    }
  });

  it('falls back to rules (source "rules") when the override model is unavailable', () => {
    // Override names frontier, but frontier is unavailable: E4 falls back to
    // the rules and the record is marked 'rules' — never mislabelled 'override'.
    const h = routingHarness({ unavailable: ['frontier'] });
    try {
      const { task } = seedExecutingWorkOrder(h.store, h.events, {
        constraints: ['model:frontier'],
      });

      h.scheduler.tick();

      const decision = h.store.list<RoutingDecisionRecord>('routing_decisions')[0]!;
      expect(decision.taskId).toBe(task.id);
      expect(decision.source).toBe('rules');
      expect(decision.selected).not.toBe('frontier');
      expect(decision.unavailable).toContain('frontier');
    } finally {
      h.close();
    }
  });

  it('does not budget-gate an override but still records the budget snapshot', () => {
    const drained: BudgetState = { monthlyRemaining: 0, weeklyRemaining: 0, fiveHourRemaining: 0 };
    const h = routingHarness({ budget: drained });
    try {
      seedExecutingWorkOrder(h.store, h.events, { constraints: ['route:frontier'] });

      h.scheduler.tick();

      const decision = h.store.list<RoutingDecisionRecord>('routing_decisions')[0]!;
      expect(decision.source).toBe('override');
      expect(decision.selected).toBe('frontier');
      expect(decision.budget).toEqual(drained);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E9.4 (#30) — verification + evidence orchestration on the live path
// ---------------------------------------------------------------------------

/**
 * A scheduler harness wired with an E5-backed {@link WorkVerifier}. Uses real
 * `createVerificationEngine` + `createSemanticVerifier` + `buildEvidenceBundle`
 * with fake check providers and a fake judge: the live orchestration path is
 * under test, nothing reaches a network or a model.
 */
function verificationHarness(options: {
  providers: Array<{
    id: string;
    category: 'deterministic' | 'behavioral';
    kind: string;
    passed: boolean;
    diagnosis?: string;
  }>;
  judgeModel: string;
  falsified?: string[];
  /**
   * Optional controlled mode: defer each Task's settlement until the test calls
   * `settle(taskId)`, and route Tasks whose id is in `failTasks` through a
   * failing check. The Set is read at verify time, so the test can populate it
   * after seeding tasks. Used to observe multi-Task interleaving across ticks.
   */
  controlled?: { failTasks?: Set<string> };
}) {
  const store = openStateStore(join(workDir, `verify-${crypto.randomUUID()}.db`));
  const events = openEventLog(store.db);
  const buildVerifier = (forceFail: boolean) => {
    const engine = createVerificationEngine();
    for (const provider of options.providers) {
      engine.registerCheck({
        id: provider.id,
        category: provider.category,
        kind: provider.kind as never,
        run: () =>
          provider.passed && !forceFail
            ? { passed: true, evidence: { summary: `${provider.id} ok` } }
            : {
                passed: false,
                evidence: { summary: `${provider.id} failed` },
                diagnosis: provider.diagnosis ?? `${provider.id} failed`,
                action: `fix ${provider.id}`,
              },
      });
    }
    const judge: SemanticJudge = {
      identity: { provider: 'judge-co', model: options.judgeModel, family: 'judge-family' },
      falsify: (context) =>
        context.criteria.map((criterion) => ({
          criterion,
          falsified: (options.falsified ?? []).includes(criterion),
          evidence: { summary: `judge reviewed "${criterion}"` },
          diagnosis: `judge falsified "${criterion}"`,
          action: `address "${criterion}"`,
        })),
    };
    return createE5Verifier({
      store,
      engine,
      judge,
      prompt: { id: 'e9-verify', version: '1' },
      rubric: ['Does the change set satisfy the criterion as written?'],
      provider: 'factory',
      now: () => '2026-09-30T12:00:00.000Z',
    });
  };
  const passing = buildVerifier(false);
  const failing = buildVerifier(true);

  const settleFns = new Map<string, () => void>();
  const settle = (taskId: string): void => settleFns.get(taskId)?.();
  const verifier: WorkVerifier = options.controlled
    ? {
        verify: (subject) =>
          new Promise((resolve) => {
            const real = options.controlled!.failTasks?.has(subject.task.id) ? failing : passing;
            settleFns.set(subject.task.id, () => {
              void real.verify(subject).then(resolve);
            });
          }),
      }
    : passing;

  const workers = createWorkerManager({ store, events, spawn: () => new FakeHerdr() });
  const worktrees = createWorktreeManager({ rootDir: join(workDir, 'wt'), baseBranch: 'main' });
  const scheduler = createScheduler({
    store,
    events,
    workers,
    worktrees,
    repoPath,
    policy: { canAssign: () => 'ALLOW' },
    verifier,
  });
  return { store, events, scheduler, verifier, settle, close: () => store.close() };
}

/** Drive a seeded Task through the real §5.2 edges to SUCCESS, with an Attempt. */
function driveTaskToSuccess(
  store: ReturnType<typeof openStateStore>,
  events: ReturnType<typeof openEventLog>,
  taskId: string,
  model: string,
  diff = 'diff --git a/x b/x\n+export const x = 1;',
): Attempt {
  const deps = { store, events };
  const attempt = createAttempt(deps, { taskId, model });
  completeAttempt(deps, attempt.id, {
    outcome: 'success',
    diff,
    artifactIds: ['art_1'],
  });
  for (const to of ['READY', 'ASSIGNED', 'RUNNING', 'SUCCESS'] as const) {
    transitionTask(deps, taskId, { to });
  }
  return store.get<Attempt>('attempts', attempt.id)!;
}

/** Run a tick, let the async verification settle, then route it on the next tick. */
async function verifyTick(scheduler: ReturnType<typeof createScheduler>): Promise<void> {
  scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  scheduler.tick();
}

/** Seed a two-node Work Order (a, b) in EXECUTING and return its Tasks. */
function seedTwoTaskWorkOrder(
  store: ReturnType<typeof openStateStore>,
  events: ReturnType<typeof openEventLog>,
): { wo: WorkOrder; tasks: Task[] } {
  const deps = { store, events };
  const wo = createWorkOrder(deps, {
    intent: 'E9.4 two-task subject',
    acceptanceCriteria: ['accepted'],
  });
  for (const to of ['READY', 'PLANNING'] as const) {
    transitionWorkOrder(deps, wo.id, { to });
  }
  const dag = commitDAG(deps, wo.id, {
    nodes: [
      { nodeId: 'a', title: 'A' },
      { nodeId: 'b', title: 'B' },
    ],
  });
  transitionWorkOrder(deps, wo.id, { to: 'EXECUTING' });
  const tasks = dag.nodes.map((node) => store.get<Task>('tasks', node.taskId)!);
  return { wo, tasks };
}

describe('E9.4 verification + evidence orchestration', () => {
  it('persists an immutable Evidence Bundle mapping every AC, then gates the WO at HUMAN_GATE', async () => {
    const h = verificationHarness({
      providers: [
        { id: 'typecheck', category: 'deterministic', kind: 'typecheck', passed: true },
        { id: 'playwright', category: 'behavioral', kind: 'playwright', passed: true },
      ],
      judgeModel: 'judge-1',
    });
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events);
      driveTaskToSuccess(h.store, h.events, task.id, 'writer-xl');

      await verifyTick(h.scheduler);

      // The Task's AC maps to a persisted bundle retrievable by id.
      const bundles = h.store.list<EvidenceBundle>('evidence_bundles');
      expect(bundles).toHaveLength(1);
      const bundle = h.store.get<EvidenceBundle>('evidence_bundles', bundles[0]!.id)!;
      expect(bundle.id.startsWith('eb_')).toBe(true);
      expect(bundle.workOrderId).toBe(wo.id);
      expect(bundle.changeSetId.startsWith('cs_')).toBe(true);

      // Every acceptance criterion maps to concrete proof (never uncovered).
      expect(bundle.criteria).toHaveLength(1);
      expect(bundle.criteria[0]!.criterion).toBe('accepted');
      expect(bundle.criteria[0]!.status).toBe('pass');
      expect(bundle.criteria[0]!.proofs.length).toBeGreaterThan(0);
      expect(bundle.criteria.every((criterion) => criterion.status === 'pass')).toBe(true);
      expect(bundle.complete).toBe(true);

      // The bundle is a copy of its inputs: mutating the store row cannot rewrite
      // the receipt the scheduler already persisted (idempotent re-read).
      const snapshot = structuredClone(bundle);
      expect(h.store.get<EvidenceBundle>('evidence_bundles', bundle.id)).toEqual(snapshot);

      // The assembled receipt is deep-frozen: it cannot be rewritten after
      // production, so a promotion gate can trust what it reads.
      const produced = await h.verifier.verify({
        workOrder: h.store.get<WorkOrder>('work_orders', wo.id)!,
        task: h.store.get<Task>('tasks', task.id)!,
        attempt: h.store
          .list<Attempt>('attempts')
          .find((candidate) => candidate.taskId === task.id)!,
      });
      expect(produced.bundle).not.toBeNull();
      expect(() => {
        (produced.bundle as unknown as { complete: boolean }).complete = false;
      }).toThrow();

      // Verification drives the Work Order lifecycle to the human gate, and the
      // Task to VERIFIED.
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('VERIFIED');
      expect(h.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('HUMAN_GATE');

      // The WO passed through the §5.1 verification states in order.
      const states = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .filter((event) => event.type === 'work_order.transitioned')
        .map((event) => (event.payload as { workOrder: WorkOrder }).workOrder.state);
      expect(states).toContain('VERIFYING');
      expect(states).toContain('EVIDENCE_READY');
      expect(states.indexOf('VERIFYING')).toBeLessThan(states.indexOf('EVIDENCE_READY'));
      expect(states.indexOf('EVIDENCE_READY')).toBeLessThan(states.indexOf('HUMAN_GATE'));

      // A later tick does not re-verify or duplicate the evidence (task is VERIFIED).
      h.scheduler.tick();
      expect(h.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('turns a failing AC into a structured failure and REWORK, never a gate', async () => {
    const h = verificationHarness({
      providers: [
        { id: 'typecheck', category: 'deterministic', kind: 'typecheck', passed: true },
        {
          id: 'playwright',
          category: 'behavioral',
          kind: 'playwright',
          passed: false,
          diagnosis: 'checkout button missing',
        },
      ],
      judgeModel: 'judge-1',
    });
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events);
      driveTaskToSuccess(h.store, h.events, task.id, 'writer-xl');

      await verifyTick(h.scheduler);

      // No evidence, no gate: fail closed and drive rework.
      expect(h.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(h.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('REWORK');

      // The failure is structured with every §14.4 field, durably recorded.
      const failures = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .filter((event) => event.type === 'verification.failed');
      expect(failures).toHaveLength(1);
      const records = (failures[0]!.payload as { failures: FailureRecord[] }).failures;
      expect(records.length).toBeGreaterThan(0);
      const record = records[0]!;
      expect(record.category).toBe('behavioral');
      expect(record.criterion).toBe('accepted');
      expect(record.verifier).toBe('playwright');
      expect(record.evidence.summary).toContain('failed');
      expect(record.diagnosis).toBe('checkout button missing');
      expect(record.action).toBe('fix playwright');

      // The WO never reached a gate.
      const states = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .filter((event) => event.type === 'work_order.transitioned')
        .map((event) => (event.payload as { workOrder: WorkOrder }).workOrder.state);
      expect(states).not.toContain('HUMAN_GATE');
      expect(states[states.length - 1]).toBe('REWORK');
    } finally {
      h.close();
    }
  });

  it('rejects same-model self-sign-off on the live path: no bundle, REWORK', async () => {
    const h = verificationHarness({
      providers: [{ id: 'typecheck', category: 'deterministic', kind: 'typecheck', passed: true }],
      // The judge is the writer: the semantic verifier must refuse to sign off.
      judgeModel: 'writer-xl',
    });
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events);
      driveTaskToSuccess(h.store, h.events, task.id, 'writer-xl');

      await verifyTick(h.scheduler);

      expect(h.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(h.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('REWORK');

      const rejection = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.rejected');
      expect(rejection).toBeDefined();
      expect((rejection!.payload as { diagnosis: string }).diagnosis).toMatch(
        /same-model self-sign-off/i,
      );
    } finally {
      h.close();
    }
  });

  it('drives REWORK from a semantic falsification with a structured semantic failure', async () => {
    const h = verificationHarness({
      providers: [{ id: 'typecheck', category: 'deterministic', kind: 'typecheck', passed: true }],
      judgeModel: 'judge-1',
      falsified: ['accepted'],
    });
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events);
      driveTaskToSuccess(h.store, h.events, task.id, 'writer-xl');

      await verifyTick(h.scheduler);

      // All deterministic checks passed, yet the independent verifier falsified
      // the criterion: the semantic tier alone drives rework, never a gate.
      expect(h.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(h.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('REWORK');

      const failure = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.failed');
      const record = (failure!.payload as { failures: FailureRecord[] }).failures[0]!;
      expect(record.category).toBe('semantic');
      expect(record.criterion).toBe('accepted');
      expect(record.verifier).toBe('judge-co/judge-1');
      expect(record.diagnosis).toContain('falsified');
    } finally {
      h.close();
    }
  });

  it('fails closed when no verifier is wired: a SUCCESS task is never promoted', () => {
    const store = openStateStore(join(workDir, 'noverifier.db'));
    const events = openEventLog(store.db);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      const workers = createWorkerManager({ store, events, spawn: () => new FakeHerdr() });
      const worktrees = createWorktreeManager({ rootDir: join(workDir, 'wt'), baseBranch: 'main' });
      const scheduler = createScheduler({
        store,
        events,
        workers,
        worktrees,
        repoPath,
        policy: { canAssign: () => 'ALLOW' },
      });
      const { wo, task } = seedExecutingWorkOrder(store, events);
      driveTaskToSuccess(store, events, task.id, 'writer-xl');

      scheduler.tick();

      expect(store.get<Task>('tasks', task.id)!.state).toBe('SUCCESS');
      expect(store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('EXECUTING');
      expect(store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(errors.some((line) => /verifier/i.test(line))).toBe(true);
    } finally {
      console.error = originalError;
      store.close();
    }
  });

  it('rejects a qualified provider/model writer that is the same model as the judge', async () => {
    const h = verificationHarness({
      providers: [{ id: 'typecheck', category: 'deterministic', kind: 'typecheck', passed: true }],
      // Judge identity is {provider:'judge-co', model:'judge-1'}; the writing
      // Attempt records the qualified form. A raw string comparison would miss
      // the match and let the same model sign off its own work.
      judgeModel: 'judge-1',
    });
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events);
      driveTaskToSuccess(h.store, h.events, task.id, 'judge-co/judge-1');

      await verifyTick(h.scheduler);

      expect(h.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(h.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('REWORK');
      const rejection = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.rejected');
      expect((rejection!.payload as { diagnosis: string }).diagnosis).toMatch(
        /same-model self-sign-off/i,
      );
    } finally {
      h.close();
    }
  });

  it('rejects a bare writer that is the same model as a qualified judge identity', async () => {
    const h = verificationHarness({
      providers: [{ id: 'typecheck', category: 'deterministic', kind: 'typecheck', passed: true }],
      // Judge identity records the qualified form; the writer records the bare
      // model. The same underlying model must still be refused.
      judgeModel: 'judge-co/judge-1',
    });
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events);
      driveTaskToSuccess(h.store, h.events, task.id, 'judge-1');

      await verifyTick(h.scheduler);

      expect(h.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(h.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      const rejection = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.rejected');
      expect((rejection!.payload as { diagnosis: string }).diagnosis).toMatch(
        /same-model self-sign-off/i,
      );
    } finally {
      h.close();
    }
  });

  it('diagnoses a gate shortfall (no checks executed) instead of REWORK with no failures', async () => {
    const h = verificationHarness({ providers: [], judgeModel: 'judge-1' });
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events);
      driveTaskToSuccess(h.store, h.events, task.id, 'writer-xl');

      await verifyTick(h.scheduler);

      // No providers → every criterion unmapped: fail closed, but the REWORK
      // must carry a structured diagnosis, not an empty failure list.
      expect(h.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(h.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      const failure = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.failed');
      const record = (failure!.payload as { failures: FailureRecord[] }).failures[0]!;
      expect(record.verifier).toBe('verification-gate');
      // The AC has semantic proof but no deterministic/behavioral proof: the gap
      // is the unmet run gate, not a specific criterion.
      expect(record.criterion).toBeNull();
      expect(record.evidence.summary.length).toBeGreaterThan(0);
      expect(record.diagnosis.length).toBeGreaterThan(0);
      expect(record.action.length).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  });

  it('turns a synchronous verifier throw into a rejection (REWORK), not a crash or a strand', () => {
    const store = openStateStore(join(workDir, `sync-throw-${crypto.randomUUID()}.db`));
    const events = openEventLog(store.db);
    try {
      const throwing: WorkVerifier = {
        verify: (() => {
          throw new Error('verifier exploded synchronously');
        }) as WorkVerifier['verify'],
      };
      const workers = createWorkerManager({ store, events, spawn: () => new FakeHerdr() });
      const worktrees = createWorktreeManager({ rootDir: join(workDir, 'wt'), baseBranch: 'main' });
      const scheduler = createScheduler({
        store,
        events,
        workers,
        worktrees,
        repoPath,
        policy: { canAssign: () => 'ALLOW' },
        verifier: throwing,
      });
      const { wo, task } = seedExecutingWorkOrder(store, events);
      driveTaskToSuccess(store, events, task.id, 'writer-xl');

      expect(() => scheduler.tick()).not.toThrow();
      // The throw settled as a rejection routed on the next tick.
      scheduler.tick();

      expect(store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      expect(store.get<Task>('tasks', task.id)!.state).toBe('REWORK');
      const rejection = events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.rejected');
      expect((rejection!.payload as { diagnosis: string }).diagnosis).toBe(
        'verifier exploded synchronously',
      );
    } finally {
      store.close();
    }
  });

  it('does not gate a multi-Task Work Order until every Task is VERIFIED', async () => {
    const h = verificationHarness({
      providers: [
        { id: 'typecheck', category: 'deterministic', kind: 'typecheck', passed: true },
        { id: 'playwright', category: 'behavioral', kind: 'playwright', passed: true },
      ],
      judgeModel: 'judge-1',
      controlled: {},
    });
    try {
      const { wo, tasks } = seedTwoTaskWorkOrder(h.store, h.events);
      const [taskA, taskB] = tasks as [Task, Task];
      driveTaskToSuccess(h.store, h.events, taskA.id, 'writer-a');
      driveTaskToSuccess(h.store, h.events, taskB.id, 'writer-b');

      // Tick 1 kicks both verifications into flight.
      h.scheduler.tick();

      // A settles first; B is still pending. The order must not gate with an
      // unverified sibling Task outstanding.
      h.settle(taskA.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      h.scheduler.tick();
      expect(h.store.get<Task>('tasks', taskA.id)!.state).toBe('VERIFIED');
      expect(h.store.get<Task>('tasks', taskB.id)!.state).toBe('SUCCESS');
      expect(h.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('EXECUTING');

      // B settles: now every active Task is VERIFIED and the order gates.
      h.settle(taskB.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      h.scheduler.tick();
      expect(h.store.get<Task>('tasks', taskB.id)!.state).toBe('VERIFIED');
      expect(h.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('HUMAN_GATE');
      expect(h.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it('never gates a multi-Task Work Order when one Task fails verification', async () => {
    const failTasks = new Set<string>();
    const h = verificationHarness({
      providers: [
        { id: 'typecheck', category: 'deterministic', kind: 'typecheck', passed: true },
        { id: 'playwright', category: 'behavioral', kind: 'playwright', passed: true },
      ],
      judgeModel: 'judge-1',
      controlled: { failTasks },
    });
    try {
      const { wo, tasks } = seedTwoTaskWorkOrder(h.store, h.events);
      const [taskA, taskB] = tasks as [Task, Task];
      driveTaskToSuccess(h.store, h.events, taskA.id, 'writer-a');
      driveTaskToSuccess(h.store, h.events, taskB.id, 'writer-b');
      failTasks.add(taskB.id);

      h.scheduler.tick();
      // One pass, one fail, settling in the same batch order (A then B).
      h.settle(taskA.id);
      h.settle(taskB.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      h.scheduler.tick();

      // A verified but B failed: the Work Order must never have gated.
      expect(h.store.get<Task>('tasks', taskA.id)!.state).toBe('VERIFIED');
      expect(h.store.get<Task>('tasks', taskB.id)!.state).toBe('REWORK');
      expect(h.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      const states = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .filter((event) => event.type === 'work_order.transitioned')
        .map((event) => (event.payload as { workOrder: WorkOrder }).workOrder.state);
      expect(states).not.toContain('HUMAN_GATE');
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E9.5 (#31) — human loops: approval answering + worker answer delivery
// ---------------------------------------------------------------------------

/**
 * A controllable Herdr adapter for the human loops. `result` is the runtime's
 * next report; `collectArtifacts` returns a *fresh copy* each call so the
 * scheduler's consume-once guard is exercised on content, not object identity —
 * exactly the "stale report re-collected" hazard the answer loop must survive.
 * `deliverAnswer` records what the runtime received (the answer channel).
 */
class ControllableHerdr implements WorkerAdapter {
  result: WorkerResult | null = null;
  envelope: ExecutionEnvelope | null = null;
  delivered: WorkerAnswer[] = [];
  async provision(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async status(): Promise<WorkerStatus> {
    const state: WorkerStatus['state'] = this.result
      ? this.result.status === 'completed'
        ? 'completed'
        : this.result.status === 'waiting_input'
          ? 'waiting_input'
          : 'failed'
      : 'running';
    return { state, lastHeartbeatAt: new Date().toISOString() };
  }
  async execute(envelope: ExecutionEnvelope): Promise<void> {
    this.envelope = envelope;
  }
  async collectArtifacts(): Promise<WorkerResult> {
    return structuredClone(this.result ?? failedWorkerResult('no result produced'));
  }
  async deliverAnswer(answer: WorkerAnswer): Promise<void> {
    this.delivered.push(answer);
  }
  async destroy(): Promise<void> {}
}

function failedWorkerResult(failure: string): WorkerResult {
  return {
    status: 'failed',
    commits: [],
    artifacts: [],
    interactions: [],
    observations: [],
    verificationRequests: [],
    diff: null,
    failure,
  };
}

function waitingWorkerResult(question: string): WorkerResult {
  return {
    status: 'waiting_input',
    commits: [],
    artifacts: [],
    interactions: [{ question }],
    observations: [],
    verificationRequests: [],
    diff: null,
    failure: null,
  };
}

function completedWorkerResult(): WorkerResult {
  return {
    status: 'completed',
    commits: [{ sha: 'cafe', message: 'after the answer' }],
    artifacts: [],
    interactions: [],
    observations: [],
    verificationRequests: [],
    diff: 'diff --git a/x b/x\n+done',
    failure: null,
  };
}

/** A real server (real `buildServerDeps` wiring) plus its spawned adapters. */
function humanLoopHarness(initial?: WorkerResult) {
  const runtime = runtimeFrom(configText());
  const adapters: ControllableHerdr[] = [];
  const deps = buildServerDeps(runtime, {
    spawn: () => {
      const adapter = new ControllableHerdr();
      if (initial) adapter.result = structuredClone(initial);
      adapters.push(adapter);
      return adapter;
    },
    now: () => new Date().toISOString(),
  });
  const server = startFactoryServer(deps);
  const client = createFactoryClient({ baseUrl: server.url });
  return {
    store: deps.store,
    events: deps.events,
    adapters,
    scheduler: deps.scheduler!,
    client,
    url: server.url,
    async poll(): Promise<void> {
      // Let the async adapter dispatch/collect settle between ticks.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    close(): void {
      server.stop();
      deps.store.close();
    },
  };
}

const approvalsIn = (store: ReturnType<typeof openStateStore>): ApprovalRecord[] =>
  store.list<ApprovalRecord>('interactions').filter((row) => row.type === 'APPROVAL');

describe('E9.5 approval answering — REQUIRE_HUMAN park answerable end-to-end', () => {
  it('answers a parked approval through the API and the decision proceeds on APPROVAL', async () => {
    const h = humanLoopHarness();
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events, {
        // The Work Order narrows repo.write to REQUIRE_HUMAN, so the assignment
        // gate parks an approval instead of assigning.
        constraints: ['policy:repo.write=require_human'],
      });

      h.scheduler.tick();
      await h.poll();

      const parked = approvalsIn(h.store);
      expect(parked).toHaveLength(1);
      expect(parked[0]!.status).toBe('PENDING');
      expect(parked[0]!.workOrderId).toBe(wo.id);
      expect(parked[0]!.binding.capability).toBe('repo.write');
      expect(h.store.get<Task>('tasks', task.id)!.state).not.toBe('RUNNING');

      // The approval is discoverable and answerable over the API contract.
      const listed = await h.client.listApprovals('PENDING');
      expect(listed.map((row) => row.id)).toContain(parked[0]!.id);

      const answered = await h.client.answerApproval(parked[0]!.id, {
        decision: 'APPROVAL',
        actor: 'operator-1',
        comment: 'proceed',
      });
      expect(answered.status).toBe('ANSWERED');
      expect(answered.response?.actor).toBe('operator-1');
      expect(answered.response?.decision).toBe('APPROVAL');

      // The receipt is durable: an approval.answered event carries actor+decision.
      const receipt = h.events
        .readEvents({ aggregateType: 'interaction', aggregateId: parked[0]!.id })
        .find((event) => event.type === 'interaction.approval_answered');
      expect(receipt).toBeDefined();
      expect((receipt!.payload as { approval: ApprovalRecord }).approval.response?.actor).toBe(
        'operator-1',
      );

      // The consuming decision proceeds: the next gate check consumes the
      // approval and the assignment goes through (ALLOW), spending it once.
      h.scheduler.tick();
      await h.poll();

      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('RUNNING');
      const spent = h.store.get<ApprovalRecord>('interactions', parked[0]!.id)!;
      expect(spent.status).toBe('SPENT');
      expect(spent.spentByDecisionId).toBeString();
      expect(approvalsIn(h.store)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('keeps the gate standing on DENY and refuses to re-answer a spent approval', async () => {
    const h = humanLoopHarness();
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events, {
        constraints: ['policy:repo.write=require_human'],
      });
      h.scheduler.tick();
      await h.poll();

      const parked = approvalsIn(h.store)[0]!;
      const denied = await h.client.answerApproval(parked.id, {
        decision: 'DENY',
        actor: 'operator-2',
      });
      expect(denied.status).toBe('ANSWERED');
      expect(denied.response?.decision).toBe('DENY');

      // A DENY is never consumed: the gate stands and the Task stays unassigned.
      h.scheduler.tick();
      await h.poll();
      expect(h.store.get<Task>('tasks', task.id)!.state).not.toBe('RUNNING');
      expect(h.store.get<ApprovalRecord>('interactions', parked.id)!.status).toBe('ANSWERED');
      // No duplicate approval is parked while the answered one stands.
      expect(approvalsIn(h.store)).toHaveLength(1);
      expect(wo.id).toBe(parked.workOrderId);
    } finally {
      h.close();
    }
  });

  it('rejects an unknown approval (404), a missing actor (400) and a spent approval (409)', async () => {
    const h = humanLoopHarness();
    try {
      await expect(
        h.client.answerApproval('appr_missing', { decision: 'APPROVAL', actor: 'operator-1' }),
      ).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND', status: 404 });

      const { task } = seedExecutingWorkOrder(h.store, h.events, {
        constraints: ['policy:repo.write=require_human'],
      });
      h.scheduler.tick();
      await h.poll();
      const parked = approvalsIn(h.store)[0]!;

      await expect(
        h.client.answerApproval(parked.id, { decision: 'APPROVAL', actor: '' }),
      ).rejects.toMatchObject({ code: 'APPROVAL_ACTOR_REQUIRED', status: 400 });

      await h.client.answerApproval(parked.id, { decision: 'APPROVAL', actor: 'operator-1' });
      // The answer is final: a second answer is refused even before the
      // approval is spent by a consuming decision (no last-writer-wins).
      await expect(
        h.client.answerApproval(parked.id, { decision: 'DENY', actor: 'operator-9' }),
      ).rejects.toMatchObject({ code: 'APPROVAL_SPENT', status: 409 });
      const stillAnswered = h.store.get<ApprovalRecord>('interactions', parked.id)!;
      expect(stillAnswered.status).toBe('ANSWERED');
      expect(stillAnswered.response?.decision).toBe('APPROVAL');
      expect(stillAnswered.response?.actor).toBe('operator-1');

      h.scheduler.tick();
      await h.poll();
      expect(h.store.get<ApprovalRecord>('interactions', parked.id)!.status).toBe('SPENT');
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('RUNNING');

      await expect(
        h.client.answerApproval(parked.id, { decision: 'DENY', actor: 'operator-1' }),
      ).rejects.toMatchObject({ code: 'APPROVAL_SPENT', status: 409 });
    } finally {
      h.close();
    }
  });

  it('does not list approval ledgers among interactions (`wo answer` discovery)', async () => {
    const h = humanLoopHarness();
    try {
      seedExecutingWorkOrder(h.store, h.events, {
        constraints: ['policy:repo.write=require_human'],
      });
      h.scheduler.tick();
      await h.poll();
      expect(approvalsIn(h.store)).toHaveLength(1);

      // The parked approval is discoverable through /approvals only; the
      // interaction feed stays question-only so a CLI `wo answer` cannot pick an
      // approval id.
      expect(await h.client.listApprovals()).toHaveLength(1);
      expect(await h.client.listInteractions()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('answers an approval from the CLI (`factory approvals answer`)', async () => {
    const h = humanLoopHarness();
    try {
      seedExecutingWorkOrder(h.store, h.events, {
        constraints: ['policy:repo.write=require_human'],
      });
      h.scheduler.tick();
      await h.poll();
      const parked = approvalsIn(h.store)[0]!;

      const cap = capture(workDir);
      const code = await runCli(
        ['approvals', 'answer', parked.id, '--decision', 'APPROVAL', '--actor', 'operator-7', '--url', h.url],
        cap.io,
      );
      expect(code).toBe(0);
      const out = JSON.parse(cap.out()) as ApprovalRecord;
      expect(out.status).toBe('ANSWERED');
      expect(out.response?.actor).toBe('operator-7');
      expect(h.store.get<ApprovalRecord>('interactions', parked.id)!.status).toBe('ANSWERED');
    } finally {
      h.close();
    }
  });
});

describe('E9.5 worker answer delivery — WAITING_INPUT resumes and converges', () => {
  it('delivers the answer to the runtime, resumes the Task and converges with one interaction', async () => {
    const h = humanLoopHarness(waitingWorkerResult('which base branch?'));
    try {
      const { task } = seedExecutingWorkOrder(h.store, h.events);

      h.scheduler.tick();
      await h.poll();
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('RUNNING');
      const adapter = h.adapters[0]!;

      // The runtime asked a question; the report is routed as WAITING_INPUT.
      h.scheduler.tick();
      await h.poll();
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('WAITING_INPUT');

      const pending = h.store
        .list<{ id: string; type: string; status: string; question: string }>('interactions')
        .filter((row) => row.type === 'QUESTION');
      expect(pending).toHaveLength(1);
      expect(pending[0]!.status).toBe('PENDING');

      // Answer through the API: the response is persisted, the Task resumes, and
      // the answer is delivered into the running runtime.
      const answered = await h.client.answerInteraction(pending[0]!.id, 'use main');
      expect(answered.interaction.status).toBe('ANSWERED');
      expect(answered.task.state).toBe('RUNNING');
      expect(adapter.delivered).toHaveLength(1);
      expect(adapter.delivered[0]!.response).toBe('use main');
      expect(adapter.delivered[0]!.interactionId).toBe(pending[0]!.id);

      // Convergence: the stale waiting report is re-collected across several
      // ticks (fresh object each poll) but is consumed once — no duplicate
      // interaction, no WAITING_INPUT flip-back, no re-ask.
      for (let i = 0; i < 3; i += 1) {
        h.scheduler.tick();
        await h.poll();
      }
      const questions = h.store
        .list<{ type: string }>('interactions')
        .filter((row) => row.type === 'QUESTION');
      expect(questions).toHaveLength(1);
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('RUNNING');
      expect(adapter.delivered).toHaveLength(1);

      // A genuinely new runtime report (the runtime continued after the answer)
      // is routed: the Task settles to SUCCESS.
      adapter.result = completedWorkerResult();
      h.scheduler.tick();
      await h.poll();
      h.scheduler.tick();
      await h.poll();
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('SUCCESS');
      expect(questions).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('does not duplicate interactions across ticks when the runtime repeats the same question', async () => {
    const h = humanLoopHarness(waitingWorkerResult('same question'));
    try {
      const { task } = seedExecutingWorkOrder(h.store, h.events);
      h.scheduler.tick();
      await h.poll();
      // The report is routed on the next tick, then the same waiting report is
      // collected by several more ticks (the adapter returns a fresh copy each
      // poll) — it must be consumed once.
      h.scheduler.tick();
      await h.poll();
      h.scheduler.tick();
      await h.poll();
      h.scheduler.tick();
      await h.poll();

      const questions = h.store
        .list<{ type: string }>('interactions')
        .filter((row) => row.type === 'QUESTION');
      expect(questions).toHaveLength(1);
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('WAITING_INPUT');
    } finally {
      h.close();
    }
  });

  it('records the answering operator identity on a QUESTION (defaulting to human)', async () => {
    const h = humanLoopHarness(waitingWorkerResult('who is this?'));
    try {
      const { task } = seedExecutingWorkOrder(h.store, h.events);
      h.scheduler.tick();
      await h.poll();
      h.scheduler.tick();
      await h.poll();
      const pendingId = h.store
        .list<{ id: string; type: string }>('interactions')
        .find((row) => row.type === 'QUESTION')!.id;

      // An explicit actor is recorded as the durable receipt.
      const answered = await h.client.answerInteraction(pendingId, 'operator-3 here', 'operator-3');
      expect(answered.interaction.answeredBy).toBe('operator-3');
      expect(answered.interaction.response).toBe('operator-3 here');
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('RUNNING');
    } finally {
      h.close();
    }
  });

  it('defaults a QUESTION answer identity to "human" when no actor is given', async () => {
    const h = humanLoopHarness(waitingWorkerResult('anon?'));
    try {
      seedExecutingWorkOrder(h.store, h.events);
      h.scheduler.tick();
      await h.poll();
      h.scheduler.tick();
      await h.poll();
      const pendingId = h.store
        .list<{ id: string; type: string }>('interactions')
        .find((row) => row.type === 'QUESTION')!.id;

      const answered = await h.client.answerInteraction(pendingId, 'no actor given');
      expect(answered.interaction.answeredBy).toBe('human');
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E9.6 (#32) — policy/recovery runtime hooks: e-stop/pause into the tick,
// boot reconciliation, and the dependency circuit breaker.
// ---------------------------------------------------------------------------

describe('E9.6 e-stop/pause freeze the live scheduler', () => {
  it('with e-stop set a live tick assigns and provisions nothing while preserving state; resume resumes', async () => {
    const h = humanLoopHarness();
    try {
      const { task } = seedExecutingWorkOrder(h.store, h.events);
      // Freeze through the real server route (the operator surface).
      const controls = await h.client.emergencyStop('operator-1');
      expect(controls).toEqual({ paused: false, emergencyStopped: true });

      const before = {
        workOrders: JSON.stringify(h.store.list('work_orders')),
        tasks: JSON.stringify(h.store.list('tasks')),
      };

      h.scheduler.tick();
      await h.poll();
      h.scheduler.tick();
      await h.poll();

      // No new external work: no assignment, no Attempt, no provisioned worker.
      expect(h.store.list<{ taskId: string }>('assignments')).toHaveLength(0);
      expect(h.store.list<Attempt>('attempts')).toHaveLength(0);
      expect(h.store.list('workers')).toHaveLength(0);
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('PLANNED');
      // State/evidence preserved (byte-identical durable rows).
      expect(JSON.stringify(h.store.list('work_orders'))).toBe(before.workOrders);
      expect(JSON.stringify(h.store.list('tasks'))).toBe(before.tasks);

      // The controls projection is readable and the live scheduler observes the flag.
      expect(await h.client.factoryControls()).toEqual({ paused: false, emergencyStopped: true });

      // Explicit human resume clears the gate and the same live scheduler proceeds.
      expect(await h.client.resume('operator-1')).toEqual({ paused: false, emergencyStopped: false });
      h.scheduler.tick();
      await h.poll();

      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('RUNNING');
      expect(h.store.list<{ taskId: string }>('assignments')).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('pause also freezes the tick (no assignment) and resume unblocks it', async () => {
    const h = humanLoopHarness();
    try {
      const { task } = seedExecutingWorkOrder(h.store, h.events);
      expect(await h.client.pause('operator-2')).toEqual({ paused: true, emergencyStopped: false });

      h.scheduler.tick();
      await h.poll();
      expect(h.store.list<{ taskId: string }>('assignments')).toHaveLength(0);
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('PLANNED');

      await h.client.resume('operator-2');
      h.scheduler.tick();
      await h.poll();
      expect(h.store.get<Task>('tasks', task.id)!.state).toBe('RUNNING');
    } finally {
      h.close();
    }
  });

  it('drives emergency-stop and resume from the CLI (`factory control`)', async () => {
    const h = humanLoopHarness();
    try {
      seedExecutingWorkOrder(h.store, h.events);

      const stop = capture(workDir);
      expect(
        await runCli(['control', 'emergency-stop', '--actor', 'operator-7', '--url', h.url], stop.io),
      ).toBe(0);
      expect(JSON.parse(stop.out())).toEqual({ paused: false, emergencyStopped: true });

      const status = capture(workDir);
      expect(await runCli(['control', 'status', '--url', h.url], status.io)).toBe(0);
      expect(JSON.parse(status.out())).toEqual({ paused: false, emergencyStopped: true });

      const resume = capture(workDir);
      expect(await runCli(['control', 'resume', '--actor', 'operator-7', '--url', h.url], resume.io)).toBe(0);
      expect(JSON.parse(resume.out())).toEqual({ paused: false, emergencyStopped: false });

      // An actor is required: the operator identity is the durable receipt.
      const anonymous = capture(workDir);
      expect(await runCli(['control', 'pause', '--url', h.url], anonymous.io)).toBe(1);
      expect(anonymous.err()).toMatch(/actor/i);
    } finally {
      h.close();
    }
  });
});

/** Seed a crashed in-flight Attempt (open lease + open assignment) into a store. */
function seedCrashedAttempt(
  store: ReturnType<typeof openStateStore>,
  events: ReturnType<typeof openEventLog>,
  options: { diff: string },
): { wo: WorkOrder; task: Task; attempt: Attempt; workerId: string } {
  const deps = { store, events };
  const wo = createWorkOrder(deps, { intent: 'E9.6 crash subject', acceptanceCriteria: ['accepted'] });
  for (const to of ['READY', 'PLANNING'] as const) transitionWorkOrder(deps, wo.id, { to });
  const dag = commitDAG(deps, wo.id, { nodes: [{ nodeId: 'a', title: 'A' }] });
  transitionWorkOrder(deps, wo.id, { to: 'EXECUTING' });
  transitionWorkOrder(deps, wo.id, { to: 'VERIFYING' });
  const task = store.get<Task>('tasks', dag.nodes[0].taskId)!;
  for (const to of ['READY', 'ASSIGNED', 'RUNNING', 'SUCCESS', 'VERIFYING'] as const) {
    transitionTask(deps, task.id, { to });
  }

  const workerId = `worker_${crypto.randomUUID()}`;
  // The Attempt carries no live worker id (the crash lost the adapter); the
  // lease binding below is what makes it in-flight for reconciliation.
  const attempt = createAttempt(deps, { taskId: task.id, model: 'writer-xl', environment: 'herdr/local' });
  // The diff the crash left behind: the evidence to preserve. A crash leaves the
  // Attempt open (no completion evidence) with its partial diff.
  store.set('attempts', attempt.id, { ...attempt, diff: options.diff });

  store.set('workers', workerId, {
    id: workerId,
    profile: 'herdr',
    runtimeState: 'BUSY',
    lease: {
      attemptId: attempt.id,
      taskId: task.id,
      expiresAt: '2020-01-01T00:00:00.000Z',
      renewedAt: '2020-01-01T00:00:00.000Z',
    },
    provisionedAt: '2020-01-01T00:00:00.000Z',
    lastActiveAt: '2020-01-01T00:00:00.000Z',
    reclaimedAt: null,
  });
  const assignmentId = `assignment_${crypto.randomUUID()}`;
  store.set('assignments', assignmentId, {
    id: assignmentId,
    taskId: task.id,
    workerId,
    branch: `wo-${wo.id}/task-${task.id.slice(0, 8)}`,
    worktreePath: join(workDir, 'crashed-wt'),
    baseCommit: 'base',
    closedAt: null,
    model: 'writer-xl',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  });

  return { wo, task, attempt, workerId };
}

describe('E9.6 boot reconciliation — a crash during VERIFYING reconciles on boot', () => {
  it('interrupts the crashed Attempt, preserves its diff as evidence, and opens one clean-baseline Attempt', () => {
    const runtime = runtimeFrom(configText());
    // Seed a crash into the runtime database, then "restart" by building the
    // server deps on the same db (the boot path `factory start` uses).
    mkdirSync(runtime.paths.state, { recursive: true });
    const seedStore = openStateStore(runtime.paths.db);
    const seedEvents = openEventLog(seedStore.db);
    const seeded = seedCrashedAttempt(seedStore, seedEvents, { diff: 'diff --git a/x b/x\n+crashed work' });
    seedStore.close();

    const adapters: FakeHerdr[] = [];
    const deps = buildServerDeps(runtime, { spawn: makeSpawn(adapters) });
    // A second boot over the same database: reconciliation must be idempotent.
    const second = buildServerDeps(runtime, { spawn: () => new FakeHerdr() });
    try {
      // The crashed Attempt is interrupted — never claimed successful.
      const crashed = deps.store.get<Attempt>('attempts', seeded.attempt.id)!;
      expect(crashed.outcome).toBe('interrupted');
      expect(crashed.outcome).not.toBe('success');
      expect(crashed.failureHistory.some((entry) => entry.failure.startsWith('CRASH_RECOVERY'))).toBe(true);
      // The old diff is preserved as immutable evidence (artifact + Attempt field).
      expect(crashed.diff).toContain('crashed work');
      const artifacts = createArtifactStore(runtime.paths.artifacts);
      expect(Buffer.from(artifacts.get(`${seeded.attempt.id}/diff.patch`)).toString('utf8')).toContain(
        'crashed work',
      );

      // A new Attempt from a clean baseline exists; the crashed one is not reused.
      const attempts = deps.store.list<Attempt>('attempts').filter((a) => a.taskId === seeded.task.id);
      expect(attempts).toHaveLength(2);
      const fresh = attempts.find((a) => a.id !== seeded.attempt.id)!;
      expect(fresh.outcome).toBeNull();
      expect(fresh.environment).toBe('clean-worktree');
      expect(fresh.context).toContain('reverification');

      // Verification is not silently completed: the Work Order stays VERIFYING.
      expect(deps.store.get<WorkOrder>('work_orders', seeded.wo.id)!.state).toBe('VERIFYING');

      // Idempotent: the second boot does not manufacture a third Attempt or a
      // duplicate recovery action.
      expect(second.store.list<Attempt>('attempts').filter((a) => a.taskId === seeded.task.id)).toHaveLength(2);
      const actions = second.events
        .readEvents({ aggregateType: 'work_order', aggregateId: seeded.wo.id })
        .filter((event) => event.type === RECOVERY_ACTION_APPLIED);
      expect(actions).toHaveLength(1);
    } finally {
      deps.store.close();
      second.store.close();
    }
  });
});

describe('E9.6 dependency circuit breaker (spec §18.9)', () => {
  const failure = (overrides: Partial<FailureContext> = {}): FailureContext => ({
    attemptId: `attempt_${crypto.randomUUID()}`,
    taskId: `task_${crypto.randomUUID()}`,
    workOrderId: `wo_${crypto.randomUUID()}`,
    failureClass: 'DEPENDENCY_UNAVAILABLE',
    error: 'dependency registry unreachable',
    attemptCount: 0,
    sameClassCount: 0,
    changedCondition: 'backoff',
    ...overrides,
  });

  function circuitHarness(budgets: Partial<RecoveryBudgets> = {}) {
    const store = openStateStore(join(workDir, `circuit-${crypto.randomUUID()}.db`));
    const events = openEventLog(store.db);
    let t = Date.parse('2026-09-30T00:00:00.000Z');
    const clock = {
      now: () => new Date(t).toISOString(),
      advance: (ms: number) => {
        t += ms;
      },
    };
    const circuit = { failureThreshold: 2, resetTimeoutMs: 30_000 };
    return {
      store,
      events,
      clock,
      circuit,
      deps: {
        store,
        events,
        now: clock.now,
        budgets: { perClassRetries: 2, backoffBaseMs: 1, backoffMaxMs: 1, ...budgets },
        circuit,
      } as RecoveryDeps,
      close: () => store.close(),
    };
  }

  it('opens on persistent failures, sheds load before the generic budget, and probes on half-open', () => {
    const h = circuitHarness();
    try {
      // Closed: a first dependency failure is retried within the bounded wheel.
      expect(recover(h.deps, failure({ failureIndex: 1 }))).toMatchObject({ kind: 'RETRY_NEW_ATTEMPT' });
      expect(circuitSnapshot(h.deps, 'dependency').state).toBe('CLOSED');
      expect(circuitSnapshot(h.deps, 'dependency').consecutiveFailures).toBe(1);

      // The second consecutive failure reaches the threshold: the circuit opens
      // and that same failure is shed rather than retried.
      const opened = recover(h.deps, failure({ failureIndex: 2, sameClassCount: 0 }));
      expect(opened).toMatchObject({ kind: 'WAITING_RESOURCE', resource: 'dependency', retryAfterMs: 30_000 });
      const open = circuitSnapshot(h.deps, 'dependency');
      expect(open.state).toBe('OPEN');
      expect(open.consecutiveFailures).toBe(2);
      expect(open.openedAt).toBe(h.clock.now());

      // The circuit — not the per-class budget — now owns the retry. The generic
      // budget would still allow a retry (sameClassCount 0 < perClassRetries 2),
      // yet the load is shed.
      const shed = recover(h.deps, failure({ failureIndex: 3, sameClassCount: 0 }));
      expect(shed.kind).toBe('WAITING_RESOURCE');
      // Shedding is not an automatic remedy: only the one pre-open retry consumed
      // any recovery autonomy.
      const automatic = h.events
        .readEvents()
        .filter((event) => event.type === RECOVERY_ACTION_APPLIED)
        .filter((event) => (event.payload as { kind?: string }).kind === 'RETRY_NEW_ATTEMPT');
      expect(automatic).toHaveLength(1);

      // After the reset window the next recovery admits the single HALF_OPEN
      // probe. E9.8: because `recover()` delivers a *failure*, that delivery is a
      // failed probe — it is settled (the circuit re-opens with a fresh window)
      // and shed, rather than retried blindly. No probe is left dangling.
      h.clock.advance(30_000);
      const probe = recover(h.deps, failure({ failureIndex: 4, sameClassCount: 0 }));
      expect(probe).toMatchObject({ kind: 'WAITING_RESOURCE', resource: 'dependency' });
      const afterProbe = circuitSnapshot(h.deps, 'dependency');
      expect(afterProbe.state).toBe('OPEN');
      expect(afterProbe.probeInFlight).toBe(false);
      expect(afterProbe.openedAt).toBe(h.clock.now());

      // The re-opened window sheds further deliveries until it elapses again.
      const reopenedAction = recover(h.deps, failure({ failureIndex: 5, sameClassCount: 0 }));
      expect(reopenedAction).toMatchObject({ kind: 'WAITING_RESOURCE' });
      expect(circuitSnapshot(h.deps, 'dependency').state).toBe('OPEN');

      // A dependency success closes the circuit and resets the failure count.
      recordDependencySuccess(h.deps, 'dependency');
      expect(circuitSnapshot(h.deps, 'dependency')).toMatchObject({
        state: 'CLOSED',
        consecutiveFailures: 0,
      });
    } finally {
      h.close();
    }
  });

  it('the gate sheds while OPEN, half-opens after the reset window, and admits a probe', () => {
    const h = circuitHarness();
    try {
      // Trip a separate dependency directly, two failures at the threshold.
      recordDependencyFailure(h.deps, 'dep-gate', h.circuit);
      recordDependencyFailure(h.deps, 'dep-gate', h.circuit);
      const openSnapshot = circuitSnapshot(h.deps, 'dep-gate');
      expect(openSnapshot.state).toBe('OPEN');

      // Before the window: shed with the remaining backoff.
      h.clock.advance(29_999);
      expect(beforeDependencyRequest(h.deps, 'dep-gate')).toMatchObject({
        allowed: false,
        state: 'OPEN',
        retryAfterMs: 1,
      });

      // At the window: half-open and exactly one probe is admitted.
      h.clock.advance(1);
      expect(beforeDependencyRequest(h.deps, 'dep-gate')).toEqual({ allowed: true, state: 'HALF_OPEN' });
      const halfOpen = circuitSnapshot(h.deps, 'dep-gate');
      expect(halfOpen.state).toBe('HALF_OPEN');
      expect(halfOpen.probeInFlight).toBe(true);

      // While that probe is in flight, further dependent calls are shed — the
      // half-open window admits a single probe, not unbounded traffic.
      expect(beforeDependencyRequest(h.deps, 'dep-gate')).toMatchObject({
        allowed: false,
        state: 'HALF_OPEN',
      });

      // The probe fails: the circuit re-opens with a fresh window.
      const reopened = recordDependencyFailure(h.deps, 'dep-gate', h.circuit);
      expect(reopened.state).toBe('OPEN');
      expect(reopened.probeInFlight).toBe(false);

      // A success (after the next window) closes it and clears the probe flag.
      h.clock.advance(30_000);
      expect(beforeDependencyRequest(h.deps, 'dep-gate')).toEqual({ allowed: true, state: 'HALF_OPEN' });
      recordDependencySuccess(h.deps, 'dep-gate');
      expect(beforeDependencyRequest(h.deps, 'dep-gate')).toEqual({ allowed: true, state: 'CLOSED' });
      expect(circuitSnapshot(h.deps, 'dep-gate').probeInFlight).toBe(false);
    } finally {
      h.close();
    }
  });

  it('e-stop/pause hold before the circuit (no recovery while frozen)', () => {
    const h = circuitHarness();
    try {
      emergencyStop({ store: h.store, events: h.events }, { actor: 'operator-1' });
      expect(recover(h.deps, failure({ failureIndex: 1 }))).toEqual({ kind: 'HOLD' });
      // A held failure is not counted against the circuit.
      expect(circuitSnapshot(h.deps, 'dependency').consecutiveFailures).toBe(0);
      expect(circuitSnapshot(h.deps, 'dependency').state).toBe('CLOSED');
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E9.7 (#33) — telemetry wiring on the live path + Observatory through the API
// ---------------------------------------------------------------------------

describe('E9.7 telemetry recorded on the live path', () => {
  it('records all six layers for a completed Attempt when the scheduler routes its completion', async () => {
    const h = humanLoopHarness(completedWorkerResult());
    try {
      const { wo, task } = seedExecutingWorkOrder(h.store, h.events);

      // Drive the fake runtime's completion through the real scheduler path.
      h.scheduler.tick();
      await h.poll();
      h.scheduler.tick();
      await h.poll();

      const attempts = h.store.list<Attempt>('attempts').filter((a) => a.taskId === task.id);
      expect(attempts).toHaveLength(1);
      const attemptId = attempts[0]!.id;
      expect(attempts[0]!.outcome).toBe('success');

      // The live path recorded exactly one per-Attempt telemetry receipt.
      const receipts = h.events
        .readEvents({ aggregateType: 'attempt', aggregateId: attemptId })
        .filter((event) => event.type === TELEMETRY_ATTEMPT_RECORDED);
      expect(receipts).toHaveLength(1);

      const record = readAttemptTelemetry(h.events, attemptId)!;
      expect(record).not.toBeNull();
      expect(Object.keys(record.layers).sort()).toEqual([...TELEMETRY_LAYERS].sort());

      // Real sources, not fabricated data: the outcome/decision layers resolve
      // from the durable Attempt + Task + Work Order (E9.3 routing decision).
      expect(record.taskId).toBe(task.id);
      expect(record.workOrderId).toBe(wo.id);
      expect(record.layers.outcome.outcome).toBe('success');
      expect(record.layers.outcome.taskState).toBe('SUCCESS');
      // No verification has run yet (E9.4 is off this tick): honest not-verified.
      expect(record.layers.outcome.verified).toBe(false);
      expect(record.layers.quality.reworkCount).toBe(0);
      expect(record.layers.decision.model.length).toBeGreaterThan(0);

      // Cost is a runtime observable E1 does not persist: honest `null`, never 0.
      expect(record.layers.economics.totalCost).toBeNull();

      // A later tick must not record a second receipt (idempotent, no double count).
      h.scheduler.tick();
      await h.poll();
      expect(
        h.events
          .readEvents({ aggregateType: 'attempt', aggregateId: attemptId })
          .filter((event) => event.type === TELEMETRY_ATTEMPT_RECORDED),
      ).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('records a failed Attempt on the live path with honest unknowns, never fabricated data', async () => {
    const h = humanLoopHarness(failedWorkerResult('worker blew up'));
    try {
      const { task } = seedExecutingWorkOrder(h.store, h.events);
      h.scheduler.tick();
      await h.poll();
      h.scheduler.tick();
      await h.poll();

      const attempt = h.store.list<Attempt>('attempts').find((a) => a.taskId === task.id)!;
      expect(attempt.outcome).toBe('failed');

      const record = readAttemptTelemetry(h.events, attempt.id);
      expect(record).not.toBeNull();
      expect(record!.layers.outcome.outcome).toBe('failed');
      expect(record!.layers.outcome.verified).toBe(false);
      expect(record!.layers.quality.firstPass).toBe(true); // first Attempt, no rework yet
      expect(record!.layers.quality.failures).toContain('worker blew up');
      expect(record!.layers.decision.replan).toEqual([
        { at: expect.any(String), failure: 'worker blew up', recovery: null },
      ]);
      // Unknown runtime cost is `null`, not a fabricated 0.
      expect(record!.layers.economics.totalCost).toBeNull();
    } finally {
      h.close();
    }
  });

  it('exposes E8 Observatory metrics and the 7-stage drill-down through the real API', async () => {
    const runtime = runtimeFrom(configText());
    const deps = buildServerDeps(runtime, { spawn: () => new FakeHerdr() });
    const server = startFactoryServer(deps);
    const client = createFactoryClient({ baseUrl: server.url });
    try {
      const { wo, task } = seedExecutingWorkOrder(deps.store, deps.events);
      driveTaskToSuccess(deps.store, deps.events, task.id, 'writer-xl');
      const attempt = deps.store.list<Attempt>('attempts').find((a) => a.taskId === task.id)!;

      // Record telemetry through the real E8 module (the live path's writer).
      recordAttemptTelemetry(
        { store: deps.store, events: deps.events, evidence: createEvidenceReadPort(deps.store) },
        attempt.id,
      );

      // Persist a real Evidence Bundle (E9.4's durable output) via E5's verifier.
      const engine = createVerificationEngine();
      engine.registerCheck({
        id: 'typecheck',
        category: 'deterministic',
        kind: 'typecheck',
        run: () => ({ passed: true, evidence: { summary: 'typecheck ok' } }),
      });
      engine.registerCheck({
        id: 'playwright',
        category: 'behavioral',
        kind: 'playwright',
        run: () => ({ passed: true, evidence: { summary: 'playwright ok' } }),
      });
      const verifier = createE5Verifier({
        store: deps.store,
        engine,
        judge: {
          identity: { provider: 'judge-co', model: 'judge-1', family: 'judge-family' },
          falsify: (context) =>
            context.criteria.map((criterion) => ({
              criterion,
              falsified: false,
              evidence: { summary: 'judge reviewed' },
              diagnosis: 'judge falsified',
              action: 'address',
            })),
        },
        prompt: { id: 'e9.7-verify', version: '1' },
        rubric: ['satisfies the criterion'],
        provider: 'factory',
        now: () => '2026-09-30T12:00:00.000Z',
      });
      const outcome = await verifier.verify({
        workOrder: deps.store.get<WorkOrder>('work_orders', wo.id)!,
        task: deps.store.get<Task>('tasks', task.id)!,
        attempt,
      });
      expect(outcome.bundle).not.toBeNull();
      const bundle = outcome.bundle!;
      deps.store.set('evidence_bundles', bundle.id, bundle);

      // The Observatory route reports real verified/day + throughput from the
      // persisted bundle (E5's durable verified-change view).
      const observatory = await client.observatory();
      expect(observatory.verifiedPerDay.length).toBeGreaterThan(0);
      expect(observatory.verifiedPerDay[0]!.verifiedChanges).toBeGreaterThanOrEqual(1);
      expect(observatory.throughputPerHumanHour.verifiedChanges).toBeGreaterThanOrEqual(1);
      expect(observatory.rework).toBe(0);
      expect(observatory.cost).toEqual({ total: 0, currency: 'USD' });

      // The drill-down resolves the full 7-stage §23 chain.
      const drill = await client.drillDown(wo.id);
      expect(drill.chain.map((step) => step.stage)).toEqual([
        'work_order',
        'task',
        'attempt',
        'trace',
        'verification',
        'evidence',
        'human_decision',
      ]);
      const byStage = new Map(drill.chain.map((step) => [step.stage, step]));
      expect(byStage.get('work_order')?.refs).toEqual([wo.id]);
      expect(byStage.get('task')?.refs).toEqual([task.id]);
      expect(byStage.get('attempt')?.refs).toEqual([attempt.id]);
      // Trace resolves from the recorded telemetry receipt, evidence from E5.
      expect(byStage.get('trace')?.status).toBe('available');
      expect(byStage.get('trace')?.refs).toEqual([attempt.id]);
      expect(byStage.get('verification')?.status).toBe('available');
      expect(byStage.get('evidence')?.status).toBe('available');
      expect(byStage.get('evidence')?.refs).toEqual([bundle.id]);
      // No human interaction yet: honest stub, never fabricated.
      expect(byStage.get('human_decision')?.status).toBe('stub');
      expect(byStage.get('human_decision')?.refs).toEqual([]);

      // An unknown Work Order is a 404, not fabricated data.
      await expect(client.drillDown('wo_missing')).rejects.toMatchObject({
        code: 'WORK_ORDER_NOT_FOUND',
        status: 404,
      });
    } finally {
      server.stop();
      deps.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E9.8 (#34) — E6 composition + provenance: durable receipt, head-SHA pin,
// branch-naming reconciliation, and the carried circuit/path-gate items.
// ---------------------------------------------------------------------------

/**
 * The mocked GitHub transport for the E9.8 path (Ruling R6): records every call
 * and hits no network. `headSha` is mutable so a test can simulate the branch
 * moving between the gate's read-back and the merge PUT (a TOCTOU attempt).
 */
class E9GitHubTransport implements GitHubTransport {
  issues = new Map<string, GitHubIssue>();
  branchCalls: CreateBranchInput[] = [];
  prCalls: CreatePullRequestInput[] = [];
  prDetails = new Map<number, GitHubPullRequestDetail>();
  /**
   * The branch's live head, independent of the last read-back. A test moves this
   * between the gate's `getPullRequest` and the merge PUT to simulate TOCTOU;
   * the merge rejects when the pinned SHA no longer matches.
   */
  currentHeadSha = new Map<number, string>();
  mergeCalls: MergePullRequestInput[] = [];
  private prNumber = 500;

  issueKey = (ref: IssueRef): string => `${ref.repository}#${ref.number}`;

  async getIssue(ref: IssueRef): Promise<GitHubIssue> {
    const issue = this.issues.get(this.issueKey(ref));
    if (!issue) throw new Error(`no such issue: ${this.issueKey(ref)}`);
    return issue;
  }

  async createBranch(input: CreateBranchInput): Promise<{ repository: string; name: string; sha: string }> {
    this.branchCalls.push({ ...input });
    return { repository: input.repository, name: input.branch, sha: 'sha_base' };
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    this.prCalls.push({ ...input });
    this.prNumber += 1;
    const pr: GitHubPullRequest = {
      repository: input.repository,
      number: this.prNumber,
      url: `https://github.com/${input.repository}/pull/${this.prNumber}`,
      head: input.head,
      base: input.base,
    };
    this.prDetails.set(pr.number, {
      ...pr,
      headSha: 'sha_head_1',
      body: input.body,
      state: 'open',
      merged: false,
    });
    this.currentHeadSha.set(pr.number, 'sha_head_1');
    return pr;
  }

  async getPullRequest(ref: PullRequestRef): Promise<GitHubPullRequestDetail> {
    const pr = this.prDetails.get(ref.number);
    if (!pr || pr.repository !== ref.repository) {
      throw new Error(`no such pull request: ${ref.repository}#${ref.number}`);
    }
    return { ...pr };
  }

  async mergePullRequest(input: MergePullRequestInput) {
    this.mergeCalls.push({ ...input });
    const pr = this.prDetails.get(input.number);
    const current = this.currentHeadSha.get(input.number) ?? pr?.headSha;
    // GitHub's `sha` parameter: reject the merge if the head moved since the
    // caller pinned it (the TOCTOU the head-SHA pin exists to close).
    if (input.sha !== undefined && input.sha !== current) {
      throw new Error(`head sha mismatch: expected ${current}, got ${input.sha}`);
    }
    if (pr) {
      this.prDetails.set(input.number, { ...pr, merged: true, state: 'closed' });
    }
    return {
      repository: input.repository,
      number: input.number,
      merged: true,
      sha: 'merge_sha',
      message: 'Pull request merged',
    };
  }
}

/** Build a genuine, complete E5 Evidence Bundle for `workOrder` on the live path. */
async function e9Bundle(workOrder: WorkOrder): Promise<EvidenceBundle> {
  const criteria = workOrder.acceptanceCriteria;
  const engine = createVerificationEngine();
  engine.registerCheck({
    id: 'unit',
    category: 'deterministic',
    kind: 'unit',
    run: () => ({ passed: true, evidence: { summary: 'unit: ok' } }),
  });
  engine.registerCheck({
    id: 'contract',
    category: 'behavioral',
    kind: 'contract',
    run: () => ({ passed: true, evidence: { summary: 'contract: ok' } }),
  });
  const changeSet = {
    id: 'cs_e9',
    attemptId: 'attempt_e9',
    taskId: 'task_e9',
    diff: 'diff --git a/counter b/counter',
    artifactIds: [],
  };
  const run = await engine.verify(changeSet, {
    criteria,
    criterionChecks: {
      [criteria[0]!]: ['unit'],
      ...(criteria[1] ? { [criteria[1]]: ['contract'] } : {}),
    },
  });
  const semantic = await createSemanticVerifier({
    judge: {
      identity: { provider: 'judge-co', model: 'judge-model' },
      falsify: (context) =>
        context.criteria.map((criterion) => ({
          criterion,
          falsified: false,
          evidence: { summary: `${criterion}: survived` },
        })),
    },
    generator: { provider: 'writer', model: 'writer-model' },
    prompt: { id: 'verify', version: '1' },
    rubric: ['seek counterexamples'],
  }).verify({
    workOrder,
    changeSet,
    deterministic: run.deterministic,
    behavioral: run.behavioral,
    criteria,
  });
  return buildEvidenceBundle({ workOrder, changeSet, run, semantic, attempts: [] });
}

interface E9Harness {
  store: ReturnType<typeof openStateStore>;
  events: ReturnType<typeof openEventLog>;
  transport: E9GitHubTransport;
  client: ReturnType<typeof createFactoryClient>;
  adapter: ReturnType<typeof createGitHubAdapter>;
  stop(): void;
}

/**
 * The real composition seam E9.8 wires: the adapter is built by the production
 * {@link buildGitHubAdapter} (the E6 composition root), which composes the real
 * E7 `checkDetailed` policy and the **store-backed durable Evidence Bundle
 * read-back**, over a loopback server (sole mutation authority).
 */
function e9Harness(): E9Harness {
  const store = openStateStore(join(workDir, `e9-github-${crypto.randomUUID()}.db`));
  const events = openEventLog(store.db);
  const server = startFactoryServer(
    { store, events, evidence: createEmptyEvidenceReadPort() },
    { port: 0, hostname: '127.0.0.1' },
  );
  const client = createFactoryClient({ baseUrl: server.url });
  const transport = new E9GitHubTransport();
  const h: E9Harness = {
    store,
    events,
    transport,
    client,
    adapter: null as unknown as ReturnType<typeof createGitHubAdapter>,
    stop(): void {
      server.stop();
      store.close();
    },
  };
  h.adapter = buildGitHubAdapter({
    transport,
    client,
    factoryBaseUrl: 'http://factory.local:8787',
    store,
    events,
  });
  return h;
}

const E9_ISSUE: GitHubIssue = {
  repository: 'acme/widgets',
  number: 42,
  title: 'Add the widget counter',
  body: ['Acceptance criteria:', '- [ ] counter increments', '- [x] counter persists'].join('\n'),
  labels: ['enhancement'],
  url: 'https://github.com/acme/widgets/issues/42',
};

const E9_ON_THE_WAY_TO_GATE = [
  'READY',
  'PLANNING',
  'EXECUTING',
  'VERIFYING',
  'EVIDENCE_READY',
  'HUMAN_GATE',
] as const;

/** Import → … → HUMAN_GATE → APPROVED, with a genuine real bundle. */
async function e9Approved(h: E9Harness): Promise<{ workOrder: WorkOrder; bundle: EvidenceBundle }> {
  h.transport.issues.set(h.transport.issueKey(E9_ISSUE), E9_ISSUE);
  const { workOrder: imported } = await h.adapter.importIssue({
    repository: E9_ISSUE.repository,
    number: E9_ISSUE.number,
  });
  let workOrder = imported;
  for (const to of E9_ON_THE_WAY_TO_GATE) {
    workOrder = await h.client.transitionWorkOrder(workOrder.id, { to });
  }
  workOrder = await h.client.applyGate(workOrder.id, 'APPROVE');
  const bundle = await e9Bundle(workOrder);
  return { workOrder, bundle };
}

describe('E9.8 merge receipt — durable bundle read-back by id (source of truth)', () => {
  it('refuses a fabricated in-memory bundle that has no durable receipt', async () => {
    const h = e9Harness();
    try {
      const { workOrder, bundle } = await e9Approved(h);
      const pr = await h.adapter.openPR(bundle);

      // The fabricated bundle is structurally valid but was never persisted.
      await expect(
        h.adapter.merge({
          workOrderId: workOrder.id,
          pullRequest: { repository: pr.repository, number: pr.number },
          evidence: bundle,
          actor: 'operator-1',
        }),
      ).rejects.toMatchObject({ name: 'MergeBlockedError', reason: 'EVIDENCE_NOT_PERSISTED' });
      expect(h.transport.mergeCalls).toHaveLength(0);
      expect(h.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(h.store.get<WorkOrder>('work_orders', workOrder.id)!.state).toBe('APPROVED');
    } finally {
      h.stop();
    }
  });

  it('refuses a claim that upgrades an incomplete durable receipt (durable value governs)', async () => {
    const h = e9Harness();
    try {
      const { workOrder, bundle } = await e9Approved(h);
      // Persist an INCOMPLETE receipt under this id; the caller claims complete.
      h.store.set('evidence_bundles', bundle.id, { ...bundle, complete: false });
      const pr = await h.adapter.openPR(bundle);

      await expect(
        h.adapter.merge({
          workOrderId: workOrder.id,
          pullRequest: { repository: pr.repository, number: pr.number },
          evidence: { ...bundle, complete: true },
          actor: 'operator-1',
        }),
      ).rejects.toMatchObject({ name: 'MergeBlockedError', reason: 'EVIDENCE_INCOMPLETE' });
      expect(h.transport.mergeCalls).toHaveLength(0);
      expect(h.store.get<WorkOrder>('work_orders', workOrder.id)!.state).toBe('APPROVED');
    } finally {
      h.stop();
    }
  });

  it('merges only when the durable receipt is APPROVED + complete + policy ALLOW', async () => {
    const h = e9Harness();
    try {
      const { workOrder, bundle } = await e9Approved(h);
      h.store.set('evidence_bundles', bundle.id, bundle);
      const pr = await h.adapter.openPR(bundle);
      // Park + answer the production merge approval (the only §13.2 path to ALLOW).
      checkDetailed(
        { store: h.store, events: h.events },
        { taskId: null, workOrderId: workOrder.id },
        { capability: 'deploy.execute', resource: { env: 'production' } },
      );
      const parked = h.store
        .list<{ id: string; type: string }>('interactions')
        .find((row) => row.type === 'APPROVAL')!;
      answerApproval(
        { store: h.store, events: h.events },
        parked.id,
        { decision: 'APPROVAL', actor: 'operator-1' },
      );

      const outcome = await h.adapter.merge({
        workOrderId: workOrder.id,
        pullRequest: { repository: pr.repository, number: pr.number },
        evidence: bundle,
        actor: 'operator-1',
      });

      expect(outcome.merge.merged).toBe(true);
      expect(h.store.get<WorkOrder>('work_orders', workOrder.id)!.state).toBe('MERGED');
    } finally {
      h.stop();
    }
  });
});

describe('E9.8 head-SHA pin — verified code is the merged code (no TOCTOU)', () => {
  it('sends the verified PR head SHA on the merge PUT', async () => {
    const h = e9Harness();
    try {
      const { workOrder, bundle } = await e9Approved(h);
      h.store.set('evidence_bundles', bundle.id, bundle);
      const pr = await h.adapter.openPR(bundle);
      checkDetailed(
        { store: h.store, events: h.events },
        { taskId: null, workOrderId: workOrder.id },
        { capability: 'deploy.execute', resource: { env: 'production' } },
      );
      const parked = h.store
        .list<{ id: string; type: string }>('interactions')
        .find((row) => row.type === 'APPROVAL')!;
      answerApproval(
        { store: h.store, events: h.events },
        parked.id,
        { decision: 'APPROVAL', actor: 'operator-1' },
      );

      await h.adapter.merge({
        workOrderId: workOrder.id,
        pullRequest: { repository: pr.repository, number: pr.number },
        evidence: bundle,
        actor: 'operator-1',
      });

      // The pinned SHA is the head the gate read back — never an unpinned merge.
      expect(h.transport.mergeCalls).toEqual([
        { repository: 'acme/widgets', number: pr.number, sha: 'sha_head_1' },
      ]);
    } finally {
      h.stop();
    }
  });

  it('refuses to merge when the head moved after the read-back (TOCTOU blocked)', async () => {
    const h = e9Harness();
    try {
      const { workOrder, bundle } = await e9Approved(h);
      h.store.set('evidence_bundles', bundle.id, bundle);
      const pr = await h.adapter.openPR(bundle);
      checkDetailed(
        { store: h.store, events: h.events },
        { taskId: null, workOrderId: workOrder.id },
        { capability: 'deploy.execute', resource: { env: 'production' } },
      );
      const parked = h.store
        .list<{ id: string; type: string }>('interactions')
        .find((row) => row.type === 'APPROVAL')!;
      answerApproval(
        { store: h.store, events: h.events },
        parked.id,
        { decision: 'APPROVAL', actor: 'operator-1' },
      );

      // The head branch moves between the gate's read-back and the merge PUT:
      // the read-back still reports sha_head_1, but the branch now points at
      // sha_head_2, so a pinned merge must be refused by GitHub.
      h.transport.currentHeadSha.set(pr.number, 'sha_head_2');

      await expect(
        h.adapter.merge({
          workOrderId: workOrder.id,
          pullRequest: { repository: pr.repository, number: pr.number },
          evidence: bundle,
          actor: 'operator-1',
        }),
      ).rejects.toThrow(/head sha mismatch/);
      // The pin was actually sent, and the merge did not land.
      expect(h.transport.mergeCalls[0]!.sha).toBe('sha_head_1');
      expect(h.store.get<WorkOrder>('work_orders', workOrder.id)!.state).toBe('APPROVED');
    } finally {
      h.stop();
    }
  });
});

describe('E9.8 branch naming reconciled with E3 worktrees + the policy scope', () => {
  it('names the E6 change-set branch in the E3 `wo-<woId>/task-<short>` namespace', async () => {
    const h = e9Harness();
    try {
      h.transport.issues.set(h.transport.issueKey(E9_ISSUE), E9_ISSUE);
      const { workOrder } = await h.adapter.importIssue({
        repository: E9_ISSUE.repository,
        number: E9_ISSUE.number,
      });

      const branch = await h.adapter.createBranch(workOrder);

      // The branch is authorizable by the embedded `branch.create` scope
      // (`wo-*/**`) without a bespoke deployment grant.
      expect(branch.name).toBe(`wo-${workOrder.id}/task-${workOrder.id.slice(0, 8)}`);
      expect(branch.name.startsWith('wo-')).toBe(true);
      expect(branch.name).toMatch(/^wo-[^/]+\/task-.+/);
      const decision = h.store
        .list<{ action: { capability: string }; decision: string }>('policy_decisions')
        .find((row) => row.action.capability === 'branch.create');
      expect(decision?.decision).toBe('ALLOW');
    } finally {
      h.stop();
    }
  });
});

describe('E9.8 path-level repo.write gating (the infra/** exclusion) at write time', () => {
  it('refuses a change set that writes infra/** even on a wo-* branch', () => {
    const store = openStateStore(join(workDir, `e9-write-${crypto.randomUUID()}.db`));
    const events = openEventLog(store.db);
    try {
      const { wo, task } = seedExecutingWorkOrder(store, events);
      const branch = expectedBranch(wo.id, task.id);
      const ref = { taskId: task.id, workOrderId: wo.id };

      // A source write on the Factory branch is allowed...
      expect(
        check({ store, events }, ref, {
          capability: 'repo.write',
          resource: { branch, path: 'src/counter.ts' },
        }),
      ).toBe('ALLOW');
      // ...but an infra write is outside the grant (the embedded exclusion).
      expect(
        check({ store, events }, ref, {
          capability: 'repo.write',
          resource: { branch, path: 'infra/main.tf' },
        }),
      ).toBe('DENY');
      // A write with no path binding is not provably outside the excluded set.
      expect(
        check({ store, events }, ref, {
          capability: 'repo.write',
          resource: { branch },
        }),
      ).toBe('DENY');
    } finally {
      store.close();
    }
  });

  it('extracts changed paths from a git diff (the write-time input)', () => {
    const diff = [
      'diff --git a/src/counter.ts b/src/counter.ts',
      'index 111..222 100644',
      '--- a/src/counter.ts',
      '+++ b/src/counter.ts',
      '@@ -1 +1 @@',
      '-const x = 1;',
      '+const x = 2;',
      'diff --git a/infra/main.tf b/infra/main.tf',
      'index 333..444 100644',
      '--- a/infra/main.tf',
      '+++ b/infra/main.tf',
      '+resource "x" "y" {}',
    ].join('\n');
    expect(changedPathsFromDiff(diff).sort()).toEqual(['infra/main.tf', 'src/counter.ts']);
  });

  it('rejects a SUCCESS change set that writes infra/** at verification time (never verified)', async () => {
    const store = openStateStore(join(workDir, `e9-writepath-${crypto.randomUUID()}.db`));
    const events = openEventLog(store.db);
    try {
      const workers = createWorkerManager({ store, events, spawn: () => new FakeHerdr() });
      const worktrees = createWorktreeManager({ rootDir: join(workDir, 'wt'), baseBranch: 'main' });
      const scheduler = createScheduler({
        store,
        events,
        workers,
        worktrees,
        repoPath,
        policy: {
          canAssign: () => 'ALLOW',
          // The live write-time gate: per-path `repo.write` over the change set.
          canWriteChangeSet: (task, workOrder, branch, paths) =>
            repoWriteGate({ store, events }, { taskId: task.id, workOrderId: workOrder.id }, branch, paths),
        },
        verifier: {
          verify: async () => {
            throw new Error('verifier must not be reached for a denied change set');
          },
        },
      });
      const { wo, task } = seedExecutingWorkOrder(store, events);
      driveTaskToSuccess(store, events, task.id, 'writer-xl', 'diff --git a/infra/main.tf b/infra/main.tf\n+bad');

      // The write gate settles as a completion on tick 1, routed at the start of
      // tick 2 (mirroring the async verifier path).
      scheduler.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      scheduler.tick();

      // The write-time gate refused the out-of-scope path: no bundle, REWORK.
      expect(store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(store.get<Task>('tasks', task.id)!.state).toBe('REWORK');
      expect(store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      const rejection = events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.rejected');
      expect((rejection!.payload as { diagnosis: string }).diagnosis).toMatch(/infra\/main\.tf/);
    } finally {
      store.close();
    }
  });
});

describe('E9.8 circuit wiring — live dependency load + HALF_OPEN probe settlement', () => {
  const circuitFailure = (failureClass: FailureContext['failureClass'], overrides: Partial<FailureContext> = {}): FailureContext => ({
    attemptId: `attempt_${crypto.randomUUID()}`,
    taskId: `task_${crypto.randomUUID()}`,
    workOrderId: `wo_${crypto.randomUUID()}`,
    failureClass,
    error: `${failureClass} observed`,
    attemptCount: 0,
    sameClassCount: 0,
    changedCondition: 'backoff',
    ...overrides,
  });

  function circuitHarnessConfig() {
    const store = openStateStore(join(workDir, `e98-circuit-${crypto.randomUUID()}.db`));
    const events = openEventLog(store.db);
    let t = Date.parse('2026-09-30T00:00:00.000Z');
    const clock = {
      now: () => new Date(t).toISOString(),
      advance: (ms: number) => {
        t += ms;
      },
    };
    const circuit = { failureThreshold: 2, resetTimeoutMs: 30_000, probeTimeoutMs: 5_000 };
    return {
      store,
      events,
      clock,
      circuit,
      deps: {
        store,
        events,
        now: clock.now,
        budgets: { perClassRetries: 2, backoffBaseMs: 1, backoffMaxMs: 1 },
        circuit,
      } as RecoveryDeps,
      close: () => store.close(),
    };
  }

  it('feeds DEPENDENCY_UNAVAILABLE / PROVIDER_OUTAGE / MODEL_UNAVAILABLE into the circuit', () => {
    const h = circuitHarnessConfig();
    try {
      for (const failureClass of ['DEPENDENCY_UNAVAILABLE', 'PROVIDER_OUTAGE', 'MODEL_UNAVAILABLE'] as const) {
        recover(h.deps, circuitFailure(failureClass, { failureIndex: 1, requiredModel: 'model-x' }));
      }
      // Each class is observed as live load: three named buckets exist, not one
      // silently-ignored class. The provider/model classes key by the pinned model.
      expect(circuitSnapshot(h.deps, 'dependency').consecutiveFailures).toBe(1);
      expect(circuitSnapshot(h.deps, 'model-x').consecutiveFailures).toBe(2);
    } finally {
      h.close();
    }
  });

  it('always settles a HALF_OPEN probe it admits (a failed probe re-opens and sheds)', () => {
    const h = circuitHarnessConfig();
    try {
      recover(h.deps, circuitFailure('DEPENDENCY_UNAVAILABLE', { failureIndex: 1 }));
      // Second failure trips OPEN and sheds.
      expect(recover(h.deps, circuitFailure('DEPENDENCY_UNAVAILABLE', { failureIndex: 2 }))).toMatchObject({
        kind: 'WAITING_RESOURCE',
      });
      expect(circuitSnapshot(h.deps, 'dependency').state).toBe('OPEN');

      // After the window the next failure admits a HALF_OPEN probe and — because
      // `recover()` is a failure delivery — settles it (re-opens, no dangling
      // probe) and sheds rather than retrying blindly.
      h.clock.advance(30_000);
      const probe = recover(h.deps, circuitFailure('DEPENDENCY_UNAVAILABLE', { failureIndex: 3 }));
      expect(probe).toMatchObject({ kind: 'WAITING_RESOURCE' });
      const settled = circuitSnapshot(h.deps, 'dependency');
      expect(settled.state).toBe('OPEN');
      expect(settled.probeInFlight).toBe(false);
    } finally {
      h.close();
    }
  });

  it('a settled success closes the circuit and shedding stops (recordDependencySuccess)', () => {
    const h = circuitHarnessConfig();
    try {
      recover(h.deps, circuitFailure('DEPENDENCY_UNAVAILABLE', { failureIndex: 1 }));
      recover(h.deps, circuitFailure('DEPENDENCY_UNAVAILABLE', { failureIndex: 2 }));
      expect(circuitSnapshot(h.deps, 'dependency').state).toBe('OPEN');

      recordDependencySuccess(h.deps, 'dependency');
      expect(circuitSnapshot(h.deps, 'dependency')).toMatchObject({
        state: 'CLOSED',
        consecutiveFailures: 0,
        probeInFlight: false,
      });
      // Load flows again: the next failure is not shed (it is retried within
      // the bounded wheel, and only then counts toward a fresh window).
      expect(recover(h.deps, circuitFailure('DEPENDENCY_UNAVAILABLE', { failureIndex: 3 }))).toMatchObject({
        kind: 'RETRY_NEW_ATTEMPT',
      });
    } finally {
      h.close();
    }
  });

  it('a directly-admitted probe that is never settled times out (no permanent half-open)', () => {
    const h = circuitHarnessConfig();
    try {
      recordDependencyFailure(h.deps, 'dependency', h.circuit);
      recordDependencyFailure(h.deps, 'dependency', h.circuit);
      expect(circuitSnapshot(h.deps, 'dependency').state).toBe('OPEN');

      h.clock.advance(30_000);
      // The gate admits the probe; nothing settles it.
      expect(beforeDependencyRequest(h.deps, 'dependency', h.circuit)).toMatchObject({
        allowed: true,
        state: 'HALF_OPEN',
      });
      expect(circuitSnapshot(h.deps, 'dependency').probeInFlight).toBe(true);

      // While in flight (within the probe window) further calls are shed.
      h.clock.advance(1_000);
      expect(beforeDependencyRequest(h.deps, 'dependency', h.circuit)).toMatchObject({
        allowed: false,
        state: 'HALF_OPEN',
      });

      // Past the probe timeout the dangling probe is reaped: the gate re-opens
      // (fresh window) instead of shedding forever.
      h.clock.advance(5_000);
      const reaped = beforeDependencyRequest(h.deps, 'dependency', h.circuit);
      expect(reaped.allowed).toBe(false);
      expect(reaped.state).toBe('OPEN');
      expect(circuitSnapshot(h.deps, 'dependency').probeInFlight).toBe(false);
    } finally {
      h.close();
    }
  });
});
