import { completeAttempt, transitionTask, type Task, type WorkOrder } from '../domain/workOrder';
import type { EventLog } from '../events/log';
import { getActiveDAG, type DAGVersion } from '../planning/dag';
import type { ArtifactStore, StateStore } from '../state/store';
import type { WorkerInteraction, WorkerResult } from '../workers/herdr';
import {
  assign,
  openAssignmentFor,
  startTask,
  type AssignmentRecord,
  type WorkerManager,
  type WorkerProfile,
  type WorkerRecord,
} from '../workers/manager';
import type { WorktreeManager } from '../worktrees/worktree';

/**
 * E3.2 capacity- and policy-aware scheduler (spec §7.2). In-process and
 * tick-driven; the queue is derived from durable state on every tick, so a
 * crash loses nothing. One tick opens with a collect step and then runs the
 * unblock, reclaim, provision and assign passes in that order.
 */

export type PolicyVerdict = 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN';

export interface SchedulerPolicy {
  canAssign(task: Task, workOrder: WorkOrder): PolicyVerdict;
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
  };
  activeDAGs: Array<{ workOrderId: string; version: number; nodes: number }>;
}

export interface Scheduler {
  tick(): void;
  start(): void;
  stop(): void;
  status(): SchedulerStatus;
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

  const completions: Completion[] = [];
  const pending = new Set<string>();
  /**
   * Route-time settle guard: the exact `WorkerResult` object already routed for
   * a worker. A resumed Task (WAITING_INPUT → RUNNING) would otherwise re-collect
   * the adapter's still-settled report and re-ask the same question forever. The
   * object identity is stable across polls (the adapter returns the same settled
   * report until the next `execute`), so dropping the identical object is
   * consume-once; a genuinely new run settles a fresh object and is routed.
   */
  const routedReports = new Map<string, WorkerResult>();
  let timer: ReturnType<typeof setInterval> | null = null;

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

    // Consume-once: a report already routed for this worker must not be routed
    // again off a later poll (the answer loop would re-ask the same question).
    if (result && routedReports.get(item.workerId) === result) return;

    // A question is not a completion: worker stays BUSY, lease/assignment stay
    // open, and the durable §12 interaction(s) are written alongside the Task
    // state transition so E2's answer loop has a question to resume from.
    if (result && result.status === 'waiting_input') {
      const t = now();
      deps.store.db.transaction(() => {
        recordInteractions(worker.id, task.id, attemptId, result.interactions, t);
        transitionTask(deps, task.id, { to: 'WAITING_INPUT' });
      })();
      routedReports.set(worker.id, result);
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
      return;
    }

    // Failure, missing evidence or a dispatch rejection: failed Attempt, Task
    // stays RUNNING (invariant 9), but the worker is still released.
    const failure =
      result?.failure ?? item.error ?? 'worker reported failure without evidence';
    const artifactIds = result ? storeArtifacts(attemptId, result) : [];
    deps.store.db.transaction(() => {
      completeAttempt(deps, attemptId, {
        outcome: 'failed',
        diff: result?.diff ?? null,
        artifactIds,
        failureHistory: [{ at: t, failure }],
      });
      release(worker, assignment, t);
    })();
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

  function assignPass(): void {
    let slots = cfg.maxConcurrentTasks - countOccupied();
    const skipped = new Set<string>();

    while (slots > 0) {
      const candidate = readyCandidates().find((c) => !skipped.has(c.task.id));
      if (!candidate) break;
      const idleWorker = deps.workers.listWorkers().find((w) => w.runtimeState === 'IDLE');
      if (!idleWorker) break;

      if (!deps.repoPath) {
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
          { taskId: candidate.task.id, workerId: idleWorker.id, worktree },
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

  function countOccupied(): number {
    return scopes().reduce(
      (count, scope) =>
        count +
        scope.tasks.filter((task) => task.state === 'ASSIGNED' || task.state === 'RUNNING').length,
      0,
    );
  }

  function tick(): void {
    routeQueued();
    collectStep();
    unblockPass();
    reclaimPass();
    provisionPass();
    assignPass();
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
      queue: { readyTaskIds, blocked, blockedPolicy },
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
  };
}
