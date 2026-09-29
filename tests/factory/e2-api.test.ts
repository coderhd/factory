import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  scheduler: ReturnType<typeof createScheduler>;
  server: ReturnType<typeof startFactoryServer>;
  client: ReturnType<typeof createFactoryClient>;
  stop(): void;
}

function schedulerHarness(): SchedulerHarness {
  const store = openStateStore(join(workDir, 'factory.db'));
  const events = openEventLog(store.db);
  const adapters: FakeHerdr[] = [];
  const workers = createWorkerManager({
    store,
    events,
    spawn: () => {
      const adapter = new FakeHerdr();
      adapters.push(adapter);
      return adapter;
    },
  });
  const repoPath = initRepo(workDir);
  const worktrees = createWorktreeManager({
    rootDir: join(workDir, 'worktrees'),
    baseBranch: 'main',
  });
  const scheduler = createScheduler({ store, events, workers, worktrees, repoPath });
  const server = startFactoryServer(
    { store, events, evidence: new FakeEvidence(), scheduler, version: '0.1.0', schemaVersion: '1' },
    { port: 0, hostname: '127.0.0.1' },
  );
  const client = createFactoryClient({ baseUrl: server.url });
  return {
    store,
    events,
    adapters,
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
      const adapter = h.adapters.find((a) => a.envelope?.taskId === taskId)!;
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

  it('exposes the E3 scheduler status projection', async () => {
    const h = schedulerHarness();
    try {
      const { scheduler } = await h.client.schedulerStatus();
      expect(scheduler.concurrency.max).toBe(3);
      expect(scheduler.provisioning.enabled).toBe(true);
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
    } finally {
      h.stop();
    }
  });

  it('projects a Work Order -> Task -> Attempt drill-down chain (stub for E5 stages)', () => {
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

      const drillDown = projectDrillDown(port, store, wo.id);
      expect(drillDown).not.toBeNull();
      const byStage = new Map(drillDown!.chain.map((step) => [step.stage, step]));
      expect(byStage.get('work_order')?.refs).toEqual([wo.id]);
      expect(byStage.get('task')?.refs).toEqual([task.id]);
      expect(byStage.get('attempt')?.refs).toEqual([attempt.id]);
      // E5-owned stages are honest stubs today, not fabricated evidence.
      expect(byStage.get('evidence')?.status).toBe('stub');
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T6 — backup -> restore (state + artifacts + knowledge + config + versions)
// ---------------------------------------------------------------------------

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
    expect(existsSync(join(restored.intoDir, 'config', 'factory.yaml'))).toBe(true);
  });

  it('fails loudly when the archive does not exist', () => {
    expect(() => restoreBackup({ archive: join(workDir, 'nope.tar.gz'), intoDir: workDir })).toThrow();
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
    const restoredStore = openStateStore(join(into, 'state', 'factory.db'));
    try {
      expect(restoredStore.get<WorkOrder>('work_orders', wo.id)?.intent).toBe('cli backup');
    } finally {
      restoredStore.close();
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
