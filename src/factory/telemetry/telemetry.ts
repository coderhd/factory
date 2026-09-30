import { FactoryError } from '../domain/errors';
import type { Attempt, RiskTier, Task, WorkOrder } from '../domain/workOrder';
import type { EventLog } from '../events/log';
import type { EvidenceBundle } from '../evidence/bundle';
import {
  projectObservatory,
  type DailyThroughput,
  type DrillDown,
  type DrillDownStage,
  type EvidenceReadPort,
  type HumanHourThroughput,
  type ObservatoryWindow,
} from '../observatory/observatory';
import type { RoutingDecisionRecord } from '../routing/decisionModel';
import type { StateStore } from '../state/store';
import type { VerificationRun } from '../verification/engine';

/**
 * E8.1 (#24) telemetry layers (design spec §23–§24).
 *
 * Every Attempt records six layers — outcome, human leverage, execution,
 * quality, economics and decision — derived from durable Factory state (E1
 * events/store, E4 `routing_decisions`, E5 verification/evidence) plus the
 * runtime observables E1 does not persist (tool calls, model/tool cost). The
 * decision layer records the *why*: which model and why (E4), which skill and
 * what context (E1 Attempt provenance), the risk assigned (E1 Work Order),
 * allow/deny (E7's `policy_decisions`, an honest stub until E7 records), when
 * replanning occurred (E1 `failureHistory`) and human gate decisions (E1
 * events).
 *
 * A projection is never a second source of truth: `projectAttemptTelemetry`
 * derives read-only state and `recordAttemptTelemetry` persists the derived
 * record as one append-only `telemetry.attempt_recorded` event (the receipt).
 * Missing data is surfaced as an honest stub, never fabricated — the same
 * discipline E2 applies to its drill-down stages.
 *
 * The drill-down projection resolves the full spec §23 chain
 * Work Order → Task → Attempt → trace → verification → evidence → decision. It
 * is additive to E2's partial projection (which intentionally stubbed the
 * trace/evidence stages before E5/E8 existed).
 */

/** The six telemetry layers (spec §24), in order. */
export const TELEMETRY_LAYERS = [
  'outcome',
  'human_leverage',
  'execution',
  'quality',
  'economics',
  'decision',
] as const;
export type TelemetryLayer = (typeof TELEMETRY_LAYERS)[number];

/** Event type for a persisted per-Attempt telemetry receipt. */
export const TELEMETRY_ATTEMPT_RECORDED = 'telemetry.attempt_recorded';

/** The read ports telemetry derives from: E1 state/log, E2/E5 evidence. */
export interface TelemetryDeps {
  store: StateStore;
  events: EventLog;
  evidence: EvidenceReadPort;
}

/** Layer 1 — outcome: what the Attempt produced and where its Task/Work Order stand. */
export interface OutcomeTelemetry {
  outcome: string | null;
  taskState: Task['state'] | null;
  workOrderState: WorkOrder['state'] | null;
  /** True when durable evidence (a complete bundle or a passing run) attests the change. */
  verified: boolean;
}

/** Layer 2 — human leverage: the human effort and interventions attributable to the Attempt. */
export interface HumanLeverageTelemetry {
  humanMinutes: number;
  /** Human questions raised on the Attempt's Task. */
  questions: number;
  /** Questions a human actually answered. */
  interventions: number;
  /** Human gate decisions recorded for the Work Order. */
  gateDecisions: number;
}

/** One step in the §24 trace tree (model calls, retrieval, tool calls, verification). */
export interface TraceStep {
  kind: 'model_call' | 'retrieval' | 'tool_call' | 'verification';
  at: string;
  ref: string | null;
  detail: string | null;
}

/** Layer 3 — execution: the provenance and trace of the Attempt. */
export interface ExecutionTelemetry {
  model: string | null;
  workerId: string | null;
  skills: string[];
  context: string | null;
  environment: string | null;
  trace: TraceStep[];
}

/** Layer 4 — quality: verification outcome this Attempt reached. */
export interface QualityTelemetry {
  verificationRunIds: string[];
  /** `null` when no verification has run — unknown, never a silent pass. */
  passed: boolean | null;
  /** No rework required and no recorded failure: the first Attempt held. */
  firstPass: boolean;
  /** Attempts on the same Task beyond the first (rework attempts). */
  reworkCount: number;
  failureCount: number;
  failures: string[];
}

/** Layer 5 — economics: model/tool cost of the Attempt, from runtime observables. */
export interface EconomicsTelemetry {
  modelCost: number | null;
  toolCost: number | null;
  totalCost: number | null;
  currency: string;
}

/** Why an E4 routing decision selected a model (spec §24 "why a model was selected"). */
export interface ModelDecisionWhy {
  ref: string;
  selected: string;
  source: 'rules' | 'override';
  reason: string;
  candidates: string[];
}

/** Which skills the Attempt used; the *why* is not persisted by E1 (honest `null`). */
export interface SkillWhy {
  selected: string[];
  reason: string | null;
}

/** What context was retrieved for the Attempt (E1 Attempt provenance). */
export interface ContextWhy {
  retrieved: string | null;
}

/** One allow/deny policy decision (E7 `policy_decisions`, read structurally). */
export interface AllowDenyWhy {
  ref: string;
  action: string | null;
  decision: string | null;
  reason: string | null;
}

/** One replan/recovery the Attempt recorded (E1 `failureHistory`). */
export interface ReplanWhy {
  at: string;
  failure: string;
  recovery: string | null;
}

/** One human gate decision on the Work Order (E1 `work_order.transitioned`). */
export interface GateWhy {
  ref: string;
  to: string;
  reason: string | null;
}

/** Layer 6 — decision telemetry: the why behind the Attempt (spec §24). */
export interface DecisionTelemetry {
  model: ModelDecisionWhy[];
  skill: SkillWhy;
  context: ContextWhy;
  risk: RiskTier | null;
  allowDeny: AllowDenyWhy[];
  /** `stub` when no policy decision exists for this Attempt (E7 does not record yet). */
  allowDenyStatus: 'available' | 'stub';
  replan: ReplanWhy[];
  gate: GateWhy[];
}

export interface AttemptTelemetry {
  attemptId: string;
  taskId: string;
  workOrderId: string | null;
  recordedAt: string;
  layers: {
    outcome: OutcomeTelemetry;
    human_leverage: HumanLeverageTelemetry;
    execution: ExecutionTelemetry;
    quality: QualityTelemetry;
    economics: EconomicsTelemetry;
    decision: DecisionTelemetry;
  };
}

/**
 * Runtime facts E1 does not persist. The Eye of the runtime sees tool calls and
 * model/tool spend; nothing here is invented when it is not supplied.
 */
export interface AttemptObservables {
  economics?: { modelCost?: number; toolCost?: number; currency?: string };
  toolCalls?: Array<{ at: string; ref: string; detail?: string }>;
}

/** Observatory metrics (spec §23 primary + E8 additions: rework and cost). */
export interface TelemetryMetrics {
  generatedAt: string;
  verifiedPerDay: DailyThroughput[];
  throughputPerHumanHour: HumanHourThroughput;
  rework: number;
  cost: { total: number; currency: string };
}

const GATE_STATES = new Set(['APPROVED', 'REJECTED', 'REWORK']);

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
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

function attemptsForTask(store: StateStore, taskId: string): Attempt[] {
  return store
    .list<Attempt>('attempts')
    .filter((attempt) => attempt.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function routingDecisionsFor(store: StateStore, attempt: Attempt, workOrder: WorkOrder | null) {
  return store
    .list<RoutingDecisionRecord>('routing_decisions')
    .filter(
      (record) =>
        record.taskId === attempt.taskId ||
        (record.taskId === null && workOrder !== null && record.workOrderId === workOrder.id),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function policyDecisionsFor(store: StateStore, attempt: Attempt) {
  const rows = store.list<unknown>('policy_decisions');
  const matched: AllowDenyWhy[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) continue;
    const attemptId = nonEmpty(row.attemptId);
    const taskId = nonEmpty(row.taskId);
    if (attemptId !== attempt.id && taskId !== attempt.taskId) continue;
    matched.push({
      ref: nonEmpty(row.id) ?? `policy_${matched.length}`,
      action: nonEmpty(row.action),
      decision: nonEmpty(row.decision),
      reason: nonEmpty(row.reason),
    });
  }
  return matched;
}

function gateDecisionsFor(
  store: StateStore,
  events: EventLog,
  workOrder: WorkOrder | null,
): GateWhy[] {
  if (!workOrder) return [];
  const gates: GateWhy[] = [];
  for (const event of events.readEvents({ aggregateType: 'work_order', aggregateId: workOrder.id })) {
    if (event.type !== 'work_order.transitioned') continue;
    const payload = asRecord(event.payload);
    const updated = asRecord(payload?.workOrder);
    const to = nonEmpty(updated?.state);
    if (!to || !GATE_STATES.has(to)) continue;
    gates.push({ ref: event.id, to, reason: nonEmpty(payload?.reason) });
  }
  return gates;
}

function evidenceBundlesFor(store: StateStore, workOrderId: string | null): EvidenceBundle[] {
  if (!workOrderId) return [];
  return store
    .list<EvidenceBundle>('evidence_bundles')
    .filter((bundle) => bundle.workOrderId === workOrderId);
}

function buildLayers(
  deps: TelemetryDeps,
  attempt: Attempt,
  task: Task | null,
  workOrder: WorkOrder | null,
  observables: AttemptObservables,
): AttemptTelemetry['layers'] {
  const { store, events, evidence } = deps;
  const taskAttempts = attemptsForTask(store, attempt.taskId);
  const reworkCount = Math.max(0, taskAttempts.length - 1);

  const runs = attempt.verificationRunIds
    .map((id) => store.get<VerificationRun>('verification_runs', id))
    .filter((run): run is VerificationRun => run !== null);
  const bundle = evidenceBundlesFor(store, workOrder?.id ?? null).find(
    (candidate) =>
      candidate.changeSetId === `cs_${attempt.id}` ||
      attempt.verificationRunIds.includes(candidate.changeSetId),
  );
  const passed = runs.length > 0 ? runs[runs.length - 1]!.passed : bundle ? bundle.gates.run : null;
  const verified = (bundle?.complete ?? false) || (runs.length > 0 && runs[runs.length - 1]!.passed);

  const interactions = store
    .list<Record<string, unknown>>('interactions')
    .filter((interaction) => nonEmpty(interaction.taskId) === attempt.taskId);
  const gates = gateDecisionsFor(store, events, workOrder);
  const humanMinutes = evidence
    .listVerifiedChanges()
    .filter((change) => change.attemptId === attempt.id)
    .reduce((sum, change) => sum + change.humanMinutes, 0);

  const trace: TraceStep[] = [];
  if (attempt.model) {
    trace.push({ kind: 'model_call', at: attempt.createdAt, ref: attempt.model, detail: null });
  }
  if (attempt.context) {
    trace.push({ kind: 'retrieval', at: attempt.createdAt, ref: attempt.context, detail: null });
  }
  for (const call of observables.toolCalls ?? []) {
    trace.push({ kind: 'tool_call', at: call.at, ref: call.ref, detail: call.detail ?? null });
  }
  for (const run of runs) {
    trace.push({
      kind: 'verification',
      at: attempt.updatedAt,
      ref: run.changeSetId,
      detail: run.passed ? 'pass' : 'fail',
    });
  }

  const modelCost = observables.economics?.modelCost ?? null;
  const toolCost = observables.economics?.toolCost ?? null;
  const currency = observables.economics?.currency ?? 'USD';
  const totalCost = modelCost === null && toolCost === null ? null : (modelCost ?? 0) + (toolCost ?? 0);

  const allowDeny = policyDecisionsFor(store, attempt);
  const modelWhy: ModelDecisionWhy[] = routingDecisionsFor(store, attempt, workOrder).map(
    (record) => ({
      ref: record.id,
      selected: record.selected,
      source: record.source,
      reason: record.reason,
      candidates: [...record.candidates],
    }),
  );
  const failures = [
    ...runs.flatMap((run) => run.failures.map((failure) => `${failure.verifier}: ${failure.diagnosis}`)),
    ...attempt.failureHistory.map((failure) => failure.failure),
  ];

  return {
    outcome: {
      outcome: attempt.outcome,
      taskState: task?.state ?? null,
      workOrderState: workOrder?.state ?? null,
      verified,
    },
    human_leverage: {
      humanMinutes,
      questions: interactions.length,
      interventions: interactions.filter((interaction) => interaction.status === 'ANSWERED').length,
      gateDecisions: gates.length,
    },
    execution: {
      model: attempt.model,
      workerId: attempt.workerId,
      skills: [...attempt.skills],
      context: attempt.context,
      environment: attempt.environment,
      trace,
    },
    quality: {
      verificationRunIds: [...attempt.verificationRunIds],
      passed,
      firstPass: reworkCount === 0 && passed !== false,
      reworkCount,
      failureCount: attempt.failureHistory.length,
      failures,
    },
    economics: { modelCost, toolCost, totalCost, currency },
    decision: {
      model: modelWhy,
      skill: { selected: [...attempt.skills], reason: null },
      context: { retrieved: attempt.context },
      risk: workOrder?.riskTier ?? null,
      allowDeny,
      allowDenyStatus: allowDeny.length > 0 ? 'available' : 'stub',
      replan: attempt.failureHistory.map((failure) => ({
        at: failure.at,
        failure: failure.failure,
        recovery: failure.recovery ?? null,
      })),
      gate: gates,
    },
  };
}

/**
 * Derive the six telemetry layers for one Attempt without persisting anything.
 * Returns `null` for an unknown Attempt (a projection, not an error).
 */
export function projectAttemptTelemetry(
  deps: TelemetryDeps,
  attemptId: string,
  observables: AttemptObservables = {},
): AttemptTelemetry | null {
  const attempt = deps.store.get<Attempt>('attempts', attemptId);
  if (!attempt) return null;
  const task = deps.store.get<Task>('tasks', attempt.taskId);
  const workOrder = task ? deps.store.get<WorkOrder>('work_orders', task.workOrderId) : null;

  return {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    workOrderId: workOrder?.id ?? null,
    recordedAt: new Date().toISOString(),
    layers: buildLayers(deps, attempt, task, workOrder, observables),
  };
}

/**
 * Record the six telemetry layers for one Attempt: derive them, then append one
 * `telemetry.attempt_recorded` event carrying the receipt. Persisting a receipt
 * never mutates execution state. Throws `ATTEMPT_NOT_FOUND` for an unknown id.
 */
export function recordAttemptTelemetry(
  deps: TelemetryDeps,
  attemptId: string,
  observables: AttemptObservables = {},
): AttemptTelemetry {
  const record = projectAttemptTelemetry(deps, attemptId, observables);
  if (!record) {
    throw new FactoryError('ATTEMPT_NOT_FOUND', `cannot record telemetry for unknown attempt: ${attemptId}`);
  }
  deps.events.appendEvent({
    type: TELEMETRY_ATTEMPT_RECORDED,
    aggregateType: 'attempt',
    aggregateId: attemptId,
    payload: { record },
  });
  return record;
}

/** Read the latest recorded telemetry receipt for an Attempt, or `null`. */
export function readAttemptTelemetry(events: EventLog, attemptId: string): AttemptTelemetry | null {
  const receipts = events
    .readEvents({ aggregateType: 'attempt', aggregateId: attemptId })
    .filter((event) => event.type === TELEMETRY_ATTEMPT_RECORDED);
  const last = receipts[receipts.length - 1];
  if (!last) return null;
  const payload = asRecord(last.payload);
  return (payload?.record as AttemptTelemetry | undefined) ?? null;
}

function telemetryAttemptIds(events: EventLog): Set<string> {
  const ids = new Set<string>();
  for (const event of events.readEvents()) {
    if (event.type === TELEMETRY_ATTEMPT_RECORDED && event.aggregateType === 'attempt') {
      ids.add(event.aggregateId);
    }
  }
  return ids;
}

/**
 * Project the full spec §23 drill-down chain for one Work Order:
 * work_order → task → attempt → trace → verification → evidence → decision.
 *
 * Factory-owned stages resolve from E1; `trace` resolves from recorded E8
 * telemetry, `verification`/`evidence` from E5's durable rows, and
 * `human_decision` from E1 interactions. A stage with no data is an honest stub
 * (`refs: []`), never fabricated. Returns `null` for an unknown Work Order.
 */
export function projectDrillDown(deps: TelemetryDeps, workOrderId: string): DrillDown | null {
  const { store, events } = deps;
  const workOrder = store.get<WorkOrder>('work_orders', workOrderId);
  if (!workOrder) return null;

  const tasks = store
    .list<Task>('tasks')
    .filter((task) => task.workOrderId === workOrderId);
  const taskIds = new Set(tasks.map((task) => task.id));
  const attempts = store
    .list<Attempt>('attempts')
    .filter((attempt) => taskIds.has(attempt.taskId));

  const recorded = telemetryAttemptIds(events);
  const traceRefs = attempts.map((attempt) => attempt.id).filter((id) => recorded.has(id));

  const verificationRefs: string[] = [];
  const seenRefs = new Set<string>();
  for (const attempt of attempts) {
    for (const runId of attempt.verificationRunIds) {
      if (store.get<VerificationRun>('verification_runs', runId) && !seenRefs.has(runId)) {
        seenRefs.add(runId);
        verificationRefs.push(runId);
      }
    }
  }
  // E5's run rows and its verified-change read port are two views of the same
  // tier: union them so the stage resolves whichever path E5 populated.
  for (const change of deps.evidence.listVerifiedChanges()) {
    if (change.workOrderId === workOrderId && !seenRefs.has(change.id)) {
      seenRefs.add(change.id);
      verificationRefs.push(change.id);
    }
  }

  const evidenceRefs = store
    .list<EvidenceBundle>('evidence_bundles')
    .filter((bundle) => bundle.workOrderId === workOrderId)
    .map((bundle) => bundle.id);

  const decisionRefs = store
    .list<Record<string, unknown>>('interactions')
    .filter((interaction) => {
      const taskId = nonEmpty(interaction.taskId);
      return taskId !== null && taskIds.has(taskId);
    })
    .map((interaction) => nonEmpty(interaction.id))
    .filter((id): id is string => id !== null);

  const stage = (name: DrillDownStage['stage'], refs: string[]): DrillDownStage => ({
    stage: name,
    refs,
    status: refs.length > 0 ? 'available' : 'stub',
  });

  return {
    workOrderId,
    chain: [
      stage('work_order', [workOrder.id]),
      stage('task', tasks.map((task) => task.id)),
      stage('attempt', attempts.map((attempt) => attempt.id)),
      stage('trace', traceRefs),
      stage('verification', verificationRefs),
      stage('evidence', evidenceRefs),
      stage('human_decision', decisionRefs),
    ],
  };
}

/** Every recorded telemetry receipt in the append-only log, in sequence order. */
function readAllTelemetry(events: EventLog): AttemptTelemetry[] {
  const records: AttemptTelemetry[] = [];
  for (const event of events.readEvents()) {
    if (event.type !== TELEMETRY_ATTEMPT_RECORDED) continue;
    const record = asRecord(event.payload)?.record;
    if (record && typeof record === 'object') records.push(record as AttemptTelemetry);
  }
  return records;
}

/**
 * Project the Observatory metrics (spec §23): verified changes/day, verified
 * throughput per human hour (reusing E2's projection over the same evidence
 * port), rework attempts, and recorded model/tool cost.
 */
export function projectTelemetryMetrics(
  deps: TelemetryDeps,
  window: ObservatoryWindow = {},
): TelemetryMetrics {
  const { store, events, evidence } = deps;
  const base = projectObservatory(evidence, window);

  const byTask = new Map<string, Attempt[]>();
  for (const attempt of store.list<Attempt>('attempts')) {
    if (!inWindow(attempt.createdAt, window)) continue;
    const list = byTask.get(attempt.taskId) ?? [];
    list.push(attempt);
    byTask.set(attempt.taskId, list);
  }
  let rework = 0;
  for (const attempts of byTask.values()) rework += Math.max(0, attempts.length - 1);

  let total = 0;
  let currency = 'USD';
  let sawCurrency = false;
  for (const record of readAllTelemetry(events)) {
    if (!inWindow(record.recordedAt, window)) continue;
    const costs = record.layers?.economics;
    if (!costs || costs.totalCost === null) continue;
    total += costs.totalCost;
    if (!sawCurrency && costs.currency) {
      currency = costs.currency;
      sawCurrency = true;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    verifiedPerDay: base.verifiedPerDay,
    throughputPerHumanHour: base.throughputPerHumanHour,
    rework,
    cost: { total, currency },
  };
}

/** Re-exported for consumers that only speak the telemetry module. */
export type { DailyThroughput, DrillDown, DrillDownStage, HumanHourThroughput, ObservatoryWindow };
