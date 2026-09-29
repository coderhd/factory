/**
 * Generic DecisionModel seam for Factory runtime routing (design spec §8;
 * addendum: factory-docs/architecture/software-factory-decision-models.md).
 *
 * Types only — no implementation lives here. The seam is
 * implementation-neutral: a DecisionModel may be deterministic rules, a
 * statistical/ML model, a bounded System 1 model, LLM/System 2 reasoning, an
 * ensemble, or a human decision process. It can recommend, rank, classify or
 * score; the Factory stays authoritative over assignments and state
 * transitions (spec §8, addendum authority invariants).
 *
 * Portability rule: nothing in this module may name a concrete provider or
 * model. `ModelId` is opaque and deployment-defined; provider-specific model
 * catalogs live in a deployment's own mapping layer, never here. Challenger
 * decision models stay behind this seam, shadow-only, and are never promoted
 * to typed runtime concepts (ADR 13:
 * factory-docs/decisions/adr-13-generic-decision-model.md).
 */

/** Task-capability vocabulary routing decides on (generic, not provider-specific). */
export type TaskType =
  | 'exploration'
  | 'repository-analysis'
  | 'planning'
  | 'architecture'
  | 'implementation'
  | 'refactoring'
  | 'debugging'
  | 'test-generation'
  | 'test-debugging'
  | 'ci-troubleshooting'
  | 'documentation'
  | 'code-review'
  | 'security-review'
  | 'adversarial-review'
  | 'second-opinion'
  | 'large-context-analysis';

export type Complexity = 'trivial' | 'simple' | 'normal' | 'complex';
export type Risk = 'low' | 'medium' | 'high';
export type ContextSize = 'small' | 'medium' | 'large' | 'xlarge';

/**
 * Opaque, deployment-defined model identifier. Deliberately NOT a union of
 * concrete provider/model IDs: the runtime seam stays provider-agnostic and a
 * deployment maps its own catalog onto these identifiers (ADR 13).
 */
export type ModelId = string;

/** Normalized remaining budget per quota window, as fractions 0..1. */
export interface BudgetState {
  /** Fraction 0..1 of the monthly window remaining. */
  monthlyRemaining: number;
  /** Fraction 0..1 of the weekly (50% of monthly) window remaining. */
  weeklyRemaining: number;
  /** Fraction 0..1 of the 5-hour (20% of monthly) window remaining. */
  fiveHourRemaining: number;
}

/** The task shape a routing decision is made from (spec §8 routing factors). */
export interface RouteInput {
  task: TaskType;
  complexity: Complexity;
  risk: Risk;
  context: ContextSize;
}

/**
 * One routing decision plus the snapshot it was made from.
 *
 * `source` is the structured provenance marker (E4.2, carried in from the
 * E4.1 review): it says *how* the decision was made, so callers never have
 * to parse `reason` strings. An override whose model was unavailable falls
 * back to the rules, and that decision is marked `rules` — a naive
 * `source: override ? 'override' : 'rules'` at the call site would
 * mislabel it.
 */
export interface RouteDecision {
  selected: ModelId;
  candidates: ModelId[];
  reason: string;
  source: RoutingDecisionSource;
  metadata: {
    task: TaskType;
    complexity: Complexity;
    risk: Risk;
    context: ContextSize;
    unavailable: ModelId[];
    budget: BudgetState;
  };
}

/**
 * Implementation-neutral decision seam (addendum "Decision Model"):
 * `recommend` returns an ordered candidate list for a task shape. It never
 * performs I/O, never mutates Factory state, and never assigns — the Factory
 * makes the actual assignment (spec §8).
 */
export interface DecisionModel {
  recommend(input: RouteInput): ModelId[];
}

/** How a routing decision was made (provenance). */
export type RoutingDecisionSource = 'rules' | 'override';

/**
 * The durable routing-decision record for the `routing_decisions` table
 * (spec §8 "Routing recommendations are recorded"). Carries the full
 * task/complexity/risk/context/budget snapshot plus the recommendation it
 * came from, so every assignment can be audited and later fed back into
 * routing. `source` is copied from the decision's structured marker (see
 * `RouteDecision`), never from a caller's label. E4.2 owns the concrete
 * writer (state row + event); E8 telemetry consumes these records.
 */
export interface RoutingDecisionRecord {
  id: string;
  workOrderId: string | null;
  taskId: string | null;
  source: RoutingDecisionSource;
  task: TaskType;
  complexity: Complexity;
  risk: Risk;
  context: ContextSize;
  selected: ModelId;
  candidates: ModelId[];
  reason: string;
  unavailable: ModelId[];
  budget: BudgetState;
  createdAt: string;
}
