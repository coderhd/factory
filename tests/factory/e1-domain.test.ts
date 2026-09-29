import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMessageBus } from '../../src/factory/bus/messageBus';
import {
  TASK_STATES,
  WORK_ORDER_CREATED,
  WORK_ORDER_STATES,
  createWorkOrder,
  type WorkOrder,
} from '../../src/factory/domain/workOrder';
import { openEventLog, replayEvents } from '../../src/factory/events/log';
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
