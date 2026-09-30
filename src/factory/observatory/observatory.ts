import type { StateStore } from '../state/store';

/**
 * E2 Observatory read-side projections (spec §23) over a minimal typed
 * evidence read port (controller ruling R2).
 *
 * E5 (verification/evidence) is the next phase and does not exist yet, so E2
 * defines only the *read* shape it needs and fakes it in tests. E5 supplies
 * the concrete `EvidenceReadPort` reader later; nothing here writes evidence,
 * and a projection is never a second source of truth — it is derived state.
 */

/** One verified change the Observatory counts. Supplied by E5's reader. */
export interface VerifiedChange {
  id: string;
  workOrderId: string;
  taskId: string;
  attemptId: string;
  /** ISO timestamp of verification. */
  verifiedAt: string;
  /** Human minutes attributable to this change. */
  humanMinutes: number;
  linesChanged: number;
  model: string | null;
  workerId: string | null;
}

/** The R2 read port: E5 will supply the concrete reader; tests fake it. */
export interface EvidenceReadPort {
  listVerifiedChanges(): VerifiedChange[];
}

/** The MVP placeholder reader used until E5 lands. Never fabricates evidence. */
export function createEmptyEvidenceReadPort(): EvidenceReadPort {
  return { listVerifiedChanges: () => [] };
}

/** The E1 attempt fields the seam reads (kept local; the store is untyped JSON). */
interface EvidenceAttemptRow {
  id: string;
  taskId: string;
  workerId: string | null;
  model: string | null;
  diff: string | null;
}

/** The E5 bundle fields the seam reads. */
interface EvidenceBundleRow {
  id: string;
  workOrderId: string;
  changeSetId: string;
  createdAt: string;
  complete: boolean;
  attempts: Array<{ attemptId: string }>;
}

/** Count non-empty diff lines (a cheap, deterministic size proxy). */
function diffLineCount(diff: string | null): number {
  if (!diff) return 0;
  return diff.split('\n').filter((line) => line.length > 0).length;
}

/**
 * The store-backed {@link EvidenceReadPort} seam (E9.1). E5 persists immutable
 * `evidence_bundles`; this projects each **complete** bundle (the durable
 * verified-change receipt) into the Observatory's read shape, resolving the
 * generating Attempt from the store for the task/worker/model/diff. It never
 * fabricates evidence — an incomplete bundle is not a verified change, and a
 * bundle whose Attempt cannot be resolved is skipped. `humanMinutes` is `0`
 * until E9.7 records the human-efficiency metadata the bundle does not yet
 * carry; the seam exists so the server no longer wires a dead placeholder.
 */
export function createEvidenceReadPort(store: StateStore): EvidenceReadPort {
  return {
    listVerifiedChanges(): VerifiedChange[] {
      const attempts = new Map(
        store.list<EvidenceAttemptRow>('attempts').map((attempt) => [attempt.id, attempt]),
      );
      const changes: VerifiedChange[] = [];
      for (const bundle of store.list<EvidenceBundleRow>('evidence_bundles')) {
        if (!bundle.complete) continue;
        // E5 stamps `changeSetId` as `cs_<attemptId>`; fall back to the last
        // recorded attempt for a bundle assembled under a different convention.
        const stamped = bundle.changeSetId.startsWith('cs_') ? bundle.changeSetId.slice(3) : null;
        const attemptId = stamped ?? bundle.attempts[bundle.attempts.length - 1]?.attemptId;
        const attempt = attemptId ? attempts.get(attemptId) : undefined;
        if (!attempt) continue;
        changes.push({
          id: bundle.id,
          workOrderId: bundle.workOrderId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          verifiedAt: bundle.createdAt,
          humanMinutes: 0,
          linesChanged: diffLineCount(attempt.diff),
          model: attempt.model,
          workerId: attempt.workerId,
        });
      }
      return changes;
    },
  };
}

export interface DailyThroughput {
  /** Calendar day (`YYYY-MM-DD`). */
  day: string;
  verifiedChanges: number;
  linesChanged: number;
}

export interface HumanHourThroughput {
  verifiedChanges: number;
  humanHours: number;
  verifiedChangesPerHumanHour: number;
}

export interface ObservatoryProjection {
  verifiedPerDay: DailyThroughput[];
  throughputPerHumanHour: HumanHourThroughput;
}

export interface ObservatoryWindow {
  /** Inclusive lower bound as `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive upper bound as `YYYY-MM-DD`. */
  to?: string;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function inWindow(iso: string, window: ObservatoryWindow): boolean {
  const day = dayOf(iso);
  if (window.from !== undefined && day < window.from) return false;
  if (window.to !== undefined && day > window.to) return false;
  return true;
}

/**
 * Project verified changes per day and verified throughput per human hour
 * (spec §23 primary metrics). Pure and read-only.
 */
export function projectObservatory(
  port: EvidenceReadPort,
  window: ObservatoryWindow = {},
): ObservatoryProjection {
  const changes = port.listVerifiedChanges().filter((change) => inWindow(change.verifiedAt, window));

  const byDay = new Map<string, DailyThroughput>();
  let totalHumanMinutes = 0;
  for (const change of changes) {
    const day = dayOf(change.verifiedAt);
    const bucket = byDay.get(day) ?? { day, verifiedChanges: 0, linesChanged: 0 };
    bucket.verifiedChanges += 1;
    bucket.linesChanged += change.linesChanged;
    byDay.set(day, bucket);
    totalHumanMinutes += change.humanMinutes;
  }

  const verifiedPerDay = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const humanHours = totalHumanMinutes / 60;
  return {
    verifiedPerDay,
    throughputPerHumanHour: {
      verifiedChanges: changes.length,
      humanHours,
      verifiedChangesPerHumanHour: humanHours > 0 ? changes.length / humanHours : 0,
    },
  };
}

/** A stage in the spec §23 drill-down chain. */
export interface DrillDownStage {
  stage:
    | 'work_order'
    | 'task'
    | 'attempt'
    | 'trace'
    | 'verification'
    | 'evidence'
    | 'human_decision';
  refs: string[];
  /** `stub` marks a stage E2 cannot resolve yet (owned by E5/E8). */
  status: 'available' | 'stub';
}

export interface DrillDown {
  workOrderId: string;
  chain: DrillDownStage[];
}

interface InteractionRow {
  id: string;
  taskId: string;
  status: string;
}

/**
 * Work Order → Task → Attempt → trace → verification → evidence → human
 * decision (spec §23). E2 resolves the Factory-owned stages from the store and
 * the evidence port; the E5-owned stages are honest stubs, not fabricated
 * evidence. Returns `null` for an unknown Work Order.
 */
export function projectDrillDown(
  port: EvidenceReadPort,
  store: StateStore,
  workOrderId: string,
): DrillDown | null {
  const workOrder = store.get<{ id: string }>('work_orders', workOrderId);
  if (!workOrder) return null;

  const tasks = store
    .list<{ id: string; workOrderId: string }>('tasks')
    .filter((task) => task.workOrderId === workOrderId);
  const taskIds = new Set(tasks.map((task) => task.id));
  const attempts = store
    .list<{ id: string; taskId: string }>('attempts')
    .filter((attempt) => taskIds.has(attempt.taskId));
  const changes = port
    .listVerifiedChanges()
    .filter((change) => change.workOrderId === workOrderId);
  const decisions = store
    .list<InteractionRow>('interactions')
    .filter((interaction) => taskIds.has(interaction.taskId));

  return {
    workOrderId,
    chain: [
      { stage: 'work_order', refs: [workOrder.id], status: 'available' },
      { stage: 'task', refs: tasks.map((task) => task.id), status: 'available' },
      { stage: 'attempt', refs: attempts.map((attempt) => attempt.id), status: 'available' },
      // trace is E8 telemetry; verification/evidence are E5. Stubs today.
      { stage: 'trace', refs: attempts.map((attempt) => attempt.id), status: 'stub' },
      {
        stage: 'verification',
        refs: changes.map((change) => change.id),
        status: changes.length > 0 ? 'available' : 'stub',
      },
      { stage: 'evidence', refs: changes.map((change) => change.id), status: 'stub' },
      {
        stage: 'human_decision',
        refs: decisions.map((interaction) => interaction.id),
        status: 'available',
      },
    ],
  };
}
