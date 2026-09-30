import { FactoryError } from '../domain/errors';
import {
  createWorkOrder,
  transitionWorkOrder,
  type WorkOrder,
} from '../domain/workOrder';
import type { EventLog } from '../events/log';
import type { StateStore } from '../state/store';
import type { TelemetryMetrics } from '../telemetry/telemetry';

/**
 * E8.1 (#24) Improvement-as-Work loop, Levels 1–2 only
 * (factory-docs/architecture/self-improving-factory-architecture.md).
 *
 * Self-improvement is **evaluated change**: identify a weakness, propose a
 * change to itself, benchmark the candidate against a baseline, qualify it, then
 * promote or reject under an explicit human gate. It is never an auto-applied
 * edit. The loop therefore produces first-class Work Orders — the ordinary,
 * gated path — and stops there: proposing, benchmarking and qualifying change
 * **nothing** about production behavior, and promotion only starts the Work
 * Order through the ordinary §5.1 edge.
 *
 * Scope (v0): Levels 1–2 only —
 *   1. runtime adaptation inside an Attempt; and
 *   2. experience/memory improvement (experience becomes future context).
 * Scaffold improvement (Level 3) and model improvement (Level 4) are explicitly
 * out of scope; this module ships no code path that edits control logic,
 * prompts, retrieval, routing, rubrics or model artifacts, and no capability to
 * update model parameters.
 *
 * Benchmark corpus discipline (spec §25): production telemetry and the dogfood
 * environment are distinct from the benchmark suite. Observations may come from
 * either, but only a benchmark-corpus run can qualify a candidate — dogfood
 * results never promote themselves.
 */

/** The Improvement-as-Work stages, in order. */
export const IMPROVEMENT_STAGES = ['observe', 'propose', 'benchmark', 'qualify', 'promote'] as const;
export type ImprovementStage = (typeof IMPROVEMENT_STAGES)[number];

/** The self-improvement levels v0 supports. Levels 3–4 are out of scope. */
export const IMPROVEMENT_LEVELS = [1, 2] as const;
export type ImprovementLevel = (typeof IMPROVEMENT_LEVELS)[number];

/** The distinct benchmark corpus (spec §25); never the dogfooding environment. */
export const BENCHMARK_CORPUS = 'benchmark';
/** Production dogfooding observations (spec §26); an input, not benchmark evidence. */
export const DOGFOODING_CORPUS = 'dogfooding';
export type Corpus = typeof BENCHMARK_CORPUS | typeof DOGFOODING_CORPUS;

/** What a Level 1–2 improvement changes. */
export type ImprovementKind = 'runtime_adaptation' | 'experience_memory';

export type ImprovementState =
  | 'PROPOSED'
  | 'BENCHMARKED'
  | 'QUALIFIED'
  | 'REJECTED'
  | 'PROMOTED';

export const IMPROVEMENT_PROPOSED = 'improvement.proposed';
export const IMPROVEMENT_BENCHMARKED = 'improvement.benchmarked';
export const IMPROVEMENT_QUALIFIED = 'improvement.qualified';
export const IMPROVEMENT_REJECTED = 'improvement.rejected';
export const IMPROVEMENT_PROMOTED = 'improvement.promoted';

const IMPROVEMENT_EVENT_TYPES = new Set([
  IMPROVEMENT_PROPOSED,
  IMPROVEMENT_BENCHMARKED,
  IMPROVEMENT_QUALIFIED,
  IMPROVEMENT_REJECTED,
  IMPROVEMENT_PROMOTED,
]);

/** A weakness observed in telemetry, fed into the Propose stage. */
export interface ObservedSignal {
  id: string;
  signal: string;
  detail: string;
  refs: string[];
}

export interface ImprovementProposalInput {
  level: number;
  title: string;
  intent: string;
  acceptanceCriteria: string[];
  rationale: string;
  /** Telemetry/evidence references the observation came from. */
  observedFrom: string[];
  /** Candidate version identifier, e.g. `experience-digest/v2`. */
  candidate: string;
  corpus: Corpus;
}

export interface ImprovementProposal {
  id: string;
  workOrderId: string;
  level: ImprovementLevel;
  kind: ImprovementKind;
  title: string;
  intent: string;
  acceptanceCriteria: string[];
  rationale: string;
  observedFrom: string[];
  candidate: string;
  corpus: Corpus;
  state: ImprovementState;
  createdAt: string;
  updatedAt: string;
}

/** The benchmark metrics compared between baseline and candidate (spec §25). */
export interface BenchmarkMetrics {
  verifiedOutcome: number;
  humanEffort: number;
  wallTimeMinutes: number;
  cost: number;
  firstPass: number;
  rework: number;
  quality: number;
  interventions: number;
}

export interface BenchmarkInput {
  corpus: Corpus;
  baseline: BenchmarkMetrics;
  candidate: BenchmarkMetrics;
}

/** A recorded benchmark run. `corpus` is always the benchmark corpus. */
export interface BenchmarkResult {
  id: string;
  proposalId: string;
  corpus: typeof BENCHMARK_CORPUS;
  baseline: BenchmarkMetrics;
  candidate: BenchmarkMetrics;
  at: string;
}

/** E1 deps-first shape: authoritative state + append-only event log. */
export interface ImprovementDeps {
  store: StateStore;
  events: EventLog;
}

function assertLevel(level: number): asserts level is ImprovementLevel {
  if (level !== 1 && level !== 2) {
    throw new FactoryError(
      'IMPROVEMENT_LEVEL_OUT_OF_SCOPE',
      `improvement level ${level} is out of scope: v0 supports Levels 1–2 only (runtime adaptation and experience/memory); scaffold and model improvement are not implemented`,
    );
  }
}

function append(
  deps: ImprovementDeps,
  type: string,
  proposal: ImprovementProposal,
  extra: Record<string, unknown> = {},
): void {
  deps.events.appendEvent({
    type,
    aggregateType: 'improvement_proposal',
    aggregateId: proposal.id,
    payload: { proposal, ...extra },
  });
}

function cloneMetrics(metrics: BenchmarkMetrics): BenchmarkMetrics {
  return { ...metrics };
}

/** A candidate is an improvement when verified output holds and effort or cost falls. */
function isImprovement(baseline: BenchmarkMetrics, candidate: BenchmarkMetrics): boolean {
  return (
    candidate.verifiedOutcome >= baseline.verifiedOutcome &&
    candidate.rework <= baseline.rework &&
    (candidate.humanEffort < baseline.humanEffort ||
      candidate.cost < baseline.cost ||
      candidate.firstPass > baseline.firstPass)
  );
}

/**
 * Observe weaknesses in the Factory's own telemetry (spec §26 micro/macro
 * metrics) and return the signals the Propose stage can act on. Pure and
 * read-only: observation changes nothing.
 */
export function observeImprovements(metrics: TelemetryMetrics): ObservedSignal[] {
  const signals: ObservedSignal[] = [];
  if (metrics.verifiedPerDay.length === 0) {
    signals.push({
      id: 'sig_no_verified_output',
      signal: 'no_verified_output',
      detail: 'no verified changes have landed in the observed window',
      refs: ['observatory:verifiedPerDay'],
    });
  }
  if (metrics.rework > 0) {
    signals.push({
      id: 'sig_rework',
      signal: 'rework',
      detail: `${metrics.rework} rework Attempt(s) recorded`,
      refs: ['observatory:rework'],
    });
  }
  if (metrics.cost.total > 0) {
    signals.push({
      id: 'sig_cost',
      signal: 'cost',
      detail: `recorded model/tool cost ${metrics.cost.total} ${metrics.cost.currency}`,
      refs: ['observatory:cost'],
    });
  }
  return signals;
}

/**
 * Propose a Level 1–2 improvement. The proposal lands as a real Work Order in
 * DRAFT — it is inert until an explicit benchmark, qualification and promotion.
 * Levels 3–4 and any unknown level are rejected here.
 */
export function proposeImprovement(
  deps: ImprovementDeps,
  input: ImprovementProposalInput,
): { proposal: ImprovementProposal; workOrder: WorkOrder } {
  assertLevel(input.level);
  const kind: ImprovementKind = input.level === 1 ? 'runtime_adaptation' : 'experience_memory';

  const workOrder = createWorkOrder(deps, {
    intent: input.intent,
    acceptanceCriteria: [...input.acceptanceCriteria],
    riskTier: 'YELLOW',
  });

  const now = new Date().toISOString();
  const proposal: ImprovementProposal = {
    id: `imp_${crypto.randomUUID()}`,
    workOrderId: workOrder.id,
    level: input.level,
    kind,
    title: input.title,
    intent: input.intent,
    acceptanceCriteria: [...input.acceptanceCriteria],
    rationale: input.rationale,
    observedFrom: [...input.observedFrom],
    candidate: input.candidate,
    corpus: input.corpus,
    state: 'PROPOSED',
    createdAt: now,
    updatedAt: now,
  };
  append(deps, IMPROVEMENT_PROPOSED, proposal);
  return { proposal, workOrder };
}

/**
 * States from which a candidate may be benchmarked (or re-benchmarked). The
 * machine is forward-only: QUALIFIED has recorded a decision and PROMOTED has
 * started work, so neither may silently regress to BENCHMARKED. A REJECTED
 * candidate may be re-benchmarked — explicit iteration, not a regression — only
 * once its re-run passes through qualify again.
 */
const BENCHMARKABLE_STATES = new Set<ImprovementState>(['PROPOSED', 'BENCHMARKED', 'REJECTED']);

/**
 * Benchmark a candidate against a baseline. Only the benchmark corpus is
 * accepted: a dogfooding run can never qualify a promotion (spec §25/§26).
 */
export function benchmarkImprovement(
  deps: ImprovementDeps,
  proposalId: string,
  input: BenchmarkInput,
): { proposal: ImprovementProposal; benchmark: BenchmarkResult } {
  const proposal = readImprovement(deps.events, proposalId);
  if (!proposal) {
    throw new FactoryError('IMPROVEMENT_NOT_FOUND', `improvement not found: ${proposalId}`);
  }
  assertLevel(proposal.level);
  if (!BENCHMARKABLE_STATES.has(proposal.state)) {
    throw new FactoryError(
      'IMPROVEMENT_NOT_BENCHMARKABLE',
      `improvement ${proposalId} cannot be benchmarked from state ${proposal.state}: it is forward-only (QUALIFIED records a decision, PROMOTED starts work); only PROPOSED, BENCHMARKED or a REJECTED candidate may be benchmarked`,
    );
  }
  if (input.corpus !== BENCHMARK_CORPUS) {
    throw new FactoryError(
      'BENCHMARK_CORPUS_REQUIRED',
      `corpus "${input.corpus}" cannot qualify an improvement: run the benchmark corpus, which stays distinct from dogfooding`,
    );
  }

  const now = new Date().toISOString();
  const benchmark: BenchmarkResult = {
    id: `bench_${crypto.randomUUID()}`,
    proposalId,
    corpus: BENCHMARK_CORPUS,
    baseline: cloneMetrics(input.baseline),
    candidate: cloneMetrics(input.candidate),
    at: now,
  };
  const updated: ImprovementProposal = { ...proposal, state: 'BENCHMARKED', updatedAt: now };
  append(deps, IMPROVEMENT_BENCHMARKED, updated, { benchmark });
  return { proposal: updated, benchmark };
}

/**
 * Qualify or reject a benchmarked candidate. Qualification only records a
 * decision; it changes no production behavior.
 *
 * The decision is made against the benchmark **recorded in the trail**, never
 * against a caller-supplied object: the `benchmark` argument is accepted only as
 * an id-checked reference to that recorded run. A caller cannot hand in
 * hand-written *improving* metrics for a run that actually regressed, and the
 * `benchmarkId` appended to the decision always names a run that exists.
 */
export function qualifyImprovement(
  deps: ImprovementDeps,
  proposalId: string,
  benchmark: BenchmarkResult,
): ImprovementProposal {
  const proposal = readImprovement(deps.events, proposalId);
  if (!proposal) {
    throw new FactoryError('IMPROVEMENT_NOT_FOUND', `improvement not found: ${proposalId}`);
  }
  if (proposal.state !== 'BENCHMARKED') {
    throw new FactoryError(
      'IMPROVEMENT_NOT_BENCHMARKED',
      `improvement ${proposalId} is not benchmarked (state ${proposal.state}); benchmark it before qualification`,
    );
  }
  if (benchmark.proposalId !== proposalId) {
    throw new FactoryError(
      'IMPROVEMENT_BENCHMARK_MISMATCH',
      `benchmark ${benchmark.id} belongs to improvement ${benchmark.proposalId}, not ${proposalId}`,
    );
  }
  const recorded = readRecordedBenchmark(deps.events, proposalId);
  if (!recorded) {
    throw new FactoryError(
      'IMPROVEMENT_NOT_BENCHMARKED',
      `improvement ${proposalId} has no recorded benchmark; benchmark it before qualification`,
    );
  }
  if (benchmark.id !== recorded.id) {
    throw new FactoryError(
      'IMPROVEMENT_BENCHMARK_MISMATCH',
      `benchmark ${benchmark.id} is not the benchmark recorded for improvement ${proposalId} (recorded ${recorded.id}); qualify only against the recorded trail`,
    );
  }
  if (recorded.corpus !== BENCHMARK_CORPUS) {
    throw new FactoryError(
      'BENCHMARK_CORPUS_REQUIRED',
      `corpus "${recorded.corpus}" cannot qualify an improvement: only a benchmark-corpus run qualifies`,
    );
  }

  const improved = isImprovement(recorded.baseline, recorded.candidate);
  const now = new Date().toISOString();
  const updated: ImprovementProposal = {
    ...proposal,
    state: improved ? 'QUALIFIED' : 'REJECTED',
    updatedAt: now,
  };
  append(deps, improved ? IMPROVEMENT_QUALIFIED : IMPROVEMENT_REJECTED, updated, {
    benchmarkId: recorded.id,
  });
  return updated;
}

/**
 * Promote a qualified improvement under the human gate. Promotion starts the
 * improvement Work Order (DRAFT → READY, the ordinary §5.1 edge); it is the
 * only step that begins work, and it mutates no control logic or model
 * artifacts. An unqualified improvement is refused.
 */
export function promoteImprovement(
  deps: ImprovementDeps,
  proposalId: string,
): { proposal: ImprovementProposal; workOrder: WorkOrder; authority: 'human_gate' } {
  const proposal = readImprovement(deps.events, proposalId);
  if (!proposal) {
    throw new FactoryError('IMPROVEMENT_NOT_FOUND', `improvement not found: ${proposalId}`);
  }
  if (proposal.state !== 'QUALIFIED') {
    throw new FactoryError(
      'IMPROVEMENT_NOT_QUALIFIED',
      `improvement ${proposalId} is not qualified (state ${proposal.state}); it must be benchmarked and qualified before promotion`,
    );
  }
  assertLevel(proposal.level);

  const workOrder = transitionWorkOrder(deps, proposal.workOrderId, {
    to: 'READY',
    reason: 'improvement promoted under human gate',
  });
  const now = new Date().toISOString();
  const updated: ImprovementProposal = { ...proposal, state: 'PROMOTED', updatedAt: now };
  append(deps, IMPROVEMENT_PROMOTED, updated, { authority: 'human_gate' });
  return { proposal: updated, workOrder, authority: 'human_gate' };
}

/** Read the latest proposal state from the append-only improvement event trail. */
export function readImprovement(events: EventLog, proposalId: string): ImprovementProposal | null {
  const trail = events
    .readEvents({ aggregateType: 'improvement_proposal', aggregateId: proposalId })
    .filter((event) => IMPROVEMENT_EVENT_TYPES.has(event.type));
  const last = trail[trail.length - 1];
  if (!last) return null;
  const payload = last.payload as { proposal?: ImprovementProposal } | null;
  return payload?.proposal ?? null;
}

/**
 * Read the latest benchmark recorded for a proposal from the append-only trail
 * (the run `benchmarkImprovement` appended). Qualification decides only against
 * this, so a caller-supplied object can never override the durable evidence.
 */
export function readRecordedBenchmark(events: EventLog, proposalId: string): BenchmarkResult | null {
  const trail = events
    .readEvents({ aggregateType: 'improvement_proposal', aggregateId: proposalId })
    .filter((event) => event.type === IMPROVEMENT_BENCHMARKED);
  const last = trail[trail.length - 1];
  if (!last) return null;
  const payload = last.payload as { benchmark?: BenchmarkResult } | null;
  return payload?.benchmark ?? null;
}
