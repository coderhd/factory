# Policy and Risk Model (E7.1)

- **Status:** Accepted design for Factory Server v0.1 policy/risk + recovery (epic `coderhd/factory#7`, sub-issue `coderhd/factory#22` [E7.1])
- **Decision record:** [ADR 14 — Policy is monotonic-narrowing down Org→Project→Work Order→Task; sensitive actions are runtime-checked](../decisions/adr-14-monotonic-policy-and-risk.md)
- **Authority:** design spec §12 (Interaction / QUESTION), §13 (Risk and Policy; §13.1 Risk Tiers, §13.2 Policy), §18 (bounded recovery, idempotency, quota/emergency controls); plan `docs/superpowers/plans/2026-09-29-factory-server-v01.md` Task 6 (E7). Spec citations are always prefixed "spec §"; bare "§N" cites this document.
- **Implements against (existing code):** E1 `src/factory/state/store.ts` (`policy_decisions` collection, `StateStore`, `EventLog`), `src/factory/domain/workOrder.ts` (`RiskTier` = `GREEN | YELLOW | RED`, `Attempt.failureHistory`), E3 `src/factory/scheduler/scheduler.ts` (`PolicyVerdict`, `SchedulerPolicy.canAssign`), `src/factory/workers/manager.ts` (`WorkerLease { attemptId, taskId, expiresAt, renewedAt }`), E3 `src/factory/planning/dag.ts` (replan guard)
- **Scope split (controller ruling R20):** this document + ADR 14 own the **architecture**; sub-issue #23 owns the **implementation** (`src/factory/policy/policy.ts`, `src/factory/policy/risk.ts`, `src/factory/recovery/recovery.ts`, `tests/factory/e7-policy.test.ts`). Everything below is contract, not code.

## 1. Scope

This is the concrete policy/risk spec the Factory Server v0.1 plan argues from. It fixes:

1. the capability list and per-capability semantics (spec §13.2's nine capabilities) — §4;
2. the exact `ALLOW` / `DENY` / `REQUIRE_HUMAN` decision semantics and how the three compose down the Organization → Project → Work Order → Task hierarchy (monotonic narrowing, proven on paper in §3.4 + §7);
3. the risk-tier machinery (`classifyRisk`, Yellow start, earned Green, Red never auto-promotes) — §6;
4. the recovery/recovery-policy contract `recover(failure)` and `emergencyStop()` must honor (spec §18) — §9–§10;
5. the production/security/auth threat model of the MVP — §12;
6. the versioned policy source format — §11.

Implementation sub-issue #23 implements this contract; this document fixes the semantics on paper so implementation review can diff code against it.

## 2. Interfaces #23 implements (plan Task 6)

```text
check(subject, action)      -> ALLOW | DENY | REQUIRE_HUMAN     (PolicyVerdict, already exported by scheduler.ts)
classifyRisk(wo)            -> GREEN | YELLOW | RED             (RiskTier, already exported by E1 workOrder.ts)
recover(failure)            -> RecoveryAction                   (§9.2)
emergencyStop()             -> void  (+ factory pause/resume)   (§10)
```

- `subject` (`TaskRef`) = `{ taskId: string; workOrderId: string } | { taskId: null; workOrderId: string }`. Task-scoped checks call `check({ taskId, workOrderId }, action)` — the plan's `check(task, action)` shape; Work-Order-scoped actions (e.g. the E6 merge gate) pass `taskId: null`.
- **Consumes:** E1 `StateStore` (especially the `policy_decisions` collection) and `EventLog`; E3 `WorkerManager` leases (`listWorkers()`, `WorkerLease.expiresAt`) for crash reconciliation; E4 `RoutingDecisionRecord` for the no-silent-downgrade cross-check in §9.5.
- **Produces (durable):** `policy_decisions` rows + `policy.decision` events (§5.1); `RecoveryAction` records (§9.2).
- **Gates (call sites):** E3 scheduler `canAssign` (assignment), E2 API consequential endpoints, E6 (`openPR`, merge — merge only on Work Order `APPROVED` **and** policy `ALLOW`), worker dispatch envelopes.

## 3. Policy hierarchy and composition algebra (spec §13.2)

### 3.1 The chain

```text
Organization  →  Project  →  Work Order  →  Task  →  Effective Policy
```

- **Organization** — the deployment root policy (MVP: the deployment's embedded defaults, optionally overridden by versioned YAML, §11).
- **Project** — per-repository policy (keyed by repository name).
- **Work Order** — narrowing knobs read from the E1 `WorkOrder` entity (`constraints`, `outOfScope`, `riskTier`, `repository`) plus WO-scoped policy written at creation.
- **Task** — a pure identity level in v0.1 (E1 `Task` carries only title/dependsOn): silent inheritance in practice, but a Task level exists in the algebra so Tasks can narrow later without a schema change.
- **Effective Policy** — the resolved decision per (capability, resource) at evaluation time.

### 3.2 The restriction lattice (fixed)

Per capability, every expressed decision sits on a three-step lattice, **strictness descending**:

```text
DENY   (most restrictive)
   ↓
REQUIRE_HUMAN
   ↓
ALLOW  (most permissive / least restrictive)
```

Comparing decisions: `DENY` is stricter than `REQUIRE_HUMAN` is stricter than `ALLOW`. The fold operator:

```text
tighter(a, b):
  tighter(DENY, _)            = DENY
  tighter(_, DENY)            = DENY
  tighter(REQUIRE_HUMAN, ALLOW) = REQUIRE_HUMAN
  tighter(ALLOW, REQUIRE_HUMAN) = REQUIRE_HUMAN
  tighter(x, x)               = x
```

`tighter` returns one of its arguments or something stricter; by construction it **never** returns a decision less restrictive than either argument.

### 3.3 Composition rule (the narrowing rule)

For a capability `c` evaluated at node `N` on the chain, with scope `s` (path/branch/env/data qualifiers, §3.5):

1. **Silence inherits.** A level that says nothing about `(c, s)` contributes nothing; the parent's effective decision propagates down unchanged.
2. **Strictest-wins.** The effective decision for `(c, s)` at `N` is `tighter(effective(parent), own(N))` where `own(N)` is `N`'s expressed decision for `(c, s)` — or `effective(parent)` unchanged if `N` is silent. Every level's contribution is folded with `tighter`, so a descendant expressing anything *less* restrictive than an ancestor is simply dominated: it can never take effect.
3. **Root default.** If no level on the chain expresses anything for `c`, the capability's **root default** from the capability table (§4) applies. Defaults are fixed in the deployment policy and version-stamped like everything else.
4. **Scopes intersect.** Where parent and descendant both scope the same grant, the effective resource set is the **intersection** (§3.5): a descendant's scope can remove resources, never add them.
5. **Ceilings sit outside the hierarchy.** Each capability has a fixed ceiling — the most permissive decision *any* policy level may express (§4, last column). No Organization/Project/WO/Task policy may express a decision more permissive than the ceiling, and the ceiling is not itself subject to hierarchy resolution; it is a property of the deployment.

### 3.4 Why a child cannot widen a parent (proof)

Theorem: for every capability `c`, scope `s`, and chain Org → Project → WO → Task, `restrictiveness(effective(Task)) ≥ restrictiveness(effective(parent of Task))`, with restrictiveness ranked `ALLOW < REQUIRE_HUMAN < DENY`.

*Proof.* By rule 3.3-2, `effective(child) = tighter(effective(parent), own(child))`. From the definition, `tighter(a, b) ∈ {a} ∪ {something stricter than a}`, hence `restrictiveness(effective(child)) ≥ restrictiveness(effective(parent))`. Scoping: by rule 3.3-4, `scope(child) = scope(parent) ∩ own(child) ⊆ scope(parent)`. By induction on chain length the property holds from the root through every level. `ALLOW` can survive to a Task only if the whole chain above never expressed `REQUIRE_HUMAN`, `DENY`, or a narrower scope for that `(capability, scope)` — a child cannot manufacture it. ∎

Two consequences, both ported by #23 to `tests/factory/e7-policy.test.ts`:

- **Narrowing is legal at every level and kind:** `ALLOW → REQUIRE_HUMAN`, `ALLOW → DENY`, `REQUIRE_HUMAN → DENY`, scope-set shrinking.
- **Widening is inert, not an error:** a descendant expressing a *looser* decision simply loses the fold (the parent's stricter decision wins). v0.1 records the attempt in the decision's `rules` trail as `widening-attempt` provenance — recorded, not fatal.

### 3.5 Policy dimensions (spec §13.2)

Every grant may be scoped by the six spec §13.2 dimensions — **repository, path/resource, action (the capability), data, environment, reversibility**. v0.1 concretely supports: path patterns (`src/**`), branch patterns (`wo-*/**`), environment (`staging` | `production`), data class (`synthetic` | `customer-data`), reversibility class (§4). Unmodeled dimensions are treated as unscoped (the parent's scope is unchanged).

### 3.6 The hierarchy cannot be widened by anything inside it

Only two things sit above the hierarchy, and both are outside it by design:

1. **Ceilings** (§3.3-5) — deployment-fixed.
2. **A human decision** (an `APPROVAL` interaction answered by an operator, spec §12) — humans are not a policy level in the chain; an operator approval *consumes* a `REQUIRE_HUMAN` verdict instance (§5, stage 4) and is recorded as evidence. A child policy never inherits an approval as authority to widen: approvals are single-use and instance-bound (`taskId` + `capability` + resource binding + `attemptId`), never reusable as a standing grant.

## 4. Capability list (all nine from spec §13.2) — fixed semantics

Columns: the decision at root when silent everywhere (`Default`), the per-capability ceiling (`Ceiling` = most permissive decision any level may express), the sensitivity class used by tier gates (§8.1), reversibility. The four capabilities the sub-issue names explicitly (`repo.write`, `pr.create`, `deploy.execute`, `secrets.read`) are starred.

| Capability | Gates | Default (root) | Ceiling | Sensitivity | Reversibility | Notes |
|---|---|---|---|---|---|---|
| `repo.read` | Reading repository content by a worker (checkout, file reads, diff reads) | `ALLOW` (unscoped) | `ALLOW` | low | read-only | Subject to path denies (e.g. `.env*`); never logs secret material (§12.3). |
| `repo.write` ★ | Writing code in a repository context (attempt diffs, worktree commits) | `ALLOW` with scope `{ branchPattern: "wo-*/**" }` (Factory worktree branches only) — anything else (default branch, outside worktree) resolves `DENY` via the scope | `ALLOW` | medium (auto risk bump when the resource path matches the security taxonomy, §6.3) | reversible per worktree (clean-worktree recovery, spec §18.4) | v0.1: the Factory creates per-task worktrees (E3); direct writes to the default branch or outside a task worktree are outside the root scope. |
| `branch.create` | Creating branches (`push` of a new ref) in the project repo | `ALLOW` scoped to the Factory prefix `wo-*/**` | `ALLOW` | low | reversible (delete branch) | Branch deletion and default-branch writes are not granted by any v0.1 capability and are outside every scope. |
| `pr.create` ★ | Opening/updating a pull request (E6 adapter) | `ALLOW` | `ALLOW` | medium | reversible (close PR) | Non-destructive and visible; gated at Yellow tier *before promotion/merge*, not before creation (§8.1 note). |
| `ci.run` | Triggering CI runs (PR checks) | `ALLOW`, bounded | `ALLOW` | medium | cost-only | Bounded by retry budgets (§9.4); no unbounded standalone workflow triggering. |
| `production.read` | Reading production systems/data | `REQUIRE_HUMAN` when `dataClass: customer-data`; `ALLOW` for `synthetic`/staging reads | `REQUIRE_HUMAN` | high (PII) | read-only | Reading real customer data requires a human-brokered approval (§12.3); PII never lands in events/artifacts. |
| `production.write` | Mutating production systems/data directly | `DENY` | `REQUIRE_HUMAN` | high | **irreversible** | Ceiling is `REQUIRE_HUMAN`: even an explicitly granted deployment can never express bare `ALLOW`. |
| `deploy.execute` ★ | Executing a deployment to an environment | `REQUIRE_HUMAN` for `env: production`; `ALLOW` for `env: staging` | `REQUIRE_HUMAN` | high | treat prod as irreversible | v0.1 production callers: the E6 `merge`/promotion path only. |
| `secrets.read` ★ | Any worker access to secret material (tokens, keys, credentials, `.env` values) | `DENY` | `REQUIRE_HUMAN` | high | n/a (read-of-secret) | Ceiling `REQUIRE_HUMAN` **and** brokered: even an approved instance never hands plaintext to a worker — the human binds the value at the boundary (§12.3). v0.1 default (and effective practice): outright `DENY` to all workers. |

Rules of the table:

- **Default-deny for sensitive capabilities.** `production.*` and `secrets.read` default to their ceilings or `DENY`; silence never opens them.
- **Capabilities not in this list do not exist** (closed vocabulary, like E4's fixed `RouteInput` vocabulary). A check for an unknown capability is a `DENY` with `rules: ['unknown-capability']`.
- **An absent grant is not an implicit `ALLOW`** except where this table's `Default` says `ALLOW` for low-risk read-side capabilities; otherwise silence resolves through §3.3-1/§3.3-3 to the restrictive default.

## 5. Decision semantics — exactly when each verdict is returned

`check(subject, action) → PolicyVerdict` is a pure function over: the resolved policy chain for `subject.workOrderId`'s project, the E1 `WorkOrder` (for `riskTier` + `constraints`), the human-approval ledger, and `action = { capability, resource? }`. Computed in four stages, in order; **the composition is monotone** — stage 1 may short-circuit to `DENY`, stages 2–3 may only make the verdict stricter, and stage 4 is the single sanctioned relaxation (consumption of a human approval), which only ever consumes a `REQUIRE_HUMAN`:

1. **Emergency-stop gate.** If the Factory is in e-stop (§10) and `action` is a consequential external action (`deploy.execute`, `pr.create`, `ci.run`, `production.write`): return `DENY`, `resolvedBy: 'e-stop'`. (Questions/interactions are not blocked by e-stop; §10.)
2. **Chain resolution (§3).** Fold Org → Project → WO → Task decisions and scopes for `(action.capability, action.resource)` with `tighter`; an explicit `DENY` anywhere on the matched scope settles the fold at `DENY`; silence + absent grants fall to the §4 `Default`.
3. **Tier gate (§8.1).** Apply `tighter(fold, tierFloor(classifiedTier, sensitivityClass))` — the tier gate can only restrict, never relax; e.g. any `RED`-tier Work Order ⇒ floor `REQUIRE_HUMAN` on every sensitivity class.
4. **Human-approval consumption.** If the standing verdict is `REQUIRE_HUMAN` and a recorded, unspent, instance-matching `APPROVAL` interaction exists (same `taskId`, `capability`, resource binding, `attemptId`; §3.6): return `ALLOW`, `resolvedBy: 'human-approval'` (spend the approval). A matching approval **never** overrides a `DENY` — overriding a denial means changing the policy (an operator action outside the hierarchy), not answering a gate.

Exact meaning of each verdict, restated as the contract #23 implements and tests:

- **`ALLOW`** — the action may proceed under Factory orchestration **now**, with the narrowed scope in force (the `rules` trail carries the org/project/WO/Task rule ids that produced it). It is the *only* verdict under which the scheduler assigns (E3 `canAssign === 'ALLOW'`) and the only verdict under which E6 performs external effects (§2).
- **`DENY`** — the action is refused, durably and non-negotiably at runtime. An explicit `DENY` at any level on the matched scope always produces `DENY`; unknown capabilities produce `DENY`; e-stop produces `DENY` for consequential external actions.
- **`REQUIRE_HUMAN`** — the action is blocked from autonomous execution pending an operator decision through the spec §12 interaction system. Returning the verdict also creates the request: an `APPROVAL`-type interaction record (distinct from the `QUESTION` interactions E3 already writes), carrying the action binding and context, one per distinct action instance (deduplicated by the action binding). It is **not** a failure and **not** `DENY`: the Task parks (`WAITING_INPUT`, spec §12) and does not consume recovery budget (§9.4).

**Absent grant** (capability never mentioned anywhere on the chain): resolve via §4 `Default` — low-risk read-side capabilities inherit a permissive default; sensitive ones resolve restricted. An **unscoped action** (no resource binding) evaluates against the unscoped fold; capabilities whose root scope requires a binding (e.g. `deploy.execute` needs `env`) resolve `REQUIRE_HUMAN`/`DENY` rather than guess. **Unknown** capability: `DENY`.

**Composition of the three decisions down the hierarchy** is exactly §3.3: `tighter` fold, silence inherits, scopes intersect, ceilings cap, defaults at root. `REQUIRE_HUMAN` sits between `ALLOW` and `DENY` in every fold.

### 5.1 Durable decision records (spec §13.2)

Every `check` persists its outcome — this is the audit trail the whole verification/telemetry chain reads:

- **State:** a row in E1's `policy_decisions` collection.
- **Event:** `policy.decision` appended to the event log (`aggregateType: 'policy_decision'`, `aggregateId: <record.id>`), in **one `store.db.transaction` with the row** (state and log can never disagree — mirrors E1's `createWorkOrder` / E4's `persistRoutingDecision`).
- **Record shape** (`PolicyDecisionRecord`), carrying exactly the fields spec §13.2 requires (task, action, risk, decision, rules, policy version) plus v0.1 additions:

```text
PolicyDecisionRecord {
  id: string                 // pd_*
  task: string | null        // taskId (null for Work Order-scoped checks, e.g. merge)
  workOrderId: string | null
  action: { capability, resource?: { path?, branch?, env?, dataClass? } }
  risk: 'GREEN' | 'YELLOW' | 'RED'     // classified tier at decision time (§6.3)
  decision: 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN'
  rules: string[]            // matched rule ids + the narrowing trail org→project→wo→task
                             // (+ markers: 'unknown-capability', 'widening-attempt', 'e-stop')
  policyVersion: string      // '<embedded>' or the YAML policy file hash (§11)
  resolvedBy: 'policy' | 'tier-gate' | 'human-approval' | 'e-stop'
  interactionId?: string     // when an APPROVAL consumed this verdict (stage 4)
  createdAt: string
}
```

## 6. Risk tiers (`classifyRisk`) — Yellow start, earned Green, Red never auto-promotes

### 6.1 Vocabulary and the E4 mapping

E1 fixes `RiskTier = 'GREEN' | 'YELLOW' | 'RED'` on the `WorkOrder`. E4 routing carries `risk: 'low' | 'medium' | 'high'` in `RouteInput`. Canonical mapping (both directions, fixed for v0.1):

```text
GREEN ↔ low      YELLOW ↔ medium      RED ↔ high
```

### 6.2 Start state (spec §13.1: "Everything starts at Yellow")

- The Factory default classification for every new Work Order is **`YELLOW`** (E1 `createWorkOrder` already implements `intent.riskTier ?? 'YELLOW'`).
- A human may **declare** a tier at creation by passing `intent.riskTier` explicitly. Human declaration is the only way a Work Order is *created* `RED`; it is recorded as a `policy.decision` (`resolvedBy: 'policy'`, `rules: ['declared']`). Declaration is not promotion — execution at `RED` is still governed by §6.5/§8.1.
- `createWorkOrder` cannot manufacture `GREEN` out of nothing: `intent.riskTier: 'GREEN'` is honored only when the intent carries an **earned-Green reference** (§6.4); otherwise it is coerced to `YELLOW` and the coercion recorded. Green is earned, not asserted.

### 6.3 `classifyRisk(wo) → RiskTier` — contract

```text
classifyRisk(wo) = tighter-tier(wo.riskTier, inferredRisk(wo))
```

(where `tighter-tier` is the tier analogue of `tighter`: it never lowers.)

- `inferredRisk(wo)` — deterministic, no-LLM classification over the Work Order's own durable fields (`constraints`, `outOfScope`, `repository`, `requiredVerification`, acceptance-criteria text) plus **runtime-observed** risk contributed by the current task resource paths (a check's `action.resource` path matching): hitting the **security taxonomy** (auth, secrets, payments, PII, prod infrastructure — v0.1: a pattern list declared in the deployment policy, e.g. `auth/**`, `*password*`, `secrets/`, `infra/prod/**`) ⇒ `RED`; prod-deploy or customer-data exposure ⇒ `RED`.
- **Monotonicity (the invariant #23 must test):** `classifyRisk` **never returns a tier below `wo.riskTier`**. Inference can raise (`YELLOW → RED`), never lower. Hence "high-risk never auto-promotes": once a Work Order is observed high-risk, no automatic path exists that treats it as lesser.
- **"Red never auto-promotes":** lifecycle promotion (§8-3) can never move a Red Work Order to `APPROVED → MERGED` autonomously — the §8.1 tier gate holds every consequential action at `REQUIRE_HUMAN` (at best), and `APPROVED` requires an explicit operator response at the `HUMAN_GATE`, recorded for non-repudiation.
- Tier **changes** are durable: raising (auto, classifier) and lowering (human-initiated only, §6.4) each append a `risk.tier_changed` event + `policy_decisions` row pointing at the evidence.

### 6.4 "Green is earned after evidence" — the earn path

The tier-carryover mechanism (otherwise a Work Order could never be `GREEN` by right):

1. A Work Order deliberately executes at `YELLOW` with all its controls.
2. At `HUMAN_GATE`, the operator's `APPROVAL` response may additionally record **earned Green for a change class** = (project + capability class + path class) with pointers to: the complete `EvidenceBundle`, verification runs green, zero violation-caused `REQUIRE_HUMAN` escalations, zero widening attempts, and no high-sensitivity capability exercised in the class.
3. The record is durable (`risk.tier_changed` event + `policy_decisions`, `resolvedBy: 'human-approval'`). *Future* Work Orders may then be **declared** `GREEN` at creation **only** by referencing that record (`intent.riskTier: 'GREEN'` + earned-Green ledger reference), validated at creation (§6.2).
4. The runtime classifier (§6.3) can always re-raise a declared-`GREEN` Work Order to `RED` when observed paths/data say so. Lowering is humans-only, evidenced, recorded.

### 6.5 Tier → required controls (spec §13.1, fixed mapping)

| Tier | Execution | Verification | Rework | Promotion/approval |
|---|---|---|---|---|
| **GREEN** (low) | autonomous | deterministic (required) | automatic rework allowed (bounded, §9.4) | promotion per policy: auto-`APPROVED` at `EVIDENCE_READY → HUMAN_GATE` **only if** the Evidence Bundle is complete, no high-sensitivity capability was used, and nothing requires semantic sign-off; otherwise the gate holds |
| **YELLOW** (medium) | autonomous with capability whitelist | deterministic + behavioral; semantic "where appropriate" — mandatory when the diff touches the security taxonomy or the WO declares `requiredVerification: semantic` | bounded rework | human approval before promotion: `HUMAN_GATE` mandatory; `MERGED` only after operator `APPROVAL` + policy `ALLOW` (E6) |
| **RED** (high) | **constrained**: approved capability + model list only (no silent model substitution, §9.5); high-sensitivity capabilities capped per §4 ceilings | deterministic + behavioral + **mandatory semantic & security verification** (independent verifier; writer ≠ verifier) | rework only within budget, then escalate | **explicit human approval; no automatic promotion ever** — the GREEN auto-promote path is unavailable by construction (the §8.1 tier gate escalates `ALLOW → REQUIRE_HUMAN`) |

## 7. Monotonic narrowing — worked examples (proof on paper)

Scenario: the §11 embedded defaults; Project `client-portal` narrows `repo.write` paths to `src/**`/`docs/**`, allows staging deploys on `release/**`, denies `production.read`; Work Order `wo-142` (Yellow, `client-portal`) narrows `branch.create` to `wo-142/*` and adds the constraint "no deploy in this WO" (`deploy.execute → DENY`); Task `t-7` is silent. Each example shows the fold per (capability, matched scope); traces are the `rules` trails #23 should produce.

### 7.1 Valid narrowing chain (worker writes a source file)

`check({ taskId: 't-7', workOrderId: 'wo-142' }, { capability: 'repo.write', resource: { path: 'src/auth-form.ts', branch: 'wo-142/impl' } })`

| Level | Expresses | Scope match | Fold after level |
|---|---|---|---|
| Organization | `ALLOW` | branch `wo-142/impl` ∈ `wo-*/**`; path ∉ `infra/**` | `ALLOW` |
| Project `client-portal` | `ALLOW` | path ∈ `{src/**, docs/**}` | `ALLOW ∩ {src/**,docs/**}` → `ALLOW` (scope stays non-empty) |
| Work Order `wo-142` | silent | — | `ALLOW` (inherited) |
| Task `t-7` | silent | — | `ALLOW` |

Chain fold = `ALLOW` → tier gate: `classifyRisk(wo-142) = RED` (the WO's accepted criteria touch the auth module; §6.3) ⇒ floor `REQUIRE_HUMAN` ⇒ **`REQUIRE_HUMAN`**. The Task parks pending a human approval; the approval (once granted) makes this instance `ALLOW`. Narrowing worked exactly as designed; the tier gate then *tightened* it — no stage relaxed anything.

### 7.2 Attempted widening #1 — a Task tries to unlock secrets

A Task-level policy entry claims `{ capabilities: { 'secrets.read': { decision: allow } } }`.

| Level | Expresses | Fold after level |
|---|---|---|
| Organization | `DENY` (root default, ceiling `REQUIRE_HUMAN`) | `DENY` |
| Project / WO / Task | Task says `ALLOW` | `tighter(DENY, ALLOW) = DENY` |

Verdict: **`DENY`**, `rules: ['org:secrets.deny', 'task:allow@widening-attempt']`. The child's `ALLOW` is inert — the parent's `DENY` dominates. Recorded provenance flags the widening attempt (§3.4).

### 7.3 Attempted widening #2 — scope widening via the intersection

The Work Order tries to grant `repo.write` on `infra/**` (claiming "we own this repo too").

| Level | Scope for `repo.write` | Fold after level |
|---|---|---|
| Organization | branch `wo-*/**`, exclude `infra/**` | scope = `{branch: wo-*/**, paths: ¬infra/**}` |
| Project | include `{src/**, docs/**}` | scope = `{branch: wo-*/**, paths: {src/**,docs/**} ∩ ¬infra/**}` |
| Work Order | claims paths `{src/**, infra/**}` | **intersection**: `{src/**} ∩ ¬infra/**` = `{src/**}` under branch `wo-*/**` |
| Task | inherits | unchanged |

`check(…, { capability: 'repo.write', resource: { path: 'infra/main.tf', branch: 'wo-142/impl' } })` → no scoped grant covers `infra/**` (Org exclude ∩ WO claim removes it) ⇒ **`DENY`**. The claimed scope set intersected with the parent's scope can never exceed `scope(parent)` (§3.4) — widening by resource claim is impossible.

### 7.4 Attempted widening #3 — the Work Order tries to self-approve deployment

`wo-142`'s Task-level entry claims `deploy.execute: ALLOW` with `env: production`.

| Level | Expresses | Fold after level |
|---|---|---|
| Organization | `REQUIRE_HUMAN` (env: production) | `REQUIRE_HUMAN` |
| Project | `ALLOW` scoped `{env: staging, branchPattern: release/**}` | staging-only: no production grant ⇒ organizational `REQUIRE_HUMAN` carries for production; `ALLOW` stands only for staging... **within its scope** |
| Work Order | claims `ALLOW` (env: production) | production env: `tighter(REQUIRE_HUMAN, ALLOW) = REQUIRE_HUMAN` |
| Task | claims `ALLOW` | `tighter(REQUIRE_HUMAN, ALLOW) = REQUIRE_HUMAN` |

Verdict for `{ capability: 'deploy.execute', resource: { env: 'production' } }`: **`REQUIRE_HUMAN`** — and since `wo-142` additionally declared "no deploy in this WO" (`deploy.execute → DENY` at WO level), the WO's own narrowing makes the fold `tighter(REQUIRE_HUMAN, DENY) = DENY`. Either way the attempt to widen to bare production `ALLOW` fails; the child's best possible outcome under this ceiling is what the parent already required.

### 7.5 What the proof and examples jointly establish

1. `DENY` anywhere on the chain is final below that level (§3.4 induction).
2. A child may narrow a stricter parent decision (`REQUIRE_HUMAN → DENY`, Example 7.4's WO constraint) but never looser it (Examples 7.2–7.4).
3. Scope claims intersect downward (Example 7.3); no chain of claims can re-add removed resources.
4. Ceilings (`production.write`, `secrets.read`, `deploy.execute` capped at `REQUIRE_HUMAN`) hold regardless of how permissive any level tries to be.
5. Only a human, answering an `APPROVAL` interaction outside the hierarchy, can turn a `REQUIRE_HUMAN` instance into an `ALLOW` — single-use, instance-bound, recorded (§3.6, §5 stage 4).

## 8. Runtime enforcement points and the tier gate

1. **E3 scheduler gate** — `SchedulerPolicy.canAssign(task, workOrder)` is implemented as `check({ taskId: task.id, workOrderId: workOrder.id }, { capability: 'repo.write', resource: { branch: 'worktree-branch-of-task' } })`; `ALLOW` assigns, anything else leaves the Task in `READY` (the scheduler already renders `blockedPolicy`).
2. **Worker dispatch envelope** — every consequential worker-requested external action (`pr.create`, `deploy.execute`, `ci.run`, production access) passes `check` at the Factory before E6/adapter does I/O; the worker never holds the credentials (§12.3).
3. **E6 external side effects** — `openPR`, `merge`, promotion: each is a `check` call site; `merge` additionally requires Work Order `APPROVED` + the no-self-merge rule (the `APPROVAL` must reference a verifier identity different from the writer's — Writer ≠ Verifier ≠ Promoter, §12.1).
4. **E2 API endpoints** — consequential endpoints call `check` server-side under the operator's authenticated identity (§12.4).

### 8.1 Tier-gate matrix (stage 3 of `check`)

Rows = classified tier (§6.3), columns = capability sensitivity class (§4: low / medium / high). Cells = `tierFloor` (the minimum restrictiveness the tier demands for that class):

| Tier \ Sensitivity | low | medium | high |
|---|---|---|---|
| **GREEN** | `ALLOW` | `ALLOW` | `REQUIRE_HUMAN` |
| **YELLOW** | `ALLOW` | `ALLOW` | `REQUIRE_HUMAN` |
| **RED** | `REQUIRE_HUMAN` | `REQUIRE_HUMAN` | `REQUIRE_HUMAN` |

Applied as `tighter(fold, tierFloor)` the gate can only ever restrict (a fold of `DENY` stays `DENY`; a fold of `ALLOW` under RED becomes `REQUIRE_HUMAN`; a fold of `REQUIRE_HUMAN` anywhere stays so). Note the promotion path, not the individual capability check, is where the *Medium gate* bites: Yellow-tier `deploy.execute`/`pr.create` may be individually `ALLOW` per §4, but the Work Order's promotion still passes the mandatory `HUMAN_GATE` (§6.5), so no autonomous publication occurs without the opportunity for semantic review. High-risk (prod/auth/payments/PII/secrets) never auto-promotes because RED's floor is never below `REQUIRE_HUMAN` on any class, and promotion requires the operator's explicit `APPROVAL`.

## 9. Recovery contract (spec §18) — what `recover(failure)` and `emergencyStop()` must honor

Design constraints for `src/factory/recovery/recovery.ts`; no code here.

### 9.1 Failure classification (deterministic, no blind retry without it)

`FailureContext = { attemptId, taskId, workOrderId, failureClass, at, error, signal?, attemptCount, sameClassCount }`. Failure classes (closed enum, spec §18.2 "structured failure classification"; modeled on the spec §18.10 event vocabulary `MODEL_RATE_LIMITED / MODEL_QUOTA_EXHAUSTED / MODEL_AUTH_FAILED / MODEL_UNAVAILABLE`, which recovery also keys off):

`WORKER_FAILURE` | `VERIFICATION_FAILURE` | `DEPENDENCY_UNAVAILABLE` | `MODEL_RATE_LIMITED` (transient) | `MODEL_QUOTA_EXHAUSTED` (subscription exhausted) | `PROVIDER_OUTAGE` | `MODEL_AUTH_FAILED` | `MODEL_UNAVAILABLE` | `IDEMPOTENCY_DUPLICATE` | `CRASH_RECOVERY` | `UNKNOWN`

### 9.2 `recover(failure) → RecoveryAction`

```text
RecoveryAction =
  { kind: 'RETRY_NEW_ATTEMPT', reason, changedCondition }   // new Attempt, clean worktree (spec §18.4)
| { kind: 'REASSIGN', workerId? }                           // same work, different worker
| { kind: 'REPLAN', taskIds }                               // bounded replan via E3 (src/factory/planning/dag.ts guard)
| { kind: 'ESCALATE_HUMAN' }                                // spec §12 interaction; Task → WAITING_INPUT
| { kind: 'WAITING_RESOURCE', resource, retryAfterMs? }     // spec §18.10; NOT FAILED
| { kind: 'FAIL_WORK_ORDER' }
| { kind: 'NO_OP_DUPLICATE' }                               // idempotency (§9.6)
| { kind: 'HOLD' }                                          // e-stop active or manual pause: take no action
```

Class → default mapping (bounds in §9.4; an active e-stop ⇒ everything holds, §10):

| Class | First response | After bounds (§9.4) |
|---|---|---|
| `WORKER_FAILURE` | `RETRY_NEW_ATTEMPT` (new worker/attempt; a worker failure does **not** automatically fail the Task, spec §18.1) | `REASSIGN` → `REPLAN` → `ESCALATE_HUMAN` |
| `VERIFICATION_FAILURE` | preserve the Change Set; `RETRY_NEW_ATTEMPT` for bounded rework (`Attempt.failureHistory` grows; verifier never modifies implementation, spec §18.8) | `ESCALATE_HUMAN` / replan per rework count |
| `DEPENDENCY_UNAVAILABLE` | bounded exponential backoff + jitter; circuit opens on persistence (spec §18.9); only dependent operations block | `WAITING_RESOURCE` |
| `MODEL_RATE_LIMITED` | backoff + jitter within the Attempt budget | `WAITING_RESOURCE { retryAfterMs }` |
| `MODEL_QUOTA_EXHAUSTED` | no alternative routing unless the substitute satisfies the Work Order's pinned model-class requirement (cross-check E4's routing record + §6.1); affected capacity marked unavailable | `WAITING_RESOURCE` — **never** a silent cheaper-model downgrade |
| `PROVIDER_OUTAGE` / `MODEL_UNAVAILABLE` | circuit opens; affected capacity unavailable; substitute only if policy-equivalent, else wait | `WAITING_RESOURCE` |
| `MODEL_AUTH_FAILED` | never auto-retry credentials; degrade the worker/host | `ESCALATE_HUMAN` |
| `IDEMPOTENCY_DUPLICATE` | `NO_OP_DUPLICATE` | — |
| `CRASH_RECOVERY` | lease reconciliation (§9.3) | per finding |
| `UNKNOWN` | no blind retry: at most one bounded `RETRY_NEW_ATTEMPT` with the failure recorded, then escalate | `ESCALATE_HUMAN` |

### 9.3 Crash reconciliation (spec §18.3) — the lease path

On Factory restart the recovery engine must (in order): load durable state → load event history → identify `RUNNING` Attempts → reconcile worker leases → reconnect where the worker is still live (adapter `status`) → otherwise interrupt/recover → retry/replan/escalate per §9.2. Concretely against E3 leases: a `WorkerLease` is *valid* iff `expiresAt > now` and the worker's adapter reports healthy — reattach and continue collecting. If the lease is expired **or** the worker is unreachable (spec §18.5: heartbeat ≠ progress ≠ completion): the Attempt gets `outcome: 'interrupted'` + a `failureHistory` entry (never `success` — E3 already refuses SUCCESS without completion evidence; that gate stays mandatory), the assignment closes, and recovery proceeds — default: new Attempt, clean worktree (spec §18.4), with the failed Attempt's diff/artifacts preserved as evidence.

### 9.4 Boundedness — no blind universal retry

- **Per-class retry budget:** default max **2** automatic retries for the *same* failure class on the same Task (deployment-configurable; stamped into the decision record).
- **Per-Task attempt budget:** default max **3** total Attempts per Task (counted from the `attempts` projection of `failureHistory`, not from in-memory state).
- **Changed-condition requirement:** every automatic retry must name a `changedCondition` (new worker, restored resource, new code baseline via clean worktree). Identical failure signature + no changed condition ⇒ no auto-retry ⇒ `REPLAN`/`ESCALATE_HUMAN`.
- Repeated failures are **signals** (spec §18.2): they feed replanning/escalation, never an unbounded loop.

### 9.5 WAITING_RESOURCE semantics (spec §18.10)

- Quota/subscription exhaustion **with a pinned escalation model** (the Work Order requirement pins a model *class* — a generic capability identifier per ADR 13, never a vendor model ID in runtime semantics): affected capacity is marked unavailable and the Attempt records `outcome: 'waiting_resource'` + event (`MODEL_QUOTA_EXHAUSTED`); the Task is **blocked in place, not FAILED**; recovery re-opens a new Attempt when capacity returns.
- Alternative routing is allowed **only** when the substitute satisfies the Work Order's policy and capability requirements (verified against the routing record + the classified tier) — otherwise it is a policy `DENY` for the routing change until a human changes the Work Order requirement. No silent downgrade when a specific model class is required.
- v0.1 note (E1 vocabulary tension, flagged to the controller): E1's `Task` state vocabulary has no `WAITING_RESOURCE` state. The contract here fixes the representation: **Attempt `outcome: 'waiting_resource'` + durable event; Task stays `RUNNING` with no live worker and the lease released**. The recovery engine — not the scheduler's `assignPass`, which only picks `READY` tasks — re-opens it. Extending the spec §5.2 state machine is an E1 follow-up, out of scope here.

### 9.6 Idempotency (spec §18.7)

- Every recovery action carries a durable idempotency key `recover:{attemptId}:{k}` (`k` = `failureHistory.length` at decision time). Duplicate deliveries of the same key are `NO_OP_DUPLICATE` — never duplicate Attempts, never unsafe duplicate actions.
- Non-repeatable external side effects (deploys, PRs) execute only through the capability-checked path (which already requires `ALLOW`); recovery never bypasses a policy check.

### 9.7 Evidence-preservation invariants (all paths)

- `CANCELLED`, `FAILED`, `INTERRUPTED` remain **distinct** Attempt outcomes (spec §18.6/§18.3); an interrupt is never reported as a failure and never as a success.
- No execution is considered successful without completion evidence (E3's `hasEvidence` gate stays mandatory in every recovery path).
- Every verification run and every failed Attempt's diff/artifacts remain immutable evidence (spec §18.8).

## 10. Factory-level controls: pause / resume / emergency-stop

`emergencyStop()` contract (state = durable flag + `factory.emergency_stopped` / `factory.resumed` events, aggregate `'factory'`):

1. **Durable, idempotent state change:** set the e-stop flag (store + event); repeated invocations are no-ops.
2. **Blocks new assignments and provisioning:** the scheduler's `assignPass`/`provisionPass` become no-ops (policy gate at the top of `tick`).
3. **Blocks external side effects:** every `check` short-circuits through stage 1 (§5) — `DENY` for consequential external actions while stopped.
4. **Graceful first, forceful second (spec §18.6):** request worker cancellation (adapter cancel), hold a bounded grace window, then force-stop; the Attempt records `outcome: 'interrupted'` with preserved diff/artifacts. Nothing is destroyed (spec §18.11: e-stop blocks assignments/provisioning/side effects, requests graceful cancellation, **preserves state/evidence**); it does not blindly kill everything. v0.1 note: E1's Task/Work Order vocabularies have no `CANCELLING`/`CANCELLED` states; Tasks stay `RUNNING` and are reconciled through the §9.3 lease path on resume. (Vocabulary extension flagged to the controller as a deferred E1 item.)
5. **Requires explicit human resume:** a `resume()` carrying operator identity (recorded) is the only way out; no timer auto-resumes. On resume, run §9.3 reconciliation over the interrupted set.

## 11. Policy source of truth (spec §13.2) — versioned YAML

- Long-term source of truth: **versioned YAML**; the Factory Client provides a UI/editor over the same configuration.
- v0.1 MVP: the §3–§10 semantics ship as **embedded defaults in code** (the §4 table + §8.1 matrix); an optional YAML override loader is #23's stretch scope. Every `policy_decision` carries `policyVersion: '<embedded>' | yaml-hash` either way, so audit trails never mix policy versions.
- Shape (normative sketch; #23 aligns exactly if implementing the loader — and the examples of §7 assume exactly these values):

```yaml
# policy.yaml — policyVersion 1
organization:
  capabilities:
    repo.write:  { decision: allow, scope: { branchPattern: "wo-*/**", excludePaths: ["infra/**"] } }
    pr.create:   { decision: allow }
    ci.run:      { decision: allow }
    deploy.execute: { decision: require_human, scope: { env: production } }   # staging allow lives at project level
    production.read: { decision: require_human, scope: { dataClass: customer-data } }
    production.write: { decision: deny }
    secrets.read: { decision: deny }
  ceilings: { production.write: require_human, secrets.read: require_human, deploy.execute: require_human }
projects:
  client-portal:
    capabilities:
      repo.write: { decision: allow, scope: { includePaths: ["src/**", "docs/**"] } }
      deploy.execute: { decision: allow, scope: { env: staging, branchPattern: "release/**" } }
      production.read: { decision: deny }
workOrders: {}      # per-WO narrowing written at creation from the WorkOrder constraints
tasks: {}
```

## 12. Production / security / auth threat model (MVP)

### 12.1 Trust boundary and principals

```text
                ┌─────────────────────────── Factory Server process (trusted) ───────────────────────────┐
                │  E1 durable state + append-only log   E7 policy/risk/recovery   E6 sole external actor   │
                └──────┬───────────────┬──────────────────────────┬─────────────────────────────────────┘
   Worker adapters     │               │ Client UI (operator)     │ GitHub API (PAT, server-side only)
   (Herdr; per-task    │               │                          │
    worktrees running  │               │                          │
    LLM agent code)    │               │                          │
```

- **Inside the boundary (trusted):** the Factory Server process itself — the only writer of `StateStore`/event-log rows; E6 the only GitHub caller.
- **Outside (untrusted):** worker processes executing model-generated code (per-task worktrees scope the blast radius); LLM output (text is untrusted input, never policy authority — ADR 13's separation of recommendation from execution); GitHub events; the Client UI network path; anything a worker asks the Factory to do.
- **Principals:** the Operator (the v0.1 auth subject), Worker agents (write-into-worktree only, via lease), the Verifier (independent of the writer — Writer ≠ Verifier ≠ Promoter), the Promoter/merger (E6, acts only on `APPROVED` + `ALLOW`), and the human approver (answers `APPROVAL` interactions; identity recorded on the interaction and the consumed `policy_decision`).

### 12.2 Who may call what

| Caller | May | May not |
|---|---|---|
| Worker agent (via adapter) | request transitions, QUESTION → `WAITING_INPUT`, propose lifecycle changes | apply state transitions; touch GitHub directly; hold repo/GitHub credentials; approve its own work (spec §5.1: "Agents cannot approve their own work"); read secrets |
| Scheduler passes | assign via `policy.canAssign` | bypass the policy check |
| E6 adapter | `openPR`/`merge` only after `check` (+ `APPROVED` for merge) | merge without `APPROVED` **and** `ALLOW`; self-merge (verifier ≠ writer) |
| Operator (Client) | everything an explicit identity can do: create/transition Work Orders, answer `APPROVAL`s, pause/resume/e-stop, edit the policy YAML | widen policy silently — hierarchy edits are versioned and every change is a recorded human action |
| Model providers | return completions | grant any authority (ADR 13: recommendations never execute) |

### 12.3 Secrets handling

- Credentials (GitHub PAT, provider keys) live in deployment environment configuration, injected server-side; never in SQLite rows, event payloads, logs, worker contexts, or prompts.
- `secrets.read` for workers is `DENY` by default (§4); an approved instance (if ever) is **human-brokered** — the operator binds the secret at the boundary (env-injection into the worker host); the *value* never transits policy records, events, or transcripts.
- `policy_decisions`/events store capability + resource *class*, never raw secret material; log redaction of `.env`/token/key patterns is a hard requirement in artifact writers.

### 12.4 MVP auth/authorization assumptions (explicit)

- **Single-operator deployment.** The Factory Server API (E2) is assumed to run on a trusted network (localhost/operator machine). Requests are authenticated as the operator (bearer token or local socket). No multi-tenant RBAC in v0.1 — deferred; identity fields already carried on interactions/decisions support later enforcement.
- Workers authenticate with provisioning-issued worker identities (E3 `WorkerRecord.id`); the Factory distrusts their *content*, not their transport.
- Human approvals require the operator identity inside the `APPROVAL` response; unauthenticated answers are rejected.
- The GitHub PAT scope is least-privilege per target repo (`contents:write` + PRs); rotation is an ops runbook item, out of code scope in v0.1.

### 12.5 Threats → controls (STRIDE-lite)

| Threat | Vector | Control |
|---|---|---|
| Prompt-injected/rogue agent requests a destructive action (`deploy.execute`, `production.write`) | worker instruction channel | §4 ceilings + runtime `check` before any external side effect; `REQUIRE_HUMAN`/`DENY`; the worker never holds credentials |
| Secret exfiltration via worker context/artifacts | reading `.env`/keys, writing them into diffs or logs | `secrets.read: DENY` default; redaction in artifact writers; brokered human binding only (§12.3) |
| Malicious/buggy PR reaching the default branch | unverified merge | promotion only via Evidence Bundle + `HUMAN_GATE` (`APPROVED`); E6 merges only `APPROVED` + `ALLOW`; no self-merge (§8-3) |
| Widening of authority by a compromised lower policy level | policy YAML/state edit | monotonic fold (§3.4): widening is inert; ceilings sit outside the hierarchy; policy edits require operator action and are version-stamped |
| State/log tampering | direct SQLite access | append-only `events` (DB-enforced triggers, WAL); the Factory process is the sole writer; policy decisions are durable events (§5.1) |
| Duplicate recovery side effects | redelivery / double dispatch after crash | §9.6 idempotency keys; spec §18.7 duplicate-delivery rules |
| Crash claims phantom success | reconciliation bug | §9.3: success only with completion evidence; leases reconciled on restart |
| Quota exhaustion silently downgrades a pinned model | routing fallback | §9.5: the substitute must satisfy the WO's pinned requirement, else `WAITING_RESOURCE` |
| Unaudited emergency action | operator misuse | e-stop/resume are durable events carrying operator identity; e-stop itself preserves all evidence (§10) |
| Untrusted network exposure of the E2 API | deployment | explicitly out of MVP scope (§12.4); the trusted-network assumption is documented, not enforced |

## 13. Open items deferred (recorded, not solved here)

1. E1 state-machine extension for `CANCELLING`/`CANCELLED` (spec §18.6) and a `WAITING_RESOURCE` representative — flagged in §9.5/§10; the E7 contract above works unchanged against today's vocabulary.
2. Multi-tenant RBAC and network hardening of E2 — out of MVP (§12.4).
3. The policy YAML loader + Client editor (§11) — runtime defaults are authoritative in v0.1.
4. The earned-Green ledger UI (§6.4) — the durable record exists; the Client affordance is future work.
