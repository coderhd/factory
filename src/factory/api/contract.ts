import type { Attempt, Task, WorkOrder } from '../domain/workOrder';
import type { GitHubPullRequest, ImportIssueResult } from '../github/adapter';
import type { DrillDownStage } from '../observatory/observatory';
import type { ApprovalRecord } from '../policy/policy';
import type { DAGVersion, RecordedProposal } from '../planning/dag';
import type { SchedulerStatus } from '../scheduler/scheduler';
import type { TelemetryMetrics } from '../telemetry/telemetry';

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
  /** The answering operator identity; `'human'` when none was supplied. */
  answeredBy?: string;
}

export interface WorkOrderSnapshotDto {
  workOrder: WorkOrder;
  tasks: Task[];
  attempts: Attempt[];
  interactions: InteractionDto[];
  dag: DAGVersion | null;
}

/**
 * The Observatory projection (E9.7; spec §23) — E8's `TelemetryMetrics`
 * verbatim: verified changes/day, verified throughput per human hour, rework
 * attempts, and recorded model/tool cost. All values derive from durable
 * evidence/telemetry; an empty Factory is zero/[], never fabricated.
 */
export type ObservatoryDto = TelemetryMetrics;

export interface DrillDownDto {
  workOrderId: string;
  chain: DrillDownStage[];
}

export interface AnswerResultDto {
  interaction: InteractionDto;
  task: Task;
  workOrder: WorkOrder | null;
}

/**
 * The E9.5 approval answer (spec §13). A human answers a §5.2 approval park:
 * `APPROVAL` authorizes the consuming decision (E7 spends it), `DENY` settles
 * it as refused. The `actor` is the durable operator receipt.
 */
export interface ApprovalAnswerRequest {
  decision: 'APPROVAL' | 'DENY';
  actor: string;
  comment?: string;
}

export interface ApprovalsDto {
  approvals: ApprovalRecord[];
}

export interface SchedulerStatusDto {
  scheduler: SchedulerStatus;
}

/**
 * E9.6 factory-level controls (spec §10/§18.11). `emergencyStopped` blocks new
 * assignments/provisioning and external side effects; `paused` blocks new
 * autonomous work. Both preserve state and evidence and require an explicit
 * human resume.
 */
export interface FactoryControlsDto {
  paused: boolean;
  emergencyStopped: boolean;
}

/**
 * The response from `POST /work-orders/:id/dag`: the recorded proposal plus the
 * committed, immutable DAG version. The request body is E3's
 * `DAGProposalPayload` verbatim; the client never names tasks or edges.
 */
export interface CommitDagResultDto {
  proposal: RecordedProposal;
  dag: DAGVersion;
}

export interface ApiErrorDto {
  error: { code: string; message: string };
}

/** Human-gate verbs mapped onto Factory-owned Work Order transitions. */
export type GateDecision = 'APPROVE' | 'REWORK' | 'REJECT';

/**
 * E10.3 (#37) GitHub operator surface (spec §4.2/§28). The server composes the
 * E6 adapter and exposes only these two operator actions over the API; every
 * GitHub side effect still authorizes through the live E7 policy inside the
 * adapter, and the PR body's Evidence Bundle link is read from the **durable**
 * `evidence_bundles` receipt by id (never a caller-supplied bundle).
 */
export interface GitHubImportRequest {
  /** `owner/name`. */
  repository: string;
  /** The GitHub issue number to reconcile into a Work Order. */
  number: number;
}

export type GitHubImportResultDto = ImportIssueResult;

export interface GitHubOpenPrRequest {
  /**
   * The id of the durable Evidence Bundle the PR links. Only the id is trusted:
   * the server re-reads the receipt from `evidence_bundles` and 404s when it is
   * absent — an in-memory bundle cannot authorize an external PR.
   */
  evidenceBundleId: string;
  /** Optional PR base override; defaults to the adapter's configured base. */
  baseBranch?: string;
  title?: string;
}

export type GitHubPullRequestDto = GitHubPullRequest;
