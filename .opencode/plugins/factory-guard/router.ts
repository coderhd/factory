/**
 * Factory dev router — Span-default, capability-aware, budget-aware.
 *
 * Scope: OpenCode DEVELOPMENT environment only (building the Software Factory).
 * NOT Factory runtime routing / Work Order execution. See factory-docs/ for product.
 *
 * Pipeline (admission, once per task — never per turn):
 *   prompt -> Span-01 Lite triage (free, outside the loop)
 *     -> margin >= 0.2: record Span route, pin session
 *     -> margin < 0.2: appeal to opencode-go/glm-5.3-flash, pin session
 *     -> Span unavailable: rules fallback (offline, zero-dep), pin session
 *   pinned session -> record only, no re-routing, no model switches.
 *   Manual /route override always wins. Capability matrix + Go budgets
 *   map the final (task, complexity, risk, context) to the model.
 *
 * Constraints preserved:
 * - DecisionModel stays generic (never JevDecisionModel).
 * - Jev stays shadow-only (jevShadowSuggest logs, never switches).
 * - Writer and verifier stay separate (enforced in index.ts / commands).
 * - No cheap->mid->frontier ladder as primary logic; selection is
 *   capability-first, then budget-filtered.
 */

export type TaskType =
  | "exploration"
  | "repository-analysis"
  | "planning"
  | "architecture"
  | "implementation"
  | "refactoring"
  | "debugging"
  | "test-generation"
  | "test-debugging"
  | "ci-troubleshooting"
  | "documentation"
  | "code-review"
  | "security-review"
  | "adversarial-review"
  | "second-opinion"
  | "large-context-analysis";

export type Complexity = "trivial" | "simple" | "normal" | "complex";
export type Risk = "low" | "medium" | "high";
export type ContextSize = "small" | "medium" | "large" | "xlarge";

export type ModelId =
  | "glm-5.3-flash"
  | "glm-5.3"
  | "deepseek-v4.1-flash"
  | "qwen3.8-flash"
  | "qwen3.8-max"
  | "mimo-v2.6-flash"
  | "mimo-v2.6-pro"
  | "grok-4.7"
  | "kimi-k3"
  | "gpt-6-luna";

export interface BudgetState {
  /** Fraction 0..1 of monthly dollar limit remaining. */
  monthlyRemaining: number;
  /** Fraction 0..1 of weekly (50% of monthly) remaining. */
  weeklyRemaining: number;
  /** Fraction 0..1 of 5-hour (20% of monthly) remaining. */
  fiveHourRemaining: number;
}

export interface RouteInput {
  task: TaskType;
  complexity: Complexity;
  risk: Risk;
  context: ContextSize;
}

export interface RouteDecision {
  selected: ModelId;
  candidates: ModelId[];
  reason: string;
  metadata: {
    task: TaskType;
    complexity: Complexity;
    risk: Risk;
    context: ContextSize;
    unavailable: ModelId[];
    budget: BudgetState;
  };
}

/** Go model IDs as used in opencode.jsonc (`opencode-go/<id>`). */
export const GO_PROVIDER = "opencode-go";

export function toGoModel(id: ModelId): string {
  return `${GO_PROVIDER}/${id}`;
}

type CostTier = "cheap" | "mid" | "escalation";

export const MODEL_TIER: Record<ModelId, CostTier> = {
  "mimo-v2.6-flash": "cheap",
  "glm-5.3-flash": "cheap",
  "qwen3.8-flash": "cheap",
  "gpt-6-luna": "cheap",
  "deepseek-v4.1-flash": "mid",
  "mimo-v2.6-pro": "mid",
  "glm-5.3": "mid",
  "qwen3.8-max": "escalation",
  "grok-4.7": "escalation",
  "kimi-k3": "escalation",
};

const ESCALATION: ReadonlySet<ModelId> = new Set(["qwen3.8-max", "grok-4.7", "kimi-k3"]);
const MID: ReadonlySet<ModelId> = new Set(["deepseek-v4.1-flash", "mimo-v2.6-pro", "glm-5.3"]);

/**
 * Capability matrix: ordered candidate lists per task shape.
 * Order matters — fallback walks this list in order, never jumping
 * straight to the most expensive model.
 */
export function candidatesFor(input: RouteInput): ModelId[] {
  const { task, complexity, risk } = input;

  if (task === "exploration" || task === "repository-analysis" || task === "large-context-analysis") {
    if (input.context === "xlarge" || input.context === "large") {
      return ["deepseek-v4.1-flash", "mimo-v2.6-flash", "glm-5.3-flash", "qwen3.8-flash"];
    }
    return ["mimo-v2.6-flash", "glm-5.3-flash", "qwen3.8-flash"];
  }
  if (task === "implementation" || task === "refactoring") {
    if (complexity === "simple" || complexity === "trivial") return ["glm-5.3-flash", "qwen3.8-flash", "mimo-v2.6-flash"];
    if (complexity === "complex") return ["deepseek-v4.1-flash", "mimo-v2.6-pro", "glm-5.3", "qwen3.8-flash"];
    return ["qwen3.8-flash", "glm-5.3-flash", "deepseek-v4.1-flash"];
  }
  if (task === "debugging" || task === "test-debugging" || task === "ci-troubleshooting") {
    return ["deepseek-v4.1-flash", "mimo-v2.6-pro", "glm-5.3"];
  }
  if (task === "test-generation" || task === "documentation") {
    return ["qwen3.8-flash", "glm-5.3-flash", "mimo-v2.6-flash"];
  }
  if (task === "planning") return ["glm-5.3", "mimo-v2.6-pro", "qwen3.8-max"];
  if (task === "architecture") {
    if (risk === "high") return ["glm-5.3", "qwen3.8-max", "mimo-v2.6-pro"];
    return ["glm-5.3", "qwen3.8-max", "mimo-v2.6-pro"];
  }
  if (task === "code-review") {
    if (risk === "high") return ["qwen3.8-max", "grok-4.7", "mimo-v2.6-pro"];
    return ["mimo-v2.6-pro", "glm-5.3", "deepseek-v4.1-flash"];
  }
  if (task === "security-review" || task === "adversarial-review") {
    return ["qwen3.8-max", "grok-4.7", "kimi-k3"];
  }
  if (task === "second-opinion") return ["gpt-6-luna", "mimo-v2.6-pro", "kimi-k3"];
  return ["glm-5.3-flash", "qwen3.8-flash", "mimo-v2.6-flash"];
}

/** Budget gate: escalation models need healthy budgets on all windows. */
export function budgetAllows(model: ModelId, budget: BudgetState): boolean {
  if (ESCALATION.has(model)) {
    return budget.monthlyRemaining >= 0.3 && budget.weeklyRemaining >= 0.3 && budget.fiveHourRemaining >= 0.2;
  }
  if (MID.has(model)) {
    return budget.monthlyRemaining >= 0.1 && budget.weeklyRemaining >= 0.1 && budget.fiveHourRemaining >= 0.05;
  }
  return true;
}

export function selectModel(
  input: RouteInput,
  budget: BudgetState = { monthlyRemaining: 1, weeklyRemaining: 1, fiveHourRemaining: 1 },
  unavailable: ModelId[] = [],
): RouteDecision {
  const candidates = candidatesFor(input);
  const blocked = new Set(unavailable);
  for (const m of candidates) {
    if (blocked.has(m)) continue;
    if (!budgetAllows(m, budget)) continue;
    return {
      selected: m,
      candidates,
      reason: explainSelection(input, m, budget),
      metadata: { ...input, unavailable: [...unavailable], budget: { ...budget } },
    };
  }
  // Last resort: cheapest compatible model that is not blocked.
  const fallback: ModelId = blocked.has("mimo-v2.6-flash") ? "glm-5.3-flash" : "mimo-v2.6-flash";
  return {
    selected: fallback,
    candidates,
    reason: `All candidates blocked by availability/budget; last-resort ${fallback}.`,
    metadata: { ...input, unavailable: [...unavailable], budget: { ...budget } },
  };
}

function explainSelection(input: RouteInput, model: ModelId, budget: BudgetState): string {
  const tier = MODEL_TIER[model];
  return (
    `task=${input.task}, complexity=${input.complexity}, risk=${input.risk}, ` +
    `context=${input.context} -> ${model} (${tier} tier; ` +
    `budget m=${Math.round(budget.monthlyRemaining * 100)}%/w=${Math.round(budget.weeklyRemaining * 100)}%` +
    `/5h=${Math.round(budget.fiveHourRemaining * 100)}%).`
  );
}

/** Manual model override: `/route <model>` — always wins unless unavailable. */
export function parseRouteOverride(text: string): ModelId | null {
  const m = text.match(/\/route\s+([a-z0-9.\-]+)/i);
  if (!m) return null;
  const id = m[1].toLowerCase() as ModelId;
  const aliases: Record<string, ModelId> = {
    "glm-5.3": "glm-5.3",
    "glm-5.3-flash": "glm-5.3-flash",
    "qwen3.8-max": "qwen3.8-max",
    "qwen3.8-flash": "qwen3.8-flash",
    "qwen3.8-flash-next": "qwen3.8-flash",
    "deepseek-v4.1-flash": "deepseek-v4.1-flash",
    "mimo-v2.6-flash": "mimo-v2.6-flash",
    "mimo-v2.6-pro": "mimo-v2.6-pro",
    "grok-4.7": "grok-4.7",
    "kimi-k3": "kimi-k3",
    "gpt-6-luna": "gpt-6-luna",
    grok: "grok-4.7",
    kimi: "kimi-k3",
    luna: "gpt-6-luna",
  };
  return aliases[id] ?? null;
}

/** Lightweight task hints: @plan @review @debug @architecture @cheap @deep */
export function parseTaskHint(text: string): Partial<RouteInput> | null {
  if (/@plan\b/i.test(text)) return { task: "planning", complexity: "complex" };
  if (/@architecture\b/i.test(text)) return { task: "architecture", complexity: "complex" };
  if (/@review\b/i.test(text)) return { task: "code-review", complexity: "normal" };
  if (/@debug\b/i.test(text)) return { task: "debugging", complexity: "complex" };
  if (/@cheap\b/i.test(text)) return { task: "exploration", complexity: "trivial" };
  if (/@deep\b/i.test(text)) return { complexity: "complex", risk: "high" };
  return null;
}

/** Deterministic keyword classifier: task type + complexity + risk + context. */
export function classifyTask(text: string): RouteInput {
  const t = text.toLowerCase();
  const hint = parseTaskHint(text);

  let task: TaskType = "implementation";
  if (/(adversarial|try to break|red team|red-team|(?<!auth )\bbypass\w*|\bfuzz(ing|ed|er)?\b|break[- ]ins?\b)/.test(t)) task = "adversarial-review";
  else if (/(second opinion|sanity[- ]check.*(other|independent)|independent.*opinion|independent (review|assessment|take))/.test(t)) task = "second-opinion";
  else if (/(code review|\blgtm\b|review (this|the|our|my)( \w+){0,2} (\bpr\b|\bdiffs?\b|changes?|code|module|function|endpoint|flow|logic|script|file|patch|commit|branch)|pr review)/.test(t)) task = "code-review";
  else if (/(architectural|architecture (decision|design|doc|review|change|proposal)|architecting|architected|re-architect|\barchitect\b|review.{0,30}\barchitectures?\b|(propos|design|draft|defin|creat).{0,40}\barchitectures?\b|design (doc|decision|system)|adr)/.test(t)) task = "architecture";
  else if (/((test|spec).*fail|fail.*(test|spec|suite)|failing (test|spec|suite))/.test(t)) task = "test-debugging";
  else if (/(\bplan(ned)?\b|\bspecs?\b|roadmap|decompos|work breakdown|break ?down)/.test(t)) task = "planning";
  else if (/(ci\/cd|pipeline.*fail|github action|workflow.*fail|\bred\b (build|suite|pipeline|tests?|ci|jobs?|runs?)|(is|are|seems?|looks?|turned|went|gone) red\b|(is|are|seems?|looks?|got) (stuck|hung|frozen))/.test(t)) task = "ci-troubleshooting";
  else if (/(debug|bug|crash|broken|\bbroke\b|\bbreaks\b|fails|failed|failure|defect|investigat(e|ion)?|stack trace|traceback|\btraces?\b|\btraced\b|failing test|test.*fail|ci fail|flaky|(repro\b|reproduc(e|es|ed|ing|ible)))/.test(t)) {
    task = /(test|spec).*fail|fail.*test/.test(t) ? "test-debugging" : "debugging";
  } else if (/(write.{0,20}tests?|generat(e|es|ing|ed).{0,20}tests?|add.*test coverage|unit tests?)/.test(t)) task = "test-generation";
  else if (/(refactor|clean[ -]?ups?|migrate|rename)/.test(t)) task = "refactoring";
  else if (/(document|\bdocs\b|readme|changelog|docstring|jsdoc)/.test(t)) task = "documentation";
  else if (/(explore|search|explain|explan\w*|summar|\blist\b|\breads?\b|\breading\b|\bfind\b|where (is|are|was|were|do|does|did)|what (does|is|are|was|were)|why (does|is|do|did)|how (do|does|is|was)|show (me|the|us)|walk me through)/.test(t)) task = "exploration";
  else if (/(security|vuln|cve|auth bypass|(?<!dependency )injection|xss|harden\w*|threat models?|\bpen[- ]tests?\b)/.test(t)) task = "security-review";
  else if (/(large|whole repo|entire|200k|500k|long context)/.test(t)) task = "large-context-analysis";

  let complexity: Complexity = "normal";
  if (/(trivial|typo|one-line|one line|rename only)/.test(t)) complexity = "trivial";
  else if (/(simple|small|quick|minor|straightforward)/.test(t)) complexity = "simple";
  else if (/(complex|\bhard\b|difficult|ambiguous|architectural|distributed|\braces?\b|deadlock|nondetermin)/.test(t)) complexity = "complex";

  let risk: Risk = "low";
  if (/(\bprod\b|\bproduction\b|\bsecurity\b|\bauth(entication)?\b|\bpayments?\b|\bbilling\b|\bmigrat\w*|\bpii\b|\bsecrets?\b|\bdeploy\w*)/.test(t)) risk = "high";
  else if (/(\bapis?\b|contract|schema|database|data model|breaking)/.test(t)) risk = "medium";

  let context: ContextSize = "small";
  if (/(xlarge|whole repo|entire codebase|>200k|500k)/.test(t)) context = "xlarge";
  else if (/(large|many files|\blong\b|full (\w+ )?file|directory)/.test(t)) context = "large";
  else if (/(medium|several files|multi-file)/.test(t)) context = "medium";

  return {
    task: hint?.task ?? task,
    complexity: hint?.complexity ?? complexity,
    risk: hint?.risk ?? risk,
    context: hint?.context ?? context,
  };
}

// --- DecisionModel seam (generic; Jev stays behind this interface, shadow-only) ---

export interface DecisionModel {
  recommend(input: RouteInput): ModelId[];
}

export class RulesDecisionModel implements DecisionModel {
  recommend(input: RouteInput): ModelId[] {
    return candidatesFor(input);
  }
}

// --- Span-default admission (locked 2026-09-30) ---

export const MARGIN_THRESHOLD = 0.2;
export const APPEAL_MODEL: ModelId = "glm-5.3-flash";
export const SPAN_TIMEOUT_MS = 3000;

export interface SpanVerdict {
  task: TaskType;
  complexity: Complexity;
  risk: Risk;
  confidence: number;
  margin: number;
}

export type RouteAction =
  | { kind: "record"; source: "pinned" | "manual" }
  | { kind: "record"; source: "span"; decision: RouteDecision }
  | { kind: "record"; source: "rules-fallback"; decision: RouteDecision }
  | { kind: "appeal"; source: "span"; decision: RouteDecision; brief: object };

/**
 * Pure admission decision. Called once per task (unpinned session) or never
 * (pinned sessions record only). Never performs I/O; never switches models.
 */
export function decideAction(opts: {
  sessionPinned: boolean;
  spanOk: boolean;
  span?: SpanVerdict;
  rules: RouteInput;
  budget?: BudgetState;
  unavailable?: ModelId[];
}): RouteAction {
  if (opts.sessionPinned) return { kind: "record", source: "pinned" };
  if (!opts.spanOk || !opts.span) {
    const decision = selectModel(opts.rules, opts.budget, opts.unavailable);
    return { kind: "record", source: "rules-fallback", decision };
  }
  const input: RouteInput = {
    task: opts.span.task,
    complexity: opts.span.complexity,
    risk: opts.span.risk,
    context: opts.rules.context,
  };
  const decision = selectModel(input, opts.budget, opts.unavailable);
  if (opts.span.margin < MARGIN_THRESHOLD) {
    return {
      kind: "appeal",
      source: "span",
      decision,
      brief: {
        span: opts.span,
        rulesTask: opts.rules.task,
        disagreement: opts.span.task !== opts.rules.task,
      },
    };
  }
  return { kind: "record", source: "span", decision };
}

/**
 * Jev shadow: compute what Jev WOULD suggest, log it, never switch.
 * Promotion to active requires benchmark evidence; until then callers
 * must ignore the return value for routing and use RulesDecisionModel.
 */
export function jevShadowSuggest(input: RouteInput): { suggestion: ModelId; note: string } {
  const [suggestion] = new RulesDecisionModel().recommend(input);
  return {
    suggestion,
    note: `jev-shadow-only task=${input.task} suggestion=${suggestion} (not applied; rules baseline active)`,
  };
}
