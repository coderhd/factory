import { FactoryError } from '../domain/errors';
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
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
import { PolicyBlockedError, PrBaseBlockedError, type EvidenceReceipt, type GitHubAdapter } from '../github/adapter';
import type { EvidenceBundle } from '../evidence/bundle';
import type { EvidenceReadPort } from '../observatory/observatory';
import { commitDAG, getActiveDAG, proposeDAG, type DAGProposalPayload } from '../planning/dag';
import {
  answerApproval,
  emergencyStop,
  factoryControlState,
  pauseFactory,
  resumeFactory,
  type ApprovalRecord,
} from '../policy/policy';
import type { Orchestrator, OrchestratorRequest } from '../orchestrator/orchestrator';
import type { ReadyTicketPoller } from '../github/poller';
import type { Scheduler } from '../scheduler/scheduler';
import type { StateStore } from '../state/store';
import {
  projectDrillDown as projectTelemetryDrillDown,
  projectTelemetryMetrics,
} from '../telemetry/telemetry';
import {
  API_VERSION,
  type AnswerResultDto,
  type ApiErrorDto,
  type ApprovalAnswerRequest,
  type ApprovalsDto,
  type CommitDagResultDto,
  type FactoryControlsDto,
  type GateDecision,
  type GitHubImportRequest,
  type GitHubImportResultDto,
  type GitHubOpenPrRequest,
  type GitHubPullRequestDto,
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
  /**
   * E10.3 (#37) the E6 GitHub adapter, composed by `buildServerDeps` with the
   * live E7 policy and durable evidence reader. Only the two operator routes
   * below use it. Absent, those routes 404 — no ungoverned GitHub path is ever
   * exposed, and the transport is mocked in tests (Ruling R6).
   */
  github?: GitHubAdapter;
  version?: string;
  schemaVersion?: string;
  instanceId?: string;
  /**
   * E10.4 (#40) control-plane authentication. Configured, every mutating route
   * requires `Authorization: Bearer <token>` and the human-action actor is the
   * configured principal (a request-body actor is ignored). Absent, the trust
   * boundary is the loopback bind — documented in compose.yaml/§20.
   */
  auth?: ServerAuth;
  /**
   * E12 (#48) the natural-language orchestrator, composed by `buildServerDeps`
   * from the resolved `orchestrator:` config. Its tool surface is a client
   * pointed at this server's own API, so the server stays the sole mutation
   * authority. Absent, `POST /api/orchestrator/message` 503s (fail closed) —
   * the orchestrator is never invoked some other way.
   */
  orchestrator?: Orchestrator;
  /**
   * E12 (#48) the GitHub "ready ticket" poller, composed by `buildServerDeps`
   * when the resolved `orchestrator.poller` is configured and a GitHub adapter
   * exists to list/import through. `cmdServe` owns its start/stop lifecycle
   * (like `scheduler`); the API surface does not touch it. Absent, nothing is
   * polled — imports stay manual (`factory github import`).
   */
  poller?: ReadyTicketPoller;
  now?: () => string;
}

/** The shared bearer credential and the operator identity it authenticates. */
export interface ServerAuth {
  token: string;
  actor: string;
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
  OPERATOR_REQUIRED: 400,
  DAG_INVALID: 422,
  // E10.3 (#37) GitHub operator surface.
  GITHUB_NOT_CONFIGURED: 404,
  EVIDENCE_BUNDLE_NOT_FOUND: 404,
  INVALID_GITHUB_REQUEST: 400,
  GITHUB_POLICY_BLOCKED: 403,
  GITHUB_UNAVAILABLE: 502,
  // E12 (#48) the natural-language orchestrator is not composed on this server.
  ORCHESTRATOR_DISABLED: 503,
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

// ---------------------------------------------------------------------------
// E10.4 (#40) — the auth boundary (bearer token, §20)
// ---------------------------------------------------------------------------

/** Extract the bearer credential from the Authorization header (no logging). */
function bearerToken(request: Request): string | null {
  const header = (request.headers.get('authorization') ?? '').trim();
  const match = /^Bearer[ ]+(.+)$/i.exec(header);
  return match ? match[1]! : null;
}

/** Constant-time token comparison; unequal lengths still burn a comparison. */
function tokensEqual(presented: string, configured: string): boolean {
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(configured, 'utf8');
  if (left.length !== right.length) {
    // Equal-burn: compare equal-length buffers so the call's timing does not
    // leak the configured token's length.
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
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
  actor?: string,
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
    // The operator identity when supplied; `'human'` is the historical default.
    answeredBy: actor ?? 'human',
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
 *
 * An answer is final: once `ANSWERED` (or `SPENT`) it may not be re-answered —
 * otherwise a second answer would silently overwrite the first (last-writer-
 * wins), letting a later `DENY` supersede a recorded `APPROVAL` or vice versa.
 * A correction therefore requires a new approval park.
 */
function answerApprovalRoute(
  deps: FactoryServerDeps,
  approvalId: string,
  body: ApprovalAnswerRequest,
): ApprovalRecord {
  const existing = deps.store.get<ApprovalRecord>('interactions', approvalId);
  if (existing && existing.type === 'APPROVAL' && existing.status !== 'PENDING') {
    throw new FactoryError(
      'APPROVAL_SPENT',
      `approval ${approvalId} is already ${existing.status}; a correction requires a new approval`,
    );
  }
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
    capabilities: [
      'work_orders',
      'interactions',
      'approvals',
      'observatory',
      'scheduler',
      'controls',
    ],
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

    // E10.4 (#40) auth boundary. When auth is configured: GET stays public
    // (documented read-only decision), every mutating method requires a valid
    // bearer credential, and the human-action actor is the **authenticated
    // principal** — a body-supplied actor is never trusted. The credential and
    // header are never logged. Absent auth, the loopback bind is the boundary
    // and the historical body-actor behavior holds.
    const authenticatedActor =
      deps.auth !== undefined &&
      // Gestalt check, not just token equality: an empty/short credential can't
      // be a real token, and `tokensEqual('', '')` would otherwise authenticate
      // headerless requests against a programmatically-configured empty token.
      bearerToken(request) !== null &&
      bearerToken(request)!.length >= 24 &&
      deps.auth.token.length >= 24 &&
      tokensEqual(bearerToken(request)!, deps.auth.token)
        ? deps.auth.actor
        : undefined;
    if (deps.auth !== undefined && authenticatedActor === undefined && method !== 'GET') {
      return apiError(
        'UNAUTHENTICATED',
        'mutating requests require a valid bearer credential',
        401,
      );
    }

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

    // E9.6 factory-level controls (spec §10/§18.11). The durable flag + event
    // are E7's (`emergencyStop`/`pauseFactory`/`resumeFactory`); these routes
    // are only the operator entry point, so the server stays the sole mutation
    // authority. The live scheduler observes the durable flag on its next tick.
    if (resource === 'factory') {
      if (method === 'GET' && id === 'controls') {
        const state = factoryControlState({ events: deps.events });
        const dto: FactoryControlsDto = { paused: state.paused, emergencyStopped: state.emergencyStopped };
        return json(dto);
      }
      if (method === 'POST' && id !== undefined && action === undefined) {
        const body = await readJson<{ actor?: unknown }>(request);
        // E10.4 (#40): authenticated deployments take the operator from the
        // bearer credential, never the body; open (loopback) mode keeps the
        // body actor.
        const bodyActor = typeof body?.actor === 'string' ? body.actor.trim() : '';
        const actor = authenticatedActor ?? bodyActor;
        if (actor.length === 0) return apiError('OPERATOR_REQUIRED', 'actor is required', 400);
        const controlDeps = { store: deps.store, events: deps.events, now };
        const state =
          id === 'emergency-stop'
            ? emergencyStop(controlDeps, { actor })
            : id === 'pause'
              ? pauseFactory(controlDeps, { actor })
              : id === 'resume'
                ? resumeFactory(controlDeps, { actor })
                : null;
        if (!state) return apiError('NOT_FOUND', `no route for ${method} ${url.pathname}`, 404);
        const dto: FactoryControlsDto = { paused: state.paused, emergencyStopped: state.emergencyStopped };
        return json(dto);
      }
    }

    // E12 (#48) natural-language orchestrator. A thin, mutating (POST) entry
    // point onto the composed `Orchestrator`; it is gated by the auth block
    // above like every other non-GET route. The whole bounded tool loop lives
    // behind `deps.orchestrator`, whose client points at this same API — so
    // every action the orchestrator proposes still passes through the Factory's
    // gates and the server remains the sole mutation authority. Absent a
    // composed orchestrator, the route 503s (fail closed).
    if (
      resource === 'orchestrator' &&
      method === 'POST' &&
      id === 'message' &&
      action === undefined
    ) {
      if (!deps.orchestrator) {
        return apiError('ORCHESTRATOR_DISABLED', 'orchestrator is not configured', 503);
      }
      const body = await readJson<OrchestratorRequest>(request);
      if (!body) return apiError('INVALID_JSON', 'request body must be JSON', 400);
      return json(await deps.orchestrator.handle(body));
    }

    if (resource === 'observatory') {
      if (method === 'GET' && id === undefined) {
        // E9.7: the Observatory projection is E8's, over the same store/evidence
        // seam — verified/day + throughput/human-hour from real evidence bundles,
        // plus rework and recorded cost. Never fabricates: an empty Factory is
        // zero/[], not invented data.
        const dto: ObservatoryDto = projectTelemetryMetrics({
          store: deps.store,
          events: deps.events,
          evidence: deps.evidence,
        });
        return json(dto);
      }
      if (method === 'GET' && id === 'work-orders' && action !== undefined) {
        const workOrderId = segments[3];
        const tail = segments[4];
        if (tail === 'drill-down') {
          // E9.7: the full §23 chain from E8's projection (trace resolves from
          // recorded telemetry; verification/evidence from E5's durable rows).
          const drillDown = projectTelemetryDrillDown(
            { store: deps.store, events: deps.events, evidence: deps.evidence },
            workOrderId,
          );
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
          // Question-only: the `interactions` collection also holds E7 approval
          // ledgers, which are answered through `/approvals`. Mixing them would
          // let a CLI `wo answer` pick up an approval id.
          .filter((interaction) => interaction.type === 'QUESTION')
          .filter((interaction) => status === null || interaction.status === status);
        return json({ interactions });
      }
      if (method === 'POST' && id !== undefined && action === 'answer') {
        const body = await readJson<{ response?: unknown; actor?: unknown }>(request);
        const response = typeof body?.response === 'string' ? body.response : null;
        if (response === null || response.trim().length === 0) {
          return apiError('INVALID_REQUEST', 'response is required', 400);
        }
        // E10.4 (#40): the answering operator is the authenticated principal
        // when auth is configured; otherwise a body actor (loopback mode).
        const actor =
          authenticatedActor ??
          (typeof body?.actor === 'string' ? body.actor.trim() : undefined);
        return json(await answerInteraction(deps, id, response, actor || undefined));
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
        // E10.4 (#40): the receipt actor is the authenticated principal in
        // authenticated deployments; open (loopback) mode keeps the body actor
        // and its required non-empty check below.
        const actor = authenticatedActor ?? (typeof body?.actor === 'string' ? body.actor.trim() : '');
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

    if (resource === 'github') {
      const adapter = deps.github;
      if (!adapter) return apiError('GITHUB_NOT_CONFIGURED', 'github adapter is not configured', 404);

      // POST /api/github/import { repository, number } — issue → Work Order.
      if (method === 'POST' && id === 'import' && action === undefined) {
        const body = await readJson<Partial<GitHubImportRequest>>(request);
        const repository = typeof body?.repository === 'string' ? body.repository.trim() : '';
        const number = typeof body?.number === 'number' ? body.number : Number(body?.number);
        if (repository.length === 0 || !Number.isInteger(number) || number <= 0) {
          return apiError(
            'INVALID_GITHUB_REQUEST',
            'import requires { repository: "owner/name", number: <positive integer> }',
            400,
          );
        }
        try {
          const result: GitHubImportResultDto = await adapter.importIssue({ repository, number });
          return json(result, result.created ? 201 : 200);
        } catch (error) {
          if (error instanceof PolicyBlockedError) {
            return apiError('GITHUB_POLICY_BLOCKED', error.message, 403);
          }
          return apiError(
            'GITHUB_UNAVAILABLE',
            error instanceof Error ? error.message : String(error),
            502,
          );
        }
      }

      // POST /api/github/pull-requests { evidenceBundleId } — open a PR whose
      // body links the **durable** evidence receipt. The route reads the bundle
      // by id from the store: a caller cannot present a bundle that was never
      // persisted, and the adapter runs its `pr.create` policy gate.
      if (method === 'POST' && id === 'pull-requests' && action === undefined) {
        const body = await readJson<Partial<GitHubOpenPrRequest>>(request);
        const evidenceBundleId =
          typeof body?.evidenceBundleId === 'string' ? body.evidenceBundleId.trim() : '';
        if (evidenceBundleId.length === 0) {
          return apiError(
            'INVALID_GITHUB_REQUEST',
            'opening a pull request requires { evidenceBundleId }',
            400,
          );
        }
        const evidence = deps.store.get<EvidenceBundle>('evidence_bundles', evidenceBundleId);
        if (!evidence) {
          return apiError(
            'EVIDENCE_BUNDLE_NOT_FOUND',
            `evidence bundle not found: ${evidenceBundleId}`,
            404,
          );
        }
        const receipt: EvidenceReceipt = evidence;
        const openOptions: { baseBranch?: string; title?: string } = {};
        if (typeof body?.baseBranch === 'string' && body.baseBranch.trim().length > 0) {
          openOptions.baseBranch = body.baseBranch.trim();
        }
        if (typeof body?.title === 'string' && body.title.trim().length > 0) {
          openOptions.title = body.title.trim();
        }
        try {
          const pr: GitHubPullRequestDto = await adapter.openPR(receipt, openOptions);
          return json(pr, 201);
        } catch (error) {
          if (error instanceof PolicyBlockedError || error instanceof PrBaseBlockedError) {
            return apiError('GITHUB_POLICY_BLOCKED', error.message, 403);
          }
          return apiError(
            'GITHUB_UNAVAILABLE',
            error instanceof Error ? error.message : String(error),
            502,
          );
        }
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
  // `Bun.serve` always assigns a concrete port (including for `port: 0`), but
  // its type is optional. Fail loudly rather than advertise "undefined".
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new FactoryError('SERVER_PORT_UNAVAILABLE', 'Bun.serve did not report a bound port');
  }
  return {
    hostname,
    port,
    url: `http://${hostname}:${port}`,
    stop(): void {
      server.stop(true);
    },
  };
}
