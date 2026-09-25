# Agentic Memory Systems for Token Efficiency (OpenCode Go Plan)

**Date:** 2026-09-24
**Status:** Research — supports ADR-007 (Memory Files First) in `2026-09-17-software-factory-design.md`
**Scope:** Token usage during coding with OpenCode. Primary sources only; vendor benchmark numbers labeled as vendor claims.

---

## 1. Ponytail — what it is (not a memory system)

- **Repo:** `DietrichGebert/ponytail`, MIT license, ~76k stars / ~4k forks per directory listing (anomaly: star count is disproportionate; treat as unverified mirror-inflated signal, not adoption evidence). Source: https://github.com/DietrichGebert/ponytail.git
- **What it does:** Agent skill / ruleset enforcing "laziest senior dev" code minimalism. Before writing code the agent stops at the first rung that holds: platform primitive → existing dependency → single file → new abstraction. Every shortcut is marked with a `ponytail:` comment naming the upgrade path. Source: https://github.com/DietrichGebert/ponytail.git (README: "How it works", "Before / after" date-picker example).
- **Token-saving mechanism:** Writes less code per task → fewer output tokens, fewer edit/repair round-trips, lower latency. It does **not** store, retrieve, or compress cross-session knowledge. It is an output-shaping skill, orthogonal to memory.
- **Claims (vendor, reproduce via `npx promptfoo eval` in `benchmarks/`):** older single-shot numbers 80–94% less code, 42–75% cheaper, 3–6× faster (median, 5 toy tasks × 3 models × 10 runs); newer "honest" real-repo measurement (Claude Code editing `tiangolo/full-stack-fastapi-template`, 12 feature tickets, Haiku 4.5, n=4): ~54% mean less code (up to 94%), ~20% cheaper, ~27% faster, "100% safe" (keeps safety guards vs bare "write one-liners" prompt). Source: same repo README "Numbers" section.
- **OpenCode compatibility:** Supported. Install via Gemini/Antigravity extension (`gemini extensions install https://github.com/DietrichGebert/ponytail`), or run OpenCode from a checkout with plugin `./.opencode/plugins/ponytail.mjs` which injects the ruleset every turn plus `/ponytail` commands; `skills/` activate per-task. Qoder zero-setup via `AGENTS.md`. Source: same repo README "OpenCode" section; skill definition at https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md
- **Fit for Factory:** Low-risk, zero-infrastructure token saver on the **generation** side. Does not conflict with ADR-007. Recommend: adopt as a worker skill with verification intact (smaller diffs are cheaper to verify; risk is under-engineering, caught by deterministic + semantic verification per spec §9/§14). It does not solve context recall.

## 2. "LLM wiki" vs QMD (qmd) — two different things sharing an acronym

### 2a. LLM Wiki (Karpathy pattern) — this is what ADR-007 already is

- **Source:** Andrej Karpathy gist `llm-wiki.md` (2026-04-04, idea file for OpenAI Codex / Claude Code / OpenCode / Pi). Source: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- **Pattern:** Three layers — (1) immutable raw sources, (2) LLM-maintained interlinked `wiki/` markdown (entity/concept pages), (3) schema file (`AGENTS.md`/`CLAUDE.md`) teaching the agent ingest/query/lint workflows. Operations: **ingest** (one source touches 10–15 pages; update `index.md` + `log.md`), **query** (answer from wiki first, file good answers back), **lint** (contradictions, stale claims, orphans, missing links). Source: same gist (full text at http://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
- **Scale claim (author experience, not benchmark):** `index.md`-first lookup "works surprisingly well at moderate scale (~100 sources, ~hundreds of pages) and avoids the need for embedding-based RAG infrastructure." Log entries with `## [date] type | title` prefix stay `grep`-parseable. Source: same gist ("index.md is content-oriented" paragraph).
- **Token logic:** Synthesis is **compiled once** into the wiki instead of re-derived from raw chunks on every query. Savings come from reading curated pages, not raw dumps. No measured % claimed.
- **Relation to ADR-007:** ADR-007 (`wiki/index.md`, `wiki/log.md`, `entities/`, `concepts/`, `decisions/`, `AGENTS.md`) is a direct instantiation of this pattern. No change needed.

### 2b. QMD (Query Markup Documents, `tobi/qmd`) — local hybrid search engine

- **Repo:** `tobi/qmd`, MIT, npm `@tobilu/qmd` v2.8.3, Node ≥22. Described as "mini cli search engine for your docs… Tracking current sota approaches while being all local." Sources: https://github.com/tobi/qmd ; https://github.com/tobi/qmd/blob/main/package.json
- **Mechanism:** On-device pipeline combining **BM25 full-text + vector semantic search + LLM re-ranking** via `node-llama-cpp` with GGUF models; SQLite storage (`better-sqlite3`); tree-sitter chunking grammars (Go/Python/Rust/TypeScript) with smart markdown-aware break points; exposes CLI (`search`/`vsearch`/`query`/`get`/`multi-get`, `--json/--md/--xml/--csv`) and **MCP server**. Sources: https://github.com/tobi/qmd ; https://tobi-qmd-3.mintlify.app/ ; skill spec at https://github.com/tobi/qmd/blob/main/skills/qmd/SKILL.md
- **How it saves tokens vs raw markdown:** (1) agent searches (`qmd search … -n 5`) and retrieves only winning docs (`qmd get`/`multi-get`) instead of globbing whole directories into context; (2) structured `query` with `intent:/lex:/vec:/hyde:` fields improves chunk selection; (3) skill instructs "do not answer from snippets alone" — snippets are leads, full source fetched on demand (progressive disclosure L0→L2). No vendor % token-saving claim found; benefit is retrieval precision, not compression. Sources: same three.
- **Cost/latency:** ~2 GB of models auto-downloaded to `~/.cache/qmd/models/` on first `qmd embed`; fully local thereafter (no per-query API cost, privacy-preserving). Index maintenance (`qmd collection add`, `qmd embed`, per-index `--index` flag) is operator burden. Source: https://tobi-qmd-3.mintlify.app/
- **Unrelated homonym:** `ajithraghavan/qmd` ("Quick Markdown", single-char markers `! > - . : ;`) is a different project claiming token-efficient markup; immature/unrelated — do not confuse. Source: https://115.175.65.104:8004/ajithraghavan/qmd
- **Fit for Factory:** Exactly what ADR-007 defers ("do not introduce qmd until knowledge exceeds ~100 pages"). Trigger remains valid: Karpathy's ~100-source index-scan ceiling is where BM25+vector pays off.

## 3. Option comparison (OpenCode Go context)

| Option | Mechanism | Token-savings evidence | Where memory lives | OpenCode integration effort | Cost / latency | Failure modes |
|---|---|---|---|---|---|---|
| **Markdown + AGENTS.md (ADR-007 now)** | Curated `wiki/index.md` → page reads; `AGENTS.md` as agent README (60k+ repos convention). Sources: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f ; https://agents.md/ | No % claim; savings = curated pages vs raw dumps; index-scan viable to ~100 sources (author claim, same gist) | Git/filesystem (Knowledge Plane, spec §10/§19) | Zero: OpenCode auto-loads `AGENTS.md`; add retrieval ritual in worker envelope | $0, file-read latency | Stale pages, contradiction, orphan pages, index drift; mitigated by ingest/lint rituals, not infra |
| **QMD (`tobi/qmd`)** | Local BM25 + vector + LLM rerank; CLI + MCP (`qmd search/vsearch/query/get`) | No % claim; precision-based (fetch winners only). Sources: https://github.com/tobi/qmd ; https://tobi-qmd-3.mintlify.app/ | Local SQLite index + markdown files + `~/.cache/qmd/models/` (~2 GB) | Low: MCP server (`qmd mcp`) or CLI skill; enable only when needed (MCP tools consume context — https://v2.opencode.ai/mcp.md) | $0/query after model download; local embed/rerank latency | Stale index (forgot `qmd embed`), chunk-boundary misses, GGUF quality vs hosted embeddings, 2 GB provisioning per worker image |
| **Mem0 (OSS + Platform)** | LLM extraction of durable facts from messages → dedup + embed; `add` after interaction, `search` before model call scoped by `user_id/agent_id/run_id`; Platform adds graph memory + rerankers. Sources: https://docs.mem0.ai/core-concepts/how-it-works.md ; https://docs.mem0.ai/what-is-mem0 ; https://docs.mem0.ai/platform/overview | Vendor: "cutting prompt tokens by up to 80%", "sub-50ms lookups" (homepage, unverified in-repo: https://mem0docs.xyz/); paper `Mem0: Building Production-Ready AI Agents` (arXiv 2504.19413) reports LoCoMo/quality + `cl100k_base` token-consumption tracking but no single headline % — cite paper, not homepage, for rigor. Source: https://arxiv.org/html/2504.19413v1 | OSS: operator-chosen SQL + vector + entity stores; Platform: managed (SOC 2 T1, HIPAA, GDPR per https://mem0.ai/) | Medium: SDK or MCP (`https://docs.mem0.ai/platform/mem0-mcp`); needs `KnowledgeStore` adapter + scoping discipline (user/agent/run) + async `add` handling (post-2025-07-01 accounts are async) | Platform per-seat/token metered; OSS self-host cost + extraction LLM calls per write (write amplification) | Hallucinated facts written as memory; contradiction without explicit update/delete (additive path); cross-user leakage if filters omitted; evaluator must check extraction precision, not just retrieval recall |
| **Graphiti (`getzep/graphiti`, Apache-2.0) / Zep managed** | Bi-temporal knowledge graph: episodes (message/text/JSON) → entity extraction + resolution (embed + full-text + LLM reflexion) → fact edges with validity windows + invalidation (not delete); hybrid semantic + BM25 + graph traversal, no LLM rerank in path. Sources: https://help.getzep.com/graphiti/getting-started/overview.md ; http://arxiv.org/html/2501.13956v1 ; https://github.com/getzep/graphiti/blob/main/README.md | Vendor: LoCoMo 94.7% @155ms, LongMemEval 90.2% @162ms; "98% fewer tokens" / "90% latency reduction" on product page (vendor claims, verify before citing externally: https://getzep.com/product/open-source) | OSS: Python 3.10+ + Neo4j 5.26 / FalkorDB / Neptune / Kuzu + LLM with structured output (OpenAI default); Zep managed: proprietary Context Graph Engine, no third-party DB. Source: same README | High: Python service + graph DB + MCP server (`mcp_server/README.md` in repo); custom entity types via Pydantic for Factory domain (WorkOrder/Attempt/Evidence) | Extraction LLM calls per episode (heaviest write cost of all options); sub-second reads; managed Zep billed | Ingestion failures on small/non-structured-output models; schema drift; over-graphing (simple facts pay graph overhead); temporal invalidation wrong on ambiguous dates; needs provenance UI or it becomes black-box |
| **OpenViking (`volcengine/OpenViking`)** | `viking://` virtual filesystem unifying memory/resources/skills; L0 abstract / L1 overview / L2 detail tiers loaded on demand; session commit → async distillation (profile/preference/entity/event/experience); retrieval trajectory observable. Sources: https://github.com/volcengine/OpenViking ; https://openviking.ai/ ; https://openviking.net/product | Vendor benchmark (Doubao 2.0 Pro, v0.3.22, repro in `./benchmark`): LoCoMo 80–83% (from 24–57% native), input tokens −34.3–91.0%, latency −58–66%; tau2-bench +6.87pp retail / +11.87pp airline; HotpotQA top-20 91% @0.23s. Treat as vendor-run, single-model-family numbers. Source: same GitHub README | Self-hosted server (`pip install openviking`, `openviking-server init`, `ov` CLI) or Volcano Engine SaaS / self-managed licensed | Low technically (OpenCode unified-memory plugin + MCP/CLI: https://openviking.ai/), **blocked by license** (next row) | OSS self-host: embedding/VLM inference cost; SaaS metered | **License: AGPLv3** for the repo (plus commercial SaaS/self-managed editions) — copyleft applies to self-hosted service modifications/network use; ADR-007 already flags "internal-only unless licensing reviewed." Source: https://github.com/volcengine/OpenViking (License + Commercial editions sections). Additional: ByteDance/Volcano provenance — data-residency review needed before SaaS. |
| **Ponytail** | Output minimalism skill (§1), not memory | Vendor §1 numbers; orthogonal to recall | N/A (ruleset in repo / plugin) | Trivial (plugin or AGENTS.md) | $0; net-negative tokens | Under-abstraction; no cross-session benefit |
| **SQLite-vec / embeddings (DIY)** | `sqlite-vec` extension or FTS5 + embeddings column; manual chunk/embed/search | No intrinsic claim; quality = embedding model + chunking | SQLite file (same op as Factory state) | Medium: build `KnowledgeStore.search` + embed pipeline + eval | Local embed cost or API; fast | DIY ranking quality, no rerank/invalidation/observability; becomes a worse QMD — prefer QMD over DIY |
| **Engram (`Gentleman-Programming/engram`, MIT)** | Go single-binary SQLite+FTS5 memory: CLI + HTTP + MCP + TUI; MCP-profile tool routing; durable-save "Memory Protocol". Source: https://github.com/Gentleman-Programming/engram | No % claim found | `~/.engram/engram.db` single file | Low: MCP stdio to OpenCode; Go binary suits Factory Docker-first (§20) | $0 + negligible latency | FTS5-only (no vector/semantic unless extended); project velocity risk (check commit recency before adopting) |
| **OpenCode built-in compaction** | Lossy checkpoint: structured summary + serialized tail (`keep.tokens`, default 8000 V2 / 15000 in newer docs) + optional tool-output prune; auto on threshold `min(input−buffer, context−max(output,buffer))`, one-shot overflow retry, manual `/compact` (`<leader>c`); durable messages preserved, active context replaced; summary presented as history not instructions. Sources: https://v2.opencode.ai/compaction ; https://opencode.ai/v2/docs/compaction ; `session/compaction.ts` + `experimental.session.compacting` plugin hook (https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/compaction.ts); community state-keeping plugin pattern (https://github.com/jmrona/opencode-compaction) | No % claim; effect visible as TUI % drop (e.g. 73%→23% anecdote in community guide: https://learnopencode.com/en/5-advanced/20-compaction) | In-session only; earlier messages durable but out of active context | Zero (default on); plugin hook available for injecting Factory state (Work Order/Attempt IDs) into compaction prompt | Summary generation = one extra model call (≤4096 tokens, tools disabled) | Lossy: dropped identifiers/paths/commands; summarizer drops state → agent improvises; V1 `prune`/tail-turn semantics changed in V2 (migration risk); needs `keep.tokens`/`buffer` tuning per model |

## 4. Staged plan (fits ADR-007; progressive disclosure L0/L1/L2 preserved)

- **Stage 0 — now (0–100 pages): Markdown-first, no new infra.**
  1. Keep ADR-007 layout exactly. Enforce the three rituals as worker instructions: ingest (update `index.md` + `log.md`, touch ≤15 pages), query (index-first, cite paths/docids, file good answers back), lint (scheduled contradiction/orphan/stale pass).
  2. Adopt Ponytail as a worker skill (generation-side savings, §1). Keep verification tiers unchanged.
  3. Tune OpenCode compaction (`compaction.keep.tokens` / `buffer`, keep `auto:true`); add a plugin on `experimental.session.compacting` injecting durable Factory IDs (work_order/task/attempt) so summaries stay attributable. This directly addresses the known "summary drops state" failure mode.
  4. Define the **`KnowledgeStore` interface now** (spec §19/§31) with exactly two methods — `search(query, scope, k) → [{path, excerpt, score}]` and `record(evt)` (explicit write-back only, spec §10) — with a filesystem backend. Every future option (QMD, Mem0, Graphiti) sits behind this seam; workers call Factory retrieval tools, never vendor SDKs directly (spec §11 Retrieval Gateway + provenance fields).
- **Stage 1 — graduate when:** `wiki/` > ~100 pages **or** measured index-scan miss rate rises (see metrics) **or** cross-session recall (preferences, decisions, attempt outcomes) is demonstrably re-derived per session. Then add **QMD** behind `KnowledgeStore.search` (local, $0, MCP-gated, enabled per-task to avoid context tax). Keep markdown as source of truth; QMD index is disposable.
- **Stage 2 — structured memory only on evidence:** if QMD + curated wiki still miss relational/temporal queries ("what did we decide about X after date Y?", "which attempts failed with error Z?"), pilot **Mem0 (fact memory)** and/or **Graphiti (temporal graph)** behind the same adapter on a branch, benchmarked on Factory Work Orders (§5). Default to Mem0-first (simpler ops); Graphiti only if temporal invalidation + provenance queries justify a graph DB + extraction-LLM write cost. Keep **OpenViking internal-only** until AGPLv3 + data-residency review completes — do not put it on the customer path. "Free to download ≠ free to deploy" (ADR-007).
- **What not to build:** DIY sqlite-vec retriever (dominated by QMD); separate vector DB before QMD proves insufficient; any memory write path that bypasses explicit Factory rituals (spec: agents propose, Factory commits).

## 5. Wiring external memory into OpenCode Go plan

- **Context controls available:** `compaction` config (`auto`, `keep.tokens`, `buffer`) in any OpenCode config file; manual `/compact`/`/summarize` + `<leader>c`; provider `limit.context/output` overrides to force earlier compaction; `OPENCODE_DISABLE_AUTOCOMPACT` escape hatch. Sources: https://v2.opencode.ai/compaction ; https://opencode.ai/v2/docs/compaction ; https://learnopencode.com/en/5-advanced/20-compaction
- **Injection seams:** `AGENTS.md` (always-on instructions — put the L0 index pointer + retrieval ritual here, not whole pages); custom agents (`.opencode/agents/<name>.md` with `mode/model/permission/tools` frontmatter — e.g. a least-privilege `verifier` without memory-write); project commands (`.opencode/commands/`); MCP servers under `mcp.servers` (local stdio / remote Streamable HTTP + OAuth via `/connect`), with the documented warning that MCP tools consume context — enable per-task. Sources: https://v2.opencode.ai/mcp.md ; community agent reference (file-format section).
- **Recommended Factory wiring:** Factory Context Assembler (spec §10) composes the worker envelope — Task + repo slice + `KnowledgeStore.search` results (L0 summary default, L1 on relevance, L2 via explicit `get`) + skills + history tail — and launches the worker with that envelope; worker's OpenCode instance sees only its effective slice (spec §5-config monotonicity). Retrieval provenance (source ID/type/authority/locator/timestamp/excerpt per spec §11) flows into the Evidence Bundle. Memory writes return as proposed diffs to `wiki/`, committed only after Factory evaluation (spec §10 write-back ritual). Compaction plugin carries Factory IDs so post-compact context remains attributable to Work Order → Task → Attempt → evidence chain.
- **State/knowledge separation (invariant §29.14):** OpenCode sessions/compaction = ephemeral execution context; Factory SQLite + event log = state truth; `wiki/` Git = knowledge truth. Never use compaction summaries as durable records; never use wiki pages as execution state.

## 6. Measuring token savings (tie to Factory metrics, spec §23–§26)

- **Primary:** verified throughput per human hour (spec §1) — memory work must move this, not just tokens.
- **Secondary (per merged PR, from Attempt/verification telemetry):** input/output/cache tokens, context-compaction count, retrieval calls + hit rank, cost per merged PR, first-pass verification rate, rework count, human minutes, wall time.
- **Retrieval quality:** context recall precision (retrieved docs actually cited in diff/evidence ÷ retrieved), index-scan miss rate (queries falling through to full reads), post-compaction recovery success (no re-ask of already-answered questions — the `jmrona/opencode-compaction` problem statement).
- **Experiment discipline:** compare configurations on the same 10–30 representative Work Orders (spec §25); Ponytail on/off, QMD on/off, `keep.tokens` variants. Report medians with n, model, repo — not single-shot anecdotes. Do not cite vendor homepage percentages in Factory docs without in-repo reproduction.

---

### Sources (primary, in order of appearance)

- https://github.com/DietrichGebert/ponytail.git
- https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md
- https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- http://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- https://agents.md/
- https://github.com/tobi/qmd
- https://github.com/tobi/qmd/blob/main/package.json
- https://tobi-qmd-3.mintlify.app/
- https://github.com/tobi/qmd/blob/main/skills/qmd/SKILL.md
- https://115.175.65.104:8004/ajithraghavan/qmd
- https://docs.mem0.ai/core-concepts/how-it-works.md
- https://docs.mem0.ai/what-is-mem0
- https://docs.mem0.ai/platform/overview
- https://mem0.ai/
- https://mem0docs.xyz/
- https://arxiv.org/html/2504.19413v1
- https://help.getzep.com/graphiti/getting-started/overview.md
- http://arxiv.org/html/2501.13956v1
- https://github.com/getzep/graphiti/blob/main/README.md
- https://getzep.com/product/open-source
- https://github.com/volcengine/OpenViking
- https://openviking.ai/
- https://openviking.net/product
- https://github.com/Gentleman-Programming/engram
- https://v2.opencode.ai/compaction
- https://opencode.ai/v2/docs/compaction
- https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/compaction.ts
- https://github.com/jmrona/opencode-compaction
- https://learnopencode.com/en/5-advanced/20-compaction
- https://v2.opencode.ai/mcp.md
