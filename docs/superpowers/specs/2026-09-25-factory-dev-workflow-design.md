# Factory Dev Workflow — Design (Track A + Track B)

**Date:** 2026-09-25
**Status:** Draft for review
**Scope:** Interim OpenCode workflow to develop the Factory itself + Go-limit routing. NOT Factory product code.
**Baseline:** `factory-docs/2026-09-17-software-factory-design.md` remains authoritative for Factory product.

## 1. Intent
Provide specs → get plans → GitHub epics/issues/tickets → CI/CD maintained, with hooks that force rules models otherwise ignore in AGENTS.md.
Pilot on `/factory` repo (docs-only today). `git init` + new GitHub repo via `gh` CLI.

## 2. Tracks (do not confuse)
- **Track A:** dev workflow: plugin + commands + scripts + Actions + worktrees + validator.
- **Track B (active):** Go-limit routing combining oh-my-openagent approach + Jev System One to optimize $10 Go plan. See §9. Separate from Factory product DecisionModel.
- **Factory product routing/DecisionModel:** already defined in `architecture/software-factory-decision-models.md`. Implementation later, separate.

## 3. Architecture (Hybrid C)
`.opencode/` plugin enforces live; explicit commands generate plans; `gh` scripts sync tickets; Actions re-validate on PR.

```text
spec (factory-docs/**/*.md)
  → /spec-to-plan (to-spec → writing-plans → to-tickets)
  → scripts/factory-tickets.sh (gh issue create epics/tasks)
  → worktrees + subagents build
  → /verify validator
  → PR + Actions (validate + hygiene)
  → roadmap update
```

## 4. Components
1. `opencode.jsonc`: permissions (deny production.write/secrets, ask shell), agents (writer vs verifier), plugins `["./.opencode/plugins/factory-guard"]`.
2. `.opencode/plugins/factory-guard/index.ts`:
   - `prompt`: inject WO/task/attempt IDs + spec path, store complexity label in metadata only.
   - `context`: pin verification checklist, strip `write` for verifier.
   - `permission.evaluate`: deny risky actions, block epic-close with open blockers, block direct main push.
   - `tool.execute.after`: append to `.factory/evidence.log` + touch roadmap status.
   - `compaction`: preserve IDs; never use summary as durable record.
3. `.opencode/commands/spec-to-plan.md`: explicit only, no auto-fire. Invokes Matt chain underneath.
4. `scripts/factory-tickets.sh`: creates epics/issues with `spec:` + `plan:` links, blocking edges as text.
5. `.github/workflows/validate.yml` + `hygiene.yml`: fail PR if missing spec/plan link or evidence; fail if roadmap stale >7d or orphan tickets.

## 5. Matt chain underneath
Order fixed: `to-spec` (if missing) → `writing-plans` → `to-tickets` → gh sync. Each ticket: `Factory: WO-*`, spec link, plan link, acceptance criteria. No skipping.

## 6. Parallel + worktrees
`subagent-driven-development` fan-out + `using-git-worktrees`: one worktree per ticket `../worktrees/<ticket>`. Plugin records owner. No shared state between workers.

## 7. Validator
`/verify` command (strong model, child session) + `requesting-code-review`: checks acceptance criteria → evidence → roadmap update. Merge blocked on fail via permission hook + branch protection.

## 8. Hygiene / roadmap
- Live: tool hook updates `.factory/evidence.log`, roadmap touched per ticket close.
- Server: `hygiene.yml` nightly checks orphan tickets, stale roadmap, missing links.

## 9. Track B — Go routing (article + Jev, active scope)
Goal: optimize $10 Go plan (per-model dollar budgets, ~400x spread). No custom router invention — adopt proven shapes behind generic `DecisionModel` seam.
- Pilot A rules-first (immediate): `opencode-model-router` npm (`@fast/@medium/@heavy`, budget modes) + `mcxufly` first-match worker rules. Mid-tier default/build/general (`glm-5.3-flash`/`deepseek-v4.1-flash`/`qwen3.8-flash`), low/search (`mimo-v2.6-flash`), frontier plan/verify only (`glm-5.3`/`k3`/etc).
- Pilot B Jev-behind-interface (shadow first): LiteLLM proxy + `prismhq/jev-router` policy + `kungfusaini` scaffold; Jev `choice/score/noul` classifies trivial/routine/complex, Factory plugin assigns via `switchModel`/command-model. Promote only after live-bench proves Jev cost < frontier saved.
- Invariants: constrain first (policy/transforms candidate set), rank second (Jev recommends only); capability-addressed workers; log routing provenance; never cite vendor % without in-repo repro.
- Refs: `2026-09-25-ohmyopenagent-vs-jev.md`, `2026-09-24-opencode-go-routing.md`, `2026-09-25-jev-router-implementations.md`.

## 10. Non-goals
- No Factory Server implementation here (Phase 1 roadmap separate).
- No DIY sqlite-vec retriever, no OpenViking on customer path (AGPLv3).

## 11. Testing / acceptance
- Track B: same 10–30 Work Orders, medians with n/model/repo; Pilot A vs Pilot B shadow; promote Jev only on measured win.
- `/spec-to-plan` on sample `factory-docs/architecture/*.md` produces plan + epics with links.
- Hooks deny test: verifier cannot write, direct main push blocked.
- Parallel test: 2 tickets in isolated worktrees, no cross-contamination.
- Actions fail on PR missing spec link (negative test).
- Metrics: plan→merge time, rework count, human minutes (precursor to verified throughput/human-hour).

## 12. Research refs
- `factory-docs/research/2026-09-24-agentic-memory-token-efficiency.md`
- `factory-docs/research/2026-09-24-opencode-go-routing.md` (Track B)
- `factory-docs/research/2026-09-25-ohmyopenagent-vs-jev.md` (Track B)
- `factory-docs/research/2026-09-25-jev-router-implementations.md` (Track B)
