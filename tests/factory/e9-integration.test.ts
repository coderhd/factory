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
  type WorkVerifier,
} from '../../src/factory/verification/orchestrator';
import { commitDAG, listDAGVersions } from '../../src/factory/planning/dag';
import { createEvidenceReadPort, projectObservatory } from '../../src/factory/observatory/observatory';
import { check } from '../../src/factory/policy/policy';
import { CAPABILITY_POOL } from '../../src/factory/routing/rules';
import type { BudgetState, RoutingDecisionRecord } from '../../src/factory/routing/decisionModel';
import { RESOURCE_UNAVAILABLE } from '../../src/factory/recovery/recovery';
import { createScheduler, type SchedulerRouting } from '../../src/factory/scheduler/scheduler';
import { openStateStore } from '../../src/factory/state/store';
import type { ApprovalRecord } from '../../src/factory/policy/policy';
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
});
