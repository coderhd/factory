# Factory Server v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Software Factory Server v0.1 as a verification-first control plane that turns a GitHub-backed Work Order into a verified Change Set + Evidence Bundle with human gates.

**Architecture:** Single deployable Factory Server (SQLite WAL + append-only event log + filesystem artifacts); Factory owns state transitions, Workers (Herdr first) execute in Git worktrees, generic DecisionModel seam for routing, 4-tier verification separate from execution. Boring-by-default per `factory-docs/architecture-skeptical-review.md`.

**Tech Stack:** TypeScript/Node (factory-guard plugin precedent, bun test), Python harnesses (span-trial, router-eval), SQLite, Docker Compose, GitHub Issues/Projects, Git worktrees.

**Spec:** `factory-docs/2026-09-17-software-factory-design.md` (authoritative baseline) + deltas: `factory-docs/architecture/architecture-freeze.md`, `factory-docs/architecture/software-factory-decision-models.md`, `factory-docs/architecture-skeptical-review.md`, `factory-docs/implementation/roadmap.md`, `docs/superpowers/specs/2026-09-28-s1s2-routing-design.md`, `.opencode/plugins/factory-guard/router.ts`, `.opencode/plugins/factory-guard/routing-policy.md`

## Global Constraints

- Verification IS the product; no completion without durable completion evidence.
- Work Order is the central primitive; Factory owns state transitions; Workers execute, do not govern.
- Planner proposes DAG; Factory validates/commits; DAG versions preserved, never silently overwritten.
- Writer ≠ Verifier ≠ Promoter; no self-merge; developer model is not sole semantic verifier; verifier uses fresh context, preferably different family; verifier never modifies implementation.
- Git/GitHub is source of truth for code; Factory is source of truth for execution state; Knowledge and state are separate planes.
- Git worktree isolation mandatory for implementation Tasks; external side effects policy-controlled; retrieval distinct from side effects.
- MVP GitHub-only external integration; deferred: Slack/Buzz/Teams, K8s, Postgres, S3, Redis, multi-tenancy, billing, multiple Git providers/runtimes, universal workspace, Root Runtime.
- Persistence: SQLite WAL + append-only event log + filesystem artifacts; interfaces StateStore/KnowledgeStore/ArtifactStore/MessageBus(in-process)/Worker/RetrievalGateway/ModelRouter/SkillRouter/WorkerRouter/GitHub adapter must exist; MVP impls stay small.
- DecisionModel stays generic (no JevDecisionModel/SpanDecisionModel); Jev/Span challengers shadow-only until blind-set bar beaten; dev-router pattern (Span-default + margin<0.2 appeal) is dev-env only, must stay portable, never leak Go model IDs into runtime semantics.
- Risk: everything starts Yellow; Green earned; Red never auto-promotes; high-risk never auto-promotes; no silent model downgrade violating Work Order requirements.
- Recovery bounded, evidence-preserving; default clean-worktree recovery; Factory crash must reconcile RUNNING Attempts via leases, never claim success without evidence.

## Review Focus

- Work Order with contradictory acceptance criteria + out-of-scope overlap — expect explicit REWORK/clarification QUESTION, not silent narrowing.
- High-risk Work Order (prod/auth/payments/PII/secrets) requesting auto-promote — expect REQUIRE_HUMAN + no auto-merge.
- Worker crash mid-Attempt + Factory restart during VERIFYING — expect new Attempt from clean baseline, old diff preserved as evidence, no duplicate side effects.
- Quota-exhausted mid-task with Work Order pinning escalation model — expect WAITING_RESOURCE, not silent cheap-model substitution.
- Semantic verifier receiving developer transcript instead of fresh context — expect rejection of verification as non-independent.

---

### Task 1: E1 Core domain + persistence — model `opencode-go/qwen3.8-flash`

**Files:**
- Create: `src/factory/state/schema.sql`, `src/factory/state/store.ts`, `src/factory/events/log.ts`, `src/factory/domain/workOrder.ts`
- Test: `tests/factory/e1-domain.test.ts`

**Interfaces:**
- Consumes: none (foundation).
- Produces: `createWorkOrder(intent) -> WorkOrder(DRAFT)`, `transitionWorkOrder(id, event) -> WorkOrder` (Factory-owned), `appendEvent(e) -> seq`, `StateStore.get/set`, `ArtifactStore.put/get` — used by E2,E3,E4,E5,E7.

- [ ] **Step 1: Write failing test** for Work Order lifecycle DRAFT→READY→PLANNING→EXECUTING→VERIFYING→EVIDENCE_READY→HUMAN_GATE→APPROVED→MERGED + Task DAG PLANNED→READY→ASSIGNED→RUNNING→VERIFYING→VERIFIED + Attempt record with model/worker/context/diff/verification provenance; SQLite + event-log replay restores state.
- [ ] **Step 2: Run test to verify it fails** Run: `bun test tests/factory/e1-domain.test.ts` Expected: FAIL (modules missing).
- [ ] **Step 3: Implement schema + stores** `src/factory/state/schema.sql` tables per spec §19 (work_orders,tasks,task_dependencies,attempts,workers,assignments,interactions,artifacts,verification_runs,evidence_bundles,policy_decisions,routing_decisions,events); WAL mode; `store.ts` + `log.ts` + `workOrder.ts` with Factory-owned transitions only.
- [ ] **Step 4: Run test to verify it passes** Run: `bun test tests/factory/e1-domain.test.ts` Expected: PASS.
- [ ] **Step 5: Commit** `git add src/factory/state tests/factory/e1-domain.test.ts; git commit -m "feat: E1 core domain persistence"`

### Task 2: E3 Planning + scheduling + workers — model `opencode-go/qwen3.8-flash`

**Files:**
- Create: `src/factory/planning/dag.ts`, `src/factory/scheduler/scheduler.ts`, `src/factory/workers/manager.ts`, `src/factory/workers/herdr.ts`, `src/factory/worktrees/worktree.ts`
- Test: `tests/factory/e3-planning.test.ts`

**Interfaces:**
- Consumes: E1 `createWorkOrder`, `StateStore`, `appendEvent`.
- Produces: `proposeDAG(wo) -> DAGv1`, `commitDAG(wo, dag) -> DAGv2…`, `provisionWorker(profile)`, `assign(task)`, isolated `branch+worktree+baseCommit` per Task — used by E5,E7.

- [ ] **Step 1: Write failing test** planner proposal → Factory validation/commit (invalid DAG rejected, versions preserved), 2–3 concurrent independent Tasks run, dependent stays blocked, demand-driven provisioning min:0 max:5, worktree isolation per Task.
- [ ] **Step 2: Run test** `bun test tests/factory/e3-planning.test.ts` Expected: FAIL.
- [ ] **Step 3: Implement** `dag.ts` (validate + version), `scheduler.ts` (capacity+policy aware), `manager.ts`/`herdr.ts` (provision/start/stop/execute/collect/destroy), `worktree.ts` (branch+worktree+baseCommit).
- [ ] **Step 4: Run test** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: E3 planning scheduling workers"`

### Task 3: E4 DecisionModel routing — model `opencode-go/glm-5.3-flash`

**Files:**
- Create: `src/factory/routing/decisionModel.ts`, `src/factory/routing/rules.ts`
- Modify: `.opencode/plugins/factory-guard/router.ts` (reference only, no runtime Go IDs leak)
- Test: `tests/factory/e4-routing.test.ts`

**Interfaces:**
- Consumes: E1 `routing_decisions` table + `appendEvent`.
- Produces: `DecisionModel.recommend(input: RouteInput) -> ModelId[]`, `selectModel(input,budget,unavailable)` capability-first + budget-filtered, `routing.log` entry — used by E8; pattern portable from dev Span-default admission.

- [ ] **Step 1: Write failing test** generic interface (no Jev/Span types), deterministic constraints → candidate set → Factory assignment, budget gates (escalation m/w≥30%/5h≥20%, mid ≥10%/10%/5%), manual override wins, every decision persisted with provenance.
- [ ] **Step 2: Run test** `bun test tests/factory/e4-routing.test.ts` Expected: FAIL.
- [ ] **Step 3: Implement** `decisionModel.ts` (generic seam), `rules.ts` (port of capability matrix, no Go IDs in runtime semantics).
- [ ] **Step 4: Run test** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: E4 generic DecisionModel routing"`

### Task 4: E2 Server API + Client/CLI — model `opencode-go/qwen3.8-flash`

**Files:**
- Create: `src/factory/api/server.ts`, `src/factory/api/client.ts`, `src/cli/factory.ts`, `factory.yaml`, `compose.yaml`
- Test: `tests/factory/e2-api.test.ts`

**Interfaces:**
- Consumes: E1 stores, E3 scheduler (status), E5 evidence (read).
- Produces: `factory init/start/stop/status/update/backup/restore`, Work Order CRUD + WAITING_INPUT answer + Observatory projections — used by E6.

- [ ] **Step 1: Write failing test** submit Work Order → status → answer QUESTION resumes Task → Observatory shows verified-throughput/human-hour → backup onto fresh machine restores (state+evidence+knowledge+config+versions).
- [ ] **Step 2: Run test** Expected: FAIL.
- [ ] **Step 3: Implement** API + CLI + compose + factory.yaml resolver (desired→runtime), persistent volumes, health/validation, explicit image versions.
- [ ] **Step 4: Run test** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: E2 server API client CLI"`

### Task 5: E5 Verification + Evidence — model `opencode-go/qwen3.8-flash`

**Files:**
- Create: `src/factory/verification/engine.ts`, `src/factory/verification/semantic.ts`, `src/factory/evidence/bundle.ts`
- Test: `tests/factory/e5-verify.test.ts`

**Interfaces:**
- Consumes: E1 attempts/artifacts, E3 change sets.
- Produces: `verify(changeSet) -> {deterministic,behavioral,semantic,evidence}`, `EvidenceBundle{ac→proof,gates,model/prompt provenance,tier sign-off}` — used by E6,E8.

- [ ] **Step 1: Write failing test** deterministic (typecheck/lint/tests/build) + behavioral (Playwright/contract) + semantic (independent fresh-context judge falsifying AC, writer≠verifier) → Evidence Bundle maps every AC; failure structured {category,criterion,verifier,evidence,diagnosis,action}; verifier never mutates impl.
- [ ] **Step 2: Run test** Expected: FAIL.
- [ ] **Step 3: Implement** engine + semantic + bundle (immutable once produced, agent self-assessment advisory only).
- [ ] **Step 4: Run test** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: E5 verification evidence"`

### Task 6: E7 Policy/risk + recovery — model `opencode-go/deepseek-v4.1-flash`

**Files:**
- Create: `src/factory/policy/policy.ts`, `src/factory/policy/risk.ts`, `src/factory/recovery/recovery.ts`
- Test: `tests/factory/e7-policy.test.ts`

**Interfaces:**
- Consumes: E1 policy_decisions/events, E3 worker leases.
- Produces: `check(task,action) -> ALLOW/DENY/REQUIRE_HUMAN`, `classifyRisk(wo)`, `recover(failure)`, `emergencyStop()` — gates E2,E5,E6.

- [ ] **Step 1: Write failing test** Org→Project→WO→Task monotonic narrowing, capability checks (repo.write/pr.create/deploy.execute/secrets.read…), Yellow-start, bounded retries (no blind retry), crash→load state→reconcile leases→retry/replan/escalate, WAITING_RESOURCE on quota (no silent downgrade), pause/resume/e-stop preserves evidence.
- [ ] **Step 2: Run test** Expected: FAIL.
- [ ] **Step 3: Implement** policy + risk + recovery (idempotency keys, backoff+jitter, circuit breaker).
- [ ] **Step 4: Run test** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: E7 policy risk recovery"`

### Task 7: E6 GitHub integration — model `opencode-go/qwen3.8-flash`

**Files:**
- Create: `src/factory/github/adapter.ts`
- Test: `tests/factory/e6-github.test.ts`

**Interfaces:**
- Consumes: E2 API, E5 Evidence Bundle, E7 policy checks.
- Produces: `importIssue()`, `openPR(evidence)`, `merge(gate)` — closes acceptance loop §27.

- [ ] **Step 1: Write failing test** GitHub import→Work Order→…→PR→merge with evidence link, hygiene checks green, no self-merge, merge only on APPROVED + policy ALLOW.
- [ ] **Step 2: Run test** Expected: FAIL.
- [ ] **Step 3: Implement** adapter (sole external MVP integration; interfaces for future providers).
- [ ] **Step 4: Run test** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: E6 github integration"`

### Task 8: E8 Telemetry/self-improvement v0 — model `opencode-go/qwen3.8-flash`

**Files:**
- Create: `src/factory/telemetry/telemetry.ts`, `src/factory/improve/loop.ts`
- Test: `tests/factory/e8-telemetry.test.ts`

**Interfaces:**
- Consumes: E4 routing decisions, E5 verification outcomes, E1 events.
- Produces: Observatory metrics (verified/day, throughput/human-hour, rework, cost), `proposeImprovement() -> WorkOrder` (Levels 1–2 only) — no auto-mutation.

- [ ] **Step 1: Write failing test** outcome/human-leverage/execution/quality/economics/decision telemetry recorded (why model/skill/context/risk/allow-deny/replan/gate), drill-down WO→Task→Attempt→trace→verification→evidence→decision, improvement follows Observe→Propose→Benchmark→Qualify→Promote as Work.
- [ ] **Step 2: Run test** Expected: FAIL.
- [ ] **Step 3: Implement** telemetry + loop v0 (no weights, no scaffold mutation).
- [ ] **Step 4: Run test** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: E8 telemetry improvement v0"`

## Self-Review

- Spec coverage: §5 WO/Task/Attempt/Evidence→E1; §7 planning→E3; §8 routing→E4; §6,20,22 client/deploy→E2; §14 verification→E5; §12 interaction/§13 policy/§18 recovery→E7; GitHub §4.2/§28→E6; §23-26 observatory/telemetry/benchmark/dogfood→E8. All 24 invariants mapped to E1/E5/E7 tests.
- Step scan: each step yields one artifact + one command + expected output; no TBDs.
- Type consistency: RouteInput/RouteDecision/DecisionModel names match `router.ts`; WorkOrder/Task/Attempt/EvidenceBundle match spec §5.
- Proportion: plan ~8 tasks for ~34-section spec; bodies omitted, only signatures + assertions referenced.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-29-factory-server-v01.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - fresh subagent per task + reviewer, whole-branch review at end. Most thorough; costs fresh context per task.
- **Native** - I implement every task myself in this session, then one fresh reviewer. Cheapest and fastest.

For this plan I recommend **Subagent-driven**, because tasks have strict interface dependencies (E1→others) and verification boundaries where independent review prevents Writer=Verifier violations. Does the plan capture what you want, and which approach should we use?
