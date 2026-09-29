-- Factory Server v0.1 — SQLite schema (design spec §19).
--
-- SQLite holds the current authoritative Factory state; the event log holds
-- immutable execution history; large artifacts live on the filesystem
-- (see ArtifactStore in store.ts), never as blobs in this database.
--
-- The state tables store each entity as a JSON document (`data`) keyed by
-- `id`, but relationships are enforced as real foreign keys: each child table
-- projects its relational keys out of `data` as VIRTUAL generated columns and
-- references the parent table, so `PRAGMA foreign_keys = ON` is meaningful.
-- The generated columns read the same camelCase JSON keys the domain types in
-- src/factory/domain/workOrder.ts write.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS work_orders (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_orders_updated_at ON work_orders (updated_at);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  data          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  work_order_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.workOrderId')) VIRTUAL
    REFERENCES work_orders (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks (updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_work_order_id ON tasks (work_order_id);

CREATE TABLE IF NOT EXISTS workers (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- DAG edges: both endpoints must reference existing tasks.
CREATE TABLE IF NOT EXISTS task_dependencies (
  id                  TEXT PRIMARY KEY,
  data                TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  task_id             TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL
    REFERENCES tasks (id) ON DELETE CASCADE,
  depends_on_task_id  TEXT GENERATED ALWAYS AS (json_extract(data, '$.dependsOnTaskId')) VIRTUAL
    REFERENCES tasks (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id
  ON task_dependencies (task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on_task_id
  ON task_dependencies (depends_on_task_id);

-- Attempts are durable execution history: a Worker referenced by an Attempt
-- may not be deleted (RESTRICT). SET NULL is impossible because the child key
-- is a generated column.
CREATE TABLE IF NOT EXISTS attempts (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  task_id    TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL
    REFERENCES tasks (id) ON DELETE CASCADE,
  worker_id  TEXT GENERATED ALWAYS AS (json_extract(data, '$.workerId')) VIRTUAL
    REFERENCES workers (id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_attempts_updated_at ON attempts (updated_at);
CREATE INDEX IF NOT EXISTS idx_attempts_task_id ON attempts (task_id);
CREATE INDEX IF NOT EXISTS idx_attempts_worker_id ON attempts (worker_id);

CREATE TABLE IF NOT EXISTS assignments (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  task_id    TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL
    REFERENCES tasks (id) ON DELETE CASCADE,
  worker_id  TEXT GENERATED ALWAYS AS (json_extract(data, '$.workerId')) VIRTUAL
    REFERENCES workers (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_assignments_task_id ON assignments (task_id);
CREATE INDEX IF NOT EXISTS idx_assignments_worker_id ON assignments (worker_id);

CREATE TABLE IF NOT EXISTS interactions (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_runs (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_bundles (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_decisions (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Append-only execution history. Rows are inserted, never updated or deleted;
-- the triggers below enforce that at the database level.
CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  payload        TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events (aggregate_type, aggregate_id);

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
