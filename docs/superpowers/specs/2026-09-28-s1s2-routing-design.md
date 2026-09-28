# Coherent System-1 + System-2 Routing — Design

**Date:** 2026-09-28
**Status:** Draft for review
**Scope:** OpenCode development environment ONLY (factory-guard plugin + ticket
toolchain). NOT Factory runtime. Pattern must stay portable to runtime later.
**Baseline this extends:** `docs/superpowers/specs/2026-09-25-factory-dev-workflow-design.md`
(Track A + Track B), `.opencode/plugins/factory-guard/router.ts`,
`routing-policy.md`, the 87-case eval corpus with 80/20 train/verify split.

## 1. Intent

Replace per-turn model guessing with a coherent pipeline where a cheap,
fast System 1 classifies and verifies, a capable System 2 executes and
adjudicates, and the Factory (policy code + human review) retains authority.
Success looks like: every task starts on the right model with the session
pinned, switches are rare/priced/logged, and every routing mistake becomes
labeled data instead of a repeated tax.

## 2. Non-negotiable constraints (carried over)

- `DecisionModel` stays generic. No `JevDecisionModel`, no `SpanDecisionModel`,
  no reasoning-model type in the interface. Challengers implement the seam.
- Jev, Span-01/Lite, Laya, and any reasoning judge stay **shadow-only** until
  a pre-registered bar is beaten on the verify split. Rules are the live path.
- Writer and verifier stay separate (agents, commands, hooks).
- Go budgets (5h = 20%, weekly = 50%, monthly) are first-class routing inputs.
  Cheap models absorb volume; escalation models need healthy budgets.
- No Factory runtime changes. No Go model IDs or Go budgets in any semantics
  runtime would inherit — they live in the plugin's mapping layer only.
- No vendor benchmark percentages without in-repo repro.

## 3. Architecture: layered pipeline with adjudication on uncertainty

```text
Admission (ticket time)          Execution (task time)           Close
─────────────────────            ─────────────────────           ─────
planner proposes                 session starts PINNED           worker reports
{task,complexity,risk,           on preselected model;           outcome + model-fit;
 model,confidence}               S1 records route metadata       ticket updated
        │                                │                            │
rules cross-check;               S1 verifies completion         feedback retunes
disagreements flagged            (looks-done? + code proves     matrix / train set
for human at ticket review       artifacts exist)                     │
        │                                │                            │
        └────────── GitHub ticket carries provenance ─────────────────┘
                   (router-version, confidence, disputed flag)

Uncertainty protocol (fires on low S1 margin, NOT raw confidence):
  Span margin < 0.2 ──▶ GLM-5.2 appeal ──▶ proceed / escalate
  (appeals court, bounded cost; every appeal logged as labeled data;
  threshold LOCKED 2026-09-29: validated on two independent blind samples —
  fresh-100 auto 59% @ 86.4%, fresh2-50 auto 52% @ 88.5%; wrong-answer
  median margin ~0.13 vs correct ~0.26)
```

**Roles.** S1 = classify, verify completion, gate (fast, cheap, beside the
loop: rules now; Span-01-Lite/Jev/Laya challengers later). S2 = execute,
adjudicate routing on appeal, manufacture labels offline (reasoning models
ONLY here and in planning — never in the live path). Factory = policy,
thresholds, human review, durable state. This mirrors the G/D/C split:
generation→S2, decisions→S1, exact rules→code.

**Appeal model (decided 2026-09-29, shootout 2026-09-30): `opencode-go/glm-5.3-flash`.**
GLM-5.2 and GLM-5.3-Flash scored identically on the same 41 blind appeals
(30/41 = 73.2% task each; complexity/risk/context within noise), so Flash
takes the seat at ~10× lower per-token cost ($0.15/$0.50 vs $1.40/$4.40)
on the same $60/month budget (~31,580 req/mo).
Go pricing $0.15/$0.50/$0.03 per M with a **$60/month** budget (~6,320 req/5h)
— appeal volume (~41% of traffic at margin < 0.2) costs an estimated
~$0.0003/appeal (~1k fresh input + ~250 output tokens); 100 tasks/day ≈
$0.01/day against the $60 budget. Appeals run as
a pinned child session (no cache churn on the parent), carrying the appeal
brief: `{prompt, span top-2 + probabilities + margin, rules vote,
disagreement flag}`. S2 returns `{task, complexity, risk, rationale}` and
its verdict is recorded with provenance like any other routing decision.

## 4. Admission: ticket-time classification

- The planner emits draft `{task, complexity, risk, model, confidence}` per
  ticket at negligible marginal cost (a few output tokens on the planning
  call that already exists).
- The rules engine cross-checks every draft; disagreements set `disputed:`
  for the human at ticket review instead of auto-winning.
- Ticket body fields: `spec:`, `plan:` (existing) plus `complexity:`,
  `model:`, `confidence:`, `router-version:`, `disputed:` (new).
- GitHub Projects custom fields mirror Complexity/Model/Confidence; labels
  mirror fields for filtering. Managed via extended tickets script
  (`gh project item-add` / `field-update`).
- Rationale (agreed): no conversation exists yet so there is no cache tax;
  cost is one-time per ticket; tickets are human-reviewed, giving a free
  verification layer no live router has.

## 5. Execution: session pinning & switching economics

- **Invariant: route once per task; pin the session model for the task
  duration.** Task boundary = new session with task declaration, new
  ticket, explicit `/route`, or task-close signal. Never re-route on
  per-turn classifier output.
- Why (measured economics): Go pricing assumes ~50–88k cached tokens/request
  at 5–50× discounts; caches key on prefix + model, so a switch orphans the
  cache and re-pays input price, plus slower cache-miss prefills; the session
  model also sets compaction cost, so churn poisons the tail.
- **Priced exceptions only:** S2 adjudication wins, explicit override, or
  worker appeal on mis-scoped tickets. Each logs the forfeited cache as part
  of the decision cost in `.factory/routing.log`.
- The classifier itself must stay off the session's context (rules and
  outside-the-loop calls satisfy this; in-loop reasoning models do not).

## 6. Verification: S1 completion check

- After execution, S1 judges "looks done" against acceptance criteria, then
  code proves it independently (artifacts exist, gates pass) — the decider
  is never the sole confirmer.
- Worker close-out reports model-fit (over/under-powered?) back to the
  ticket; fit data retunes the capability matrix and grows the train set.
- Existing `/verify` (pinned reviewer model, child session) is unchanged in
  role; it consumes the provenance fields.

## 7. Challenger bench & promotion protocol

- Challengers (hosted Jev, Span-01/Lite, local Laya, fine-tuned DistilBERT)
  run in shadow on the eval corpus: train split for criteria/threshold
  tuning, verify split scored once at decision time.
- Span-01 notes: exact IDs `respan/span-01`, `respan/span-01-lite`
  (OpenRouter); Lite free/free, full $0.02/M input; vendor behavior-detection
  numbers (0.806 vs Jev 0.716) are domain-mismatched to task routing and do
  not count as evidence. Its inverted benchmark independently corroborates
  our Laya caution (Laya 0.542, injection ASR 0.396) — still vendor-judged.
- Promotion bar (revised 2026-09-29 after the home-turf discovery — the
  original rules-baseline leg compared challengers against a 99.8% score the
  rules earned on cases written with the rulebook open, so it is retired):
  (a) head-to-head task accuracy on blind sets (fresh/fresh2, never tuned
  against) favoring the challenger — measured Span-01 Lite v2: 73% and 84%
  vs rules 31% and 38%; (b) the negation discriminator correct
  (`adv-negation` in-train, fresh-028 blind — Span correct, rules wrong);
  (c) p95 end-to-end decision latency ≤ 1 s over ≥100 live decisions;
  (d) fully-loaded cost per decision ≤ $0.001 (or $0 marginal for local).
  Miss any leg and rules stay.
- Local-model note: Laya zero-shot sits in its documented weak zone at
  16-way choice; admissible paths are hierarchical decomposition or domain
  fine-tune on our (grown, 200+) corpus — never zero-shot promotion.

## 8. Testing / acceptance

- Existing gates stay green: `check-router.sh` (matrix + 87-case eval +
  22 `bun test`), legacy checks, 80/20 split discipline (`--split`
  train/verify/all; tune on train, decide on verify).
- New work adds: admission tests (planner-label schema, rules cross-check
  flags disputes, ticket template fields present), pinning tests (no
  per-turn `switchModel`; switches only via adjudication/override paths),
  completion-check tests (judge-then-prove ordering), challenger harness
  dry-run scoring without credentials.
- Red-green required for every new behavior; mirrors must match the TS
  source (spot cross-checks run in-gate).

## 9. Non-goals

- No Factory runtime Work Order/worker changes; no product DecisionModel
  migration (pattern ports later, implementation does not).
- No live reasoning-model routing; no per-turn model switching.
- No self-learning router, embeddings, or external routing services in v1.
- No new vendors wired into the live path (shadow harnesses only).

## 10. Risks & open questions

- Ticket-time mislabels have whole-task blast radius — mitigated by
  rules cross-check + human review + execution appeal, in that order.
- Threshold validated, not just tuned: adjudication fires on Span margin
  < 0.2 (raw confidence is uncalibrated — flat ~73% across all bands on
  fresh-100 — so margin, not confidence, is the signal; the 0.2 value was
  picked on fresh-100 and confirmed on the independent fresh2-50 sample).
  Rules↔Span disagreement alone is NOT an appeal trigger (Span is right
  ~73% of disagreements; margin subsumes it).
- Shadow-harness credentials (TypeSafe/Respan keys) are human-provisioned;
  dry-run mode must always work without them.
