import type {
  BudgetState,
  DecisionModel,
  ModelId,
  RouteDecision,
  RouteInput,
  RoutingDecisionRecord,
} from './decisionModel';

/**
 * Deterministic rules port — the default DecisionModel implementation for
 * Factory runtime routing (design:
 * factory-docs/architecture/decision-model-routing-core.md; ADR 13).
 *
 * Ported from the dev router (`.opencode/plugins/factory-guard/router.ts` +
 * `routing-policy.md`) with every provider-specific model ID replaced by a
 * generic capability identifier: same ordered candidate lists, same budget
 * gates, same fallback discipline. Selection is capability-first, then
 * budget-filtered; blocked candidates are skipped in list order and the walk
 * never jumps straight to the most expensive model.
 */

/** Routing cost tiers (routing vocabulary, not vendor rank). */
export type CostTier = 'cheap' | 'mid' | 'escalation';

/**
 * Generic capability identifiers for the ported model pool. Each names the
 * role a deployment's concrete model plays, never a concrete provider/model.
 */
export type CapabilityModelId =
  | 'generalist' // high-volume general work (cheap)
  | 'explorer' // exploration / utility reads (cheap)
  | 'implementer' // implementation / testing at volume (cheap)
  | 'independent-opinion' // cheap independent second opinion (cheap)
  | 'loop-solver' // difficult debugging loops (mid)
  | 'reviewer' // review / planning strength at mid cost (mid)
  | 'planner' // planning / architecture lead at mid cost (mid)
  | 'frontier' // top capability, escalation-only (escalation)
  | 'adversarial' // frontier review / adversarial work (escalation)
  | 'diversifier'; // reasoning diversity, escalation (escalation)

/** Cost tier per capability identifier (ported from the dev router's tiers). */
export const MODEL_TIER: Record<CapabilityModelId, CostTier> = {
  generalist: 'cheap',
  explorer: 'cheap',
  implementer: 'cheap',
  'independent-opinion': 'cheap',
  'loop-solver': 'mid',
  reviewer: 'mid',
  planner: 'mid',
  frontier: 'escalation',
  adversarial: 'escalation',
  diversifier: 'escalation',
};

/**
 * The whole pool in fallback order: cheapest first, escalation last. The
 * last-resort walk uses this order, so a blocked candidate list degrades to
 * the cheapest unblocked model, never to the most expensive one.
 */
export const CAPABILITY_POOL: readonly CapabilityModelId[] = [
  'explorer',
  'generalist',
  'implementer',
  'independent-opinion',
  'loop-solver',
  'reviewer',
  'planner',
  'frontier',
  'adversarial',
  'diversifier',
];

/**
 * Budget gates per cost tier, as fractions of each quota window that must
 * remain. Escalation needs monthly >= 30%, weekly >= 30%, 5h >= 20%; mid
 * needs monthly >= 10%, weekly >= 10%, 5h >= 5%; cheap is never gated.
 */
export const BUDGET_GATES: Readonly<Record<CostTier, BudgetState>> = {
  cheap: { monthlyRemaining: 0, weeklyRemaining: 0, fiveHourRemaining: 0 },
  mid: { monthlyRemaining: 0.1, weeklyRemaining: 0.1, fiveHourRemaining: 0.05 },
  escalation: { monthlyRemaining: 0.3, weeklyRemaining: 0.3, fiveHourRemaining: 0.2 },
};

/** A fully funded budget; the default when a caller has no budget signal. */
export const FULL_BUDGET: BudgetState = {
  monthlyRemaining: 1,
  weeklyRemaining: 1,
  fiveHourRemaining: 1,
};

/** Cost tier of a model. Unknown identifiers fall back to the cheap tier. */
function tierOf(model: ModelId): CostTier {
  return (MODEL_TIER as Record<string, CostTier | undefined>)[model] ?? 'cheap';
}

/**
 * Capability matrix: ordered candidate lists per task shape, ported from the
 * dev router. Order matters — the budget/availability walk moves down this
 * list and never jumps straight to the most expensive model.
 */
export function candidatesFor(input: RouteInput): ModelId[] {
  const { task, complexity, risk, context } = input;

  if (task === 'exploration' || task === 'repository-analysis' || task === 'large-context-analysis') {
    if (context === 'xlarge' || context === 'large') {
      return ['loop-solver', 'explorer', 'generalist', 'implementer'];
    }
    return ['explorer', 'generalist', 'implementer'];
  }
  if (task === 'implementation' || task === 'refactoring') {
    if (complexity === 'simple' || complexity === 'trivial') {
      return ['generalist', 'implementer', 'explorer'];
    }
    if (complexity === 'complex') {
      return ['loop-solver', 'reviewer', 'planner', 'implementer'];
    }
    return ['implementer', 'generalist', 'loop-solver'];
  }
  if (task === 'debugging' || task === 'test-debugging' || task === 'ci-troubleshooting') {
    return ['loop-solver', 'reviewer', 'planner'];
  }
  if (task === 'test-generation' || task === 'documentation') {
    return ['implementer', 'generalist', 'explorer'];
  }
  if (task === 'planning') return ['planner', 'reviewer', 'frontier'];
  if (task === 'architecture') return ['planner', 'frontier', 'reviewer'];
  if (task === 'code-review') {
    if (risk === 'high') return ['frontier', 'adversarial', 'reviewer'];
    return ['reviewer', 'planner', 'loop-solver'];
  }
  if (task === 'security-review' || task === 'adversarial-review') {
    return ['frontier', 'adversarial', 'diversifier'];
  }
  if (task === 'second-opinion') return ['independent-opinion', 'reviewer', 'diversifier'];
  return ['generalist', 'implementer', 'explorer'];
}

/** Budget gate: a model's tier must have a healthy budget on every window. */
export function budgetAllows(model: ModelId, budget: BudgetState): boolean {
  const gate = BUDGET_GATES[tierOf(model)];
  return (
    budget.monthlyRemaining >= gate.monthlyRemaining &&
    budget.weeklyRemaining >= gate.weeklyRemaining &&
    budget.fiveHourRemaining >= gate.fiveHourRemaining
  );
}

function explainSelection(input: RouteInput, model: ModelId, budget: BudgetState): string {
  const tier = tierOf(model);
  return (
    `task=${input.task}, complexity=${input.complexity}, risk=${input.risk}, ` +
    `context=${input.context} -> ${model} (${tier} tier; ` +
    `budget m=${Math.round(budget.monthlyRemaining * 100)}%/w=${Math.round(budget.weeklyRemaining * 100)}%` +
    `/5h=${Math.round(budget.fiveHourRemaining * 100)}%).`
  );
}

/**
 * Thrown when every pool member is blocked by availability or budget. A caller
 * maps this to `WAITING_RESOURCE` (or equivalent) — never a silent substitution
 * of a blocked model.
 */
export class RoutingBlockedError extends Error {
  readonly code = 'ROUTING_BLOCKED';
  constructor(
    readonly candidates: ModelId[],
    readonly unavailable: ModelId[],
    readonly budget: BudgetState,
  ) {
    super('routing blocked: every candidate model is unavailable or budget-exhausted');
    this.name = 'RoutingBlockedError';
  }
}

/**
 * Capability-first, budget-filtered selection: walk the ordered candidate list
 * and return the first model that is neither unavailable nor budget-blocked.
 * Last resort: the cheapest pool model that is not blocked either — never a
 * jump straight to the most expensive model. If the entire pool is blocked the
 * decision is refused with a distinguishable {@link RoutingBlockedError} so the
 * caller can park on `WAITING_RESOURCE` rather than run an unavailable model.
 */
export function selectModel(
  input: RouteInput,
  budget: BudgetState = FULL_BUDGET,
  unavailable: ModelId[] = [],
): RouteDecision {
  const candidates = candidatesFor(input);
  const blocked = new Set(unavailable);
  for (const model of candidates) {
    if (blocked.has(model)) continue;
    if (!budgetAllows(model, budget)) continue;
    return {
      selected: model,
      candidates,
      reason: explainSelection(input, model, budget),
      source: 'rules',
      metadata: { ...input, unavailable: [...unavailable], budget: { ...budget } },
    };
  }
  const fallback = CAPABILITY_POOL.find(
    (model) => !blocked.has(model) && budgetAllows(model, budget),
  );
  if (!fallback) throw new RoutingBlockedError(candidates, [...unavailable], { ...budget });
  return {
    selected: fallback,
    candidates,
    reason: `All candidates blocked by availability/budget; last-resort ${fallback}.`,
    source: 'rules',
    metadata: { ...input, unavailable: [...unavailable], budget: { ...budget } },
  };
}

/** The deterministic rules as a DecisionModel behind the generic seam. */
export class RulesDecisionModel implements DecisionModel {
  recommend(input: RouteInput): ModelId[] {
    return candidatesFor(input);
  }
}

/**
 * Parse a manual `/route <model>` override against a pool of known model
 * identifiers (defaults to the ported capability pool). Unknown models return
 * `null`; the caller decides whether that is an error or a no-op.
 */
export function parseRouteOverride(
  text: string,
  pool: readonly ModelId[] = CAPABILITY_POOL,
): ModelId | null {
  const match = text.match(/\/route\s+([a-z0-9.\-]+)/i);
  if (!match) return null;
  const id = match[1].toLowerCase();
  return pool.includes(id) ? id : null;
}

/**
 * Apply a manual override: it always wins over the rules recommendation
 * unless the model is unavailable, in which case selection falls back to the
 * deterministic rules. The structured `source` marker distinguishes the two
 * outcomes: `override` only when the override model was actually applied,
 * `rules` when selection fell back. Overrides are not budget-gated — a human
 * asking for a specific model is a priced exception, and the decision still
 * records the full snapshot so the cost is auditable.
 */
export function applyOverride(
  input: RouteInput,
  override: ModelId,
  budget: BudgetState = FULL_BUDGET,
  unavailable: ModelId[] = [],
): RouteDecision {
  if (unavailable.includes(override)) {
    return selectModel(input, budget, unavailable);
  }
  return {
    selected: override,
    candidates: candidatesFor(input),
    reason: `manual override -> ${override} (wins over rules recommendation)`,
    source: 'override',
    metadata: { ...input, unavailable: [...unavailable], budget: { ...budget } },
  };
}

/**
 * Provenance supplied alongside a decision when it becomes a record.
 * Deliberately carries no `source`: a caller-supplied label would
 * misattribute the override-fallback path (E4.1 review finding), so the
 * record's `source` derives solely from the decision's structured marker.
 */
export interface RoutingProvenance {
  workOrderId?: string | null;
  taskId?: string | null;
  id?: string;
  createdAt?: string;
}

/**
 * Fold a decision into the durable `RoutingDecisionRecord` shape. Pure: no
 * I/O, no persistence — E4.2's `persistRoutingDecision` stores the record and
 * appends its event; this seam guarantees every record carries the full
 * task/complexity/risk/context/budget snapshot with provenance. `source` is
 * read from the decision itself, never from the caller's label.
 */
export function toRoutingDecisionRecord(
  decision: RouteDecision,
  provenance: RoutingProvenance,
): RoutingDecisionRecord {
  return {
    id: provenance.id ?? `rd_${crypto.randomUUID()}`,
    workOrderId: provenance.workOrderId ?? null,
    taskId: provenance.taskId ?? null,
    source: decision.source,
    ...decision.metadata,
    selected: decision.selected,
    candidates: decision.candidates,
    reason: decision.reason,
    createdAt: provenance.createdAt ?? new Date().toISOString(),
  };
}
