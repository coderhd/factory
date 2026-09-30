import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFactoryClient } from '../../src/factory/api/client';
import { startFactoryServer } from '../../src/factory/api/server';
import { createBackup, restoreBackup } from '../../src/factory/backup/archive';
import {
  DEFAULT_FACTORY_CONFIG,
  parseFactoryConfig,
  resolveFactoryConfig,
  serializeFactoryConfig,
  validateCompose,
} from '../../src/factory/config/factoryConfig';
import {
  createAttempt,
  createTask,
  createWorkOrder,
  transitionWorkOrder,
  type Task,
  type WorkOrder,
} from '../../src/factory/domain/workOrder';
import { openEventLog } from '../../src/factory/events/log';
import { commitDAG } from '../../src/factory/planning/dag';
import {
  projectDrillDown,
  projectObservatory,
  type EvidenceReadPort,
  type VerifiedChange,
} from '../../src/factory/observatory/observatory';
import { createScheduler } from '../../src/factory/scheduler/scheduler';
import { createArtifactStore, openStateStore, type StateStore } from '../../src/factory/state/store';
import {
  type ExecutionEnvelope,
  type WorkerAdapter,
  type WorkerResult,
  type WorkerStatus,
} from '../../src/factory/workers/herdr';
import { createWorkerManager } from '../../src/factory/workers/manager';
import { createWorktreeManager } from '../../src/factory/worktrees/worktree';
import { runCli, type CliIO } from '../../src/cli/factory';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'factory-e2-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

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

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A read-side evidence port double (Ruling R2 seam; E5 will supply the real one). */
class FakeEvidence implements EvidenceReadPort {
  changes: VerifiedChange[] = [];
  listVerifiedChanges(): VerifiedChange[] {
    return this.changes;
  }
}

/** Fake Herdr adapter (Ruling R5: no live external calls). */
class FakeHerdr implements WorkerAdapter {
  result: WorkerResult | null = null;
  envelope: ExecutionEnvelope | null = null;
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
    return this.result ?? failedResult('no result produced');
  }
  async destroy(): Promise<void> {}
}

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

const waitingResult = (question: string): WorkerResult => ({
  status: 'waiting_input',
  commits: [],
  artifacts: [],
  interactions: [{ question }],
  observations: [],
  verificationRequests: [],
  diff: null,
  failure: null,
});

interface ApiHarness {
  store: StateStore;
  events: ReturnType<typeof openEventLog>;
  evidence: FakeEvidence;
  server: ReturnType<typeof startFactoryServer>;
  client: ReturnType<typeof createFactoryClient>;
  stop(): void;
}

function apiHarness(opts: { dbPath?: string; evidence?: FakeEvidence } = {}): ApiHarness {
  const store = openStateStore(opts.dbPath ?? join(workDir, 'factory.db'));
  const events = openEventLog(store.db);
  const evidence = opts.evidence ?? new FakeEvidence();
  const server = startFactoryServer(
    { store, events, evidence, version: '0.1.0', schemaVersion: '1' },
    { port: 0, hostname: '127.0.0.1' },
  );
  const client = createFactoryClient({ baseUrl: server.url });
  return {
    store,
    events,
    evidence,
    server,
    client,
    stop(): void {
      server.stop();
      store.close();
    },
  };
}

// ---------------------------------------------------------------------------
// T1 — factory.yaml validation + desired -> runtime resolution
// ---------------------------------------------------------------------------

describe('E2 factory.yaml validation + resolution', () => {
  it('parses the default desired config and round-trips the serialized form', () => {
    const parsed = parseFactoryConfig(serializeFactoryConfig(DEFAULT_FACTORY_CONFIG));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.apiVersion).toBe('factory/v0.1');
      expect(parsed.config.server.port).toBe(DEFAULT_FACTORY_CONFIG.server.port);
      expect(parsed.config.image.tag).not.toBe('latest');
      expect(parsed.config.storage.state).toBeTruthy();
    }
  });

  it('resolves desired config into absolute runtime paths, a db path, a url, and a pinned image ref', () => {
    const runtime = resolveFactoryConfig(DEFAULT_FACTORY_CONFIG, { baseDir: workDir });
    expect(runtime.paths.state.startsWith(workDir)).toBe(true);
    expect(runtime.paths.artifacts.startsWith(workDir)).toBe(true);
    expect(runtime.paths.knowledge.startsWith(workDir)).toBe(true);
    expect(runtime.paths.db).toBe(join(runtime.paths.state, 'factory.db'));
    expect(runtime.server.url).toBe(`http://${runtime.server.hostname}:${runtime.server.port}`);
    expect(runtime.image.ref).toBe(
      `${DEFAULT_FACTORY_CONFIG.image.repository}:${DEFAULT_FACTORY_CONFIG.image.tag}`,
    );
    expect(runtime.image.ref.endsWith(':latest')).toBe(false);
    expect(runtime.schemaVersion).toBe('1');
  });

  it('rejects malformed desired config with a path-carrying issue (not a throw)', () => {
    const cases: Array<{ text: string; path: string }> = [
      { text: 'server:\n  port: 8787\n', path: 'apiVersion' },
      { text: 'apiVersion: factory/v0.1\nfactoryVersion: 0.1.0\n', path: 'server' },
      {
        text: serializeFactoryConfig({
          ...DEFAULT_FACTORY_CONFIG,
          server: { hostname: '127.0.0.1', port: 0 },
        }),
        path: 'server.port',
      },
      {
        text: serializeFactoryConfig({
          ...DEFAULT_FACTORY_CONFIG,
          image: { repository: 'ghcr.io/coderhd/factory', tag: 'latest' },
        }),
        path: 'image.tag',
      },
      {
        text: serializeFactoryConfig({
          ...DEFAULT_FACTORY_CONFIG,
          storage: { state: '', artifacts: '.factory/artifacts', knowledge: '.factory/knowledge' },
        }),
        path: 'storage.state',
      },
    ];
    for (const testCase of cases) {
      const parsed = parseFactoryConfig(testCase.text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues.map((issue) => issue.path)).toContain(testCase.path);
      }
    }

    // Non-mapping YAML is rejected, not thrown.
    expect(parseFactoryConfig('- just\n- a list\n').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T2 — compose.yaml structure (no Docker daemon)
// ---------------------------------------------------------------------------

const COMPOSE_TEXT = readFileSync(join(import.meta.dir, '..', '..', 'compose.yaml'), 'utf8');

describe('E2 compose.yaml structure', () => {
  it('accepts the checked-in compose.yaml and declares the three persistent volumes + healthcheck', () => {
    const result = validateCompose(COMPOSE_TEXT);
    expect(result.ok).toBe(true);
    expect(COMPOSE_TEXT).toContain('factory-state');
    expect(COMPOSE_TEXT).toContain('factory-artifacts');
    expect(COMPOSE_TEXT).toContain('factory-knowledge');
    expect(COMPOSE_TEXT).toMatch(/image:\s*\S+:\d/);
    expect(COMPOSE_TEXT).not.toMatch(/image:\s*\S+:latest/);
    expect(COMPOSE_TEXT).toContain('healthcheck');
  });

  it('rejects a `latest` image tag, a missing healthcheck, and an undeclared volume', () => {
    const latest = validateCompose(
      [
        'services:',
        '  factory:',
        '    image: ghcr.io/coderhd/factory:latest',
        '    volumes:',
        '      - factory-state:/var/lib/factory/state',
        '    healthcheck:',
        '      test: ["CMD", "true"]',
        'volumes:',
        '  factory-state:',
      ].join('\n'),
    );
    expect(latest.ok).toBe(false);
    if (!latest.ok) expect(latest.issues.map((i) => i.path)).toContain('services.factory.image');

    const healthy = validateCompose(
      [
        'services:',
        '  factory:',
        '    image: ghcr.io/coderhd/factory:0.1.0',
        '    volumes:',
        '      - factory-state:/var/lib/factory/state',
      ].join('\n'),
    );
    expect(healthy.ok).toBe(false);
    if (!healthy.ok) expect(healthy.issues.map((i) => i.path)).toContain('services.factory.healthcheck');

    const undeclared = validateCompose(
      [
        'services:',
        '  factory:',
        '    image: ghcr.io/coderhd/factory:0.1.0',
        '    volumes:',
        '      - factory-state:/var/lib/factory/state',
        '    healthcheck:',
        '      test: ["CMD", "true"]',
      ].join('\n'),
    );
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.issues.some((i) => i.message.includes('factory-state'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — API + client: submit -> DRAFT -> transitions (server sole authority)
// ---------------------------------------------------------------------------

describe('E2 API + client work-order lifecycle', () => {
  it('exposes handshake + health over the API', async () => {
    const h = apiHarness();
    try {
      const handshake = await h.client.handshake();
      expect(handshake.apiVersion).toBe('factory/api/v0.1');
      expect(handshake.version).toBe('0.1.0');
      expect(handshake.instanceId).toBeTruthy();
      expect(handshake.capabilities).toContain('work_orders');

      const health = await h.client.health();
      expect(health.status).toBe('ok');
      expect(health.schemaVersion).toBe('1');
    } finally {
      h.stop();
    }
  });

  it('creates a DRAFT Work Order through the API and reflects transitions in status', async () => {
    const h = apiHarness();
    try {
      const workOrder = await h.client.submitWorkOrder({
        intent: 'ship the slice',
        acceptanceCriteria: ['CLI submit creates a WO'],
        requiredVerification: ['tests'],
      });
      expect(workOrder.state).toBe('DRAFT');
      expect(workOrder.id.startsWith('wo_')).toBe(true);

      // The API wrote through the Factory-owned store + event log.
      expect(h.store.get<WorkOrder>('work_orders', workOrder.id)?.state).toBe('DRAFT');
      expect(h.events.readEvents().some((e) => e.type === 'work_order.created')).toBe(true);

      const advanced = await h.client.transitionWorkOrder(workOrder.id, { to: 'READY' });
      expect(advanced.state).toBe('READY');

      const snapshot = await h.client.getWorkOrder(workOrder.id);
      expect(snapshot.workOrder.state).toBe('READY');

      const listed = await h.client.listWorkOrders();
      expect(listed.map((wo) => wo.id)).toContain(workOrder.id);
    } finally {
      h.stop();
    }
  });

  it('is the sole authority: client-supplied state is ignored and illegal edges are rejected', async () => {
    const h = apiHarness();
    try {
      // A rogue payload that tries to set state/risk directly.
      const response = await fetch(`${h.server.url}/api/work-orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent: 'rogue', state: 'APPROVED', riskTier: 'GREEN' }),
      });
      const body = (await response.json()) as { workOrder: WorkOrder };
      expect(response.status).toBe(201);
      // Unknown/forbidden client fields are dropped; the Factory starts DRAFT/YELLOW.
      expect(body.workOrder.state).toBe('DRAFT');
      expect(body.workOrder.riskTier).toBe('YELLOW');

      // Illegal transition DRAFT -> APPROVED is a 409 (Factory edge rule).
      await expect(h.client.transitionWorkOrder(body.workOrder.id, { to: 'APPROVED' })).rejects.toMatchObject({
        status: 409,
        code: 'INVALID_TRANSITION',
      });
      expect(h.store.get<WorkOrder>('work_orders', body.workOrder.id)?.state).toBe('DRAFT');
    } finally {
      h.stop();
    }
  });

  it('only reaches Factory state over HTTP: a stopped server cannot be mutated', async () => {
    const h = apiHarness();
    try {
      const workOrder = await h.client.submitWorkOrder({ intent: 'http only' });

      h.server.stop();
      await expect(h.client.health()).rejects.toBeInstanceOf(Error);
      await expect(h.client.submitWorkOrder({ intent: 'too late' })).rejects.toBeInstanceOf(Error);

      // Nothing was written without the server: the client holds no store.
      expect(h.store.list<WorkOrder>('work_orders').map((wo) => wo.id)).toEqual([workOrder.id]);
    } finally {
      h.store.close();
    }
  });

  it('applies human-gate decisions as Factory-owned Work Order transitions', async () => {
    const h = apiHarness();
    try {
      const workOrder = await h.client.submitWorkOrder({ intent: 'gate me' });
      for (const to of [
        'READY',
        'PLANNING',
        'EXECUTING',
        'VERIFYING',
        'EVIDENCE_READY',
        'HUMAN_GATE',
      ] as const) {
        await h.client.transitionWorkOrder(workOrder.id, { to });
      }
      const approved = await h.client.applyGate(workOrder.id, 'APPROVE');
      expect(approved.state).toBe('APPROVED');

      const notAtGate = await h.client.submitWorkOrder({ intent: 'not at gate' });
      await expect(h.client.applyGate(notAtGate.id, 'APPROVE')).rejects.toMatchObject({ status: 409 });
    } finally {
      h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — WAITING_INPUT answer -> resume through E3 transitions
// ---------------------------------------------------------------------------

interface SchedulerHarness {
  store: StateStore;
  events: ReturnType<typeof openEventLog>;
  adapters: FakeHerdr[];
  /** Adapters keyed by the worker id they were provisioned for. */
  adapterByWorker: Map<string, FakeHerdr>;
  scheduler: ReturnType<typeof createScheduler>;
  server: ReturnType<typeof startFactoryServer>;
  client: ReturnType<typeof createFactoryClient>;
  stop(): void;
}

function schedulerHarness(config: { tickIntervalMs?: number } = {}): SchedulerHarness {
  const store = openStateStore(join(workDir, 'factory.db'));
  const events = openEventLog(store.db);
  const adapters: FakeHerdr[] = [];
  const adapterByWorker = new Map<string, FakeHerdr>();
  const baseWorkers = createWorkerManager({
    store,
    events,
    spawn: () => {
      const adapter = new FakeHerdr();
      adapters.push(adapter);
      return adapter;
    },
  });
  const workers: ReturnType<typeof createWorkerManager> = {
    ...baseWorkers,
    provisionWorker: (profile) => {
      const worker = baseWorkers.provisionWorker(profile);
      adapterByWorker.set(worker.id, adapters[adapters.length - 1]!);
      return worker;
    },
  };
  const repoPath = initRepo(workDir);
  const worktrees = createWorktreeManager({
    rootDir: join(workDir, 'worktrees'),
    baseBranch: 'main',
  });
  const scheduler = createScheduler(
    { store, events, workers, worktrees, repoPath, policy: { canAssign: () => 'ALLOW' } },
    config,
  );
  const server = startFactoryServer(
    { store, events, evidence: new FakeEvidence(), scheduler, version: '0.1.0', schemaVersion: '1' },
    { port: 0, hostname: '127.0.0.1' },
  );
  const client = createFactoryClient({ baseUrl: server.url });
  return {
    store,
    events,
    adapters,
    adapterByWorker,
    scheduler,
    server,
    client,
    stop(): void {
      scheduler.stop();
      server.stop();
      store.close();
    },
  };
}

/** The adapter provisioned for the worker currently holding `taskId`. */
function adapterForTask(h: SchedulerHarness, taskId: string): FakeHerdr {
  const open = h.store
    .list<{ taskId: string; workerId: string; closedAt: string | null }>('assignments')
    .find((assignment) => assignment.taskId === taskId && assignment.closedAt === null);
  if (open) {
    const adapter = h.adapterByWorker.get(open.workerId);
    if (adapter) return adapter;
  }
  return h.adapters.find((adapter) => adapter.envelope?.taskId === taskId)!;
}

describe('E2 WAITING_INPUT answer/resume', () => {
  it('answers a QUESTION, persists the response and resumes the Task from WAITING_INPUT', async () => {
    const h = schedulerHarness();
    try {
      // Drive a task to RUNNING through the E3 scheduler, then have it ask.
      const wo = createWorkOrder({ store: h.store, events: h.events }, { intent: 'answer loop' });
      transitionWorkOrder({ store: h.store, events: h.events }, wo.id, { to: 'READY' });
      transitionWorkOrder({ store: h.store, events: h.events }, wo.id, { to: 'PLANNING' });
      const dag = commitDAG({ store: h.store, events: h.events }, wo.id, {
        nodes: [{ nodeId: 'a', title: 'A' }],
      });
      transitionWorkOrder({ store: h.store, events: h.events }, wo.id, { to: 'EXECUTING' });

      const taskId = dag.nodes[0].taskId;
      h.scheduler.tick();
      const adapter = adapterForTask(h, taskId);
      adapter.result = waitingResult('which base branch?');
      await settle();
      h.scheduler.tick();
      await settle();

      expect(h.store.get<Task>('tasks', taskId)?.state).toBe('WAITING_INPUT');

      const pending = await h.client.listInteractions('PENDING');
      expect(pending).toHaveLength(1);
      expect(pending[0].question).toBe('which base branch?');
      expect(pending[0].taskId).toBe(taskId);

      const answered = await h.client.answerInteraction(pending[0].id, 'use main');
      expect(answered.interaction.status).toBe('ANSWERED');
      expect(answered.interaction.response).toBe('use main');
      expect(answered.task.state).toBe('RUNNING');
      expect(
        h.events.readEvents().some((e) => e.type === 'interaction.answered'),
      ).toBe(true);

      // Answering the same interaction twice is a conflict.
      await expect(h.client.answerInteraction(pending[0].id, 'again')).rejects.toMatchObject({
        status: 409,
      });

      // The resumed Task is collected by E3 on the next ticks and can settle.
      adapter.result = completedResult();
      h.scheduler.tick(); // collectStep starts a poll for the resumed Task
      await settle();
      h.scheduler.tick(); // routeQueued settles the completion -> SUCCESS
      await settle();
      expect(h.store.get<Task>('tasks', taskId)?.state).toBe('SUCCESS');
    } finally {
      h.stop();
    }
  });

  it('rejects answering an unknown interaction with 404', async () => {
    const h = apiHarness();
    try {
      await expect(h.client.answerInteraction('interaction_missing', 'x')).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      h.stop();
    }
  });

  it('drives the loop from its own timer (start/stop), no manual ticks', async () => {
    const h = schedulerHarness({ tickIntervalMs: 5 });
    try {
      const wo = createWorkOrder({ store: h.store, events: h.events }, { intent: 'timer loop' });
      transitionWorkOrder({ store: h.store, events: h.events }, wo.id, { to: 'READY' });
      transitionWorkOrder({ store: h.store, events: h.events }, wo.id, { to: 'PLANNING' });
      const dag = commitDAG({ store: h.store, events: h.events }, wo.id, {
        nodes: [{ nodeId: 'a', title: 'A' }],
      });
      transitionWorkOrder({ store: h.store, events: h.events }, wo.id, { to: 'EXECUTING' });
      const taskId = dag.nodes[0].taskId;

      // No tick() calls: the started interval must drive unblock → provision → assign.
      h.scheduler.start();
      for (let i = 0; i < 200; i += 1) {
        if (h.store.get<Task>('tasks', taskId)?.state === 'RUNNING') break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }
      expect(h.store.get<Task>('tasks', taskId)?.state).toBe('RUNNING');
      expect(h.adapters.some((adapter) => adapter.envelope?.taskId === taskId)).toBe(true);
    } finally {
      h.stop();
    }
  });

  it('exposes the E3 scheduler status projection (config + loop state)', async () => {
    const h = schedulerHarness();
    try {
      const { scheduler } = await h.client.schedulerStatus();
      expect(scheduler.concurrency.max).toBe(3);
      expect(scheduler.provisioning.enabled).toBe(true);
      // The interval loop is not started for an in-process test scheduler.
      expect(scheduler.running).toBe(false);
      expect(scheduler.tickIntervalMs).toBe(1000);

      h.scheduler.start();
      const running = await h.client.schedulerStatus();
      expect(running.scheduler.running).toBe(true);
      h.scheduler.stop();
    } finally {
      h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// T5 — Observatory projections + drill-down (R2 evidence read seam)
// ---------------------------------------------------------------------------

const change = (overrides: Partial<VerifiedChange>): VerifiedChange => ({
  id: 'vc_1',
  workOrderId: 'wo_1',
  taskId: 'task_1',
  attemptId: 'attempt_1',
  verifiedAt: '2026-09-28T10:00:00.000Z',
  humanMinutes: 30,
  linesChanged: 100,
  model: 'generalist',
  workerId: 'worker_1',
  ...overrides,
});

describe('E2 Observatory projections', () => {
  it('projects verified changes per day and per human hour from the evidence port', () => {
    const port = new FakeEvidence();
    port.changes = [
      change({ id: 'c1', verifiedAt: '2026-09-28T10:00:00.000Z', humanMinutes: 30, linesChanged: 100 }),
      change({ id: 'c2', verifiedAt: '2026-09-28T12:00:00.000Z', humanMinutes: 30, linesChanged: 50 }),
      change({ id: 'c3', verifiedAt: '2026-09-29T09:00:00.000Z', humanMinutes: 60, linesChanged: 200 }),
    ];

    const projection = projectObservatory(port);
    expect(projection.verifiedPerDay).toEqual([
      { day: '2026-09-28', verifiedChanges: 2, linesChanged: 150 },
      { day: '2026-09-29', verifiedChanges: 1, linesChanged: 200 },
    ]);
    expect(projection.throughputPerHumanHour).toEqual({
      verifiedChanges: 3,
      humanHours: 2,
      verifiedChangesPerHumanHour: 1.5,
    });

    // A date window narrows the projection.
    const windowed = projectObservatory(port, { from: '2026-09-29' });
    expect(windowed.verifiedPerDay).toEqual([
      { day: '2026-09-29', verifiedChanges: 1, linesChanged: 200 },
    ]);
  });

  it('serves Observatory + drill-down over the API', async () => {
    const evidence = new FakeEvidence();
    evidence.changes = [change({})];
    const h = apiHarness({ evidence });
    try {
      const wo = await h.client.submitWorkOrder({ intent: 'observable' });
      const observatory = await h.client.observatory();
      expect(observatory.verifiedPerDay).toHaveLength(1);
      expect(observatory.throughputPerHumanHour.verifiedChanges).toBe(1);

      const drillDown = await h.client.drillDown(wo.id);
      expect(drillDown.workOrderId).toBe(wo.id);
      const stages = drillDown.chain.map((step) => step.stage);
      expect(stages).toContain('work_order');
      expect(stages).toContain('task');
      expect(stages).toContain('attempt');

      // The drill-down is served from the stub port; the E5 stages stay stubs.
      const byStage = new Map(drillDown.chain.map((step) => [step.stage, step]));
      expect(byStage.get('trace')?.status).toBe('stub');
      expect(byStage.get('evidence')?.status).toBe('stub');

      // An unknown Work Order has no drill-down (404, not an empty chain).
      await expect(h.client.drillDown('wo_missing')).rejects.toMatchObject({ status: 404 });
    } finally {
      h.stop();
    }
  });

  it('projects the full spec §23 drill-down chain with E5/E8 stages marked stub', () => {
    const store = openStateStore(join(workDir, 'factory.db'));
    try {
      const events = openEventLog(store.db);
      const wo = createWorkOrder({ store, events }, { intent: 'drill' });
      const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
      const attempt = createAttempt(
        { store, events },
        { taskId: task.id, model: 'generalist', workerId: null },
      );
      const port = new FakeEvidence();
      port.changes = [change({ workOrderId: wo.id, taskId: task.id, attemptId: attempt.id })];
      store.set('interactions', 'interaction_1', {
        id: 'interaction_1',
        taskId: task.id,
        status: 'PENDING',
      });

      const drillDown = projectDrillDown(port, store, wo.id);
      expect(drillDown).not.toBeNull();
      // Spec §23 order: WO → Task → Attempt → trace → verification → evidence → decision.
      expect(drillDown!.chain.map((step) => step.stage)).toEqual([
        'work_order',
        'task',
        'attempt',
        'trace',
        'verification',
        'evidence',
        'human_decision',
      ]);
      const byStage = new Map(drillDown!.chain.map((step) => [step.stage, step]));
      expect(byStage.get('work_order')?.refs).toEqual([wo.id]);
      expect(byStage.get('task')?.refs).toEqual([task.id]);
      expect(byStage.get('attempt')?.refs).toEqual([attempt.id]);
      expect(byStage.get('human_decision')?.refs).toEqual(['interaction_1']);
      // Verification is Factory-owned and resolves once changes exist; trace and
      // evidence are E8/E5-owned, so they stay honest stubs (never fabricated).
      expect(byStage.get('verification')?.status).toBe('available');
      expect(byStage.get('trace')?.status).toBe('stub');
      expect(byStage.get('evidence')?.status).toBe('stub');
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T6 — backup -> restore (state + artifacts + knowledge + config + versions)
// ---------------------------------------------------------------------------

/** Build a valid backup archive from a self-contained state dir under `base`. */
function makeBackupArchive(outFile: string, base: string): void {
  const runtime = resolveFactoryConfig(DEFAULT_FACTORY_CONFIG, { baseDir: base });
  mkdirSync(runtime.paths.state, { recursive: true });
  mkdirSync(runtime.paths.artifacts, { recursive: true });
  mkdirSync(runtime.paths.knowledge, { recursive: true });
  const store = openStateStore(runtime.paths.db);
  const events = openEventLog(store.db);
  createWorkOrder({ store, events }, { intent: 'guard me' });
  store.close();
  writeFileSync(join(runtime.paths.knowledge, 'notes.md'), '# knowledge\n');
  createBackup({
    stateDbPath: runtime.paths.db,
    artifactsDir: runtime.paths.artifacts,
    knowledgeDir: runtime.paths.knowledge,
    configText: serializeFactoryConfig(DEFAULT_FACTORY_CONFIG),
    outFile,
    factoryVersion: runtime.factoryVersion,
    schemaVersion: runtime.schemaVersion,
  });
}

describe('E2 backup/restore', () => {
  it('round-trips state, artifacts, knowledge, config and versions onto a fresh directory', () => {
    const runtime = resolveFactoryConfig(DEFAULT_FACTORY_CONFIG, { baseDir: workDir });
    mkdirSync(runtime.paths.state, { recursive: true });
    mkdirSync(runtime.paths.artifacts, { recursive: true });
    mkdirSync(runtime.paths.knowledge, { recursive: true });

    const store = openStateStore(runtime.paths.db);
    const events = openEventLog(store.db);
    const wo = createWorkOrder({ store, events }, { intent: 'backup me' });
    const artifacts = createArtifactStore(runtime.paths.artifacts);
    artifacts.put('attempt_1/verification.log', 'all green');
    writeFileSync(join(runtime.paths.knowledge, 'notes.md'), '# knowledge\n');
    const configText = serializeFactoryConfig(DEFAULT_FACTORY_CONFIG);
    store.close();

    const archive = join(workDir, 'backup.tar.gz');
    const manifest = createBackup({
      stateDbPath: runtime.paths.db,
      artifactsDir: runtime.paths.artifacts,
      knowledgeDir: runtime.paths.knowledge,
      configText,
      outFile: archive,
      factoryVersion: runtime.factoryVersion,
      schemaVersion: runtime.schemaVersion,
    });
    expect(existsSync(archive)).toBe(true);
    expect(manifest.format).toBe('factory-backup/v1');
    expect(manifest.factoryVersion).toBe(DEFAULT_FACTORY_CONFIG.factoryVersion);
    expect(manifest.schemaVersion).toBe('1');
    expect(manifest.entries).toContain('state/factory.db');
    expect(manifest.entries).toContain('config/factory.yaml');
    expect(manifest.entries.some((entry) => entry.startsWith('artifacts/'))).toBe(true);
    expect(manifest.entries.some((entry) => entry.startsWith('knowledge/'))).toBe(true);

    const restored = restoreBackup({ archive, intoDir: join(workDir, 'fresh') });
    expect(restored.manifest.factoryVersion).toBe(DEFAULT_FACTORY_CONFIG.factoryVersion);
    expect(restored.configText).toBe(configText);

    // State restored and readable.
    const restoredStore = openStateStore(restored.stateDbPath);
    try {
      expect(restoredStore.get<WorkOrder>('work_orders', wo.id)?.intent).toBe('backup me');
      expect(
        openEventLog(restoredStore.db).readEvents().some((e) => e.type === 'work_order.created'),
      ).toBe(true);
    } finally {
      restoredStore.close();
    }

    // Artifacts + knowledge restored byte-for-byte.
    expect(readFileSync(join(restored.artifactsDir, 'attempt_1/verification.log'), 'utf8')).toBe(
      'all green',
    );
    expect(readFileSync(join(restored.knowledgeDir, 'notes.md'), 'utf8')).toBe('# knowledge\n');

    // The restore materializes a *bootable* deployment: factory.yaml at the
    // target root + state/artifacts/knowledge under the configured paths.
    expect(existsSync(join(restored.intoDir, 'factory.yaml'))).toBe(true);
    expect(restored.stateDbPath).toBe(join(restored.intoDir, '.factory', 'state', 'factory.db'));
    expect(restored.artifactsDir).toBe(join(restored.intoDir, '.factory', 'artifacts'));
    expect(restored.knowledgeDir).toBe(join(restored.intoDir, '.factory', 'knowledge'));
    expect(readFileSync(join(restored.intoDir, 'factory.yaml'), 'utf8')).toBe(configText);
  });

  it('fails loudly when the archive does not exist', () => {
    expect(() => restoreBackup({ archive: join(workDir, 'nope.tar.gz'), intoDir: workDir })).toThrow();
  });

  it('refuses to restore into a non-empty directory without --force', () => {
    const archive = join(workDir, 'guard.tar.gz');
    makeBackupArchive(archive, join(workDir, 'guard-src'));

    const occupied = join(workDir, 'occupied');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'keep.txt'), 'do not clobber');

    expect(() => restoreBackup({ archive, intoDir: occupied })).toThrow(/not empty/);
    // Nothing was extracted over the existing files.
    expect(readdirSync(occupied)).toEqual(['keep.txt']);
    expect(existsSync(join(occupied, 'manifest.json'))).toBe(false);
    expect(existsSync(join(occupied, '.factory', 'state', 'factory.db'))).toBe(false);
  });

  it('restores into a non-empty directory when --force is given', () => {
    const archive = join(workDir, 'force.tar.gz');
    makeBackupArchive(archive, join(workDir, 'force-src'));

    const occupied = join(workDir, 'force-occupied');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'keep.txt'), 'stays');

    const restored = restoreBackup({ archive, intoDir: occupied, force: true });
    expect(existsSync(restored.stateDbPath)).toBe(true);
    expect(existsSync(join(occupied, 'factory.yaml'))).toBe(true);
    expect(existsSync(join(occupied, 'keep.txt'))).toBe(true);
  });

  it('rejects a wrong-format archive without writing anything', () => {
    const staging = join(workDir, 'wrong-format-src');
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      join(staging, 'manifest.json'),
      JSON.stringify({ format: 'not-a-factory-backup', entries: ['manifest.json'] }),
    );
    const archive = join(workDir, 'wrong-format.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', staging, '.']);

    const into = join(workDir, 'wrong-format-out');
    expect(() => restoreBackup({ archive, intoDir: into })).toThrow(/unsupported backup format/);
    expect(existsSync(into)).toBe(false);
  });

  it('rejects a manifest missing required entries without writing anything', () => {
    const staging = join(workDir, 'missing-entry-src');
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      join(staging, 'manifest.json'),
      JSON.stringify({ format: 'factory-backup/v1', entries: ['manifest.json'] }),
    );
    const archive = join(workDir, 'missing-entry.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', staging, '.']);

    const into = join(workDir, 'missing-entry-out');
    expect(() => restoreBackup({ archive, intoDir: into })).toThrow(/missing required entry/);
    expect(existsSync(into)).toBe(false);
  });

  it('rejects a corrupt archive without writing anything', () => {
    const archive = join(workDir, 'corrupt.tar.gz');
    writeFileSync(archive, 'not a real tarball');

    const into = join(workDir, 'corrupt-out');
    expect(() => restoreBackup({ archive, intoDir: into })).toThrow(/unreadable or corrupt/);
    expect(existsSync(into)).toBe(false);
  });

  it('refuses to create a backup when the state database is missing', () => {
    const outFile = join(workDir, 'no-state.tar.gz');
    expect(() =>
      createBackup({
        stateDbPath: join(workDir, 'missing-state', 'factory.db'),
        artifactsDir: join(workDir, 'no-artifacts'),
        knowledgeDir: join(workDir, 'no-knowledge'),
        configText: serializeFactoryConfig(DEFAULT_FACTORY_CONFIG),
        outFile,
        factoryVersion: DEFAULT_FACTORY_CONFIG.factoryVersion,
        schemaVersion: '1',
      }),
    ).toThrow(/state database not found/);
    expect(existsSync(outFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T7 — CLI: init, wo submit/status/answer, backup/restore, lifecycle
// ---------------------------------------------------------------------------

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

describe('E2 CLI', () => {
  it('init writes a valid factory.yaml and status reports a stopped server', async () => {
    const dir = join(workDir, 'deploy');
    mkdirSync(dir, { recursive: true });
    const cap = capture(dir);

    const initCode = await runCli(['init', '--dir', dir], cap.io);
    expect(initCode).toBe(0);
    const configPath = join(dir, 'factory.yaml');
    expect(existsSync(configPath)).toBe(true);
    expect(parseFactoryConfig(readFileSync(configPath, 'utf8')).ok).toBe(true);

    const statusCap = capture(dir);
    const statusCode = await runCli(['status', '--dir', dir], statusCap.io);
    expect(statusCode).toBe(0);
    expect((JSON.parse(statusCap.out()) as { status: string }).status).toBe('stopped');
  });

  it('submit/status/answer go through the API client (CLI never touches the store)', async () => {
    const h = apiHarness();
    try {
      const cap = capture(workDir);
      const submitCode = await runCli(
        ['wo', 'submit', '--url', h.server.url, '--intent', 'via cli', '--acceptance', 'works'],
        cap.io,
      );
      expect(submitCode).toBe(0);
      const submitted = JSON.parse(cap.out()) as WorkOrder;
      expect(submitted.state).toBe('DRAFT');

      const statusCap = capture(workDir);
      const statusCode = await runCli(['wo', 'status', submitted.id, '--url', h.server.url], statusCap.io);
      expect(statusCode).toBe(0);
      const status = JSON.parse(statusCap.out()) as { workOrder: WorkOrder };
      expect(status.workOrder.id).toBe(submitted.id);
      expect(status.workOrder.state).toBe('DRAFT');

      // The CLI created the WO through the API, which wrote Factory state.
      expect(h.store.get<WorkOrder>('work_orders', submitted.id)?.intent).toBe('via cli');
    } finally {
      h.stop();
    }
  });

  it('backup and restore go through the CLI', async () => {
    const dir = join(workDir, 'deploy');
    mkdirSync(dir, { recursive: true });
    expect(await runCli(['init', '--dir', dir], capture(dir).io)).toBe(0);

    const runtime = resolveFactoryConfig(DEFAULT_FACTORY_CONFIG, { baseDir: dir });
    mkdirSync(runtime.paths.state, { recursive: true });
    const store = openStateStore(runtime.paths.db);
    const events = openEventLog(store.db);
    const wo = createWorkOrder({ store, events }, { intent: 'cli backup' });
    store.close();

    const archive = join(workDir, 'cli-backup.tar.gz');
    const backupCode = await runCli(['backup', '--dir', dir, '--out', archive], capture(dir).io);
    expect(backupCode).toBe(0);
    expect(existsSync(archive)).toBe(true);

    const into = join(workDir, 'cli-fresh');
    const restoreCode = await runCli(['restore', archive, '--into', into], capture(dir).io);
    expect(restoreCode).toBe(0);
    const restoredStore = openStateStore(join(into, '.factory', 'state', 'factory.db'));
    try {
      expect(restoredStore.get<WorkOrder>('work_orders', wo.id)?.intent).toBe('cli backup');
    } finally {
      restoredStore.close();
    }
  });

  it('restore refuses a non-empty target unless --force is passed', async () => {
    const dir = join(workDir, 'restore-force');
    mkdirSync(dir, { recursive: true });
    expect(await runCli(['init', '--dir', dir], capture(dir).io)).toBe(0);
    const runtime = resolveFactoryConfig(DEFAULT_FACTORY_CONFIG, { baseDir: dir });
    mkdirSync(runtime.paths.state, { recursive: true });
    openStateStore(runtime.paths.db).close();

    const archive = join(workDir, 'restore-force.tar.gz');
    expect(await runCli(['backup', '--dir', dir, '--out', archive], capture(dir).io)).toBe(0);

    const into = join(workDir, 'restore-force-out');
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, 'keep.txt'), 'keep');

    const refused = capture(dir);
    expect(await runCli(['restore', archive, '--into', into], refused.io)).toBe(1);
    expect(refused.err()).toMatch(/not empty/);
    expect(readdirSync(into)).toEqual(['keep.txt']);

    const forced = capture(dir);
    expect(await runCli(['restore', archive, '--into', into, '--force'], forced.io)).toBe(0);
    expect(existsSync(join(into, '.factory', 'state', 'factory.db'))).toBe(true);
    expect(existsSync(join(into, 'factory.yaml'))).toBe(true);
    expect(existsSync(join(into, 'keep.txt'))).toBe(true);
  });

  it('restores onto a fresh dir and boots a clean server that reads the restored state', async () => {
    const src = join(workDir, 'boot-src');
    mkdirSync(src, { recursive: true });
    expect(await runCli(['init', '--dir', src], capture(src).io)).toBe(0);

    const runtime = resolveFactoryConfig(DEFAULT_FACTORY_CONFIG, { baseDir: src });
    mkdirSync(runtime.paths.state, { recursive: true });
    const store = openStateStore(runtime.paths.db);
    const events = openEventLog(store.db);
    const wo = createWorkOrder({ store, events }, { intent: 'survives restore' });
    createArtifactStore(runtime.paths.artifacts).put('attempt_1/verification.log', 'all green');
    writeFileSync(join(runtime.paths.knowledge, 'notes.md'), '# knowledge\n');
    store.close();

    const archive = join(workDir, 'boot-backup.tar.gz');
    expect(await runCli(['backup', '--dir', src, '--out', archive], capture(src).io)).toBe(0);

    const fresh = join(workDir, 'boot-fresh');
    expect(await runCli(['restore', archive, '--into', fresh], capture(fresh).io)).toBe(0);
    // Fresh machine layout: a bootable factory.yaml + .factory storage.
    expect(existsSync(join(fresh, 'factory.yaml'))).toBe(true);
    expect(existsSync(join(fresh, '.factory', 'state', 'factory.db'))).toBe(true);

    const startCap = capture(fresh);
    expect(await runCli(['start', '--dir', fresh, '--detached', '--port', '0'], startCap.io)).toBe(0);
    try {
      const client = createFactoryClient({ baseUrl: startCap.out().trim() });
      const health = await client.health();
      expect(health.status).toBe('ok');
      // The restored instance's server reads the restored Work Order.
      const snapshot = await client.getWorkOrder(wo.id);
      expect(snapshot.workOrder.intent).toBe('survives restore');
      // State + evidence/artifacts + knowledge all booted from the fresh dir.
      expect(readFileSync(join(fresh, '.factory', 'artifacts', 'attempt_1', 'verification.log'), 'utf8')).toBe(
        'all green',
      );
      expect(readFileSync(join(fresh, '.factory', 'knowledge', 'notes.md'), 'utf8')).toBe(
        '# knowledge\n',
      );
    } finally {
      // Safety net: never leak a detached server if an assertion fails.
      await runCli(['stop', '--dir', fresh], capture(fresh).io);
    }
  });

  it('answers a QUESTION through CLI `wo answer` and resumes the Task', async () => {
    const h = schedulerHarness();
    try {
      const wo = createWorkOrder({ store: h.store, events: h.events }, { intent: 'cli answer' });
      transitionWorkOrder({ store: h.store, events: h.events }, wo.id, { to: 'READY' });
      transitionWorkOrder({ store: h.store, events: h.events }, wo.id, { to: 'PLANNING' });
      const dag = commitDAG({ store: h.store, events: h.events }, wo.id, {
        nodes: [{ nodeId: 'a', title: 'A' }],
      });
      transitionWorkOrder({ store: h.store, events: h.events }, wo.id, { to: 'EXECUTING' });
      const taskId = dag.nodes[0].taskId;
      h.scheduler.tick();
      const adapter = adapterForTask(h, taskId);
      adapter.result = waitingResult('which base branch?');
      await settle();
      h.scheduler.tick();
      await settle();
      const pending = await h.client.listInteractions('PENDING');
      expect(pending).toHaveLength(1);

      const cap = capture(workDir);
      const code = await runCli(
        ['wo', 'answer', pending[0].id, 'use main', '--url', h.server.url],
        cap.io,
      );
      expect(code).toBe(0);
      const answered = JSON.parse(cap.out()) as {
        interaction: { status: string; response: string };
        task: { state: string };
      };
      expect(answered.interaction.status).toBe('ANSWERED');
      expect(answered.interaction.response).toBe('use main');
      expect(answered.task.state).toBe('RUNNING');
      expect(h.store.get<Task>('tasks', taskId)?.state).toBe('RUNNING');

      // The CLI surfaces a server error and exits non-zero (no shell mutation).
      const bad = capture(workDir);
      expect(await runCli(['wo', 'answer', 'interaction_missing', 'x', '--url', h.server.url], bad.io)).toBe(1);
      expect(bad.err()).toMatch(/interaction not found/);
    } finally {
      h.stop();
    }
  });

  it('applies the resolved scheduler config from factory.yaml to the running server', async () => {
    const dir = join(workDir, 'scheduler-config');
    mkdirSync(dir, { recursive: true });
    expect(await runCli(['init', '--dir', dir], capture(dir).io)).toBe(0);

    // Edit the desired config; the serve path must resolve it into the scheduler.
    const text = readFileSync(join(dir, 'factory.yaml'), 'utf8')
      .replace('maxConcurrentTasks: 3', 'maxConcurrentTasks: 7')
      .replace('tickIntervalMs: 1000', 'tickIntervalMs: 250');
    writeFileSync(join(dir, 'factory.yaml'), text);

    const startCap = capture(dir);
    expect(await runCli(['start', '--dir', dir, '--detached', '--port', '0'], startCap.io)).toBe(0);
    try {
      const client = createFactoryClient({ baseUrl: startCap.out().trim() });
      const { scheduler } = await client.schedulerStatus();
      expect(scheduler.concurrency.max).toBe(7);
      expect(scheduler.tickIntervalMs).toBe(250);
      // The serve path started the tick loop itself (no manual tick).
      expect(scheduler.running).toBe(true);
    } finally {
      await runCli(['stop', '--dir', dir], capture(dir).io);
    }
  });

  it('refuses a detached start when runtime.json points at a live process', async () => {
    const dir = join(workDir, 'busy');
    mkdirSync(join(dir, '.factory'), { recursive: true });
    expect(await runCli(['init', '--dir', dir], capture(dir).io)).toBe(0);
    writeFileSync(
      join(dir, '.factory', 'runtime.json'),
      `${JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:9', port: 9, dir, startedAt: new Date().toISOString() })}\n`,
    );

    const cap = capture(dir);
    expect(await runCli(['start', '--dir', dir, '--detached', '--port', '0'], cap.io)).toBe(1);
    expect(cap.err()).toMatch(/already running/);
  });

  it('clears a stale runtime.json before a detached start', async () => {
    const dir = join(workDir, 'stale');
    mkdirSync(join(dir, '.factory'), { recursive: true });
    expect(await runCli(['init', '--dir', dir], capture(dir).io)).toBe(0);
    writeFileSync(
      join(dir, '.factory', 'runtime.json'),
      `${JSON.stringify({ pid: 2147483646, url: 'http://127.0.0.1:1', port: 1, dir, startedAt: '2000-01-01T00:00:00.000Z' })}\n`,
    );

    const cap = capture(dir);
    try {
      expect(await runCli(['start', '--dir', dir, '--detached', '--port', '0'], cap.io)).toBe(0);
      // Not the stale URL: the stale file was cleared and the fresh child reported its own.
      expect(cap.out()).not.toContain('http://127.0.0.1:1');
      const info = JSON.parse(readFileSync(join(dir, '.factory', 'runtime.json'), 'utf8')) as {
        pid: number;
      };
      expect(info.pid).not.toBe(2147483646);
    } finally {
      // Safety net: never leak a detached server if an assertion fails.
      await runCli(['stop', '--dir', dir], capture(dir).io);
    }
  });

  it('update validates config and writes a mandatory pre-upgrade backup', async () => {
    const dir = join(workDir, 'update');
    mkdirSync(dir, { recursive: true });
    expect(await runCli(['init', '--dir', dir], capture(dir).io)).toBe(0);
    const runtime = resolveFactoryConfig(DEFAULT_FACTORY_CONFIG, { baseDir: dir });
    openStateStore(runtime.paths.db).close();

    const cap = capture(dir);
    expect(await runCli(['update', '--dir', dir], cap.io)).toBe(0);
    const update = JSON.parse(cap.out()) as { configValid: boolean; image: string; backup: string };
    expect(update.configValid).toBe(true);
    expect(update.image).toBe(runtime.image.ref);
    expect(existsSync(update.backup)).toBe(true);
  });

  it('starts a detached server, reports running, and stops it', async () => {
    const dir = join(workDir, 'lifecycle');
    mkdirSync(dir, { recursive: true });
    expect(await runCli(['init', '--dir', dir], capture(dir).io)).toBe(0);

    const startCode = await runCli(['start', '--dir', dir, '--detached', '--port', '0'], capture(dir).io);
    expect(startCode).toBe(0);

    try {
      // Poll until the detached server answers health (bounded).
      let status: { status: string; url?: string } | null = null;
      for (let i = 0; i < 50; i += 1) {
        const cap = capture(dir);
        await runCli(['status', '--dir', dir], cap.io);
        status = JSON.parse(cap.out()) as { status: string; url?: string };
        if (status.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(status?.status).toBe('running');

      expect(await runCli(['stop', '--dir', dir], capture(dir).io)).toBe(0);

      const stoppedCap = capture(dir);
      await runCli(['status', '--dir', dir], stoppedCap.io);
      expect((JSON.parse(stoppedCap.out()) as { status: string }).status).toBe('stopped');
    } finally {
      // Safety net: never leak a detached server if an assertion fails.
      await runCli(['stop', '--dir', dir], capture(dir).io);
    }
  });
});
