# Improvement-as-Work Runbook

## Status

Operator runbook for the Factory Server v0.1 self-improvement loop (E8.2, #25), documenting the shipped E8.1 implementation (#24):

- Loop: `src/factory/improve/loop.ts`
- Telemetry: `src/factory/telemetry/telemetry.ts`
- Tests (behavioral authority): `tests/factory/e8-telemetry.test.ts`

Authoritative upstream: design spec [`../2026-09-17-software-factory-design.md`](../2026-09-17-software-factory-design.md) §23 (Observatory), §24 (Telemetry), §25 (Benchmarking), §26 (Dogfooding With Lekhan), and [`../architecture/self-improving-factory-architecture.md`](../architecture/self-improving-factory-architecture.md) (the four improvement levels). Every claim below names the real function, event type or error code in the shipped code; where the code deliberately stops short, this runbook says so.

## The loop in one paragraph

Self-improvement here is **evaluated change, never an auto-applied edit** (architecture doc: *"Autonomy is delegated authority. Improvement is evaluated change."*). The Factory watches its own telemetry for weaknesses, proposes a Level 1–2 change to itself **as an ordinary Work Order**, benchmarks the named candidate against a baseline on a frozen benchmark corpus, deterministically qualifies or rejects the recorded run, and — only under an explicit human gate — promotes the proposal by starting its Work Order through the ordinary §5.1 lifecycle. Proposing, benchmarking and qualifying change **nothing** about production behavior; promotion starts *work*, which then lands like any other change through verification, evidence and the Work Order's own human gate.

## Invariants (non-negotiable)

1. **Levels 1–2 only.** `IMPROVEMENT_LEVELS = [1, 2]`. Any other level throws `IMPROVEMENT_LEVEL_OUT_OF_SCOPE` from `assertLevel`, which is re-checked at propose, benchmark *and* promote — a proposal cannot age into a higher level.
2. **No weights, no scaffold mutation.** The module "ships no code path that edits control logic, prompts, retrieval, routing, rubrics or model artifacts, and no capability to update model parameters" (loop.ts header). The tests assert the loop is free of production-mutating code.
3. **Never silent behavior change.** Proposals land as Work Orders in `DRAFT`. Only an explicit `promoteImprovement` — and only from state `QUALIFIED` — begins work, and it merely fires the ordinary §5.1 `DRAFT → READY` transition. Before that, production behavior is untouched.
4. **Benchmark corpus distinct from dogfooding** (spec §25/§26). Observations may come from either corpus, but `benchmarkImprovement` accepts only `corpus: 'benchmark'` (`BENCHMARK_CORPUS_REQUIRED` otherwise), and qualification re-checks the recorded run's corpus. *Dogfood results never promote themselves.*
5. **The trail is the evidence.** Proposal state and benchmark evidence live in the append-only event log (`improvement_proposal` aggregate); reads are last-wins (`readImprovement`, `readRecordedBenchmark`). Qualification decides against the **recorded** run, never a caller-supplied object.

## Pipeline at a glance

Stages, in order (`IMPROVEMENT_STAGES`): `observe → propose → benchmark → qualify → promote`.

| Stage | Call | Writes (events / artifacts) | Proposal state after | Who acts |
| --- | --- | --- | --- | --- |
| Observe | `observeImprovements(projectTelemetryMetrics(deps, window))` | nothing — pure, read-only | — | Factory computes; human reviews |
| Propose | `proposeImprovement(deps, input)` | `work_order.created` (DRAFT, YELLOW) + `improvement.proposed` | `PROPOSED` | Human owns the proposal; Factory does the mechanics |
| Benchmark | `benchmarkImprovement(deps, id, input)` | `improvement.benchmarked` (carries the `BenchmarkResult`) | `BENCHMARKED` | Human runs the benchmark harness; Factory validates and records |
| Qualify | `qualifyImprovement(deps, id, benchmark)` | `improvement.qualified` **or** `improvement.rejected` (carries `benchmarkId`) | `QUALIFIED` / `REJECTED` | Factory computes the decision deterministically; human witnesses it in the trail |
| Promote | `promoteImprovement(deps, id)` | `work_order.transitioned` (DRAFT→READY) + `improvement.promoted` (carries `authority: 'human_gate'`) | `PROMOTED` | **Human decision only** — this is the gate |

All improvement events use `aggregateType: 'improvement_proposal'`, `aggregateId: proposal.id` (`imp_…`), and each payload carries the full updated proposal snapshot.

## Telemetry inputs (what "Observe" reads)

Per Attempt, `recordAttemptTelemetry` derives the six spec §24 layers — `outcome, human_leverage, execution, quality, economics, decision` (`TELEMETRY_LAYERS`) — from durable Factory state plus supplied runtime observables, and persists them as one append-only `telemetry.attempt_recorded` receipt on the `attempt` aggregate. Recording never mutates execution state; missing data is an honest `null`/`stub`, never fabricated (the `allowDenyStatus: 'stub'` field is E7's not-yet-recorded policy layer).

Two read models feed the loop:

- `projectTelemetryMetrics(deps, window)` — the Observatory view (spec §23): `verifiedPerDay`, `throughputPerHumanHour`, `rework`, `cost` (a re-recorded Attempt counts once, latest receipt wins).
- `projectDrillDown(deps, workOrderId)` — the full §23 chain `work_order → task → attempt → trace → verification → evidence → human_decision`, used to diagnose *where* a weakness lives before proposing.

## Stage 1 — Observe

- **Entry criteria:** Attempts exist in the observation window with telemetry recorded (`recordAttemptTelemetry`), so `projectTelemetryMetrics` reflects real receipts.
- **What happens:** `observeImprovements(metrics)` returns `ObservedSignal[]` (`{ id, signal, detail, refs }`). The three built-in signals:

  | Signal id | Fires when | Ref |
  | --- | --- | --- |
  | `sig_no_verified_output` | `verifiedPerDay` is empty (nothing verified landed in the window) | `observatory:verifiedPerDay` |
  | `sig_rework` | `rework > 0` | `observatory:rework` |
  | `sig_cost` | recorded model/tool `cost.total > 0` | `observatory:cost` |

- **Writes:** nothing — "observation changes nothing" is enforced by the function being pure over the metrics projection.
- **Exit criteria:** a signal set (possibly empty). Empty means no weakness surfaced this window; keep operating, re-observe later.
- **Human role:** the operator reads the Observatory and decides whether a signal (alone or combined with drill-down evidence) is worth acting on.

## Stage 2 — Propose

- **Entry criteria:** at least one observed weakness, expressed as `ImprovementProposalInput`: `level` (must be 1 or 2), `title`, `intent`, `acceptanceCriteria`, `rationale`, `observedFrom` (the signal ids / telemetry refs), `candidate` (a version identifier, e.g. `experience-digest/v2`), and `corpus` — **where the observation came from** (`'dogfooding'` or `'benchmark'`; dogfooding is a legitimate source, see the corpus section).
- **What happens:** `proposeImprovement`
  1. `assertLevel` — Levels 0/3/4/unknown throw `IMPROVEMENT_LEVEL_OUT_OF_SCOPE`.
  2. Creates a **real, first-class Work Order** via `createWorkOrder` with the proposal's intent and acceptance criteria, `riskTier: 'YELLOW'` (spec §13.1 — everything starts Yellow), state `DRAFT`.
  3. Appends `improvement.proposed` with the snapshot in state `PROPOSED`. Level 1 maps to kind `runtime_adaptation`, level 2 to `experience_memory`.
- **Writes:** `work_order.created` + `improvement.proposed`.
- **Exit criteria:** `{ proposal (PROPOSED), workOrder (DRAFT) }`. The proposal is **inert** — no code runs, nothing is applied.
- **Human role:** a human authors/owns the proposal (the Factory may assist by drafting from signals, but the proposal reflects a decision to change something). The Work Order is an ordinary work order and is editable through ordinary work-order operations — treat that as high-risk tampering with the audit trail, and prefer re-proposing.

## Stage 3 — Benchmark

- **Entry criteria:** proposal exists (`IMPROVEMENT_NOT_FOUND` otherwise) and is in `PROPOSED`, `BENCHMARKED` or `REJECTED` (`BENCHMARKABLE_STATES`); level re-asserted. The operator has run **baseline and candidate configurations on the same frozen benchmark-corpus Work Orders** (spec §25: "Configurations should be compared on the same Work Orders") and holds the eight §25 metrics for each run: `verifiedOutcome, humanEffort, wallTimeMinutes, cost, firstPass, rework, quality, interventions` (`BenchmarkMetrics`).
- **What happens:** `benchmarkImprovement(deps, proposalId, { corpus, baseline, candidate })`
  - Rejects any `corpus` other than `'benchmark'` with `BENCHMARK_CORPUS_REQUIRED` — a dogfooding run can never enter the qualification evidence chain.
  - Records a `BenchmarkResult` (`bench_…`, `corpus` fixed to `'benchmark'`, copied metric sets, timestamp) and appends `improvement.benchmarked` carrying it; state → `BENCHMARKED`.
- **Writes:** `improvement.benchmarked` (event payload: updated proposal + benchmark).
- **Exit criteria:** the run sits in the trail; `readRecordedBenchmark` returns it as the *latest* recorded evidence. Re-benchmarking (allowed from PROPOSED/BENCHMARKED/REJECTED) appends a newer run; only the newest one can qualify.
- **Human role:** humans operate the benchmark harness and supply both metric sets; v0 ships no built-in runner (see Boundaries). The Factory's contribution is the corpus gate, the metric schema, and durable recording.

## Stage 4 — Qualify

- **Entry criteria:** proposal is in `BENCHMARKED` (`IMPROVEMENT_NOT_BENCHMARKED` otherwise) and the caller passes the benchmark run they mean to decide on.
- **What happens:** `qualifyImprovement` turns the recorded run into a decision — under the **trail-binding guards**, which are the point of this stage:
  - `benchmark.proposalId` must equal the proposal (`IMPROVEMENT_BENCHMARK_MISMATCH` otherwise) — a run from another improvement cannot decide this one.
  - The run must be the one recorded in the trail: `benchmark.id === recorded.id` (`IMPROVEMENT_BENCHMARK_MISMATCH` otherwise). The caller's object is accepted **only as an id-checked reference**; the decision recomputes from `readRecordedBenchmark`, so nobody can hand-write "improving" metrics for a run that actually regressed.
  - The recorded run's corpus must be `'benchmark'` (`BENCHMARK_CORPUS_REQUIRED`) — belt-and-braces over the trail.
  - The decision rule `isImprovement(recorded.baseline, recorded.candidate)`: **verified outcome holds** (`verifiedOutcome >= baseline`), **rework does not grow** (`rework <= baseline`), and **at least one efficiency lever strictly improves**: `humanEffort <`, `cost <`, or `firstPass >`.
- **Writes:** `improvement.qualified` (state `QUALIFIED`) or `improvement.rejected` (state `REJECTED`); either carries `benchmarkId` naming the recorded run.
- **Exit criteria:** a decision recorded. **Qualification changes no production behavior** — it is bookkeeping of "this candidate earned promotion", nothing more.
- **Human role:** the pass/fail is deterministic, not a judgment call; the human reviews the event (all eight metrics are in the recorded run — `wallTimeMinutes`, `quality` and `interventions` are recorded for human scrutiny even though the automatic gate doesn't read them) and decides what to do next: promote, or iterate.

## Stage 5 — Promote

- **Entry criteria:** proposal is `QUALIFIED` (`IMPROVEMENT_NOT_QUALIFIED` otherwise — an unqualified or rejected proposal cannot be promoted, full stop); level re-asserted.
- **What happens:** `promoteImprovement(deps, proposalId)`
  - Calls `transitionWorkOrder` on the proposal's Work Order: `to: 'READY'`, reason `'improvement promoted under human gate'` — **the ordinary §5.1 `DRAFT → READY` edge**. The loop starts work through the same state machine every other change must pass; if the Work Order has left `DRAFT` by other means, `transitionWorkOrder` throws `INVALID_TRANSITION`, the `improvement.promoted` event is *not* appended, and the proposal correctly stays `QUALIFIED`.
  - Appends `improvement.promoted` carrying `authority: 'human_gate'` and returns `{ authority: 'human_gate' }`; state → `PROMOTED`.
- **Writes:** `work_order.transitioned` + `improvement.promoted`.
- **Exit criteria:** the improvement is now ordinary scheduled work. It lands only by running the normal pipeline — PLANNING → EXECUTING → VERIFYING → EVIDENCE_READY → HUMAN_GATE → APPROVED → MERGED — with all the same verification and human-gate rules as any Work Order. **The loop itself never applies an edit.**
- **Human role:** this step is a human decision, structurally gated three ways: it requires `QUALIFIED` (so requires a recorded, benchmark-corpus, trail-bound passing run), it re-checks the level, and the event permanently stamps `authority: 'human_gate'`. The code does not authenticate the caller — the operator rule is that `promoteImprovement` runs **only when a human who has reviewed the proposal and its qualifying benchmark says so**. Never promote from a scripted or implicit path; that is precisely the "silent behavior change" this loop exists to prevent.

## Proposal state machine

```text
PROPOSED    ── benchmark ─▶ BENCHMARKED   (corpus gate: 'benchmark' only)
BENCHMARKED ── qualify   ─▶ QUALIFIED     (isImprovement passes)
BENCHMARKED ── qualify   ─▶ REJECTED      (isImprovement fails)
REJECTED    ── benchmark ─▶ BENCHMARKED   (explicit iteration; must qualify again)
QUALIFIED   ── promote   ─▶ PROMOTED      (the only step that starts the Work Order)
```

Any other (stage, state) pair is refused by the guards above.

- Forward-only by design: `QUALIFIED` and `PROMOTED` cannot regress to `BENCHMARKED` — `benchmarkImprovement` throws `IMPROVEMENT_NOT_BENCHMARKABLE`, its message stating the reason: "it is forward-only (QUALIFIED records a decision, PROMOTED starts work)". A recorded decision and a started Work Order never silently rewind.
- `REJECTED → BENCHMARKED → (QUALIFIED|REJECTED)` is allowed: fixing a candidate and re-running the benchmark is explicit iteration, and the re-run must pass qualification again on its own evidence.
- Proposal state is reconstructed from the trail: `readImprovement(events, id)` returns the snapshot from the last `improvement.*` event.

## Benchmark corpus vs. Lekhan dogfooding

Spec §25: "Production telemetry is distinct from the benchmark suite… The benchmark must remain distinct from Lekhan dogfooding." Spec §26: "Lekhan is the primary dogfooding environment. It is not itself the benchmark." The code encodes this as two corpus constants — `BENCHMARK_CORPUS = 'benchmark'` ("never the dogfooding environment") and `DOGFOODING_CORPUS = 'dogfooding'` ("an input, not benchmark evidence").

| | **Dogfooding (Lekhan)** | **Benchmark corpus** |
| --- | --- | --- |
| What it is | Real Lekhan roadmap work flowing through the Factory: live Work Orders, real deadlines, one run each, changing week to week | A frozen suite of 10–30 representative Work Orders (spec §25), snapshotted/extracted from the Lekhan roadmap (≈5–10, spec §26) and pinned so they stay stable as Lekhan moves |
| What belongs in it | Every real task Lekhan actually needs — including messy, urgent, unusual ones. If it exposes a limitation, that's a *signal* | Representative tasks spanning the qualities spec §25 lists: dependency edges (multi-Task DAGs), acceptance-criteria-driven changes, multiple technical domains, real-world implementation complexity. Same pinned Work Orders replayed for baseline and candidate |
| What it produces | `telemetry.attempt_recorded` receipts → Observatory metrics (`projectTelemetryMetrics`) → `observeImprovements` signals | `BenchmarkResult` runs recorded by `benchmarkImprovement` — the *only* accepted qualification evidence |
| Role in the loop | Input to Observe; may be tagged as a proposal's `corpus` (where the weakness was seen); production ground truth | Evidence that qualifies a candidate for promotion |
| Can it promote anything? | **No.** A dogfooding run fails `benchmarkImprovement` with `BENCHMARK_CORPUS_REQUIRED` | Yes — but only after `qualifyImprovement` passes and a human promotes |

**Concrete worked example.** This week, Lekhan's real "add CSV export" Work Order needed three Attempts to verify — dogfooding telemetry fires `sig_rework`. That motivates a Level 2 proposal (`candidate: 'experience-digest/v2'`, `corpus: 'dogfooding'`, `observedFrom: ['sig_rework']`) — the dogfood traffic *is* the right reason to propose. But the candidate is qualified by running the **frozen corpus** — e.g. ten pinned Work Orders extracted from earlier Lekhan milestones (the dependency-edge onboarding DAG, the schema-migration + API + CLI cross-domain change, …) — once under the current configuration (baseline) and once under `experience-digest/v2` (candidate), and recording that run with `corpus: 'benchmark'`. If someone instead tried to qualify with "look at this week's dogfood numbers", the code refuses: `BENCHMARK_CORPUS_REQUIRED`.

**Why the separation is real, not ceremony.** (1) A candidate tuned to *this week's* traffic (e.g. memorizing one repo's CI flakiness) can look great in dogfooding and generalize nowhere — dogfooding results must never self-promote. (2) Dogfooding is never re-runnable, so a baseline-vs-candidate comparison there is impossible; §25 requires "the same Work Orders". (3) The converse discipline holds too: §25 warns "Do not optimize solely for public benchmark scores. The Factory's own production outcomes matter more" — which is why observations *come from* dogfooding even though qualification comes from the benchmark.

## Levels: 1–2 only, nothing more

Definitions from [`../architecture/self-improving-factory-architecture.md`](../architecture/self-improving-factory-architecture.md):

| Level | Name | In v0.1? | In code |
| --- | --- | --- | --- |
| 1 | Runtime adaptation — temporary adaptation inside an Attempt | ✅ | `kind: 'runtime_adaptation'` |
| 2 | Experience / memory — experience becomes future context, no weight change | ✅ | `kind: 'experience_memory'` |
| 3 | Scaffold — prompts, skills, retrieval, context policies, routing, verifier rubrics, tool selection, graph topology | ❌ out of scope | rejected by `assertLevel` |
| 4 | Model — fine-tuning / replacement of the model itself | ❌ out of scope | rejected by `assertLevel` |

The guard fires at **three** points (`proposeImprovement`, `benchmarkImprovement`, `promoteImprovement`), so a Level 3/4 proposal cannot exist, cannot be benchmarked into the evidence chain, and cannot be promoted even if the trail is replayed. There is no weights capability anywhere: nothing in the loop can update model parameters or mutate the scaffold. (A *new external model* is not self-improvement and gets no production authority automatically — the architecture doc's "Model replacement" rule; treating external model versions as candidates would be future Level-adjacent work, not a loop bypass.)

Concrete Level 1/2 candidates that fit v0.1's shape: an in-Attempt retry/context-recovery policy (Level 1), or a digest of prior Attempt experience injected as future retrieval context (Level 2, as in the test's `experience-digest/v2`). Both are *evaluated changes promoted as Work Orders* — the loop is how they land, not whether they're allowed to land silently.

## Never silent behavior change — how to audit it

The loop's own header: "proposing, benchmarking and qualifying change **nothing** about production behavior, and promotion only starts the Work Order through the ordinary §5.1 edge." To verify on any deployment:

1. **Nothing before promote is real work.** The proposal's Work Order stays `DRAFT` until `improvement.promoted` exists. Query: for each `improvement_proposal` aggregate, the Work Order reached `READY` only if an `improvement.promoted` event exists, and it references a `QUALIFIED` proposal.
2. **Every decision is trail-attributed.** Each `improvement.qualified` / `improvement.rejected` carries a `benchmarkId` that names an `improvement.benchmarked` run with `corpus: 'benchmark'` (`readRecordedBenchmark` / `readImprovement` reconstruct it).
3. **The only behavior-affecting step is human-gated.** `improvement.promoted` events are the complete list of improvements that started landing; each stamped `authority: 'human_gate'`; each followed by the Work Order's ordinary §5.1 transitions — including its own `HUMAN_GATE` — before any merge.
4. **The module is provably inert beyond recording.** The tests scan `loop.ts` for production-mutating capabilities ("keeps the loop free of production-mutating code (no weights, no scaffold mutation)").

## Operator walkthrough

```ts
import { projectTelemetryMetrics, recordAttemptTelemetry } from '../src/factory/telemetry/telemetry';
import {
  observeImprovements, proposeImprovement, benchmarkImprovement,
  qualifyImprovement, promoteImprovement,
} from '../src/factory/improve/loop';

const deps = { store, events }; // ImprovementDeps = same store + EventLog as the rest of E1

// 1. Observe (read-only)
const signals = observeImprovements(projectTelemetryMetrics(deps, { from: '2026-09-01' }));

// 2. Propose — lands as a DRAFT Work Order; changes nothing
const { proposal, workOrder } = proposeImprovement(deps, {
  level: 2,
  title: 'Digest repeated context',
  intent: 'Feed prior Attempt experience into future context',
  acceptanceCriteria: ['rework drops without model changes'],
  rationale: 'rework observed in telemetry',
  observedFrom: signals.map((s) => s.id),
  candidate: 'experience-digest/v2',
  corpus: 'dogfooding', // where the weakness was seen — allowed as an *input*
});

// 3. Benchmark — human runs baseline & candidate over the frozen corpus, records both
const { benchmark } = benchmarkImprovement(deps, proposal.id, {
  corpus: 'benchmark', // anything else: BENCHMARK_CORPUS_REQUIRED
  baseline, candidate, // the eight spec §25 metrics per side
});

// 4. Qualify — deterministic decision against the RECORDED run
const decision = qualifyImprovement(deps, proposal.id, benchmark); // QUALIFIED | REJECTED

// 5. Promote — ONLY on a human decision, and only if decision.state === 'QUALIFIED'
const promoted = promoteImprovement(deps, proposal.id); // WO DRAFT→READY, authority: 'human_gate'
// From here it is ordinary Work Order lifecycle: plan → execute → verify → evidence → human gate.
```

## Failure reference

| Error code | Thrown by | Meaning / operator action |
| --- | --- | --- |
| `IMPROVEMENT_LEVEL_OUT_OF_SCOPE` | `assertLevel` in propose / benchmark / promote | Someone asked for Level 0/3/4 (scaffold, model, weights) — refuse; v0 is Levels 1–2 |
| `IMPROVEMENT_NOT_FOUND` | benchmark / qualify / promote | Unknown `imp_…` id — check the proposal id |
| `IMPROVEMENT_NOT_BENCHMARKABLE` | `benchmarkImprovement` | Proposal is `QUALIFIED`/`PROMOTED` — the machine is forward-only; open a new proposal for a new iteration |
| `BENCHMARK_CORPUS_REQUIRED` | `benchmarkImprovement` / `qualifyImprovement` | A dogfooding corpus tried to enter the evidence chain — re-run on the frozen benchmark corpus |
| `IMPROVEMENT_NOT_BENCHMARKED` | `qualifyImprovement` | No recorded benchmark run — benchmark first |
| `IMPROVEMENT_BENCHMARK_MISMATCH` | `qualifyImprovement` | The referenced run is another proposal's or not the latest recorded one — always re-read via `readRecordedBenchmark` |
| `IMPROVEMENT_NOT_QUALIFIED` | `promoteImprovement` | Promotion attempted on PROPOSED/BENCHMARKED/REJECTED — there is no path around qualification |
| `INVALID_TRANSITION` (E1) | `transitionWorkOrder` inside promote | The proposal's Work Order left `DRAFT` outside the loop; promote fails cleanly, proposal stays `QUALIFIED` |
| `WORK_ORDER_NOT_FOUND` (E1) | promote | The linked Work Order no longer exists — investigate; do not hand-append events |

## v0 boundaries (honest gaps)

- **No built-in benchmark runner.** `benchmarkImprovement` records operator-supplied `BenchmarkMetrics` behind a structural, corpus-gated, append-only interface; producing the numbers (replaying the frozen corpus under both configurations) is manual/operator tooling for now. The trail-binding guards ensure qualification can never outrun what was actually *recorded*, but the harness remains external.
- **The automatic gate reads 5 of the 8 metrics.** `isImprovement` gates on verified-outcome hold, rework non-growth, and effort/cost/first-pass improvement; `wallTimeMinutes`, `quality`, `interventions` are recorded for human review but do not fail the candidate automatically. A candidate with flat quality metrics can still auto-qualify — a human reviewing the `improvement.qualified` event before promoting is the backstop (and promotion is where the real gate is).
- **`human_gate` is stamped, not authenticated.** The event records `authority: 'human_gate'` as a durable marker of the decision; the calling surface must keep it human-only by convention and process.
- **The allow/deny decision layer is a stub.** Until E7 records `policy_decisions`, telemetry's `allowDenyStatus` honestly reports `'stub'` — a gap for the decision layer, not for improvement qualification.
- **Proposals are event-sourced only.** There is no `improvements` state table; `readImprovement`/`readRecordedBenchmark` reconstruct from the trail. Tooling that lists open proposals reads the event log.

## Sources

- Design spec §5.1 (Work Order lifecycle), §13.1 (risk tiers), §23 (Observatory), §24 (Telemetry), §25 (Benchmarking), §26 (Dogfooding With Lekhan)
- [`../architecture/self-improving-factory-architecture.md`](../architecture/self-improving-factory-architecture.md) — four levels, "Improvement is Work", no uncontrolled self-modification
- [`../architecture/decision-model-routing-core.md`](../architecture/decision-model-routing-core.md) / [`../architecture/routing-decision-log.md`](../architecture/routing-decision-log.md) — E4, whose `routing_decisions` records the decision telemetry layer consumes
- `src/factory/improve/loop.ts`, `src/factory/telemetry/telemetry.ts`, `tests/factory/e8-telemetry.test.ts` — the shipped behavior this runbook documents
