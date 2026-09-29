# Routing Decision Log + Provenance (E4.2)

- **Status:** Accepted for Factory Server v0.1 routing (epic `coderhd/factory#4`, sub-issue `#17`)
- **Builds on:** [decision-model-routing-core.md](decision-model-routing-core.md) (E4.1 core), [ADR 13](../decisions/adr-13-generic-decision-model.md)
- **Authority:** design spec §8 (every routing recommendation is recorded); [software-factory-decision-models.md](software-factory-decision-models.md); [s1s2 routing design](../../docs/superpowers/specs/2026-09-28-s1s2-routing-design.md) §4–§6
- **Code:** `src/factory/routing/persist.ts`, `src/factory/routing/log.ts`, `src/factory/routing/ticketFields.ts`
- **Dev precedent (reference only):** `.opencode/plugins/factory-guard/routing-policy.md` §6, `.factory/routing.log`

## 1. What is recorded

Every routing decision — rules selection or applied manual override — folds into a
`RoutingDecisionRecord` (`src/factory/routing/decisionModel.ts`) carrying the full
provenance: task, complexity, risk, context, selected model, the ordered candidate
list, the human-readable reason, the unavailable set, and the budget snapshot it
passed the gates with. `persistRoutingDecision(deps, record)` (deps-first, ruling R9)
stores it in E1's `routing_decisions` collection **and** appends a
`routing.decision_recorded` event (`aggregateType: 'routing_decision'`,
`aggregateId: <record.id>`, payload `{ record }`) in one `store.db.transaction`,
mirroring `createWorkOrder`: a failing event append rolls the row back, so state and
log can never disagree.

### Structured source marker

`RouteDecision.source` is `'rules' | 'override'` and is the **only** authority for a
record's `source`; `toRoutingDecisionRecord` reads it from the decision, and
`RoutingProvenance` deliberately carries no source label at all. This
kills the misattribution the E4.1 review flagged: when `/route <model>` names an
unavailable model, selection falls back to the rules and the decision is marked
`rules` — no `reason`-string parsing involved, and no caller-side field that could lie.

## 2. `routing.log` line format

One decision per line, one compact JSON object per decision: the
`RoutingDecisionRecord` fields in this fixed order — no spaces, no trailing newline
in the formatted string (hosts append `\n` when writing):

`id`, `workOrderId`, `taskId`, `source`, `task`, `complexity`, `risk`, `context`,
`selected`, `candidates`, `reason`, `unavailable`, `budget`, `createdAt`

- `id` / `workOrderId` / `taskId` — record id (`rd_*`) and the E1 entities it is
  keyed to (`null` when the decision has no Work Order or Task yet).
- `source` — `'rules' | 'override'`, the structured marker above.
- `task`, `complexity`, `risk`, `context` — the `RouteInput` shape the decision was
  made from (generic capability vocabulary; never provider-specific).
- `selected` — the assigned model identifier (opaque, deployment-defined).
- `candidates` — the ordered capability list the gates walked.
- `reason` — the human-readable explanation from the selector.
- `unavailable` — models the availability gate skipped.
- `budget` — the `{ monthlyRemaining, weeklyRemaining, fiveHourRemaining }` snapshot
  (fractions 0..1) the gates passed with.
- `createdAt` — ISO-8601 timestamp of the decision.

Example line (produced byte-for-byte by `formatRoutingLogLine`; pinned by
`tests/factory/e4-routing.test.ts`):

`{"id":"rd_doc_1","workOrderId":"wo_doc_1","taskId":"task_doc_1","source":"rules","task":"documentation","complexity":"complex","risk":"medium","context":"large","selected":"implementer","candidates":["implementer","generalist","explorer"],"reason":"task=documentation, complexity=complex, risk=medium, context=large -> implementer (cheap tier; budget m=100%/w=100%/5h=100%).","unavailable":["explorer"],"budget":{"monthlyRemaining":1,"weeklyRemaining":1,"fiveHourRemaining":1},"createdAt":"2026-09-30T09:00:00.000Z"}`

The formatter is pure and deterministic: identical records render identical bytes
regardless of object key insertion order. The durable store stays the source of
truth; the log is a rendering of the same record (dev environment writes it to
`.factory/routing.log`; runtime hosts choose their sink). E8 telemetry consumes
these records/log lines later — nothing here wires telemetry in.

## 3. Override path

`/route <model>` always wins over the rules recommendation and is recorded with
`source: 'override'` (`applyOverride`, `decision-model-routing-core.md` §6). Overrides
are **not budget-gated** — a human asking for a specific model is a priced exception —
but the record still carries the full budget snapshot, so the cost is auditable from
the log alone. If the override model is unavailable, selection falls back to the
rules and the record is marked `source: 'rules'`.

## 4. Appeal path

The appeal pattern (s1s2 design §3, dev `/appeal`): when admission confidence/margin
falls below the locked threshold, the ticket/session is routed to a stronger model
for adjudication **outside the live path**, and the adjudicated decision is recorded
with the same provenance as any other — an appeal verdict is a `RoutingDecisionRecord`
too, not a special log shape. Disagreements between the classifier and the rules set
`disputed` on the ticket for human review instead of auto-winning (see §5). Runtime
thresholds and the adjudicating model are deployment policy; nothing in the runtime
semantics names them.

## 5. Ticket routing fields

Tickets carry the decision. The field set (`src/factory/routing/ticketFields.ts`)
mirrors the tracker template in `docs/agents/issue-tracker.md` ("Ticket body
fields"): `complexity:`, `model:`, `confidence:`, `disputed:`, `router-version:`.

| Field | Type | Rule |
|---|---|---|
| `complexity` | `trivial \| simple \| normal \| complex` | routing capability vocabulary |
| `model` | non-empty string | opaque deployment-defined ModelId |
| `confidence` | number | finite, `0..1` inclusive |
| `disputed` | boolean | set when rules and classifier disagreed |
| `router-version` | non-empty string | version stamp of the deciding router |

`validateTicketRoutingFields(raw)` returns `{ ok, errors }` with one field-prefixed
error per offending field. The ticket-routing-fields test asserts a complete block
passes, malformed blocks (missing/out-of-range `confidence`, unknown `complexity`,
missing `router-version`, non-boolean `disputed`, empty/missing `model`, non-object
input) are rejected, and that the tracker template still documents all five fields.

## 6. Testing

`tests/factory/e4-routing.test.ts` (E4.2 describes) covers: the structured source
marker including the override-fallback misattribution case, `persistRoutingDecision`
round-trip + event + rollback-on-failing-append atomicity, byte-stable log-line
formatting against the pinned example line, the example line's presence in this doc,
and the ticket-fields validator against the tracker template. The provider-leak guard
now globs `src/factory/routing/**/*.ts`, so every routing source (this task's
included) stays free of concrete provider/model identifiers.
