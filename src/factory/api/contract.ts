import type { Attempt, Task, WorkOrder } from '../domain/workOrder';
import type { DailyThroughput, HumanHourThroughput, DrillDownStage } from '../observatory/observatory';
import type { DAGVersion } from '../planning/dag';
import type { SchedulerStatus } from '../scheduler/scheduler';

/**
 * The E2 Factory API contract (spec §6, §22): the request/response DTOs shared
 * by the server and the CLI client. Clients only ever speak this contract; the
 * server is the sole mutation authority and the only writer of Factory state.
 */

export const API_VERSION = 'factory/api/v0.1';

/** Handshake describes the instance a client connected to (spec §22). */
export interface HandshakeDto {
  instanceId: string;
  version: string;
  apiVersion: string;
  schemaVersion: string;
  capabilities: string[];
}

export interface HealthDto {
  status: 'ok';
  instanceId: string;
  version: string;
  apiVersion: string;
  schemaVersion: string;
  uptimeSeconds: number;
}

/** A durable §12 interaction as the client sees it. */
export interface InteractionDto {
  id: string;
  type: 'QUESTION';
  taskId: string;
  attemptId: string;
  workerId: string;
  recipient: 'human';
  question: string;
  status: 'PENDING' | 'ANSWERED';
  response: string | null;
  createdAt: string;
  updatedAt: string;
  answeredAt?: string;
  answeredBy?: 'human';
}

export interface WorkOrderSnapshotDto {
  workOrder: WorkOrder;
  tasks: Task[];
  attempts: Attempt[];
  interactions: InteractionDto[];
  dag: DAGVersion | null;
}

export interface ObservatoryDto {
  generatedAt: string;
  verifiedPerDay: DailyThroughput[];
  throughputPerHumanHour: HumanHourThroughput;
}

export interface DrillDownDto {
  workOrderId: string;
  chain: DrillDownStage[];
}

export interface AnswerResultDto {
  interaction: InteractionDto;
  task: Task;
  workOrder: WorkOrder | null;
}

export interface SchedulerStatusDto {
  scheduler: SchedulerStatus;
}

export interface ApiErrorDto {
  error: { code: string; message: string };
}

/** Human-gate verbs mapped onto Factory-owned Work Order transitions. */
export type GateDecision = 'APPROVE' | 'REWORK' | 'REJECT';
