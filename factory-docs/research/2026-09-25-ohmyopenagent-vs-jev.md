# oh-my-openagent routing vs Jev System One — evaluation

**Date:** 2026-09-25
**Status:** Research / evaluation only. Custom router design stays OUT of scope (backlog per user).
**Question:** What does oh-my-openagent ("oh-my-openagent" / "oh-my-opencode" / "omo") actually do for model routing, and how could Jev System One deliver *similar* complexity-aware routing without the opinionated lock-in?

---

## 0. Source-access note (Medium fallback)

- The assigned Medium post (https://medium.com/@jatinkrmalik/opencode-go-oh-my-openagent-the-complete-guide-to-sota-model-routing-without-hitting-limits-49fdc8cb3417) returned **HTTP 403** on direct fetch (Medium WAF/paywall block). A `r.jina.ai` reader fallback also failed (transport error). **No plugin details below are invented from the Medium post.**
- What was used instead (all fetched and read in full):
  1. The plugin repo itself, primary: https://github.com/code-yeongyu/oh-my-openagent (README, ~69.4k stars / ~5.7k forks at fetch time; npm dual-publish `oh-my-opencode`/`oh-my-openagent`).
  2. Official docs site, primary: https://ohmyopenagent.com/docs ("What Is Oh My OpenAgent?").
  3. Raw primary docs from the repo: `docs/guide/orchestration.md`, `docs/guide/agent-model-matching.md` (fetched via `raw.githubusercontent.com/.../dev/docs/guide/...`).
  4. Search-result snippets for the Medium post's claims (secondary, labeled as such): "Sep 2026 routing for 27 OpenCode Go models", "GLM-5.2 stays Sisyphus", "Treat Luna, GLM-5.3, and Kimi K3 as $15/month" (search index only — not verified against post body).
  5. Two community mirrors that summarize/extend the same routing approach (secondary, numbers labeled third-party): https://www.devanshtiwari.com/blog/opencode-go-model-routing-guide (May 2026, v4.2.3-era) and https://www.glukhov.org/ai-devtools/opencode/oh-my-opencode-agents/ (agents + model-routing deep dive).
- A Reddit daily-usage thread (https://www.reddit.com/r/opencode/comments/1u6kgi1/opencode_go_ohmyopenagent_practical_daily_usage/) was located but returned no fetchable body; it is cited only for the existence of the "does omo route by complexity vs by agent primary model?" community question, not for any fact.

---

## 1. What oh-my-openagent actually is (primary sources)

- **Identity:** a community multi-model agent-orchestration harness (plugin) for OpenCode (Ultimate edition), Codex CLI (Light edition), plus a standalone `omo` beta. "If OpenCode is Debian/Arch, oh-my-openagent is Ubuntu/Omarchy." Sources: repo README; https://ohmyopenagent.com/docs.
- **Core loop:** one main agent (runs on the *session* model) plans, delegates, verifies. Delegation goes through a `task` tool with **exactly one of `category` or `subagent_type`**. Sources: orchestration guide (`docs/guide/orchestration.md`).
- **IntentGate is keyword matching, not classification.** It regex-detects `ultrawork`/`ulw`, team-mode spellings, `hyperplan` and injects the matching mode prompt. The docs state explicitly: "It does not semantically classify requests as research, implementation, investigation, or fixes. Prompts without those explicit mode keywords continue without IntentGate mode injection." Source: https://ohmyopenagent.com/docs ("IntentGate" section). **Implication: there is no complexity classifier in the current design** — "routing" is static assignment + human keyword, not System-1 classification.
- **Main-agent model selection:** `model_profile` lanes (`daily-normal`, `daily-heavy`, `geeky-normal`, `geeky-heavy`, `recommended` default) walk an ordered chain at session start and apply the first rung the connected providers serve. Pins (`provider/model`) win; unset means Recommended ladder (Opus 5.5 → Fable 5.1 → Kimi K3 → GPT-6 Astra → GPT-6 Sol → GLM 5.3). Source: `docs/guide/agent-model-matching.md`.
- **Planning/execution split:** `/ulw-plan` (interview planner → gap analysis via `plan-consultant` → review rounds via `plan-reviewer` → `.omo/plans/*.md`) then `/ulw-execute` (main agent never writes product code itself; every unit delegated to spawned workers; 5 verification gates per checkbox; evidence to `.omo/ulw-execute/ledger.jsonl`). Source: orchestration guide.

---

## 2. How its "routing" works: dedicated agents + categories + hardcoded fallback chains

### 2a. Dedicated (curated) agents

- Four curated **read-only** agents with own prompts, tool policies, and model chains, invoked via `task(subagent_type: ...)`: `explore` (codebase grep), `librarian` (docs/OSS search), `plan-consultant` (gap analysis, plan-gated), `plan-reviewer` (one-shot plan review, plan-gated). Architecture consult is **not** an agent — it is `task(category: "architect")`. Plus a read-only memory sidecar, **Kibitzer** (nudges only, cannot write). Sources: https://ohmyopenagent.com/docs; orchestration guide.
- Older/community snapshots name a larger roster (Sisyphus, Prometheus, Metis, Atlas, Hephaestus, Oracle, Momus, code-reviewer, multimodal-looker, Sisyphus-Junior). The current primary docs consolidate around main-agent + 4 curated + category worker + ulw-loop reviewers. The Glukhov deep dive catalogs the older roster with per-agent fallback chains — useful history, secondary source. Source: https://www.glukhov.org/ai-devtools/opencode/oh-my-opencode-agents/.

### 2b. Categories (the routing abstraction)

- Implementation work is delegated by **category** (intent), never by model name: `architect`, `artistry`, `deep`, `deep-low`, `deep-high`, `quick`, `ultrabrain`, `unspecified-high`, `unspecified-low`, `visual-engineering`, `writing`. "A model name in a prompt carries the model's own idea of its limits. A category carries intent." Source: orchestration guide.
- Delegation router (current primary): `quick` = mechanical/single-file default for every splittable piece; `unspecified-low/high` = small/standard; `visual-engineering`/`writing` = frontend/prose; `deep` = hairy debugging; `ultrabrain` = one hard logic problem (goal, not steps); `architect` = advisory read-only lane. Splittable work fans out as a swarm of `quick`/`unspecified-low` workers. Source: orchestration guide ("Builtin categories" + delegation router table).
- User config (`omo.json`) can add categories and override any category/agent. But **a category you configure skips the gate and is always listed** — user override replaces builtin judgment. Source: agent-model-matching guide ("How model resolution works").

### 2c. Hardcoded fallback chains (why it feels opinionated)

- Curated-agent chains are **hardcoded** in `packages/senpi-task/src/agents/builtin/fallback-chains.ts`; category chains in `packages/senpi-task/src/category/fallback-chains.ts`. First rung the connected providers serve wins. Examples (current primary): `explore`/`librarian` head = `kimi-for-coding-highspeed` → `gpt-6-luna-fast` → `deepseek-flash` → … → `claude-haiku-4-5`; `ultrabrain` = `gpt-6-astra (max)` → `gpt-5.6-sol (max)`; `deep-high` = `gpt-6-astra (xhigh)`, **no fallback**; `quick` = `gpt-6-luna-fast` → … → `claude-haiku-4-5`. Source: agent-model-matching guide ("Curated agents" + "Categories" tables).
- **Category gates are hardcoded on model presence:** `ultrabrain`/`deep-low`/`deep-high`/`architect` appear in the main agent's list only when their gate model exists in the registry (e.g. no GPT-6 → no deep lanes; `writing` disappears without its Claude models). Source: same guide.
- **Prompt presets are per model family** (`resolvePresetName` in `prompt-preset/presets.ts`): Claude-family = mechanics-driven (long, checklist); GPT-family = principle-driven (concise). Swapping an agent across families without preset support degrades output; some agents (older Sisyphus/Hephaestus) had single-family prompts only. Sources: agent-model-matching guide ("Models with tuned prompt presets", "Claude vs GPT prompting differences"); Glukhov deep dive §"Why … Assigns Different Models" (secondary, consistent).
- **Provider priority is hardcoded:** native provider > subscription mirrors > aggregators; "Gateway aggregators such as OpenGateway and OpenRouter are never picked for [Recommended]." Subscription login outranks API key for the same model. Source: agent-model-matching guide.
- **Verdict on "opinionated":** the opinionation is (a) fixed agent roster with fixed roles, (b) builtin chains + gates in source, (c) family-coupled prompts, (d) subscription-first provider order. Overrides exist (`omo.json` `agents.*`/`categories.*` with `model`/`models`/`reasoning`/concurrency), but the default experience is a curated mapping, and a configured category bypasses the availability gate rather than participating in ranking. This matches the Reddit community question ("doesn't automatically route based on complexity, only based on the agent's primary model") — routing key is **task-type/category**, not a measured complexity label.

---

## 3. Complexity routing and limit savings: what evidence exists

- **No automatic complexity classifier found in primary docs.** Routing decisions are made by the *main agent's judgment* (which category to call, LIGHT vs HEAVY checkbox classification in `/ulw-execute`) plus static chains plus human keywords. The agent-model-matching guide's own advice for a scarce premium model is positional, not measured: put the rare model in a low-frequency high-leverage role (`plan-consultant`, one pass per plan) and keep it out of high-volume slots (category worker, `explore`, `librarian`). Source: agent-model-matching guide ("Where to spend one scarce premium model").
- **The "complexity-aware" behavior is therefore:** cheap utility models for retrieval/grep by construction (`explore`/`librarian` on fast models), escalation lanes (`deep-high`, `ultrabrain`) invoked on judgment, `on-failure` escalation policy in community configs. The Devansh mirror states the community rule as "Route through V4 Flash first for any task that will exceed 100 requests. Escalate … only if V4 Flash gets stuck. Do not escalate preemptively." — labeled **third-party heuristic, not a measured threshold**. Source: https://www.devanshtiwari.com/blog/opencode-go-model-routing-guide.
- **Limit-savings numbers are third-party/vendor, not controlled benchmarks:**
  - OpenCode Go mechanics (primary, official docs, already captured in `2026-09-24-opencode-go-routing.md` §1): per-model monthly dollar budgets; 5h = 20%, weekly = 50%; `Use balance` pay-as-you-go fallback; free models keep working at cap. Sources: https://opencode.ai/v2/docs/console/go/ (and budgets/usage/models companions).
  - Devansh mirror's arithmetic (third-party estimate, 2,500 tokens/req assumption, May-2026 roster): same $12/5h window buys ~17,000 DeepSeek V4 Flash vs ~480 Claude Opus 4.7 requests (~35× volume); MiniMax M2.5 100k req/month hard cap; "$10/month genuinely enough for 8–12 substantial sessions"; "10–20× cost reduction vs Claude API" from personal experience. Label: **author estimate + experience, n unspecified**. Source: same mirror.
  - SWE-bench-adjacent table in the mirror (Opus 4.7 87.6% vs V4 Pro 80.6% vs Flash ~79.0%) is presented without benchmark harness citation — treat as **unverified directional**, not evidence. Source: same mirror.
  - Medium-post search snippets (secondary, unverified body): Sep-2026 routing for 27 Go models; GLM-5.2 pinned to Sisyphus; Luna/GLM-5.3/Kimi K3 treated as "$15/month" tier. Cite only as "search-index snippet of the assigned post," not as confirmed content.
- **What this means for Factory:** omo demonstrates the *shape* of the savings (cheap default + category-scoped escalation + fallback chains + on-failure escalation) but provides **no transferable measurement**. Any Factory claim must come from our own Work-Order experiments (cf. `2026-09-24-agentic-memory-token-efficiency.md` §6 experiment discipline: same 10–30 Work Orders, medians with n/model/repo).

---

## 4. Comparison to Jev / System One as defined in this repo

Repo definitions (all read in full):

| Repo source | Jev/System-One definition |
|---|---|
| `factory-docs/architecture/software-factory-decision-models.md` | Jev is **one candidate implementation** of the System-1/DecisionModel layer (classification, routing, ranking, filtering, model/worker selection, bounded verification support). Interface must be `DecisionModel`, never `JevDecisionModel`. Authority invariant: **Decision Model ≠ Authority ≠ Policy ≠ Factory**. Topology: Task → deterministic policy/capability constraints → candidate set → DecisionModel → Factory assignment → Worker. MVP must not hard-depend on Jev; adopt only after Work-Order evidence. |
| `factory-docs/quant/quant-factory-brainstorm.md` (§"Jev / System One", §"Software Factory connection") | Same slot: DecisionModel → recommendation/classification/score → Policy + Authority → Factory decision → Operation. "A Decision Model does not acquire authority merely because it produced a high-confidence result." Routing model restated: deterministic constraints → allowed candidate set → DecisionModel/ranking → Factory assignment. |
| `factory-docs/research/2026-09-24-agentic-memory-token-efficiency.md` | **No Jev section exists** in this file (verified by grep: only `KnowledgeStore` interface §4/§5 references). The task brief's reference to a "Jev section" there appears to be a mis-citation — the Jev material lives in the two files above plus the routing file below. Noted so future citations don't point at a phantom section. |
| `factory-docs/research/2026-09-24-opencode-go-routing.md` (§4 mapping, §5 sketch) | Maps Factory layers to OpenCode V2 primitives: policy/constraints → `experimental.policies` + transforms; candidate set → post-transform catalog; **DecisionModel → complexity labeler (rules now, Jev experimentally later)**; assignment → `factory-guard` plugin (`switchModel`, command/agent `model:`, `default.set`); worker → pinned subagents. |

### Structural contrast

| Dimension | oh-my-openagent (as built) | Factory + Jev (as specified) |
|---|---|---|
| What decides the model | Main-agent judgment + static per-category chains + keyword; no measured classifier | `DecisionModel` interface returns recommendation/rank/classification; Factory assigns |
| Who holds authority | The harness (chains, gates, provider order in source) | Factory exclusively; DecisionModel never acquires authority from confidence |
| Policy vs decision | Conflated: gates + chains + overrides all live in plugin/config | Separated: deterministic policy constrains the **candidate set first**, DecisionModel only ranks within it |
| Replaceability | Fork-level: chains are source files; swapping "brains" means re-tuning prompts per family | Seam-level: `DecisionModel` (like `KnowledgeStore`) is an interface; rules → Jev → anything without changing Factory semantics |
| Complexity signal | Positional (which agent/lane) + human keyword; LIGHT/HEAVY checkbox label inside `/ulw-execute` only | Explicit System-1 output: trivial/routine/complex label + model/worker ranking, logged as decision provenance |
| Evidence | Community heuristics, vendor-adjacent numbers | Work-Order experiments required before default adoption |

---

## 5. Answer: how Jev System One could implement omo-like routing without the lock-in

### 5a. The shape to copy (approach, not code)

1. **Cheap default + escalation lanes.** Keep omo's core economy: session default on a high-limit cheap model; expensive models reachable only through explicit escalation paths (pinned verify/build agents, `switchModel` on gate pass). This is already the `2026-09-24-opencode-go-routing.md` §3 pattern — no new finding, confirmed viable by omo's mass deployment.
2. **Intent-keyed delegation (categories), not model names in prompts.** omo's durable insight is that workers should be addressed by *kind of work* (`quick`, `deep`, `writing`) while models stay in config. Factory equivalent: Task kinds route to worker profiles; the DecisionModel ranks candidate models/workers per Task.
3. **On-failure escalation as policy, not hope.** omo community rule (cheap first, escalate on stuck) becomes a Factory policy + DecisionModel loop: attempt → verification signal → re-rank → escalate. Verification stays independent of the writer (decision-models doc §"Verification").
4. **Separate the memory sidecar from the router.** Kibitzer (read-only recall nudges) is rightly decoupled from delegation chains. Factory already has this seam: `KnowledgeStore.search` behind the Retrieval Gateway. Do not let routing state and memory state share a component.

### 5b. What stays generic vs what the plugin hardcodes

| Generic (Factory-owned, model-agnostic) | Plugin-hardcoded (replaceable config/source) |
|---|---|
| `DecisionModel` interface: `classify(task) → {trivial, routine, complex}`, `rank(candidates, task) → ordered[]`, optional `score` | Concrete chain contents (which model IDs per category, reasoning levels) |
| `KnowledgeStore` interface (`search`/`record`) + Retrieval Gateway + provenance fields | Prompt presets per model family (mechanics- vs principle-driven) |
| Policy layer: allowed candidate set, deny rules, budget ceilings, verification gates | Provider priority order, subscription-first ranking |
| Factory assignment: `switchModel` / command-`model:` / agent-`model:` / `default.set` calls, logged with decision provenance | Category catalog itself (which lanes exist) and gate conditions |
| Authority invariant enforcement (recommender can never commit) | Retry/fallback order, concurrency limits, escalation thresholds |
| Experiment harness: same Work Orders, medians with n/model/repo | Any tuned numeric threshold (e.g. "100 requests", token budgets) — must be measured, never copied from a blog |

Jev specifically sits behind `DecisionModel` as the **System-1 classifier/ranker**: task-complexity label + model/worker ranking within the policy-constrained candidate set. Rules engine can occupy the same interface today (routing file §5 `labelTask` sketch); Jev replaces the implementation later with no Factory semantic change. The `factory-guard` plugin remains the assignment actuator. Policy (`experimental.policies`, transforms, permission scopes) constrains the candidate set before Jev ever sees it.

### 5c. How to adopt the approach while keeping the invariants

1. **Keep the interface name generic.** `DecisionModel`, not `JevDecisionModel` (decision-models doc, verbatim requirement). Jev is an experiment behind the seam.
2. **Constrain first, rank second.** Policy/transforms produce the candidate set; Jev only orders it. A high-confidence Jev score must never widen the candidate set or skip verification — confidence ≠ authority (quant brainstorm boundary, verbatim principle).
3. **Avoid dedicated-agent coupling.** Do not mirror omo's fixed roster (Sisyphus/Oracle/Hephaestus-style named agents with family-locked prompts) into Factory semantics. Factory workers are capability-addressed; any family-specific prompt tuning lives in the plugin layer and is documented as a replaceable liability, not architecture.
4. **Log routing as decision provenance.** Every assignment records: candidate set (post-policy), DecisionModel output (label + ranking + confidence), policy check, Factory commit. This is what makes Jev evaluable and removable.
5. **Evidence before default.** Per decision-models MVP rule: rules-based labeler now; Jev evaluated on representative Work Orders (routing quality, cost/merged-PR, first-pass verification rate per memory-doc §6 metrics); default adoption only after it beats rules. No vendor/community percentages cited as justification.
6. **Treat omo's numbers as hypotheses.** The 35× volume arithmetic, on-failure rule, and "scarce model in low-frequency roles" heuristic are worth testing, not assuming — our token/request distributions and verification costs differ.

### 5d. Explicit non-goals (per user scope)

- No custom router design in this file; router stays in backlog.
- No Jev adoption decision; evaluation only.
- No correction of the memory-doc mis-citation beyond noting it (§4 table row 3).

---

## Sources (primary first, in order of appearance)

- https://medium.com/@jatinkrmalik/opencode-go-oh-my-openagent-the-complete-guide-to-sota-model-routing-without-hitting-limits-49fdc8cb3417 — assigned post; **inaccessible (HTTP 403)**; claims from it cited only as search-snippets, labeled.
- https://github.com/code-yeongyu/oh-my-openagent — repo README (editions, IntentGate, orchestration table, category table, config locations, install).
- https://ohmyopenagent.com/docs — official docs (philosophy, architecture diagram, category worker, curated agents, Kibitzer, IntentGate non-classification statement, model families).
- https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/docs/guide/orchestration.md — orchestration guide (`task` category/subagent_type contract, LIGHT/HEAVY, gates, plan-gate rules, `omo.json` schema).
- https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/docs/guide/agent-model-matching.md — chains, gates, provider priority, scarce-model guidance, resolution order, safe/risky overrides.
- https://www.devanshtiwari.com/blog/opencode-go-model-routing-guide — third-party mirror (tier arithmetic, on-failure rule, config sample, cost claims; labeled estimates).
- https://www.glukhov.org/ai-devtools/opencode/oh-my-opencode-agents/ — third-party deep dive (older agent roster, fallback chains, family groups, self-hosting table; labeled secondary).
- https://www.reddit.com/r/opencode/comments/1u6kgi1/opencode_go_ohmyopenagent_practical_daily_usage/ — located, body unfetchable; cited for question existence only.
- https://opencode.ai/v2/docs/console/go/ — Go limits mechanics (via routing research file §1).
- Local: `factory-docs/architecture/software-factory-decision-models.md`; `factory-docs/quant/quant-factory-brainstorm.md` (Jev §, Softw. Factory connection §); `factory-docs/research/2026-09-24-opencode-go-routing.md` (§4 mapping, §5 sketch); `factory-docs/research/2026-09-24-agentic-memory-token-efficiency.md` (§6 metrics; no Jev section — verified).
