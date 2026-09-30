import { completeAttempt, createAttempt, type Attempt, type Task } from '../domain/workOrder';
import { FactoryError } from '../domain/errors';
import type { EventLog } from '../events/log';
import {
  commitDAG,
  getActiveDAG,
  type DAGProposalPayload,
  type DAGVersion,
} from '../planning/dag';
import { isEmergencyStopped, isFactoryPaused } from '../policy/policy';
import {
  beforeDependencyRequest,
  recordDependencyFailure,
  type CircuitConfig,
} from './circuitBreaker';
import type { ArtifactStore, StateStore } from '../state/store';
import type { AssignmentRecord, WorkerLease, WorkerRecord } from '../workers/manager';

/**
 * E7 bounded recovery (design `policy-and-risk-model.md` §9–§10; spec §18).
 *
 * Recovery is deterministic and bounded: it classifies a failure, then acts
 * under per-class / per-Task / per-Work-Order budgets with an explicit
 * changed-condition requirement (no blind universal retry). Rework always opens
 * a **new Attempt from a clean baseline**, preserving the failed Attempt's diff
 * as immutable evidence. Crash reconciliation walks durable state → event
 * history → RUNNING Attempts → worker leases and never claims success without
 * completion evidence. Quota exhaustion with a pinned model parks at
 * `WAITING_RESOURCE` — never a silent cheaper-model downgrade.
 */

export const RECOVERY_ACTION_APPLIED = 'recovery.action_applied';
export const RESOURCE_UNAVAILABLE = 'resource.unavailable';

/** The closed failure vocabulary (design §9.1). */
export type FailureClass =
  | 'WORKER_FAILURE'
  | 'VERIFICATION_FAILURE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_QUOTA_EXHAUSTED'
  | 'PROVIDER_OUTAGE'
  | 'MODEL_AUTH_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'IDEMPOTENCY_DUPLICATE'
  | 'CRASH_RECOVERY'
  | 'UNKNOWN';

export const FAILURE_CLASSES: readonly FailureClass[] = [
  'WORKER_FAILURE',
  'VERIFICATION_FAILURE',
  'DEPENDENCY_UNAVAILABLE',
  'MODEL_RATE_LIMITED',
  'MODEL_QUOTA_EXHAUSTED',
  'PROVIDER_OUTAGE',
  'MODEL_AUTH_FAILED',
  'MODEL_UNAVAILABLE',
  'IDEMPOTENCY_DUPLICATE',
  'CRASH_RECOVERY',
  'UNKNOWN',
];

/**
 * The §9.1 encoding convention: E1's `AttemptFailure.failure` carries a
 * class-prefixed string `'<FAILURE_CLASS>: <message>'`. An unparseable or
 * out-of-vocabulary token is `UNKNOWN` (never string-sniffed).
 */
export function parseFailureClass(failure: string): FailureClass {
  const token = failure.split(':')[0]?.trim() ?? '';
  return (FAILURE_CLASSES as readonly string[]).includes(token) ? (token as FailureClass) : 'UNKNOWN';
}

/** Encode one failure per the §9.1 convention. */
export function encodeFailure(failureClass: FailureClass, message: string): string {
  return `${failureClass}: ${message}`;
}

export interface FailureContext {
  attemptId: string;
  taskId: string;
  workOrderId: string;
  failureClass: FailureClass;
  error: string;
  at?: string;
  signal?: string;
  changedCondition?: string;
  /** The Work Order's pinned model class (§9.5); no silent downgrade. */
  requiredModel?: string;
  /** A substitute that satisfies the pinned requirement, if any. */
  substituteModel?: string;
  attemptCount?: number;
  sameClassCount?: number;
  /**
   * The dependency whose outage this failure reports (spec §18.9). Keys the
   * circuit breaker; derived from the failure class when omitted.
   */
  dependency?: string;
  /**
   * The durable failure index (`failureHistory.length` at delivery time). The
   * §9.6 idempotency key is `recover:{attemptId}:{failureIndex}`; callers
   * delivering a failure pass it so a replay computes the same key even after
   * the action appended to `failureHistory`.
   */
  failureIndex?: number;
  retryAfterMs?: number;
}

export type RecoveryAction =
  | { kind: 'RETRY_NEW_ATTEMPT'; reason: string; changedCondition: string }
  | { kind: 'REASSIGN'; workerId?: string }
  | { kind: 'REPLAN'; taskIds: string[] }
  | { kind: 'ESCALATE_HUMAN'; reason?: string }
  | { kind: 'WAITING_RESOURCE'; resource: string; retryAfterMs?: number }
  | { kind: 'FAIL_WORK_ORDER' }
  | { kind: 'NO_OP_DUPLICATE' }
  | { kind: 'HOLD' };

export interface RecoveryBudgets {
  /** Max automatic retries for the same failure class on the same Task. */
  perClassRetries: number;
  /** Max total Attempts per Task. */
  perTaskAttempts: number;
  /** Max automatic recovery actions per Work Order. */
  workOrderCeiling: number;
  /** Max automatically replanned DAG versions per Work Order. */
  replanBudget: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_RECOVERY_BUDGETS: RecoveryBudgets = {
  perClassRetries: 2,
  perTaskAttempts: 3,
  workOrderCeiling: 6,
  replanBudget: 2,
  backoffBaseMs: 100,
  backoffMaxMs: 10_000,
};

export type WorkerStatusFn = (
  workerId: string,
) => 'running' | 'completed' | 'failed' | 'waiting_input' | 'stopped';

export interface RecoveryDeps {
  store: StateStore;
  events: EventLog;
  now?: () => string;
  artifacts?: ArtifactStore;
  workerStatus?: WorkerStatusFn;
  budgets?: Partial<RecoveryBudgets>;
  rand?: () => number;
  /** §18.9 circuit-breaker tuning for dependency outages. */
  circuit?: Partial<CircuitConfig>;
}

const AUTOMATIC_KINDS: ReadonlySet<RecoveryAction['kind']> = new Set([
  'RETRY_NEW_ATTEMPT',
  'REASSIGN',
  'REPLAN',
]);

/** Full-jitter exponential backoff (design §9.5; spec §18.9). */
export function backoffWithJitter(
  attempt: number,
  opts: { baseMs: number; maxMs: number; rand: () => number },
): number {
  const cap = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt));
  return Math.round(opts.rand() * cap);
}

function budgetsOf(deps: RecoveryDeps): RecoveryBudgets {
  return { ...DEFAULT_RECOVERY_BUDGETS, ...(deps.budgets ?? {}) };
}

function delayFor(deps: RecoveryDeps, failure: FailureContext): number {
  if (failure.retryAfterMs !== undefined) return failure.retryAfterMs;
  const budgets = budgetsOf(deps);
  return backoffWithJitter(failure.sameClassCount ?? 0, {
    baseMs: budgets.backoffBaseMs,
    maxMs: budgets.backoffMaxMs,
    rand: deps.rand ?? Math.random,
  });
}

function attemptsForTask(deps: RecoveryDeps, taskId: string): number {
  return deps.store.list<Attempt>('attempts').filter((attempt) => attempt.taskId === taskId).length;
}

/**
 * Derive the per-Task attempt count and same-class failure count from durable
 * state when the caller did not provide them (counted from the `attempts`
 * projection of `failureHistory`, §9.4).
 */
function deriveCounts(
  deps: RecoveryDeps,
  failure: FailureContext,
): { attemptCount: number; sameClassCount: number } {
  const attempts = deps.store.list<Attempt>('attempts').filter((attempt) => attempt.taskId === failure.taskId);
  const sameClassCount = attempts
    .flatMap((attempt) => attempt.failureHistory)
    .filter((entry) => parseFailureClass(entry.failure) === failure.failureClass).length;
  return { attemptCount: attempts.length, sameClassCount };
}

function countAutomaticRecovery(deps: RecoveryDeps, workOrderId: string): number {
  return deps.events
    .readEvents({ aggregateType: 'work_order', aggregateId: workOrderId })
    .filter((event) => event.type === RECOVERY_ACTION_APPLIED)
    .filter((event) => AUTOMATIC_KINDS.has((event.payload as { kind?: RecoveryAction['kind'] }).kind ?? 'NO_OP_DUPLICATE')).length;
}

function actionKey(deps: RecoveryDeps, failure: FailureContext): string | null {
  const attempt = deps.store.get<Attempt>('attempts', failure.attemptId);
  // Idempotency keys are bound to a durable Attempt (§9.6). With no durable
  // Attempt there is nothing to protect against a duplicate side effect.
  if (!attempt) return null;
  const index = failure.failureIndex ?? attempt.failureHistory.length;
  return `recover:${failure.attemptId}:${index}`;
}

function alreadyApplied(deps: RecoveryDeps, key: string): boolean {
  return deps.events
    .readEvents()
    .some(
      (event) =>
        event.type === RECOVERY_ACTION_APPLIED &&
        (event.payload as { key?: string }).key === key,
    );
}

function retryAction(changedCondition: string, reason: string): RecoveryAction {
  return { kind: 'RETRY_NEW_ATTEMPT', reason, changedCondition };
}

/**
 * Decide the bounded recovery action for a failure (design §9.2 + §9.4). Pure
 * with respect to the durable side effects; `recover` applies them.
 */
function decide(
  deps: RecoveryDeps,
  failure: FailureContext,
  counts: { attemptCount: number; sameClassCount: number; woAutomatic: number },
): RecoveryAction {
  const budgets = budgetsOf(deps);
  // The §9.4 global bound, tracked separately so a *substitute* (an automatic
  // remedy) can tell WO-ceiling exhaustion — which escalates — from a per-Task
  // / per-class bound, which parks on capacity.
  const workOrderCeilingReached = counts.woAutomatic >= budgets.workOrderCeiling;
  const automaticAllowed = counts.attemptCount < budgets.perTaskAttempts && !workOrderCeilingReached;
  const withinRetryBudget = counts.sameClassCount < budgets.perClassRetries;
  const hasChangedCondition = counts.sameClassCount === 0 || Boolean(failure.changedCondition);

  const canAutoRetry = automaticAllowed && withinRetryBudget && hasChangedCondition;
  const retry = (reason: string): RecoveryAction =>
    retryAction(failure.changedCondition ?? 'clean-worktree', reason);

  /**
   * A policy-satisfying model substitute mints a new Attempt, so it is an
   * *automatic* remedy and obeys the §9.4 bounds exactly like every other
   * automatic action — it may not bypass them by naming a substitute. When a
   * bound refuses it, the branch falls through to the class's §9.2 "after
   * bounds" remedy: capacity parking, or `ESCALATE_HUMAN` once the Work-Order
   * ceiling (the global bound) is reached, since §9.4 maps every remaining
   * automatic remedy to escalation there.
   */
  const substituteRetry = (satisfies: boolean): RecoveryAction | null => {
    if (!satisfies) return null;
    if (automaticAllowed && withinRetryBudget) return retry(`model:${failure.substituteModel}`);
    if (workOrderCeilingReached) {
      return { kind: 'ESCALATE_HUMAN', reason: 'work-order-recovery-ceiling-exhausted' };
    }
    return null;
  };

  switch (failure.failureClass) {
    case 'IDEMPOTENCY_DUPLICATE':
      return { kind: 'NO_OP_DUPLICATE' };

    case 'MODEL_AUTH_FAILED':
      return { kind: 'ESCALATE_HUMAN', reason: 'model-auth-failed' };

    case 'MODEL_QUOTA_EXHAUSTED': {
      const satisfies =
        Boolean(failure.substituteModel) &&
        failure.substituteModel === failure.requiredModel &&
        Boolean(failure.changedCondition);
      const substitute = substituteRetry(satisfies);
      if (substitute) return substitute;
      // Never a silent cheaper-model downgrade (§9.5).
      return {
        kind: 'WAITING_RESOURCE',
        resource: failure.requiredModel ?? 'model-class',
        retryAfterMs: delayFor(deps, failure),
      };
    }

    case 'PROVIDER_OUTAGE':
    case 'MODEL_UNAVAILABLE': {
      const satisfies = Boolean(failure.substituteModel) && Boolean(failure.changedCondition);
      const substitute = substituteRetry(satisfies);
      if (substitute) return substitute;
      return {
        kind: 'WAITING_RESOURCE',
        resource: failure.requiredModel ?? 'provider',
        retryAfterMs: delayFor(deps, failure),
      };
    }

    case 'DEPENDENCY_UNAVAILABLE': {
      if (canAutoRetry) return retry(`backoff:${delayFor(deps, failure)}ms`);
      return {
        kind: 'WAITING_RESOURCE',
        resource: 'dependency',
        retryAfterMs: delayFor(deps, failure),
      };
    }

    case 'MODEL_RATE_LIMITED': {
      if (canAutoRetry) return retry(`backoff:${delayFor(deps, failure)}ms`);
      return {
        kind: 'WAITING_RESOURCE',
        resource: failure.requiredModel ?? 'model',
        retryAfterMs: delayFor(deps, failure),
      };
    }

    case 'VERIFICATION_FAILURE': {
      if (canAutoRetry) return retry('clean-worktree');
      return { kind: 'ESCALATE_HUMAN', reason: 'verification-budget-exhausted' };
    }

    case 'CRASH_RECOVERY': {
      if (canAutoRetry) return retry('clean-worktree');
      return { kind: 'ESCALATE_HUMAN', reason: 'crash-recovery-budget-exhausted' };
    }

    case 'UNKNOWN': {
      // No blind retry: at most one bounded Attempt, then escalate.
      if (automaticAllowed && counts.sameClassCount === 0) return retry('bounded-single-retry');
      return { kind: 'ESCALATE_HUMAN', reason: 'unknown-failure' };
    }

    case 'WORKER_FAILURE': {
      if (!automaticAllowed) {
        return { kind: 'ESCALATE_HUMAN', reason: 'worker-failure-budget-exhausted' };
      }
      if (withinRetryBudget) {
        if (canAutoRetry) return retry('clean-worktree');
        // Identical signature with no changed condition: no blind loop.
        return { kind: 'ESCALATE_HUMAN', reason: 'no-changed-condition' };
      }
      const overflow = counts.sameClassCount - budgets.perClassRetries;
      if (overflow === 0) return { kind: 'REASSIGN' };
      if (overflow === 1) return { kind: 'REPLAN', taskIds: [] };
      return { kind: 'ESCALATE_HUMAN', reason: 'worker-failure-budget-exhausted' };
    }

    default:
      return { kind: 'ESCALATE_HUMAN', reason: 'unhandled-failure-class' };
  }
}

function newAttemptFor(deps: RecoveryDeps, failure: FailureContext, action: RecoveryAction): Attempt {
  const prior = deps.store.get<Attempt>('attempts', failure.attemptId);
  const model = failure.substituteModel ?? failure.requiredModel ?? prior?.model ?? null;
  const condition = action.kind === 'RETRY_NEW_ATTEMPT' ? action.changedCondition : 'clean-worktree';
  return createAttempt(
    { store: deps.store, events: deps.events },
    {
      taskId: failure.taskId,
      workerId: null,
      model,
      context: `recovery:${condition}`,
      environment: 'clean-worktree',
    },
  );
}

/** Apply the durable side effects of an action + record its idempotency key. */
function applyAction(deps: RecoveryDeps, failure: FailureContext, action: RecoveryAction, key: string | null): void {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  deps.store.db.transaction(() => {
    if (action.kind === 'RETRY_NEW_ATTEMPT') {
      if (deps.store.get<Task>('tasks', failure.taskId)) newAttemptFor(deps, failure, action);
    } else if (action.kind === 'WAITING_RESOURCE') {
      const attempt = deps.store.get<Attempt>('attempts', failure.attemptId);
      if (attempt && attempt.outcome === null) {
        completeAttempt(deps, failure.attemptId, {
          outcome: 'waiting_resource',
          failureHistory: [
            ...attempt.failureHistory,
            { at, failure: `${failure.failureClass}: ${failure.error}`, recovery: 'WAITING_RESOURCE' },
          ],
        });
      }
      deps.events.appendEvent({
        type: RESOURCE_UNAVAILABLE,
        aggregateType: 'work_order',
        aggregateId: failure.workOrderId,
        payload: { resource: action.resource, at },
      });
    }

    deps.events.appendEvent({
      type: RECOVERY_ACTION_APPLIED,
      aggregateType: 'work_order',
      aggregateId: failure.workOrderId,
      payload: { key, kind: action.kind, action, attemptId: failure.attemptId, at },
    });
  })();
}

/**
 * The §18.9 failure classes that represent a dependency becoming unavailable:
 * these feed the circuit breaker instead of walking the retry ladder blindly.
 */
const CIRCUIT_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set([
  'DEPENDENCY_UNAVAILABLE',
  'PROVIDER_OUTAGE',
  'MODEL_UNAVAILABLE',
]);

/** The circuit key for a failure: the named dependency, or the pinned model/provider. */
export function dependencyKeyFor(failure: FailureContext): string {
  if (failure.dependency) return failure.dependency;
  if (failure.failureClass === 'DEPENDENCY_UNAVAILABLE') return 'dependency';
  return failure.requiredModel ?? 'provider';
}

/**
 * The bounded recovery entry point (design §9.2). Returns the decided
 * `RecoveryAction` and applies its durable side effects (new Attempt from a
 * clean baseline, `waiting_resource` outcome + event, idempotency record).
 * Duplicate deliveries of the same idempotency key are `NO_OP_DUPLICATE`.
 *
 * §18.9: a dependency outage (DEPENDENCY_UNAVAILABLE / PROVIDER_OUTAGE /
 * MODEL_UNAVAILABLE) feeds the circuit breaker first. While the circuit is
 * OPEN the dependent operation is shed — a `WAITING_RESOURCE` park that spends
 * no per-class/per-Task/Work-Order recovery budget — rather than retried. After
 * the reset window the circuit half-opens: the next failure is admitted as a
 * probe through the ordinary bounded wheel, and a failed probe re-opens.
 */
export function recover(deps: RecoveryDeps, failure: FailureContext): RecoveryAction {
  if (isEmergencyStopped(deps) || isFactoryPaused(deps)) return { kind: 'HOLD' };

  const key = actionKey(deps, failure);
  if (key && alreadyApplied(deps, key)) return { kind: 'NO_OP_DUPLICATE' };

  if (CIRCUIT_FAILURE_CLASSES.has(failure.failureClass)) {
    const dependency = dependencyKeyFor(failure);
    recordDependencyFailure(deps, dependency, deps.circuit);
    const gate = beforeDependencyRequest(deps, dependency, deps.circuit);
    if (!gate.allowed) {
      const shed: RecoveryAction = {
        kind: 'WAITING_RESOURCE',
        resource: dependency,
        ...(gate.retryAfterMs !== undefined ? { retryAfterMs: gate.retryAfterMs } : {}),
      };
      applyAction(deps, failure, shed, key);
      return shed;
    }
  }

  const derived = deriveCounts(deps, failure);
  const counts = {
    attemptCount: failure.attemptCount ?? derived.attemptCount,
    sameClassCount: failure.sameClassCount ?? derived.sameClassCount,
    woAutomatic: countAutomaticRecovery(deps, failure.workOrderId),
  };

  const action = decide(deps, failure, counts);
  if (action.kind === 'NO_OP_DUPLICATE' || action.kind === 'HOLD') return action;

  applyAction(deps, failure, action, key);
  return action;
}

// ---------------------------------------------------------------------------
// Bounded replan (§9.2)
// ---------------------------------------------------------------------------

export type ReplanResult =
  | { ok: true; version: number; dag: DAGVersion }
  | { ok: false; action: RecoveryAction; reasons?: string[] };

/**
 * Bounded replan. The bound lives in E7, not E3: `commitDAG` is called directly
 * (validate + commit in one transactional path). If the active version already
 * consumed the replan budget, escalate; a rejected payload escalates after one
 * attempt with no silent auto-reformulation.
 */
export function replanWorkOrder(
  deps: Pick<RecoveryDeps, 'store' | 'events' | 'now' | 'budgets'>,
  workOrderId: string,
  payload: DAGProposalPayload,
): ReplanResult {
  const budgets = budgetsOf(deps as RecoveryDeps);
  const active = getActiveDAG(deps, workOrderId);
  const version = active?.version ?? 0;
  // v-1 replans have already happened; the initial v1 is not a replan.
  if (version - 1 >= budgets.replanBudget) {
    return {
      ok: false,
      action: { kind: 'ESCALATE_HUMAN', reason: 'replan-budget-exhausted' },
    };
  }
  try {
    const dag = commitDAG(deps, workOrderId, payload);
    return { ok: true, version: dag.version, dag };
  } catch (error) {
    if (error instanceof FactoryError && error.code === 'DAG_INVALID') {
      return {
        ok: false,
        action: { kind: 'ESCALATE_HUMAN', reason: 'replan-rejected' },
        reasons: [error.message],
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Crash reconciliation (§9.3) — the lease path
// ---------------------------------------------------------------------------

export interface ReconciliationFinding {
  attemptId: string;
  taskId: string;
  disposition: 'reattached' | 'interrupted';
  reason: string;
  action?: RecoveryAction;
}

export interface ReconciliationResult {
  findings: ReconciliationFinding[];
}

export interface ReconcileOptions {
  workerStatus?: WorkerStatusFn;
}

// `SUCCESS` is in-flight here on purpose: a Task that reached SUCCESS while an
// Attempt on it is still open (no completion evidence, no `outcome`) is
// anomalous — the crash left the state and the Attempt disagreeing. Interrupting
// that open Attempt is evidence-preserving (it never claims success); reading
// SUCCESS as "settled, skip" would leave a phantom open Attempt behind forever.
const IN_FLIGHT_STATES: ReadonlySet<string> = new Set([
  'ASSIGNED',
  'RUNNING',
  'VERIFYING',
  'SUCCESS',
]);

function findLease(workers: readonly WorkerRecord[], attemptId: string): { worker: WorkerRecord; lease: WorkerLease } | null {
  for (const worker of workers) {
    if (worker.lease && worker.lease.attemptId === attemptId) return { worker, lease: worker.lease };
  }
  return null;
}

/**
 * On Factory restart (spec §18.3): load durable state → event history →
 * identify RUNNING Attempts → reconcile worker leases → reconnect live workers,
 * interrupt the rest. An Attempt is only considered in-flight when a crashed
 * execution left a lease or an open Assignment behind (a recovery-created
 * Attempt with neither is not re-reconciled). Success is never claimed without
 * completion evidence: an interrupted Attempt records `interrupted` and its diff
 * is preserved as evidence.
 */
export function reconcileAfterRestart(
  deps: RecoveryDeps,
  options: ReconcileOptions = {},
): ReconciliationResult {
  const now = deps.now ?? (() => new Date().toISOString());
  const nowMs = Date.parse(now());
  const statusFn = options.workerStatus ?? deps.workerStatus ?? (() => 'running');
  const findings: ReconciliationFinding[] = [];

  const openAttempts = deps.store.list<Attempt>('attempts').filter((attempt) => attempt.outcome === null);
  for (const attempt of openAttempts) {
    const task = deps.store.get<Task>('tasks', attempt.taskId);
    if (!task || !IN_FLIGHT_STATES.has(task.state)) continue;

    const workers = deps.store.list<WorkerRecord>('workers');
    const leaseEntry = findLease(workers, attempt.id);
    const openAssignments = deps.store
      .list<AssignmentRecord>('assignments')
      .filter((assignment) => assignment.taskId === task.id && assignment.closedAt === null);

    // Not in flight from a crash: no lease and no open assignment.
    if (!leaseEntry && openAssignments.length === 0) continue;

    const status = leaseEntry ? statusFn(leaseEntry.worker.id) : 'stopped';
    const leaseValid =
      Boolean(leaseEntry) &&
      Date.parse(leaseEntry!.lease.expiresAt) > nowMs &&
      (status === 'running' || status === 'waiting_input');

    if (leaseValid) {
      findings.push({
        attemptId: attempt.id,
        taskId: task.id,
        disposition: 'reattached',
        reason: 'lease valid and worker live',
      });
      continue;
    }

    const reason = !leaseEntry
      ? 'no-lease'
      : Date.parse(leaseEntry.lease.expiresAt) <= nowMs
        ? 'lease-expired'
        : `worker-${status}`;
    const at = now();

    deps.store.db.transaction(() => {
      // Preserve the failed Attempt's diff as immutable evidence before anything else.
      if (attempt.diff && deps.artifacts) {
        deps.artifacts.put(`${attempt.id}/diff.patch`, attempt.diff);
      }
      completeAttempt(deps, attempt.id, {
        outcome: 'interrupted',
        failureHistory: [
          ...attempt.failureHistory,
          // §9.1: `failureHistory[].recovery` carries a `RecoveryAction.kind`.
          // The crash-recovery default (§9.3) is a new clean-baseline Attempt;
          // the "interrupted" disposition stays in the failure detail.
          {
            at,
            failure: `CRASH_RECOVERY: factory restart interrupted (${reason})`,
            recovery: 'RETRY_NEW_ATTEMPT',
          },
        ],
      });
      if (leaseEntry) {
        deps.store.set('workers', leaseEntry.worker.id, {
          ...leaseEntry.worker,
          runtimeState: 'IDLE',
          lease: null,
          lastActiveAt: at,
        });
      }
      for (const assignment of openAssignments) {
        deps.store.set('assignments', assignment.id, { ...assignment, closedAt: at, updatedAt: at });
      }
    })();

    const action = recover(deps, {
      attemptId: attempt.id,
      taskId: task.id,
      workOrderId: task.workOrderId,
      failureClass: 'CRASH_RECOVERY',
      error: `factory restart (${reason})`,
      changedCondition: task.state === 'VERIFYING' ? 'reverification' : 'clean-worktree',
      failureIndex: attempt.failureHistory.length + 1,
    });

    findings.push({
      attemptId: attempt.id,
      taskId: task.id,
      disposition: 'interrupted',
      reason,
      action,
    });
  }

  return { findings };
}
