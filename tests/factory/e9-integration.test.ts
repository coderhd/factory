import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServerDeps, runCli, type CliIO, type ServerDepsOptions } from '../../src/cli/factory';
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
} from '../../src/factory/verification/orchestrator';
import { commitDAG, listDAGVersions } from '../../src/factory/planning/dag';
import { createEvidenceReadPort, projectObservatory } from '../../src/factory/observatory/observatory';
import { check } from '../../src/factory/policy/policy';
import { CAPABILITY_POOL } from '../../src/factory/routing/rules';
import type { BudgetState, RoutingDecisionRecord } from '../../src/factory/routing/decisionModel';
import { RESOURCE_UNAVAILABLE } from '../../src/factory/recovery/recovery';
import { createScheduler, type SchedulerRouting } from '../../src/factory/scheduler/scheduler';
import { openStateStore } from '../../src/factory/state/store';
import {
  type ExecutionEnvelope,
  type WorkerAdapter,
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
}) {
  const store = openStateStore(join(workDir, `verify-${crypto.randomUUID()}.db`));
  const events = openEventLog(store.db);
  const engine = createVerificationEngine();
  for (const provider of options.providers) {
    engine.registerCheck({
      id: provider.id,
      category: provider.category,
      kind: provider.kind as never,
      run: () =>
        provider.passed
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
  const verifier = createE5Verifier({
    store,
    engine,
    judge,
    prompt: { id: 'e9-verify', version: '1' },
    rubric: ['Does the change set satisfy the criterion as written?'],
    provider: 'factory',
    now: () => '2026-09-30T12:00:00.000Z',
  });
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
  return { store, events, scheduler, close: () => store.close() };
}

/** Drive a seeded Task through the real §5.2 edges to SUCCESS, with an Attempt. */
function driveTaskToSuccess(
  store: ReturnType<typeof openStateStore>,
  events: ReturnType<typeof openEventLog>,
  taskId: string,
  model: string,
): Attempt {
  const deps = { store, events };
  const attempt = createAttempt(deps, { taskId, model });
  completeAttempt(deps, attempt.id, {
    outcome: 'success',
    diff: 'diff --git a/x b/x\n+export const x = 1;',
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
});
