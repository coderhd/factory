import { FactoryError } from '../domain/errors';
import {
  createWorkOrder,
  transitionTask,
  transitionWorkOrder,
  type Task,
  type WorkOrder,
  type WorkOrderIntent,
  type WorkOrderState,
} from '../domain/workOrder';
import type { EventLog } from '../events/log';
import { projectDrillDown, projectObservatory, type EvidenceReadPort } from '../observatory/observatory';
import { commitDAG, getActiveDAG, proposeDAG, type DAGProposalPayload } from '../planning/dag';
import { answerApproval, type ApprovalRecord } from '../policy/policy';
import type { Scheduler } from '../scheduler/scheduler';
import type { StateStore } from '../state/store';
import {
  API_VERSION,
  type AnswerResultDto,
  type ApiErrorDto,
  type ApprovalAnswerRequest,
  type ApprovalsDto,
  type CommitDagResultDto,
  type GateDecision,
  type HandshakeDto,
  type HealthDto,
  type InteractionDto,
  type ObservatoryDto,
  type WorkOrderSnapshotDto,
} from './contract';

/**
 * The E2 Factory API server (spec §6, §22). The server is the sole mutation
 * authority: every write goes through Factory-owned transitions/scheduler, and
 * clients only ever call these endpoints. Built on Bun's HTTP server + a plain
 * `Request`/`Response` handler — no framework.
 *
 * The handler is a pure function of the request and the injected deps, so the
 * core surface is testable in-process; `startFactoryServer` adds a real
 * loopback listener for the CLI/client path.
 */

export interface FactoryServerDeps {
  store: StateStore;
  events: EventLog;
  /** R2 evidence read seam (E5 supplies the concrete reader). */
  evidence: EvidenceReadPort;
  /** Optional E3 scheduler; exposes its status projection when present. */
  scheduler?: Scheduler;
  version?: string;
  schemaVersion?: string;
  instanceId?: string;
  now?: () => string;
}

export type ApiHandler = (request: Request) => Promise<Response>;

export interface RunningFactoryServer {
  hostname: string;
  port: number;
  url: string;
  stop(): void;
}

const STATUS_BY_CODE: Record<string, number> = {
  INTERACTION_NOT_FOUND: 404,
  WORK_ORDER_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  ATTEMPT_NOT_FOUND: 404,
  WORKER_NOT_FOUND: 404,
  APPROVAL_NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  INTERACTION_ALREADY_ANSWERED: 409,
  APPROVAL_SPENT: 409,
  TASK_NOT_WAITING_INPUT: 409,
  TASK_NOT_READY: 409,
  WORKER_NOT_IDLE: 409,
  APPROVAL_ACTOR_REQUIRED: 400,
  DAG_INVALID: 422,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function apiError(code: string, message: string, status: number): Response {
  const body: ApiErrorDto = { error: { code, message } };
  return json(body, status);
}

function errorStatus(code: string): number {
  return STATUS_BY_CODE[code] ?? 500;
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

const GATE_TRANSITIONS: Record<GateDecision, WorkOrderState> = {
  APPROVE: 'APPROVED',
  REWORK: 'REWORK',
  REJECT: 'REJECTED',
};

/**
 * Answer a PENDING §12 interaction and resume its Task (spec §12). The answer
 * is persisted and the Task transitions `WAITING_INPUT → RUNNING` through E1's
 * Factory-owned transition; the scheduler then collects the still-open Attempt
 * on a later tick.
 *
 * This is the durable, state-level resume. There is deliberately no WO-level
 * `WAITING_INPUT` here: a Work Order only asks through its Tasks, so the resume
 * unit is the Task (spec §5.2). The answer is also pushed into the live runtime
 * (`WorkerAdapter.deliverAnswer`) so the worker can continue rather than sit
 * parked with its answered question; delivery is attempted only when a
 * scheduler/runtime is wired.
 */
async function answerInteraction(
  deps: FactoryServerDeps,
  interactionId: string,
  response: string,
): Promise<AnswerResultDto> {
  const now = deps.now?.() ?? new Date().toISOString();
  const record = deps.store.get<InteractionDto>('interactions', interactionId);
  if (!record) {
    throw new FactoryError('INTERACTION_NOT_FOUND', `interaction not found: ${interactionId}`);
  }
  if (record.status !== 'PENDING') {
    throw new FactoryError(
      'INTERACTION_ALREADY_ANSWERED',
      `interaction ${interactionId} is already ${record.status}`,
    );
  }
  const task = deps.store.get<Task>('tasks', record.taskId);
  if (!task) {
    throw new FactoryError('TASK_NOT_FOUND', `task not found: ${record.taskId}`);
  }
  if (task.state !== 'WAITING_INPUT') {
    throw new FactoryError(
      'TASK_NOT_WAITING_INPUT',
      `task ${task.id} is ${task.state}; nothing to resume`,
    );
  }

  const answered: InteractionDto = {
    ...record,
    status: 'ANSWERED',
    response,
    answeredAt: now,
    answeredBy: 'human',
    updatedAt: now,
  };
  let updatedTask = task;
  const workOrder = deps.store.get<WorkOrder>('work_orders', task.workOrderId) ?? null;

  deps.store.db.transaction(() => {
    deps.store.set('interactions', interactionId, answered);
    deps.events.appendEvent({
      type: 'interaction.answered',
      aggregateType: 'interaction',
      aggregateId: interactionId,
      payload: { interaction: answered, response },
    });
    updatedTask = transitionTask(deps, task.id, {
      to: 'RUNNING',
      reason: 'human answered interaction',
    });
  })();

  // Deliver the answer into the live runtime (E9.5). The durable answer above is
  // the source of truth; this is the channel that lets the worker continue. The
  // worker holds an open assignment for a `waiting_input` Attempt, so it is
  // present; a delivery failure is surfaced, never swallowed.
  if (deps.scheduler) {
    await deps.scheduler.deliverAnswer(record.workerId, {
      interactionId,
      question: record.question,
      response,
    });
  }

  return { interaction: answered, task: updatedTask, workOrder };
}

/**
 * Answer a PENDING E7 approval (spec §13). The approval ledger and the answer
 * receipt are E7's (`answerApproval`); this route is only the server-side entry
 * point that keeps the server the sole mutation authority. An `APPROVAL` is
 * consumed (spent) by the *next* matching policy decision, not here.
 */
function answerApprovalRoute(
  deps: FactoryServerDeps,
  approvalId: string,
  body: ApprovalAnswerRequest,
): ApprovalRecord {
  const now = deps.now ?? (() => new Date().toISOString());
  return answerApproval(
    { store: deps.store, events: deps.events, now },
    approvalId,
    {
      decision: body.decision,
      actor: body.actor,
      ...(body.comment ? { comment: body.comment } : {}),
    },
  );
}

/** The pure request handler: the entire server surface, no socket required. */
export function createApiHandler(deps: FactoryServerDeps): ApiHandler {
  const startedAt = Date.now();
  const instanceId = deps.instanceId ?? `factory_${crypto.randomUUID()}`;
  const version = deps.version ?? '0.1.0';
  const schemaVersion = deps.schemaVersion ?? '1';
  const now = deps.now ?? (() => new Date().toISOString());

  const handshake = (): HandshakeDto => ({
    instanceId,
    version,
    apiVersion: API_VERSION,
    schemaVersion,
    capabilities: ['work_orders', 'interactions', 'approvals', 'observatory', 'scheduler'],
  });

  return async function handle(request: Request): Promise<Response> {
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof FactoryError) {
        return apiError(error.code, error.message, errorStatus(error.code));
      }
      return apiError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error), 500);
    }
  };

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const method = request.method.toUpperCase();

    if (segments[0] !== 'api') return apiError('NOT_FOUND', `no route for ${url.pathname}`, 404);
    const [resource, id, action] = [segments[1], segments[2], segments[3]];

    if (resource === 'health' && method === 'GET' && id === undefined) {
      const health: HealthDto = {
        status: 'ok',
        instanceId,
        version,
        apiVersion: API_VERSION,
        schemaVersion,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      };
      return json(health);
    }

    if (resource === 'handshake' && method === 'GET' && id === undefined) {
      return json(handshake());
    }

    if (resource === 'scheduler' && method === 'GET' && id === undefined) {
      if (!deps.scheduler) return apiError('NOT_FOUND', 'scheduler not configured', 404);
      return json({ scheduler: deps.scheduler.status() });
    }

    if (resource === 'observatory') {
      if (method === 'GET' && id === undefined) {
        const dto: ObservatoryDto = {
          generatedAt: now(),
          ...projectObservatory(deps.evidence),
        };
        return json(dto);
      }
      if (method === 'GET' && id === 'work-orders' && action !== undefined) {
        const workOrderId = segments[3];
        const tail = segments[4];
        if (tail === 'drill-down') {
          const drillDown = projectDrillDown(deps.evidence, deps.store, workOrderId);
          if (!drillDown) {
            return apiError('WORK_ORDER_NOT_FOUND', `work order not found: ${workOrderId}`, 404);
          }
          return json(drillDown);
        }
      }
    }

    if (resource === 'work-orders') {
      if (method === 'GET' && id === undefined) {
        return json({ workOrders: deps.store.list<WorkOrder>('work_orders') });
      }
      if (method === 'POST' && id === undefined) {
        const body = await readJson<Record<string, unknown>>(request);
        if (!body) return apiError('INVALID_JSON', 'request body must be JSON', 400);
        const intent = typeof body.intent === 'string' ? body.intent.trim() : '';
        if (intent.length === 0) return apiError('INVALID_REQUEST', 'intent is required', 400);
        // Client-supplied riskTier/state are deliberately ignored: the Factory
        // starts every Work Order DRAFT/YELLOW (spec §13.1; sole authority).
        const workOrderIntent: WorkOrderIntent = {
          intent,
          acceptanceCriteria: stringArray(body.acceptanceCriteria),
          constraints: stringArray(body.constraints),
          outOfScope: stringArray(body.outOfScope),
          repository: typeof body.repository === 'string' ? body.repository : undefined,
          requiredVerification: stringArray(body.requiredVerification),
        };
        return json({ workOrder: createWorkOrder(deps, workOrderIntent) }, 201);
      }
      if (method === 'GET' && id !== undefined && action === undefined) {
        const workOrder = deps.store.get<WorkOrder>('work_orders', id);
        if (!workOrder) return apiError('WORK_ORDER_NOT_FOUND', `work order not found: ${id}`, 404);
        const tasks = deps.store.list<Task>('tasks').filter((task) => task.workOrderId === id);
        const taskIds = new Set(tasks.map((task) => task.id));
        const snapshot: WorkOrderSnapshotDto = {
          workOrder,
          tasks,
          attempts: deps.store
            .list<{ taskId: string }>('attempts')
            .filter((attempt) => taskIds.has(attempt.taskId)) as WorkOrderSnapshotDto['attempts'],
          interactions: deps.store
            .list<InteractionDto>('interactions')
            .filter((interaction) => taskIds.has(interaction.taskId)),
          dag: getActiveDAG(deps, id),
        };
        return json(snapshot);
      }
      if (method === 'POST' && id !== undefined && action === 'transition') {
        const body = await readJson<{ to?: string; reason?: string }>(request);
        if (!body || typeof body.to !== 'string') {
          return apiError('INVALID_REQUEST', 'transition requires "to"', 400);
        }
        const workOrder = transitionWorkOrder(deps, id, {
          to: body.to as WorkOrderState,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        });
        return json({ workOrder });
      }
      if (method === 'POST' && id !== undefined && action === 'decision') {
        const body = await readJson<{ decision?: string }>(request);
        const decision = body?.decision as GateDecision | undefined;
        if (!decision || !(decision in GATE_TRANSITIONS)) {
          return apiError('INVALID_REQUEST', 'decision must be APPROVE, REWORK or REJECT', 400);
        }
        const workOrder = transitionWorkOrder(deps, id, { to: GATE_TRANSITIONS[decision] });
        return json({ workOrder });
      }
      if (method === 'POST' && id !== undefined && action === 'dag') {
        const body = await readJson<DAGProposalPayload>(request);
        if (!body || typeof body !== 'object') {
          return apiError('INVALID_REQUEST', 'dag requires a JSON proposal payload', 400);
        }
        // Planner proposes, Factory commits (spec §7.1): record the advisory
        // proposal, then commit through E3. Both are Factory-owned; an invalid
        // payload throws DAG_INVALID (422) after one rejection event, nothing
        // else written. The route never touches tasks/edges directly.
        const proposal = proposeDAG(deps, id, body);
        const dag = commitDAG(deps, id, body);
        const result: CommitDagResultDto = { proposal, dag };
        return json(result, 201);
      }
    }

    if (resource === 'interactions') {
      if (method === 'GET' && id === undefined) {
        const status = url.searchParams.get('status');
        const interactions = deps.store
          .list<InteractionDto>('interactions')
          .filter((interaction) => status === null || interaction.status === status);
        return json({ interactions });
      }
      if (method === 'POST' && id !== undefined && action === 'answer') {
        const body = await readJson<{ response?: unknown }>(request);
        const response = typeof body?.response === 'string' ? body.response : null;
        if (response === null || response.trim().length === 0) {
          return apiError('INVALID_REQUEST', 'response is required', 400);
        }
        return json(await answerInteraction(deps, id, response));
      }
    }

    if (resource === 'approvals') {
      if (method === 'GET' && id === undefined) {
        const status = url.searchParams.get('status');
        const approvals = deps.store
          .list<ApprovalRecord>('interactions')
          .filter((row) => row.type === 'APPROVAL')
          .filter((row) => status === null || row.status === status);
        const dto: ApprovalsDto = { approvals };
        return json(dto);
      }
      if (method === 'POST' && id !== undefined && action === 'answer') {
        const body = await readJson<Partial<ApprovalAnswerRequest>>(request);
        const decision = body?.decision;
        if (decision !== 'APPROVAL' && decision !== 'DENY') {
          return apiError('INVALID_REQUEST', 'decision must be APPROVAL or DENY', 400);
        }
        const actor = typeof body?.actor === 'string' ? body.actor.trim() : '';
        if (actor.length === 0) return apiError('APPROVAL_ACTOR_REQUIRED', 'actor is required', 400);
        const comment = typeof body?.comment === 'string' ? body.comment : undefined;
        const approval = answerApprovalRoute(deps, id, {
          decision,
          actor,
          ...(comment ? { comment } : {}),
        });
        return json({ approval });
      }
    }

    return apiError('NOT_FOUND', `no route for ${method} ${url.pathname}`, 404);
  }
}

/** Start the API on a real (loopback by default) listener. */
export function startFactoryServer(
  deps: FactoryServerDeps,
  options: { port?: number; hostname?: string } = {},
): RunningFactoryServer {
  const hostname = options.hostname ?? '127.0.0.1';
  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    fetch: createApiHandler(deps),
  });
  return {
    hostname,
    port: server.port,
    url: `http://${hostname}:${server.port}`,
    stop(): void {
      server.stop(true);
    },
  };
}
