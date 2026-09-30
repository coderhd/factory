import type { WorkOrder } from '../domain/workOrder';
import type {
  BudgetState,
  ContextSize,
  Complexity,
  Risk,
  RouteDecision,
  RouteInput,
  RouteInputDerivation,
  TaskType,
} from './decisionModel';
import { applyOverride, parseRouteOverride, selectModel } from './rules';

/**
 * Assignment-time routing bridge (E9.3, ruling RE7). E4's engine is pure and
 * caller-fed; this module is the runtime's one caller: it derives the
 * `RouteInput` a Task is routed from durable Work Order data, honours a manual
 * override, and returns the decision. It performs no I/O and mutates nothing —
 * the scheduler commits the resulting assignment and persists the provenance.
 *
 * Every derived dimension is either read from a documented Work Order
 * `constraint` (`route-task:`/`route-complexity:`/`route-context:`) or a
 * documented default; the decision metadata records which. Nothing is invented
 * and no provider/model name enters the semantics (ADR 13).
 */

const DEFAULT_TASK: TaskType = 'implementation';
const DEFAULT_COMPLEXITY: Complexity = 'normal';
const DEFAULT_CONTEXT: ContextSize = 'small';

/**
 * Runtime allow-lists mirroring the `TaskType`/`Complexity`/`ContextSize` unions
 * in `decisionModel.ts` (TS unions have no runtime members). A constraint value
 * outside a list is ignored in favour of the default, so a typo can never
 * become a different task shape.
 */
const TASK_VALUES: readonly TaskType[] = [
  'exploration',
  'repository-analysis',
  'planning',
  'architecture',
  'implementation',
  'refactoring',
  'debugging',
  'test-generation',
  'test-debugging',
  'ci-troubleshooting',
  'documentation',
  'code-review',
  'security-review',
  'adversarial-review',
  'second-opinion',
  'large-context-analysis',
];
const COMPLEXITY_VALUES: readonly Complexity[] = ['trivial', 'simple', 'normal', 'complex'];
const CONTEXT_VALUES: readonly ContextSize[] = ['small', 'medium', 'large', 'xlarge'];

/** `constraint:value` forms read from `WorkOrder.constraints`. */
const ROUTE_TASK_RE = /^route-task:([a-z-]+)$/i;
const ROUTE_COMPLEXITY_RE = /^route-complexity:([a-z]+)$/i;
const ROUTE_CONTEXT_RE = /^route-context:([a-z]+)$/i;
/** Manual override: `model:<id>` with `route:<id>` as an alias. */
const OVERRIDE_RE = /^(?:model|route):([a-z0-9.\-]+)$/i;

/** Risk from the Work Order's risk tier (RE7(a)): GREEN→low, YELLOW→medium, RED→high. */
function riskFromTier(tier: WorkOrder['riskTier']): Risk {
  if (tier === 'GREEN') return 'low';
  if (tier === 'RED') return 'high';
  return 'medium';
}

/** The RouteInput plus where each classified field came from (provenance). */
export interface DerivedRouteInput {
  input: RouteInput;
  /** `constraint` when a Work Order constraint supplied it, else `default`. */
  derivedFrom: RouteInputDerivation;
}

function constraintValue(workOrder: WorkOrder, pattern: RegExp): string | null {
  for (const constraint of workOrder.constraints) {
    const match = pattern.exec(constraint.trim());
    if (match) return match[1].toLowerCase();
  }
  return null;
}

/**
 * Derive the routing input from durable Work Order state (RE7(a)): the
 * classified dimensions from `route-*` constraints (defaults
 * `implementation`/`normal`/`small`), risk from the risk tier.
 */
export function deriveRouteInput(workOrder: WorkOrder): DerivedRouteInput {
  const taskValue = constraintValue(workOrder, ROUTE_TASK_RE);
  const complexityValue = constraintValue(workOrder, ROUTE_COMPLEXITY_RE);
  const contextValue = constraintValue(workOrder, ROUTE_CONTEXT_RE);

  const task = TASK_VALUES.includes(taskValue as TaskType) ? (taskValue as TaskType) : DEFAULT_TASK;
  const complexity = COMPLEXITY_VALUES.includes(complexityValue as Complexity)
    ? (complexityValue as Complexity)
    : DEFAULT_COMPLEXITY;
  const context = CONTEXT_VALUES.includes(contextValue as ContextSize)
    ? (contextValue as ContextSize)
    : DEFAULT_CONTEXT;

  return {
    input: { task, complexity, risk: riskFromTier(workOrder.riskTier), context },
    derivedFrom: {
      task: task === taskValue ? 'constraint' : 'default',
      complexity: complexity === complexityValue ? 'constraint' : 'default',
      context: context === contextValue ? 'constraint' : 'default',
    },
  };
}

/**
 * The manual override a Work Order carries, if any (RE7(d)): a `model:<id>` or
 * `route:<id>` constraint parsed through E4's `parseRouteOverride` against the
 * known pool. An unknown id yields `null` so selection falls back to the rules
 * — the Factory never invents a model.
 */
export function workOrderOverride(workOrder: WorkOrder): string | null {
  for (const constraint of workOrder.constraints) {
    const match = OVERRIDE_RE.exec(constraint.trim());
    if (match) {
      const parsed = parseRouteOverride(`/route ${match[1]}`);
      if (parsed) return parsed;
    }
  }
  return null;
}

/** The routing inputs the scheduler supplies for one assignment pass. */
export interface AssignmentRoutingInput {
  workOrder: WorkOrder;
  budget?: BudgetState;
  unavailable?: string[];
}

/**
 * Route one Task's assignment: derive the shape, apply a Work Order override if
 * present, else the deterministic rules. Returns E4's `RouteDecision` (throwing
 * E4's `RoutingBlockedError` when the whole pool is blocked) plus the
 * derivation provenance for the record's metadata.
 */
export function routeAssignment(
  routing: AssignmentRoutingInput,
): { decision: RouteDecision; derivedFrom: DerivedRouteInput['derivedFrom'] } {
  const derived = deriveRouteInput(routing.workOrder);
  const override = workOrderOverride(routing.workOrder);
  const decision = override
    ? applyOverride(derived.input, override, routing.budget, routing.unavailable)
    : selectModel(derived.input, routing.budget, routing.unavailable);
  return { decision, derivedFrom: derived.derivedFrom };
}
