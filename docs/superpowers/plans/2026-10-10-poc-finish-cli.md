# POC Finish: CLI Usability

**Goal:** Make `factory` usable by a human operator end-to-end without curl: human-readable
command output by default (machine JSON opt-in), per-command help and actionable errors, and a
`wo transition` command so the submit → READY → PLANNING → plan flow never leaves the CLI.

**Spec:** `factory-docs/implementation/operating-guide.md` (CLI behavior, §3–§5 first-step flow;
notes the missing `wo transition` as a gap) + `factory-docs/2026-09-17-software-factory-design.md`
§20 (operator interface). The guide is the authority; the plan argues from it.

**Tech Stack:** TypeScript/Bun, existing `src/cli/factory.ts` + `src/factory/api/client.ts`
(which already exposes `transitionWorkOrder`, `commitDag`, etc.). No new dependencies.

## Global Constraints

- Server is the sole mutation authority; the CLI only calls the API client — never the store.
- Every human action keeps its durable receipt; output changes must not alter request/response behavior.
- JSON output stays available verbatim via `--json` (machine consumers depend on it).
- Hermetic tests: drive `runCli` in-process with temp dirs; no live server/network.
- `bun test` green; `sh scripts/check-tsc.sh` exit 0.
- Boring-by-default; no new dependencies; no web UI/TUI in this plan.

## Review Focus

- A command whose human output hides the id the next command needs (e.g. `wo submit` must still
  surface the Work Order id prominently).
- An error message that does not say what to do next (e.g. missing `--dag` file, unknown id).
- Any behavior change to `--json` output shape.

---

### Task 1: Human-readable CLI output + `wo transition` — model `opencode-go/glm-5.3-flash`

**Files:**
- Modify: `src/cli/factory.ts`
- Test: `tests/factory/e2-api.test.ts` (CLI output cases; it already drives `runCli`)

**Interfaces:**
- Consumes: existing `FactoryClient` methods (`submitWorkOrder`, `getWorkOrder`, `listWorkOrders`,
  `commitDag`, `answerInteraction`, `transitionWorkOrder`, `observatory`, approvals, controls, github).
  `transitionWorkOrder` already exists on the client (`src/factory/api/client.ts:135`).
- Produces: default human-readable `out` lines; `--json` preserves today's exact JSON output.

- [ ] **Step 1: Write failing tests** for: (a) `wo submit`/`wo status`/`wo plan`/`approvals answer`/
  `control`/`observatory`/`github` default output is human-readable (key fields labeled, ids
  prominent) and `--json` output is byte-identical to today's JSON; (b) `factory wo transition
  <id> --to READY` (and `--to PLANNING`) calls `client.transitionWorkOrder` and prints the new
  state; missing/invalid `--to` prints usage + exit 1; (c) `factory wo --help`-style per-command
  usage on missing args (at minimum `wo`, `wo submit`, `wo plan`, `wo transition`).
- [ ] **Step 2: Run tests to verify they fail** Run: `bun test tests/factory/e2-api.test.ts`
  Expected: FAIL (output is raw JSON; no `wo transition` subcommand).
- [ ] **Step 3: Implement** human-readable default output + `--json` passthrough + `wo transition`
  subcommand + per-command usage errors in `src/cli/factory.ts`. Keep every existing JSON shape
  exactly as-is under `--json`.
- [ ] **Step 4: Run tests to verify they pass** Run: `bun test tests/factory/e2-api.test.ts` and
  the full `bun test`. Expected: PASS, output pristine.
- [ ] **Step 5: Commit** `git add src/cli/factory.ts tests/factory/e2-api.test.ts;
  git commit -m "feat(cli): human-readable output, wo transition, per-command help"`

## Self-Review

- Spec coverage: operating-guide §3 (submit), §4 (PLANNING + plan), §7–§8 (human loops, observe)
  all stay CLI-only after this task; the guide's "no `wo transition`" gap is closed.
- Step scan: each step yields one artifact + one command + expected output; no TBDs.
- Type consistency: reuses `FactoryClient.transitionWorkOrder(id, { to })`; no new API surface.

## Execution Handoff

Subagent-driven execution (fresh implementer + reviewer, whole-branch review at end).
