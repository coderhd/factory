import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FactoryError } from '../../src/factory/domain/errors';
import {
  TASK_CREATED,
  createWorkOrder,
  transitionTask,
  transitionWorkOrder,
  type Task,
  type WorkOrderState,
} from '../../src/factory/domain/workOrder';
import { openEventLog } from '../../src/factory/events/log';
import {
  DAG_COMMITTED,
  DAG_PROPOSED,
  DAG_REJECTED,
  commitDAG,
  getActiveDAG,
  listDAGVersions,
  projectDAGVersions,
  proposeDAG,
  validateDAG,
  type DAGProposalPayload,
  type ProposalNode,
} from '../../src/factory/planning/dag';
import { createScheduler } from '../../src/factory/scheduler/scheduler';
import { createArtifactStore, openStateStore } from '../../src/factory/state/store';
import type {
  ExecutionEnvelope,
  WorkerAdapter,
  WorkerResult,
  WorkerStatus,
} from '../../src/factory/workers/herdr';
import {
  assign,
  createWorkerManager,
  startTask,
  type AssignmentRecord,
  type WorkerRecord,
} from '../../src/factory/workers/manager';
import { createWorktreeManager } from '../../src/factory/worktrees/worktree';

let workDir: string;
let dbPath: string;
let worktreeRoot: string;
let repoPath: string;
let baseCommit: string;

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
  workDir = mkdtempSync(join(tmpdir(), 'factory-e3-'));
  dbPath = join(workDir, 'factory.db');
  worktreeRoot = join(workDir, 'worktrees');
  repoPath = initRepo(workDir);
  baseCommit = git(['rev-parse', 'HEAD'], repoPath);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake Herdr adapter (Ruling R5: no live external calls)
// ---------------------------------------------------------------------------

class FakeHerdr implements WorkerAdapter {
  provisioned = false;
  started = false;
  stopped = false;
  destroyed = false;
  result: WorkerResult | null = null;
  envelope: ExecutionEnvelope | null = null;
  dispatchError: Error | null = null;

  async provision(): Promise<void> {
    this.provisioned = true;
  }
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  status(): WorkerStatus {
    return { state: this.result ? 'completed' : 'running', lastHeartbeatAt: new Date().toISOString() };
  }
  async execute(envelope: ExecutionEnvelope): Promise<void> {
    if (this.dispatchError) throw this.dispatchError;
    this.envelope = envelope;
  }
  async collectArtifacts(): Promise<WorkerResult> {
    return this.result ?? failedResult('no result produced');
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

const completedResult = (overrides: Partial<WorkerResult> = {}): WorkerResult => ({
  status: 'completed',
  commits: [{ sha: 'deadbeef', message: 'task work' }],
  artifacts: [],
  interactions: [],
  observations: [],
  verificationRequests: [],
  diff: 'diff --git a/x b/x',
  failure: null,
  ...overrides,
});

const failedResult = (failure: string): WorkerResult => ({
  status: 'failed',
  commits: [],
  artifacts: [],
  interactions: [],
  observations: [],
  verificationRequests: [],
  diff: null,
  failure,
});

const waitingResult = (): WorkerResult => ({
  status: 'waiting_input',
  commits: [],
  artifacts: [],
  interactions: [{ question: 'which base branch?' }],
  observations: [],
  verificationRequests: [],
  diff: null,
  failure: null,
});

function makeClock() {
  let t = Date.parse('2026-09-30T00:00:00.000Z');
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

interface Harness {
  store: ReturnType<typeof openStateStore>;
  events: ReturnType<typeof openEventLog>;
  workers: ReturnType<typeof createWorkerManager>;
  worktrees: ReturnType<typeof createWorktreeManager>;
  scheduler: ReturnType<typeof createScheduler>;
  adapters: FakeHerdr[];
  clock: ReturnType<typeof makeClock>;
}

function harness(opts: { maxConcurrentTasks?: number; withArtifacts?: boolean } = {}): Harness {
  const store = openStateStore(dbPath);
  const events = openEventLog(store.db);
  const clock = makeClock();
  const adapters: FakeHerdr[] = [];
  const workers = createWorkerManager({
    store,
    events,
    spawn: () => {
      const adapter = new FakeHerdr();
      adapters.push(adapter);
      return adapter;
    },
    now: clock.now,
  });
  const worktrees = createWorktreeManager({ rootDir: worktreeRoot, baseBranch: 'main' });
  const scheduler = createScheduler(
    {
      store,
      events,
      workers,
      worktrees,
      now: clock.now,
      repoPath,
      artifacts: opts.withArtifacts ? createArtifactStore(join(workDir, 'artifacts')) : undefined,
    },
    { maxConcurrentTasks: opts.maxConcurrentTasks ?? 3 },
  );
  return { store, events, workers, worktrees, scheduler, adapters, clock };
}

function deps(h: Harness) {
  return { store: h.store, events: h.events };
}

function seedWorkOrder(h: Harness, states: WorkOrderState[] = []): string {
  const wo = createWorkOrder(deps(h), {
    intent: 'E3 subject',
    acceptanceCriteria: ['accepted'],
    requiredVerification: ['accepted'],
  });
  for (const to of states) transitionWorkOrder(deps(h), wo.id, { to });
  return wo.id;
}

/** Create a Work Order, commit a v1 DAG, and move it to EXECUTING. */
function plan(h: Harness, nodes: ProposalNode[]): { woId: string; dag: ReturnType<typeof commitDAG> } {
  const woId = seedWorkOrder(h, ['READY', 'PLANNING']);
  const dag = commitDAG(deps(h), woId, { nodes });
  transitionWorkOrder(deps(h), woId, { to: 'EXECUTING' });
  return { woId, dag };
}

const nodeTask = (dag: { nodes: Array<{ nodeId: string; taskId: string }> }, nodeId: string): string =>
  dag.nodes.find((node) => node.nodeId === nodeId)!.taskId;

const stateOf = (h: Harness, taskId: string): string | undefined =>
  h.store.get<Task>('tasks', taskId)?.state;

const tasksInState = (h: Harness, state: string): Task[] =>
  h.store.list<Task>('tasks').filter((task) => task.state === state);

const workerOf = (h: Harness, workerId: string): WorkerRecord =>
  h.store.get<WorkerRecord>('workers', workerId)!;

const adapterForTask = (h: Harness, taskId: string): FakeHerdr =>
  h.adapters.find((adapter) => adapter.envelope?.taskId === taskId)!;

const openAssignments = (h: Harness): AssignmentRecord[] =>
  h.store
    .list<AssignmentRecord>('assignments')
    .filter((assignment) => assignment.closedAt === null);

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function expectCode(fn: () => unknown, code: string): void {
  let caught: FactoryError | null = null;
  try {
    fn();
  } catch (error) {
    caught = error as FactoryError;
  }
  expect(caught).toBeInstanceOf(FactoryError);
  expect(caught?.code).toBe(code);
}

// ---------------------------------------------------------------------------
// T1 / T2 — DAG validation + commit
// ---------------------------------------------------------------------------

const VALID_PAYLOAD: DAGProposalPayload = {
  nodes: [
    { nodeId: 'n1', title: 'Add config schema' },
    { nodeId: 'n2', title: 'Implement store', dependsOn: ['n1'] },
    { nodeId: 'n3', title: 'Write docs', dependsOn: ['n1'] },
    { nodeId: 'n4', title: 'Release notes', dependsOn: ['n2', 'n3'] },
  ],
  rationale: 'store and docs are independent once the schema lands',
};

describe('E3 DAG propose / validate / commit', () => {
  it('records a proposal without committing, then commits a valid DAG as DAGv1 (V-agree holds)', () => {
    const h = harness();
    try {
      const woId = seedWorkOrder(h, ['READY', 'PLANNING']);

      const proposal = proposeDAG(deps(h), woId, VALID_PAYLOAD);
      expect(proposal.proposedVersion).toBe(1);
      expect(proposal.workOrderId).toBe(woId);
      expect(proposal.id.startsWith('prop_')).toBe(true);
      expect(h.events.readEvents({ aggregateId: woId }).some((e) => e.type === DAG_PROPOSED)).toBe(
        true,
      );
      // proposeDAG records only; nothing durable is materialized.
      expect(h.store.list('tasks')).toHaveLength(0);
      expect(h.store.list('task_dependencies')).toHaveLength(0);

      expect(validateDAG(deps(h), woId, VALID_PAYLOAD)).toEqual({ ok: true });

      const dag = commitDAG(deps(h), woId, VALID_PAYLOAD);
      expect(dag.version).toBe(1);
      expect(dag.workOrderId).toBe(woId);
      expect(dag.nodes).toHaveLength(4);

      const tasks = h.store.list<Task>('tasks');
      expect(tasks).toHaveLength(4);
      expect(tasks.every((task) => task.state === 'PLANNED')).toBe(true);
      expect(tasks.every((task) => task.workOrderId === woId)).toBe(true);

      // Resolved dependencies: n2 depends on n1's minted task id.
      expect(h.store.get<Task>('tasks', nodeTask(dag, 'n2'))?.dependsOn).toEqual([
        nodeTask(dag, 'n1'),
      ]);
      expect(h.store.get<Task>('tasks', nodeTask(dag, 'n4'))?.dependsOn).toEqual([
        nodeTask(dag, 'n2'),
        nodeTask(dag, 'n3'),
      ]);

      // V-agree: version doc ≡ task.dependsOn ≡ edge rows.
      const edges = h.store.list<{ taskId: string; dependsOnTaskId: string }>('task_dependencies');
      expect(edges).toHaveLength(4);
      for (const node of dag.nodes) {
        const task = h.store.get<Task>('tasks', node.taskId)!;
        expect(task.dependsOn).toEqual(node.dependsOnTaskIds);
        for (const dep of node.dependsOnTaskIds) {
          expect(edges.some((e) => e.taskId === node.taskId && e.dependsOnTaskId === dep)).toBe(true);
        }
      }

      // Events: one dag.committed + one task.created per node.
      expect(h.events.readEvents({ aggregateId: woId }).some((e) => e.type === DAG_COMMITTED)).toBe(
        true,
      );
      expect(h.events.readEvents().filter((e) => e.type === TASK_CREATED)).toHaveLength(4);
    } finally {
      h.store.close();
    }
  });

  const invalidCases: Array<{
    rule: string;
    state: WorkOrderState[];
    payload: DAGProposalPayload;
    reasons: number;
  }> = [
    {
      rule: 'DAG_WO_STATE',
      state: ['READY'],
      payload: { nodes: [{ nodeId: 'n1', title: 'Ship it' }] },
      reasons: 1,
    },
    { rule: 'DAG_EMPTY', state: ['READY', 'PLANNING'], payload: { nodes: [] }, reasons: 1 },
    {
      rule: 'DAG_MALFORMED',
      state: ['READY', 'PLANNING'],
      payload: {
        nodes: [{ nodeId: 'n1', title: '' }, { nodeId: 'n2' } as unknown as ProposalNode],
      },
      reasons: 2,
    },
    {
      rule: 'DAG_DUPLICATE_NODE',
      state: ['READY', 'PLANNING'],
      payload: {
        nodes: [
          { nodeId: 'n1', title: 'Design API' },
          { nodeId: 'n1', title: 'Design API v2' },
        ],
      },
      reasons: 1,
    },
    {
      rule: 'DAG_UNKNOWN_DEP',
      state: ['READY', 'PLANNING'],
      payload: {
        nodes: [
          { nodeId: 'n1', title: 'Design API' },
          { nodeId: 'n2', title: 'Implement', dependsOn: ['n9'] },
        ],
      },
      reasons: 1,
    },
    {
      rule: 'DAG_SELF_DEP',
      state: ['READY', 'PLANNING'],
      payload: { nodes: [{ nodeId: 'n1', title: 'Review itself', dependsOn: ['n1'] }] },
      reasons: 1,
    },
    {
      rule: 'DAG_CYCLE',
      state: ['READY', 'PLANNING'],
      payload: {
        nodes: [
          { nodeId: 'n1', title: 'A', dependsOn: ['n3'] },
          { nodeId: 'n2', title: 'B', dependsOn: ['n1'] },
          { nodeId: 'n3', title: 'C', dependsOn: ['n2'] },
        ],
      },
      reasons: 1,
    },
  ];

  for (const testCase of invalidCases) {
    it(`rejects ${testCase.rule} on paper: dag.rejected + no task/edge rows + WO state unchanged`, () => {
      const h = harness();
      try {
        const woId = seedWorkOrder(h, testCase.state);
        const stateBefore = h.store.get<{ state: string }>('work_orders', woId)!.state;

        const validation = validateDAG(deps(h), woId, testCase.payload);
        expect(validation.ok).toBe(false);
        if (!validation.ok) {
          expect(validation.reasons).toHaveLength(testCase.reasons);
          expect(validation.reasons.map((r) => r.rule)).toContain(testCase.rule);
        }

        expectCode(() => commitDAG(deps(h), woId, testCase.payload), 'DAG_INVALID');

        const rejected = h.events
          .readEvents({ aggregateId: woId })
          .filter((e) => e.type === DAG_REJECTED);
        expect(rejected).toHaveLength(1);
        expect(
          (rejected[0].payload as { reasons: Array<{ rule: string }> }).reasons.map((r) => r.rule),
        ).toContain(testCase.rule);

        expect(h.store.list('tasks')).toHaveLength(0);
        expect(h.store.list('task_dependencies')).toHaveLength(0);
        expect(h.store.get<{ state: string }>('work_orders', woId)!.state).toBe(stateBefore);
        expect(getActiveDAG(deps(h), woId)).toBeNull();
      } finally {
        h.store.close();
      }
    });
  }

  it('rejects DAG_IN_FLIGHT for a REPLAN while an active task is RUNNING', () => {
    const h = harness();
    try {
      const { woId, dag } = plan(h, [
        { nodeId: 'a', title: 'A' },
        { nodeId: 'b', title: 'B' },
      ]);
      // Put an active-version task into RUNNING.
      const taskId = nodeTask(dag, 'a');
      transitionTask(deps(h), taskId, { to: 'READY' });
      transitionTask(deps(h), taskId, { to: 'ASSIGNED' });
      transitionTask(deps(h), taskId, { to: 'RUNNING' });

      const replan: DAGProposalPayload = { nodes: [{ nodeId: 'x', title: 'replacement' }] };
      const validation = validateDAG(deps(h), woId, replan);
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.reasons.map((r) => r.rule)).toContain('DAG_IN_FLIGHT');
      }
      expectCode(() => commitDAG(deps(h), woId, replan), 'DAG_INVALID');
      // The prior version still stands.
      expect(getActiveDAG(deps(h), woId)?.version).toBe(1);
    } finally {
      h.store.close();
    }
  });

  it('preserves DAG v1 when a REPLAN commits v2 (append-only versioning + replay)', () => {
    const h = harness();
    try {
      const { woId, dag: v1 } = plan(h, [
        { nodeId: 'a', title: 'A' },
        { nodeId: 'b', title: 'B', dependsOn: ['a'] },
      ]);
      const v2 = commitDAG(deps(h), woId, {
        nodes: [
          { nodeId: 'x', title: 'X' },
          { nodeId: 'y', title: 'Y', dependsOn: ['x'] },
        ],
      });
      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);

      expect(getActiveDAG(deps(h), woId)).toEqual(v2);
      const versions = listDAGVersions(deps(h), woId);
      expect(versions.map((v) => v.version)).toEqual([1, 2]);

      // Replay fold reproduces both versions.
      const replayed = projectDAGVersions(h.events.readEvents(), woId);
      expect(replayed.map((v) => v.id)).toEqual([v1.id, v2.id]);

      // v1 task rows survive untouched (append-only; no silent overwrite).
      for (const node of v1.nodes) {
        expect(h.store.get<Task>('tasks', node.taskId)?.state).toBe('PLANNED');
      }
      expect(h.store.list('tasks')).toHaveLength(4);

      // The event log is immutable at the DB level.
      expect(() =>
        h.store.db.query("UPDATE events SET type = 'tampered' WHERE type = 'dag.committed'").run(),
      ).toThrow();
    } finally {
      h.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T3–T6 — scheduler concurrency, blocking, provisioning, reclaim
// ---------------------------------------------------------------------------

describe('E3 scheduler capacity + policy', () => {
  it('runs 3 independent tasks concurrently at maxConcurrentTasks 3', () => {
    const h = harness({ maxConcurrentTasks: 3 });
    try {
      const { woId } = plan(h, [
        { nodeId: 'a', title: 'A' },
        { nodeId: 'b', title: 'B' },
        { nodeId: 'c', title: 'C' },
      ]);
      h.scheduler.tick();

      const running = tasksInState(h, 'RUNNING').filter((t) => t.workOrderId === woId);
      expect(running).toHaveLength(3);
      expect(h.workers.listWorkers().filter((w) => w.runtimeState === 'BUSY')).toHaveLength(3);
      expect(h.scheduler.status().concurrency).toEqual({ current: 3, max: 3 });

      // Every running task has a distinct isolated worktree recorded on its assignment.
      const assignments = h.store.list<AssignmentRecord>('assignments');
      expect(new Set(assignments.map((a) => a.worktreePath)).size).toBe(3);
    } finally {
      h.store.close();
    }
  });

  it('respects maxConcurrentTasks 2 and assigns the queued task only after a slot frees', async () => {
    const h = harness({ maxConcurrentTasks: 2 });
    try {
      const { woId } = plan(h, [
        { nodeId: 'a', title: 'A' },
        { nodeId: 'b', title: 'B' },
        { nodeId: 'c', title: 'C' },
      ]);
      h.scheduler.tick();

      expect(tasksInState(h, 'RUNNING')).toHaveLength(2);
      expect(tasksInState(h, 'READY')).toHaveLength(1);
      expect(h.workers.listWorkers().filter((w) => w.runtimeState === 'BUSY')).toHaveLength(2);
      expect(h.scheduler.status().concurrency.current).toBe(2);

      // Complete whichever task runs first.
      const finished = tasksInState(h, 'RUNNING')[0];
      adapterForTask(h, finished.id).result = completedResult();

      await settle();
      h.scheduler.tick();
      await settle();

      expect(stateOf(h, finished.id)).toBe('SUCCESS');
      // The freed slot + idle worker pick up the queued task.
      const nowRunning = tasksInState(h, 'RUNNING').filter((t) => t.workOrderId === woId);
      expect(nowRunning).toHaveLength(2);
      expect(nowRunning.map((t) => t.id)).not.toContain(finished.id);
      // Concurrency never exceeded the configured max.
      expect(h.scheduler.status().concurrency.current).toBeLessThanOrEqual(2);
    } finally {
      h.store.close();
    }
  });

  it('keeps a dependent blocked until its dependency is VERIFIED', async () => {
    const h = harness();
    try {
      const { woId, dag } = plan(h, [
        { nodeId: 'a', title: 'A' },
        { nodeId: 'b', title: 'B', dependsOn: ['a'] },
      ]);
      const a = nodeTask(dag, 'a');
      const b = nodeTask(dag, 'b');

      h.scheduler.tick();
      expect(stateOf(h, a)).toBe('RUNNING');
      expect(stateOf(h, b)).toBe('PLANNED');

      adapterForTask(h, a).result = completedResult();
      await settle();
      h.scheduler.tick();
      await settle();
      expect(stateOf(h, a)).toBe('SUCCESS');
      expect(stateOf(h, b)).toBe('PLANNED');

      // SUCCESS/VERIFYING do not unblock dependents (spec §5.2).
      transitionTask(deps(h), a, { to: 'VERIFYING' });
      h.scheduler.tick();
      expect(stateOf(h, b)).toBe('PLANNED');

      transitionTask(deps(h), a, { to: 'VERIFIED' });
      h.scheduler.tick();
      await settle();
      expect(stateOf(h, b)).toBe('RUNNING');
      expect(woId).toBeString();
    } finally {
      h.store.close();
    }
  });

  it('provisions on demand (never above max 5) and reclaims idle workers to zero at rest', async () => {
    const h = harness({ maxConcurrentTasks: 3 });
    try {
      const { woId } = plan(h, [
        { nodeId: 'a', title: 'A' },
        { nodeId: 'b', title: 'B' },
        { nodeId: 'c', title: 'C' },
        { nodeId: 'd', title: 'D' },
        { nodeId: 'e', title: 'E' },
        { nodeId: 'f', title: 'F' },
      ]);

      // Demand is 6 but the ceiling is 5 and only 3 may run concurrently.
      // No pre-provisioning at rest: min is 0 (no floor-keeping).
      expect(h.workers.listWorkers()).toHaveLength(0);
      expect(h.scheduler.status().provisioning).toEqual({ enabled: true, min: 0, max: 5 });
      h.scheduler.tick();
      expect(h.workers.listWorkers()).toHaveLength(5);
      expect(tasksInState(h, 'RUNNING')).toHaveLength(3);
      expect(h.workers.listWorkers().filter((w) => w.runtimeState === 'IDLE')).toHaveLength(2);

      // A second tick never grows the population past the ceiling.
      h.scheduler.tick();
      expect(h.workers.listWorkers()).toHaveLength(5);

      // Complete the first wave: the adapters are identified synchronously,
      // and results must be set before the collect promises resolve.
      for (const task of tasksInState(h, 'RUNNING')) {
        adapterForTask(h, task.id).result = completedResult();
      }
      await settle();
      h.scheduler.tick(); // routes the first wave and assigns the second.
      for (const task of tasksInState(h, 'RUNNING')) {
        expect(adapterForTask(h, task.id)).toBeDefined();
        adapterForTask(h, task.id).result = completedResult();
      }
      await settle();
      h.scheduler.tick();
      await settle();

      const settled = h.store.list<Task>('tasks').filter((t) => t.workOrderId === woId);
      expect(settled).toHaveLength(6);
      expect(settled.every((t) => t.state === 'SUCCESS')).toBe(true);

      // Every completion's release rule closed the assignment and freed the worker.
      expect(openAssignments(h)).toHaveLength(0);
      expect(h.workers.listWorkers().every((w) => w.runtimeState === 'IDLE')).toBe(true);

      // E5 would drive EXECUTING→VERIFYING; reclaim must still zero the population.
      transitionWorkOrder(deps(h), woId, { to: 'VERIFYING' });
      h.clock.advance(11 * 60_000);
      h.scheduler.tick();

      const workers = h.workers.listWorkers();
      expect(workers).toHaveLength(5); // rows retained as provenance
      expect(workers.every((w) => w.runtimeState === 'RECLAIMED')).toBe(true);
      expect(h.adapters.every((a) => a.destroyed)).toBe(true);
      expect(h.scheduler.status().workers.idle + h.scheduler.status().workers.busy).toBe(0);

      const assignments = h.store.list<AssignmentRecord>('assignments');
      expect(assignments.length).toBeGreaterThan(0);
      expect(assignments.every((a) => a.closedAt !== null)).toBe(true);
    } finally {
      h.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T7 — worktree isolation
// ---------------------------------------------------------------------------

describe('E3 worktree isolation', () => {
  it('gives every task a unique branch + worktree + baseCommit under the temp root', () => {
    const worktrees = createWorktreeManager({ rootDir: worktreeRoot, baseBranch: 'main' });
    const a = worktrees.createTaskWorktree('task_a', repoPath);
    const b = worktrees.createTaskWorktree('task_b', repoPath);

    expect(a.branch).toBe('factory/task-task_a');
    expect(b.branch).toBe('factory/task-task_b');
    expect(a.branch).not.toBe(b.branch);
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.worktreePath.startsWith(worktreeRoot)).toBe(true);
    expect(a.baseCommit).toBe(baseCommit);
    expect(b.baseCommit).toBe(baseCommit);
    expect(existsSync(a.worktreePath)).toBe(true);
    expect(existsSync(b.worktreePath)).toBe(true);

    const branches = git(['branch', '--list', 'factory/task-*'], repoPath);
    expect(branches).toContain('factory/task-task_a');
    expect(branches).toContain('factory/task-task_b');
  });

  it('records the isolation triple on each assignment', async () => {
    const h = harness({ maxConcurrentTasks: 2 });
    try {
      plan(h, [
        { nodeId: 'a', title: 'A' },
        { nodeId: 'b', title: 'B' },
      ]);
      h.scheduler.tick();

      const assignments = h.store.list<AssignmentRecord>('assignments');
      expect(assignments).toHaveLength(2);
      for (const assignment of assignments) {
        expect(assignment.branch).toBe(`factory/task-${assignment.taskId}`);
        expect(assignment.baseCommit).toBe(baseCommit);
        expect(assignment.worktreePath.startsWith(worktreeRoot)).toBe(true);
        expect(existsSync(assignment.worktreePath)).toBe(true);
      }
    } finally {
      h.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T9 — assign guards, transaction atomicity, worker failure
// ---------------------------------------------------------------------------

describe('E3 assignment + completion rules', () => {
  it('rejects assign when the task is not READY or the worker is not IDLE', () => {
    const h = harness();
    try {
      const { dag } = plan(h, [
        { nodeId: 'a', title: 'A' },
        { nodeId: 'b', title: 'B' },
      ]);
      const a = nodeTask(dag, 'a');
      const b = nodeTask(dag, 'b');
      const worker = h.workers.provisionWorker('herdr');
      const intent = (taskId: string) => ({
        taskId,
        workerId: worker.id,
        worktree: {
          taskId,
          branch: `factory/task-${taskId}`,
          worktreePath: '/tmp/x',
          baseCommit: 'c',
        },
      });

      expectCode(() => assign(deps(h), intent(a)), 'TASK_NOT_READY');

      transitionTask(deps(h), a, { to: 'READY' });
      const record = assign(deps(h), intent(a));
      expect(record.branch).toBe(`factory/task-${a}`);
      expect(record.closedAt).toBeNull();
      expect(workerOf(h, worker.id).runtimeState).toBe('BUSY');

      // The worker now holds a single live assignment.
      transitionTask(deps(h), b, { to: 'READY' });
      expectCode(() => assign(deps(h), intent(b)), 'WORKER_NOT_IDLE');
    } finally {
      h.store.close();
    }
  });

  it('rolls back the whole assign (task + worker + assignment) when the event append fails', () => {
    const h = harness();
    try {
      const { dag } = plan(h, [{ nodeId: 'a', title: 'A' }]);
      const a = nodeTask(dag, 'a');
      transitionTask(deps(h), a, { to: 'READY' });
      const worker = h.workers.provisionWorker('herdr');
      const failingEvents = {
        appendEvent() {
          throw new Error('event log unavailable');
        },
        readEvents() {
          return [];
        },
        count() {
          return 0;
        },
      };

      expect(() =>
        assign(
          { store: h.store, events: failingEvents },
          {
            taskId: a,
            workerId: worker.id,
            worktree: { taskId: a, branch: 'b', worktreePath: '/tmp/x', baseCommit: 'c' },
          },
        ),
      ).toThrow('event log unavailable');

      expect(stateOf(h, a)).toBe('READY');
      expect(workerOf(h, worker.id).runtimeState).toBe('IDLE');
      expect(h.store.list('assignments')).toHaveLength(0);
    } finally {
      h.store.close();
    }
  });

  it('completes a failed report as a failed Attempt and leaves the Task RUNNING', async () => {
    const h = harness();
    try {
      const { dag } = plan(h, [{ nodeId: 'a', title: 'A' }]);
      const a = nodeTask(dag, 'a');
      h.scheduler.tick();

      adapterForTask(h, a).result = failedResult('typecheck failed');
      await settle();
      h.scheduler.tick();
      await settle();

      const attempts = h.store.list<{
        taskId: string;
        outcome: string | null;
        failureHistory: unknown[];
      }>('attempts');
      expect(attempts).toHaveLength(1);
      expect(attempts[0].outcome).toBe('failed');
      expect(attempts[0].failureHistory).toHaveLength(1);

      // Invariant 9: a failed Attempt does not fail durable Work by itself.
      expect(stateOf(h, a)).toBe('RUNNING');

      // Release rule still frees the worker and closes the assignment.
      const worker = h.workers.listWorkers()[0];
      expect(worker.runtimeState).toBe('IDLE');
      expect(worker.lease).toBeNull();
      expect(openAssignments(h)).toHaveLength(0);
    } finally {
      h.store.close();
    }
  });

  it('treats a completed report without evidence as failure (no success without evidence)', async () => {
    const h = harness();
    try {
      const { dag } = plan(h, [{ nodeId: 'a', title: 'A' }]);
      const a = nodeTask(dag, 'a');
      h.scheduler.tick();

      adapterForTask(h, a).result = completedResult({ commits: [], diff: '' });
      await settle();
      h.scheduler.tick();
      await settle();

      expect(stateOf(h, a)).toBe('RUNNING');
      expect(h.store.list<{ outcome: string | null }>('attempts')[0].outcome).toBe('failed');
    } finally {
      h.store.close();
    }
  });

  it('keeps a waiting_input worker BUSY with an open assignment (never reclaimed)', async () => {
    const h = harness();
    try {
      const { dag } = plan(h, [{ nodeId: 'a', title: 'A' }]);
      const a = nodeTask(dag, 'a');
      h.scheduler.tick();

      adapterForTask(h, a).result = waitingResult();
      await settle();
      h.scheduler.tick();
      await settle();

      expect(stateOf(h, a)).toBe('WAITING_INPUT');
      const worker = h.workers.listWorkers()[0];
      expect(worker.runtimeState).toBe('BUSY');
      expect(openAssignments(h)).toHaveLength(1);

      h.clock.advance(11 * 60_000);
      h.scheduler.tick();
      expect(workerOf(h, worker.id).runtimeState).toBe('BUSY');
    } finally {
      h.store.close();
    }
  });

  it('surfaces a dispatch rejection as a failed WorkerResult', async () => {
    const h = harness();
    try {
      const worker = h.workers.provisionWorker('herdr');
      h.adapters[0].dispatchError = new Error('herdr spawn refused');
      const envelope: ExecutionEnvelope = {
        workOrderId: 'wo',
        taskId: 'task',
        attemptId: 'attempt',
        repository: repoPath,
        baseCommit,
        branch: 'b',
        worktree: worktreeRoot,
        authorizationCapabilities: [],
        initialContext: 'x',
        retrievalEndpoint: null,
        skills: [],
        requiredVerification: [],
      };

      await h.workers.execute(worker.id, envelope);
      const result = await h.workers.collectArtifacts(worker.id);
      expect(result.status).toBe('failed');
      expect(result.failure).toContain('herdr spawn refused');
    } finally {
      h.store.close();
    }
  });

  it('startTask returns a §17 execution envelope and dispatches to the adapter', async () => {
    const h = harness();
    try {
      const { woId, dag } = plan(h, [{ nodeId: 'a', title: 'A', notes: 'node note' }]);
      const a = nodeTask(dag, 'a');
      transitionTask(deps(h), a, { to: 'READY' });
      const worker = h.workers.provisionWorker('herdr');
      const assignment = assign(deps(h), {
        taskId: a,
        workerId: worker.id,
        worktree: {
          taskId: a,
          branch: `factory/task-${a}`,
          worktreePath: join(worktreeRoot, a),
          baseCommit,
        },
      });
      const envelope = startTask(
        {
          store: h.store,
          events: h.events,
          workers: h.workers,
          worktrees: h.worktrees,
          now: h.clock.now,
        },
        assignment,
      );
      await settle();

      expect(envelope.taskId).toBe(a);
      expect(envelope.workOrderId).toBe(woId);
      expect(envelope.branch).toBe(`factory/task-${a}`);
      expect(envelope.baseCommit).toBe(baseCommit);
      expect(envelope.worktree).toBe(join(worktreeRoot, a));
      expect(envelope.requiredVerification).toEqual(['accepted']);
      expect(adapterForTask(h, a).envelope?.taskId).toBe(a);
      expect(workerOf(h, worker.id).lease?.taskId).toBe(a);
    } finally {
      h.store.close();
    }
  });
});
