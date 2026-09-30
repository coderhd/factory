import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServerDeps, type ServerDepsOptions } from '../../src/cli/factory';
import {
  DEFAULT_FACTORY_CONFIG,
  parseFactoryConfig,
  resolveFactoryConfig,
  serializeFactoryConfig,
  type FactoryDesiredConfig,
} from '../../src/factory/config/factoryConfig';
import {
  createWorkOrder,
  transitionWorkOrder,
  type Task,
  type WorkOrder,
} from '../../src/factory/domain/workOrder';
import { openEventLog } from '../../src/factory/events/log';
import { commitDAG } from '../../src/factory/planning/dag';
import { createEvidenceReadPort, projectObservatory } from '../../src/factory/observatory/observatory';
import { check } from '../../src/factory/policy/policy';
import { createScheduler } from '../../src/factory/scheduler/scheduler';
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
      expect(projectObservatory(createEvidenceReadPort(openStateStore(join(workDir, 'empty.db')))).verifiedPerDay).toEqual([]);
    } finally {
      store.close();
    }
  });
});
