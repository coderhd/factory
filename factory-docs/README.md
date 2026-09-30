# Root / Factory Architecture Artifacts

Final architecture capture for the Root / Factory ecosystem. The existing `2026-09-17-software-factory-design.md` remains the authoritative Software Factory baseline.

## Reading order
1. `architecture/architecture-freeze.md`
2. `architecture/root-architecture.md`
3. `architecture/factory-architecture.md`
4. `architecture/shared-package.md`
5. `architecture/root-protocol.md`
6. `architecture/root-runtime.md`
7. `architecture/factory-lifecycle.md`
8. `architecture/deployment.md`
9. `architecture/worker-execution.md`
10. `architecture/software-factory-implementation.md`
11. `architecture/quant-factory-boundary.md`
12. `decisions/adr-index.md`
13. `implementation/roadmap.md`

## Routing (Factory Server v0.1, E4)

- `architecture/decision-model-routing-core.md` — E4.1: generic DecisionModel seam, capability matrix, budget gates
- `architecture/routing-decision-log.md` — E4.2: decision persistence, `routing.log` format + example line, override/appeal paths, ticket routing fields

## Policy / risk (Factory Server v0.1, E7)

- `architecture/policy-and-risk-model.md` — E7.1: monotonic policy narrowing (Org→Project→WO→Task), capability list + ALLOW/DENY/REQUIRE_HUMAN semantics, risk tiers (Yellow start / earned Green / Red never auto-promotes), recovery + emergency-stop contract, threat model
- `decisions/adr-14-monotonic-policy-and-risk.md` — the ADR record
