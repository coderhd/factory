import type { WorkOrder, WorkOrderIntent, WorkOrderTransition } from '../domain/workOrder';
import type { DAGProposalPayload } from '../planning/dag';
import type {
  AnswerResultDto,
  CommitDagResultDto,
  DrillDownDto,
  GateDecision,
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
  answerInteraction(id: string, response: string): Promise<AnswerResultDto>;
  schedulerStatus(): Promise<SchedulerStatusDto>;
  observatory(): Promise<ObservatoryDto>;
  drillDown(workOrderId: string): Promise<DrillDownDto>;
}

export function createFactoryClient(options: FactoryClientOptions): FactoryClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${base}/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
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
    answerInteraction: (id, response) =>
      request<AnswerResultDto>('POST', `/interactions/${id}/answer`, { response }),
    schedulerStatus: () => request<SchedulerStatusDto>('GET', '/scheduler'),
    observatory: () => request<ObservatoryDto>('GET', '/observatory'),
    drillDown: (workOrderId) =>
      request<DrillDownDto>('GET', `/observatory/work-orders/${workOrderId}/drill-down`),
  };
}
