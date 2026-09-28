# Factory Dev Router — Routing Policy (Track B, rules-first)

Scope: OpenCode DEVELOPMENT environment only. NOT Factory runtime routing.
`DecisionModel` stays generic. Jev stays shadow-only until benchmark evidence.
Writer and verifier stay separate.

## 1. Intelligence evidence (Sep 2026, not a global ranking)

Arena WebDev overall, 2026-09-23 (739,375 votes, 133 models).
Purpose: specialization and trade-offs.

| Model (Arena label) | Score | Read |
|---|---|---|
| qwen3.8-max | 1671 (#6) | Top WebDev in pool; escalation-only, $15/mo ~810 req/mo |
| kimi-k3-max | 1660 (#9) | Strong reasoning/diversity; escalation-only, $15/mo ~490 req/mo |
| qwen3.8-flash-next (preliminary) | 1636 (#11) | Best cheap WebDev signal; high-volume implementation |
| grok-4.7-xhigh | 1632 (#12) | Frontier review/adversarial; $15/mo ~845 req/mo, heavy token use |
| glm-5.3-max | 1622 (#17) | Planning/architecture lead; $15/mo ~1,080 req/mo |
| deepseek-v4.1-flash-max | 1620 (#18) | Debugging/complex-loop lead among cheap-mid models |
| mimo-v2.6-pro | 1619 (#19) | Review/planning strength at mid cost, $15/mo ~16,300 req/mo |
| glm-5.3-flash | 1612 (#21) | Only ~10 pts behind glm-5.3-max; high-volume general work, $60/mo ~31,580 req/mo |
| gpt-6-luna-max | 1593 (#24) | Lower WebDev score but cheapest independent second opinion, $15/mo ~21,130 req/mo |

Artificial Analysis (second source, not a single leaderboard):
- GPT-6 Sol/Luna halve cost vs 5.6; Luna (max) Coding Agent Index 41 (−2), $0.07/task — cheap utility/second-opinion, not frontier verifier.
  https://artificialanalysis.ai/articles/gpt-6-sol-and-luna-push-the-cost-efficiency-frontier
- Grok 4.7: Intelligence Index 46, Coding Agent Index 56 (4th in native harness), but ~81k output tokens/task (vs 27k Astra) — reserve for high-value review.
  https://artificialanalysis.ai/articles/benchmarking-grok-4-7

Takeaway: Flash models sit within ~10–60 pts of Max models at 10–150× the request budget. Route by task fit, not by headline score.

Sources:
- https://arena.ai/leaderboard/code/webdev/overall
- https://artificialanalysis.ai/
- https://opencode.ai/v2/docs/console/go/ (limits/prices/estimates)

## 2. Model pool (OpenCode Go IDs)

Primary: `glm-5.3-flash`, `glm-5.3`, `deepseek-v4.1-flash`, `qwen3.8-flash`,
`qwen3.8-max`, `mimo-v2.6-flash`, `mimo-v2.6-pro`, `grok-4.7`.
Secondary/rare: `kimi-k3`, `gpt-6-luna`.
Alias: `qwen3.8-flash-next` → `qwen3.8-flash` until listed separately on the Go page.

Cost tiers (routing, not vendor rank):
- cheap: mimo-v2.6-flash ($60/mo), glm-5.3-flash ($60/mo), qwen3.8-flash ($30/mo), gpt-6-luna ($15/mo but ~21k req/mo)
- mid: deepseek-v4.1-flash (promo $60 → base $15; treat as mid), mimo-v2.6-pro ($15/mo), glm-5.3 ($15/mo)
- escalation: qwen3.8-max, grok-4.7, kimi-k3 (all $15/mo, ~490–845 req/mo)

Go windows: 5-hour = 20% monthly, weekly = 50%, monthly = 100%. Estimates vary with usage.

## 3. Capability matrix (ordered candidates; fallback walks in order)

- exploration / repository-analysis: mimo-v2.6-flash, glm-5.3-flash, qwen3.8-flash
  (large/xlarge context: deepseek-v4.1-flash first)
- simple implementation: glm-5.3-flash, qwen3.8-flash, mimo-v2.6-flash
- normal implementation: qwen3.8-flash, glm-5.3-flash, deepseek-v4.1-flash
- complex implementation: deepseek-v4.1-flash, mimo-v2.6-pro, glm-5.3, qwen3.8-flash
- debugging / test-debugging / CI troubleshooting: deepseek-v4.1-flash, mimo-v2.6-pro, glm-5.3
- test generation / documentation: qwen3.8-flash, glm-5.3-flash, mimo-v2.6-flash
- planning: glm-5.3, mimo-v2.6-pro, qwen3.8-max
- architecture: glm-5.3, qwen3.8-max, mimo-v2.6-pro
- normal code review: mimo-v2.6-pro, glm-5.3, deepseek-v4.1-flash
- high-risk / adversarial / security review: qwen3.8-max, grok-4.7, kimi-k3 (sparingly)
- second opinion: gpt-6-luna, mimo-v2.6-pro, kimi-k3 (cheap independent view, not frontier verify)
- rare reasoning (ambiguous/research-heavy): kimi-k3, never default verifier
- final/production-risk review: grok-4.7, reserved

## 4. Budget-aware selection

Escalation models require monthly ≥30%, weekly ≥30%, 5h ≥20% remaining.
Mid models require monthly ≥10%, weekly ≥10%, 5h ≥5%.
Cheap models always allowed. Blocked candidates are skipped in order;
last resort is mimo-v2.6-flash (or glm-5.3-flash if mimo is down).
Never jump straight to the most expensive model.

Absorption: GLM Flash = high-volume general; MiMo Flash = exploration/utility;
Qwen Flash = implementation/testing; DeepSeek Flash = difficult loops;
MiMo Pro + GLM-5.3 = reasoning/review/planning; Max/Grok/Kimi = escalation.

## 5. Manual overrides (always win unless unavailable)

`/route glm-5.3`, `/route qwen3.8-max`, `/route grok-4.7`, `/route kimi-k3`, etc.
Hints: `@plan` → planning/complex; `@architecture` → architecture/complex;
`@review` → code-review/normal; `@debug` → debugging/complex;
`@cheap` → exploration/trivial; `@deep` → complex/high-risk.

## 6. Explainability

Each decision stores: task, complexity, risk, context, selected, candidates,
reason, budget snapshot. Prompt hook writes `route_model`, `route_reason`,
`jev_shadow` to session metadata and appends one JSON line to
`.factory/routing.log`. No excessive internal reasoning in chat.

Example:
`task=debugging, complexity=complex, risk=medium, context=large -> deepseek-v4.1-flash (mid tier; budget m=80%/w=80%/5h=80%).`

## 7. Fallback

Unavailable / limit-hit / over-context → next candidate in the same list.
Example: qwen3.8-flash ↓ → glm-5.3-flash ↓ → deepseek-v4.1-flash.
Stay in-category; do not escalate on failure.

## 8. Jev

Shadow only. `jevShadowSuggest()` logs a suggestion; routing uses
`RulesDecisionModel`. No `JevDecisionModel` exists. Promote only on
measured win over the same 10–30 Work Orders.

## 9. Wired admission loop (Span-default since 2026-09-30)

Rules are off the default path (kept as offline fallback only). Admission,
once per task — never per turn:

```text
New task prompt → Span-01 Lite triage (free, ~600 ms, outside the loop)
   ├── margin ≥ 0.2: record Span route, pin session
   ├── margin < 0.2: switchModel to opencode-go/glm-5.3-flash, pin, log appeal
   └── Span unavailable: rules fallback, pin session
Pinned session → record only. Manual /route always wins.
```

- `/appeal` command (`.opencode/commands/appeal.md`): runs
  `span-trial.py --live --prompt`, interprets the verdict, appends to
  `.factory/routing.log`. Triage failure falls back to the rules route,
  never blocks.
- Tickets carry the decision: `factory-tickets.sh` accepts
  `--complexity/--model/--confidence/--disputed` into the issue body
  (planner-proposed, rules-checked, human-confirmed at review).
- Manual `/route <model>` always wins unless the model is unavailable;
  hints (`@plan`, `@review`, `@debug`, …) patch classification.
