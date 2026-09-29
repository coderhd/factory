# E3 Design — DAG Validation, Versioning, and the Capacity/Policy-Aware Scheduler

**Status:** Design deliverable (E3.1, sub-issue `coderhd/factory#14`). Implementation is E3.2 (`#15`).
**Authority:** spec `factory-docs/2026-09-17-software-factory-design.md` §7.1 Planning, §7.2 Scheduling, §15 Worker Runtime, §16 Worker Provisioning, §17 Worker Execution Envelope (with §5 core domain, §18 failure/recovery, §19 persistence as background).
**Refines:** plan `docs/superpowers/plans/2026-09-29-factory-server-v01.md` Task 2 (E3). This doc is the concrete DAG/scheduler specification the plan argues for; it does not repeat the plan's epic-level text.
**Foundation:** E1 (merged, `b68bc78`): `src/factory/domain/workOrder.ts`, `src/factory/state/store.ts`, `src/factory/state/schema.sql`, `src/factory/events/log.ts`, `src/factory/bus/messageBus.ts`. All E1 signatures cited below are taken from that code, not invented.

---

## 1. Design summary

```text
Work Order (PLANNING)
   ↓  proposeDAG          Planner (LLM) → proposal payload (planner-local nodeIds)
   ↓  validateDAG         Factory → all rules, all reasons (pure, no writes)
   ↓  commitDAG           Factory → single transaction: task rows + edge rows + dag.committed event
   ↓  transitionWorkOrder Factory (E1 fn) → PLANNING → EXECUTING
Scheduler tick (in-process, event- + timer-driven)
   ↓  unblock pass        active-version PLANNED tasks whose deps are all VERIFIED → READY
   ↓  reclaim pass        idle workers past idle_timeout → RECLAIMED (zero at rest)
   ↓  provision pass      demand-driven: provision up to unmet demand, ceiling max 5
   ↓  assign pass         READY task + IDLE worker + capacity + policy → worktree + assign + start
Worker (Herdr adapter) executes in an isolated branch+worktree+baseCommit
   ↓  collect             status/commits/artifacts → completeAttempt + Factory transitions
   ↓  release             worker → IDLE, lastActiveAt updated, lease cleared, assignment closed (§6.4 release rule)
   ↓  SUCCESS → VERIFYING → VERIFIED   (verification is E5; E3 only reacts to Task states)
   ↓  dependency VERIFIED → dependents unblocked on the next tick
REPLAN (failure / missing information) → proposeDAG → commitDAG → DAG v2 (v1 preserved, never overwritten)
```

Authority split (spec §7.1, invariant "Planner proposes; Factory commits"):

- **Planner:** composes the proposal payload. It never writes durable state.
- **Factory:** records proposals, validates, commits versions, owns every state transition. Workers execute; they do not govern.

---

## 2. DAG proposal format

### 2.1 Planner → Factory payload

The planner addresses one Work Order. `proposeDAG` is the recording seam — it is planner-agnostic (LLM planner, CLI, test) and performs **no graph validation**; validation authority is `commitDAG` (§3).

```ts
/** src/factory/planning/dag.ts (E3.2) */

/** One proposed DAG node. `nodeId` is planner-local and unique within the proposal. */
export interface ProposalNode {
  nodeId: string;        // required, non-empty, unique in this proposal
  title: string;         // required, non-empty
  dependsOn?: string[];  // references sibling nodeIds of THIS proposal; default []
  notes?: string;        // optional planner rationale for the node
}

/** The exact planner → Factory payload. No Work Order id inside: the call binds it. */
export interface DAGProposalPayload {
  nodes: ProposalNode[];   // required, ≥ 1 node
  rationale?: string;      // optional planner-level rationale
}

/** What proposeDAG records. Nothing durable changes except the audit event. */
export interface RecordedProposal {
  id: string;              // `prop_${crypto.randomUUID()}`
  workOrderId: string;
  proposedVersion: number; // advisory: lastCommittedVersion + 1
  payload: DAGProposalPayload;
  proposedAt: string;      // ISO timestamp
}
```

Design choices:

- **Planner-local `nodeId`s.** The planner cannot know Factory task IDs (`task_${uuid}` are minted by the Factory at commit). References inside a proposal are therefore always *sibling nodeIds of the same proposal* — one namespace, one reference rule. The Factory resolves `nodeId → taskId` at commit time (§2.3).
- **Node minimalism (KISS).** `nodeId / title / dependsOn / notes` only. The E1 `Task` shape (`{ id, workOrderId, title, state, dependsOn, createdAt, updatedAt }`) has no kind/estimate fields, so none are invented. E5/E7 can extend additively later.
- **Payload carries no version number.** Version numbers are Factory property, assigned at commit from durable state (§4.3). `proposedVersion` on the recorded proposal is advisory only.

### 2.2 `proposeDAG` — recording the proposal

```ts
export function proposeDAG(
  deps: PlanningDeps,        // = E1 WorkOrderDeps { store: StateStore; events: EventLog }
  workOrderId: string,
  payload: DAGProposalPayload,
): RecordedProposal;
```

- Guards the Work Order exists (E1 `WORK_ORDER_NOT_FOUND` behavior) and is in a state where a commit of the next version is legal (§3, rule `DAG_WO_STATE`).
- Appends one audit event `dag.proposed` (aggregate `work_order`, `aggregateId = workOrderId`, payload `{ proposal: RecordedProposal }`) and returns the `RecordedProposal`. **No task rows, no version doc, no state change.**
- `proposeDAG` is optional in the flow: `commitDAG` accepts a raw `DAGProposalPayload` and re-validates whatever it is given (it never trusts that `proposeDAG` ran). The audit event is the only reason to call it.

### 2.3 `DAGv1` / `DAGv2…` — the committed version representation

A **committed version** is an immutable document. It is durably stored **only in the append-only event log**, as the payload of a `dag.committed` event:

```ts
export interface CommittedNode {
  nodeId: string;           // the planner-local id, kept for traceability
  taskId: string;           // `task_${uuid}` minted at commit
  title: string;
  dependsOnTaskIds: string[];// resolved Factory task ids (E1 Task.dependsOn values)
}

export interface DAGVersion {
  id: string;               // `dag_${crypto.randomUUID()}`
  workOrderId: string;
  version: number;          // 1-based, assigned at commit = lastCommitted + 1
  nodes: CommittedNode[];
  createdAt: string;
}
```

`DAGv1` is simply the `DAGVersion` document with `version: 1`; `DAGv2…` are subsequent commits (REPLAN). There is no `active` flag on the document — the active version is derived (§4.2), so no version document is ever mutated.

Every committed version is simultaneously materialized as E1 relational state in **one transaction** (§3.2):

| Representation | Where | Content |
|---|---|---|
| Version document | `events` row `dag.committed` (payload `{ dag: DAGVersion }`) | planning truth + history (append-only, DB-trigger-enforced) |
| Task rows | `tasks` table | one E1-shaped `Task` per `CommittedNode`, `state: 'PLANNED'`, `dependsOn = dependsOnTaskIds` |
| Edge rows | `task_dependencies` table | one E1-shaped `TaskDependency` per edge `{ taskId, dependsOnTaskId }` |

**In invariant (V-agree):** for every committed version, the three representations agree — `version.nodes[].dependsOnTaskIds` ≡ the `dependsOn` of that version's task rows ≡ that version's `task_dependencies` rows. `commitDAG` writes them in one transaction, so they cannot disagree.

---

## 3. Factory validation rules (`commitDAG`)

### 3.1 The rules

`validateDAG(deps, workOrderId, payload)` is a **pure function** (no writes) returning **all** reasons, not just the first — the planner gets complete feedback:

```ts
export type DagRuleCode =
  | 'DAG_WO_STATE'      | 'DAG_IN_FLIGHT' | 'DAG_EMPTY'     | 'DAG_MALFORMED'
  | 'DAG_DUPLICATE_NODE'| 'DAG_UNKNOWN_DEP'| 'DAG_SELF_DEP' | 'DAG_CYCLE';

export interface DagRejection { rule: DagRuleCode; message: string; }
export type DagValidation = { ok: true } | { ok: false; reasons: DagRejection[] };

export function validateDAG(
  deps: PlanningDeps, workOrderId: string, payload: DAGProposalPayload,
): DagValidation;
```

| # | Code | Rule |
|---|---|---|
| R1 | `DAG_WO_STATE` | Work Order exists and is in a legal state for this commit: **v1** requires `PLANNING`; **v2+ (REPLAN)** requires `EXECUTING`, `WAITING_INPUT`, or `REWORK`. |
| R2 | `DAG_IN_FLIGHT` | (REPLAN only) no task of the *active* version is `ASSIGNED`, `RUNNING`, or `WAITING_INPUT` — live executions must settle first (§4.4). |
| R3 | `DAG_EMPTY` | `nodes` is an array with at least one node. |
| R4 | `DAG_MALFORMED` | Every node is well-formed: `nodeId` non-empty string; `title` non-empty string; `dependsOn` an array of strings (default `[]`); `notes`/`rationale` strings when present. |
| R5 | `DAG_DUPLICATE_NODE` | Single definition per node: `nodeId`s are unique within the proposal (a proposal is a function from `nodeId` to node). |
| R6 | `DAG_UNKNOWN_DEP` | Known dependency references: every `dependsOn` entry is a `nodeId` of this proposal. |
| R7 | `DAG_SELF_DEP` | No node depends on itself. |
| R8 | `DAG_CYCLE` | The directed graph over `nodes`/`dependsOn` is acyclic (DFS three-color or Kahn's algorithm; report one cycle in the message). |

R7 is a special case of R8 but keeps its own code so a self-edge is reported as such. Evaluation order is R1 → R2 → (R3 stops node-level rules if empty) → R4–R8; all applicable reasons are collected.

### 3.2 `commitDAG` — validate, then commit atomically

```ts
export function commitDAG(
  deps: PlanningDeps, workOrderId: string, payload: DAGProposalPayload,
): DAGVersion;
```

- Runs `validateDAG`. **If invalid:** appends one `dag.rejected` event (payload `{ payload, reasons: DagRejection[] }`) — the append-only log is safe to write before throwing — and then throws `FactoryError('DAG_INVALID', '<rule codes + messages>')` (E1's typed error from `src/factory/domain/errors.ts`). **Nothing else changes:** no task rows, no edges, no version doc, no Work Order state. That is "rejected on paper": the rejection exists only as an event + an exception.
- **If valid:** one `deps.store.db.transaction(...)` (E1's pattern from `createWorkOrder`, generalized to a whole graph):
  1. Mint one E1-shaped `Task` row per node (`task_${uuid}`, `workOrderId`, `title`, `state: 'PLANNED'`, `dependsOn` = **resolved task ids**) + one `TASK_CREATED` event each (payload `{ task }` — exactly E1's `createTask` event shape, so E1's `projectState` replay stays correct).
  2. Mint one `TaskDependency` row per edge (`{ id, taskId, dependsOnTaskId, createdAt, updatedAt }`) — written **after all task rows** so the schema's real foreign keys (`task_dependencies.task_id`/`depends_on_task_id` → `tasks.id`) enforce endpoint existence at the database level as a belt-and-suspenders under R6.
  3. Append one `dag.committed` event (payload `{ dag: DAGVersion }`, aggregate `work_order`).
- Returns the `DAGVersion`. Version number = last committed version for this Work Order + 1 (from durable state; `proposedVersion` is not trusted).
- **Work Order transition is deliberately not applied here.** `commitDAG` commits planning artifacts only; the orchestrator (E2 server / CLI / E3.2 test) applies `transitionWorkOrder(deps, woId, { to: 'EXECUTING' })` (E1, deps-first per Ruling R9) immediately after the v1 commit. The crash window between the two is benign: the scheduler's task passes (unblock/assign — §5.3 scope; the worker passes are Work-Order-agnostic and never touch tasks) only consider Work Orders already in `EXECUTING`/`WAITING_INPUT`, and E7 reconciliation owns the window. This keeps `commitDAG` single-responsibility and avoids relying on nested transactions.
- `commitDAG` does **not** call E1's `createTask` per node: it needs full-graph atomicity and resolved cross-references, so it mints the rows and `TASK_CREATED` events itself in E1's exact shapes.

### 3.3 Valid example (V1)

Work Order `wo_9f2` in `PLANNING`. Planner payload:

```json
{
  "nodes": [
    { "nodeId": "n1", "title": "Add config schema" },
    { "nodeId": "n2", "title": "Implement store", "dependsOn": ["n1"] },
    { "nodeId": "n3", "title": "Write docs",       "dependsOn": ["n1"] },
    { "nodeId": "n4", "title": "Release notes",    "dependsOn": ["n2", "n3"] }
  ],
  "rationale": "store and docs are independent once the schema lands"
}
```

`validateDAG` → `{ ok: true }` (4 nodes, 4 edges, no cycles: n1 → {n2, n3} → n4).
`commitDAG` → **DAGv1** (abridged; task ids minted at commit):

```json
{
  "id": "dag_0d1c",
  "workOrderId": "wo_9f2",
  "version": 1,
  "nodes": [
    { "nodeId": "n1", "taskId": "task_a1", "title": "Add config schema", "dependsOnTaskIds": [] },
    { "nodeId": "n2", "taskId": "task_b2", "title": "Implement store",    "dependsOnTaskIds": ["task_a1"] },
    { "nodeId": "n3", "taskId": "task_c3", "title": "Write docs",         "dependsOnTaskIds": ["task_a1"] },
    { "nodeId": "n4", "taskId": "task_d4", "title": "Release notes",      "dependsOnTaskIds": ["task_b2", "task_c3"] }
  ],
  "createdAt": "2026-09-29T10:00:00.000Z"
}
```

Durable effects of the single transaction: 4 `tasks` rows (all `PLANNED`, `dependsOn` resolved as shown), 4 `task_dependencies` rows (`task_b2→task_a1`, `task_c3→task_a1`, `task_d4→task_b2`, `task_d4→task_c3`), 4 `task.created` events, 1 `dag.committed` event. Orchestrator then applies `transitionWorkOrder(deps, 'wo_9f2', { to: 'EXECUTING' })`. The scheduler's first tick transitions `task_a1` `PLANNED → READY` (no dependencies) — §5.3.

### 3.4 Worked invalid examples (one per rule — rejected on paper)

Each example shows the payload fragment, the recorded rejection, and the invariant that **nothing besides the `dag.rejected` event changes** (no task rows, no version doc, Work Order state untouched, `commitDAG` throws `FactoryError('DAG_INVALID', …)`).

**I1 — `DAG_WO_STATE`** (first commit against a Work Order that has not entered PLANNING):

```json
{ "nodes": [ { "nodeId": "n1", "title": "Ship it" } ] }
```

`commitDAG(deps, 'wo_9f2', …)` while `wo_9f2.state === 'READY'` →

```json
{ "rule": "DAG_WO_STATE", "message": "work order wo_9f2 is READY; first DAG commit requires PLANNING" }
```

REPLAN variant: a v2 commit while `state === 'VERIFYING'` → `"...is VERIFYING; REPLAN requires EXECUTING, WAITING_INPUT, or REWORK"`.

**I2 — `DAG_EMPTY`:**

```json
{ "nodes": [] }
```

→ `{ "rule": "DAG_EMPTY", "message": "proposal contains no nodes; a DAG must define at least one task" }`

**I3 — `DAG_MALFORMED`** (required fields):

```json
{ "nodes": [ { "nodeId": "n1", "title": "" }, { "nodeId": "n2" } ] }
```

→ two reasons, both recorded:
`{ "rule": "DAG_MALFORMED", "message": "node n1: title is required and must be a non-empty string" }`,
`{ "rule": "DAG_MALFORMED", "message": "node n2: title is required and must be a non-empty string" }`

**I4 — `DAG_DUPLICATE_NODE`** (single definition violated):

```json
{ "nodes": [
    { "nodeId": "n1", "title": "Design API" },
    { "nodeId": "n1", "title": "Design API v2" }
] }
```

→ `{ "rule": "DAG_DUPLICATE_NODE", "message": "nodeId n1 is defined more than once; nodeIds must be unique within a proposal" }`

**I5 — `DAG_UNKNOWN_DEP`** (known dependency references):

```json
{ "nodes": [
    { "nodeId": "n1", "title": "Design API" },
    { "nodeId": "n2", "title": "Implement", "dependsOn": ["n9"] }
] }
```

→ `{ "rule": "DAG_UNKNOWN_DEP", "message": "n2 depends on n9, which is not a nodeId in this proposal" }`

**I6 — `DAG_SELF_DEP`:**

```json
{ "nodes": [ { "nodeId": "n1", "title": "Review itself", "dependsOn": ["n1"] } ] }
```

→ `{ "rule": "DAG_SELF_DEP", "message": "n1 depends on itself" }`

**I7 — `DAG_CYCLE`:**

```json
{ "nodes": [
    { "nodeId": "n1", "title": "A", "dependsOn": ["n3"] },
    { "nodeId": "n2", "title": "B", "dependsOn": ["n1"] },
    { "nodeId": "n3", "title": "C", "dependsOn": ["n2"] }
] }
```

→ `{ "rule": "DAG_CYCLE", "message": "dependency cycle detected: n1 → n3 → n2 → n1" }`

**I8 — `DAG_IN_FLIGHT`** (REPLAN while execution is live): active DAGv1's `task_b2` is `RUNNING`; planner submits a replacement proposal and `commitDAG` targets v2 →

```json
{ "rule": "DAG_IN_FLIGHT", "message": "task_b2 (DAG v1) is RUNNING; REPLAN requires no active task in ASSIGNED, RUNNING, or WAITING_INPUT" }
```

Rationale for I8: a live worker holds a worktree and an open Attempt for a task; replacing the plan under it would orphan an execution. Settling first (`FAILED`, `REWORK`, `VERIFIED`, or paused-and-abandoned via E7 cancellation) keeps E3 free of cancellation logic. Missing-information REPLAN follows the §12 question path (`WAITING_INPUT` → answer → `RUNNING` → settle) or E7 cancellation.

---

## 4. Versioning scheme

### 4.1 Preservation — append-only, never overwritten

- Version documents exist **only** as `dag.committed` event payloads. The `events` table is append-only **at the database level** — `schema.sql` triggers `events_no_update` / `events_no_delete` `RAISE(ABORT)`. A version, once committed, cannot be modified or deleted.
- REPLAN (**v2, v3, …**) commits a **fresh node set**: new task rows, new edge rows, new version doc. It never mutates or deletes a prior version's task rows, edge rows, or events. Consequences:
  - Planning facts are append-only; the only mutations to task rows are E1 Factory-owned state transitions (`task.transitioned` events, full post-transition entity in payload) — E1's replay determinism is preserved exactly.
  - Attempt history survives: `attempts.task_id` has `ON DELETE CASCADE`, so deleting task rows would destroy execution history — this design never deletes them. `attempts.worker_id` has `ON DELETE RESTRICT` — worker rows are likewise never deleted (§6.2).
  - §5.3 "repeated failures are evidence for replanning": the failed v1 task keeps its rows and Attempts; E7/E8 can query Work-Order-level failure history across versions.
  - No duplicate `(taskId, dependsOnTaskId)` edges can arise across versions because task ids are minted fresh per version.
- `dag.proposed` / `dag.rejected` events give the full audit trail: proposal → rejection reasons (or) → commit. Nothing is silently overwritten, and a REPLAN is a loud, visible event — never silent.

### 4.2 Active version selection

- `getActiveDAG(deps, workOrderId)` folds `readEvents({ aggregateType: 'work_order', aggregateId: workOrderId })` (E1 `EventLog`), filters `dag.committed`, and returns the entry with the highest `version` (equivalently: the last by `seq`). Returns `null` if no version was ever committed.
- `listDAGVersions(deps, workOrderId)` returns all committed versions, ascending; `projectDAGVersions(events, workOrderId)` is the replay fold E3.2 uses for the store/log agreement test (and for E2 backup/restore).
- The **scheduler and every consumer derive** "active" this way; no stored flag exists to go stale. Prior-version tasks that were never started simply remain as inert `PLANNED`/`READY` rows — they are not in the active version's `taskId` set, so no pass of the scheduler will touch them (§5.3).
- E1's `projectWorkOrder` continues to return *all* tasks of the Work Order, including superseded ones — that is correct for E1's projection; consumers that want "current work" filter through the active version's node set (documented for E2).

### 4.3 Version numbers

- Assigned **at commit time** from durable state: `version = maxCommitted(workOrderId) + 1`. `RecordedProposal.proposedVersion` is advisory; if two recorded proposals both target v2, committing both yields v2 then v3, each fully validated against the state of its moment. No staleness rule is needed in v0.1.
- Work Order coupling: v1 commits only while `PLANNING`; v2+ (REPLAN) only while `EXECUTING` / `WAITING_INPUT` / `REWORK` (rule R1) and with all active tasks settled (rule R2). After a v1 commit the orchestrator transitions the Work Order `PLANNING → EXECUTING` via E1's `transitionWorkOrder`.

### 4.4 REPLAN semantics (v0.1) and the upgrade path

Chosen model — **fresh task set per version**: a REPLAN re-plans the remaining work as a new self-contained DAG. Verified prior work is history, not a node; the new version's `dependsOn` references only its own siblings, so validation stays single-namespace (R6). What a dependent needs from a prior version's verified code is a *base-commit* concern, recorded at assign time (§6.3) and completed by E5/E6's merge flow (§9 handoffs).

Deliberate boundary: v0.1 has no "resume same task across versions" (nodeId-stable task reuse). That would require mutating task rows and a new `task.replanned` event type, and it re-opens the dropped-work guard. It is deferred; the workaround today is a new node whose worktree base includes the prior attempt's preserved diff (§18.4 evidence-preserving recovery).

---

## 5. Scheduler design (capacity- and policy-aware)

### 5.1 Shape

In-process, tick-driven (KISS: in-process queue; no Redis — deferred). One `Scheduler` instance owns all passes. A tick is triggered (a) explicitly by the orchestrator after any Factory transition (`tick()` call), and (b) by a timer (`start()` sets the interval; `stop()` clears it) for worker-report collection, idle reclaim, and lease expiry. The queue is **derived state** (READY tasks of active versions) — rebuilt each tick from `StateStore`, so a crash loses nothing.

```ts
/** src/factory/scheduler/scheduler.ts (E3.2) */

export interface SchedulerConfig {
  maxConcurrentTasks: number;        // default 3 (spec §7.2 MVP band 2–3; tests exercise 2 and 3)
  provisioning: {                    // spec §16
    enabled: boolean;                // default true
    min: number;                     // default 0 — the only supported value in v0.1 (§5.3 pass 3: no floor-keeping; zero at rest)
    max: number;                     // default 5  — capacity ceiling, not an initial count
    idleTimeoutMs: number;           // default 10 * 60_000 (§16 idle_timeout: 10m)
    defaultProfile: WorkerProfile;   // 'herdr'
  };
}

export interface SchedulerDeps {
  store: StateStore;                 // E1 seam
  events: EventLog;                  // E1 seam
  workers: WorkerManager;           // §6.2
  worktrees: WorktreeManager;       // §6.3
  policy?: SchedulerPolicy;         // default allow-all seam; E7 plugs `check()` in
  now?: () => string;                // the single injected clock — threaded into the WorkerManager and assign (§6.2, §6.4); one injection point
}

export function createScheduler(deps: SchedulerDeps, config?: Partial<SchedulerConfig>): Scheduler;

export interface Scheduler {
  tick(): void;
  start(): void;   // begin the interval timer
  stop(): void;
  status(): SchedulerStatus;        // consumed by E2 (plan Task 4 "E3 scheduler (status)")
}
```

### 5.2 Policy seam

```ts
export type PolicyVerdict = 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN';   // E7's check() vocabulary
export interface SchedulerPolicy {
  canAssign(task: Task, workOrder: WorkOrder): PolicyVerdict;
}
```

v0.1 ships an allow-all default (the seam, not the policy). `DENY`/`REQUIRE_HUMAN` skip the task this tick and surface it in `status().blockedPolicy` for E2/E7. Full policy/risk enforcement (risk tiers, capability checks, high-risk gating) is E7 (#19); the seam is where it plugs in — the scheduler is policy-*aware* from day one.

### 5.3 The tick — collect, then four passes, in order

Each tick opens with a **collect step** — the driver of §6.4's completion rules: the scheduler polls every `BUSY` worker holding an open assignment (the same heartbeat poll that renews the lease, §6.2) and routes each terminal `WorkerResult` into §6.4's completion path, whose release rule returns the worker to `IDLE` and frees the concurrency slot before the passes below run. The four passes then run in order.

**Task scope.** The scheduler's *task* work — pass 1 (unblock), pass 4's candidates, and the demand signal pass 3 counts (the same candidate set pass 4 could actually assign) — considers only Work Orders in `EXECUTING` or `WAITING_INPUT` and only tasks in the **active** version's node set. The reclaim and provision passes are otherwise **Work-Order-agnostic**: they act on the worker population, not the Work-Order-scoped task set, so idle workers are still reclaimed (and the population still returns to zero) once every Work Order has left `EXECUTING`/`WAITING_INPUT` (e.g. all tasks `VERIFIED`, the Work Order in `VERIFYING` — S4 depends on this).

1. **Unblock pass.** For each active-version task in `PLANNED` whose `dependsOn` tasks are **all `VERIFIED`** (terminal success — `SUCCESS`/`VERIFYING` do *not* unblock; spec §5.2): apply E1 `transitionTask(deps, taskId, { to: 'READY', reason: 'dependencies verified' })`. Dependents stay `PLANNED` (blocked) until then.
2. **Reclaim pass.** Workers with `runtimeState: 'IDLE'`, **no open assignment** (no `AssignmentRecord` with this `workerId` and `closedAt: null`; an assignment is **open** while `closedAt` is `null` and **closed** once the §6.4 release rule stamps it — closed rows are retained as provenance, and a `waiting_input` assignment is open, so its worker is never reclaimed), and `now() - lastActiveAt > idleTimeoutMs` → `destroy()` the adapter and mark `runtimeState: 'RECLAIMED'` (+ `worker.reclaimed` event; row retained — §6.2). This pass is Work-Order-agnostic (scope above). Result at rest: active population 0.
3. **Provision pass.** Demand-driven: `readyDemand` = policy-allowed `READY` tasks in the scoped candidate set (scope above); `idle` = `IDLE` workers. If `readyDemand > idle` and `activePopulation < max (5)`, provision `min(readyDemand - idle, max - activePopulation)` workers of `defaultProfile` (§6.2). **`min` is accepted but unused in v0.1** — the formula reads only demand and `max`, and the reclaim pass still zeroes the population, so a non-zero `min` would be floor-keeping that contradicts zero-at-rest: **`min ≠ 0` is unsupported** (it has no effect; only `min: 0` behaves as configured, and the Factory never pre-provisions). The field exists so the config shape is forward-compatible (§7.2).
4. **Assign pass.** While `assignedOrRunning < maxConcurrentTasks` and a policy-allowed `READY` task exists and an `IDLE` worker exists: pick the task (deterministic FIFO by `createdAt`, tie-break `id`), ensure its worktree (§6.3), then `assign` + `start` (§6.4). Per-task errors (e.g. worktree creation failure) skip that task for this tick and leave it `READY` — retried next tick.

Selection fairness beyond FIFO (complexity/risk-weighted ordering) is deferred; the seam is the ordered candidate list.

### 5.4 Worked scenarios (on paper)

**S1 — 3 independent tasks, capacity 3.** DAGv1 = three dependency-free nodes (V1-style minus edges). Tick: unblock 3 → `READY`; provision 3 (demand 3, ceiling 5); assign+start 3 → three workers executing concurrently. `status().concurrency = { current: 3, max: 3 }`, population 3.

**S2 — capacity 2, 3 independent tasks.** First tick: 2 assigned + started, 1 stays `READY` (capacity bound). When one finishes execution (leaves `RUNNING`, i.e. `SUCCESS`), the next tick's collect step routes its report, the §6.4 release rule frees the worker and the slot, and the assign pass assigns the queued one — concurrency never exceeds 2.

**S3 — blocked dependent.** DAGv1: `A` (no deps) → `B` (depends on `A`). Ticks while `A` is `RUNNING`, then `SUCCESS`, then `VERIFYING`: `B` remains `PLANNED` — not `READY`, never assignable. The tick after `A` is `VERIFIED`: `B` → `READY` → assigned (with a worker provisioned on demand). This is "dependent tasks remain blocked" (§7.2).

**S4 — idle reclaim, zero at rest (reachable end-to-end).** Every task reached `SUCCESS` — its Attempt completed, so the §6.4 release rule fired per worker: `IDLE`, `lastActiveAt` updated, lease cleared, assignment closed (row retained) — and then `VERIFIED`; the Work Order has moved on to `VERIFYING` (E5's driving; E3 only reacts), which is why the reclaim pass is Work-Order-agnostic (§5.3 scope). Every worker is therefore `IDLE` with no open assignment. Injected clock advances past `idleTimeoutMs` (10m): reclaim pass marks all workers `RECLAIMED` (adapters destroyed) → active population 0. The `workers` rows and closed `assignments` rows remain as provenance (attempts FK `RESTRICT`).

**S5 — REPLAN.** DAGv1's task fails and settles (`FAILED`); Work Order is `EXECUTING`. Planner proposes v2 (fresh node set); `commitDAG` validates (R1/R2 pass) → `DAGv2` committed. v1's version doc, task rows, edges, and events are untouched; `getActiveDAG` now returns v2; the scheduler's passes consider only v2's tasks. An invalid REPLAN (live task `RUNNING`) is rejected per I8.

### 5.5 `status()` (consumed by E2)

```ts
export interface SchedulerStatus {
  concurrency: { current: number; max: number };
  workers: { idle: number; busy: number; reclaimed: number };
  provisioning: { enabled: boolean; min: number; max: number };
  queue: {
    readyTaskIds: string[];
    blocked: Array<{ taskId: string; waitingOnTaskIds: string[] }>;
    blockedPolicy: Array<{ taskId: string; verdict: PolicyVerdict }>;
  };
  activeDAGs: Array<{ workOrderId: string; version: number; nodes: number }>;
}
```

---

## 6. Workers and worktrees

### 6.1 Worker API (§15) — the adapter seam

```ts
/** src/factory/workers/herdr.ts (E3.2) — implements the §15 Worker API. */
export interface WorkerAdapter {
  provision(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  status(): Promise<WorkerStatus>;              // heartbeat source
  execute(envelope: ExecutionEnvelope): Promise<void>;
  collectArtifacts(): Promise<WorkerResult>;    // §17 worker → Factory
  destroy(): Promise<void>;
}
export function createHerdrWorker(opts: HerdrOptions): WorkerAdapter;
```

v0.1 Herdr is a thin **process boundary** (spawn/stop a `herdr` runtime per worker). E3.2 pins the interface and the envelope; the concrete Herdr invocation is E3.2's to fill behind it. **Tests never spawn real Herdr** — they substitute a fake `WorkerAdapter` (Ruling R5: hermetic tests; OS temp dirs; never mutate this repo's worktrees).

### 6.2 Worker records, provisioning, leases

Workers are documents in E1's `workers` collection (JSON doc store; no schema change — the collection already exists in `DOCUMENT_COLLECTIONS` and has no generated FK columns, so additive fields are free). `manager.ts` exposes a **`WorkerManager` façade object** (this is the `workers` member of `SchedulerDeps`, §5.1); the plan's `provisionWorker(profile)` surface is the façade method:

```ts
/** src/factory/workers/manager.ts (E3.2) */
export type WorkerProfile = 'herdr';
/** Worker lifecycle: IDLE → BUSY (assign, §6.4) → IDLE (release rule, §6.4) → RECLAIMED.
 *  There is no separate `PROVISIONED` runtime state: `provisionWorker` provisions and
 *  starts the adapter in one call and records IDLE — the provision fact lives in the
 *  `worker.provisioned` event, not in the runtime state. */
export type WorkerRuntimeState = 'IDLE' | 'BUSY' | 'RECLAIMED';

export interface WorkerLease {   // consumed by E7 (plan Task 6: "E3 worker leases")
  attemptId: string;
  taskId: string;
  expiresAt: string;             // renewed on heartbeat
  renewedAt: string;
}

export interface WorkerRecord {
  id: string;                    // `worker_${uuid}`
  profile: WorkerProfile;
  runtimeState: WorkerRuntimeState;
  lease: WorkerLease | null;
  provisionedAt: string;
  lastActiveAt: string;
  reclaimedAt: string | null;
}

/** Adapter factory seam: Herdr in production (§6.1), a fake in tests (Ruling R5). */
export type SpawnWorker = (profile: WorkerProfile) => WorkerAdapter;

export interface WorkerManagerDeps {
  store: StateStore;
  events: EventLog;
  spawn: SpawnWorker;
  now?: () => string;             // the scheduler's single clock, threaded in at composition (§5.1) — not a second injection point
}

export interface WorkerManager {
  provisionWorker(profile: WorkerProfile): WorkerRecord;               // + worker.provisioned event; returns IDLE record
  reclaimIdleWorkers(idleTimeoutMs: number): WorkerRecord[];           // → RECLAIMED + worker.reclaimed events
  renewLease(workerId: string, binding: { attemptId: string; taskId: string }, leaseTtlMs: number): WorkerRecord; // grants when absent, extends when present (idempotent heartbeat)
  listWorkers(): WorkerRecord[];
  execute(workerId: string, envelope: ExecutionEnvelope): Promise<void>;      // façade over the worker's adapter
  collectArtifacts(workerId: string): Promise<WorkerResult>;                 // façade; feeds completeAttempt + transitions (§6.4)
}

export function createWorkerManager(deps: WorkerManagerDeps): WorkerManager;
```

- `provisionWorker` appends `worker.provisioned` and returns an `IDLE` record (adapter provisioned+started; there is no `PROVISIONED` runtime state — the provision fact is the event, not the state). Population accounting (pass 3's `activePopulation`, §5.3) counts `IDLE|BUSY` only — `RECLAIMED` rows are history.
- `reclaimIdleWorkers` marks `RECLAIMED` and destroys the adapter. **Worker rows are never deleted**: once an Attempt references a worker, `attempts.worker_id` is `ON DELETE RESTRICT` — deletion would throw. Reclaim = stop runtime + mark state.
- Leases: `startTask` (§6.4) grants via `renewLease(workerId, { attemptId, taskId }, ttl)`; heartbeats (adapter `status()` on tick) re-grant with the same binding. Expiry facts are queryable via `listWorkers()` (each record's `lease.expiresAt`); **E7 owns reconciliation** (§18.3/§18.5: `SUSPECT`/`UNREACHABLE`, grace, retry/replan/escalate). E3 records the lease and the expiry fact; it does not act on it.

### 6.3 Worktrees — `branch + worktree + baseCommit` per Task (§15, §17)

Mandatory isolation for implementation tasks (all v0.1 tasks are implementation tasks).

```ts
/** src/factory/worktrees/worktree.ts (E3.2) — a WorktreeManager façade object
 *  (the `worktrees` member of SchedulerDeps, §5.1). */
export interface TaskWorktree {
  taskId: string;
  branch: string;        // `factory/task-<taskId>` — unique because task ids are unique
  worktreePath: string;  // `<rootDir>/<taskId>`
  baseCommit: string;    // resolved at assign time
}

export interface WorktreeManager {
  createTaskWorktree(taskId: string, repoPath: string): TaskWorktree;
  removeTaskWorktree(t: TaskWorktree, evidence: ArtifactStore): void;  // §18.4 evidence-preserving
}

export function createWorktreeManager(config: {
  rootDir: string;      // configured worktree root, e.g. <dataDir>/worktrees
  baseBranch: string;   // v0.1 default 'main' (see finding F2)
}): WorktreeManager;
```

`createTaskWorktree(taskId, repoPath)`: `git rev-parse <baseBranch>` → `baseCommit`; `git worktree add <rootDir>/<taskId> -b factory/task-<taskId> <baseCommit>`.

- `baseCommit` is resolved at **assign time** (after the task's dependencies are `VERIFIED` — §5.3 ordering guarantees deps settled first). The base is the configured base branch; whether a dependency's *branch* is merged into it is E5/E6's merge-order concern — recorded here as a v0.1 boundary (§9).
- Cleanup is evidence-preserving (§18.4): `collectArtifacts()` → `ArtifactStore.put` (diff/logs) → only then remove worktree + branch. A failed Attempt's diff survives as a recovery/evidence artifact.
- Worktree fields are recorded on the Assignment (§6.4) and carried in the envelope (§17).

### 6.4 Assignment and start — `assign(task)`

```ts
export interface AssignmentIntent {
  taskId: string;
  workerId: string;
  worktree: TaskWorktree;
}

/** E1 Assignment { id, taskId, workerId, createdAt, updatedAt } + the worktree triple
 *  + the closure stamp. Additive JSON fields are safe: the assignments FK columns read
 *  only `$.taskId` / `$.workerId`, which are kept. */
export interface AssignmentRecord extends Assignment {
  branch: string;
  worktreePath: string;
  baseCommit: string;
  closedAt: string | null;        // null = open; stamped by the release rule below on
                                  // Attempt completion — rows are retained as provenance
}

export function assign(
  deps: { store: StateStore; events: EventLog; now?: () => string },  // now = the scheduler's single clock (§5.1)
  intent: AssignmentIntent,
): AssignmentRecord;

export function startTask(deps: SchedulerDeps, assignment: AssignmentRecord): ExecutionEnvelope;
```

- `assign` guards: task exists and is `READY` (else `FactoryError('TASK_NOT_READY', …)`), worker exists and is `IDLE` (else `'WORKER_NOT_IDLE', …`) — **single active assignment per task** and per worker (the second reading of "single-assignment": one task, one worker, one live Assignment). Then, in **one outer `store.db.transaction`** (the guards are evaluated inside it, closing the validate-outside-transaction TOCTOU window E1 left open): E1 `transitionTask(deps, taskId, { to: 'ASSIGNED' })`, write the `AssignmentRecord` (collection `assignments`), mark the worker `BUSY`, append `assignment.created` (payload `{ assignment: AssignmentRecord }`).
  Atomicity note: Bun nests `db.transaction` as savepoints (empirically verified on bun 1.4.2 for this design: an outer transaction rolls back inner E1-style transaction writes on failure), so E1's per-call transactions compose under the outer transaction. E3.2 keeps this case in its test.
- `startTask` (scheduler's assign pass, after `assign`): E1 `createAttempt(deps, { taskId, workerId, model: null, environment })` → E1 `transitionTask(deps, taskId, { to: 'RUNNING' })` → grant the worker's lease via `renewLease` (§6.2) → `worker.execute(envelope)` (async dispatch; the tick returns — reports are **collected by a later tick's collect step**, §5.3, which polls `BUSY` workers holding open assignments and routes terminal `WorkerResult`s into the completion rules below).
- **Completion is Factory-governed** (E1's `TASK_EDGES` are the law: `RUNNING → WAITING_INPUT | SUCCESS`):
  - Report `completed` **with evidence** (non-empty diff/commits — invariant 24: no success claim without evidence): E1 `completeAttempt(deps, attemptId, { outcome: 'success', diff, artifactIds, … })` (artifacts stored via `ArtifactStore.put`, ids into the Attempt) → E1 `transitionTask(deps, taskId, { to: 'SUCCESS' })`. `SUCCESS → VERIFYING → VERIFIED` is E5's engine driving the same E1 transitions; E3 only *reacts* to `VERIFIED` by unblocking dependents (§5.3 pass 1).
  - Report `failed`, missing evidence, or a dispatch rejection: E1 `completeAttempt(deps, attemptId, { outcome: 'failed', failureHistory: [{ at, failure }] })` and the task **remains `RUNNING`** — invariant 9: failed Attempts do not automatically fail durable Work. A task reaches `FAILED` only via `VERIFYING → FAILED` (E5's verdict). Recovery (new Attempt from a clean known baseline, §18.4; bounded retries, escalation) is **E7's**; E3 records the failed Attempt and leaves the task `RUNNING`.
  - Report `waiting_input` (a question): E1 `transitionTask(deps, taskId, { to: 'WAITING_INPUT' })` + an interaction record; the §12 human answer loop (resume `WAITING_INPUT → RUNNING`) lands with E2 — the E1 edge already exists.
  - **Release rule — runs on every Attempt completion, success *or* failure** (it is what returns a worker from `BUSY` to `IDLE`, and it is driven by the tick's collect step, §5.3): in the same transaction as the `completeAttempt` call, the Factory (a) marks the worker `runtimeState: 'IDLE'` (clearing `BUSY`); (b) sets the worker's `lastActiveAt = now()`; (c) clears the lease (`lease = null`); and (d) closes the live Assignment by stamping its `closedAt = now()` (`AssignmentRecord.closedAt`). The `AssignmentRecord` row is **retained** as provenance — never deleted — so §5.3 pass 2's "**no assignment**" means **no *open* assignment** (`closedAt: null`); *closed* rows (`closedAt` stamped) are history. `waiting_input` is **not** a completion: the worker stays `BUSY`, the lease stays live, and the assignment stays open (a resume is `WAITING_INPUT → RUNNING` via the §12 loop), so the reclaim pass never touches it. A **failed** completion releases the worker and closes the assignment too, even though the Task itself remains `RUNNING` (invariant 9): the Task still occupies its concurrency slot, and E7 owns the retry/replan that re-opens execution with a fresh Assignment. Every execution path that reaches terminal success (`SUCCESS`) or terminal failure therefore leaves its worker `IDLE` with no open assignment — which is exactly the predicate S4/T6 rely on.

### 6.5 Execution envelope (§17)

Factory → Worker (`startTask` return, passed to `worker.execute`):

```ts
export interface ExecutionEnvelope {
  workOrderId: string;
  taskId: string;
  attemptId: string;
  repository: string;                  // repoPath (v0.1 local)
  baseCommit: string;
  branch: string;
  worktree: string;                    // worktreePath
  authorizationCapabilities: string[]; // v0.1: [] — external side effects are E7 policy-controlled
  initialContext: string;              // WO intent + acceptance criteria + task title + node notes
  retrievalEndpoint: string | null;    // v0.1: null (Retrieval Gateway deferred)
  skills: string[];                    // v0.1: [] (skill routing is E4's seam)
  requiredVerification: string[];      // from WorkOrder.requiredVerification
}
```

Worker → Factory (`collectArtifacts`): `status`, `commits` (sha + message), `artifacts` (→ `ArtifactStore.put`, ids into the Attempt), `interactions`, `observations`, `verification requests` (E5 consumes). Environment provenance for Evidence (OS/runtime/worker runtime/model/version/skills/Factory version) rides the Attempt's `environment` (E1 field).

---

## 7. E3.2 implementation notes

### 7.1 File map (plan Task 2)

| File | Owns |
|---|---|
| `src/factory/planning/dag.ts` | `DAGProposalPayload`, `ProposalNode`, `DAGVersion`, `DagRejection`; `proposeDAG`, `validateDAG`, `commitDAG`, `getActiveDAG`, `listDAGVersions`, `projectDAGVersions`; `DAG_PROPOSED`/`DAG_REJECTED`/`DAG_COMMITTED` constants |
| `src/factory/scheduler/scheduler.ts` | `SchedulerConfig`, `SchedulerDeps`, `SchedulerPolicy`, `SchedulerStatus`; `createScheduler`; the four tick passes |
| `src/factory/workers/manager.ts` | `WorkerRecord`, `WorkerLease`, `WorkerProfile`, `WorkerRuntimeState`, `SpawnWorker`; `WorkerManager` façade (`provisionWorker`, `reclaimIdleWorkers`, `renewLease`, `listWorkers`, `execute`, `collectArtifacts`) via `createWorkerManager`; `WORKER_PROVISIONED`/`WORKER_RECLAIMED`/`ASSIGNMENT_CREATED` constants; `assign`, `startTask`, `AssignmentRecord`, `AssignmentIntent` |
| `src/factory/workers/herdr.ts` | `WorkerAdapter` (§15 API), `ExecutionEnvelope`, `WorkerResult`, `WorkerStatus`; `createHerdrWorker` |
| `src/factory/worktrees/worktree.ts` | `TaskWorktree`; `WorktreeManager` façade (`createTaskWorktree`, `removeTaskWorktree`) via `createWorktreeManager` |

Event vocabulary (E1 style, `<aggregate>.<verb>`): `dag.proposed`, `dag.rejected`, `dag.committed` (aggregate `work_order`); `worker.provisioned`, `worker.reclaimed` (aggregate `worker`); `assignment.created` (aggregate `assignment`, payload `{ assignment }`). None of these payloads use E1's `workOrder`/`task`/`attempt` keys, so E1's `projectState` fold is unaffected — except `task.created`, which reuses E1's exact shape and stays replay-correct.

All E3.2 module functions follow E1's deps-first shape (Ruling R9): `proposeDAG(deps, workOrderId, payload)`, `commitDAG(deps, workOrderId, payload)`, `validateDAG(deps, workOrderId, payload)`, `assign(deps, intent)`, `startTask(deps, assignment)`; the `WorkerManager`/`WorktreeManager` façade methods (`provisionWorker(profile)`, …) take plain inputs because the façade holds its deps from `createWorkerManager(deps)` — the plan's `provisionWorker(profile)` / `assign(task)` surfaces are these. `PlanningDeps = WorkOrderDeps = { store: StateStore; events: EventLog }` re-exported from `src/factory/domain/workOrder.ts`. Consume E1's `createAttempt`, `completeAttempt`, `transitionTask`, `transitionWorkOrder`, `createWorkOrder` as-is; do not reimplement them.

### 7.2 Config defaults (spec §16 / §7.2)

```yaml
scheduler:
  maxConcurrentTasks: 3        # spec §7.2 MVP band 2–3; tests cover 2 and 3
  provisioning:                # loaded 1:1 into SchedulerConfig.provisioning (§5.1)
    enabled: true
    min: 0                     # only supported value in v0.1 (§5.3 pass 3)
    max: 5                     # capacity ceiling, not an initial count (spec §16)
    idleTimeoutMs: 600000      # spec §16 idle_timeout: 10m
    defaultProfile: herdr      # spec §16 default_profile
worktrees:
  rootDir: <dataDir>/worktrees
  baseBranch: main             # see finding F2
```

The `provisioning` keys are **flat** — `min` / `max` / `idleTimeoutMs` / `defaultProfile` — exactly matching the flat field names of `SchedulerConfig.provisioning` (§5.1); `status().provisioning` (§5.5) reports the same `enabled`/`min`/`max` subset. There is no nested `capacity` object. The spec §16 example writes the same two bounds as `workers.capacity: { min, max }` with `workers.idle_timeout` / `workers.default_profile` as siblings; the loader maps those spec names onto these keys (`workers.provisioning` → `SchedulerConfig.provisioning`, `capacity.min`/`capacity.max` → `min`/`max`, `idle_timeout` → `idleTimeoutMs`, `default_profile` → `defaultProfile`). E3.2 reads **one** shape: `SchedulerConfig`.

### 7.3 Test matrix for `tests/factory/e3-planning.test.ts` (plan Task 2 Step 1)

All tests hermetic (Ruling R5): `mkdtempSync(join(tmpdir(), 'factory-e3-…'))` for db + worktree roots; `git init` fixture repos in temp; **never** touch this repo's worktrees; no real Herdr (fake `WorkerAdapter`); injectable `now()`.

| # | Scenario | Assertions |
|---|---|---|
| T1 | valid propose → commit (V1 example) | `DAGVersion{version:1}` returned; 4 task rows `PLANNED` with resolved `dependsOn`; 4 `task_dependencies` rows; `dag.committed` event; `task.created` events; invariant V-agree |
| T2 | one invalid example per rule I1–I8 | `FactoryError('DAG_INVALID')`; `dag.rejected` event with that rule code; **zero new task/edge rows**; Work Order state unchanged |
| T3 | 3 independent, `maxConcurrentTasks: 3` | 3 tasks `RUNNING` concurrently; population 3 ≤ 5 |
| T4 | 3 independent, `maxConcurrentTasks: 2` | 2 `RUNNING`, 1 `READY` queued; after one leaves `RUNNING` (`SUCCESS`), the third assigns; concurrency never exceeds 2 |
| T5 | dependent blocked | B stays `PLANNED` while A `RUNNING`/`SUCCESS`/`VERIFYING`; B `READY` only after A `VERIFIED` |
| T6 | provisioning + zero at rest | starts at 0 workers; provisions on demand only; never exceeds max 5; each completion's §6.4 release rule returns the worker to `IDLE` and closes its assignment (row retained); after all tasks terminal + clock > 10m → reclaim pass marks all `RECLAIMED`, active population 0 |
| T7 | worktree isolation | per task: unique `factory/task-<id>` branch, distinct worktree path, recorded `baseCommit`; created under the temp root |
| T8 | versioning + replay | commit v1, REPLAN v2 (S5); v1 event/doc unchanged (log immutability); `getActiveDAG` → v2; `projectDAGVersions(events)` reproduces both; store ≡ log |
| T9 | assign guards + atomicity + worker failure | double-assign rejected (`TASK_NOT_READY`/`WORKER_NOT_IDLE`); a failure inside `assign`'s outer transaction rolls back task state + assignment + worker state together (savepoint nesting case); a worker `failed`/evidence-less report completes the Attempt `outcome: 'failed'` and leaves the task `RUNNING` (invariant 9) |

### 7.4 What E3.2 must not do

- No changes to E1 files (`src/factory/domain/*`, `src/factory/state/*`, `src/factory/events/*`, `src/factory/bus/*`, `tests/factory/e1-domain.test.ts`); E1 findings go to the report (§8).
- No real Herdr process, no real Git host, no repo worktree mutation (R5), no LLM planner call inside `proposeDAG` (the planner client is external; v0.1 tests/CLI act as the planner).
- No crash-recovery actions on expired leases (E7), no verification execution (E5), no PR/merge ordering (E6).

---

## 8. E1 findings (no changes made — design is additive)

- **F1 — no schema/code change required.** `workers`/`assignments` collections already exist and store JSON documents; E3's additive fields (`runtimeState`, `lease`, `branch`, `worktreePath`, `baseCommit`) ride the docs. The `assignments` FK columns read only `$.taskId`/`$.workerId`, which E3 keeps.
- **F2 — Work Order lacks the §5.1 "Branch/worktree policy" field.** E1's `WorkOrderIntent`/`WorkOrder` has `repository` only. v0.1 uses scheduler/worktree config defaults (`baseBranch: main`). A per-WO branch/worktree policy would be an additive E1 extension — deferred to E2/E6; noted, not changed.
- **F3 — E1's projector skips unknown payload shapes.** Fine by design: `dag.*`/`worker.*`/`assignment.*` events intentionally live outside E1's `FactoryProjection`; E3 provides `projectDAGVersions` for its own fold. `task.created` events from `commitDAG` reuse E1's exact payload shape, so E1 replay remains exactly correct. Superseded tasks appear in E1's `WorkOrderSnapshot` — consumers filter via the active DAG (§4.2).
- **F4 — `Task.dependsOn` vs `task_dependencies` duplication (known E1 deferred minor).** Ruled here: the row field and the edge rows are two projections of the same commit-transaction facts; invariant V-agree (§2.3) + T1/T8 keep them consistent. The version doc is the source both derive from.
- **F5 — nested transactions verified.** Bun 1.4.2 nests `db.transaction` as savepoints (verified empirically for this design): E1-style inner transactions roll back with a failing outer transaction. `assign` relies on this; T9 covers it.

## 9. Handoffs and deliberate v0.1 boundaries

- **E4 (#16/#17):** skill/model routing — envelope `skills`/`model` fields stay null/empty until routing lands; `Attempt.model` (E1) is where assignments record it.
- **E5 (#21):** drives `SUCCESS → VERIFYING → VERIFIED` on E3's tasks; `verification requests` flow through the worker result; Evidence Bundle consumes Attempt/worktree provenance.
- **E6 (#22):** merge ordering — a dependent's `baseCommit` is the base branch at assign time; folding a dependency's *branch* into a later task's base is the PR/merge flow's concern.
- **E7 (#19):** plugs `check()` into `SchedulerPolicy`; owns lease expiry reconciliation (`SUSPECT`/`UNREACHABLE`), cancellation (which unblocks REPLAN-while-`WAITING_INPUT`), crash reconcile of the PLANNING→EXECUTING window, and `WAITING_RESOURCE`.
- **E2 (#12–#15 lane C):** consumes `status()`, drives the §12 question loop for `WAITING_INPUT` tasks, and applies the orchestrator's WO transitions around commits.

## 10. Acceptance-criteria mapping

| Sub-issue #14 criterion | Where |
|---|---|
| DAG proposal/validation spec written; invalid DAG examples rejected on paper | §2 (format), §3 (rules + V1 + I1–I8, each with recorded rejection and store-unchanged invariant) |
| Scheduler design covers 2–3 concurrent, blocked dependents, min0/max5 provisioning | §5 (§5.3 passes, §5.4 S1–S4; defaults §7.2) |
| Spec recorded in docs/superpowers/plans/ | this file |
