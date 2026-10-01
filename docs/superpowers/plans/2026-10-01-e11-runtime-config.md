# Factory Server v0.1 — E11 Runtime + config surfaces Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Make the Factory actually execute work (herdr-once worker environment + opencode harnesses) and close the remaining config surfaces (#43 GitHub transport, #41 policy/rules config, #42 semantic-judge provider).

**Why:** `factory start` runs the control plane but no work happens: the E3 Herdr adapter assumes one `herdr` subprocess per worker speaking NDJSON, while the real Herdr is a long-lived multiplexer server hosting agent harnesses in panes. Plus `github:`/`policy:`/judge config surfaces are unbuilt.

**Spec:** `factory-docs/2026-09-17-software-factory-design.md` + deltas; ADR 14 + `factory-docs/architecture/policy-and-risk-model.md`.

## Global Constraints

- Verification IS the product; no completion without durable completion evidence.
- Factory owns state transitions; server is the sole mutation authority.
- Writer ≠ Verifier ≠ Promoter; no self-merge; Red/high-risk never auto-promote.
- Herdr provides the worker environment (started once); agent harnesses are spawned/killed on demand.
- DecisionModel generic; no Go model IDs in runtime semantics.
- MVP GitHub-only; secrets never logged/committed; fail-closed when required config is absent.
- Hermetic tests (fake harness/transport, temp dirs, no network/Docker); `bun test` + `scripts/check-tsc.sh` green.

## Order (ruling RG1)

#43 → #44 → #42 → #41. Rationale: #43 is in flight (independent config); #44 (herdr-once harness) is the real blocker and is now design-confirmed, #42 (judge) builds on it, #41 (policy config) is independent and last.

---

### Task 1 (E11.3, #43): Outbound GitHub transport/token configuration
**Files:** `src/factory/config/factoryConfig.ts`, `factory.yaml`, `compose.yaml`, `src/cli/factory.ts`, `src/factory/github/adapter.ts`; Test `tests/factory/e11-integration.test.ts` (create).
- [ ] Steps: failing test (running deps with a `github:` section → adapter composed, routes work mocked; unconfigured → 404; token not logged; effective-bind URL; PR-base gating) → implement → PASS → commit.

### Task 2 (E11.4, #41): Policy/rules configuration surface
**Files:** `src/factory/config/factoryConfig.ts`, `factory.yaml`, `src/factory/policy/policy.ts` (loader), `src/cli/factory.ts`; Test `tests/factory/e11-integration.test.ts`.
- [ ] Steps: failing test (a `policy:` section loads/validates/overrides the embedded `PolicyDocument`; invalid rejected loudly; absent → embedded default) → implement → PASS → commit.

### Task 3 (E11.1, #44): Herdr-once worker environment + opencode harness lifecycle
**Files:** `src/factory/workers/herdr.ts` (+ manager/`workers/`); Test `tests/factory/e11-integration.test.ts`.
- [ ] Steps: failing test (a real Attempt spawns an opencode harness in a herdr pane, prompts, collects a `WorkerResult`, closes the pane; blocked → WAITING_INPUT; zero at rest) → implement → PASS → commit.

### Task 4 (E11.2, #42): Production semantic-judge provider + CLI wiring
**Files:** `src/factory/verification/production.ts`, `src/cli/factory.ts`, `src/factory/config/factoryConfig.ts`; Test `tests/factory/e11-integration.test.ts`.
- [ ] Steps: failing test (a real `factory start` with a configured judge drives SUCCESS → HUMAN_GATE; fresh context, writer≠verifier) → implement → PASS → commit.

## Self-Review

- Coverage: #41/#42/#43/#44 each map to one task; #44 unblocks real execution; #42 builds on #44.
- Dependencies: #44 before #42; #43/#41 independent.
- Each task yields tests + a commit; hermetic; `bun test` + tsc green.
