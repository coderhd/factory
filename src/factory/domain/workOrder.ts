import type { EventLog } from '../events/log';
import type { StateStore } from '../state/store';

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
  verificationRunIds: string[];
  environment: string | null;
  outcome: string | null;
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
 * this directly. State transitions arrive in E1.2.
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

  deps.store.set('work_orders', workOrder.id, workOrder);
  deps.events.appendEvent({
    type: WORK_ORDER_CREATED,
    aggregateType: 'work_order',
    aggregateId: workOrder.id,
    payload: { intent: workOrder.intent, riskTier: workOrder.riskTier },
  });

  return workOrder;
}
