# Herdr live-smoke findings (#45 — E11.5)

E11.5 ran the E11 worker adapter against a **real** environment on this machine:
`herdr` **0.9.3** + `opencode` **v2.0.32**. This document records what the live
CLI actually does, the two places the adapter diverged from it, the model
selection probes that failed, and what was corrected. It is the ground truth the
adapter now matches; the raw shapes below are verbatim from the live smoke.

The hermetic suite (`tests/factory/e11-integration.test.ts`) still runs against
an in-process fake — this document is what keeps that fake honest.

## Observed primitive shapes (verbatim)

Every successful command exits 0 and prints a single JSON document. Most nest
their payload under `.result`; a **failed** command exits non-zero and prints its
error document to **stdout**.

| Primitive | Observed stdout |
| --- | --- |
| `herdr workspace list` | `{"id":"cli:workspace:list","result":{"type":"workspace_list","workspaces":[{"active_tab_id":"w6:t1","agent_status":"blocked","focused":true,"label":"factory","number":1,"pane_count":1,"tab_count":1,"workspace_id":"w6"}]}}` |
| `herdr workspace create --label L --cwd P --no-focus` | `{"result":{"type":"workspace_created","root_pane":{"pane_id":"w7:p1",...},"tab":{"tab_id":"w7:t1",...},"workspace":{"workspace_id":"w7",...}}}` |
| `herdr tab create --workspace W --cwd A --label factory-x --no-focus` | `{"result":{"type":"tab_created","root_pane":{"pane_id":"w7:p2",...},"tab":{"tab_id":"w7:t2",...}}}` |
| `herdr tab list --workspace W` | `{"result":{"type":"tab_list","tabs":[{"label":"1","tab_id":"w7:t1",...},...]}}` |
| `herdr tab close <id>` | `{"id":"cli:tab:close","result":{"type":"ok"}}` — exit 0, **does** emit JSON on success |
| `herdr workspace close <id>` | `{"result":{"type":"ok"}}` — exit 0 |
| `herdr agent start <name> --kind opencode --pane <pane> --timeout 120000` | `{"result":{"agent":{"agent":"opencode","agent_status":"idle","interactive_ready":true,"name":...,"pane_id":"wA:p2",...},"argv":["opencode"],"type":"agent_started"}}` — exit 0 |
| `herdr agent get <name>` | `{"result":{"agent":{"agent_status":"idle"\|"done",...,"agent_session":{"kind":"id","value":"ses_..."}},"type":"agent_info"}}` |
| `herdr agent prompt <name> <text> --wait --timeout <ms>` | returns when the agent settles, exit 0: `{"result":{"agent":{"agent_status":"done","completion_seq":53,...},"type":"agent_prompted"}}`. Observed live: a `Reply with exactly the single word ZEPHYR …` prompt returned in **4 s** with the model's reply `ZEPHYR` visible in the pane. **`--timeout` is milliseconds.** |
| `herdr agent read <name> --source recent-unwrapped --lines 50` | terminal text (not JSON) — exit 0 |
| `herdr agent start` on a just-created tab, no wait | **exit 1**, stdout: `{"error":{"code":"agent_pane_busy","message":"agent target pane w9:p2 is not an available shell"},"id":"cli:agent:start"}` |

## Divergence 1 (fatal): the adapter passed `--model` to the interactive TUI

The adapter appended `['--', '--model', concrete]` to `agent start` whenever a
concrete model resolved from `workers.models`. Against the real harness this put,
**inside the pane**:

```
ERROR
  Unrecognized flag: --model in command opencode
```

`opencode` never started; herdr never saw it become ready; `agent start` ended
with `{"error":{"code":"timeout","message":"timed out waiting for agent startup"}}`
after the CLI's default 30000 ms. This is why the first live attempt failed.

### Model-selection probes (all captured live; none worked)

| Probe | Result |
| --- | --- |
| `--model` on the interactive TUI | **Rejected.** `--model`/`-m` is documented only on the `opencode run` **subcommand** (`opencode run --help`: `--model, -m string  Model to use in the format provider/model#variant`). The top-level TUI has no `--model`. |
| `OPENCODE_MODEL=<provider/model>` via `herdr tab create --env` | **No effect** — the TUI footer stayed `Build · DeepSeek V4.1 Flash Free ...`. |
| `OPENCODE_CONFIG=<file>` via `--env` | **No effect** on the TUI's model. |
| `XDG_CONFIG_HOME` via `--env` | **No effect** on the TUI's model. |

**Conclusion:** there is **no supported way** to force the interactive opencode
TUI's model from the herdr argv or environment. The model is opencode's own
config concern.

## Divergence 2: `agent start` can race the pane's shell

`agent start` issued immediately after `tab create` can return
`agent_pane_busy` ("agent target pane … is not an available shell"). A 3-second
wait made the same call succeed. The adapter neither waited nor retried.

## The live round trip (acceptance #1) — spawn → prompt → reply → read → close

Exercised end-to-end against the real harness in a scratch workspace (the label
`factory` was already taken by the smoke author's own herdr workspace, so the
smoke used scratch labels):

1. `workspace create --label factory-smoke10 --cwd <dir> --no-focus` → `wJ`.
2. `tab create --workspace wJ --cwd <dir> --label factory-smoke-10 --no-focus` → `wJ:t2`.
3. `agent start smoke-f --kind opencode --pane wJ:p2 --timeout 120000` →
   `{"agent_status":"idle","interactive_ready":true}`, exit 0.
4. `agent prompt smoke-f "Reply with exactly the single word ZEPHYR and nothing else." --wait --timeout 120000`
   → returned in **4 s**, `{"agent_status":"done","completion_seq":53}`, exit 0.
5. `pane read wJ:p2 --source recent-unwrapped --lines 200` → the assistant's
   reply **`ZEPHYR`** and the footer `Build · DeepSeek V4.1 Flash Free · 3.4s · 1.5 tok/s`.
6. `tab close wJ:t2` → `{"result":{"type":"ok"}}`; `workspace close wJ` → `{"result":{"type":"ok"}}`.

Two operational caveats observed (recorded as observations, not proven causes):

- **Read width/settle.** A narrow, immediate read can miss the reply — the model
  response renders in the status/news column. Read wide (`--lines 200`) and read
  after the prompt call returns.
- **Prompt-after-start race.** In three of five runs the first prompt issued
  immediately after `agent start` returned `agent_status:"done"` in ≈0 s with no
  model output yet; with an ~8 s settle after `agent start` before prompting, the
  same prompt produced a real reply in 4 s. Treat "start then prompt immediately"
  as flaky; a settle/verify step is advisable.

## Not live-exercised: the blocked → WAITING_INPUT path (acceptance #2, partial)

`--timeout` units are confirmed **milliseconds** for both `agent start` and
`agent prompt`. The block-return semantics come from the installed binary's own
`--help` (authoritative for 0.9.3): `--wait` matches idle/done/**blocked** by
default; submitting to an **already-blocked** agent is rejected with
`agent_blocked` before any input is sent; if no working/blocked state is observed
within 5000 ms the call returns `agent_prompt_stalled`; a caller timeout returns
`timeout`. The adapter's blocked → `waiting_input` handling is covered by the
hermetic tests. A **live** approval block was attempted twice (default
permissions, then an explicit `{"action":"shell","resource":"*","effect":"ask"}`)
and did not reproducibly reach `agent_status:"blocked"`. That path is therefore
**doc-verified and unit-tested, not live-exercised** — disclosed, not claimed.

## What was corrected (`src/factory/workers/herdr.ts`)

1. **Dropped the fatal model argv.** The `agentArgs.push('--', '--model', concrete)`
   block is gone. The routed capability is still **validated** at dispatch:
   `resolveModel` throws for an id that `workers.models` does not map (fail-loud,
   unchanged and still tested). The resolved concrete model is **not** forwarded
   to the harness.
2. **`agent start` now carries a startup `--timeout`.** New option
   `agentStartTimeoutMs` (default `120_000`; CLI default 30000, max 300000) is
   appended as `--timeout <ms>`.
3. **`agent start` tolerates `agent_pane_busy`.** A bounded retry —
   `paneReadyAttempts` (default 10) with `paneReadyDelayMs` (default 1000) — retries
   only failures whose error text contains `agent_pane_busy`; any other failure
   propagates unchanged.
4. **`createProcessHerdrCli.run()` surfaces stdout on failure.** A non-zero exit
   previously rejected with `stderr` (often empty) while herdr writes its JSON
   error to **stdout**. The thrown message now includes a bounded (≤300 char)
   stdout snippet, so retry logic can match `agent_pane_busy` and operators see
   the real cause. `runText` is unchanged.

Tests: the four assertions that pinned `-- --model …` are inverted (argv must
**not** contain `--model`), and new tests cover the startup `--timeout`, the
busy→success retry, the non-busy no-retry, and the bounded-attempts give-up. The
shared fake (`tests/factory/helpers/fakeHerdr.ts`) gained an `agentStartErrors`
queue so `agent start` can return an error document, as the real CLI does.

## Residual gap (open — NOT solved)

The Factory **validates** the routed model but **cannot force** the interactive
TUI's model. A deployment must pin its harness model in **opencode's own config**
(not in the herdr argv or env). Until that is done, the model recorded against an
Attempt's routing is a **validation/provenance** claim, not a guarantee that the
TUI ran that model. This is tracked as a **followed-up open item**; it is not
silently claimed as solved here.

Follow-up: pin the harness model via opencode config in the deployment (and, if
desired later, revisit whether a future opencode exposes a supported
model-selection primitive for the TUI).
