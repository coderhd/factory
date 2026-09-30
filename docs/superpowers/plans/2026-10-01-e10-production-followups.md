# Factory Server v0.1 — E10 Production Follow-ups Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Close the four production-composition follow-ups that keep the E9-wired Factory from being fully live: production verifier composition (#39), worker-failure re-dispatch producer (#38), circuit live producer + GitHub route + per-task PR branch leaf (#37), and control-plane API authentication (#40).

**Why:** E9 (merged, `main` 07f7913, 393/393) made the modules a runnable control plane, but four seams are dormant: a real `factory start` reaches SUCCESS then parks (no production verifier), the circuit breaker has no live producer, a worker failure dead-ends (no re-dispatch), and the API has no authentication. A policy/rules config surface (#41) is a related gap.

**Spec:** `factory-docs/2026-09-17-software-factory-design.md` + deltas; ADR 14 + `factory-docs/architecture/policy-and-risk-model.md`.

## Global Constraints

- Verification IS the product; no completion without durable completion evidence.
- Factory owns state transitions; server is the sole mutation authority.
- Writer ≠ Verifier ≠ Promoter; no self-merge; Red/high-risk never auto-promote.
- DecisionModel generic; no Go model IDs in runtime semantics.
- MVP GitHub-only; tests hermetic (fake Herdr, mocked GitHub transport, no live network/Docker/LLM).
- Recovery bounded, evidence-preserving; never claim success without evidence.
- `bun test` + `scripts/check-tsc.sh` must stay green.

## Order (ruling RF1)

#39 → #38 → #37 → #40. Rationale: #39 makes the golden path verify end-to-end and introduces the config surface; #38 establishes the live failure producer that #37's circuit consumes; #40 is independent.

---

### Task 1 (E10.1, #39): Production verifier composition

**Files:** Modify `src/cli/factory.ts` (`buildServerDeps`/`cmdServe`), `src/factory/config/factoryConfig.ts`, `factory.yaml`; likely a small composition module (e.g. `src/factory/verification/production.ts`); Test `tests/factory/e10-*.test.ts` (create).
**Interfaces:** E5 `createE5Verifier`, check-provider registry, semantic judge config.
- [ ] Step 1: failing test — a real `buildServerDeps` (production path, no test injection) drives a SUCCESS task through verification to HUMAN_GATE.
- [ ] Step 2: `bun test` → FAIL.
- [ ] Step 3: compose the verifier from validated config (judge identity + providers); fail-closed when unconfigured.
- [ ] Step 4: `bun test` + `scripts/check-tsc.sh` → PASS.
- [ ] Step 5: commit.

### Task 2 (E10.2, #38): Worker-failure re-dispatch producer

**Files:** Modify `src/factory/scheduler/scheduler.ts`, `src/factory/recovery/recovery.ts`; Test `tests/factory/e10-*.test.ts`.
**Interfaces:** E7 `recover(failure)`, failure classes, budgets.
- [ ] Steps: failing test (a live worker failure → new Attempt from a clean baseline, old diff kept as evidence, Task not stuck RUNNING, no duplicate side effects, bounded) → implement → PASS → commit.

### Task 3 (E10.3, #37): Circuit live producer + GitHub route + PR branch leaf

**Files:** Modify `src/factory/recovery/recovery.ts`/`circuitBreaker.ts`, `src/cli/factory.ts`, `src/factory/api/server.ts`/`client.ts`/`contract.ts`, `src/factory/github/adapter.ts`; Test `tests/factory/e10-*.test.ts`.
**Interfaces:** circuit `beforeDependencyRequest`/`recordDependencyFailure`/`recordDependencySuccess`; `buildGitHubAdapter`; `taskWorktreeBranch`.
- [ ] Steps: failing tests (a live dependency failure opens/sheds and a success closes; the adapter is constructed in a running process and its gates run against live policy; the E6 PR branch aligns with the E3 worktree leaf or the aggregation model is documented+tested) → implement → PASS → commit.

### Task 4 (E10.4, #40): Control-plane API authentication

**Files:** Modify `src/factory/api/server.ts`, `src/factory/config/factoryConfig.ts`, `factory.yaml`, `compose.yaml`, docs; Test `tests/factory/e10-*.test.ts`.
**Interfaces:** a token/auth boundary for mutating routes; authenticated actor on human actions.
- [ ] Steps: failing tests (unauthenticated mutating requests rejected; the actor on human actions is authenticated, not self-asserted) → implement → PASS → commit.

## Self-Review

- Coverage: #37–#40 each map to one task; #41 (policy config) is a tracked sibling of Task 1.
- Dependencies: Task 1 first (config + golden path); Task 2 precedes Task 3's circuit producer; Task 4 independent.
- Each task yields tests + a commit; hermetic; `bun test` + tsc stay green.
