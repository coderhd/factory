# Operating the Factory Server (v0.1)

A practical guide to running a Factory deployment: what `factory start` is, how to create the first Work Order and DAG, what the Factory does automatically, and where the human loops are.

> The Factory is a **verification-first control plane**. It owns execution state; coding-agent harnesses (opencode, run inside a long-lived herdr server) do the work; a separate independent judge verifies it. The surface is an HTTP API plus the `factory` CLI, plus a small **read-first web UI** the server serves at `/`: a live dashboard, Work Order detail with the `WO → Task → Attempt → trace → verification → evidence → decision` drill-down, and an orchestrator chat panel. The UI is reached **without a token for reads**; every mutation it offers requires the operator's bearer token.

---

## 0. Concepts in one screen

| Term | What it is |
|---|---|
| **Work Order (WO)** | The central primitive: intent + acceptance criteria + risk tier. Lifecycle: `DRAFT → READY → PLANNING → EXECUTING → VERIFYING → EVIDENCE_READY → HUMAN_GATE → APPROVED → MERGED` (plus `WAITING_INPUT`, `FAILED`, `REWORK`, `REJECTED`). |
| **Task** | A node of the Work Order's DAG. Lifecycle: `PLANNED → READY → ASSIGNED → RUNNING → VERIFYING → VERIFIED` (plus `WAITING_INPUT`, `SUCCESS`, `FAILED`, `REWORK`). |
| **Attempt** | One execution of a Task by a harness. Records model/worker/context/diff/verification. |
| **Worker environment** | A single long-lived herdr workspace the Factory owns; per Attempt it opens an isolated **tab** and starts an **opencode** harness there, then closes it (zero at rest). |
| **Evidence Bundle** | The immutable receipt for a change set: every acceptance criterion → proof, gates, provenance. |
| **DecisionModel** | Generic routing seam: capability id → concrete model (configured in `factory.yaml`). |

---

## 1. Prerequisites

1. **herdr running** (it is a long-lived server, started once):
   ```bash
   herdr status          # should report server: running
   ```
2. **A configured deployment** — a directory containing `factory.yaml` (the deployment directory). Start from a template:
   ```bash
   cd /path/to/deployment
   factory init          # writes factory.yaml (rewrites the file; comments are dropped)
   ```
   Key sections to set:
   - `repository.path` — the local repo Task worktrees are created from.
   - `workers.models` — capability id → concrete opencode model. **Required for dispatch** (an unmapped routed id fails loud).
   - `verification:` — the judge + deterministic checks. **Absent, a Task reaching SUCCESS parks** (no promotion).
   - `github:` — optional; enables `github import` / PR opening (token is an **env-var reference**, never the token itself).
   - `policy:` / `policyFile:` — optional; overrides the embedded policy.
3. **opencode** available to herdr as a harness kind (`herdr agent` lists `opencode`).

---

## 2. Start / stop / status

```bash
factory start  --dir <deployment>              # foreground
factory start  --dir <deployment> --detached   # background (writes runtime.json)
factory status --dir <deployment>              # {"status":"running","url":"http://127.0.0.1:<port>", ...}
factory stop   --dir <deployment>
```

Useful overrides: `--port <n>`, `--hostname <addr>`. A non-loopback hostname **requires** `server.auth` or the server refuses to start (fail-closed).

> Port conflict (e.g. `8787` already used): change `server.port` in `factory.yaml` or pass `--port <free-port>`.

---

## 3. The first step after starting: create a Work Order

The Factory does **not** invent work. You hand it a Work Order, then a DAG.

### Option A — submit a Work Order directly

```bash
factory wo submit --intent "Add CSV export to the reports page" \
  --acceptance "Export button downloads a CSV of the current report" \
  --acceptance "CSV columns match the on-screen table" \
  --url http://127.0.0.1:<port>
```

Creates a `DRAFT` Work Order and prints its id.

### Option B — import a GitHub issue (reconciles to a Work Order)

```bash
factory github import --repo owner/name --issue 42 --url http://127.0.0.1:<port>
```

Idempotent: re-importing the same issue returns the same Work Order.

---

## 4. Move the Work Order to PLANNING, then commit a DAG

The first DAG commit requires the Work Order in **PLANNING**. The transitions are Factory-owned; the API exposes them (the CLI has no `wo transition` command yet):

```bash
curl -s -X POST http://127.0.0.1:<port>/api/work-orders/<woId>/transition \
  -H 'content-type: application/json' -d '{"to":"READY"}'
curl -s -X POST http://127.0.0.1:<port>/api/work-orders/<woId>/transition \
  -H 'content-type: application/json' -d '{"to":"PLANNING"}'
```

Then commit the DAG:

```bash
factory wo plan <woId> --dag dag.json --url http://127.0.0.1:<port>
```

This validates the proposal and commits **DAG v1** (versions are append-only; a later commit preserves v1). It creates the Task rows and the dependency edges.

---

## 5. The DAG file — format and rules

A DAG proposal is a JSON document:

```json
{
  "rationale": "Split the export feature into a data layer and a UI layer; the UI depends on the data layer.",
  "nodes": [
    {
      "nodeId": "n1",
      "title": "Add a CSV serialiser for the report model",
      "notes": "Pure function; no UI changes. Acceptance: unit tests cover empty rows and unicode.",
      "dependsOn": []
    },
    {
      "nodeId": "n2",
      "title": "Add the Export CSV button and wire it to the serialiser",
      "notes": "Acceptance: clicking Export downloads a CSV matching the table columns.",
      "dependsOn": ["n1"]
    }
  ]
}
```

**Fields**
- `nodes` (required) — the Task nodes.
  - `nodeId` (required) — planner-local, unique within the payload, non-empty string.
  - `title` (required) — non-empty string; becomes the Task title the harness works from.
  - `dependsOn` (optional) — array of `nodeId`s that must reach `VERIFIED` before this node is dispatched.
  - `notes` (optional) — extra context for the harness (acceptance detail, constraints).
- `rationale` (optional) — why this decomposition.

**Validation rules (the Factory validates; an invalid DAG is rejected with `DAG_INVALID` and nothing is written)**
- Acyclic — no dependency cycles.
- Every `dependsOn` entry references a node that exists in the payload.
- No self-dependency.
- Unique, non-empty `nodeId`s; non-empty `title`s.
- The Work Order must be in `PLANNING` (`DAG_WO_STATE` otherwise).

---

## 6. What the Factory does automatically (no further action)

Once the DAG is committed, the scheduler ticks (default `tickIntervalMs: 1000`) and, **with no commands from you**:

1. **Unblocks** — a Task whose dependencies are all `VERIFIED` becomes `READY` (root Tasks are `READY` immediately).
2. **Provisions** — demand-driven workers up to `scheduler.provisioning.max` (default 5), min 0.
3. **Routes** — a `READY` Task gets a model from the DecisionModel (capability id → `workers.models`), persisted to `routing_decisions`.
4. **Assigns** — the policy gate (`repo.write` on the task's worktree branch) must return `ALLOW`; a blocked route leaves the Task `READY` and surfaces in `status`.
5. **Executes** — the Factory opens an isolated herdr **tab** in its own workspace, at the Task's worktree (`branch + worktree + baseCommit`), and starts an **opencode** harness; the harness is prompted with the Task, works, commits, and writes `<worktree>/.factory/report.json`.
6. **Collects** — the Factory reads the worktree's git diff/commits plus the report.
7. **Verifies** — deterministic checks run in the worktree (`verification.checks`), then an independent **judge harness** (fresh pane, different model/family) attempts to falsify each acceptance criterion.
8. **Gates** — a passing bundle drives the Work Order to `EVIDENCE_READY → HUMAN_GATE`; a failure drives `REWORK`.
9. **Reclaims** — idle harnesses/tabs are closed; zero at rest.

> **On "check for ready tickets and claim work":** the auto-claim applies to **Tasks** (the scheduler above). There is currently **no background poller that watches GitHub for issues in a "ready" state** — importing issues is a manual `factory github import`. That poller is a planned extension, not present in v0.1.

---

## 7. Human loops (the Factory stops and asks)

The Factory spends human attention only at decision boundaries.

```bash
# A Task asked a question (Task is WAITING_INPUT)
factory wo answer <interactionId> "<answer>" --url http://127.0.0.1:<port>

# A policy check requires a human (REQUIRE_HUMAN park)
factory approvals list --url http://127.0.0.1:<port>
factory approvals answer <approvalId> --decision APPROVAL|DENY --actor <you> --url ...

# Work Order at the human gate
curl -s -X POST http://127.0.0.1:<port>/api/work-orders/<woId>/decision \
  -H 'content-type: application/json' -d '{"decision":"APPROVE"}'
```

Emergency controls:

```bash
factory control status --url http://127.0.0.1:<port>
factory control emergency-stop --actor <you> --url ...
factory control pause|resume --actor <you> --url ...
```

---

## 8. Observe

```bash
factory wo status <woId> --url http://127.0.0.1:<port>       # WO state + tasks
factory observatory --url http://127.0.0.1:<port>            # verified/day, throughput/human-hour, rework, cost
curl -s http://127.0.0.1:<port>/api/scheduler                # queue, blocked routes, parked recoveries
curl -s http://127.0.0.1:<port>/api/observatory/work-orders/<woId>/drill-down
```

The Observatory drill-down is `Work Order → Task → Attempt → trace → verification → evidence → decision`.

---

## 9. GitHub change-set / merge (optional)

```bash
factory github pr --bundle <evidenceBundleId> --url http://127.0.0.1:<port>
```

A merge is only permitted on a durable `APPROVED` Work Order **and** a policy `ALLOW` for `deploy.execute {env: production}` (which requires a consumed human approval). No self-merge.

---

## 10. Backup / restore

```bash
factory backup  --dir <deployment> --out backup.tar.gz
factory restore backup.tar.gz --into <fresh-dir>          # refuses a non-empty dir unless --force
factory start   --dir <fresh-dir>                        # boots clean from the backup
```

A backup contains state + evidence/artifacts + knowledge + config + versions.

---

## 11. Known gaps in v0.1 (be aware)

- **No automatic GitHub "ready ticket" poller** — imports are manual (`factory github import`).
- **No `factory wo transition` CLI** — moving a WO `DRAFT → READY → PLANNING` is via the API (`POST /api/work-orders/:id/transition`).
- **Verification requires config** — without a `verification:` section a Task reaching SUCCESS parks (fail-closed).
- **Worker models require config** — an unmapped routed capability id fails loud at dispatch.
- **The herdr wire contract is only partly live-verified** — the adapter was corrected against real herdr output, but a full live Attempt (harness prompt → report) has not been exercised end-to-end yet.
- **One Factory per herdr server** — `workers.workspaceLabel` must be unique (do not reuse a label you already have a workspace for).

---

## 12. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `factory start` exits with a config error | Missing/invalid `factory.yaml` section (e.g. a `github:` section without its token env var, or a non-loopback hostname without `server.auth`). |
| Port in use | `server.port` conflict — change it or pass `--port`. |
| Tasks stay `READY` forever | No `workers.models` mapping for the routed capability id, or the policy gate denied (`check /api/scheduler` → `blockedPolicy`). |
| Task reaches `SUCCESS` and parks | No `verification:` section (no judge) — add one. |
| Nothing happens after `wo plan` | The scheduler only dispatches `READY` Tasks; confirm the WO is `EXECUTING` and the DAG committed (`wo status`). |
| Harness never reports | The harness must write `<worktree>/.factory/report.json`; a missing report is a loud failure. |
| `herdr` errors | `herdr status` — the server must be running; the Factory owns only its `workers.workspaceLabel` workspace. |
