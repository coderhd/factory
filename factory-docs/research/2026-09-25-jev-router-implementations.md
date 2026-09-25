# Jev / System One Model Routers — Implementation Survey (evaluation only)

Date: 2026-09-25. Scope: primary sources only (GitHub repos, npm, official docs, source code).
Question: is there an existing model router built ON TOP of Jev (or a System-One-style classifier) usable as Factory's `DecisionModel` for complexity-aware routing to protect OpenCode Go $10 limits? No router design in this doc — evaluation only.

## 1. What Jev / System One is (canonical)

- TypeSafe AI's Jev is the first "System One" model: send `state` + typed `questions`, get structured answers code can branch on — no text generation, no parsing. Three primitives: `Choice` (pick option, returns `choice`+`probabilities`+`confidence`), `Score` (ordered rubric, returns `score`+`probabilities`+`confidence`), `Noul` (yes/no, returns `noul` 0–1). All question types can be mixed in one call, evaluated in parallel/isolated against the same state.
  - https://docs.typesafe.ai/introduction
  - https://docs.typesafe.ai/concepts/system-one
- HTTP contract: `POST https://api.typesafe.ai/v1/systemone`, body `{state, model, questions}`, answers keyed by caller-chosen question ids, plus `{model, usage:{input_tokens, output_tokens}}`. Choice max 255 options; Score 2–10 ordered levels; `instructions` can be string/object/array; question keys are not sent to the model. Errors: 401/422/429/529 with backoff guidance.
  - https://docs.typesafe.ai/api
- Current model: `jev-1.13` / `jev-1.13.0`, alias `jev-latest`. Rate limit 250 (per models page). Price $42/BTok = $0.042/MTok input; output tokens FREE ("too cheap to meter").
  - https://docs.typesafe.ai/models
  - https://typesafe.ai/blog/introducing-system-one-models-and-jev
  - https://vercel.com/ai-gateway/models/jev (lists `typesafe-ai/jev`, evaluation type, 32k context, $0.042/1M input, providers typesafe-ai + digitalocean)
- Speed claim: 70ms–500ms end-to-end, "40x–200x faster for same levels of frontier intelligence for System One shaped queries"; homepage-derived 193.6x faster / 444.6x cheaper figures are high-end workflow comparisons vs GPT-6 Astra / Fable 5.1 average as reference, per the launch post itself.
  - https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Independent how-to for exactly our shape: `jevmanual.com/tutorials/model-routing` — Request → Jev `route` (choice: code/fast/deep/human) + `sensitive` (noul) → confidence/policy gate (educational threshold 0.85, sensitivity ≥0.2 → human) → approved handler. Warns: prompt length ≠ difficulty; routing call can cost more than it saves on trivial workloads; pin model, log version+rubric, keep eval set.
  - https://jevmanual.com/tutorials/model-routing/
- LangChain guide confirms the mental model: Jev is not an LLM, trained with RLCD for calibrated decisions; code uses results to guide what an agent does next without a chat call per decision.
  - https://www.langchain.com/blog/building-a-harness-with-jev
- Open-weights System-One alternative: Convai `convaiinnovations/laya` (Apache 2.0, 421M params, same question format as Jev) — relevant as offline/no-vendor fallback candidate. Surfaced via jevbench classifier table.
  - https://github.com/dhruvmehra/jevbench
- Typed local/hosted abstraction: `sys1.io` — one typed client (choice/yes-no/score) across hosted Jev or local Qwen; "local quality is experimental".
  - https://sys1.io/

### Public Jev tooling (exists, but NOT routers)

- `FrancoisChastel/jev-code` (17★, 0 forks, 3 commits): five tools `jev_classify/jev_check/jev_score/jev_rank/jev_ask` with identical JSON across Claude Code / Codex / Pi / OpenCode (MCP stdio + Pi native extension + CLI), one skill, one-command setup, local validation + threshold-to-`auto/review` decisions, `TYPESAFE_API_KEY` convention. This is a classifier-toolkit, not a model router — but it is the cleanest reference for "Jev behind a generic interface" and for OpenCode wiring (`integrations/opencode/`).
  - https://github.com/FrancoisChastel/jev-code
- `jkudish/jev-mcp` and `itsmostafa/typesafe-mcp`: other MCP servers for Jev (cited as related by jev-code).
  - https://github.com/FrancoisChastel/jev-code (Related section)
- `typesafe-ai/skills`: TypeSafe's own skill for building on Jev (adapted inside jev-code's references).
  - https://github.com/FrancoisChastel/jev-code (Related section)
- `dhruvmehra/jevbench` (6★, 2 forks, 18 commits): reproducible benchmark Jev (`typesafe/jev-1.13` via OpenRouter Decisions API `/api/alpha/decisions`) vs Laya vs cheap/frontier LLM vs fine-tuned DistilBERT vs zero-shot NLI over SST-2 / AG News / Banking77; reports accuracy, macro-F1, ECE, p50/p95, throughput, $/1k from provider `usage.cost`. Useful as calibration-evidence methodology if we pilot Jev; not a router.
  - https://github.com/dhruvmehra/jevbench

## 2. Model routers built ON TOP of Jev (direct hits)

Only four repos claim Jev-driven routing. None is an OpenCode-native complexity router. Ranked by relevance to Factory:

### A. `prismhq/jev-router` (12★, 1 fork) — generic OpenAI-compatible LLM router with Jev decider ★ closest reusable pattern
- Mechanism: LiteLLM-proxy pre-call hook (`jev_router/hook.py`) intercepts `model:"jev-router"`; builds minimized summary (recent messages + image/tool signals); `eligible()` filters `router.yaml` candidates by capability (vision, output length, tools); decider picks one — `JevDecider` if `TYPESAFE_API_KEY` set else `RulesDecider` (cheapest eligible); any failure → `fallback` in `router.yaml`. Response `model` reports serving model. Privacy note: routing sends minimized summary to TypeSafe when Jev enabled.
  - https://github.com/prismhq/jev-router
- OpenCode compatibility: transport is LiteLLM, OpenAI-compatible — OpenCode can point a custom provider at it (same pattern as `jtbnz/opencode-routed-model` + `kungfusaini/litellm-router` below). Not an OpenCode plugin; no `chat.params`/switchModel hook. Integration effort: medium — stand up proxy, map Go vs fallback models in `router.yaml`, add OpenCode custom provider; DecisionModel stays behind our interface since Jev is only the decider.
- Cost/latency: one Jev call per routed request (~$0.042/MTok in, free out; 70–500ms) vs one frontier call saved on trivial turns. No measured savings published; status "Experimental. APIs and config will change."
- Fit: cheap-default+escalation ✓ (fallback + cheapest-eligible baseline even without key); capability-addressed workers △ (capability filter is per-model flags, not per-worker authority); authority invariant ✓ (policy stays in `router.yaml`/code, Jev supplies probabilities only — matches jevmanual "label is evidence, not authorization").

### B. `philippdubach/pi-jev-router` (12–14★, 1 fork, 28 commits, last push 22 Sep 2026) — Pi-only Pareto-optimal router, best-measured Jev routing evidence
- Mechanism: Pi extension; `src/classifier.ts` makes ONE Jev `systemOne` call with five questions per turn; `src/catalog.ts` fetches/caches OpenRouter catalog; `src/evidence.ts` blends recorded runs (`eval/results`) with Artificial Analysis index (writing uses EQ-Bench Creative Writing v3 Elo); `src/frontier.ts` computes Pareto frontier over quality/cost/latency and picks the knee point (farthest from cheapest–dearest chord; weighted-value fallback if frontier too small/flat); `src/selector.ts` pure-function selection + small fallback table when catalog unreachable. Commands: `/router[/shadow|auto|off|frontier|pin|budget|subscription|test]`; default shadow (recommend-only). Subscription routing is opt-in/best-effort with cooldowns. Workers run in isolated git worktrees with verifier-gated merge.
  - https://github.com/philippdubach/pi-jev-router
  - https://systemonemodels.org/examples/tools/philippdubach-pi-jev-router/ (quotes the `systemOne` call + `classifierUnavailable` fallback shape from `src/classifier.ts:181`)
- Measured: 5-task isolated-workspace bench (2026-09-20): fixed-frontier Sonnet 5 $0.5722 / pinned-role $1.5732 / frontier-knee $0.1993, all 5/5 pass — router arm ~65% cheaper than fixed frontier on that tiny set. Author caveats: classification overhead excluded; five tasks establish no general saving rate; `--hard`/`--ceiling` tasks + turn budgets added because base tasks didn't discriminate.
  - https://github.com/philippdubach/pi-jev-router (Benchmarks section)
- OpenCode compatibility: none — Pi extension API (`extensions/router.ts`, pi hooks/commands). Port effort: medium-high — classifier+frontier+selector are portable TypeScript, but hooks/commands/board/dispatch must be re-mapped to OpenCode plugin hooks (`chat.params`/`experimental.chat.system.transform`, `tool.execute.before/after`, task dispatch). Worktree-isolation idea is directly reusable for capability-addressed workers.
- Fit: escalation ✓ (shadow→auto, budget cap, pin); capability workers △ (Pareto pick is per-model, not per-authority; but worker/verify split is the right shape); authority invariant ✓ (pure selector + policy-in-code; Jev only classifies).

### C. `felpsdev/jev-classifier` (4★, 1 fork, 6 commits) — tool-routing gateway, OpenCode support is limited
- Mechanism: local gateway proxy for Codex/Claude Code/Grok Build/OpenCode + MCP tools (`jev_status`, `jev_choose_next_tool`) for Cursor/Antigravity; modes Observe (`shadow`: record+compare) vs Enforce (`enforce`: set `tool_choice` when confident); keeps full tool list for prompt-cache stability; failures pass through to model; decision logs + dashboard. Inspiration credited to `vinilana/jev-eval-agent`. Jev providers: TypeSafe / OpenRouter (`~typesafe/jev-latest`) / Vercel AI Gateway (`typesafe-ai/jev`); up to 255 choices incl. `respond_to_user`.
  - https://github.com/felpsdev/jev-classifier
- OpenCode caveat (load-bearing): "supports OpenCode v1 with API keys. Subscription plugins may send requests directly to the provider and skip the proxy. Other providers and the v2 config format are not supported yet." So on OpenCode Go subscription traffic it likely does NOT intercept — disqualifies it as a Go-limit saver today.
- Fit: routes *tools*, not *models* — wrong layer for our usecase. Useful only as observe-mode Jev instrumentation reference + decision-log schema.

### D. `jason-allen-oneal/openclaw-plugin-typesafe-ai` (0★, 0 forks, 14 commits, created 2026-09-18) — OpenClaw plugin where model routing is a disabled-by-default sub-feature
- Mechanism: `before_dispatch` group-chat triage (noul, ~80ms), `before_tool_call` blast-radius guard (score 1–5, fail-closed), pre-compaction curation + post-compaction fidelity audit, LRU decision cache (SHA-256, 0ms repeats), circuit breaker, prompt-injection screen; manual tools `typesafe_evaluate`/`typesafe_jev` (noul/choice/score/systemOne batch). `features.modelComplexityRouting: false` by default — "dynamically routes trivial queries to fast utility models (e.g. Claude 3.5 Haiku) and reserves frontier reasoning for complex tasks."
  - https://github.com/jason-allen-oneal/openclaw-plugin-typesafe-ai
- Price repeated: "$0.042 per million input tokens (with output tokens free)", 70–150ms in this README.
- OpenCode compatibility: none — OpenClaw gateway hooks. Patterns portable (triage/safety-gate/cache/breaker), but routing itself is undocumented beyond the flag. Not a pilot candidate for the router; candidate for guardrail patterns only.

### Negative result
- No public repo implements "Jev complexity classifier → OpenCode model switch" end-to-end. `jev-code` gives Jev tools inside OpenCode but no routing policy; `jev-router`/`pi-jev-router` give Jev routing policy but not inside OpenCode; `jev-classifier` touches OpenCode but routes tools and misses subscription traffic.

## 3. Closest non-Jev alternatives (lightweight complexity labelers as DecisionModel)

### E. `opencode-model-router` (npm, v1.13.0, 40 versions, 0 deps) — most mature OpenCode-native cost router; rules/self-route, NO classifier ★ pilot candidate #1 (rules-first)
- Mechanism: NOT a classifier — injects a dense delegation protocol (~3.2k chars base, ~4k with Claude authority prefix, ~1.0–1.1k tokens/message) teaching a mid-tier orchestrator (Sonnet, not Opus) to match task→tier (`@fast` search/grep/read, `@medium` impl/refactor/test, `@heavy` arch/debug/security), split composite tasks explore(@fast)→execute(@medium) (~36% claim on composites, ~60–70% of sessions), skip delegation for trivial (≤1 tool call), cost ratios in-prompt (1x/5x/20x), orchestrator-aware `self∈opus→never→@heavy`, 7 presets (anthropic/openai/github-copilot/google/hybrid/fable-effort/zai), 4 budget modes (`/budget normal|budget|quality|deep`), cross-provider fallback chain, `/annotate-plan` tier tagging, read-only call caps + redundancy banners via `tool.execute.after`, return protocol (DONE/NEED MORE/ESCALATE), subagent tier mapping, adversarial Claude prefixes, opt-in anti-narration guard.
  - https://www.npmjs.com/package/opencode-model-router
- OpenCode compatibility: native plugin (install via `plugin` field; `tiers.json` + overrides files; `/preset`, `/budget`, `/router`, `/tiers` commands). Direct analogue to `factory-guard`'s prompt-injection surface; enforcement layer maps to our `prompt/context` hooks, caps/banners map to `tool.execute.after`, fallback chain maps to our escalation path. Overhead is per-message prompt tax (~1k tokens) — must be weighed against Go-limit savings.
- Cost evidence: simulated only — 30-task session: all-Opus 600x vs router-normal 100x (−83%) vs router-budget 50x (−92%) in relative units; "actual savings depend on provider pricing." No live measured bench like pi-jev-router's. Author's own comparison table claims oh-my-openagent has no tier routing/cost-ratio awareness (consistent with §5).
- Fit: cheap-default+escalation ✓✓ (budget modes + fallback chain are exactly this); capability workers ✓ (tier→subagent mapping + per-tier prompts/caps); authority invariant △ (relies on orchestrator obeying prompt; needs our hard-guard layer — the plugin's own enforced/advisory modes acknowledge this).

### F. LiteLLM complexity auto-router (official) — production heuristic/LLM-classifier tier router OpenCode can sit behind ★ pilot candidate #2 (proxy tier)
- Mechanism: `auto_router/complexity_router` deployment with SIMPLE/MEDIUM/COMPLEX/REASONING tiers (each one model, random pool, or Thompson-sampled adaptive pool); classifiers: heuristic scorer (free), LLM classifier (small model, fraction of cent/req), lexical/semantic keyword rules, or custom classifier plugin (`async classify(context)->str|None`); 7 scoring dimensions (token count, code presence, reasoning markers ≥2→REASONING, technical terms, simple indicators, multi-step, question complexity); context-window pre-dispatch escalation, opt-in modality routing, session affinity pinning, shadow evaluations, custom `system_prompt` + `tier_labels`, dashboard Test Routing.
  - https://docs.litellm.ai/docs/proxy/auto_routing
  - https://docs.litellm.ai/docs/routing_plugins
  - https://docs.litellm.ai/docs/auto_router/setup
  - https://docs.litellm.ai/blog/auto-router-setup-and-testing
  - https://docs.litellm.ai/blog/auto-router-more-routing-configurations
- OpenCode compatibility: proven pattern — OpenCode custom provider → LiteLLM proxy alias (documented in `jtbnz/opencode-routed-model` README + `kungfusaini/litellm-router` `opencode.sample.json`). Swap the LLM classifier for a Jev-backed custom classifier plugin to get "Jev router" without forking LiteLLM.
- Cost/latency: heuristic = $0/0ms extra; LLM classifier = ~fraction of cent + small-model latency with `classifier_fallback` to heuristic/default on timeout/empty/schema-mismatch. Our Jev variant would inherit `classifier_plugin_timeout_ms` + fallback semantics — ideal DecisionModel seam.
- Fit: escalation ✓ (default model + affinity + escalation keywords); capability workers △ (tiers are models, but tag-routing + plugins can narrow pools per tenant/team — see tag routing docs); authority invariant ✓ (policy in YAML + code, classifier names tier only).
  - https://docs.litellm.ai/docs/proxy/tag_routing

### G. `kungfusaini/litellm-router` (0★, 1 commit) — minimal dual-router OpenCode recipe (native vs classifier-hook)
- Mechanism: `config.yaml` exposes `native-router` (built-in complexity router) + `model-router` (pre-call hook `hooks/model_router.py`: extract recent user text → classifier model emits FAST/BALANCED/COMPLEX/REASONING minified JSON → rewrite `data["model"]` to tier alias; error fallback `opencode-balanced`); 4 tier aliases; `opencode.sample.json` routes only main model, keeps `small_model` cheap. Author guidance: native-router is the better default; classifier costs one extra call.
  - https://github.com/kungfusaini/litellm-router
- Fit: smallest working template for "classifier hook + OpenCode provider config"; swap its `OPENCODE_CLASSIFIER_MODEL` for Jev (via OpenRouter/Vercel Jev endpoint) to prototype a Jev DecisionModel in an afternoon. No savings evidence; single commit.

### H. `jtbnz/opencode-routed-model` (0★, 24 commits) — cautionary: OpenCode cannot yet observe routed model
- Plugin surfaces LiteLLM's serving model as a TUI toast, but is currently NON-FUNCTIONAL: "depends on an OpenCode API that is not yet available. Track progress at opencode issue #26091." Also documents tier-model requirements (all tier models need tool calling for OpenCode) and cost-tracking blind spot (use LiteLLM dashboard/`x-litellm-response-cost`/`/spend/logs`).
  - https://github.com/jtbnz/opencode-routed-model
- Implication for Factory: keep routing telemetry in the proxy/guard logs, not in OpenCode events; don't depend on OpenCode exposing the serving model.

### I. `mcxufly/opencode-model-router` (0★, 44 commits, CI) — deterministic parent→subagent rules
- Mechanism: pinned plugin `@mcxufly/opencode-model-router@0.1.0`, OpenCode `>=1.18.13 <2`; `templates/model-router.json` first-match rules with `*`/`$same`/cross-provider/fallback-modes/strict-validation; missing-file default = parent model; smoke test asserts exactly one task-metadata `targetModel`. Docs admit: background state process-local, parent inferred from recent messages, targets not preflighted, variants unsupported.
  - https://github.com/mcxufly/opencode-model-router
- Fit: best authority-invariant shape (explicit first-match rules, strict validation, no credentials in config) for capability-addressed workers; but static like oh-my-openagent — needs a classifier (Jev) in front to become complexity-aware.

### J. `ziuus/opencode-provider-router` (0★, 6 commits) — agent-invoked tool router
- Mechanism: plugin tools (`route task`, `check providers`, `check quota`) with static routing table (coding/vision/research/browser/chat × simple vs medium-complex across Ollama/Antigravity/Copilot/OpenRouter) + live health checks + Copilot quota monitoring.
  - https://github.com/ziuus/opencode-provider-router
- Fit: wrong trigger (agent must call the tool) for automatic Go-limit protection; quota/health-check ideas reusable.

### K/L. Claude-only cheap-classifier routers — best savings-measurement methodology, not portable to OpenCode Go
- `0dust/ClaudeRouter` (1★, 2 forks, 5 commits, npm `@0dust/claude-router`): `UserPromptSubmit` hook → pre-Haiku heuristics (~30% LOW, zero cost) → Haiku classifier (<$0.001, 3s timeout) → context-injected directive → subagent delegation (LOW→Haiku, MEDIUM→Sonnet, HIGH→Opus direct, `//opus` override); failures fall back MEDIUM, hook always exits 0; `stats` tracks routed counts, Opus tokens saved, LOW follow-up rate, overrides; SDK (`classify/route/createRouter`) available.
  - https://github.com/0dust/ClaudeRouter
- `junoseong/claude-model-router` (0★, PyPI `claude-model-router` 0.2.0, 27 tests): Haiku classifier → cheapest-capable tier (trivial/haiku, low/sonnet-5/medium, mid/opus-4-8/high, high/fable-5/xhigh); handles Claude-5 API traps (refusals as HTTP 200, per-model thinking/effort/max_tokens, model-scoped cache → route-once-per-conversation + `execute()` reuse, 200K vs 1M context); keyword fallback never assigns trivial (retry-cost argument); cost model 1000 prompts $106.36 vs $144.40 all-Fable (−26% mixed; −70%+ support-bot-shaped) + live `$2–6` 17-prompt bench from real `usage` blocks; `hooks/subagent-router.py` PreToolUse denies model-less Agent spawns (measured 25.3k→11.4k tokens on one investigation).
  - https://github.com/junoseong/claude-model-router
  - https://pypi.org/project/claude-model-router/
- Relevance: validates cheap-default+escalation economics and the "heuristic pre-filter → cheap classifier → fallback middle" pipeline we want; code not reusable for OpenCode (Claude hooks/APIs), but the eval discipline (calculated vs live, misroute flagging, refusal-aware fallback) should be copied.

## 4. Candidate comparison (for factory-guard: prompt/context/switchModel hooks)

| Candidate | Mechanism | Integration effort w/ `.opencode/plugins/factory-guard` | Cost / latency per decision | Cheap-default + escalation | Capability-addressed workers | Authority invariant | Verdict |
|---|---|---|---|---|---|---|---|
| prismhq/jev-router | LiteLLM pre-call hook; Jev choice over candidates w/ capability filter; cheapest-eligible baseline; YAML fallback | Medium: sidecar proxy + OpenCode custom provider; guard keeps policy, Jev only classifies | ~$0.00001–0.0001 + 70–500ms per routed turn; $0/0ms without key | ✓ | △ (model flags, not worker authority) | ✓ policy-in-code | **Pilot B** (proxy tier) |
| philippdubach/pi-jev-router | 1 Jev call (5 questions) → Pareto knee over catalog+evidence; shadow/auto/off; verifier-gated worktree workers | Medium-high: port classifier+selector; re-map Pi hooks→OpenCode hooks | 1 Jev call/turn + catalog fetch; measured −65% on 5 tasks (overhead excl.) | ✓ (budget/pin/shadow) | ✓-shape (dispatch+verify) | ✓ pure selector | Reference design; borrow eval + knee idea, don't fork (Pi-only) |
| felpsdev/jev-classifier | Gateway tool-choice classifier, observe/enforce | Low but **misses Go subscription traffic** (v1 API-key only) | per-tool-call Jev; p95 in own metrics | ✗ (tools, not models) | ✗ | ✓ | Reject for router; maybe reuse log schema |
| openclaw Jev plugin | Triage/guard/compaction hooks; routing flag off by default | High (OpenClaw→OpenCode port) for little routing value | $0.042/MTok, 70–150ms, LRU cache → 0ms repeats | △ (flag only) | ✗ | ✓ | Reject for router; reuse cache/breaker patterns |
| opencode-model-router (npm) | Static prompt protocol, tier taxonomy, budget modes, caps/banners, fallback chain | Low: native plugin alongside guard; composes via hook order | ~1k tokens/msg prompt tax, $0 extra calls | ✓✓ | ✓ | △ needs hard guard | **Pilot A** (rules-first, immediate) |
| LiteLLM auto-router | Heuristic/LLM/keyword/custom classifier → tier pools; affinity; shadow eval | Medium: proxy + provider config; Jev as custom classifier plugin | $0 heuristic; ~sub-cent LLM/Jev per req | ✓ | △ (+tag routing) | ✓ | **Pilot B substrate** (use with Jev plugin later) |
| kungfusaini/litellm-router | Minimal native vs hook classifier recipe + OpenCode sample | Low (afternoon prototype) | 1 cheap classifier call | ✓ | △ | ✓ | Prototype scaffold for Pilot B |
| jtbnz/opencode-routed-model | Toast display for routed model | N/A (non-functional, blocked on opencode#26091) | — | — | — | — | Do not depend on serving-model visibility |
| mcxufly/opencode-model-router | Deterministic first-match parent→child rules | Low; strict validation | $0/0ms | static only | ✓ shape | ✓✓ | Rules engine complement; add Jev front to make it adaptive |
| ziuus/opencode-provider-router | Agent-invoked routing tools + health/quota | Low but wrong trigger | $0 | ✗ auto | △ | ✓ | Reject; reuse quota/health ideas |
| ClaudeRouter / claude-model-router | Heuristic→Haiku classifier→tier delegation; measured −26% to −92% shapes | N/A (Claude-only) | <$0.001, 3s timeout, fallback MEDIUM | ✓✓ pattern | ✓ (subagent tiers) | ✓ | Methodology reference only |

OpenCode hook surface assumed (v1 hooks `chat.params`, `experimental.chat.system.transform`, `tool.execute.before/after`, custom `tool`; v2 `ctx.session.hook("request")`, `ctx.tool.hook`, `ctx.aisdk.hook`):
- https://github.com/IA-Generative/opencode-setup/blob/main/config/hooks.md
- https://opencode.ai/docs/plugins
- https://opencode.ai/v2/docs/build/plugins
- https://v2.opencode.ai/build/plugins.md

## 5. oh-my-openagent baseline (as claimed in prompt — confirmed)
- Static categories + ordered fallback chains, no classifier: `categories.<name>.{model|models[], temperature, prompt_append, thinking}` + per-agent `fallback_models[]`; two fallback systems (proactive `model-fallback` chain selection in chat params; reactive `runtime-fallback` after provider failures).
  - https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/features.md
- Practitioner config shows the failure mode rules-first must fix: wrong-model fallback when category mapping misses (issue #928 — general sub-agent fell back to default model; fix = configure category section).
  - https://github.com/code-yeongyu/oh-my-openagent/issues/928

## 6. Recommendation (evaluation, not design)
1. **Pilot A — rules-first with `opencode-model-router` (npm) as the complexity-taxonomy + budget-mode layer.** Reason: only mature OpenCode-native option; immediate Go-limit protection via Sonnet-orchestrator + `@fast` default + fallback chains with zero new services; its gaps (prompt-obedience authority, ~1k-token/msg tax, simulated-only savings) are exactly what our guard + measured eval must close. Pair with `mcxufly` first-match rule shape for worker authority.
2. **Pilot B — Jev-behind-interface via LiteLLM proxy (`prismhq/jev-router` policy + `kungfusaini/litellm-router` scaffold + official auto-router).** Reason: only Jev routing pattern with OpenAI-compatible transport OpenCode can consume today; cheapest-eligible baseline works without a key (risk-free shadow mode); custom-classifier-plugin seam lets Jev replace the LLM classifier later while keeping heuristic fallback + session affinity + shadow eval. Gate on confirming Go subscription traffic can be pointed at a custom provider/proxy — `felpsdev`'s v1-only caveat and `jtbnz`'s blocked-API note say verify this first.
- **Do not pilot**: `felpsdev/jev-classifier` (wrong layer + misses subscription traffic), OpenClaw plugin routing flag (undocumented, wrong harness), Claude-only routers (methodology only), `ziuus` tool-trigger router (not automatic).
- **Build vs buy**: no direct "Jev × OpenCode complexity router" exists to buy; build the DecisionModel seam rules-first (Pilot A), back it with the proxy tier (Pilot B shadow), and promote Jev from shadow to active only after our own live-bench (copy `pi-jev-router` isolated-workspace + `junoseong` calculated-vs-live discipline) shows the Jev call costs less than the frontier tokens it saves on our workload. Keep Jev behind the generic interface throughout so Laya/local-heuristic can substitute.
