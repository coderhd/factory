# Decision Model — Routing Core (E4.1)

- **Status:** Accepted design for Factory Server v0.1 routing (epic `coderhd/factory#4`, sub-issue `#16`)
- **Decision record:** [ADR 13 — The DecisionModel seam stays generic](../decisions/adr-13-generic-decision-model.md)
- **Authority:** design spec §8 (hybrid, policy-constrained, evidence-fed routing); [software-factory-decision-models.md](software-factory-decision-models.md) (Decision Model addendum)
- **Dev precedent (reference only):** `.opencode/plugins/factory-guard/router.ts`, `.opencode/plugins/factory-guard/routing-policy.md`, [docs/superpowers/specs/2026-09-28-s1s2-routing-design.md](../../docs/superpowers/specs/2026-09-28-s1s2-routing-design.md)

## 1. Scope

The deterministic rules port and its budget gates for **Factory runtime routing** — the E4.1 core. It defines how a `RouteInput` (task shape) becomes a recorded `RouteDecision` (model assignment recommendation) using only generic capability identifiers. E4.2 (#17) added the concrete persistence (state row + event + routing log) and ticket provenance validation — see [routing-decision-log.md](routing-decision-log.md); E8 consumes the records for telemetry. Nothing here names a concrete provider or model.

## 2. Topology (spec §8, addendum)

```text
Task shape (RouteInput)
  ↓
Deterministic capability constraints (candidatesFor)   → candidate set
  ↓
Budget + availability gates (budgetAllows, unavailable) → allowed candidate
  ↓
DecisionModel.recommend / selectModel                  → recommendation
  ↓
Factory assignment (spec §8: the Factory assigns)      → Worker
  ↓
RoutingDecisionRecord                                  → recorded provenance
```

Authority invariants carry over unchanged: a Decision Model can **recommend, rank, classify, score** — it never performs I/O, never mutates state, never assigns. Policy determines what is permitted; the Factory commits assignments and durable state.

## 3. Generic vocabulary (`src/factory/routing/decisionModel.ts`)

| Type | Shape | Notes |
|---|---|---|
| `RouteInput` | `{ task, complexity, risk, context }` | 16 task types, 4 complexity / 3 risk / 4 context values — capability vocabulary, not provider vocabulary |
| `ModelId` | opaque `string` | Deployment-defined; provider catalogs live in a deployment mapping layer, never in runtime semantics (ADR 13) |
| `BudgetState` | `{ monthlyRemaining, weeklyRemaining, fiveHourRemaining }` | Normalized fractions 0..1 per quota window — any provider's quotas map onto these |
| `RouteDecision` | `{ selected, candidates, reason, source, metadata }` | `source` is the structured provenance marker (`'rules' \| 'override'`); `metadata` carries the full task/complexity/risk/context/unavailable/budget snapshot |
| `DecisionModel` | `recommend(input) → ModelId[]` | Implementation-neutral seam: rules, statistical model, System 1, System 2, ensemble, or human process |
| `RoutingDecisionRecord` | see §7 | Durable provenance shape for the `routing_decisions` table |

## 4. Capability matrix (`candidatesFor`)

Ordered candidate lists per task shape, ported from the dev router with provider model IDs replaced by generic capability identifiers. **Order matters:** the gates walk the list top-down; fallback never jumps straight to the most expensive model.

| Task shape | Ordered candidates |
|---|---|
| exploration / repository-analysis / large-context-analysis (small, medium context) | explorer, generalist, implementer |
| exploration / repository-analysis / large-context-analysis (large, xlarge context) | loop-solver, explorer, generalist, implementer |
| implementation / refactoring (trivial, simple) | generalist, implementer, explorer |
| implementation / refactoring (normal) | implementer, generalist, loop-solver |
| implementation / refactoring (complex) | loop-solver, reviewer, planner, implementer |
| debugging / test-debugging / ci-troubleshooting | loop-solver, reviewer, planner |
| test-generation / documentation | implementer, generalist, explorer |
| planning | planner, reviewer, frontier |
| architecture | planner, frontier, reviewer |
| code-review (low, medium risk) | reviewer, planner, loop-solver |
| code-review (high risk) | frontier, adversarial, reviewer |
| security-review / adversarial-review | frontier, adversarial, diversifier |
| second-opinion | independent-opinion, reviewer, diversifier |

### Capability identifiers and tiers

| Identifier | Tier | Role (what a deployment maps onto it) |
|---|---|---|
| `generalist` | cheap | high-volume general work |
| `explorer` | cheap | exploration / utility reads |
| `implementer` | cheap | implementation / testing at volume |
| `independent-opinion` | cheap | cheap independent second opinion |
| `loop-solver` | mid | difficult debugging loops |
| `reviewer` | mid | review / planning strength at mid cost |
| `planner` | mid | planning / architecture lead |
| `frontier` | escalation | top capability, escalation-only |
| `adversarial` | escalation | frontier review / adversarial work |
| `diversifier` | escalation | reasoning diversity |

`CAPABILITY_POOL` lists all ten in fallback order (cheapest first, escalation last). `tierOf` treats an unknown identifier as cheap — the gates below then never block it, mirroring the dev router where only mid and escalation tiers are gated.

## 5. Budget gates (`budgetAllows`)

A model's tier must have a healthy budget on **every** window (fractions remaining):

| Tier | monthly | weekly | 5-hour |
|---|---|---|---|
| escalation | ≥ 30% | ≥ 30% | ≥ 20% |
| mid | ≥ 10% | ≥ 10% | ≥ 5% |
| cheap | ungated | ungated | ungated |

`BUDGET_GATES` holds the thresholds as data; `FULL_BUDGET` (all 1.0) is the default when a caller has no budget signal.

## 6. Selection algorithm (`selectModel`)

```text
candidates = candidatesFor(input)
for model in candidates (in order):
    skip if model ∈ unavailable
    skip if not budgetAllows(model, budget)
    return decision(model)                      # capability-first, budget-filtered
last resort = first model in CAPABILITY_POOL that is neither unavailable
             nor budget-blocked                 # cheapest unblocked, never max
if the whole pool is blocked: CAPABILITY_POOL[0]  # decision still records one
```

Every returned decision carries `metadata` = the full `RouteInput` + `unavailable` + `budget` snapshot, and a human-readable `reason` (`task=…, complexity=…, risk=…, context=… -> <model> (<tier> tier; budget m=…%/w=…%/5h=…%).`).

### Manual override (`/route`)

- `parseRouteOverride(text, pool?)` parses `/route <model>` against the known pool (defaults to `CAPABILITY_POOL`; a deployment passes its own catalog). Unknown models return `null`.
- `applyOverride(input, override, budget?, unavailable?)`: the override **always wins** unless the model is unavailable, in which case selection falls back to the deterministic rules. The structured `source` marker records which happened (`override` only when applied). Overrides are not budget-gated — a human asking for a specific model is a priced exception — but the decision still records the full snapshot so the cost is auditable.

## 7. Decision provenance (`toRoutingDecisionRecord`)

Every decision — rules or override — folds into a `RoutingDecisionRecord`:

```text
id, workOrderId, taskId, source ('rules' | 'override'),
task, complexity, risk, context,          # the RouteInput it was made from
selected, candidates, reason,            # the recommendation and its list
unavailable, budget,                     # the gates it passed
createdAt
```

The builder is pure (no I/O). **E4.2 (#17) delivered the concrete writer**: `persistRoutingDecision` stores the record in the E1 `routing_decisions` table, appends its `routing.decision_recorded` event atomically, and `formatRoutingLogLine` renders the `routing.log` line — format, example line, override/appeal paths, and ticket fields are documented in [routing-decision-log.md](routing-decision-log.md). The record's `source` comes from the decision's structured marker, never a caller label. E4.1's tests only stub-persist through E1's existing `StateStore` seam to prove the shape round-trips.

## 8. Testing

`tests/factory/e4-routing.test.ts` covers: the provider-leak guard (no provider model IDs in any `src/factory/routing/**` runtime source), the implementation-neutral seam, the full ported matrix, determinism, gate boundaries (inclusive ≥ at 30/30/20 and 10/10/5), ordered skipping under budget/availability blocks, the cheapest-unblocked last resort (never max), override parse/win/fallback semantics, and the provenance record shape + E1 round-trip. E4.2 adds the writer/atomicity, log-format, source-marker, and ticket-fields describes. `scripts/check-router.sh` stays green — the dev router is reference-only and unchanged.

## 9. Non-goals (E4.1)

- No challenger promotion, no shadow harness, no admission loop in the runtime (dev-only pattern; ADR 13).
- No concrete persistence writer, routing log, or ticket validation (E4.2 / #17).
- No telemetry consumption of records (E8).
- No per-task classification from raw text — `RouteInput` is supplied by the caller; ticket-time classification is E4.2's ticket-provenance concern.
