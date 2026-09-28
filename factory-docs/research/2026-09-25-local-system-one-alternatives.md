# Local System One Alternatives — Research (evaluation only)

Date: 2026-09-25. Scope: primary sources only (model cards, benchmark repos,
maintainer-published evaluations). Question: is there a local, zero-marginal-cost
decision model that could sit behind the factory-guard `DecisionModel` seam
instead of (or before) hosted Jev? No router design in this doc — evaluation only.

## 1. Cost ladder (cheapest first)

| Tier | Option | Marginal cost | Source |
|---|---|---|---|
| $0 / 0 ms | Heuristic pre-filter (keyword rules — what `classifyTask` is today) | $0, no deps | `router.ts` + 87-case eval gate |
| $0, local | Fine-tuned DistilBERT per domain | $0/call after one 7–10 min train | jevbench results below |
| $0, local | Laya (open weights, Apache 2.0) | $0 self-hosted, ~33–130 ms | model card + jevbench below |
| $0, local | Local Qwen via sys1 (experimental) | hardware/electricity only | sys1 evals below |
| ~sub-cent | Hosted Jev 1.13 | $0.042/1M input, output free | TypeSafe pricing; sys1 measured ~$0.0015/100 calls |

Local is not literally free (hardware, memory, energy, ops) — it is free of
per-call API spend and keeps prompt text on the machine.

## 2. Laya (Convai Innovations) — the direct local candidate

- What: non-autoregressive System 1 decision model, ModernBERT-large backbone,
  421M params, trained with RLCD (honest probabilities are the reward-maximising
  strategy). Same `state` + typed `choice/score/noul` shape as Jev; never
  generates text. License Apache 2.0 (commercial use allowed).
  Source: https://huggingface.co/convaiinnovations/laya
- Use: `pip install laya` (needs Python ≥3.10 — available via pyenv
  3.14 on the dev box; do not use system python 3.9). `Router()` auto-selects one of
  three checkpoints (english 421M/512ctx ~808 MB; multilingual 322M/up-to-8k;
  typed-decisions 421M fine-tuned). `laya-serve` exposes Jev-compatible
  `POST /v1/systemone`, so existing Jev clients switch by changing base URL.
  Source: same model card.
- Speed (author-measured, T4): 32.8–39.5 ms single question; 6.8–15.9 ms/q
  batched; ~6–8× faster than independently measured Jev p50 236–276 ms.
  Source: same model card benchmarks section.

### Independent numbers: jevbench (dhruvmehra, n=500, Apple Silicon, local CPU/MPS)

Source: https://github.com/dhruvmehra/jevbench +
https://github.com/dhruvmehra/jevbench/blob/main/docs/results/2026-09-22-n500-summary.md

| Dataset (labels) | Laya acc / p50 | Jev 1.13 acc / p50 | $/1k Laya vs Jev |
|---|---|---|---|
| AG News (4) | **90.6** / 59 ms | 84.3–85.8 / ~380 ms | $0 vs $0.018 |
| SST-2 (2) | 92.0 / 41 ms | 95.4 / ~376 ms | $0 vs $0.015 |
| Banking77 (77) | 38.2, ECE 0.511 | **76.4**, ECE 0.125 | $0 vs $0.083 |

Reading: Laya beats Jev on few-label classification at zero cost and ~6–9×
lower latency — and on AG News even beat frontier Sonnet (89.6, $1.04/1k).
It collapses on high-cardinality choice (77 options, ECE 0.511 = confidently
wrong). Our router needs ~16 task categories: squarely nearer the Banking77
end of that spectrum than the AG News end.

### Maintainer-admitted limits (author's own "Honest Limits" — load-bearing)

Source: same model card, Honest Limits section.

- Base checkpoints are near chance zero-shot on novel decision tasks (0.362 vs
  0.461 majority baseline on typed-decisions). The headline 0.766 belongs to
  the checkpoint fine-tuned on that benchmark's own training split.
- >20 options at default head budget starve each label to ~3–4 tokens;
  Jev supports 255 options out of the box.
- `noul` can follow its true/false labels instead of the state (issue #156);
  workaround is re-asking as two-option `choice`.
- Ships over-confident: needs per-(type, option-count) temperature fitting
  (ECE 0.466 → 0.081) on your own data before trusting probabilities.
- `score` is the weakest primitive; `action.act_probability` carries no signal
  (issue #185) — gate on `confidence`, not on it.

### sys1's independent Laya study (72 authored decision cases, Apple M5 Max)

Source: https://sys1.io/docs/evaluations (Laya study section).

- Laya typed-decisions: 30/72 (41.7%), three cases above the constant-label
  reference (27/72). Verdict, quoted: results "do not support replacing Jev
  or promoting Laya as Sys1's local default."
- Same fixture: Qwen3.5 4B 44/72 (61.1%, "experimental… not dependable"),
  Qwen3 1.7B 32/72. Hosted Jev 20/20 on the smaller forms fixture.
- External JevBench v1.2.6 (pinned, third party): Jev 75.4 (#1) > SemIf
  Qwen3.5 4B 74.7 (#2) > openJev Verdict 1.4 72.5 (#4, local CPU) >
  Laya 421M 70.1 (#5, local CPU).

## 3. Other local names (do not over-claim)

- openJev / openJev Verdict 1.4: self-hosted Jev-compatible server; JevBench
  72.5 local CPU — second local candidate behind Laya, same zero-shot caveats
  apply until measured on our tasks. Sources: sys1 backends + JevBench rows.
- sys1 (hraness, MIT): typed client + local daemon speaking one format across
  Jev / local Qwen GGUF / registered compatible servers, with `local-only`
  mode. The sane abstraction IF we go beyond rules — backends stay swappable
  behind our `DecisionModel`. Caveat: needs Bun 1.3.14+ runtime, which this
  dev box currently lacks (no node/bun). Source: https://sys1.io/
- Kev, SemIf, djev, NanoJev: names from a secondary roundup
  (datacamp blog). Unverified here — watch, don't adopt.
- Fine-tuned DistilBERT: jevbench's `bert-ft` hit 88–91% at p50 6–13 ms local,
  $0 — but on thousands of labeled examples per dataset. Our 87-case corpus
  is an order of magnitude too small to repeat that today; it is the seed of
  the flywheel (every future misroute becomes training data), not a ready
  training set.

## 4. Fit against factory-guard

- The seam already exists: `RulesDecisionModel implements DecisionModel`
  (`router.ts`). A `LayaDecisionModel` (or sys1-backed one) can slot in
  without touching callers. No `JevDecisionModel`-style hard coupling, same
  invariant as hosted Jev.
- Laya zero-shot is NOT a drop-in upgrade over the 87/87 rules baseline:
  base-checkpoint quality on novel decision tasks is near chance per its own
  authors, and our 16-way task choice sits in its documented weak zone. The
  Laya docs' own prescription for >20 options applies to us: hierarchical
  coarse-to-fine (e.g. 4–5 route buckets, then complexity `score`, then risk
  `noul`) or a domain fine-tune.
- Privacy cut: hosted Jev receives prompt state off-box; Laya/DistilBERT keep
  it on-machine. Relevant next to this repo's existing stance on
  training-on-prompts (muse-spark exclusion in routing-notes).
- Candidate ladder, cheapest first: (1) keep rules (current, measured);
  (2) grow corpus toward 200+ cases; (3) fine-tune Laya-td or DistilBERT on
  OUR prompts, scored on a held-out split of OUR prompts (domain match is the
  entire lesson of the jevbench caveats — SST-2 numbers must not sell this);
  (4) promote the challenger behind `DecisionModel` only on a measured
  misroute-rate win, same bar as hosted Jev.

## 5. Suggested pilot (not started)

1. Isolated env with Python ≥3.10 (pyenv 3.14 on dev box). `pip install laya`.
2. Ask our 87 eval prompts as one `choice` over the 16 task labels AND as a
   hierarchical variant (5 buckets → detail); record accuracy vs rules,
   p50 on this Mac, and ECE after temperature fitting.
3. Score risk/complexity as `noul`/`score` on the same corpus.
4. Write up: misroute rate vs rules baseline, latency, memory. Promote only
   on a win. All telemetry stays in the proxy/guard logs per the existing
   `jtbnz` blind-spot note.

### Sources (primary, in order)

- https://huggingface.co/convaiinnovations/laya
- https://github.com/dhruvmehra/jevbench
- https://github.com/dhruvmehra/jevbench/blob/main/docs/results/2026-09-22-n500-summary.md
- https://sys1.io/
- https://sys1.io/docs/evaluations
- TypeSafe pricing via https://sys1.io/docs/evaluations (measured $0.0015/105 calls) and prior note `factory-docs/research/2026-09-25-jev-router-implementations.md`
