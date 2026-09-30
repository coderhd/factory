import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMessageBus } from '../../src/factory/bus/messageBus';
import { FactoryError } from '../../src/factory/domain/errors';
import {
  ATTEMPT_COMPLETED,
  ATTEMPT_CREATED,
  TASK_CREATED,
  TASK_STATES,
  TASK_TRANSITIONED,
  WORK_ORDER_CREATED,
  WORK_ORDER_STATES,
  WORK_ORDER_TRANSITIONED,
  completeAttempt,
  createAttempt,
  createTask,
  createWorkOrder,
  projectWorkOrder,
  projectState,
  transitionTask,
  transitionWorkOrder,
  type Attempt,
  type Task,
  type TaskState,
  type WorkOrder,
  type WorkOrderState,
} from '../../src/factory/domain/workOrder';
import { openEventLog, replayEvents, type EventLog } from '../../src/factory/events/log';
import {
  SCHEMA_TABLES,
  createArtifactStore,
  openStateStore,
} from '../../src/factory/state/store';

let workDir: string;
let dbPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'factory-e1-'));
  dbPath = join(workDir, 'factory.db');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('E1.1 SQLite schema + store seams', () => {
  it('creates all 13 §19 tables and enables WAL', () => {
    const store = openStateStore(dbPath);
    try {
      const mode = store.db.query('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(mode.journal_mode.toLowerCase()).toBe('wal');
      expect(SCHEMA_TABLES).toHaveLength(13);

      const names = (
        store.db
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      for (const table of SCHEMA_TABLES) {
        expect(names).toContain(table);
      }
    } finally {
      store.close();
    }
  });

  it('StateStore put/get round-trips and survives a reconnect', () => {
    const store = openStateStore(dbPath);
    const value = { id: 'wo_roundtrip', intent: 'ship the slice', meta: { n: 1 } };
    store.set('work_orders', value.id, value);
    expect(store.get('work_orders', value.id)).toEqual(value);
    expect(store.get('tasks', 'missing')).toBeNull();
    expect(store.list('work_orders')).toEqual([value]);
    store.close();

    const reopened = openStateStore(dbPath);
    try {
      expect(reopened.get('work_orders', value.id)).toEqual(value);
    } finally {
      reopened.close();
    }
  });

  it('ArtifactStore keeps large artifacts on disk, outside the database', () => {
    const artifacts = createArtifactStore(join(workDir, 'artifacts'));
    const marker = 'FACTORY_LARGE_ARTIFACT_MARKER_';
    const large = marker.repeat(20_000);

    const ref = artifacts.put('evidence/large.txt', large);

    expect(ref.size).toBe(Buffer.byteLength(large));
    expect(ref.sha256).toHaveLength(64);
    expect(ref.path.startsWith(join(workDir, 'artifacts'))).toBe(true);
    expect(existsSync(ref.path)).toBe(true);
    expect(Buffer.from(artifacts.get(ref)).toString('utf8')).toBe(large);

    // The authoritative SQLite state must not carry the artifact payload.
    const store = openStateStore(dbPath);
    try {
      expect(readFileSync(dbPath).includes(Buffer.from(marker))).toBe(false);
      const artifactCount = store.db
        .query('SELECT COUNT(*) AS count FROM artifacts')
        .get() as { count: number };
      expect(artifactCount.count).toBe(0);
    } finally {
      store.close();
    }
  });

  it('appends events with a strictly increasing seq and replays them in order', () => {
    const store = openStateStore(dbPath);
    const events = openEventLog(store.db);
    const seqA = events.appendEvent({
      type: 'work_order.created',
      aggregateType: 'work_order',
      aggregateId: 'wo_1',
    });
    const seqB = events.appendEvent({
      type: 'work_order.ready',
      aggregateType: 'work_order',
      aggregateId: 'wo_1',
    });
    const seqC = events.appendEvent({
      type: 'task.planned',
      aggregateType: 'task',
      aggregateId: 'task_1',
      payload: { title: 'first' },
    });

    expect(seqB).toBeGreaterThan(seqA);
    expect(seqC).toBeGreaterThan(seqB);

    const all = events.readEvents();
    expect(all.map((event) => event.seq)).toEqual([seqA, seqB, seqC]);
    expect(all.map((event) => event.type)).toEqual([
      'work_order.created',
      'work_order.ready',
      'task.planned',
    ]);
    expect(all[2].payload).toEqual({ title: 'first' });

    // The log is append-only: rows can be added, never mutated or removed.
    expect(() =>
      store.db.query("UPDATE events SET type = 'tampered' WHERE seq = ?").run(seqA),
    ).toThrow();
    expect(() => store.db.query('DELETE FROM events WHERE seq = ?').run(seqA)).toThrow();
    expect(events.count()).toBe(3);

    const replayed = replayEvents(
      all,
      (states, event) => [...states, event.type],
      [] as string[],
    );
    expect(replayed).toEqual(['work_order.created', 'work_order.ready', 'task.planned']);

    store.close();
  });
});

describe('E1.1 Work Order creation + in-process MessageBus', () => {
  it('exposes the full lifecycle state vocabulary for the E1.2 state machine', () => {
    const workOrderStates = [
      'DRAFT',
      'READY',
      'PLANNING',
      'EXECUTING',
      'WAITING_INPUT',
      'VERIFYING',
      'FAILED',
      'REWORK',
      'EVIDENCE_READY',
      'HUMAN_GATE',
      'REJECTED',
      'APPROVED',
      'MERGED',
    ];
    const taskStates = [
      'PLANNED',
      'READY',
      'ASSIGNED',
      'RUNNING',
      'WAITING_INPUT',
      'SUCCESS',
      'VERIFYING',
      'VERIFIED',
      'FAILED',
      'REWORK',
    ];
    for (const state of workOrderStates) expect(WORK_ORDER_STATES).toContain(state);
    for (const state of taskStates) expect(TASK_STATES).toContain(state);
  });

  it('creates a DRAFT Work Order, writes and reads it back (narrow slice demo)', () => {
    const store = openStateStore(dbPath);
    const events = openEventLog(store.db);
    let created: WorkOrder;
    try {
      created = createWorkOrder(
        { store, events },
        {
          intent: 'Ship E1.1',
          acceptanceCriteria: ['schema exists', 'put/get round-trips'],
          repository: 'coderhd/factory',
        },
      );

      expect(created.state).toBe('DRAFT');
      expect(created.riskTier).toBe('YELLOW');
      expect(created.id).toBeString();
      expect(created.acceptanceCriteria).toEqual(['schema exists', 'put/get round-trips']);

      // Persisted through the StateStore seam.
      expect(store.get<WorkOrder>('work_orders', created.id)).toEqual(created);

      // Creation is recorded as durable history.
      const recorded = events.readEvents({ aggregateId: created.id });
      expect(recorded).toHaveLength(1);
      expect(recorded[0].type).toBe(WORK_ORDER_CREATED);
      expect(recorded[0].aggregateType).toBe('work_order');
    } finally {
      store.close();
    }

    // Demo path: a fresh connection reads the Work Order back.
    const reopened = openStateStore(dbPath);
    try {
      const readBack = reopened.get<WorkOrder>('work_orders', created!.id);
      expect(readBack).not.toBeNull();
      expect(readBack?.state).toBe('DRAFT');
    } finally {
      reopened.close();
    }
  });

  it('delivers in-process messages to subscribers until they unsubscribe', () => {
    const bus = createMessageBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe<string>('work_order.created', (message) => {
      seen.push(message);
    });

    bus.publish('work_order.created', 'wo_1');
    bus.publish('unrelated.topic', 'ignored');
    unsubscribe();
    bus.publish('work_order.created', 'wo_2');

    expect(seen).toEqual(['wo_1']);
  });
});

describe('E1.1 referential integrity + atomic writes', () => {
  it('rejects child rows whose foreign key does not exist', () => {
    const store = openStateStore(dbPath);
    try {
      store.set('work_orders', 'wo_parent', { id: 'wo_parent', intent: 'parent' });
      store.set('workers', 'worker_1', { id: 'worker_1', name: 'worker one' });

      // Valid parent-then-child inserts succeed.
      store.set('tasks', 'task_a', { id: 'task_a', workOrderId: 'wo_parent' });
      store.set('tasks', 'task_b', { id: 'task_b', workOrderId: 'wo_parent' });
      store.set('attempts', 'attempt_1', {
        id: 'attempt_1',
        taskId: 'task_a',
        workerId: 'worker_1',
      });
      store.set('assignments', 'assignment_1', {
        id: 'assignment_1',
        taskId: 'task_a',
        workerId: 'worker_1',
      });
      store.set('task_dependencies', 'dep_1', {
        id: 'dep_1',
        taskId: 'task_a',
        dependsOnTaskId: 'task_b',
      });
      expect(store.get('tasks', 'task_a')).not.toBeNull();

      // Missing parent work order is rejected.
      expect(() =>
        store.set('tasks', 'task_orphan', { id: 'task_orphan', workOrderId: 'wo_missing' }),
      ).toThrow();

      // Missing task endpoints are rejected for attempts and DAG edges.
      expect(() =>
        store.set('attempts', 'attempt_orphan', { id: 'attempt_orphan', taskId: 'task_missing' }),
      ).toThrow();
      expect(() =>
        store.set('task_dependencies', 'dep_orphan', {
          id: 'dep_orphan',
          taskId: 'task_a',
          dependsOnTaskId: 'task_missing',
        }),
      ).toThrow();

      // Missing worker references are rejected.
      expect(() =>
        store.set('assignments', 'assignment_orphan', {
          id: 'assignment_orphan',
          taskId: 'task_a',
          workerId: 'worker_missing',
        }),
      ).toThrow();

      // A Worker referenced by durable Attempt history cannot be deleted.
      expect(() => store.delete('workers', 'worker_1')).toThrow();

      // ON DELETE CASCADE keeps no orphaned children behind.
      store.delete('work_orders', 'wo_parent');
      expect(store.list('tasks')).toHaveLength(0);
      expect(store.list('task_dependencies')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('rolls back Work Order creation when appending the event fails', () => {    const store = openStateStore(dbPath);
    const failingEvents: EventLog = {
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
    try {
      expect(() =>
        createWorkOrder({ store, events: failingEvents }, { intent: 'must not persist' }),
      ).toThrow('event log unavailable');
      expect(store.list<WorkOrder>('work_orders')).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

type E1Deps = { store: ReturnType<typeof openStateStore>; events: EventLog };

function openDeps(): E1Deps {
  const store = openStateStore(dbPath);
  return { store, events: openEventLog(store.db) };
}

function seedWorkOrder(deps: E1Deps): WorkOrder {
  return createWorkOrder(deps, { intent: 'lifecycle subject' });
}

function driveWorkOrder(deps: E1Deps, id: string, states: WorkOrderState[]): WorkOrder {
  let wo: WorkOrder | null = null;
  for (const to of states) wo = transitionWorkOrder(deps, id, { to });
  return wo!;
}

function seedTask(deps: E1Deps): Task {
  const wo = seedWorkOrder(deps);
  return createTask(deps, { workOrderId: wo.id, title: 'lifecycle task' });
}

function driveTask(deps: E1Deps, id: string, states: TaskState[]): Task {
  let task: Task | null = null;
  for (const to of states) task = transitionTask(deps, id, { to });
  return task!;
}

const byId = <T extends { id: string }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => a.id.localeCompare(b.id));

describe('E1.2 Factory-owned Work Order lifecycle', () => {
  it('walks the happy path DRAFT→READY→PLANNING→EXECUTING→VERIFYING→EVIDENCE_READY→HUMAN_GATE→APPROVED→MERGED', () => {
    const deps = openDeps();
    try {
      const wo = seedWorkOrder(deps);
      const path: WorkOrderState[] = [
        'READY',
        'PLANNING',
        'EXECUTING',
        'VERIFYING',
        'EVIDENCE_READY',
        'HUMAN_GATE',
        'APPROVED',
        'MERGED',
      ];

      let current = wo;
      for (const to of path) {
        current = transitionWorkOrder(deps, wo.id, { to });
        expect(current.state).toBe(to);
        expect(deps.store.get<WorkOrder>('work_orders', wo.id)?.state).toBe(to);
      }

      const transitions = deps.events
        .readEvents({ aggregateId: wo.id })
        .filter((event) => event.type === WORK_ORDER_TRANSITIONED);
      expect(transitions).toHaveLength(path.length);
    } finally {
      deps.store.close();
    }
  });

  it('supports EXECUTING↔WAITING_INPUT and WAITING_INPUT→VERIFYING', () => {
    const deps = openDeps();
    try {
      const wo = seedWorkOrder(deps);
      driveWorkOrder(deps, wo.id, ['READY', 'PLANNING', 'EXECUTING']);

      expect(transitionWorkOrder(deps, wo.id, { to: 'WAITING_INPUT' }).state).toBe('WAITING_INPUT');
      expect(transitionWorkOrder(deps, wo.id, { to: 'EXECUTING' }).state).toBe('EXECUTING');
      expect(transitionWorkOrder(deps, wo.id, { to: 'WAITING_INPUT' }).state).toBe('WAITING_INPUT');
      expect(transitionWorkOrder(deps, wo.id, { to: 'VERIFYING' }).state).toBe('VERIFYING');
    } finally {
      deps.store.close();
    }
  });

  it('supports VERIFYING→FAILED→REWORK→EXECUTING (re-execution)', () => {
    const deps = openDeps();
    try {
      const wo = seedWorkOrder(deps);
      driveWorkOrder(deps, wo.id, ['READY', 'PLANNING', 'EXECUTING', 'VERIFYING']);

      expect(transitionWorkOrder(deps, wo.id, { to: 'FAILED' }).state).toBe('FAILED');
      expect(transitionWorkOrder(deps, wo.id, { to: 'REWORK' }).state).toBe('REWORK');
      // Controller ruling R8: REWORK returns to EXECUTING for re-execution.
      expect(transitionWorkOrder(deps, wo.id, { to: 'EXECUTING' }).state).toBe('EXECUTING');
    } finally {
      deps.store.close();
    }
  });

  it('supports HUMAN_GATE→REWORK, →REJECTED and →APPROVED→MERGED', () => {
    for (const branch of ['REWORK', 'REJECTED', 'APPROVED'] as const) {
      const deps = openDeps();
      try {
        const wo = seedWorkOrder(deps);
        driveWorkOrder(deps, wo.id, [
          'READY',
          'PLANNING',
          'EXECUTING',
          'VERIFYING',
          'EVIDENCE_READY',
          'HUMAN_GATE',
        ]);
        expect(transitionWorkOrder(deps, wo.id, { to: branch }).state).toBe(branch);
        if (branch === 'APPROVED') {
          expect(transitionWorkOrder(deps, wo.id, { to: 'MERGED' }).state).toBe('MERGED');
        }
      } finally {
        deps.store.close();
      }
    }
  });

  it('rejects an illegal Work Order edge with a FactoryError and changes nothing', () => {
    const deps = openDeps();
    try {
      const wo = seedWorkOrder(deps);
      const eventCount = deps.events.count();

      expect(() => transitionWorkOrder(deps, wo.id, { to: 'MERGED' })).toThrow(FactoryError);
      expect(() => transitionWorkOrder(deps, wo.id, { to: 'DRAFT' })).toThrow(FactoryError);

      // Persisted state and the append-only log are untouched by a rejected edge.
      expect(deps.store.get<WorkOrder>('work_orders', wo.id)).toEqual(wo);
      expect(deps.events.count()).toBe(eventCount);

      let code: string | undefined;
      try {
        transitionWorkOrder(deps, wo.id, { to: 'PLANNING' });
      } catch (error) {
        code = (error as FactoryError).code;
      }
      expect(code).toBe('INVALID_TRANSITION');
    } finally {
      deps.store.close();
    }
  });

  it('rejects a terminal-state outgoing edge (MERGED→READY, REJECTED→APPROVED)', () => {
    const deps = openDeps();
    try {
      const merged = seedWorkOrder(deps);
      driveWorkOrder(deps, merged.id, [
        'READY',
        'PLANNING',
        'EXECUTING',
        'VERIFYING',
        'EVIDENCE_READY',
        'HUMAN_GATE',
        'APPROVED',
        'MERGED',
      ]);
      expect(() => transitionWorkOrder(deps, merged.id, { to: 'READY' })).toThrow(FactoryError);

      const rejected = seedWorkOrder(deps);
      driveWorkOrder(deps, rejected.id, [
        'READY',
        'PLANNING',
        'EXECUTING',
        'VERIFYING',
        'EVIDENCE_READY',
        'HUMAN_GATE',
        'REJECTED',
      ]);
      expect(() => transitionWorkOrder(deps, rejected.id, { to: 'APPROVED' })).toThrow(FactoryError);
    } finally {
      deps.store.close();
    }
  });

  it('rejects a transition on an unknown Work Order', () => {
    const deps = openDeps();
    try {
      let code: string | undefined;
      try {
        transitionWorkOrder(deps, 'wo_missing', { to: 'READY' });
      } catch (error) {
        code = (error as FactoryError).code;
      }
      expect(code).toBe('WORK_ORDER_NOT_FOUND');
    } finally {
      deps.store.close();
    }
  });
});

describe('E1.2 Factory-owned Task lifecycle', () => {
  it('walks PLANNED→READY→ASSIGNED→RUNNING→SUCCESS→VERIFYING→VERIFIED', () => {
    const deps = openDeps();
    try {
      const task = seedTask(deps);
      expect(task.state).toBe('PLANNED');

      const path: TaskState[] = ['READY', 'ASSIGNED', 'RUNNING', 'SUCCESS', 'VERIFYING', 'VERIFIED'];
      let current = task;
      for (const to of path) {
        current = transitionTask(deps, task.id, { to });
        expect(current.state).toBe(to);
        expect(deps.store.get<Task>('tasks', task.id)?.state).toBe(to);
      }

      const transitions = deps.events
        .readEvents({ aggregateId: task.id })
        .filter((event) => event.type === TASK_TRANSITIONED);
      expect(transitions).toHaveLength(path.length);
    } finally {
      deps.store.close();
    }
  });

  it('supports RUNNING↔WAITING_INPUT and FAILED→REWORK→RUNNING', () => {
    const deps = openDeps();
    try {
      const task = driveTask(deps, seedTask(deps).id, ['READY', 'ASSIGNED', 'RUNNING']);
      expect(transitionTask(deps, task.id, { to: 'WAITING_INPUT' }).state).toBe('WAITING_INPUT');
      expect(transitionTask(deps, task.id, { to: 'RUNNING' }).state).toBe('RUNNING');
      expect(transitionTask(deps, task.id, { to: 'SUCCESS' }).state).toBe('SUCCESS');
      expect(transitionTask(deps, task.id, { to: 'VERIFYING' }).state).toBe('VERIFYING');
      expect(transitionTask(deps, task.id, { to: 'FAILED' }).state).toBe('FAILED');
      expect(transitionTask(deps, task.id, { to: 'REWORK' }).state).toBe('REWORK');
      expect(transitionTask(deps, task.id, { to: 'RUNNING' }).state).toBe('RUNNING');
    } finally {
      deps.store.close();
    }
  });

  it('rejects an illegal Task edge with a FactoryError and changes nothing', () => {
    const deps = openDeps();
    try {
      const task = seedTask(deps);
      const eventCount = deps.events.count();

      expect(() => transitionTask(deps, task.id, { to: 'RUNNING' })).toThrow(FactoryError);
      expect(() => transitionTask(deps, task.id, { to: 'VERIFIED' })).toThrow(FactoryError);

      expect(deps.store.get<Task>('tasks', task.id)).toEqual(task);
      expect(deps.events.count()).toBe(eventCount);

      let code: string | undefined;
      try {
        transitionTask(deps, task.id, { to: 'SUCCESS' });
      } catch (error) {
        code = (error as FactoryError).code;
      }
      expect(code).toBe('INVALID_TRANSITION');
    } finally {
      deps.store.close();
    }
  });

  it('rejects a transition on an unknown Task', () => {
    const deps = openDeps();
    try {
      let code: string | undefined;
      try {
        transitionTask(deps, 'task_missing', { to: 'READY' });
      } catch (error) {
        code = (error as FactoryError).code;
      }
      expect(code).toBe('TASK_NOT_FOUND');
    } finally {
      deps.store.close();
    }
  });

  it('rejects createTask for a missing Work Order with a typed WORK_ORDER_NOT_FOUND', () => {
    const deps = openDeps();
    try {
      let caught: unknown;
      try {
        createTask(deps, { workOrderId: 'wo_missing', title: 'orphan' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FactoryError);
      expect((caught as FactoryError).code).toBe('WORK_ORDER_NOT_FOUND');
      expect(deps.store.list('tasks')).toHaveLength(0);
    } finally {
      deps.store.close();
    }
  });

  it('rejects createAttempt for a missing Task with a typed TASK_NOT_FOUND', () => {
    const deps = openDeps();
    try {
      let caught: unknown;
      try {
        createAttempt(deps, { taskId: 'task_missing', model: 'm' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FactoryError);
      expect((caught as FactoryError).code).toBe('TASK_NOT_FOUND');
      expect(deps.store.list('attempts')).toHaveLength(0);
    } finally {
      deps.store.close();
    }
  });
});

describe('E1.2 Attempt provenance', () => {
  it('creates and completes an Attempt with §5.3 provenance persisted and logged', () => {
    const deps = openDeps();
    try {
      const task = seedTask(deps);
      deps.store.set('workers', 'worker_1', { id: 'worker_1', name: 'worker one' });

      const attempt = createAttempt(deps, {
        taskId: task.id,
        model: 'anthropic/claude-opus',
        workerId: 'worker_1',
        context: 'fresh-context-snapshot',
        skills: ['typescript', 'testing'],
        environment: 'herdr/local',
      });

      expect(attempt.outcome).toBeNull();
      expect(attempt.taskId).toBe(task.id);
      expect(attempt.model).toBe('anthropic/claude-opus');
      expect(attempt.workerId).toBe('worker_1');
      expect(attempt.context).toBe('fresh-context-snapshot');
      expect(attempt.skills).toEqual(['typescript', 'testing']);
      expect(attempt.environment).toBe('herdr/local');
      expect(deps.store.get<Attempt>('attempts', attempt.id)).toEqual(attempt);

      const completed = completeAttempt(deps, attempt.id, {
        diff: 'diff --git a/x b/x',
        artifactIds: ['artifact_log'],
        interactionIds: ['interaction_q1'],
        verificationRunIds: ['verification_1'],
        outcome: 'SUCCESS',
        failureHistory: [
          { at: '2026-09-29T00:00:00.000Z', failure: 'typecheck failed', recovery: 'fixed types' },
        ],
      });

      expect(completed.outcome).toBe('SUCCESS');
      expect(completed.diff).toBe('diff --git a/x b/x');
      expect(completed.artifactIds).toEqual(['artifact_log']);
      expect(completed.interactionIds).toEqual(['interaction_q1']);
      expect(completed.verificationRunIds).toEqual(['verification_1']);
      expect(completed.failureHistory).toHaveLength(1);
      expect(deps.store.get<Attempt>('attempts', attempt.id)).toEqual(completed);

      const recorded = deps.events.readEvents({ aggregateId: attempt.id });
      expect(recorded.map((event) => event.type)).toEqual([ATTEMPT_CREATED, ATTEMPT_COMPLETED]);
    } finally {
      deps.store.close();
    }
  });

  it('rejects completion of an unknown Attempt', () => {
    const deps = openDeps();
    try {
      expect(() => completeAttempt(deps, 'attempt_missing', { outcome: 'SUCCESS' })).toThrow(
        FactoryError,
      );
    } finally {
      deps.store.close();
    }
  });
});

describe('E1.2 event-log replay restores identical state', () => {
  it('rebuilds the Work Order, Task and Attempt set identically to the persisted store', () => {
    const deps = openDeps();
    try {
      const wo = seedWorkOrder(deps);
      const task = createTask(deps, { workOrderId: wo.id, title: 'first task' });
      driveTask(deps, task.id, ['READY', 'ASSIGNED', 'RUNNING', 'SUCCESS', 'VERIFYING', 'VERIFIED']);

      const attempt = createAttempt(deps, {
        taskId: task.id,
        model: 'openai/gpt-5',
        workerId: null,
        context: 'c',
        skills: ['ts'],
        environment: 'local',
      });
      completeAttempt(deps, attempt.id, {
        diff: 'diff',
        artifactIds: ['a'],
        outcome: 'SUCCESS',
        verificationRunIds: ['v'],
      });

      driveWorkOrder(deps, wo.id, [
        'READY',
        'PLANNING',
        'EXECUTING',
        'VERIFYING',
        'EVIDENCE_READY',
        'HUMAN_GATE',
        'APPROVED',
        'MERGED',
      ]);

      // Replay the append-only log onto a fresh projection.
      const replay = projectState(deps.events.readEvents());
      const snapshot = projectWorkOrder(deps.events.readEvents(), wo.id);

      expect(snapshot).not.toBeNull();
      expect(snapshot!.workOrder).toEqual(deps.store.get<WorkOrder>('work_orders', wo.id));
      expect(byId(snapshot!.tasks)).toEqual(byId(deps.store.list<Task>('tasks')));
      expect(byId(snapshot!.attempts)).toEqual(byId(deps.store.list<Attempt>('attempts')));

      // coherence between the two replay entry points
      expect(replay.workOrders.get(wo.id)).toEqual(snapshot!.workOrder);
      expect(byId([...replay.tasks.values()])).toEqual(byId(snapshot!.tasks));
    } finally {
      deps.store.close();
    }
  });

  it('records the post-transition state in each event so replay is deterministic', () => {
    const deps = openDeps();
    try {
      const wo = seedWorkOrder(deps);
      const ready = transitionWorkOrder(deps, wo.id, { to: 'READY' });

      const [created, transitioned] = deps.events.readEvents({ aggregateId: wo.id });
      expect(created.type).toBe(WORK_ORDER_CREATED);
      expect((created.payload as { workOrder: WorkOrder }).workOrder).toEqual(wo);

      expect(transitioned.type).toBe(WORK_ORDER_TRANSITIONED);
      expect((transitioned.payload as { workOrder: WorkOrder }).workOrder).toEqual(ready);

      // Replaying only up to the current log yields the current state, not a partial one.
      expect(projectWorkOrder(deps.events.readEvents(), wo.id)?.workOrder).toEqual(ready);
    } finally {
      deps.store.close();
    }
  });

  it('is deterministic: replaying the same log twice produces the same projection', () => {
    const deps = openDeps();
    try {
      const wo = seedWorkOrder(deps);
      const task = createTask(deps, { workOrderId: wo.id, title: 'deterministic task' });
      driveTask(deps, task.id, ['READY', 'ASSIGNED', 'RUNNING', 'SUCCESS', 'VERIFYING']);
      driveWorkOrder(deps, wo.id, ['READY', 'PLANNING']);

      const first = projectState(deps.events.readEvents());
      const second = projectState(deps.events.readEvents());

      expect(first.workOrders.get(wo.id)).toEqual(second.workOrders.get(wo.id));
      expect(byId([...first.tasks.values()])).toEqual(byId([...second.tasks.values()]));
    } finally {
      deps.store.close();
    }
  });

  it('reconstructs identical state after reconnect from a fresh store instance', () => {
    const deps = openDeps();
    let woId: string;
    let expected: WorkOrder;
    try {
      const wo = seedWorkOrder(deps);
      woId = wo.id;
      expected = driveWorkOrder(deps, wo.id, ['READY', 'PLANNING', 'EXECUTING']);
    } finally {
      deps.store.close();
    }

    const reopened = openStateStore(dbPath);
    const events = openEventLog(reopened.db);
    try {
      const replayed = projectWorkOrder(events.readEvents(), woId!);
      expect(replayed!.workOrder).toEqual(reopened.get<WorkOrder>('work_orders', woId!));
      expect(replayed!.workOrder).toEqual(expected!);
    } finally {
      reopened.close();
    }
  });
});
