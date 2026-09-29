import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Entity tables from design spec §19 that StateStore persists as JSON documents. */
export const DOCUMENT_COLLECTIONS = [
  'work_orders',
  'tasks',
  'task_dependencies',
  'attempts',
  'workers',
  'assignments',
  'interactions',
  'artifacts',
  'verification_runs',
  'evidence_bundles',
  'policy_decisions',
  'routing_decisions',
] as const;

/** All §19 tables, including the append-only `events` log. */
export const SCHEMA_TABLES = [...DOCUMENT_COLLECTIONS, 'events'] as const;

export type StateCollection = (typeof DOCUMENT_COLLECTIONS)[number];

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

function assertCollection(collection: string): asserts collection is StateCollection {
  if (!(DOCUMENT_COLLECTIONS as readonly string[]).includes(collection)) {
    throw new Error(`unknown state collection: ${collection}`);
  }
}

/**
 * Seam over the current authoritative Factory state (SQLite). Small and
 * swappable: reads and writes whole entities by collection + id.
 */
export interface StateStore {
  readonly db: Database;
  get<T>(collection: StateCollection, id: string): T | null;
  set<T>(collection: StateCollection, id: string, value: T): void;
  list<T>(collection: StateCollection): T[];
  delete(collection: StateCollection, id: string): void;
  close(): void;
}

class SqliteStateStore implements StateStore {
  constructor(readonly db: Database) {}

  get<T>(collection: StateCollection, id: string): T | null {
    assertCollection(collection);
    const row = this.db
      .query(`SELECT data FROM ${collection} WHERE id = ?`)
      .get(id) as { data: string } | null;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  set<T>(collection: StateCollection, id: string, value: T): void {
    assertCollection(collection);
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO ${collection} (id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(id, JSON.stringify(value), now, now);
  }

  list<T>(collection: StateCollection): T[] {
    assertCollection(collection);
    const rows = this.db
      .query(`SELECT data FROM ${collection} ORDER BY updated_at, id`)
      .all() as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as T);
  }

  delete(collection: StateCollection, id: string): void {
    assertCollection(collection);
    this.db.query(`DELETE FROM ${collection} WHERE id = ?`).run(id);
  }

  close(): void {
    this.db.close();
  }
}

/** Open (creating if needed) the SQLite state database and apply the schema. */
export function openStateStore(dbPath: string): StateStore {
  const db = new Database(dbPath);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return new SqliteStateStore(db);
}

/** Reference to a large artifact stored on the filesystem, outside the database. */
export interface ArtifactRef {
  id: string;
  path: string;
  size: number;
  sha256: string;
}

/**
 * Seam over large artifacts (evidence, diffs, logs, screenshots). MVP keeps
 * them on the filesystem under a configured root; swappable for object storage.
 */
export interface ArtifactStore {
  put(name: string, data: string | Uint8Array): ArtifactRef;
  get(ref: ArtifactRef | string): Uint8Array;
}

function resolveWithinRoot(root: string, name: string): string {
  const path = resolve(root, name);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`artifact path escapes root: ${name}`);
  }
  return path;
}

export function createArtifactStore(rootDir: string): ArtifactStore {
  const root = resolve(rootDir);
  mkdirSync(root, { recursive: true });
  return {
    put(name, data) {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      const relative = name.replace(/\\/g, '/').replace(/^\/+/, '');
      const path = resolveWithinRoot(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      return {
        id: relative,
        path,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    },
    get(ref) {
      const path = typeof ref === 'string' ? resolveWithinRoot(root, ref) : ref.path;
      return readFileSync(path);
    },
  };
}
