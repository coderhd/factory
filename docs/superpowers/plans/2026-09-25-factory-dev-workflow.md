# Factory Dev Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build interim OpenCode workflow (Track A) + Go routing pilots (Track B) to develop the Factory.

**Architecture:** Hybrid C: `factory-guard` plugin enforces live via session/permission/tool hooks; explicit commands run Matt chain; gh scripts sync tickets; Actions re-validate. Track B adds rules-first router now, Jev shadow later.

**Tech Stack:** OpenCode V2 plugins (TypeScript, `@opencode/plugin`), `gh` CLI, GitHub Actions, bash, LiteLLM proxy (Track B pilot B only).

**Spec:** `docs/superpowers/specs/2026-09-25-factory-dev-workflow-design.md`

## Global Constraints
- Pilot on `/factory` repo, docs-only start, `git init` already attempted (Xcode license blocks commit — retry after `sudo xcodebuild -license`).
- Explicit `/spec-to-plan` only, no auto-fire.
- Writer ≠ verifier; verifier has no `write`.
- `DecisionModel` generic, never `JevDecisionModel`; Jev shadow only until live-bench win.
- No OpenViking on customer path (AGPLv3).
- Every ticket has `spec:` + `plan:` links + `Factory: WO-*` ID.

## Review Focus
- Verifier prompt that smuggles `write` via tool alias — expect deny, test pins it.
- Direct push to `main` bypassing PR — expect block, test pins it.
- Epic closed with open blockers — expect deny, test pins it.
- Compaction dropping WO/task/attempt IDs — expect IDs preserved, test pins it.
- Go subscription traffic bypassing proxy (v1-only caveat) — expect fallback to rules, test pins it.

---

### Task 1: Repo bootstrap + base config

**Files:**
- Create: `opencode.jsonc`
- Create: `.gitignore`
- Create: `.factory/.gitkeep`
- Test: `scripts/check-json.sh`

**Interfaces:**
- Consumes: nothing
- Produces: `opencode.jsonc` with `model`, `agents`, `permissions`, `plugins` keys consumed by Tasks 2,3,6.

- [ ] **Step 1: Write the failing test**

```bash
# scripts/check-json.sh
#!/bin/sh
set -e
node -e "JSON.parse(require('fs').readFileSync('opencode.jsonc','utf8').replace(/\/\/.*$/gm,''))" && echo OK
test -f .opencode/plugins/factory-guard/index.ts && echo PLUGIN_OK || (echo MISSING_PLUGIN; exit 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh scripts/check-json.sh`
Expected: FAIL with MISSING_PLUGIN or JSON parse error.

- [ ] **Step 3: Write minimal implementation**

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode-go/glm-5.3-flash",
  "agents": {
    "explore": { "model": "opencode-go/mimo-v2.6-flash" },
    "general": { "model": "opencode-go/deepseek-v4.1-flash" },
    "build": { "model": "opencode-go/qwen3.8-flash" },
    "plan": { "model": "opencode-go/glm-5.3" }
  },
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status *", "effect": "allow" },
    { "action": "shell", "resource": "git diff *", "effect": "allow" },
    { "action": "shell", "resource": "git push origin main *", "effect": "deny" },
    { "action": "edit", "resource": ".env*", "effect": "deny" }
  ],
  "plugins": ["./.opencode/plugins/factory-guard"],
  "compaction": { "auto": true, "keep": { "tokens": 15000 }, "buffer": 20000 }
}
```

```text
# .gitignore
node_modules/
.opencode/plugins/*/node_modules/
.factory/evidence.log
../worktrees/
```

- [ ] **Step 4: Run test to verify partial pass**

Run: `sh scripts/check-json.sh`
Expected: JSON OK, still MISSING_PLUGIN (Task 2 closes it).

- [ ] **Step 5: Commit**

```bash
git add opencode.jsonc .gitignore scripts/check-json.sh .factory/.gitkeep
git commit -m "feat: bootstrap opencode base config"
```

### Task 2: factory-guard plugin skeleton

**Files:**
- Create: `.opencode/plugins/factory-guard/package.json`
- Create: `.opencode/plugins/factory-guard/index.ts`
- Test: `scripts/check-plugin.sh`

**Interfaces:**
- Consumes: `opencode.jsonc` plugins entry from Task 1.
- Produces: `factory-guard` hooks consumed by Tasks 5,6,7 (prompt metadata `complexity`, evidence log path).

- [ ] **Step 1: Write the failing test**

```bash
# scripts/check-plugin.sh
#!/bin/sh
set -e
node --check .opencode/plugins/factory-guard/index.ts && echo SYNTAX_OK
grep -q 'session.hook("prompt"' .opencode/plugins/factory-guard/index.ts && echo PROMPT_OK
grep -q 'permission.hook("evaluate"' .opencode/plugins/factory-guard/index.ts && echo PERM_OK
grep -q 'tool.hook("execute.after"' .opencode/plugins/factory-guard/index.ts && echo TOOL_OK
grep -q 'session.hook("compaction"' .opencode/plugins/factory-guard/index.ts && echo COMPACT_OK
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh scripts/check-plugin.sh`
Expected: FAIL file not found.

- [ ] **Step 3: Write minimal implementation**

```json
// .opencode/plugins/factory-guard/package.json
{ "name": "factory-guard", "version": "0.1.0", "type": "module" }
```

```ts
// .opencode/plugins/factory-guard/index.ts
import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"

function labelTask(text: string): string {
  if (/(hotfix|prod.*down|migration|auth|payment|security)/i.test(text)) return "complex"
  if (/(explore|search|explain|summar|list|read)/i.test(text)) return "trivial"
  return "routine"
}

export default Plugin.define({
  id: "factory-guard",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      const label = labelTask(event.prompt.text)
      event.metadata = { ...event.metadata, complexity: label, factory: "WO-pending" }
    })
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: "Verify against acceptance criteria. Cite evidence paths. No success without evidence." })
    })
    await ctx.permission.hook("evaluate", async (event) => {
      const res = event.resources.join(" ")
      if (/push.*main/.test(res) && event.action === "shell") { event.effect = "deny"; event.message = "Direct main push blocked. Open a PR." }
      if (event.action === "edit" && /\.env/.test(res)) { event.effect = "deny"; event.message = "Secrets blocked." }
    })
    await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return
      try {
        mkdirSync(".factory", { recursive: true })
        appendFileSync(".factory/evidence.log", JSON.stringify({ t: new Date().toISOString(), tool: (event as any).tool, status: event.status }) + "\n")
      } catch {}
    })
    await ctx.session.hook("compaction", async (event) => {
      // keep cheap session model summary; IDs already in durable log, do not invent result
    })
    await ctx.session.hook("title", (event) => { event.result ??= "factory-task" })
  },
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh scripts/check-plugin.sh`
Expected: PASS all five greps.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/factory-guard/ scripts/check-plugin.sh
git commit -m "feat: add factory-guard hooks skeleton"
```

### Task 3: Commands spec-to-plan + verify

**Files:**
- Create: `.opencode/commands/spec-to-plan.md`
- Create: `.opencode/commands/verify.md`
- Test: `scripts/check-commands.sh`

**Interfaces:**
- Consumes: Matt skills `to-spec`, `writing-plans`, `to-tickets` (invoked by agent, not imported).
- Produces: `/spec-to-plan` + `/verify` commands used by Task 4.

- [ ] **Step 1: Write the failing test**

```bash
#!/bin/sh
set -e
grep -q "to-spec" .opencode/commands/spec-to-plan.md && echo SPEC_OK
grep -q "writing-plans" .opencode/commands/spec-to-plan.md && echo PLAN_OK
grep -q "to-tickets" .opencode/commands/spec-to-plan.md && echo TICKET_OK
grep -q "acceptance criteria" .opencode/commands/verify.md && echo VERIFY_OK
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh scripts/check-commands.sh`
Expected: FAIL missing files.

- [ ] **Step 3: Write minimal implementation**

```md
<!-- .opencode/commands/spec-to-plan.md -->
---
description: Spec -> plan -> tickets (explicit only)
---
Input: $ARGUMENTS = path to spec file in factory-docs/**/*.md
Steps:
1. Invoke skill to-spec if spec missing acceptance criteria.
2. Invoke skill writing-plans to write docs/superpowers/plans/<date>-<slug>.md.
3. Invoke skill to-tickets to emit epics with blocking edges.
4. Run scripts/factory-tickets.sh with plan path to create GitHub issues.
Rules: explicit invocation only. Every ticket needs spec: + plan: links + Factory: WO-* ID from prompt metadata.
```

```md
<!-- .opencode/commands/verify.md -->
---
description: Strong-model verification gate
agent: general
model: opencode-go/kimi-k3
subagent: true
---
Verify $ARGUMENTS against acceptance criteria. Check deterministic gates (typecheck/lint/tests), cite evidence paths from .factory/evidence.log, update implementation/roadmap.md status. Fail closed if evidence missing.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh scripts/check-commands.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .opencode/commands/ scripts/check-commands.sh
git commit -m "feat: add spec-to-plan and verify commands"
```

### Task 4: Tickets script + roadmap touch

**Files:**
- Create: `scripts/factory-tickets.sh`
- Modify: `factory-docs/implementation/roadmap.md` (append Track A/B lines only)
- Test: `scripts/test-tickets.sh`

**Interfaces:**
- Consumes: `/spec-to-plan` output plan path + spec path.
- Produces: GitHub issues with `spec:`/`plan:` links; roadmap updated by Task 5 hygiene.

- [ ] **Step 1: Write the failing test**

```bash
#!/bin/sh
set -e
sh scripts/factory-tickets.sh --dry-run --spec factory-docs/architecture/root-architecture.md --plan docs/superpowers/plans/EXAMPLE.md | grep -q "gh issue create" && echo DRY_OK
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh scripts/test-tickets.sh`
Expected: FAIL script missing.

- [ ] **Step 3: Write minimal implementation**

```bash
#!/bin/sh
# scripts/factory-tickets.sh --spec <spec> --plan <plan> [--dry-run]
set -e
SPEC=""; PLAN=""; DRY=""
while [ $# -gt 0 ]; do case "$1" in --spec) SPEC="$2"; shift 2;; --plan) PLAN="$2"; shift 2;; --dry-run) DRY=1; shift;; *) shift;; esac; done
[ -n "$SPEC" ] && [ -n "$PLAN" ] || { echo "usage: $0 --spec <spec> --plan <plan> [--dry-run]"; exit 1; }
cmd="gh issue create --title \"[Epic] $(basename $SPEC .md)\" --body \"spec: $SPEC
plan: $PLAN
Factory: WO-pending
Acceptance: see plan\""
if [ -n "$DRY" ]; then echo "$cmd"; else eval "$cmd"; fi
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh scripts/test-tickets.sh`
Expected: PASS DRY_OK.

- [ ] **Step 5: Commit**

```bash
git add scripts/factory-tickets.sh scripts/test-tickets.sh
git commit -m "feat: add factory tickets sync script"
```

### Task 5: Actions validate + hygiene

**Files:**
- Create: `.github/workflows/validate.yml`
- Create: `.github/workflows/hygiene.yml`
- Test: `scripts/check-actions.sh`

**Interfaces:**
- Consumes: evidence log from Task 2, ticket links from Task 4.
- Produces: PR gates; no downstream consumers.

- [ ] **Step 1: Write the failing test**

```bash
#!/bin/sh
set -e
grep -q "spec:" .github/workflows/validate.yml && echo VAL_OK
grep -q "roadmap" .github/workflows/hygiene.yml && echo HYG_OK
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh scripts/check-actions.sh`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```yaml
# .github/workflows/validate.yml
name: validate
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          test -f .factory/evidence.log || (echo "missing evidence log" && exit 1)
          git log --format=%B -n 5 | grep -qE "spec:|plan:" || (echo "PR needs spec:/plan: links" && exit 1)
```

```yaml
# .github/workflows/hygiene.yml
name: hygiene
on: { schedule: [{ cron: "0 6 * * *" }], workflow_dispatch: {} }
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          find factory-docs/implementation/roadmap.md -mtime -7 | grep -q roadmap || (echo "roadmap stale >7d" && exit 1)
          gh issue list --json title,state --limit 50 | grep -q . || echo "no issues yet (ok on bootstrap)"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh scripts/check-actions.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ scripts/check-actions.sh
git commit -m "feat: add validate and hygiene actions"
```

### Task 6: Track B Pilot A rules-first router

**Files:**
- Create: `.opencode/plugins/factory-guard/routing-notes.md`
- Modify: `opencode.jsonc` (pin cheap default — already done in Task 1, verify only)
- Test: `scripts/check-router-a.sh`

**Interfaces:**
- Consumes: guard `prompt` metadata `complexity` from Task 2.
- Produces: cheap-default posture; Pilot B shadow compares against it.

- [ ] **Step 1: Write the failing test**

```bash
#!/bin/sh
set -e
grep -q "glm-5.3-flash" opencode.jsonc && echo CHEAP_OK
grep -qv "muse-spark" opencode.jsonc && echo NO_MUSE_OK
test -f .opencode/plugins/factory-guard/routing-notes.md && echo NOTES_OK
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh scripts/check-router-a.sh`
Expected: FAIL NOTES missing (until Step 3).

- [ ] **Step 3: Write minimal implementation**

```md
<!-- .opencode/plugins/factory-guard/routing-notes.md -->
Pilot A (active): mid-tier default/build/general = glm-5.3-flash (default+build rotation), deepseek-v4.1-flash (general), qwen3.8-flash (build; use qwen3.8-flash-next ID when listed on Go page). Low/search = mimo-v2.6-flash on explore. Frontier plan/verify only: glm-5.3 (plan agent), kimi-k3 / qwen3.8-max / grok-4.7 via /verify child session. GPT-6-luna is mid, not frontier — do not use for verify. No muse-spark (trains on prompts).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh scripts/check-router-a.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/factory-guard/routing-notes.md scripts/check-router-a.sh
git commit -m "feat: document Pilot A rules-first routing"
```

### Task 7: Parallel worktrees discipline

**Files:**
- Create: `scripts/worktree-new.sh`
- Test: `scripts/test-worktree.sh`

**Interfaces:**
- Consumes: ticket ID from Task 4.
- Produces: isolated worktree `../worktrees/<ticket>`; owner logged by Task 2 hook.

- [ ] **Step 1: Write the failing test**

```bash
#!/bin/sh
set -e
sh scripts/worktree-new.sh --dry-run WO-123 | grep -q "worktrees/WO-123" && echo WT_OK
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh scripts/test-worktree.sh`
Expected: FAIL script missing.

- [ ] **Step 3: Write minimal implementation**

```bash
#!/bin/sh
# scripts/worktree-new.sh --dry-run <ticket> | <ticket>
set -e
DRY=""; T=""
[ "$1" = "--dry-run" ] && { DRY=1; T="$2"; } || T="$1"
[ -n "$T" ] || { echo "usage: $0 [--dry-run] <ticket>"; exit 1; }
[ -n "$DRY" ] && echo "git worktree add ../worktrees/$T -b $T" || git worktree add "../worktrees/$T" -b "$T"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh scripts/test-worktree.sh`
Expected: PASS WT_OK.

- [ ] **Step 5: Commit**

```bash
git add scripts/worktree-new.sh scripts/test-worktree.sh
git commit -m "feat: add worktree discipline"
```

### Task 8: Track B Pilot B Jev shadow scaffold

**Files:**
- Create: `factory-docs/research/2026-09-25-jev-shadow-checklist.md`
- Create: `scripts/jev-shadow.sh`
- Test: run script with `--dry-run`

**Interfaces:**
- Consumes: LiteLLM proxy pattern + `prismhq/jev-router` policy (reference only, not vendored).
- Produces: shadow log; promotion decision needs live-bench win before active.

- [ ] **Step 1: Write the failing test**

```bash
#!/bin/sh
set -e
sh scripts/jev-shadow.sh --dry-run | grep -q "shadow" && echo SHADOW_OK
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh scripts/jev-shadow.sh --dry-run`
Expected: FAIL missing script.

- [ ] **Step 3: Write minimal implementation**

```bash
#!/bin/sh
# scripts/jev-shadow.sh --dry-run logs what WOULD route, never switches model
set -e
echo "shadow: complexity=$1 model-suggestion=cheap (Jev key absent = rules baseline)"
echo "rule: promote Jev to active only after same 10-30 Work Orders show Jev cost < frontier saved"
```

```md
<!-- factory-docs/research/2026-09-25-jev-shadow-checklist.md -->
Shadow checklist: 1) confirm Go traffic can point at custom provider/proxy, 2) run Pilot A baseline on 10 WOs (cost/merged-PR, first-pass rate), 3) replay with Jev shadow recommendations logged, 4) compare medians with n/model/repo, 5) promote only on win. Keep DecisionModel generic.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh scripts/jev-shadow.sh --dry-run routine`
Expected: PASS SHADOW_OK.

- [ ] **Step 5: Commit**

```bash
git add scripts/jev-shadow.sh factory-docs/research/2026-09-25-jev-shadow-checklist.md
git commit -m "feat: add Jev shadow scaffold"
```
