import {
  completeAttempt,
  transitionTask,
  transitionWorkOrder,
  type Attempt,
  type Task,
  type WorkOrder,
} from '../domain/workOrder';
import type { WorkVerifier, VerificationOutcome } from '../verification/orchestrator';
import type { EventLog } from '../events/log';
import { getActiveDAG, type DAGVersion } from '../planning/dag';
import { createEvidenceReadPort, type EvidenceReadPort } from '../observatory/observatory';
import { changedPathsFromDiff, isEmergencyStopped, isFactoryPaused } from '../policy/policy';
import {
  encodeFailure,
  recover,
  RESOURCE_UNAVAILABLE,
  type FailureContext,
} from '../recovery/recovery';
import { routeAssignment } from '../routing/assignment';
import type { BudgetState, ModelId } from '../routing/decisionModel';
import { persistRoutingDecision } from '../routing/persist';
import { RoutingBlockedError, toRoutingDecisionRecord } from '../routing/rules';
import type { ArtifactStore, StateStore } from '../state/store';
import { recordAttemptTelemetry, TELEMETRY_ATTEMPT_RECORDED } from '../telemetry/telemetry';
import type { WorkerAnswer, WorkerInteraction, WorkerResult } from '../workers/herdr';
import {
  assign,
  dispatchReopenedAttempt,
  openAssignmentFor,
  reopenAttempt,
  startTask,
  type AssignmentRecord,
  type WorkerManager,
  type WorkerProfile,
  type WorkerRecord,
} from '../workers/manager';
import type { WorktreeManager } from '../worktrees/worktree';
import { taskWorktreeBranch } from '../worktrees/worktree';

/**
 * E3.2 capacity- and policy-aware scheduler (spec §7.2). In-process and
 * tick-driven; the queue is derived from durable state on every tick, so a
 * crash loses nothing. One tick opens with a collect step and then runs the
 * unblock, reclaim, provision and assign passes in that order.
 */

export type PolicyVerdict = 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN';

export interface SchedulerPolicy {
  canAssign(task: Task, workOrder: WorkOrder): PolicyVerdict;
  /**
   * E9.8 write-time path gate (RE6): given the changed paths a SUCCESS change
   * set touches, authorize each as a `repo.write` on the Task's worktree branch.
   * The assignment gate binds `path:'**'` for the whole worktree; this is the
   * enforcement against the *actual* paths — the embedded `infra/**` exclusion.
   * Absent, the write-time gate is not enforced (production wires it).
   */
  canWriteChangeSet?(
    task: Task,
    workOrder: WorkOrder,
    branch: string,
    paths: string[],
  ): { allowed: boolean; denied: string[] };
}

export interface SchedulerConfig {
  maxConcurrentTasks: number;
  tickIntervalMs: number;
  provisioning: {
    enabled: boolean;
    min: number;
    max: number;
    idleTimeoutMs: number;
    defaultProfile: WorkerProfile;
  };
}

export interface SchedulerDeps {
  store: StateStore;
  events: EventLog;
  workers: WorkerManager;
  worktrees: WorktreeManager;
  policy?: SchedulerPolicy;
  now?: () => string;
  /** Local repo the scheduler creates per-Task worktrees from (v0.1 local). */
  repoPath?: string;
  /** Evidence sink for worker artifacts (§6.4); optional store seam. */
  artifacts?: ArtifactStore;
  /** Lease TTL for `startTask` heartbeats; defaults to `idleTimeoutMs`. */
  leaseTtlMs?: number;
  /**
   * E4 routing gates the assignment pass routes with (E9.3): the budget
   * snapshot and the unavailable model set. Both default to "no signal"
   * (`FULL_BUDGET`, none unavailable), which routes purely on capability.
   */
  routing?: SchedulerRouting;
  /**
   * E9.4 verification seam. When wired, a Task reaching SUCCESS is verified by
   * the E5 tiers and its Evidence Bundle is persisted before the Task/WO may
   * advance. Absent, verification fails closed: a SUCCESS Task is never
   * promoted (no silent pass).
   */
  verifier?: WorkVerifier;
  /**
   * E9.7 telemetry read port. When wired (production: the server's store-backed
   * evidence reader), the per-Attempt receipt derives its human-leverage layer
   * from the same reader the Observatory uses. Absent, a store-backed reader is
   * built locally; either way the receipt is derived, never fabricated.
   */
  telemetry?: { evidence: EvidenceReadPort };
}

/** E4 routing signals for the assignment pass (RE7(b)). */
export interface SchedulerRouting {
  budget?: BudgetState;
  unavailable?: ModelId[];
}

export interface SchedulerStatus {
  /** True while the interval tick loop is running (`start()`ed, not `stop()`ed). */
  running: boolean;
  /** Configured tick cadence, surfaced so a resolved `factory.yaml` is observable. */
  tickIntervalMs: number;
  concurrency: { current: number; max: number };
  workers: { idle: number; busy: number; reclaimed: number };
  provisioning: { enabled: boolean; min: number; max: number };
  queue: {
    readyTaskIds: string[];
    blocked: Array<{ taskId: string; waitingOnTaskIds: string[] }>;
    blockedPolicy: Array<{ taskId: string; verdict: PolicyVerdict }>;
    /** E9.3: READY tasks a blocked route refused to assign (no model available). */
    blockedRouting: Array<{ taskId: string; candidates: ModelId[]; unavailable: ModelId[] }>;
  };
  activeDAGs: Array<{ workOrderId: string; version: number; nodes: number }>;
}

export interface Scheduler {
  tick(): void;
  start(): void;
  stop(): void;
  status(): SchedulerStatus;
  /**
   * Deliver a human answer into the runtime holding `workerId` (E9.5). The
   * durable interaction is already persisted by the server; this is the live
   * channel that unparks a `waiting_input` runtime.
   */
  deliverAnswer(workerId: string, answer: WorkerAnswer): Promise<void>;
}

/** Event vocabulary for persisted §12 interactions (E1 `<aggregate>.<verb>` style). */
export const INTERACTION_CREATED = 'interaction.created';

/**
 * Diagnostic event appended when an assign→start attempt is compensated: the
 * Assignment is closed, the Worker released and the Task reverted to READY
 * because `startTask` threw after `assign` had committed.
 */
export const ASSIGNMENT_START_FAILED = 'assignment.start_failed';

/**
 * E9.4 diagnostic events. `EVIDENCE_BUNDLE_RECORDED` is appended in the same
 * transaction that persists the immutable bundle, so the receipt and its log
 * entry cannot diverge. `VERIFICATION_FAILED` carries the structured §14.4
 * failures that drove REWORK; `VERIFICATION_REJECTED` records a run refused
 * before any bundle could exist (e.g. writer = verifier) — never a pass.
 */
export const EVIDENCE_BUNDLE_RECORDED = 'evidence.bundle_recorded';
export const VERIFICATION_FAILED = 'verification.failed';
export const VERIFICATION_REJECTED = 'verification.rejected';

/**
 * A persisted §12 interaction: the durable question a `waiting_input` Attempt
 * asks. It is the record E2's answer loop resumes from — the Task's
 * `WAITING_INPUT` state alone carries no question. `attemptId`/`taskId` bind it
 * to the open Attempt; `response` stays `null` until E2 answers.
 */
export interface InteractionRecord {
  id: string;
  type: 'QUESTION';
  taskId: string;
  attemptId: string;
  workerId: string;
  recipient: 'human';
  question: string;
  status: 'PENDING';
  response: null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  maxConcurrentTasks: 3,
  tickIntervalMs: 1000,
  provisioning: {
    enabled: true,
    min: 0,
    max: 5,
    idleTimeoutMs: 10 * 60_000,
    defaultProfile: 'herdr',
  },
};

interface Scope {
  workOrder: WorkOrder;
  dag: DAGVersion;
  tasks: Task[];
}

interface Completion {
  workerId: string;
  result: WorkerResult | null;
  error?: string;
}

/**
 * The fail-closed stand-in for an absent `SchedulerPolicy` (E9.1). A scheduler
 * with no policy must never assign: defaulting to `ALLOW` would silently bypass
 * the §5 policy gate. It DENIES every Task and logs once, loudly, at
 * construction so a misconfigured server is visible in the logs rather than
 * silently starved.
 */
function missingPolicy(): SchedulerPolicy {
  console.error(
    'scheduler: no policy wired (SchedulerDeps.policy is undefined); denying all assignments — wire the E7 policy check',
  );
  return {
    canAssign: (_task, _workOrder) => 'DENY',
  };
}

export function createScheduler(deps: SchedulerDeps, config: Partial<SchedulerConfig> = {}): Scheduler {
  const cfg: SchedulerConfig = {
    maxConcurrentTasks: config.maxConcurrentTasks ?? DEFAULT_CONFIG.maxConcurrentTasks,
    tickIntervalMs: config.tickIntervalMs ?? DEFAULT_CONFIG.tickIntervalMs,
    provisioning: {
      ...DEFAULT_CONFIG.provisioning,
      ...(config.provisioning ?? {}),
    },
  };
  const now = deps.now ?? (() => new Date().toISOString());
  const policy = deps.policy ?? missingPolicy();
  const leaseTtlMs = deps.leaseTtlMs ?? cfg.provisioning.idleTimeoutMs;
  // E9.7: one evidence reader shared by telemetry and, in production, the
  // server's Observatory projection (wired via `SchedulerDeps.telemetry`).
  const telemetryEvidence =
    deps.telemetry?.evidence ?? createEvidenceReadPort(deps.store);

  const completions: Completion[] = [];
  const pending = new Set<string>();
  /**
   * Route-time settle guard: the signature of the exact `WorkerResult` content
   * already routed for a worker's live Attempt. A resumed Task
   * (WAITING_INPUT → RUNNING) would otherwise re-collect the adapter's still-
   * settled report and re-ask the same question forever. The guard is
   * content-based (not object identity) so it holds even when an adapter returns
   * a fresh copy of the same report on every poll; `attemptId` scopes it so a
   * genuinely new Attempt (or a new question on the same Attempt) is routed.
   */
  const routedReports = new Map<string, { attemptId: string; signature: string }>();
  /**
   * E9.3: READY tasks a blocked route refused this tick, rendered by `status()`.
   * Recomputed each assign pass; a blocked Task stays READY and is retried next
   * tick (a model may become available again).
   */
  let blockedRouting: Array<{ taskId: string; candidates: ModelId[]; unavailable: ModelId[] }> = [];
  /**
   * Per-Task signature of the last blocked route, so a Task parked on a blocked
   * pool records its `resource.unavailable` event once rather than once per
   * tick. A changed blocked set (a model returning, budget shifting) records a
   * fresh event; the Task stays READY throughout and is retried every tick.
   */
  const blockedSignatures = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  /** One-time guard so a missing `repoPath` warns loudly but only once. */
  let warnedMissingRepoPath = false;
  /**
   * One-time guard so a missing verifier warns loudly but only once. Per
   * instance (like `warnedMissingRepoPath`), so a scheduler created over a
   * fresh deployment state warns again rather than staying silent off a
   * process-global latch.
   */
  let warnedMissingVerifier = false;
  /**
   * E9.4: Tasks whose SUCCESS→VERIFIED/REWORK routing is in flight. The async
   * verification runs off-tick (mirroring `pollWorker`) and its outcome is
   * routed on the next tick; this set is the kind of "pending" guard that keeps
   * a SUCCESS Task from being re-dispatched every tick while it settles.
   */
  const verifyPending = new Set<string>();
  const verificationCompletions: Array<{
    subject: { workOrderId: string; taskId: string; attemptId: string };
    outcome: VerificationOutcome;
  }> = [];

  /**
   * E9.7: Attempts whose six-layer telemetry receipt has already been appended.
   * Seeded from the durable log on construction so a restart (or a replayed
   * completion) never double-records — and therefore never double-counts cost.
   */
  const telemetryRecorded = new Set<string>(
    deps.events
      .readEvents()
      .filter((event) => event.type === TELEMETRY_ATTEMPT_RECORDED)
      .map((event) => event.aggregateId),
  );

  /**
   * E9.7: append the six-layer telemetry receipt for a just-completed Attempt
   * (the live path E8 had no caller for). One receipt per Attempt, idempotent,
   * and read-only w.r.t. execution state: `recordAttemptTelemetry` derives the
   * layers and appends a single `telemetry.attempt_recorded` event. It never
   * fabricates data — an absent runtime observable is an honest `null`.
   */
  function recordTelemetry(attemptId: string): void {
    if (telemetryRecorded.has(attemptId)) return;
    telemetryRecorded.add(attemptId);
    try {
      recordAttemptTelemetry(
        { store: deps.store, events: deps.events, evidence: telemetryEvidence },
        attemptId,
      );
    } catch (error) {
      // A telemetry receipt is derived state, not execution state: a projection
      // failure must never strand a settled Attempt or abort the tick. Drop the
      // guard so a later completion can retry, and surface it loudly.
      telemetryRecorded.delete(attemptId);
      console.error(
        `scheduler: telemetry recording failed for attempt ${attemptId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // --- durable-state readers -------------------------------------------------

  function scopes(): Scope[] {
    const workOrders = deps.store
      .list<WorkOrder>('work_orders')
      .filter((wo) => wo.state === 'EXECUTING' || wo.state === 'WAITING_INPUT');
    const allTasks = deps.store.list<Task>('tasks');
    const result: Scope[] = [];
    for (const workOrder of workOrders) {
      const dag = getActiveDAG(deps, workOrder.id);
      if (!dag) continue;
      const activeIds = new Set(dag.nodes.map((node) => node.taskId));
      result.push({
        workOrder,
        dag,
        tasks: allTasks.filter(
          (task) => task.workOrderId === workOrder.id && activeIds.has(task.id),
        ),
      });
    }
    return result;
  }

  function readyCandidates(): Array<{ task: Task; workOrder: WorkOrder }> {
    const candidates: Array<{ task: Task; workOrder: WorkOrder }> = [];
    for (const scope of scopes()) {
      for (const task of scope.tasks) {
        if (task.state !== 'READY') continue;
        if (policy.canAssign(task, scope.workOrder) !== 'ALLOW') continue;
        candidates.push({ task, workOrder: scope.workOrder });
      }
    }
    return candidates.sort(
      (a, b) =>
        a.task.createdAt.localeCompare(b.task.createdAt) || a.task.id.localeCompare(b.task.id),
    );
  }

  // --- collect step ----------------------------------------------------------

  function pollWorker(workerId: string): void {
    if (pending.has(workerId)) return;
    const worker = deps.store.get<WorkerRecord>('workers', workerId);
    const assignment = openAssignmentFor(deps.store, workerId);
    if (!worker || worker.runtimeState !== 'BUSY' || !worker.lease || !assignment) return;
    const task = deps.store.get<Task>('tasks', assignment.taskId);
    if (!task || task.state !== 'RUNNING') return;
    const lease = worker.lease;

    pending.add(workerId);
    void deps.workers
      .status(workerId)
      .then((status) => {
        // Heartbeat: re-grant the lease only off a fresh `status()` read. A
        // runtime that is no longer alive does not get its lease extended
        // (design §6.2; a wedged runtime must not hold a lease forever).
        if (status.state === 'running' || status.state === 'waiting_input') {
          deps.workers.renewLease(
            workerId,
            { attemptId: lease.attemptId, taskId: lease.taskId },
            leaseTtlMs,
          );
        }
        return deps.workers.collectArtifacts(workerId);
      })
      .then(
        (result) => completions.push({ workerId, result }),
        (error: unknown) =>
          completions.push({
            workerId,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
  }

  function collectStep(): void {
    for (const worker of deps.workers.listWorkers()) {
      if (worker.runtimeState === 'BUSY') pollWorker(worker.id);
    }
  }

  function routeQueued(): void {
    const queued = completions.splice(0, completions.length);
    for (const item of queued) {
      pending.delete(item.workerId);
      routeCompletion(item);
    }
  }

  function hasEvidence(result: WorkerResult): boolean {
    return (
      (Array.isArray(result.commits) && result.commits.length > 0) ||
      (typeof result.diff === 'string' && result.diff.trim().length > 0)
    );
  }

  /**
   * The content signature of a routed report (E9.5). Keyed per Attempt so the
   * same report polled twice is consumed once, while a new question, a new
   * completion or a new Attempt routes afresh.
   */
  function reportSignature(result: WorkerResult): string {
    return JSON.stringify({
      status: result.status,
      interactions: result.interactions,
      commits: result.commits,
      diff: result.diff,
      failure: result.failure,
    });
  }

  function storeArtifacts(attemptId: string, result: WorkerResult): string[] {
    return result.artifacts.map((artifact) => {
      if (!deps.artifacts) return artifact.name;
      return deps.artifacts.put(`${attemptId}/${artifact.name}`, artifact.data).id;
    });
  }

  /**
   * Persist one §12 interaction doc per worker question, linked to the Attempt
   * and Task. Called inside the `waiting_input` state write so the durable
   * question and the Task's `WAITING_INPUT` state cannot diverge.
   */
  function recordInteractions(
    workerId: string,
    taskId: string,
    attemptId: string,
    questions: WorkerInteraction[],
    at: string,
  ): string[] {
    return questions.map((interaction) => {
      const record: InteractionRecord = {
        id: `interaction_${crypto.randomUUID()}`,
        type: 'QUESTION',
        taskId,
        attemptId,
        workerId,
        recipient: 'human',
        question: interaction.question,
        status: 'PENDING',
        response: null,
        createdAt: at,
        updatedAt: at,
      };
      deps.store.set('interactions', record.id, record);
      deps.events.appendEvent({
        type: INTERACTION_CREATED,
        aggregateType: 'interaction',
        aggregateId: record.id,
        payload: { interaction: record },
      });
      return record.id;
    });
  }

  function release(worker: WorkerRecord, assignment: AssignmentRecord, at: string): void {
    deps.store.set('workers', worker.id, {
      ...worker,
      runtimeState: 'IDLE',
      lease: null,
      lastActiveAt: at,
    });
    deps.store.set('assignments', assignment.id, {
      ...assignment,
      closedAt: at,
      updatedAt: at,
    });
  }

  function routeCompletion(item: Completion): void {
    const worker = deps.store.get<WorkerRecord>('workers', item.workerId);
    if (!worker || worker.runtimeState !== 'BUSY' || !worker.lease) return;
    const assignment = openAssignmentFor(deps.store, item.workerId);
    if (!assignment) return;
    const task = deps.store.get<Task>('tasks', assignment.taskId);
    if (!task || task.state !== 'RUNNING') return;

    const attemptId = worker.lease.attemptId;
    const result = item.result;

    // Consume-once: a report whose content was already routed for this Attempt
    // must not be routed again off a later poll (the answer loop would re-ask
    // the same question).
    if (result) {
      const routed = routedReports.get(item.workerId);
      if (routed && routed.attemptId === attemptId && routed.signature === reportSignature(result)) {
        return;
      }
    }

    // A question is not a completion: worker stays BUSY, lease/assignment stay
    // open, and the durable §12 interaction(s) are written alongside the Task
    // state transition so E2's answer loop has a question to resume from.
    if (result && result.status === 'waiting_input') {
      const t = now();
      deps.store.db.transaction(() => {
        recordInteractions(worker.id, task.id, attemptId, result.interactions, t);
        transitionTask(deps, task.id, { to: 'WAITING_INPUT' });
      })();
      routedReports.set(worker.id, { attemptId, signature: reportSignature(result) });
      return;
    }

    const t = now();
    routedReports.delete(worker.id);
    if (result && result.status === 'completed' && hasEvidence(result)) {
      const artifactIds = storeArtifacts(attemptId, result);
      deps.store.db.transaction(() => {
        completeAttempt(deps, attemptId, {
          outcome: 'success',
          diff: result.diff,
          artifactIds,
          verificationRunIds: result.verificationRequests,
        });
        transitionTask(deps, task.id, { to: 'SUCCESS' });
        release(worker, assignment, t);
      })();
      recordTelemetry(attemptId);
      return;
    }

    // Failure, missing evidence or a dispatch rejection: failed Attempt, Task
    // stays RUNNING (invariant 9), but the worker is still released. E10.2
    // (#38): the live failure is then handed to E7's bounded recovery, which
    // re-opens execution with a fresh Assignment (the dead-end was the missing
    // re-dispatcher, not the RUNNING state). The diff is preserved as immutable
    // evidence before the clean-baseline re-dispatch (§18.4).
    const detail = result?.failure ?? item.error ?? 'worker reported failure without evidence';
    const failure = encodeFailure('WORKER_FAILURE', detail);
    const artifactIds = result ? storeArtifacts(attemptId, result) : [];
    if (result?.diff && result.diff.trim().length > 0 && deps.artifacts) {
      deps.artifacts.put(`${attemptId}/diff.patch`, result.diff);
    }
    deps.store.db.transaction(() => {
      completeAttempt(deps, attemptId, {
        outcome: 'failed',
        diff: result?.diff ?? null,
        artifactIds,
        failureHistory: [{ at: t, failure }],
      });
      release(worker, assignment, t);
    })();
    recordTelemetry(attemptId);
    recoverWorkerFailure(task, attemptId, detail);
  }

  /**
   * Hand a live worker failure to E7's bounded recovery (E10.2, #38). E7
   * classifies it `WORKER_FAILURE`, applies its budgeted action, and — for
   * `RETRY_NEW_ATTEMPT` — mints the single clean-baseline Attempt. The actual
   * re-dispatch (a fresh Assignment against that open Attempt) is performed by
   * {@link redispatchPass} on this or a following tick. A recovery error must
   * never strand the tick: it is surfaced loudly and the Task stays RUNNING
   * (invariant 9), retried next tick.
   */
  function recoverWorkerFailure(task: Task, attemptId: string, detail: string): void {
    const attempt = deps.store.get<Attempt>('attempts', attemptId);
    const failure: FailureContext = {
      attemptId,
      taskId: task.id,
      workOrderId: task.workOrderId,
      failureClass: 'WORKER_FAILURE',
      error: detail,
      // §18.4 default: a new Attempt from a clean worktree is the changed condition.
      changedCondition: 'clean-worktree',
      // Post-completion failureHistory length, so a replayed delivery computes
      // the same §9.6 idempotency key.
      failureIndex: attempt?.failureHistory.length ?? 1,
    };
    try {
      recover(
        {
          store: deps.store,
          events: deps.events,
          now,
          ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
        },
        failure,
      );
    } catch (error) {
      console.error(
        `scheduler: worker-failure recovery failed for attempt ${attemptId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // --- passes ----------------------------------------------------------------

  function unblockPass(): void {
    for (const scope of scopes()) {
      for (const task of scope.tasks) {
        if (task.state !== 'PLANNED') continue;
        const dependenciesVerified = task.dependsOn.every(
          (depId) => deps.store.get<Task>('tasks', depId)?.state === 'VERIFIED',
        );
        if (!dependenciesVerified) continue;
        transitionTask(deps, task.id, { to: 'READY', reason: 'dependencies verified' });
      }
    }
  }

  function reclaimPass(): void {
    deps.workers.reclaimIdleWorkers(cfg.provisioning.idleTimeoutMs);
  }

  function provisionPass(): void {
    if (!cfg.provisioning.enabled) return;
    const demand = readyCandidates().length;
    const workers = deps.workers.listWorkers();
    const idle = workers.filter((worker) => worker.runtimeState === 'IDLE').length;
    const population = workers.filter((worker) => worker.runtimeState !== 'RECLAIMED').length;
    if (demand <= idle || population >= cfg.provisioning.max) return;
    const count = Math.min(demand - idle, cfg.provisioning.max - population);
    for (let i = 0; i < count; i += 1) {
      deps.workers.provisionWorker(cfg.provisioning.defaultProfile);
    }
  }

  /**
   * Compensate an `assign` that committed but whose `startTask` then threw:
   * close the open Assignment, release the Worker, revert the Task to READY and
   * record a diagnostic event. Without this the Task stays ASSIGNED/RUNNING, the
   * Worker stays BUSY and the Assignment stays open with a null lease — a state
   * `pollWorker` and the reclaim pass both skip, consuming a concurrency slot
   * forever and silently.
   *
   * The revert is a rollback, not a forward §5.2 edge: `READY→ASSIGNED→READY`
   * is not in `TASK_EDGES`, so the prior state is written directly and recorded
   * with the reverted Task on the diagnostic event (replay folds it).
   */
  function compensateFailedStart(assignment: AssignmentRecord, error: unknown): void {
    const at = now();
    const message = error instanceof Error ? error.message : String(error);
    const task = deps.store.get<Task>('tasks', assignment.taskId);
    const worker = deps.store.get<WorkerRecord>('workers', assignment.workerId);
    const open = openAssignmentFor(deps.store, assignment.workerId);
    deps.store.db.transaction(() => {
      if (task && (task.state === 'ASSIGNED' || task.state === 'RUNNING')) {
        const reverted: Task = { ...task, state: 'READY', updatedAt: at };
        deps.store.set('tasks', reverted.id, reverted);
      }
      if (worker) {
        deps.store.set('workers', worker.id, {
          ...worker,
          runtimeState: 'IDLE',
          lease: null,
          lastActiveAt: at,
        });
      }
      if (open) {
        deps.store.set('assignments', open.id, { ...open, closedAt: at, updatedAt: at });
      }
      deps.events.appendEvent({
        type: ASSIGNMENT_START_FAILED,
        aggregateType: 'assignment',
        aggregateId: assignment.id,
        payload: {
          assignmentId: assignment.id,
          taskId: assignment.taskId,
          workerId: assignment.workerId,
          task: task ? { ...task, state: 'READY', updatedAt: at } : null,
          error: message,
          at,
        },
      });
    })();
  }

  /** Signature of a blocked route: the unavailable set that closed the pool. */
  function blockedSignature(error: RoutingBlockedError): string {
    return error.unavailable.join(',');
  }

  /**
   * Route one candidate's assignment through E4 (E9.3, RE7(b)) and persist the
   * decision's provenance. Returns the selected model, or `null` when the route
   * is blocked — in which case no Attempt is created, the Task stays READY, and
   * E4's `RoutingBlockedError` is mapped to E7's `resource.unavailable` park
   * event bound to the Work Order (RE7(c)). Never substitutes a blocked model.
   */
  function routeForAssignment(candidate: { task: Task; workOrder: WorkOrder }): string | null {
    try {
      const { decision, derivedFrom } = routeAssignment({
        workOrder: candidate.workOrder,
        ...(deps.routing?.budget ? { budget: deps.routing.budget } : {}),
        ...(deps.routing?.unavailable ? { unavailable: deps.routing.unavailable } : {}),
      });
      const record = toRoutingDecisionRecord(decision, {
        workOrderId: candidate.workOrder.id,
        taskId: candidate.task.id,
        derivedFrom,
      });
      persistRoutingDecision({ store: deps.store, events: deps.events }, record);
      return decision.selected;
    } catch (error) {
      if (!(error instanceof RoutingBlockedError)) throw error;
      // Whole pool blocked: park on WAITING_RESOURCE semantics without a
      // lifecycle change — Task stays READY, no Attempt, durable park event.
      if (blockedSignatures.get(candidate.task.id) !== blockedSignature(error)) {
        blockedSignatures.set(candidate.task.id, blockedSignature(error));
        const at = now();
        deps.events.appendEvent({
          type: RESOURCE_UNAVAILABLE,
          aggregateType: 'work_order',
          aggregateId: candidate.workOrder.id,
          payload: { resource: 'model', candidates: error.candidates, unavailable: error.unavailable, at },
        });
      }
      blockedRouting.push({
        taskId: candidate.task.id,
        candidates: error.candidates,
        unavailable: error.unavailable,
      });
      return null;
    }
  }

  function assignPass(): void {
    blockedRouting = [];
    let slots = cfg.maxConcurrentTasks - countOccupied();
    const skipped = new Set<string>();

    while (slots > 0) {
      const candidate = readyCandidates().find((c) => !skipped.has(c.task.id));
      if (!candidate) break;
      const idleWorker = deps.workers.listWorkers().find((w) => w.runtimeState === 'IDLE');
      if (!idleWorker) break;

      if (!deps.repoPath) {
        // Without a repo the scheduler cannot create a worktree, so it would
        // skip every candidate forever and silently. Warn once (not per tick)
        // so a misconfigured server is visible, mirroring the fail-closed
        // policy default's loudness.
        if (!warnedMissingRepoPath) {
          warnedMissingRepoPath = true;
          console.error(
            'scheduler: no repoPath wired (SchedulerDeps.repoPath is undefined); skipping all assignments — set repository.path in factory.yaml',
          );
        }
        skipped.add(candidate.task.id);
        continue;
      }

      // Route before committing anything: a blocked route must not burn the
      // worker, a concurrency slot, or a worktree (RE7(b)/(c)).
      const model = routeForAssignment(candidate);
      if (model === null) {
        skipped.add(candidate.task.id);
        continue;
      }

      let assignment: AssignmentRecord | null = null;
      try {
        const worktree = deps.worktrees.createTaskWorktree(
          candidate.task.id,
          candidate.workOrder.id,
          deps.repoPath,
        );
        assignment = assign(
          { store: deps.store, events: deps.events, now },
          { taskId: candidate.task.id, workerId: idleWorker.id, worktree, model },
        );
        startTask({ ...deps, leaseTtlMs }, assignment);
        pollWorker(idleWorker.id);
        slots -= 1;
      } catch (error) {
        // A committed assign whose start failed is compensated so the worker and
        // the concurrency slot are not wedged; a pre-assign error (worktree
        // creation) has nothing to compensate.
        if (assignment) compensateFailedStart(assignment, error);
        // Per-task error (e.g. worktree creation failure): skip this task; retry next tick.
        skipped.add(candidate.task.id);
      }
    }
  }

  /**
   * E10.2 (#38): re-open execution for a Task whose E7 recovery minted a
   * clean-baseline Attempt but which has no live dispatch. A RUNNING Task with
   * an open Attempt and no open Assignment is an un-dispatched recovery Attempt;
   * bind it to a fresh idle worker on a clean worktree and dispatch it. The
   * Attempt is E7's (never re-minted here), so `assignPass` — which only picks
   * `READY` Tasks — can never mint a second Attempt for a recovery re-dispatch.
   * Idempotent: once assigned, the open Assignment excludes the Task next tick.
   */
  function redispatchPass(): void {
    if (!deps.repoPath) return;
    for (const scope of scopes()) {
      for (const task of scope.tasks) {
        if (task.state !== 'RUNNING') continue;
        const hasOpenAssignment = deps.store
          .list<AssignmentRecord>('assignments')
          .some((assignment) => assignment.taskId === task.id && assignment.closedAt === null);
        if (hasOpenAssignment) continue;
        const attempt = deps.store
          .list<Attempt>('attempts')
          .filter((candidate) => candidate.taskId === task.id && candidate.outcome === null)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .at(-1);
        if (!attempt) continue;
        const idleWorker = deps.workers.listWorkers().find((worker) => worker.runtimeState === 'IDLE');
        if (!idleWorker) continue;
        let assignment: AssignmentRecord | null = null;
        try {
          const worktree = deps.worktrees.createTaskWorktree(task.id, scope.workOrder.id, deps.repoPath);
          assignment = reopenAttempt(
            { ...deps, leaseTtlMs },
            { attemptId: attempt.id, workerId: idleWorker.id, worktree },
          );
          dispatchReopenedAttempt({ ...deps, leaseTtlMs }, assignment);
          pollWorker(idleWorker.id);
        } catch (error) {
          // A reopen that committed but whose dispatch then failed is
          // compensated (close the Assignment, release the worker) so the
          // worker and the clean Attempt are not wedged — the Task stays
          // RUNNING and the re-dispatch is retried next tick. A pre-commit
          // failure has nothing to compensate.
          if (assignment) compensateFailedReopen(assignment);
          console.error(
            `scheduler: re-dispatch of attempt ${attempt.id} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  /**
   * Compensate a committed `reopenAttempt` whose dispatch failed: close the
   * open Assignment and release the worker, leaving the Task `RUNNING` (unlike
   * {@link compensateFailedStart}, it does not revert the Task state — the Task
   * never left RUNNING, and the clean Attempt must remain open for retry).
   */
  function compensateFailedReopen(assignment: AssignmentRecord): void {
    const at = now();
    const worker = deps.store.get<WorkerRecord>('workers', assignment.workerId);
    deps.store.db.transaction(() => {
      const open = deps.store.get<AssignmentRecord>('assignments', assignment.id);
      if (open) deps.store.set('assignments', open.id, { ...open, closedAt: at, updatedAt: at });
      if (worker) {
        deps.store.set('workers', worker.id, {
          ...worker,
          runtimeState: 'IDLE',
          lease: null,
          lastActiveAt: at,
        });
      }
    })();
  }

  function countOccupied(): number {
    return scopes().reduce(
      (count, scope) =>
        count +
        scope.tasks.filter((task) => task.state === 'ASSIGNED' || task.state === 'RUNNING').length,
      0,
    );
  }

  // --- E9.4 verification + evidence ------------------------------------------

  /**
   * The Tasks awaiting verification: SUCCESS Tasks whose Work Order is still in
   * the execution states (EXECUTING/WAITING_INPUT). Read from durable state, so
   * a crash mid-flight simply re-dispatches on the next tick.
   */
  function successSubjects(): Array<{
    workOrder: WorkOrder;
    task: Task;
    attempt: Attempt;
    worktreePath?: string;
  }> {
    const subjects: Array<{
      workOrder: WorkOrder;
      task: Task;
      attempt: Attempt;
      worktreePath?: string;
    }> = [];
    const workOrders = deps.store
      .list<WorkOrder>('work_orders')
      .filter((wo) => wo.state === 'EXECUTING' || wo.state === 'WAITING_INPUT');
    const attempts = deps.store.list<Attempt>('attempts');
    const assignments = deps.store.list<AssignmentRecord>('assignments');
    for (const workOrder of workOrders) {
      for (const task of deps.store.list<Task>('tasks')) {
        if (task.workOrderId !== workOrder.id || task.state !== 'SUCCESS') continue;
        // The latest completed Attempt for the Task is the change set verified.
        const attempt =
          attempts
            .filter((candidate) => candidate.taskId === task.id && candidate.outcome === 'success')
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
            .at(-1) ?? null;
        if (!attempt) continue;
        // E10.1 (#39): pin verification to the Attempt's worktree checkout. The
        // Assignment carries it (it is closed by now, so it is provenance, not an
        // open lease) — command checks must run against the change under
        // verification, not the repository checkout. Absent an assignment the
        // subject carries no path and a check falls back to the repo.
        const worktreePath = assignments
          .filter((assignment) => assignment.taskId === task.id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .at(-1)?.worktreePath;
        subjects.push({ workOrder, task, attempt, ...(worktreePath ? { worktreePath } : {}) });
      }
    }
    return subjects;
  }

  /**
   * Kick verification for every SUCCESS Task not already in flight. The
   * verifier is async, so — like `pollWorker` — the durable routing happens on
   * the next tick via {@link routeVerificationQueued}.
   */
  function verificationPass(): void {
    const subjects = successSubjects();
    if (!deps.verifier) {
      if (subjects.length > 0 && !warnedMissingVerifier) {
        warnedMissingVerifier = true;
        console.error(
          'scheduler: no verifier wired (SchedulerDeps.verifier is undefined); SUCCESS Tasks will not be verified or promoted — wire the E5 verification orchestration',
        );
      }
      return;
    }
    for (const subject of subjects) {
      if (verifyPending.has(subject.task.id)) continue;

      // E9.8 write-time path gate (RE6): the assignment gate authorized the whole
      // worktree (`path:'**'`); here the change set's *actual* paths are known
      // from the diff, so a path outside the `repo.write` grant (the embedded
      // `infra/**` exclusion) is refused before verification — never verified,
      // never promoted. A denial settles as a structured rejection. An empty
      // diff yields no paths (a vacuous, explicitly-non-denying case inside the
      // gate) — nothing was written, so there is nothing to gate.
      const gate = deps.policy?.canWriteChangeSet;
      if (gate) {
        const branch = taskWorktreeBranch(subject.task.id, subject.workOrder.id);
        const paths = changedPathsFromDiff(subject.attempt.diff ?? '');
        const check = gate(subject.task, subject.workOrder, branch, paths);
        if (!check.allowed) {
          verifyPending.add(subject.task.id);
          verificationCompletions.push({
            subject: keyOf(subject),
            outcome: {
              bundle: null,
              passed: false,
              failures: [],
              rejection: `repo.write denied for ${check.denied.join(', ')} on ${branch}`,
            },
          });
          continue;
        }
      }

      verifyPending.add(subject.task.id);
      const reject = (error: unknown): void => {
        verificationCompletions.push({
          subject: keyOf(subject),
          outcome: {
            bundle: null,
            passed: false,
            failures: [],
            rejection: error instanceof Error ? error.message : String(error),
          },
        });
      };
      try {
        // A custom verifier may be synchronous or throw before returning a
        // promise. Both must settle as a rejection routed to REWORK — a raw
        // throw here would escape `tick()` and strand the Task in `verifyPending`.
        const verifier = deps.verifier;
        Promise.resolve(verifier.verify(subject)).then(
          (outcome) => verificationCompletions.push({ subject: keyOf(subject), outcome }),
          reject,
        );
      } catch (error) {
        reject(error);
      }
    }
  }

  function keyOf(subject: { task: Task; attempt: Attempt }): {
    workOrderId: string;
    taskId: string;
    attemptId: string;
  } {
    return {
      workOrderId: subject.task.workOrderId,
      taskId: subject.task.id,
      attemptId: subject.attempt.id,
    };
  }

  /**
   * Apply one settled verification to durable state, atomically. A pass persists
   * the immutable bundle and advances Task → VERIFIED; when every active Task of
   * the Work Order is VERIFIED, the Work Order advances
   * `EXECUTING/WAITING_INPUT → VERIFYING → EVIDENCE_READY → HUMAN_GATE`. A
   * failure (or a rejection: writer = verifier, no evidence) advances the Task
   * `SUCCESS → VERIFYING → FAILED → REWORK` and the Work Order
   * `→ VERIFYING → FAILED → REWORK`, recording the structured failures. Fail
   * closed: no bundle means no gate.
   */
  function routeVerification(completion: (typeof verificationCompletions)[number]): void {
    const { taskId, workOrderId } = completion.subject;
    const task = deps.store.get<Task>('tasks', taskId);
    const workOrder = deps.store.get<WorkOrder>('work_orders', workOrderId);
    verifyPending.delete(taskId);
    // Guard: a crash/retry or a duplicate settle of an already-routed Task
    // leaves state untouched. A Task still at SUCCESS is not a duplicate settle.
    if (!task || task.state !== 'SUCCESS' || !workOrder) return;
    // The Work Order must still be executing for the Work Order-level
    // transitions. Two completions can settle in one batch: the first moves the
    // WO to REWORK, so by the second's turn the WO is no longer executing. The
    // Task-level failure transition (and, above all, the failure *event*) must
    // still be recorded for the second Task, or its evidence is silently lost.
    const workOrderExecuting =
      workOrder.state === 'EXECUTING' || workOrder.state === 'WAITING_INPUT';

    const outcome = completion.outcome;
    const at = now();

    if (outcome.passed && outcome.bundle) {
      if (!workOrderExecuting) return;
      const bundle = outcome.bundle;
      deps.store.db.transaction(() => {
        deps.store.set('evidence_bundles', bundle.id, bundle);
        deps.events.appendEvent({
          type: EVIDENCE_BUNDLE_RECORDED,
          aggregateType: 'work_order',
          aggregateId: workOrder.id,
          payload: { bundle, taskId, attemptId: completion.subject.attemptId, at },
        });
        transitionTask(deps, taskId, { to: 'VERIFYING' });
        transitionTask(deps, taskId, { to: 'VERIFIED', reason: 'evidence bundle recorded' });
        if (allTasksVerified(workOrder.id)) {
          transitionWorkOrder(deps, workOrder.id, { to: 'VERIFYING' });
          transitionWorkOrder(deps, workOrder.id, { to: 'EVIDENCE_READY' });
          transitionWorkOrder(deps, workOrder.id, { to: 'HUMAN_GATE', reason: 'evidence ready' });
        }
      })();
      return;
    }

    // Failure or rejection: structured failure, REWORK, never a gate. The event
    // is appended first and unconditionally (given a SUCCESS Task) so a second
    // settle in the same batch cannot lose its evidence record; the Work Order
    // transitions are skipped once it has already left execution.
    const eventType = outcome.rejection ? VERIFICATION_REJECTED : VERIFICATION_FAILED;
    deps.store.db.transaction(() => {
      deps.events.appendEvent({
        type: eventType,
        aggregateType: 'work_order',
        aggregateId: workOrder.id,
        payload: {
          taskId,
          attemptId: completion.subject.attemptId,
          failures: outcome.failures,
          diagnosis: outcome.rejection,
          at,
        },
      });
      transitionTask(deps, taskId, { to: 'VERIFYING' });
      transitionTask(deps, taskId, { to: 'FAILED', reason: 'verification failed' });
      transitionTask(deps, taskId, { to: 'REWORK', reason: 'verification failed' });
      if (workOrderExecuting) {
        transitionWorkOrder(deps, workOrder.id, { to: 'VERIFYING' });
        transitionWorkOrder(deps, workOrder.id, { to: 'FAILED' });
        transitionWorkOrder(deps, workOrder.id, { to: 'REWORK', reason: 'verification failed' });
      }
    })();
  }

  function routeVerificationQueued(): void {
    const queued = verificationCompletions.splice(0, verificationCompletions.length);
    for (const completion of queued) routeVerification(completion);
  }

  /** True when every Task in the Work Order's active DAG is VERIFIED. */
  function allTasksVerified(workOrderId: string): boolean {
    const dag = getActiveDAG(deps, workOrderId);
    if (!dag || dag.nodes.length === 0) return false;
    return dag.nodes.every(
      (node) => deps.store.get<Task>('tasks', node.taskId)?.state === 'VERIFIED',
    );
  }

  function tick(): void {
    // E9.6 §10-2/§18.11: while an emergency stop or manual pause is active the
    // tick takes no consequential action — no assignment, no provisioning, no
    // verification dispatch and no new external side effect. State and evidence
    // are preserved (nothing is destroyed or advanced); the flag is durable and
    // event-derived, so a live scheduler observes a control set by any operator
    // surface on the next tick, and an explicit resume releases it.
    //
    // The gate is read once at tick entry: a long tick that began before a stop
    // completes all its passes. Accepted v0.1 per-tick model (passes are
    // synchronous and short); a stop is observed from the following tick.
    if (isEmergencyStopped(deps) || isFactoryPaused(deps)) return;
    routeVerificationQueued();
    routeQueued();
    collectStep();
    verificationPass();
    unblockPass();
    reclaimPass();
    provisionPass();
    assignPass();
    redispatchPass();
  }

  function status(): SchedulerStatus {
    const scopeList = scopes();
    const workers = deps.workers.listWorkers();
    const readyTaskIds: string[] = [];
    const blocked: Array<{ taskId: string; waitingOnTaskIds: string[] }> = [];
    const blockedPolicy: Array<{ taskId: string; verdict: PolicyVerdict }> = [];

    for (const scope of scopeList) {
      for (const task of scope.tasks) {
        if (task.state === 'READY') {
          const verdict = policy.canAssign(task, scope.workOrder);
          if (verdict === 'ALLOW') readyTaskIds.push(task.id);
          else blockedPolicy.push({ taskId: task.id, verdict });
        } else if (task.state === 'PLANNED') {
          blocked.push({
            taskId: task.id,
            waitingOnTaskIds: task.dependsOn.filter(
              (depId) => deps.store.get<Task>('tasks', depId)?.state !== 'VERIFIED',
            ),
          });
        }
      }
    }

    const current = scopeList.reduce(
      (count, scope) =>
        count +
        scope.tasks.filter((task) => task.state === 'ASSIGNED' || task.state === 'RUNNING').length,
      0,
    );

    return {
      running: timer !== null,
      tickIntervalMs: cfg.tickIntervalMs,
      concurrency: { current, max: cfg.maxConcurrentTasks },
      workers: {
        idle: workers.filter((worker) => worker.runtimeState === 'IDLE').length,
        busy: workers.filter((worker) => worker.runtimeState === 'BUSY').length,
        reclaimed: workers.filter((worker) => worker.runtimeState === 'RECLAIMED').length,
      },
      provisioning: {
        enabled: cfg.provisioning.enabled,
        min: cfg.provisioning.min,
        max: cfg.provisioning.max,
      },
      queue: { readyTaskIds, blocked, blockedPolicy, blockedRouting },
      activeDAGs: scopeList.map((scope) => ({
        workOrderId: scope.workOrder.id,
        version: scope.dag.version,
        nodes: scope.dag.nodes.length,
      })),
    };
  }

  return {
    tick,
    start(): void {
      if (timer) return;
      timer = setInterval(tick, cfg.tickIntervalMs);
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    status,
    async deliverAnswer(workerId, answer): Promise<void> {
      await deps.workers.deliverAnswer(workerId, answer);
    },
  };
}
