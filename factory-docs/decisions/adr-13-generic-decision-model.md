# ADR 13 — The DecisionModel seam stays generic; challengers stay shadow-only

- **Status:** Accepted (2026-09-29)
- **Origin:** `coderhd/factory#16` ([E4.1] DecisionModel architecture; parent epic `#4`, Factory Server v0.1 routing)
- **Design:** [factory-docs/architecture/decision-model-routing-core.md](../architecture/decision-model-routing-core.md)
- **Extends:** [factory-docs/architecture/software-factory-decision-models.md](../architecture/software-factory-decision-models.md) (Decision Model addendum); design spec §8 (hybrid, policy-constrained, evidence-fed routing)

## Context

The Factory must route Work Order tasks to models, skills, and workers (spec §8): deterministic constraints define the allowed candidate set, a decision model may rank or recommend, and the Factory makes the actual assignment. Routing recommendations must be recorded.

During Factory development we built a working router for the **development environment** (`.opencode/plugins/factory-guard/router.ts` + `routing-policy.md`): a capability matrix, per-tier budget gates, an admission loop whose default path is the Span-01 Lite triage service with a margin < 0.2 appeal, and manual `/route` overrides. That router is coupled to one provider's concrete model IDs, and its default path is a specific externally-hosted System 1 service. It works well enough to port **as a pattern**, but the Factory runtime must not inherit either coupling: a runtime that names concrete vendor models in its semantics cannot swap providers, cannot evaluate challengers fairly, and bakes one vendor's quota windows and pricing into core domain behavior.

The addendum already ruled the vocabulary: expose an implementation-neutral `DecisionModel`, not `JevDecisionModel`. This ADR records the runtime decision that follows from it.

## Decision

1. **Runtime routing exposes only generic types** (`src/factory/routing/decisionModel.ts`): `RouteInput` (task/complexity/risk/context), `RouteDecision` (selected + candidates + reason + full snapshot), `DecisionModel` (`recommend(input: RouteInput): ModelId[]`), and `RoutingDecisionRecord` (the durable provenance shape). `ModelId` is an opaque, deployment-defined identifier (`string`) — never a union of provider model IDs. Budget windows are normalized fractions (`BudgetState`, 0..1 per window), not vendor quota units.

2. **The default runtime DecisionModel is the deterministic rules port** (`src/factory/routing/rules.ts`): the dev router's capability matrix, budget gates (escalation m/w ≥ 30%/30% and 5h ≥ 20%; mid ≥ 10%/10%/5%; cheap ungated), ordered fallback ("blocked candidates skipped in order, never jump to max"), and `/route` override semantics, ported with every provider-specific model ID replaced by a generic capability identifier (`explorer`, `planner`, `frontier`, …). A deployment maps its own concrete models onto those identifiers in its own configuration layer.

3. **Manual override wins:** a `/route <model>` override always beats the rules recommendation unless the model is unavailable; overrides are not budget-gated but are recorded with the full snapshot, so their cost stays auditable.

4. **Every decision is recorded with provenance:** rules and override decisions alike fold into `RoutingDecisionRecord` (task/complexity/risk/context, selected, ordered candidates, reason, unavailable list, budget snapshot, source). E4.2 owns the concrete writer (the `routing_decisions` row + event); E8 telemetry consumes the records.

5. **Challengers stay behind the seam, shadow-only.** No `JevDecisionModel` or `SpanDecisionModel` type exists or may be introduced into runtime semantics. Jev/System One and Span-01 remain challenger implementations of the generic `DecisionModel` interface, evaluated experimentally per the addendum, until a pre-registered blind-set bar is beaten (dev precedent §7: head-to-head blind-set task accuracy favoring the challenger, the negation-discrimination case, p95 decision latency ≤ 1 s over ≥ 100 live decisions, and fully-loaded cost ≤ $0.001/decision). Until then the deterministic rules are the only live path in the runtime, exactly as they were the guarded fallback in the dev environment.

## Why Jev/Span stay challengers (not defaults)

- **No transferable evidence yet.** The dev measurements (Span-01 Lite ahead of rules on blind sets, Jev throttling under bulk use) were taken in the dev environment against dev traffic and a dev corpus. None of it is evidence about Factory runtime Work Orders. Promotion requires beating the pre-registered bar on representative Factory data, which does not exist yet.
- **Coupling risk.** Making either the default couples the Factory runtime to an externally-hosted service (availability, throttling, cost, shutdown) — the exact coupling this seam exists to prevent.
- **Neutrality is the point.** The addendum's decision: the implementation must be evaluable and replaceable without changing Factory semantics. That only holds if no challenger's name is in a type.

## Dev-only pattern, ported as pattern

The dev router's **Span-default admission** (Span-01 Lite triage; margin ≥ 0.2 records and pins; margin < 0.2 appeals to a stronger model; Span unavailable → rules fallback) and its appeal/`/route` overrides are **development-environment behavior**. The runtime ports the *pattern* — deterministic constraints → candidate set → decision → recorded provenance; overrides win; uncertainty is adjudicated outside the live path — but never the *identifiers*: no provider model IDs, no vendor quota windows, and no admission-loop service appear in runtime semantics. They stay in the dev plugin's mapping layer (reference-only; `scripts/check-router.sh` keeps it honest), and the generic capability identifiers in `rules.ts` are the only trace of the dev matrix in the runtime.

## Consequences

- **Positive:** the runtime is provider-agnostic and swappable; challengers can be benchmarked head-to-head behind one interface; every routing decision is auditable end-to-end; the port keeps the tuned capability ordering and gate thresholds the dev environment already validated.
- **Negative:** indirection — deployments must maintain a capability-identifier → concrete-model mapping; the runtime loses the dev environment's model-specific tuning (absorption roles are re-expressed as generic identifiers); a blind-set promotion protocol for the runtime still has to be defined before any challenger can graduate.
- **Later:** E4.2 persists `RoutingDecisionRecord`s (state row + event + routing log) and validates ticket provenance fields; E8 consumes them for telemetry; a future ADR handles challenger promotion if the bar is ever beaten on Factory data.

## Alternatives considered

- **Typed union of provider model IDs** (as the dev router does): rejected — couples runtime semantics to one provider, blocks evaluation and replacement, violates the addendum's vocabulary ruling.
- **Promote the dev admission loop into the runtime now:** rejected — dev evidence does not transfer to Factory traffic; the promotion bar exists precisely to prevent this.
- **No record of routing decisions:** rejected — spec §8 requires recommendations to be recorded; provenance is also the raw material for later evidence-fed routing improvements.
