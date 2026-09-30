# Policy and Risk Model (E7.1)

- **Status:** Accepted design for Factory Server v0.1 policy/risk + recovery (epic `coderhd/factory#7`, sub-issue `coderhd/factory#22` [E7.1])
- **Decision record:** [ADR 14 — Policy is monotonic-narrowing down Org→Project→Work Order→Task; sensitive actions are runtime-checked](../decisions/adr-14-monotonic-policy-and-risk.md)
- **Authority:** design spec §12 (Interaction / QUESTION), §13 (Risk and Policy; §13.1 Risk Tiers, §13.2 Policy), §18 (bounded recovery, idempotency, quota/emergency controls); plan `docs/superpowers/plans/2026-09-29-factory-server-v01.md` Task 6 (E7). Spec citations are always prefixed "spec §"; bare "§N" cites this document.
- **Implements against (existing code):** E1 `src/factory/state/store.ts` (`policy_decisions` collection, `StateStore`, `EventLog`), `src/factory/domain/workOrder.ts` (`RiskTier` = `GREEN | YELLOW | RED`, `Attempt.failureHistory`), E3 `src/factory/scheduler/scheduler.ts` (`PolicyVerdict`, `SchedulerPolicy.canAssign`), `src/factory/workers/manager.ts` (`WorkerLease { attemptId, taskId, expiresAt, renewedAt }`), E3 `src/factory/planning/dag.ts` (DAG propose/validate/commit — replan mechanics; the bound is E7's, §9.2)
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
escalateFor(capability, resource) -> GREEN | YELLOW | RED       (check-time observation tier, §6.3 stage-3 input)
recover(failure)            -> RecoveryAction                   (§9.2)
emergencyStop()             -> void  (+ factory pause/resume)   (§10)
```

- `check` is the enforcement entry point: it *evaluates* (a pure function, §5's `evaluate()`) and then *records* durably under the write rule of §5.1. `classifyRisk(wo)` and `escalateFor(capability, resource)` are both pure; only `check` and the durable tier ratchet it triggers (§6.3) write.
- `subject` (`TaskRef`) = `{ taskId: string; workOrderId: string } | { taskId: null; workOrderId: string }`. Task-scoped checks call `check({ taskId, workOrderId }, action)` — the plan's `check(task, action)` shape; Work-Order-scoped actions (e.g. the E6 merge gate) pass `taskId: null`.
- **Consumes:** E1 `StateStore` (especially the `policy_decisions` collection) and `EventLog`; E3 `WorkerManager` leases (`listWorkers()`, `WorkerLease.expiresAt`) for crash reconciliation; E4 `RoutingDecisionRecord` for the no-silent-downgrade cross-check in §9.5.
- **Produces (durable):** `policy_decisions` rows + `policy.decision` events (§5.1); `RecoveryAction` records (§9.2).
- **Gates (call sites):** E3 scheduler `canAssign` (`repo.write` on the task's worktree branch, assignment), E2 API consequential endpoints, E6 — `openPR` checks `pr.create`; **`merge`/promotion checks `deploy.execute { env: production }`** (merge only on Work Order `APPROVED` **and** the consumed policy `ALLOW`, §8-3), worker dispatch envelopes.

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
5. **Ceilings sit outside the hierarchy, and bind per matched dimension.** Each capability carries a fixed ceiling — the most permissive decision *any* policy level may express **for the facets the ceiling scopes** (§4, last column: for `deploy.execute` and `production.read` the ceiling is deliberately scoped to `env: production` / `dataClass: customer-data`; elsewhere the capability's own ordinary rules apply, so a staging `ALLOW` under a production `REQUIRE_HUMAN` ceiling is legal, not a violation). No Organization/Project/WO/Task policy may express a decision more permissive than the ceiling on any facet the ceiling covers, and the ceiling is not itself subject to hierarchy resolution; it is a property of the deployment.

   **Over-ceiling handling.** Two enforcement moments, both specified:
   - **Load time (sources #23 parses at startup):** a policy source (YAML override, §11) whose expression exceeds a ceiling is **rejected** — the loader refuses the file and the Factory keeps the previous policy. Over-ceiling authoring is a configuration error, not a runtime event.
   - **Evaluation time (levels that arrive from durable state, e.g. WO-scoped policy written at creation):** an over-ceiling expression is **coerced down to the ceiling** before the fold, and the decision's `rules` trail records `ceiling-violation` on the offending level's contribution (in addition to the `widening-attempt` marker of §3.4, which the coercion almost always also triggers). Coercion is never silent: the marker is part of the audit contract.

   The two moments agree: anything load-time validation would reject is, at evaluation time, coerced rather than trusted — a dynamic level can never launder an out-of-policy grant into effect.

### 3.4 Why a child cannot widen a parent (proof)

Theorem: for every capability `c`, scope `s`, and chain Org → Project → WO → Task, `restrictiveness(effective(Task)) ≥ restrictiveness(effective(parent of Task))`, with restrictiveness ranked `ALLOW < REQUIRE_HUMAN < DENY`.

*Proof.* By rule 3.3-2, `effective(child) = tighter(effective(parent), own(child))`. From the definition, `tighter(a, b) ∈ {a} ∪ {something stricter than a}`, hence `restrictiveness(effective(child)) ≥ restrictiveness(effective(parent))`. Scoping: by rule 3.3-4, `scope(child) = scope(parent) ∩ own(child) ⊆ scope(parent)`. By induction on chain length the property holds from the root through every level. `ALLOW` can survive to a Task only if the whole chain above never expressed `REQUIRE_HUMAN`, `DENY`, or a narrower scope for that `(capability, scope)` — a child cannot manufacture it. ∎

**Ceilings and the proof.** The theorem covers parent→child relations. Ceilings add a horizontal invariant over the whole chain: for every `(capability, facet)` the ceiling covers, `restrictiveness(effective(level)) ≥ restrictiveness(ceiling)` at **every** level, because over-ceiling expressions are coerced to the ceiling before the fold (§3.3-5) and `tighter` then never relaxes the coerced floor. This is why a root-level default of `ALLOW` for `deploy.execute` at `env: production` cannot survive either — it is coerced to `REQUIRE_HUMAN` and marked `ceiling-violation` before hierarchy resolution even begins. The proof's substitution `own(child) → tighter(ceiling, own(child))` is what #23 implements.

Two consequences, both ported by #23 to `tests/factory/e7-policy.test.ts`:

- **Narrowing is legal at every level and kind:** `ALLOW → REQUIRE_HUMAN`, `ALLOW → DENY`, `REQUIRE_HUMAN → DENY`, scope-set shrinking.
- **Widening is inert, not an error:** a descendant expressing a *looser* decision simply loses the fold (the parent's stricter decision wins). v0.1 records the attempt in the decision's `rules` trail as `widening-attempt` provenance — recorded, not fatal. **Over-ceiling expression is the one widening that is not merely inert:** it is coerced to the ceiling and separately marked `ceiling-violation` (§3.3-5), because the ceiling — unlike a parent decision — must hold against every level, including the root's own defaults being misconfigured.

### 3.5 Policy dimensions (spec §13.2)

Every grant may be scoped by the six spec §13.2 dimensions — **repository, path/resource, action (the capability), data, environment, reversibility**. v0.1 concretely supports: path patterns (`src/**`), branch patterns (`wo-*/**`), environment (`staging` | `production`), data class (`synthetic` | `customer-data`), reversibility class (§4). Unmodeled dimensions are treated as unscoped (the parent's scope is unchanged).

### 3.6 The hierarchy cannot be widened by anything inside it

Only two things sit above the hierarchy, and both are outside it by design:

1. **Ceilings** (§3.3-5) — deployment-fixed.
2. **A human decision** (an `APPROVAL` interaction answered by an operator, spec §12) — humans are not a policy level in the chain; an operator approval *consumes* a `REQUIRE_HUMAN` verdict instance (§5, stage 4) and is recorded as evidence. A child policy never inherits an approval as authority to widen: approvals are single-use and instance-bound (`taskId` + `capability` + resource binding + `attemptId`), never reusable as a standing grant.

## 4. Capability list (all nine from spec §13.2) — fixed semantics

Columns: the decision at root when silent everywhere (`Default`), the per-capability ceiling (`Ceiling` — most permissive decision any level may express **for the facet(s) the ceiling scopes**, per §3.3-5; scoped ceilings state that facet), the sensitivity class used by tier gates (§8.1), reversibility. The four capabilities the sub-issue names explicitly (`repo.write`, `pr.create`, `deploy.execute`, `secrets.read`) are starred.

| Capability | Gates | Default (root) | Ceiling | Sensitivity | Reversibility | Notes |
|---|---|---|---|---|---|---|
| `repo.read` | Reading repository content by a worker (checkout, file reads, diff reads) | `ALLOW` (unscoped) | `ALLOW` | low | read-only | Subject to path denies (e.g. `.env*`); never logs secret material (§12.3). |
| `repo.write` ★ | Writing code in a repository context (attempt diffs, worktree commits) | `ALLOW` with scope `{ branchPattern: "wo-*/**" }` (Factory worktree branches only) — anything else (default branch, outside worktree) resolves `DENY` via the scope | `ALLOW` | medium (auto risk bump when the resource path matches the security taxonomy, §6.3) | reversible per worktree (clean-worktree recovery, spec §18.4) | v0.1: the Factory creates per-task worktrees (E3); direct writes to the default branch or outside a task worktree are outside the root scope. |
| `branch.create` | Creating branches (`push` of a new ref) in the project repo | `ALLOW` scoped to the Factory prefix `wo-*/**` | `ALLOW` | low | reversible (delete branch) | Branch deletion and default-branch writes are not granted by any v0.1 capability and are outside every scope. |
| `pr.create` ★ | Opening/updating a pull request (E6 adapter) | `ALLOW` | `ALLOW` | medium | reversible (close PR) | Non-destructive and visible; gated at Yellow tier *before promotion/merge*, not before creation (§8.1 note). |
| `ci.run` | Triggering CI runs (PR checks) | `ALLOW`, bounded | `ALLOW` | medium | cost-only | Bounded by retry budgets (§9.4); no unbounded standalone workflow triggering. |
| `production.read` | Reading production systems/data | `REQUIRE_HUMAN` when `dataClass: customer-data`; `ALLOW` for `synthetic`/staging reads | `REQUIRE_HUMAN` (scoped: `customer-data` reads only) | high (PII) | read-only | Reading real customer data requires a human-brokered approval (§12.3); PII never lands in events/artifacts. The ceiling does not forbid the default's `synthetic`/staging `ALLOW` — binding per matched dimension (§3.3-5). |
| `production.write` | Mutating production systems/data directly | `DENY` | `REQUIRE_HUMAN` | high | **irreversible** | Ceiling is `REQUIRE_HUMAN`: even an explicitly granted deployment can never express bare `ALLOW`. |
| `deploy.execute` ★ | Executing a deployment to an environment | `REQUIRE_HUMAN` for `env: production`; `ALLOW` for `env: staging` | `REQUIRE_HUMAN` (scoped: `env: production` only) | high | treat prod as irreversible | The ceiling caps production expressions per §3.3-5, so the default's staging `ALLOW` is coherent with it. v0.1 production callers: the E6 `merge`/promotion path only — merge is a `deploy.execute { env: production }` check (§8-3), which is why it floors at `REQUIRE_HUMAN` for **every** tier (high sensitivity, §8.1): even a fully earned-Green Work Order cannot auto-merge. |
| `secrets.read` ★ | Any worker access to secret material (tokens, keys, credentials, `.env` values) | `DENY` | `REQUIRE_HUMAN` | high | n/a (read-of-secret) | Ceiling `REQUIRE_HUMAN` **and** brokered: even an approved instance never hands plaintext to a worker — the human binds the value at the boundary (§12.3). v0.1 default (and effective practice): outright `DENY` to all workers. |

Rules of the table:

- **Default-deny for sensitive capabilities.** `production.*` and `secrets.read` default to their ceilings or `DENY`; silence never opens them.
- **Ceilings bind per matched dimension (§3.3-5).** A ceiling does not forbid a more permissive decision on facets outside its scope (`deploy.execute { env: staging }` under the production `REQUIRE_HUMAN` ceiling is legal); it forbids any level from expressing a decision more permissive than the ceiling on the facets the ceiling covers. Over-ceiling expressions are rejected at load time and coerced to the ceiling (marked `ceiling-violation` in `rules`) at evaluation time.
- **Capabilities not in this list do not exist** (closed vocabulary, like E4's fixed `RouteInput` vocabulary). A check for an unknown capability is a `DENY` with `rules: ['unknown-capability']`.
- **An absent grant is not an implicit `ALLOW`** except where this table's `Default` says `ALLOW` for low-risk read-side capabilities; otherwise silence resolves through §3.3-1/§3.3-3 to the restrictive default.

## 5. Decision semantics — exactly when each verdict is returned

`check(subject, action) → PolicyVerdict` is **evaluated** as a pure function (`evaluate()`) over: the resolved policy chain for `subject.workOrderId`'s project, the E1 `WorkOrder` (the declared `riskTier` for the tier gate; `constraints`/WO-scoped policy for chain resolution), the human-approval ledger, and `action = { capability, resource? }`. The public `check` = `evaluate()` + the write rule of §5.1 (durably recording the verdict, idempotently). Stages, in order; **the composition is monotone** — stage 1 may short-circuit to `DENY`, stages 2–3 may only make the verdict stricter, and stage 4 is the single sanctioned relaxation (consumption of a human approval), which only ever consumes a `REQUIRE_HUMAN`:

1. **Emergency-stop gate.** If the Factory is in e-stop (§10) and `action` is a **consequential external action**: return `DENY`, `resolvedBy: 'e-stop'`. The set is defined by a rule, not an enumeration: **every capability whose exercise produces a durable effect outside the task's worktree** — i.e. everything that mutates externally — is `repo.write` scoped outside the task worktree, `branch.create`, `pr.create`, `ci.run`, `deploy.execute`, `production.write`, `secrets.read`. When the Factory is stopped, no new external effect of any kind is acceptable; reads inside the task worktree are work, not side effects, and stay available. Exempt (read-only, no external mutation — still subject to all other stages, incl. e.g. the `customer-data` ceiling): `repo.read` and `production.read`. Questions/interactions are not blocked by e-stop (§10).
2. **Chain resolution (§3).** Fold Org → Project → WO → Task decisions and scopes for `(action.capability, action.resource)` with `tighter`; an explicit `DENY` anywhere on the matched scope settles the fold at `DENY`; silence + absent grants fall to the §4 `Default`.
3. **Tier gate (§8.1).** Fold the effective tier as `tighter-tier(classifyRisk(wo), escalateFor(action.capability, action.resource))` (§6.3) and apply `tighter(fold, tierFloor(effectiveTier, sensitivityClass))` — the tier gate can only restrict, never relax; e.g. any `RED`-effective Work Order ⇒ floor `REQUIRE_HUMAN` on every sensitivity class.
4. **Human-approval consumption.** If the standing verdict is `REQUIRE_HUMAN` and a recorded, unspent, instance-matching `APPROVAL` interaction exists (same `taskId`, `capability`, resource binding, `attemptId`; §5.2): return `ALLOW`, `resolvedBy: 'human-approval'` — and spend the approval in the same transaction that records this decision (§5.2). A matching approval **never** overrides a `DENY` — overriding a denial means changing the policy (an operator action outside the hierarchy), not answering a gate.

Exact meaning of each verdict, restated as the contract #23 implements and tests:

- **`ALLOW`** — the action may proceed under Factory orchestration **now**, with the narrowed scope in force (the `rules` trail carries the org/project/WO/Task rule ids that produced it). It is the *only* verdict under which the scheduler assigns (E3 `canAssign === 'ALLOW'`) and the only verdict under which E6 performs external effects (§2).
- **`DENY`** — the action is refused, durably and non-negotiably at runtime. An explicit `DENY` at any level on the matched scope always produces `DENY`; unknown capabilities produce `DENY`; e-stop produces `DENY` for consequential external actions.
- **`REQUIRE_HUMAN`** — the action is blocked from autonomous execution pending an operator decision through the spec §12 interaction system. Recording the verdict also creates or reuses the request: an `APPROVAL` interaction record (`ApprovalRecord`, §5.2 — distinct from the `QUESTION` records E3 already writes into the same `interactions` collection), carrying the action binding and context, one per distinct action instance (created only when no unspent one exists for the binding, §5.1). It is **not** a failure and **not** `DENY`: the Task parks (`WAITING_INPUT`, spec §12) and does not consume recovery budget (§9.4).

**Absent grant** (capability never mentioned anywhere on the chain): resolve via §4 `Default` — low-risk read-side capabilities inherit a permissive default; sensitive ones resolve restricted. An **unscoped action** (no resource binding) evaluates against the unscoped fold; capabilities whose root scope requires a binding (e.g. `deploy.execute` needs `env`) resolve `REQUIRE_HUMAN`/`DENY` rather than guess. **Unknown** capability: `DENY`.

**Composition of the three decisions down the hierarchy** is exactly §3.3: `tighter` fold, silence inherits, scopes intersect, ceilings cap, defaults at root. `REQUIRE_HUMAN` sits between `ALLOW` and `DENY` in every fold.

### 5.1 Durable decision records — the write rule (spec §13.2)

**Write rule.** `check` is invoked on hot paths — E3's `canAssign` runs per `READY` Task per assign pass (scheduler.ts) — so a naive "persist on every call" would emit a fresh audit row per scheduler tick for every parked Task. Therefore:

- **The stage 1–4 pipeline is `evaluate()`**: pure, no writes. `check()` = `evaluate()` + `recordIfSignificant()`.
- **`recordIfSignificant()` persists a `PolicyDecisionRecord` only when the decision instance's verdict is significant:** a prior record for the *same decision instance* `(workOrderId, taskId, attemptId, action binding)` with an **identical verdict** ⇒ write nothing (the prior record stays the authoritative audit entry); a first evaluation or a **verdict change** ⇒ write the row + event. A parked RED Work Order therefore produces exactly one row + `policy.decision` event, not one per tick.
- **`REQUIRE_HUMAN` additionally creates/reuses the `ApprovalRecord`** (§5.2) in the same transaction as the decision row: created only when no unspent approval exists for the action binding, reused verbatim otherwise.
- **Transaction scope and failure mode.** The persisted set — decision row + `policy.decision` event (+ a created approval on park, + a spent approval on stage-4 consumption, + the §6.3 tier ratchet when it fires) is written in **one `store.db.transaction`** so state and log can never disagree (mirrors E1's `createWorkOrder` / E4's `persistRoutingDecision`). The verdict is returned only after commit: if the transaction throws, `check` propagates the error — the caller treats it as an error, not a verdict (E3 skips the Task this assign pass; the E6 call path aborts the side effect and reports failure). Because the write rule is idempotent and the transaction rolls back atomically, a retried `check` is safe and leaves no partial record.
- **Record shape** (`PolicyDecisionRecord`), carrying exactly the fields spec §13.2 requires (task, action, risk, decision, rules, policy version) plus v0.1 additions:
```text
PolicyDecisionRecord {
  id: string                 // pd_*
  task: string | null        // taskId (null for Work Order-scoped checks, e.g. merge)
  workOrderId: string | null
  attemptId: string | null   // binds this decision instance to one execution (part of the §5.1 dedup key)
  action: { capability, resource?: { path?, branch?, env?, dataClass? } }
  risk: 'GREEN' | 'YELLOW' | 'RED'     // effective tier at decision time (§6.3 fold)
  decision: 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN'
  rules: string[]            // matched rule ids + the narrowing trail org→project→wo→task
                             // (+ markers: 'unknown-capability', 'widening-attempt',
                             //  'ceiling-violation', 'escalateFor:<tier>', 'e-stop')
  policyVersion: string      // '<embedded>' or the YAML policy file hash (§11)
  resolvedBy: 'policy' | 'tier-gate' | 'human-approval' | 'e-stop'
  interactionId?: string     // when an APPROVAL consumed this verdict (stage 4)
  createdAt: string
}
```

### 5.2 The approval ledger — `ApprovalRecord` (the stage-4 contract)

Stage 4 consumes "a recorded, unspent, instance-matching approval". Unlike `PolicyDecisionRecord`, that ledger had no fixed shape — E3's scheduler writes `InteractionRecord`s hardcoded `type: 'QUESTION'` (scheduler.ts) and E1 does not constrain the `type` literal at write time. The contract: the policy engine records approvals in the **same `interactions` collection** as a separately discriminated document:

```text
ApprovalRecord {
  id: string                 // appr_*
  type: 'APPROVAL'           // discriminator (E3's records are 'QUESTION' — a QUESTION is never stage-4 consumable)
  workOrderId: string
  taskId: string | null      // null for Work-Order-scoped checks (e.g. merge)
  attemptId: string | null   // the Attempt the verdict instance belongs to (null for Work-Order-scoped checks, e.g. merge)
  binding: {                 // instance-matching keys (§3.6): all must match at consumption
    capability: string,
    resource?: { path?, branch?, env?, dataClass? },
  },
  question: string           // human-readable context shown to the operator
  workerId: string | null    // the awaiting worker identity (mirrors E3's interaction records)
  status: 'PENDING' | 'ANSWERED' | 'SPENT'
  response: null | {         // operator's answer via E2 (§12.4); identity required
    decision: 'APPROVAL' | 'DENY',
    actor: string,
    answeredAt: string,
    comment?: string,
  }
  spentAt?: string
  spentByDecisionId?: string  // the PolicyDecisionRecord that consumed this approval
  createdAt: string
  updatedAt: string
}
```

Semantics, fixed:

- **Who writes what.** *Creation*: the policy engine, when stage 3's standing verdict is the first `REQUIRE_HUMAN` for an unbound action instance (§5.1 write rule) — never E3. *Answer*: E2's answer loop (operator identity recorded): `response` set, `PENDING → ANSWERED`; an operator `DENY` settles the instance (further checks for the same instance stay `REQUIRE_HUMAN` with no new rows — the write rule dedups on the unchanged verdict). *Spend*: **the policy engine**, at stage-4 consumption — not E2, not recovery. The `status` field and the `spentAt`/`spentByDecisionId` pair are written by the consumer transaction.
- **Spend is a transaction, not a flag race.** Spend = set `status: 'SPENT'` + `spentAt` + `spentByDecisionId` **inside the one `store.db.transaction`** that also inserts the consuming `PolicyDecisionRecord` (`resolvedBy: 'human-approval'`, `interactionId`) and appends its event (§5.1). The consumption update is conditional on the record still being unspent; if two `check` calls race one approval, the conditional update fails for the loser, whose transaction rolls back without any row — the loser re-executes stage 4, sees the spent artifact, and returns `REQUIRE_HUMAN` (or the caller re-`check`s, landing on the winner's audited `ALLOW` lineage via `spentByDecisionId`). Net: exactly one consuming decision, exactly one durable "spend", never a double-execution of the gated action on two racing checks.
- **Instance-matching, restated operationally.** Consumable iff `binding.capability`, `binding.resource`, `workOrderId`, `taskId` and `attemptId` all equal the live check's. An approval granted for attempt N never carries to attempt N+1: a replanned attempt re-parks and re-asks, unless the operator answers the fresh instance. **Work-Order-scoped checks (e.g. `merge`) bind differently:** their `PolicyDecisionRecord` carries `taskId: null` and `attemptId: null`, so a WO-scoped approval is created with `taskId: null` **and** `attemptId: null` — `null` matching `null` exactly, an attempt-agnostic instance key. A null-attempt approval never matches an attempt-scoped check (any non-null `attemptId` fails equality against `null`), and vice versa: the two approval populations never cross-spend, so WO-scoped approvals stay consumable by the merge path regardless of which attempt's rework produced the diff.
- **Single-use on both answers.** An `APPROVAL` is consumed exactly once (stage 4); a `DENY` exhausts the instance; neither is a standing grant (§3.6). The next Attempt needs a fresh instance.

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

### 6.3 `classifyRisk(wo)` and check-time `escalateFor` — contract

The contract is deliberately split into a **durable** classifier and a **decision-time** escalator, because they have different inputs and different effects:

```text
classifyRisk(wo)                          = wo.riskTier     (durable tier, WO-only inputs)
escalateFor(capability, resource) → tier    = RED when the (capability, resource) facet hits the
                                              security taxonomy / prod / customer-data, else GREEN
```

Per decision, stage 3 of `check` (§5) folds the effective tier as `tighter-tier(classifyRisk(wo), escalateFor(...))` — `tighter-tier` is the tier analogue of `tighter`: it never lowers.

- `classifyRisk(wo) = wo.riskTier` — it reads exactly **one** Work Order field: the durable `riskTier` (declared at creation, §6.2, or raised afterwards only by the durable ratchet below or a human). There is **no WO-field inference in v0.1**: `classifyRisk` does not read `constraints`/`outOfScope`/acceptance-criteria text, and no `inferTier(wo)`-style inference exists — if #23 ever needs one, it must be a separately named function with its own audited contract, never folded into `classifyRisk`. WO fields like `constraints` and `outOfScope` still shape policy, but through **chain resolution** (the WO-scoped policy entries written at creation, stage 2, §3/§5), not through the tier classifier. `classifyRisk` takes no per-call `capability`/`resource` argument, because the durable controls it feeds (§6.5, §8.1) are Work-Order-level — execution constraints, verification mix, promotion rules — and must be stable for the WO, not swing from decision to decision; per-decision observation is `escalateFor`'s job.
- **The durable ratchet (defined here; referenced by §2, §5.1, and §6.4).** What raises the durable tier: an `escalateFor` observation on a **recorded** decision that is stricter than `wo.riskTier`. When one fires, the same transaction that records the decision (§5.1) raises `wo.riskTier` to the observed tier and appends a `risk.tier_changed` event + a `policy_decisions` row (`resolvedBy: 'policy'`) pointing at that decision as evidence. The ratchet is **monotone** (it only ever raises, never lowers — lowering is humans-only, §6.4) and **idempotent** (an observation at a tier the WO already holds changes nothing and writes no extra rows, per the §5.1 write rule). Per-decision `escalateFor` results that do **not** exceed the durable tier never fire the ratchet; they appear only on the decision's `rules` trail.
- `escalateFor(capability, resource)` — deterministic, no-LLM **check-time** observation scoped to one decision's action binding: hitting the **security taxonomy** (auth, secrets, payments, PII, prod infrastructure — v0.1: a pattern list declared in the deployment policy, patterns matched anywhere in the resource path, e.g. `**/auth/**`, `**/*password*`, `**/secrets/**`, `**/infra/prod/**` — so `src/auth/login.ts` matches `**/auth/**`) via the check's `action.resource` path ⇒ `RED`; prod-deploy or customer-data exposure ⇒ `RED`; anything else ⇒ `GREEN` (i.e. no escalation — the no-op sentinel — and the WO's own tier stands via the fold). This is what makes the promised risk bump actually fire: a YELLOW Work Order whose Task checks `repo.write` on `src/auth/login.ts` is floored exactly as a Red one **for that decision** (and durably, via the ratchet), even though `classifyRisk(wo)` alone returns YELLOW.
- **Monotonicity (the invariant #23 must test):** the **effective-tier fold** preserves the Work Order's floor — `tighter-tier(classifyRisk(wo), escalateFor(...))` is never below `classifyRisk(wo)`. Inference/observation can raise (`YELLOW → RED`), never lower. (`escalateFor` alone may return `GREEN`, the no-escalation sentinel, in which case the fold simply leaves the durable tier standing — it is the fold, not either operand alone, that carries this invariant.) Hence "high-risk never auto-promotes": once a Work Order is observed high-risk, no automatic path exists that treats it as lesser.
- **"Red never auto-promotes":** lifecycle promotion (§8-3) can never move a Red Work Order to `APPROVED → MERGED` autonomously — the §8.1 tier gate holds every consequential action at `REQUIRE_HUMAN` (at best), and `APPROVED` requires an explicit operator response at the `HUMAN_GATE`, recorded for non-repudiation.
- Tier **changes** are durable and human-visible: every automatic raise goes through the durable ratchet above; lowering is humans-only (§6.4); each change appends a `risk.tier_changed` event + a `policy_decisions` row pointing at the evidence, so no tier ever moves without a durable record.

### 6.4 "Green is earned after evidence" — the earn path

The tier-carryover mechanism (otherwise a Work Order could never be `GREEN` by right):

1. A Work Order deliberately executes at `YELLOW` with all its controls.
2. At `HUMAN_GATE`, the operator's `APPROVAL` response may additionally record **earned Green for a change class** = (project + capability class + path class) with pointers to: the complete `EvidenceBundle`, verification runs green, zero violation-caused `REQUIRE_HUMAN` escalations, zero widening attempts, and no high-sensitivity capability exercised in the class.
3. The record is durable (`risk.tier_changed` event + `policy_decisions`, `resolvedBy: 'human-approval'`). *Future* Work Orders may then be **declared** `GREEN` at creation **only** by referencing that record (`intent.riskTier: 'GREEN'` + earned-Green ledger reference), validated at creation (§6.2).
4. `escalateFor` (§6.3) can always re-raise a declared-`GREEN` Work Order to `RED`, decision-by-decision and then via the durable ratchet, when observed paths/data say so. Lowering is humans-only, evidenced, recorded.

### 6.5 Tier → required controls (spec §13.1, fixed mapping)

| Tier | Execution | Verification | Rework | Promotion/approval |
|---|---|---|---|---|
| **GREEN** (low) | autonomous | deterministic (required) | automatic rework allowed (bounded, §9.4) | promotion per policy: auto-`APPROVED` at `EVIDENCE_READY → HUMAN_GATE` **only if** the Evidence Bundle is complete, no high-sensitivity capability was used, and nothing requires semantic sign-off; otherwise the gate holds |
| **YELLOW** (medium) | autonomous with capability whitelist | deterministic + behavioral; semantic "where appropriate" — mandatory when the diff touches the security taxonomy or the WO declares `requiredVerification: semantic` | bounded rework | human approval before promotion: `HUMAN_GATE` mandatory; `MERGED` only after operator `APPROVAL` + policy `ALLOW` (E6) |
| **RED** (high) | **constrained**: approved capability + model list only (no silent model substitution, §9.5); high-sensitivity capabilities capped per §4 ceilings | deterministic + behavioral + **mandatory semantic & security verification** (independent verifier; writer ≠ verifier) | rework only within budget, then escalate | **explicit human approval; no automatic promotion ever** — the GREEN auto-promote path is unavailable by construction (the §8.1 tier gate escalates `ALLOW → REQUIRE_HUMAN`) |

## 7. Monotonic narrowing — worked examples (proof on paper)

Scenario: the §11 embedded defaults; Project `client-portal` narrows `repo.write` paths to `src/**`/`docs/**`, allows staging deploys on `release/**`, denies `production.read`; Work Order `wo-142` (Yellow, `client-portal`) narrows `branch.create` to `wo-142/*` and adds the constraint "no deploy in this WO" (`deploy.execute → DENY`); Task `t-7` is silent. Each example shows the fold per (capability, matched scope); traces are the `rules` trails #23 should produce.

### 7.1 Valid narrowing chain (worker writes a source file)

`check({ taskId: 't-7', workOrderId: 'wo-142' }, { capability: 'repo.write', resource: { path: 'src/auth/login.ts', branch: 'wo-142/impl' } })`

| Level | Expresses | Scope match | Fold after level |
|---|---|---|---|
| Organization | `ALLOW` | branch `wo-142/impl` ∈ `wo-*/**`; path ∉ `infra/**` | `ALLOW` |
| Project `client-portal` | `ALLOW` | path ∈ `{src/**, docs/**}` | `ALLOW ∩ {src/**,docs/**}` → `ALLOW` (scope stays non-empty) |
| Work Order `wo-142` | silent | — | `ALLOW` (inherited) |
| Task `t-7` | silent | — | `ALLOW` |

Chain fold = `ALLOW` → tier gate: `classifyRisk(wo-142) = YELLOW` (the durable claimed value), but `escalateFor('repo.write', { path: 'src/auth/login.ts' }) = RED` — the resource path hits the security taxonomy pattern `**/auth/**` (§6.3) — so the **effective tier** is `tighter-tier(YELLOW, RED) = RED` ⇒ floor `REQUIRE_HUMAN` ⇒ **`REQUIRE_HUMAN`**. Note where the RED comes from: not from criteria-text inference (there is none in v0.1 — `classifyRisk(wo) = wo.riskTier`, and wo-142's declared tier is YELLOW); it comes from the check-time escalation on the matched resource, via the effective-tier fold — and, because it exceeds the durable tier, the same transaction **ratchets** `wo-142.riskTier` up to `RED` durably (§6.3). The Task parks pending a human approval; the approval (once granted) makes this instance `ALLOW`. Narrowing worked exactly as designed; the tier gate then *tightened* it — no stage relaxed anything.

### 7.2 Attempted widening #1 — a Task tries to unlock secrets

A Task-level policy entry claims `{ capabilities: { 'secrets.read': { decision: allow } } }`.

| Level | Expresses | Fold after level |
|---|---|---|
| Organization | `DENY` (root default, ceiling `REQUIRE_HUMAN`) | `DENY` |
| Project / WO / Task | Task says `ALLOW` | `tighter(DENY, ALLOW) = DENY` |

Verdict: **`DENY`**, `rules: ['org:secrets.deny', 'task:allow@ceiling-violation', 'task:allow@widening-attempt']`. The child's `ALLOW` is doubly inert: it exceeds the `REQUIRE_HUMAN` ceiling (`ceiling-violation`, §3.3-5) and it loses the fold to the parent's `DENY` (`widening-attempt`, §3.4). Recorded provenance flags both.

### 7.3 Attempted widening #2 — scope widening via the intersection

The Work Order tries to grant `repo.write` on `infra/**` (claiming "we own this repo too").

| Level | Scope for `repo.write` | Fold after level |
|---|---|---|
| Organization | branch `wo-*/**`, exclude `infra/**` | scope = `{branch: wo-*/**, paths: ¬infra/**}` |
| Project | include `{src/**, docs/**}` | scope = `{branch: wo-*/**, paths: {src/**,docs/**} ∩ ¬infra/**}` |
| Work Order | claims paths `{src/**, infra/**}` | **intersection**: `{src/**} ∩ ¬infra/**` = `{src/**}` under branch `wo-*/**` |
| Task | inherits | unchanged |

`check(…, { capability: 'repo.write', resource: { path: 'infra/main.tf', branch: 'wo-142/impl' } })` → no scoped grant covers `infra/**` (Org exclude ∩ WO claim removes it) ⇒ **`DENY`**. The claimed scope set intersected with the parent's scope can never exceed `scope(parent)` (§3.4) — widening by resource claim is impossible.

### 7.4 Attempted widening #3 — a Task tries to unlock production deployment

`wo-142`'s **Task-level** entry claims `deploy.execute: ALLOW` with `env: production`. (Who expresses what, once and unambiguously: the **Task** claims `ALLOW@production`; the **Work Order** declares `DENY` — its "no deploy in this WO" constraint; the **Project** grants `ALLOW` scoped `{env: staging, branchPattern: release/**}` — staging only; the **Organization** default is `REQUIRE_HUMAN` for `env: production`, which is also the ceiling for production deploys, §4.)

| Level | Expresses (on facet `env: production`) | Fold after level |
|---|---|---|
| Organization | `REQUIRE_HUMAN` (default; ceiling-scoped to production, §3.3-5) | `REQUIRE_HUMAN` |
| Project | *(silent on the production facet — its `ALLOW` is scoped `env: staging`)* | `REQUIRE_HUMAN` (inherited) |
| Work Order | `DENY` ("no deploy in this WO" constraint) | `tighter(REQUIRE_HUMAN, DENY) = DENY` |
| Task | claims `ALLOW` | **coerced to `REQUIRE_HUMAN`** (`ceiling-violation`, §3.3-5); then `tighter(DENY, REQUIRE_HUMAN) = DENY` |

Verdict for `{ capability: 'deploy.execute', resource: { env: 'production' } }`: **`DENY`**, `rules: ['org:deploy.require-human', 'wo:no-deploy@DENY', 'task:allow@ceiling-violation', 'task:allow@widening-attempt']`.

Two things are worth separating, because they answer the two natural objections:

- **Without the WO's `DENY` constraint**, the fold for production would settle at `REQUIRE_HUMAN` (org) — the Task's claim, coerced to the production ceiling, loses the fold and the best it could produce is the human gate its ancestors already required. Bare production `ALLOW` is unreachable by every level: the ceiling caps it *for the production facet only*, which is why the Project's staging grant (`ALLOW@staging`) is legal in the same chain — ceilings bind per matched dimension (§3.3-5), so the staging `ALLOW` stands for staging (checked on facet `env: staging`, the Project row is the last to speak and the fold ends `ALLOW@staging` at release branches).
- **With the WO's `DENY` constraint**, folding continues to `DENY` (the WO narrows, which §3.4 calls legal), and the Task's coerced claim can't resurrect it. A task that wants to deploy must have its Work Order's constraint changed by a human — not its own policy entry.

### 7.5 What the proof and examples jointly establish

1. `DENY` anywhere on the chain is final below that level (§3.4 induction).
2. A child may narrow a stricter parent decision (`REQUIRE_HUMAN → DENY`, Example 7.4's WO constraint) but never looser it (Examples 7.2–7.4).
3. Scope claims intersect downward (Example 7.3); no chain of claims can re-add removed resources.
4. Ceilings (`production.write`, `secrets.read`; and `deploy.execute` capped at `REQUIRE_HUMAN` **for the `env: production` facet**, §3.3-5) hold regardless of how permissive any level tries to be: over-ceiling expressions are coerced to the ceiling and marked `ceiling-violation` (Example 7.4). Facets a ceiling does not scope are governed by the ordinary hierarchy rules — the staging `ALLOW` in Example 7.4 is legal and unaffected.
5. Only a human, answering an `APPROVAL` interaction outside the hierarchy, can turn a `REQUIRE_HUMAN` instance into an `ALLOW` — single-use, instance-bound, recorded (§3.6, §5 stage 4).

## 8. Runtime enforcement points and the tier gate

1. **E3 scheduler gate** — `SchedulerPolicy.canAssign(task, workOrder)` is implemented as `check({ taskId: task.id, workOrderId: workOrder.id }, { capability: 'repo.write', resource: { branch: 'worktree-branch-of-task' } })`; `ALLOW` assigns, anything else leaves the Task in `READY` (the scheduler already renders `blockedPolicy`).
2. **Worker dispatch envelope** — every consequential worker-requested external action (`pr.create`, `deploy.execute`, `ci.run`, production access) passes `check` at the Factory before E6/adapter does I/O; the worker never holds the credentials (§12.3).
3. **E6 external side effects** — `openPR`, `merge`, promotion: each is a `check` call site. **The capability for `merge`/promotion is `deploy.execute` with binding `{ env: production }`** — merging to the default branch of the production repository *is* a production deployment, and it is the only §13.2 capability available for it (`pr.create` covers only opening/updating the PR, a reversible, non-public act; the merge makes the content live on the shared branch). Consequences, fixed: (a) merge is high-sensitivity, so the §8.1 tier floor is `REQUIRE_HUMAN` for **every** tier — no Work Order, Green included, can auto-merge; (b) since `merge` is the sole production expression of `deploy.execute`, its verdict is at best `REQUIRE_HUMAN` (§4 ceiling) and becomes `ALLOW` only via stage-4 consumption of an operator `APPROVAL`. `merge` additionally requires Work Order `APPROVED` + the no-self-merge rule (the `APPROVAL` must reference a verifier identity different from the writer's — Writer ≠ Verifier ≠ Promoter, §12.1). `openPR` remains a `pr.create` check, which is why PR creation can be autonomous at Green/Yellow while the merge step never is.
4. **E2 API endpoints** — consequential endpoints call `check` server-side under the operator's authenticated identity (§12.4).

### 8.1 Tier-gate matrix (stage 3 of `check`)

Rows = the **effective tier** of the decision — `tighter-tier(classifyRisk(wo), escalateFor(...))` (§6.3) — columns = capability sensitivity class (§4: low / medium / high). Cells = `tierFloor` (the minimum restrictiveness the tier demands for that class):

| Tier \ Sensitivity | low | medium | high |
|---|---|---|---|
| **GREEN** | `ALLOW` | `ALLOW` | `REQUIRE_HUMAN` |
| **YELLOW** | `ALLOW` | `ALLOW` | `REQUIRE_HUMAN` |
| **RED** | `REQUIRE_HUMAN` | `REQUIRE_HUMAN` | `REQUIRE_HUMAN` |

Applied as `tighter(fold, tierFloor)` the gate can only ever restrict (a fold of `DENY` stays `DENY`; a fold of `ALLOW` under RED becomes `REQUIRE_HUMAN`; a fold of `REQUIRE_HUMAN` anywhere stays so). Two boundaries this table deliberately draws:

- **Publication vs. promotion.** `pr.create` (medium sensitivity) is individually `ALLOW` at Green/Yellow — opening a PR is reversible and non-public. The *merge* to the production branch is a `deploy.execute { env: production }` check (§8-3): high sensitivity, so its floor is `REQUIRE_HUMAN` for every row of this table, and the Work Order's promotion must additionally pass `HUMAN_GATE` (§6.5) with an operator `APPROVAL`. So the tier gate bites in two places: before promotion (mandatory `HUMAN_GATE` at Yellow; unavailable at Red) and at the merge decision itself (never below `REQUIRE_HUMAN`, regardless of tier). High-risk (prod/auth/payments/PII/secrets) never auto-promotes because RED's floor is never below `REQUIRE_HUMAN` on any class, and promotion requires the operator's explicit `APPROVAL` — an approval the Green Work Order's *own* promotion path can render optional, but its merge never can.

## 9. Recovery contract (spec §18) — what `recover(failure)` and `emergencyStop()` must honor

Design constraints for `src/factory/recovery/recovery.ts`; no code here.

### 9.1 Failure classification (deterministic, no blind retry without it)

`FailureContext = { attemptId, taskId, workOrderId, failureClass, at, error, signal?, attemptCount, sameClassCount }`. Failure classes (closed enum, spec §18.2 "structured failure classification"; modeled on the spec §18.10 event vocabulary `MODEL_RATE_LIMITED / MODEL_QUOTA_EXHAUSTED / MODEL_AUTH_FAILED / MODEL_UNAVAILABLE`, which recovery also keys off):

`WORKER_FAILURE` | `VERIFICATION_FAILURE` | `DEPENDENCY_UNAVAILABLE` | `MODEL_RATE_LIMITED` (transient) | `MODEL_QUOTA_EXHAUSTED` (subscription exhausted) | `PROVIDER_OUTAGE` | `MODEL_AUTH_FAILED` | `MODEL_UNAVAILABLE` | `IDEMPOTENCY_DUPLICATE` | `CRASH_RECOVERY` | `UNKNOWN`

**`failureClass` encoding convention (v0.1, no E1 schema change).** E1's `AttemptFailure` is `{ at, failure: string, recovery?: string }` — deliberately unstructured. Classification therefore cannot invent a field, so #23 writes into `failure` a **class-prefixed string**: `failure = '<FAILURE_CLASS>: <human message>'` — e.g. `MODEL_RATE_LIMITED: 429 from provider, retried`, `VERIFICATION_FAILURE: security scan failed on auth/**`. The class token is the first `: `-delimited segment of `failure`, matched **exact-token** (one of the enum above; an unparseable or out-of-vocabulary token ⇒ treated as `UNKNOWN`, never string-sniffed). For entries written before this convention existed, recovery treats a bare (no-prefix) `failure` as `UNKNOWN`. `AttemptFailure.recovery` carries the applied `RecoveryAction.kind` when one was applied. This is what §9.4's `sameClassCount` and §9.6's idempotency keys read; the enum lives with the deployment policy like the security taxonomy (§6.3), so the classifier and the counter use the same list.

### 9.2 `recover(failure) → RecoveryAction`

```text
RecoveryAction =
  { kind: 'RETRY_NEW_ATTEMPT', reason, changedCondition }   // new Attempt, clean worktree (spec §18.4)
| { kind: 'REASSIGN', workerId? }                           // same work, different worker
| { kind: 'REPLAN', taskIds }                               // bounded replan (this §, v2; §9.4 WO-level recovery ceiling)
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

**The replan procedure (the bound lives in E7, not in E3).** E3's `src/factory/planning/dag.ts` exports `validateDAG` / `proposeDAG` / `commitDAG` and contains **no bound of its own** — `proposeDAG` happily accepts any lawful version count and any state in `REPLAN_STATES`. So the bound is E7's contract, and #23 implements `replanWorkOrder(workOrderId, payload)` in the recovery engine as:

1. **Check the cap first:** let `v = getActiveDAG(...)?.version` (E3 `dag.ts`). If `v - 1 ≥ replanBudget(workOrderId)` (default **2** replanned versions — DAG v3 is the last automatic one when replan budget = 2; deployment-configurable, stamped into the decision record), stop: `ESCALATE_HUMAN` with reason `replan-budget-exhausted`.
2. **Call E3 directly:** `commitDAG(deps, workOrderId, payload)` — it validates first; commit is the single transactional path, so E7 never calls `proposeDAG` + a separate commit.
3. **Rejection path:** `commitDAG` throws `FactoryError('DAG_INVALID')` (after appending one `dag.rejected` event) ⇒ the recovery action **must not retry with a mutated payload automatically more than once**; after one rejection the action is `ESCALATE_HUMAN` with the rejection reasons attached (a recovery engine that silently reformulates DAG payloads is out of scope for v0.1).

The result: a failing Task's Task-set is re-planned at most `replanBudget` times per Work Order *by decision of E7's contract*; E3 provides the mechanics and V-agree durability, not the bound.

### 9.3 Crash reconciliation (spec §18.3) — the lease path

On Factory restart the recovery engine must (in order): load durable state → load event history → identify `RUNNING` Attempts → reconcile worker leases → reconnect where the worker is still live (adapter `status`) → otherwise interrupt/recover → retry/replan/escalate per §9.2. Concretely against E3 leases: a `WorkerLease` is *valid* iff `expiresAt > now` and the worker's adapter reports healthy — reattach and continue collecting. If the lease is expired **or** the worker is unreachable (spec §18.5: heartbeat ≠ progress ≠ completion): the Attempt gets `outcome: 'interrupted'` + a `failureHistory` entry (never `success` — E3 already refuses SUCCESS without completion evidence; that gate stays mandatory), the assignment closes, and recovery proceeds — default: new Attempt, clean worktree (spec §18.4), with the failed Attempt's diff/artifacts preserved as evidence.

### 9.4 Boundedness — no blind universal retry

- **Per-class retry budget:** default max **2** automatic retries for the *same* failure class on the same Task (deployment-configurable; stamped into the decision record).
- **Per-Task attempt budget:** default max **3** total Attempts per Task (counted from the `attempts` projection of `failureHistory`, not from in-memory state).
- **Work-Order-level recovery ceiling (the global bound).** The per-Task budgets above are *re-created* for every Task the DAG (re)materializes — a replanned DAG would naively hand each new Task a fresh budget and make global automatic recovery unbounded against spec §18.2. So the Work Order also carries a durable automatic-recovery-action budget: default max **6** automatic recovery actions per Work Order (`RETRY_NEW_ATTEMPT` + `REASSIGN` + `REPLAN` occurrences summed, counted from durable recovery/event records, deployment-configurable). Exceeding it ⇒ every remaining failure class whose remedy would be an **automatic** action (`RETRY_NEW_ATTEMPT`, `REASSIGN`, `REPLAN`) maps to `ESCALATE_HUMAN`, regardless of per-Task budgets. The no-autonomy dispositions are **not** covered — after exhaustion, `WAITING_RESOURCE` (quota/dependency classes, §9.5), `HOLD`, and `NO_OP_DUPLICATE` stay exactly what they would otherwise be; they are never rewritten into `ESCALATE_HUMAN`, because they are already non-automatic (they consume no autonomy and are merely capacity/quota/duplicate bookkeeping, not further attempts to recover). Humans-only actions (`ESCALATE_HUMAN`, `WAITING_RESOURCE`, `HOLD`, `NO_OP_DUPLICATE`) do not count against the budget — they consume no budget because they consume no autonomy. Note also that replanned DAG versions are subject to their own cap (§9.2 replan budget: default 2) *and* each `REPLAN` consumes work-order recovery budget.
- **`REQUIRE_HUMAN`/`ESCALATE_HUMAN` parks are outside every budget.** A `REQUIRE_HUMAN` parking (§5) and an `ESCALATE_HUMAN` escalation generate no further automatic action on the same failure — they wait on a human — so they consume none of the per-class, per-Task, or Work-Order budgets.
- **Changed-condition requirement:** every automatic retry must name a `changedCondition` (new worker, restored resource, new code baseline via clean worktree). Identical failure signature + no changed condition ⇒ no auto-retry ⇒ `REPLAN`/`ESCALATE_HUMAN`.
- Repeated failures are **signals** (spec §18.2): they feed replanning/escalation, never an unbounded loop. Budget exhaustion is itself a signal: the Work Order stops converting budget into retries and waits for a human.

### 9.5 WAITING_RESOURCE semantics (spec §18.10)

- Quota/subscription exhaustion **with a pinned escalation model** (the Work Order requirement pins a model *class* — a generic capability identifier per ADR 13, never a vendor model ID in runtime semantics): affected capacity is marked unavailable and the Attempt records `outcome: 'waiting_resource'` + event (`MODEL_QUOTA_EXHAUSTED`); the Task is **blocked in place, not FAILED**; recovery re-opens a new Attempt when capacity returns.
- Alternative routing is allowed **only** when the substitute satisfies the Work Order's policy and capability requirements (verified against the routing record + the classified tier) — otherwise it is a policy `DENY` for the routing change until a human changes the Work Order requirement. No silent downgrade when a specific model class is required.
- v0.1 note (E1 vocabulary tension, flagged to the controller): E1's `Task` state vocabulary has no `WAITING_RESOURCE` state. The contract here fixes the representation: **Attempt `outcome: 'waiting_resource'` + durable event; Task stays `RUNNING` with no live worker and the lease released**. The recovery engine — not the scheduler's `assignPass`, which only picks `READY` tasks — re-opens it. Extending the spec §5.2 state machine is an E1 follow-up, out of scope here.

### 9.6 Idempotency (spec §18.7)

- Every recovery action carries a durable idempotency key `recover:{attemptId}:{k}` (`k` = `failureHistory.length` at decision time). Duplicate deliveries of the same key are `NO_OP_DUPLICATE` — never duplicate Attempts, never unsafe duplicate actions.
- Non-repeatable external side effects (deploys, PRs) execute only through the capability-checked path (which already requires `ALLOW`); recovery never bypasses a policy check.

### 9.7 Evidence-preservation invariants (all paths)

- **Canonical Attempt `outcome` union (authoritative for v0.1, pinned here):** `outcome: 'success' | 'failed' | 'interrupted' | 'waiting_resource' | 'cancelled'` — lowercase strings in E1's `Attempt.outcome` (E1 types it as `string | null`, so this doc is the normative union and no schema change is needed). Mapping to spec §18.6/§18.3 vocabulary: `failed` ↔ FAILED, `interrupted` ↔ INTERRUPTED, `cancelled` ↔ CANCELLED; `waiting_resource` is the spec §18.10 representative fixed by §9.5 (v0.1: Task stays `RUNNING`); `success` is written only through E3's `hasEvidence` gate. E1/E3's current writers use `success`/`failed` (scheduler.ts); `interrupted` and `waiting_resource` are new outcome values #23 writes into the same free-text field, and `cancelled` becomes possible once the deferred E1 CANCELLED vocabulary lands (§13).
- `CANCELLED`, `FAILED`, `INTERRUPTED` remain **distinct** Attempt outcomes (the `cancelled`/`failed`/`interrupted` rows above are never aliases of each other); an interrupt is never reported as a failure and never as a success.
- No execution is considered successful without completion evidence (E3's `hasEvidence` gate stays mandatory in every recovery path).
- Every verification run and every failed Attempt's diff/artifacts remain immutable evidence (spec §18.8).

## 10. Factory-level controls: pause / resume / emergency-stop

`emergencyStop()` contract (state = durable flag + `factory.emergency_stopped` / `factory.resumed` events, aggregate `'factory'`):

1. **Durable, idempotent state change:** set the e-stop flag (store + event); repeated invocations are no-ops.
2. **Blocks new assignments and provisioning:** the scheduler's `assignPass`/`provisionPass` become no-ops (policy gate at the top of `tick`).
3. **Blocks external side effects:** every `check` short-circuits through stage 1 (§5) — `DENY` for every consequential external action while stopped, i.e. every capability with an effect outside the task worktree (`branch.create`, `pr.create`, `ci.run`, `deploy.execute`, `production.write`, `secrets.read`, and `repo.write` scoped outside the worktree); reads (`repo.read`, `production.read`) stay subject only to their ordinary stages.
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
  ceilings: { production.write: require_human, secrets.read: require_human, deploy.execute: { decision: require_human, scope: { env: production } } }   # ceilings bind per matched dimension (§3.3-5): deploy.execute's scope caps the production facet only; the project's staging allow below is legal; a source violating a ceiling is rejected at load time (§3.3-5)
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
  UNTRUSTED (outside)                                                TRUSTED (inside): Factory Server process
                                                                    +----------------------------------------+
  Worker adapters   --dispatch / lease / policy-checked I/O-->       | E1 durable state + append-only log     |
  (per-task worktrees running LLM agent     <--results/leases---     | E7 policy / risk / recovery (every gate)|
   code; file writes stay inside the worktree)                       | E6 adapter -- the ONLY external writer | --> GitHub API (PAT, server-side only)
                                                                    +----------------------------------------+
  Operator (Client UI) -- authenticated E2 calls: APPROVAL answers,    ^
  pause/resume/e-stop, policy edits    --------------------------------+
  LLM provider -- completions only (text = untrusted input, never policy authority)
```

- **Inside the boundary (trusted):** the Factory Server process itself — the only writer of `StateStore`/event-log rows; E6 the only GitHub caller.
- **Outside (untrusted):** worker processes executing model-generated code (per-task worktrees scope the blast radius); LLM output (text is untrusted input, never policy authority — ADR 13's separation of recommendation from execution); GitHub events; the Client UI network path; anything a worker asks the Factory to do.
- **Principals:** the Operator (the v0.1 auth subject), Worker agents (write-into-worktree only, via lease), the Verifier (independent of the writer — Writer ≠ Verifier ≠ Promoter), the Promoter/merger (E6, acts only on `APPROVED` + `ALLOW`), and the human approver (answers `APPROVAL` interactions; identity recorded on the interaction and the consumed `policy_decision`).

### 12.2 Who may call what

| Caller | May | May not |
|---|---|---|
| Worker agent (via adapter) | request transitions, QUESTION → `WAITING_INPUT`, propose lifecycle changes | apply state transitions; touch GitHub directly; hold repo/GitHub credentials; approve its own work (spec §5.1: "Agents cannot approve their own work"); read secrets |
| Scheduler passes | assign via `policy.canAssign` | bypass the policy check |
| E6 adapter | `openPR` after a `pr.create` check; `merge` after a `deploy.execute { env: production }` check + Work Order `APPROVED` + the consumed operator `APPROVAL` | merge without `APPROVED` **and** the consumed `ALLOW`; self-merge (verifier ≠ writer) |
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
