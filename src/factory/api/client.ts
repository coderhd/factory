import type { WorkOrder, WorkOrderIntent, WorkOrderTransition } from '../domain/workOrder';
import type { DAGProposalPayload } from '../planning/dag';
import type { ApprovalRecord } from '../policy/policy';
import type {
  AnswerResultDto,
  ApprovalAnswerRequest,
  CommitDagResultDto,
  DrillDownDto,
  FactoryControlsDto,
  GateDecision,
  GitHubImportRequest,
  GitHubImportResultDto,
  GitHubOpenPrRequest,
  GitHubPullRequestDto,
  HandshakeDto,
  HealthDto,
  InteractionDto,
  ObservatoryDto,
  SchedulerStatusDto,
  WorkOrderSnapshotDto,
} from './contract';

/**
 * The E2 Factory API client (spec §22). A thin typed HTTP client — it holds a
 * base URL and nothing else, never a StateStore, and therefore cannot mutate
 * Factory state except through the API. That is how "the server is the sole
 * mutation authority" is provable: the CLI's submit/status/answer paths run
 * over this client.
 */

export class FactoryApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FactoryApiError';
  }
}

export interface FactoryClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /**
   * E10.4 (#40) the shared bearer credential. Present, every request carries
   * `Authorization: Bearer <token>`; absent, no header is sent. The secret
   * lives in the caller's configuration and is never logged.
   */
  token?: string;
}

export interface FactoryClient {
  health(): Promise<HealthDto>;
  handshake(): Promise<HandshakeDto>;
  submitWorkOrder(intent: WorkOrderIntent): Promise<WorkOrder>;
  listWorkOrders(): Promise<WorkOrder[]>;
  getWorkOrder(id: string): Promise<WorkOrderSnapshotDto>;
  transitionWorkOrder(id: string, transition: WorkOrderTransition): Promise<WorkOrder>;
  applyGate(id: string, decision: GateDecision): Promise<WorkOrder>;
  commitDag(id: string, payload: DAGProposalPayload): Promise<CommitDagResultDto>;
  listInteractions(status?: InteractionDto['status']): Promise<InteractionDto[]>;
  answerInteraction(id: string, response: string, actor?: string): Promise<AnswerResultDto>;
  listApprovals(status?: ApprovalRecord['status']): Promise<ApprovalRecord[]>;
  answerApproval(id: string, answer: ApprovalAnswerRequest): Promise<ApprovalRecord>;
  schedulerStatus(): Promise<SchedulerStatusDto>;
  observatory(): Promise<ObservatoryDto>;
  drillDown(workOrderId: string): Promise<DrillDownDto>;
  factoryControls(): Promise<FactoryControlsDto>;
  emergencyStop(actor: string): Promise<FactoryControlsDto>;
  pause(actor: string): Promise<FactoryControlsDto>;
  resume(actor: string): Promise<FactoryControlsDto>;
  /**
   * E10.3 (#37): reconcile a GitHub issue into a Work Order through the server.
   * The server composes the E6 adapter; the client only speaks the contract.
   */
  githubImportIssue(request: GitHubImportRequest): Promise<GitHubImportResultDto>;
  /**
   * E10.3 (#37): open a PR whose body links the durable Evidence Bundle receipt
   * named by `evidenceBundleId`. The server reads the receipt and runs the E6
   * adapter's live `pr.create` policy gate.
   */
  githubOpenPullRequest(request: GitHubOpenPrRequest): Promise<GitHubPullRequestDto>;
}

export function createFactoryClient(options: FactoryClientOptions): FactoryClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // GET routes are the declared-public read boundary (E10.4), so the bearer
    // credential is attached to non-GET requests only — it never rides along
    // on reads, and it is never logged.
    const headers: Record<string, string> = {};
    if (options.token && method !== 'GET') headers.authorization = `Bearer ${options.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetchImpl(`${base}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      throw new FactoryApiError(
        response.status,
        error?.code ?? 'HTTP_ERROR',
        error?.message ?? `HTTP ${response.status}`,
      );
    }
    return payload as T;
  }

  return {
    health: () => request<HealthDto>('GET', '/health'),
    handshake: () => request<HandshakeDto>('GET', '/handshake'),

    async submitWorkOrder(intent): Promise<WorkOrder> {
      const { workOrder } = await request<{ workOrder: WorkOrder }>('POST', '/work-orders', intent);
      return workOrder;
    },
    async listWorkOrders(): Promise<WorkOrder[]> {
      const { workOrders } = await request<{ workOrders: WorkOrder[] }>('GET', '/work-orders');
      return workOrders;
    },
    getWorkOrder: (id) => request<WorkOrderSnapshotDto>('GET', `/work-orders/${id}`),
    async transitionWorkOrder(id, transition): Promise<WorkOrder> {
      const { workOrder } = await request<{ workOrder: WorkOrder }>(
        'POST',
        `/work-orders/${id}/transition`,
        transition,
      );
      return workOrder;
    },
    async applyGate(id, decision): Promise<WorkOrder> {
      const { workOrder } = await request<{ workOrder: WorkOrder }>('POST', `/work-orders/${id}/decision`, {
        decision,
      });
      return workOrder;
    },
    commitDag: (id, payload) =>
      request<CommitDagResultDto>('POST', `/work-orders/${id}/dag`, payload),
    async listInteractions(status): Promise<InteractionDto[]> {
      const query = status === undefined ? '' : `?status=${encodeURIComponent(status)}`;
      const { interactions } = await request<{ interactions: InteractionDto[] }>(
        'GET',
        `/interactions${query}`,
      );
      return interactions;
    },
    answerInteraction: (id, response, actor) =>
      request<AnswerResultDto>('POST', `/interactions/${id}/answer`, {
        response,
        ...(actor ? { actor } : {}),
      }),
    async listApprovals(status): Promise<ApprovalRecord[]> {
      const query = status === undefined ? '' : `?status=${encodeURIComponent(status)}`;
      const { approvals } = await request<{ approvals: ApprovalRecord[] }>(
        'GET',
        `/approvals${query}`,
      );
      return approvals;
    },
    async answerApproval(id, answer): Promise<ApprovalRecord> {
      const { approval } = await request<{ approval: ApprovalRecord }>(
        'POST',
        `/approvals/${id}/answer`,
        answer,
      );
      return approval;
    },
    schedulerStatus: () => request<SchedulerStatusDto>('GET', '/scheduler'),
    observatory: () => request<ObservatoryDto>('GET', '/observatory'),
    drillDown: (workOrderId) =>
      request<DrillDownDto>('GET', `/observatory/work-orders/${workOrderId}/drill-down`),
    factoryControls: () => request<FactoryControlsDto>('GET', '/factory/controls'),
    emergencyStop: (actor) =>
      request<FactoryControlsDto>('POST', '/factory/emergency-stop', { actor }),
    pause: (actor) => request<FactoryControlsDto>('POST', '/factory/pause', { actor }),
    resume: (actor) => request<FactoryControlsDto>('POST', '/factory/resume', { actor }),
    githubImportIssue: (input) =>
      request<GitHubImportResultDto>('POST', '/github/import', input),
    githubOpenPullRequest: (input) =>
      request<GitHubPullRequestDto>('POST', '/github/pull-requests', input),
  };
}
