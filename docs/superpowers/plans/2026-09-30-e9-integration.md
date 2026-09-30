# Factory Server v0.1 — E9 Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Make the E1–E8 modules a runnable control plane: wire the orchestration seams so `factory start` executes an imported Work Order end-to-end, ending with the roadmap #1 acceptance trace.

**Why:** E1–E8 shipped complete, reviewed modules (312/312 tests on `main` @ 841fc36), but no runtime caller exists for routing, DAG commit (except recovery replan), evidence-bundle building/persistence, telemetry recording, approval answering, or crash reconciliation.

**Tech stack:** TypeScript/Node, `bun test`, SQLite WAL, in-process scheduler, fake Herdr + mocked GitHub transport in tests.

**Spec:** `factory-docs/2026-09-17-software-factory-design.md` + deltas. Tracker: epic `#26`, sub-issues `#27`–`#36`.

## Global Constraints

- Verification IS the product; no completion without durable completion evidence.
- Factory owns state transitions; Workers execute, do not govern.
- Writer ≠ Verifier ≠ Promoter; no self-merge; Red/high-risk never auto-promote.
- Server is the sole mutation authority; clients never mutate state directly.
- Persistence: SQLite WAL + append-only event log + filesystem artifacts.
- MVP GitHub-only external integration; tests hermetic (no live network/Docker/LLM).
- DecisionModel stays generic; no Go model IDs in runtime semantics.
- Boring-by-default; keep integrations small and explicit.

---

### Task 1 (E9.1, #27): Server orchestration spine

**Files:** Modify `src/cli/factory.ts` (`buildServerDeps`), `src/factory/scheduler/scheduler.ts`, `src/factory/config/factoryConfig.ts`, `factory.yaml`; Test `tests/factory/e9-integration.test.ts` (create).
**Interfaces:** `SchedulerDeps { repoPath, artifacts, policy, ... }`; `SchedulerPolicy.canAssign(task, workOrder) -> PolicyVerdict` (E7 `check`).
- [ ] Step 1: failing test — `factory start` on a repo with a READY task assigns it (RUNNING + worktree), using real deps.
- [ ] Step 2: `bun test tests/factory/e9-integration.test.ts` → FAIL.
- [ ] Step 3: wire `repoPath`/`ArtifactStore`/`check`/evidence reader into `buildServerDeps`; extend `factory.yaml`; fail-closed policy default.
- [ ] Step 4: `bun test` → PASS.
- [ ] Step 5: commit.

### Task 2 (E9.2, #28): DAG-commit API/CLI surface

**Files:** Modify `src/factory/api/server.ts`, `src/factory/api/client.ts`, `src/factory/api/contract.ts`, `src/cli/factory.ts`; Test `tests/factory/e9-integration.test.ts`.
**Interfaces:** `POST /work-orders/:id/dag`; `client.commitDag`; CLI `factory wo plan <id>`.
- [ ] Steps: failing test (import→plan→tasks; invalid rejected; v1/v2 preserved) → implement `proposeDAG`/`commitDAG` surface → PASS → commit.

### Task 3 (E9.3, #29): Routing to assignment

**Files:** Modify `src/factory/scheduler/scheduler.ts` (or `workers/manager.ts`); Test `tests/factory/e9-integration.test.ts`.
**Interfaces:** E4 `selectModel(input,budget,unavailable)`, `persistRoutingDecision`; sets `attempt.model`.
- [ ] Steps: failing test (attempt records routed model + `routing_decisions` row; blocked → WAITING_RESOURCE) → implement → PASS → commit.

### Task 4 (E9.4, #30): Verification + Evidence orchestration

**Files:** Modify `src/factory/scheduler/scheduler.ts`, `src/factory/evidence/bundle.ts`; Test `tests/factory/e9-integration.test.ts`.
**Interfaces:** on `SUCCESS→VERIFYING` run E5 engine + semantic verifier → `buildEvidenceBundle` → persist `evidence_bundles` → `EVIDENCE_READY→HUMAN_GATE`; failing AC → REWORK.
- [ ] Steps: failing test (ACs → persisted immutable bundle; failing AC → REWORK) → implement → PASS → commit.

### Task 5 (E9.5, #31): Human loops (approval + answer delivery)

**Files:** Modify `src/factory/api/server.ts`, `src/factory/api/client.ts`, `src/cli/factory.ts`, `src/factory/workers/herdr.ts`, `src/factory/scheduler/scheduler.ts`; Test `tests/factory/e9-integration.test.ts`.
**Interfaces:** approval-answer route → E7 `answerApproval`; `WorkerAdapter.deliverAnswer`.
- [ ] Steps: failing tests (REQUIRE_HUMAN answerable; WAITING_INPUT answer delivered, converges) → implement → PASS → commit.

### Task 6 (E9.6, #32): Policy/recovery runtime hooks + circuit breaker

**Files:** Modify `src/factory/scheduler/scheduler.ts`, `src/factory/recovery/recovery.ts`, `src/cli/factory.ts`; Test `tests/factory/e9-integration.test.ts`.
**Interfaces:** e-stop/pause into tick; `reconcileAfterRestart` on boot; circuit breaker (§9.2/§18.9).
- [ ] Steps: failing tests (e-stop stops live assignment; crash reconciles; circuit opens) → implement → PASS → commit.

### Task 7 (E9.7, #33): Telemetry wiring + Observatory DTO

**Files:** Modify `src/factory/scheduler/scheduler.ts`, `src/factory/api/server.ts`, `src/factory/api/contract.ts`, `src/factory/observatory/observatory.ts`; Test `tests/factory/e9-integration.test.ts`.
**Interfaces:** `recordAttemptTelemetry` on completion; API projections + drill-down.
- [ ] Steps: failing test (six layers live; drill-down navigable) → implement → PASS → commit.

### Task 8 (E9.8, #34): E6 composition + provenance

**Files:** Modify `src/factory/github/adapter.ts` (+ composition in `src/cli/factory.ts`); Test `tests/factory/e9-integration.test.ts`.
**Interfaces:** merge reads persisted bundle by id; head-SHA pin; branch naming reconciled.
- [ ] Steps: failing tests (fabricated bundle cannot merge; head SHA pinned; naming aligned) → implement → PASS → commit.

### Task 9 (E9.9, #35): Infra hygiene

**Files:** Create `tsconfig.json`; Modify `compose.yaml` or add `Dockerfile`, `factory.yaml`; Test `scripts/check-tsc.sh` (create).
- [ ] Steps: add tsconfig + tsc gate; make compose buildable or drop the pinned image; expose provisioning/worktrees; PASS → commit.

### Task 10 (E9.10, #36): End-to-end acceptance test

**Files:** Test `tests/factory/e9-e2e.test.ts` (create).
- [ ] Steps: roadmap #1 trace (import → plan → 2 concurrent → worktrees → QUESTION/WAITING_INPUT → failure+recovery → verify fail+rework → Evidence Bundle → gate → PR/merge → telemetry → restart), hermetic; PASS → commit.

## Self-Review

- Coverage: every E9 sub-issue maps to one task; the epic acceptance (roadmap #1 trace) is Task 10.
- Dependencies: Task 1 is the spine; Tasks 2–6 depend on it; Task 4 precedes 5/7/8; Task 10 depends on all.
- No TBDs; each task yields a test + a commit.
