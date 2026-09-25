# OpenCode Go Plan + V2 Model Routing (Session-Limit Research)

**Date:** 2026-09-24
**Status:** Research — primary sources only
**Question:** How to route models in OpenCode V2 so OpenCode Go session/usage limits exhaust as slowly as possible.
**Companion:** `2026-09-24-agentic-memory-token-efficiency.md` (memory side); this file is the routing side.

---

## 1. What OpenCode Go / Console Go is

- **What:** Optional $10/month subscription giving reliable access to popular open coding models, tested/benchmarked by the OpenCode team. Works like any other provider: subscribe in console, `/connect` → OpenCode Go, `/models` to select. Source: https://opencode.ai/v2/docs/console/go/ , https://opencode.ai/v2/docs/providers/
- **Model IDs in OpenCode:** `opencode-go/<model-id>` (e.g. `opencode-go/kimi-k3`). Source: https://opencode.ai/v2/docs/console/go/
- **Current Go roster (may change):** Grok 4.7/4.6, GLM-5.x flash/full, GPT 6/5.6 Luna, Kimi K3/K2.7 Code/K2.6, LongCat-2.0, MiMo V2.5/V2.6 Flash+Pro, MiniMax M2.5/M2.7/M3, Muse Spark 1.2/1.3 Contributor, Qwen3.x Max/Plus/Flash, DeepSeek V4 family (peak/off-peak pricing), Hy3/Hy4-preview, Space Bunny Free (unlimited, limited time). Source: https://opencode.ai/v2/docs/console/go/
- **How limits exhaust (per-model dollar budgets, not a single pooled session cap):** Each model has a monthly dollar limit; 5-hour = 20% of it, weekly = 50%, monthly = 100%. E.g. $60/month model → $12/5h, $30/week, $60/month. Token prices are per 1M (input/output/cached-read/cached-write columns). Source: https://opencode.ai/v2/docs/console/go/
- **Order-of-magnitude spread (estimated requests, typical Go usage):** cheap tier — Muse Spark Contributor ~45k req/5h, MiMo-Flash ~30k/5h, DeepSeek V4.1 Flash ~26k/5h (4× promo ends Sep 27), LongCat ~11.4k/5h; expensive tier — Kimi K3 ~110/5h, Grok 4.7/4.6 ~169/5h, Qwen3.7 Max ~170/5h, GLM-5.3 full ~220/5h. Mid tier — GPT 6 Luna ~4.2k/5h, Qwen3.8 Flash ~5.4k/5h, Kimi K2.7 Code ~1.35k/5h. Source: estimated-requests table + per-request token assumptions, https://opencode.ai/v2/docs/console/go/
- **What happens at the limit:** requests block unless **Use balance** is enabled (falls back to pay-as-you-go Console balance); free models keep working regardless ("If you reach the usage limit, you can continue using the free models"). Usage tracked in console; limits may change. Source: https://opencode.ai/v2/docs/console/go/
- **Session hygiene matters for caching:** Go asks clients to send a stable `x-opencode-session` per conversation for routing + prompt caching; validated/problematic client table on the Go page. Estimates assume ~50–88k cached tokens/request — cache hits are the dominant cost lever. Source: https://opencode.ai/v2/docs/console/go/
- **Go vs Console pay-as-you-go:** Console (`opencode/<model-id>`) is per-request metered with workspace/monthly/member budgets, auto-reload, and CSV usage export; Go is the flat subscription with the per-model caps above. Don't conflate the two. Sources: https://opencode.ai/v2/docs/console/models/ , https://opencode.ai/v2/docs/console/go/ , https://opencode.ai/v2/docs/console/budgets/ , https://opencode.ai/v2/docs/console/usage/

## 2. V2 model-routing controls (all primary-sourced)

| Control | Shape / semantics | Source |
|---|---|---|
| Root default `model` | `"model": "opencode-go/<id>"`; session-selected model beats config; switching session model doesn't rewrite config; root default keeps provider+model only, **not** `#variant` | https://opencode.ai/v2/docs/models/ , https://opencode.ai/v2/docs/config/ |
| `agents.<id>.model` | Per-agent `provider/model[#variant]` (string or `{providerID, model, variant}` object); **subagent uses its configured model, else inherits parent session model**; selecting a primary agent by ID does **not** change session model | https://opencode.ai/v2/docs/agents/ |
| Commands `model` + `agent` | Command `model` overrides everything; else command agent's model wins; else current session model. `subagent:true/false` controls child session; child uses command model → agent model → parent model | https://opencode.ai/v2/docs/commands/ |
| Variants `#variant` | Named option per model (reasoning effort/token budgets); provider values → model values → variant last; unknown variant = resolution error | https://opencode.ai/v2/docs/models/ |
| Provider/model `limit.context/output` (+`capabilities`, `cost`, `disabled`) | Catalog overrides; aliases via `modelID`; `disabled:true` hides from catalog; compaction ceiling derives from these limits | https://opencode.ai/v2/docs/models/ , https://opencode.ai/v2/docs/compaction/ , https://opencode.ai/v2/docs/providers/ |
| `compaction.keep.tokens` / `buffer` | `keep.tokens` (default 15000) = recent context retained beside summary; `buffer` (default 20000) = safety margin; auto threshold `estimated >= min(input−buffer, context−max(output reserve≤32k, buffer))`; overflow → compact + retry same step **once** (requires `auto:true`); manual compact via API even with `auto:false` | https://opencode.ai/v2/docs/compaction/ , https://opencode.ai/v2/docs/config/ |
| Provider compaction policy | `providers.<p>.settings.compaction={type:native}` with per-model `{type:summary}` override; local summaries default; native checkpoints reuse only same provider/model/protocol/endpoint | https://opencode.ai/v2/docs/compaction/ |
| `ctx.model.transform` | Plugin edits whole candidate collection: `list/get/update/remove`, `default.set`; disabled candidates editable until transforms finish; provider defaults merged on commit | https://opencode.ai/v2/docs/build/plugins/ |
| `ctx.provider.transform` | Edit provider settings/source models, `models.set/update/remove`; changes invalidate active-model result | https://opencode.ai/v2/docs/build/plugins/ |
| `ctx.session.switchModel` | `switchModel({sessionID, model:{providerID, id}})` changes model for subsequent requests | https://opencode.ai/v2/docs/build/plugins/ |
| `ctx.session.hook("context" \| "compaction" \| "generate" \| "title", fn, {providerID}?)` | Per-request overrides before dispatch: push `system`, delete `tools.*`, set `options` (semantic names e.g. `reasoningEffort`, `maxTokens`); `compaction` can set `result` to skip model call; `title` can set `result` string (has no agent/tools); `http.request/response` see `kind: primary/compaction/title/generate`; hooks run in plugin order; `retry` hook overrides retry decision (separate from compaction-overflow recovery) | https://opencode.ai/v2/docs/build/plugins/ |
| `policies` (`experimental.policies`) | Binary tighten-only: `provider.use` deny removes provider from catalog; broader config wins over narrower; Console workspace statements get final say | https://opencode.ai/v2/docs/policies/ |
| Hidden maintenance agents | `compaction`, `title`, `summary` are hidden, not directly selectable. **Local compaction uses the session's selected agent/model/variant** — so session model choice sets compaction cost. Separately, Console notes session titles are generated on low-cost models (Haiku/Nano/Flash) in usage history. V2 has no built-in `scout`. | https://opencode.ai/v2/docs/agents/ , https://opencode.ai/v2/docs/compaction/ , https://opencode.ai/v2/docs/console/models/ |

## 3. Recommended pattern: cheap explore/title/summary/compaction, strong build/verify

Derived strictly from the controls above (no extra API invented):

1. **Default session = cheapest capable Go model** (high-limit tier: MiMo-Flash, Muse Spark Contributor, DeepSeek V4.1 Flash off-peak, LongCat-2.0, Qwen3.8 Flash, GPT 6 Luna). High-limit = 150–450× more 5h requests than Kimi K3/Grok tier.
2. **Pin expensive models to explicit escalation only:** `agents.build.model` (or a `builder-pro` agent) + verify commands with `model:` set, invoked only after cheap plan passes deterministic gates.
3. **Cheap read-only agents:** `agents.explore` / `agents.general` (and any Factory scout) get an explicit cheap `model:` — otherwise they **inherit the parent session model** (the most common accidental spend).
4. **Compaction rides the session model:** keep long exploratory sessions on cheap models so their checkpoint summaries are cheap; reserve `keep.tokens` headroom (larger keep = more detail, less room for work) and don't disable `auto` (loses one-shot overflow recovery).
5. **Titles/summaries:** `title` hook can short-circuit (`event.result = ...`) or is already low-cost; `compaction` hook can supply `result` to skip the call where Factory state already has the summary.
6. **Guardrail, not just default:** `ctx.model.transform` removes/bans expensive Go models from the catalog for routine sessions (`editor.remove(providerID, id)` by output-price or explicit ID list); `experimental.policies` `provider.use: deny` as the hard backstop.
7. **Per-request cheapening:** `context` hook scoped `{providerID:"opencode-go"}` (provider-scoped options) to cap `maxTokens`/reasoning on low-complexity kinds; key off `event.kind` in `http.request` to deprioritize `title`/`compaction` traffic.

## 4. Relationship to Factory DecisionModel / routing topology

Factory topology (`factory-docs/architecture/software-factory-decision-models.md`):

```text
Task → Deterministic policy/capability constraints → Candidate set → DecisionModel → Factory assignment → Worker
```

with invariant `Decision Model ≠ Authority ≠ Policy ≠ Factory`.

Mapping to OpenCode V2 primitives:

| Factory layer | OpenCode V2 mechanism |
|---|---|
| Deterministic policy / capability constraints | `experimental.policies` (`provider.use` deny), `agents.<id>.permissions`, `limit`/`capabilities`/`disabled` catalog facts, `ctx.provider.transform` + `ctx.model.transform` (candidate-set surgery) |
| Candidate set | Result of model transforms = enabled, available-provider models (`/models` selector scope) |
| DecisionModel (System 1: classify/route/rank; System 2: plan/diagnose) | Complexity labeler (rules now, Jev/System One experimentally later per decision-models doc — keep interface `DecisionModel`, not `JevDecisionModel`) |
| Factory assignment decision | `factory-guard` plugin: `ctx.session.switchModel`, command `model:`, agent `model:`, `default.set` for the session |
| Worker | Subagent/child session with its pinned model (`explore` cheap, `build` strong), inheriting only when intended |

Authority stays with Factory: the plugin **assigns**; the DecisionModel only **recommends/ranks** (authority invariant preserved).

## 5. Concrete `factory-guard` plugin sketch (complexity-label routing)

Config (`opencode.jsonc`) — static half of the routing:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode-go/mimo-v2.6-flash",
  "agents": {
    "explore": { "model": "opencode-go/mimo-v2.6-flash" },
    "general": { "model": "opencode-go/mimo-v2.6-flash" },
    "build":   { "model": "opencode-go/kimi-k2.7-code" },
    "plan":    { "model": "opencode-go/qwen3.8-flash" }
  },
  "commands": {
    "verify": {
      "description": "Strong-model verification",
      "template": "Verify $ARGUMENTS against acceptance criteria.",
      "agent": "general",
      "model": "opencode-go/kimi-k3",
      "subagent": true
    }
  },
  "compaction": { "auto": true, "keep": { "tokens": 15000 }, "buffer": 20000 },
  "experimental": {
    "policies": [
      { "action": "provider.use", "resource": "*", "effect": "deny" },
      { "action": "provider.use", "resource": "opencode-go", "effect": "allow" }
    ]
  },
  "plugins": ["./.opencode/plugins/factory-guard"]
}
```

Plugin (`.opencode/plugins/factory-guard/index.ts`) — dynamic half. Uses only documented APIs (`ctx.model.transform`, `ctx.session.hook("context",…, {providerID})`, `ctx.session.switchModel`):

```ts
import { Plugin } from "@opencode/plugin"

const CHEAP = { providerID: "opencode-go", id: "mimo-v2.6-flash" } as const
const STRONG = { providerID: "opencode-go", id: "kimi-k2.7-code" } as const
// 5h-budget sinkholes (~110–220 req/5h): keep out of routine candidate set.
const SINKHOLES: ReadonlySet<string> = new Set(["kimi-k3", "grok-4.7", "grok-4.6", "qwen3.7-max", "glm-5.3"])

type Label = "trivial" | "routine" | "complex"
function labelTask(text: string): Label {
  if (/(hotfix|prod.*down|migration|auth|payment|security)/i.test(text)) return "complex"
  if (/(explore|search|explain|summar|list|read)/i.test(text)) return "trivial"
  return "routine"
}

export default Plugin.define({
  id: "factory-guard",
  async setup(ctx) {
    // 1. Candidate-set surgery: hide sinkholes from routine selection.
    await ctx.model.transform((editor) => {
      for (const m of editor.list("opencode-go"))
        if (SINKHOLES.has(m.id)) editor.remove(m.providerID, m.id);
      editor.default.set(CHEAP.providerID, CHEAP.id);
    });
    // 2. Admission-time assignment (prompt hook): route by label.
    await ctx.session.hook("prompt", (event) => {
      const label = labelTask(event.prompt.text);
      event.metadata = { ...event.metadata, complexity: label };
    });
    // 3. Belt-and-braces per-request cap on cheap provider traffic.
    await ctx.session.hook("context", (event) => {
      event.options.maxTokens ??= 4000;
    }, { providerID: "opencode-go" });
    // 4. Compaction/title stay cheap: short-circuit title; let session (cheap) model summarize.
    await ctx.session.hook("title", (event) => {
      event.result ??= "factory-task";
    });
  },
})
```

> Escalation path (Factory assignment, not model code): when deterministic gates pass and label = `complex`, the orchestrator calls `ctx.session.switchModel({ sessionID, model: STRONG })` (or invokes `/verify`, whose command `model:` already pins the strong model). Downgrade back to `CHEAP` on task close so the next session's compaction tail stays cheap. `switchModel`/`switchAgent` semantics: https://opencode.ai/v2/docs/build/plugins/
>
> Caveats: (a) prompt-hook edits become canonical persisted input — store only the `complexity` label in `metadata`, never secrets; (b) hook `{providerID}` scoping applies to `context`/`model.request`-family hooks; prompt admission runs before model resolution so it is **not** provider-scoped; (c) Go roster + caps change — re-check https://opencode.ai/v2/docs/console/go/ before hard-coding IDs.

---

### Sources (primary, in order of appearance)

- https://opencode.ai/v2/llms.txt
- https://opencode.ai/v2/docs/console/go/
- https://opencode.ai/v2/docs/providers/
- https://opencode.ai/v2/docs/models/
- https://opencode.ai/v2/docs/config/
- https://opencode.ai/v2/docs/console/models/
- https://opencode.ai/v2/docs/console/budgets/
- https://opencode.ai/v2/docs/console/usage/
- https://opencode.ai/v2/docs/agents/
- https://opencode.ai/v2/docs/commands/
- https://opencode.ai/v2/docs/compaction/
- https://opencode.ai/v2/docs/build/plugins/
- https://opencode.ai/v2/docs/build/plugins/rpc/
- https://opencode.ai/v2/docs/policies/
- `factory-docs/architecture/software-factory-decision-models.md` (routing topology, authority invariant)
