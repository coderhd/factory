import { replayEvents, type DomainEvent, type EventLog } from '../events/log';
import type { StateStore } from '../state/store';
import { FactoryError } from './errors';

/** Work Order lifecycle vocabulary (spec §5.1). E1.2 owns the transitions. */
export const WORK_ORDER_STATES = [
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
] as const;
export type WorkOrderState = (typeof WORK_ORDER_STATES)[number];

/** Task lifecycle vocabulary (spec §5.2). E1.2 owns the transitions. */
export const TASK_STATES = [
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
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type RiskTier = 'GREEN' | 'YELLOW' | 'RED';

export const WORK_ORDER_CREATED = 'work_order.created';
export const WORK_ORDER_TRANSITIONED = 'work_order.transitioned';
export const TASK_CREATED = 'task.created';
export const TASK_TRANSITIONED = 'task.transitioned';
export const ATTEMPT_CREATED = 'attempt.created';
export const ATTEMPT_COMPLETED = 'attempt.completed';

/**
 * The legal Work Order edges (spec §5.1). Factory-owned: a Worker may request a
 * transition but only the Factory may apply one. Terminal states have no
 * outgoing edge. REWORK returns to EXECUTING for re-execution (controller
 * ruling R8; the §5.1 diagram does not draw REWORK's outgoing edge).
 */
export const WORK_ORDER_EDGES: Readonly<Record<WorkOrderState, readonly WorkOrderState[]>> = {
  DRAFT: ['READY'],
  READY: ['PLANNING'],
  PLANNING: ['EXECUTING'],
  EXECUTING: ['WAITING_INPUT', 'VERIFYING'],
  WAITING_INPUT: ['EXECUTING', 'VERIFYING'],
  VERIFYING: ['EVIDENCE_READY', 'FAILED'],
  FAILED: ['REWORK'],
  REWORK: ['EXECUTING'],
  EVIDENCE_READY: ['HUMAN_GATE'],
  HUMAN_GATE: ['APPROVED', 'REWORK', 'REJECTED'],
  REJECTED: [],
  APPROVED: ['MERGED'],
  MERGED: [],
};

/**
 * The legal Task edges (spec §5.2). `WAITING_INPUT→RUNNING` is the resume edge
 * the Factory uses when a human answer arrives (spec §12). Terminal state
 * VERIFIED has no outgoing edge.
 */
export const TASK_EDGES: Readonly<Record<TaskState, readonly TaskState[]>> = {
  PLANNED: ['READY'],
  READY: ['ASSIGNED'],
  ASSIGNED: ['RUNNING'],
  RUNNING: ['WAITING_INPUT', 'SUCCESS'],
  WAITING_INPUT: ['RUNNING'],
  SUCCESS: ['VERIFYING'],
  VERIFYING: ['VERIFIED', 'FAILED'],
  VERIFIED: [],
  FAILED: ['REWORK'],
  REWORK: ['RUNNING'],
};

/** The human request a Work Order is created from (spec §5.1). */
export interface WorkOrderIntent {
  intent: string;
  acceptanceCriteria?: string[];
  riskTier?: RiskTier;
  constraints?: string[];
  outOfScope?: string[];
  repository?: string;
  requiredVerification?: string[];
}

/** The central Factory primitive (spec §5.1). */
export interface WorkOrder {
  id: string;
  intent: string;
  acceptanceCriteria: string[];
  riskTier: RiskTier;
  constraints: string[];
  outOfScope: string[];
  repository: string | null;
  requiredVerification: string[];
  state: WorkOrderState;
  createdAt: string;
  updatedAt: string;
}

/** A node in the Task dependency DAG (spec §5.2). */
export interface Task {
  id: string;
  workOrderId: string;
  title: string;
  state: TaskState;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A DAG edge between two Tasks (spec §19 `task_dependencies`). `taskId` and
 * `dependsOnTaskId` are the JSON keys the schema's foreign keys are generated
 * from.
 */
export interface TaskDependency {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Binds a Task to a Worker (spec §19 `assignments`). `taskId` and `workerId`
 * are the JSON keys the schema's foreign keys are generated from.
 */
export interface Assignment {
  id: string;
  taskId: string;
  workerId: string;
  createdAt: string;
  updatedAt: string;
}

/** One failure encountered during an Attempt and the recovery applied (spec §5.3). */
export interface AttemptFailure {
  at: string;
  failure: string;
  recovery?: string;
}

/** Provenance for one execution of a Task (spec §5.3). */
export interface Attempt {
  id: string;
  taskId: string;
  model: string | null;
  workerId: string | null;
  context: string | null;
  skills: string[];
  diff: string | null;
  artifactIds: string[];
  interactionIds: string[];
  verificationRunIds: string[];
  environment: string | null;
  outcome: string | null;
  failureHistory: AttemptFailure[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkOrderDeps {
  store: StateStore;
  events: EventLog;
}

/**
 * Create a Work Order in DRAFT, persist it through the StateStore, and record
 * its creation in the append-only event log. Factory-owned; Workers never call
 * this directly.
 */
export function createWorkOrder(
  deps: WorkOrderDeps,
  intent: WorkOrderIntent,
): WorkOrder {
  const now = new Date().toISOString();
  const workOrder: WorkOrder = {
    id: `wo_${crypto.randomUUID()}`,
    intent: intent.intent,
    acceptanceCriteria: intent.acceptanceCriteria ?? [],
    // Everything starts Yellow (spec §13.1); Green is earned, Red never auto-promotes.
    riskTier: intent.riskTier ?? 'YELLOW',
    constraints: intent.constraints ?? [],
    outOfScope: intent.outOfScope ?? [],
    repository: intent.repository ?? null,
    requiredVerification: intent.requiredVerification ?? [],
    state: 'DRAFT',
    createdAt: now,
    updatedAt: now,
  };

  // State and log must agree: persist the DRAFT record and its creation event
  // in one transaction so a failure cannot leave an unlogged Work Order. The
  // event carries the full post-creation state so the log replays deterministically.
  deps.store.db.transaction(() => {
    deps.store.set('work_orders', workOrder.id, workOrder);
    deps.events.appendEvent({
      type: WORK_ORDER_CREATED,
      aggregateType: 'work_order',
      aggregateId: workOrder.id,
      payload: { workOrder },
    });
  })();

  return workOrder;
}

function assertTransition(
  aggregate: string,
  id: string,
  from: string,
  to: string,
  edges: Readonly<Record<string, readonly string[]>>,
): void {
  const allowed = edges[from] ?? [];
  if (!allowed.includes(to)) {
    throw new FactoryError(
      'INVALID_TRANSITION',
      `invalid ${aggregate} transition for ${id}: ${from} -> ${to}`,
    );
  }
}

/** A requested Work Order state change. The Factory validates it against §5.1. */
export interface WorkOrderTransition {
  to: WorkOrderState;
  reason?: string;
}

/**
 * Apply a Factory-owned Work Order transition (spec §5.1). Validates the edge
 * before touching durable state; an illegal edge throws `FactoryError`
 * (`INVALID_TRANSITION`) and leaves both the store and the event log unchanged.
 */
export function transitionWorkOrder(
  deps: WorkOrderDeps,
  id: string,
  transition: WorkOrderTransition,
): WorkOrder {
  const current = deps.store.get<WorkOrder>('work_orders', id);
  if (!current) {
    throw new FactoryError('WORK_ORDER_NOT_FOUND', `work order not found: ${id}`);
  }
  assertTransition('work_order', id, current.state, transition.to, WORK_ORDER_EDGES);

  const updated: WorkOrder = {
    ...current,
    state: transition.to,
    updatedAt: new Date().toISOString(),
  };

  deps.store.db.transaction(() => {
    deps.store.set('work_orders', id, updated);
    deps.events.appendEvent({
      type: WORK_ORDER_TRANSITIONED,
      aggregateType: 'work_order',
      aggregateId: id,
      payload: { workOrder: updated, reason: transition.reason ?? null },
    });
  })();

  return updated;
}

/** A Task the Planner proposes; the Factory commits it in PLANNED (spec §5.2). */
export interface TaskIntent {
  workOrderId: string;
  title: string;
  dependsOn?: string[];
}

/**
 * Persist a Task in PLANNED and record its creation. Dependency-graph
 * validation/versioning is E3; this only commits Factory-owned Task state.
 */
export function createTask(deps: WorkOrderDeps, intent: TaskIntent): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: `task_${crypto.randomUUID()}`,
    workOrderId: intent.workOrderId,
    title: intent.title,
    state: 'PLANNED',
    dependsOn: intent.dependsOn ?? [],
    createdAt: now,
    updatedAt: now,
  };

  deps.store.db.transaction(() => {
    deps.store.set('tasks', task.id, task);
    deps.events.appendEvent({
      type: TASK_CREATED,
      aggregateType: 'task',
      aggregateId: task.id,
      payload: { task },
    });
  })();

  return task;
}

/** A requested Task state change. The Factory validates it against §5.2. */
export interface TaskTransition {
  to: TaskState;
  reason?: string;
}

/**
 * Apply a Factory-owned Task transition (spec §5.2). Same contract as
 * `transitionWorkOrder`: illegal edges throw `FactoryError` and change nothing.
 */
export function transitionTask(
  deps: WorkOrderDeps,
  id: string,
  transition: TaskTransition,
): Task {
  const current = deps.store.get<Task>('tasks', id);
  if (!current) {
    throw new FactoryError('TASK_NOT_FOUND', `task not found: ${id}`);
  }
  assertTransition('task', id, current.state, transition.to, TASK_EDGES);

  const updated: Task = {
    ...current,
    state: transition.to,
    updatedAt: new Date().toISOString(),
  };

  deps.store.db.transaction(() => {
    deps.store.set('tasks', id, updated);
    deps.events.appendEvent({
      type: TASK_TRANSITIONED,
      aggregateType: 'task',
      aggregateId: id,
      payload: { task: updated, reason: transition.reason ?? null },
    });
  })();

  return updated;
}

/** Provenance supplied when an Attempt starts (spec §5.3). */
export interface AttemptIntent {
  taskId: string;
  model?: string | null;
  workerId?: string | null;
  context?: string | null;
  skills?: string[];
  environment?: string | null;
}

/**
 * Open a first-class Attempt for a Task (spec §5.3). Attempts are durable
 * execution history: each repeated execution gets a new Attempt.
 */
export function createAttempt(deps: WorkOrderDeps, intent: AttemptIntent): Attempt {
  const now = new Date().toISOString();
  const attempt: Attempt = {
    id: `attempt_${crypto.randomUUID()}`,
    taskId: intent.taskId,
    model: intent.model ?? null,
    workerId: intent.workerId ?? null,
    context: intent.context ?? null,
    skills: intent.skills ?? [],
    diff: null,
    artifactIds: [],
    interactionIds: [],
    verificationRunIds: [],
    environment: intent.environment ?? null,
    outcome: null,
    failureHistory: [],
    createdAt: now,
    updatedAt: now,
  };

  deps.store.db.transaction(() => {
    deps.store.set('attempts', attempt.id, attempt);
    deps.events.appendEvent({
      type: ATTEMPT_CREATED,
      aggregateType: 'attempt',
      aggregateId: attempt.id,
      payload: { attempt },
    });
  })();

  return attempt;
}

/** Fields recorded when an Attempt finishes (spec §5.3). `outcome` is required. */
export interface AttemptCompletion {
  outcome: string;
  model?: string | null;
  context?: string | null;
  skills?: string[];
  diff?: string | null;
  artifactIds?: string[];
  interactionIds?: string[];
  verificationRunIds?: string[];
  environment?: string | null;
  failureHistory?: AttemptFailure[];
}

/** Close an Attempt with its execution/verification provenance. */
export function completeAttempt(
  deps: WorkOrderDeps,
  attemptId: string,
  completion: AttemptCompletion,
): Attempt {
  const current = deps.store.get<Attempt>('attempts', attemptId);
  if (!current) {
    throw new FactoryError('ATTEMPT_NOT_FOUND', `attempt not found: ${attemptId}`);
  }

  const updated: Attempt = {
    ...current,
    model: completion.model ?? current.model,
    context: completion.context ?? current.context,
    skills: completion.skills ?? current.skills,
    diff: completion.diff ?? current.diff,
    artifactIds: completion.artifactIds ?? current.artifactIds,
    interactionIds: completion.interactionIds ?? current.interactionIds,
    verificationRunIds: completion.verificationRunIds ?? current.verificationRunIds,
    environment: completion.environment ?? current.environment,
    outcome: completion.outcome,
    failureHistory: completion.failureHistory ?? current.failureHistory,
    updatedAt: new Date().toISOString(),
  };

  deps.store.db.transaction(() => {
    deps.store.set('attempts', updated.id, updated);
    deps.events.appendEvent({
      type: ATTEMPT_COMPLETED,
      aggregateType: 'attempt',
      aggregateId: updated.id,
      payload: { attempt: updated },
    });
  })();

  return updated;
}

/** A rebuilt projection of the Factory's durable state (spec §19 replay). */
export interface FactoryProjection {
  workOrders: Map<string, WorkOrder>;
  tasks: Map<string, Task>;
  attempts: Map<string, Attempt>;
}

/** The replayed slice of one Work Order: the order, its Tasks and their Attempts. */
export interface WorkOrderSnapshot {
  workOrder: WorkOrder;
  tasks: Task[];
  attempts: Attempt[];
}

function applyEvent(projection: FactoryProjection, event: DomainEvent): FactoryProjection {
  const payload = event.payload as {
    workOrder?: WorkOrder;
    task?: Task;
    attempt?: Attempt;
  };
  if (payload.workOrder) {
    projection.workOrders.set(payload.workOrder.id, payload.workOrder);
  } else if (payload.task) {
    projection.tasks.set(payload.task.id, payload.task);
  } else if (payload.attempt) {
    projection.attempts.set(payload.attempt.id, payload.attempt);
  }
  return projection;
}

/**
 * Replay the append-only event log onto a fresh projection. Each event carries
 * the full post-transition entity, so folding in seq order rebuilds the same
 * state the StateStore holds (spec §19).
 */
export function projectState(events: readonly DomainEvent[]): FactoryProjection {
  return replayEvents<FactoryProjection>(
    events,
    applyEvent,
    { workOrders: new Map(), tasks: new Map(), attempts: new Map() },
  );
}

/**
 * Rebuild one Work Order and its Task/Attempt set from the event log. Returns
 * `null` if the log never created the Work Order.
 */
export function projectWorkOrder(
  events: readonly DomainEvent[],
  workOrderId: string,
): WorkOrderSnapshot | null {
  const projection = projectState(events);
  const workOrder = projection.workOrders.get(workOrderId) ?? null;
  if (!workOrder) return null;

  const tasks = [...projection.tasks.values()].filter((task) => task.workOrderId === workOrderId);
  const taskIds = new Set(tasks.map((task) => task.id));
  const attempts = [...projection.attempts.values()].filter((attempt) =>
    taskIds.has(attempt.taskId),
  );

  return { workOrder, tasks, attempts };
}
