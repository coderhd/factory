import { FactoryError } from '../domain/errors';
import {
  createAttempt,
  transitionTask,
  type Assignment,
  type Task,
  type WorkOrder,
} from '../domain/workOrder';
import type { EventLog } from '../events/log';
import type { SchedulerDeps } from '../scheduler/scheduler';
import type { StateStore } from '../state/store';
import type { ExecutionEnvelope, WorkerAdapter, WorkerResult, WorkerStatus } from './herdr';

/**
 * E3.2 WorkerManager façade (spec §15/§16). Workers are durable JSON documents
 * in E1's `workers` collection; this façade owns provisioning, leases and the
 * adapter dispatch/collect boundary. Workers execute; they never govern.
 */

export const WORKER_PROVISIONED = 'worker.provisioned';
export const WORKER_RECLAIMED = 'worker.reclaimed';
export const ASSIGNMENT_CREATED = 'assignment.created';

export type WorkerProfile = 'herdr';

/**
 * `IDLE → BUSY` (assign) `→ IDLE` (release rule) `→ RECLAIMED`. There is no
 * separate `PROVISIONED` state: `provisionWorker` provisions+starts the adapter
 * in one call and records `IDLE`; the provision fact is the event, not state.
 */
export type WorkerRuntimeState = 'IDLE' | 'BUSY' | 'RECLAIMED';

export interface WorkerLease {
  attemptId: string;
  taskId: string;
  expiresAt: string;
  renewedAt: string;
}

export interface WorkerRecord {
  id: string;
  profile: WorkerProfile;
  runtimeState: WorkerRuntimeState;
  lease: WorkerLease | null;
  provisionedAt: string;
  lastActiveAt: string;
  reclaimedAt: string | null;
}

/** Adapter factory seam: Herdr in production, a fake in tests (Ruling R5). */
export type SpawnWorker = (profile: WorkerProfile) => WorkerAdapter;

export interface WorkerManagerDeps {
  store: StateStore;
  events: EventLog;
  spawn: SpawnWorker;
  now?: () => string;
}

export interface WorkerManager {
  provisionWorker(profile: WorkerProfile): WorkerRecord;
  reclaimIdleWorkers(idleTimeoutMs: number): WorkerRecord[];
  renewLease(
    workerId: string,
    binding: { attemptId: string; taskId: string },
    leaseTtlMs: number,
  ): WorkerRecord;
  listWorkers(): WorkerRecord[];
  status(workerId: string): Promise<WorkerStatus>;
  execute(workerId: string, envelope: ExecutionEnvelope): Promise<void>;
  collectArtifacts(workerId: string): Promise<WorkerResult>;
}

/**
 * The single live Assignment for a Worker, shared by the manager's reclaim
 * guard and the scheduler's collect/completion passes (`closedAt: null` = open;
 * closed rows are retained as provenance).
 */
export function openAssignmentFor(store: StateStore, workerId: string): AssignmentRecord | null {
  return (
    store
      .list<AssignmentRecord>('assignments')
      .find((assignment) => assignment.workerId === workerId && assignment.closedAt === null) ?? null
  );
}

const DEFAULT_NOW = (): string => new Date().toISOString();

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

/**
 * The WorkerManager façade. It holds the adapters it spawned and the in-flight
 * dispatch promises so the scheduler's synchronous `tick()` can poll for
 * terminal reports across ticks.
 */
export function createWorkerManager(deps: WorkerManagerDeps): WorkerManager {
  const now = deps.now ?? DEFAULT_NOW;
  const adapters = new Map<string, WorkerAdapter>();
  const runs = new Map<string, Promise<void>>();
  const dispatchFailures = new Map<string, string>();
  /**
   * The per-worker provision→start boot promise (spec §15/§6.4). `provisionWorker`
   * returns synchronously, but the adapter's runtime is only usable once
   * `provision().then(start())` settles. `execute` awaits this before writing the
   * envelope; without it a same-tick provision→assign→execute dispatch finds the
   * real Herdr `child` null, the envelope is never written, and the run wedges
   * with no loud failure.
   */
  const boots = new Map<string, Promise<void>>();

  const listWorkers = (): WorkerRecord[] => deps.store.list<WorkerRecord>('workers');

  return {
    provisionWorker(profile): WorkerRecord {
      const worker: WorkerRecord = {
        id: `worker_${crypto.randomUUID()}`,
        profile,
        runtimeState: 'IDLE',
        lease: null,
        provisionedAt: now(),
        lastActiveAt: now(),
        reclaimedAt: null,
      };
      const adapter = deps.spawn(profile);
      adapters.set(worker.id, adapter);

      deps.store.db.transaction(() => {
        deps.store.set('workers', worker.id, worker);
        deps.events.appendEvent({
          type: WORKER_PROVISIONED,
          aggregateType: 'worker',
          aggregateId: worker.id,
          payload: { worker },
        });
      })();

      // Provision + start the runtime in one call; the provision fact is the
      // event. The boot promise is retained so `execute` can await it (below).
      boots.set(
        worker.id,
        adapter
          .provision()
          .then(() => adapter.start())
          .catch(() => undefined),
      );

      return worker;
    },

    reclaimIdleWorkers(idleTimeoutMs): WorkerRecord[] {
      const t = now();
      const nowMs = Date.parse(t);
      const reclaimed: WorkerRecord[] = [];
      for (const worker of listWorkers()) {
        if (worker.runtimeState !== 'IDLE') continue;
        // An open assignment protects a worker (a waiting_input assignment is open).
        if (openAssignmentFor(deps.store, worker.id)) continue;
        if (nowMs - Date.parse(worker.lastActiveAt) <= idleTimeoutMs) continue;

        const updated: WorkerRecord = {
          ...worker,
          runtimeState: 'RECLAIMED',
          lease: null,
          lastActiveAt: t,
          reclaimedAt: t,
        };
        deps.store.db.transaction(() => {
          deps.store.set('workers', worker.id, updated);
          deps.events.appendEvent({
            type: WORKER_RECLAIMED,
            aggregateType: 'worker',
            aggregateId: worker.id,
            payload: { worker: updated },
          });
        })();
        void adapters.get(worker.id)?.destroy();
        reclaimed.push(updated);
      }
      return reclaimed;
    },

    renewLease(workerId, binding, leaseTtlMs): WorkerRecord {
      const worker = deps.store.get<WorkerRecord>('workers', workerId);
      if (!worker) throw new FactoryError('WORKER_NOT_FOUND', `worker not found: ${workerId}`);
      const t = now();
      const updated: WorkerRecord = {
        ...worker,
        lease: {
          attemptId: binding.attemptId,
          taskId: binding.taskId,
          expiresAt: new Date(Date.parse(t) + leaseTtlMs).toISOString(),
          renewedAt: t,
        },
        lastActiveAt: t,
      };
      deps.store.set('workers', workerId, updated);
      return updated;
    },

    listWorkers,

    async status(workerId): Promise<WorkerStatus> {
      const adapter = adapters.get(workerId);
      if (!adapter) throw new FactoryError('WORKER_NOT_FOUND', `worker not found: ${workerId}`);
      const boot = boots.get(workerId);
      if (boot) await boot;
      return adapter.status();
    },

    async execute(workerId, envelope): Promise<void> {
      const adapter = adapters.get(workerId);
      if (!adapter) throw new FactoryError('WORKER_NOT_FOUND', `worker not found: ${workerId}`);
      // Await the provision→start boot before dispatching: a same-tick
      // assign→execute must not race the detached boot (the real adapter's
      // `child` is null until `start()` settles and would drop the envelope).
      const boot = boots.get(workerId);
      if (boot) await boot;
      dispatchFailures.delete(workerId);
      // Invoke the adapter synchronously so the dispatch is observable in-tick.
      const run = adapter.execute(envelope).catch((error: unknown) => {
        dispatchFailures.set(workerId, error instanceof Error ? error.message : String(error));
      });
      runs.set(workerId, run);
      await run;
    },

    async collectArtifacts(workerId): Promise<WorkerResult> {
      const adapter = adapters.get(workerId);
      if (!adapter) throw new FactoryError('WORKER_NOT_FOUND', `worker not found: ${workerId}`);
      const boot = boots.get(workerId);
      if (boot) await boot;
      const run = runs.get(workerId);
      if (run) await run;
      const failure = dispatchFailures.get(workerId);
      if (failure) return failedResult(failure);
      return adapter.collectArtifacts();
    },
  };
}

// ---------------------------------------------------------------------------
// Assignment + start (§6.4)
// ---------------------------------------------------------------------------

export interface AssignmentIntent {
  taskId: string;
  workerId: string;
  worktree: { taskId: string; branch: string; worktreePath: string; baseCommit: string };
  /**
   * The routed model for this attempt (E9.3): selected by E4 at assignment and
   * carried through to the Attempt. `null`/absent leaves `attempt.model` null.
   */
  model?: string | null;
}

/**
 * E1 Assignment + the worktree triple + the closure stamp (spec §6.4). Additive
 * JSON fields are safe: the schema FK columns read only `$.taskId`/`$.workerId`.
 */
export interface AssignmentRecord extends Assignment {
  branch: string;
  worktreePath: string;
  baseCommit: string;
  closedAt: string | null;
  /** The routed model for this assignment's Attempt (E9.3); null when unrouted. */
  model: string | null;
}

export interface AssignDeps {
  store: StateStore;
  events: EventLog;
  now?: () => string;
}

/** The lease TTL used until a scheduler config supplies one (renewed each tick). */
export const DEFAULT_LEASE_TTL_MS = 10 * 60_000;

/**
 * Bind a READY Task to an IDLE Worker in one transaction. Guards are evaluated
 * inside the transaction so a failure rolls back the Task transition, the
 * Worker state and the Assignment together (no TOCTOU window).
 */
export function assign(deps: AssignDeps, intent: AssignmentIntent): AssignmentRecord {
  const now = deps.now ?? DEFAULT_NOW;
  return deps.store.db.transaction((): AssignmentRecord => {
    const task = deps.store.get<Task>('tasks', intent.taskId);
    if (!task) throw new FactoryError('TASK_NOT_FOUND', `task not found: ${intent.taskId}`);
    if (task.state !== 'READY') {
      throw new FactoryError(
        'TASK_NOT_READY',
        `task ${task.id} is ${task.state}; assign requires READY`,
      );
    }

    const worker = deps.store.get<WorkerRecord>('workers', intent.workerId);
    if (!worker) throw new FactoryError('WORKER_NOT_FOUND', `worker not found: ${intent.workerId}`);
    if (worker.runtimeState !== 'IDLE') {
      throw new FactoryError(
        'WORKER_NOT_IDLE',
        `worker ${worker.id} is ${worker.runtimeState}; assign requires IDLE`,
      );
    }

    const t = now();
    const assignment: AssignmentRecord = {
      id: `assignment_${crypto.randomUUID()}`,
      taskId: task.id,
      workerId: worker.id,
      branch: intent.worktree.branch,
      worktreePath: intent.worktree.worktreePath,
      baseCommit: intent.worktree.baseCommit,
      closedAt: null,
      model: intent.model ?? null,
      createdAt: t,
      updatedAt: t,
    };

    transitionTask(deps, task.id, { to: 'ASSIGNED' });
    deps.store.set('workers', worker.id, {
      ...worker,
      runtimeState: 'BUSY',
      lastActiveAt: t,
    });
    deps.store.set('assignments', assignment.id, assignment);
    deps.events.appendEvent({
      type: ASSIGNMENT_CREATED,
      aggregateType: 'assignment',
      aggregateId: assignment.id,
      payload: { assignment },
    });

    return assignment;
  })();
}

function envelopeContext(workOrder: WorkOrder, task: Task): string {
  const lines = [
    `Work Order: ${workOrder.intent}`,
    ...workOrder.acceptanceCriteria.map((criterion) => `Acceptance: ${criterion}`),
    `Task: ${task.title}`,
  ];
  return lines.join('\n');
}

/**
 * Open the Attempt, move the Task to RUNNING, grant the lease and dispatch the
 * envelope. The dispatch is async; the report is collected by a later tick.
 */
export function startTask(deps: SchedulerDeps, assignment: AssignmentRecord): ExecutionEnvelope {
  const task = deps.store.get<Task>('tasks', assignment.taskId);
  if (!task) throw new FactoryError('TASK_NOT_FOUND', `task not found: ${assignment.taskId}`);
  const workOrder = deps.store.get<WorkOrder>('work_orders', task.workOrderId);
  if (!workOrder) {
    throw new FactoryError('WORK_ORDER_NOT_FOUND', `work order not found: ${task.workOrderId}`);
  }

  const attempt = createAttempt(deps, {
    taskId: task.id,
    workerId: assignment.workerId,
    model: assignment.model,
    context: envelopeContext(workOrder, task),
    environment: 'herdr/local',
  });
  transitionTask(deps, task.id, { to: 'RUNNING' });
  deps.workers.renewLease(
    assignment.workerId,
    { attemptId: attempt.id, taskId: task.id },
    deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
  );

  const envelope: ExecutionEnvelope = {
    workOrderId: workOrder.id,
    taskId: task.id,
    attemptId: attempt.id,
    repository: workOrder.repository ?? deps.repoPath ?? '',
    baseCommit: assignment.baseCommit,
    branch: assignment.branch,
    worktree: assignment.worktreePath,
    authorizationCapabilities: [],
    initialContext: envelopeContext(workOrder, task),
    retrievalEndpoint: null,
    skills: [],
    requiredVerification: workOrder.requiredVerification,
  };

  void deps.workers.execute(assignment.workerId, envelope);
  return envelope;
}
