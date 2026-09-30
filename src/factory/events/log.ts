import type { Database } from 'bun:sqlite';

/** An immutable fact in the append-only execution history. */
export interface DomainEvent {
  seq: number;
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  createdAt: string;
}

/** An event to append; `seq`, `id` and `createdAt` are assigned by the log. */
export interface NewEvent {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload?: unknown;
}

export interface ReadEventsOptions {
  afterSeq?: number;
  aggregateType?: string;
  aggregateId?: string;
}

export interface EventLog {
  /** Append one event and return its monotonic sequence number. */
  appendEvent(event: NewEvent): number;
  readEvents(options?: ReadEventsOptions): DomainEvent[];
  count(): number;
}

interface EventRow {
  seq: number;
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: string;
  created_at: string;
}

class SqliteEventLog implements EventLog {
  constructor(private readonly db: Database) {}

  appendEvent(event: NewEvent): number {
    const result = this.db
      .query(
        `INSERT INTO events (id, type, aggregate_type, aggregate_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        event.type,
        event.aggregateType,
        event.aggregateId,
        JSON.stringify(event.payload ?? {}),
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  readEvents(options: ReadEventsOptions = {}): DomainEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.afterSeq !== undefined) {
      clauses.push('seq > ?');
      params.push(options.afterSeq);
    }
    if (options.aggregateType !== undefined) {
      clauses.push('aggregate_type = ?');
      params.push(options.aggregateType);
    }
    if (options.aggregateId !== undefined) {
      clauses.push('aggregate_id = ?');
      params.push(options.aggregateId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .query(
        `SELECT seq, id, type, aggregate_type, aggregate_id, payload, created_at
         FROM events${where} ORDER BY seq`,
      )
      .all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  count(): number {
    const row = this.db.query('SELECT COUNT(*) AS count FROM events').get() as { count: number };
    return row.count;
  }
}

function rowToEvent(row: EventRow): DomainEvent {
  return {
    seq: row.seq,
    id: row.id,
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}

/** Open the append-only event log over an existing state database. */
export function openEventLog(db: Database): EventLog {
  return new SqliteEventLog(db);
}

/**
 * Replay primitive: fold events in sequence order into a state value. E1.2 uses
 * this to rebuild Work Order state from the log.
 */
export function replayEvents<S>(
  events: readonly DomainEvent[],
  reducer: (state: S, event: DomainEvent) => S,
  initial: S,
): S {
  let state = initial;
  for (const event of events) {
    state = reducer(state, event);
  }
  return state;
}
