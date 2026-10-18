# E12.1 — Factory Orchestrator: NL control via the opencode-go inference API (GitHub #48)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-side orchestrator that accepts a natural-language message, translates it into
**enumerated Factory API operations** via a small in-TypeScript tool-calling loop, requires explicit
human confirmation for consequential actions, and (separately) polls GitHub for "ready" issues and
imports+claims them as Work Orders.

**Architecture:** A new generic `ModelClient` (HTTP, OpenAI-Chat-Completions and Anthropic-Messages
families) talks to `https://opencode.ai/inference`. A `ToolRegistry` enumerates the Factory API
operations (each a thin wrapper over `FactoryClient`). `createOrchestrator` runs the loop: ask the
model for a strict-JSON tool call → execute read tools via the client → pause for confirmation on
consequential tools. The orchestrator is injected into the E2 server as a dependency and exposed on
`POST /api/orchestrator/message`. A separate poller lists ready GitHub issues and imports+claims them.

**Tech Stack:** TypeScript / Bun; zero new runtime dependencies; hermetic tests (`fetch` injected).

**Spec:** GitHub issue #48 (quoted in full in `.superpowers/sdd/e12-orchestrator/explore-e12.md`),
the design doc `factory-docs/2026-09-17-software-factory-design.md` §12/§22/§23 and
`factory-docs/implementation/operating-guide.md` §5/§7, and the exact code map in
`.superpowers/sdd/e12-orchestrator/explore-e12.md` (sections A–F; cite its file:line).

## Global Constraints

- **Zero new runtime dependencies.** Bun/Node builtins only. `fetch` is injected for tests.
- **No direct state mutation.** Every action goes through the E2 API surface (`FactoryClient`);
  the orchestrator never touches the store/events/evidence directly.
- **Hermetic tests.** No live model calls, no network, no real subprocess. Inject a fake `fetch`
  (ModelClient/GitHub transport) or a fake `ModelClient` (orchestrator loop).
- **The API key is never logged** and never echoed in any DTO, error message, test snapshot, or
  event. Config carries an env-var *name* (`apiKeyEnv`), never a value.
- **Consequential actions require explicit human confirmation** in the conversation before any
  mutating call. The Factory's human gates stay authoritative.
- Suite green: `bun test` passes (baseline 487 pass / 0 fail at branch point `cac9e40`); `sh
  scripts/check-tsc.sh` exits 0.
- Keep every existing public signature of `FactoryClient`, `FactoryServerDeps`, the config parser,
  and the GitHub adapter transport backwards-compatible (additive only).
- Config validation follows the existing dotted-path `issue(...)` convention (`factoryConfig.ts:258`)
  and rejects unknown keys (as `github.token` does at `factoryConfig.ts:553`).

## Review Focus

Inputs/conditions the spec implies but that no single task's own tests name directly — each pinned
by a step in the task that owns the code:

1. **Missing key / quota.** With no `apiKeyEnv` value set (free model) the call is attempted; a
   401/403 or 429 from upstream surfaces a clear, key-free error naming the env var. (Task 2.)
2. **Consequential refusal → confirmation.** A gate/approval/e-stop request must produce **zero**
   mutating API calls until an explicit `confirm` is supplied, then exactly the confirmed call.
   (Task 3, and end-to-end in Task 4.)
3. **Unknown/over-broad tool output.** A model reply naming an unknown tool, or with malformed JSON,
   must not crash and must not mutate anything. (Task 3.)
4. **Per-message token cap.** A single message must not run unbounded: a step cap bounds model calls
   and a `max_tokens` bound is sent per call. (Task 3.)
5. **Poller idempotence.** A ready issue already imported must not be imported twice; a transport
   failure must not kill the poller or the server. (Task 5.)

---

### Task 1: `orchestrator:` config section

**Model:** implementer `opencode/deepseek-v4.1-flash-free`; reviewer `opencode/glm-5.3-flash-free`.

**Files:**
- Modify: `src/factory/config/factoryConfig.ts` (types ~`:33–137`, parse in `parseFactoryConfig` `:247–623`, resolve `:628–704`, serialize `:789–887`, `DEFAULT_FACTORY_CONFIG` `:183–215`)
- Test: `tests/factory/e12-orchestrator.test.ts` (new)

**Interfaces:**
- Consumes: `issue(path,message)` (`:258`), `isPlainObject` (`:221`), `isNonEmptyString` (`:225`),
  `isPositiveInteger` (`:229`), the env-var-name regex `/^[A-Za-z_][A-Za-z0-9_]*$/` (`:560`), the URL
  regex `/^https?:\/\//` (`:567`), and the unknown-key loop pattern (`:528–535`, `:553–557`).
- Produces (new exports):
  ```ts
  export type OrchestratorApiFamily = 'openai' | 'anthropic';
  export interface OrchestratorPollerDesired { label: string; intervalMs: number; }
  export interface OrchestratorDesired {
    baseUrl: string;              // https?://
    apiFamily: OrchestratorApiFamily;
    model: string;                // non-empty
    apiKeyEnv: string;            // /^[A-Za-z_][A-Za-z0-9_]*$/
    maxTokensPerMessage?: number; // positive int; default 2048
    poller?: OrchestratorPollerDesired;
  }
  ```
  Added as `orchestrator?: OrchestratorDesired` on `FactoryDesiredConfig` and carried through
  `resolveFactoryConfig` to `FactoryRuntimeConfig` (same shape; default `maxTokensPerMessage`), and
  emitted by `serializeFactoryConfig`.

- [ ] **Step 1: Write the failing config test.** In `tests/factory/e12-orchestrator.test.ts`, build a
  minimal valid `factory.yaml` text plus:
  ```yaml
  orchestrator:
    baseUrl: https://opencode.ai/inference
    apiFamily: openai
    model: glm-5.3-flash
    apiKeyEnv: OPENCODE_API_KEY
    maxTokensPerMessage: 2048
    poller:
      label: factory:ready
      intervalMs: 60000
  ```
  Assert `parseFactoryConfig(text).ok === true` and the resolved config carries the section
  (`resolveFactoryConfig(parsed.config, { baseDir }).orchestrator.model === 'glm-5.3-flash'`).
  Add negative cases (one `it` each): bad `baseUrl` (no scheme) → issue at `orchestrator.baseUrl`;
  `apiFamily: 'gemini'` → issue at `orchestrator.apiFamily`; `apiKeyEnv: '1X'` → issue at
  `orchestrator.apiKeyEnv`; unknown key `orchestrator.temperature` → issue at
  `orchestrator.temperature`; `poller` missing `label` → issue at `orchestrator.poller.label`.
- [ ] **Step 2: Run it — expect FAIL** (`orchestrator` is not yet parsed; `parsed.config.orchestrator`
  is undefined). Run: `bun test tests/factory/e12-orchestrator.test.ts -t orchestrator`.
- [ ] **Step 3: Implement the types + parse branch.** Add the types above; in `parseFactoryConfig`,
  add an `if (root.orchestrator !== undefined) { ... }` branch mirroring the `verification:` branch
  (`:432–513`): require a mapping; reject unknown keys against the known set
  `['baseUrl','apiFamily','model','apiKeyEnv','maxTokensPerMessage','poller']`; validate each; for
  `poller`, require `label` (non-empty) and `intervalMs` (positive int).
- [ ] **Step 4: Run the config test — expect PASS.**
- [ ] **Step 5: Wire resolve + serialize.** Add the carry-through in `resolveFactoryConfig`
  (`:691–704` pattern; default `maxTokensPerMessage ?? 2048`) and the emit block in
  `serializeFactoryConfig`. Add an `orchestrator` round-trip assertion to the test
  (serialize→parse yields the same section).
- [ ] **Step 6: Full suite + tsc.** Run: `bun test && sh scripts/check-tsc.sh` → all green.
- [ ] **Step 7: Commit.** `git commit -m "feat(config): add orchestrator: section (#48)"`

---

### Task 2: Generic `ModelClient` over the opencode inference API

**Model:** implementer `opencode/deepseek-v4.1-flash-free`; reviewer `opencode/glm-5.3-flash-free`.

**Files:**
- Create: `src/factory/inference/modelClient.ts`
- Test: `tests/factory/e12-orchestrator.test.ts` (append a `ModelClient` describe)

**Interfaces:**
- Consumes: nothing internal (Bun/Node `fetch` only, injected).
- Produces:
  ```ts
  export type ModelRole = 'system' | 'user' | 'assistant';
  export interface ModelTurn { role: ModelRole; content: string; }
  export interface ModelRequest { system?: string; turns: ModelTurn[]; maxTokens?: number; }
  export interface ModelUsage { inputTokens: number; outputTokens: number; }
  export interface ModelReply { text: string; usage?: ModelUsage; }
  export interface ModelClient { complete(request: ModelRequest): Promise<ModelReply>; }
  export type ModelApiFamily = 'openai' | 'anthropic';
  export type ModelFailureReason = 'auth' | 'quota' | 'transport' | 'upstream';
  export class ModelUnavailableError extends Error {
    constructor(readonly reason: ModelFailureReason, message: string);
  }
  export interface HttpModelClientOptions {
    baseUrl: string; apiFamily: ModelApiFamily; model: string;
    apiKey?: string;            // already read from env by the caller
    apiKeyEnvName: string;      // for error text only — never log the value
    fetch?: typeof fetch;       // hermetic tests
    timeoutMs?: number;
  }
  export function createHttpModelClient(options: HttpModelClientOptions): ModelClient;
  ```
  - **openai** family → `POST {baseUrl}/openai/v1/chat/completions`, body
    `{ model, messages: [{role,content},...incl. system], max_tokens }`; parse
    `choices[0].message.content`; usage `prompt_tokens`/`completion_tokens`.
  - **anthropic** family → `POST {baseUrl}/anthropic/v1/messages`, body
    `{ model, max_tokens, system?, messages }` (`max_tokens` REQUIRED — default 2048 when unset);
    parse `content[0].text`; usage `input_tokens`/`output_tokens`.
  - Auth header `Authorization: Bearer <apiKey>` only when `apiKey` is a non-empty string.
  - Map HTTP `401|403` → `reason:'auth'`, `429` → `'quota'`, other non-2xx → `'upstream'`, thrown
    fetch/timeout → `'transport'`; every message names `apiKeyEnvName` and **never** the key.

- [ ] **Step 1: Write failing tests** with an injected fake `fetch`:
  - openai: assert the request URL is `…/openai/v1/chat/completions`, the body parses to the right
    `{model,messages,max_tokens}`, the `Authorization` header equals `Bearer test-key`, and the
    returned `ModelReply.text`/`usage` match a canned response.
  - anthropic: assert `…/anthropic/v1/messages`, `max_tokens` present even when `maxTokens` unset,
    `system` hoisted, and `content[0].text` returned.
  - no `apiKey` → no `Authorization` header.
  - `401` → throws `ModelUnavailableError` with `reason:'auth'`, message contains `OPENCODE_API_KEY`
    and does **not** contain `test-key`. Same for `429`→`quota`, `500`→`upstream`, fetch throw
    →`transport`.
- [ ] **Step 2: Run — expect FAIL** (`Cannot find module .../modelClient`).
- [ ] **Step 3: Implement `createHttpModelClient`.** Join `baseUrl` with the family path
  (strip a trailing `/` first). Build/parse the two family shapes. Never interpolate `apiKey` into
  any error string.
- [ ] **Step 4: Run the tests — expect PASS.**
- [ ] **Step 5: Full suite + tsc.**
- [ ] **Step 6: Commit.** `git commit -m "feat(inference): generic ModelClient (openai+anthropic families) (#48)"`

---

### Task 3: Tool registry + orchestrator loop + confirmation gating

**Model:** implementer `opencode/deepseek-v4.1-flash-free`; reviewer `opencode/glm-5.3-flash-free`.

**Files:**
- Create: `src/factory/orchestrator/tools.ts`, `src/factory/orchestrator/orchestrator.ts`
- Test: `tests/factory/e12-orchestrator.test.ts` (append `tools` + `orchestrator` describes)

**Interfaces:**
- Consumes: `FactoryClient` (`src/factory/api/client.ts:53–84` — 21 methods verbatim in the explore
  report §C), `ModelClient`/`ModelRequest`/`ModelReply`/`ModelUnavailableError` (Task 2).
- Produces:
  ```ts
  // tools.ts
  export type ToolKind = 'read' | 'mutate' | 'control';
  export interface OrchestratorTool {
    name: string; description: string;
    parameters: Record<string, unknown>;           // JSON schema for args
    kind: ToolKind;
    run(args: Record<string, unknown>, client: FactoryClient): Promise<unknown>;
  }
  export const ORCHESTRATOR_TOOLS: readonly OrchestratorTool[];
  export function toolByName(name: string): OrchestratorTool | undefined;
  // orchestrator.ts
  export interface OrchestratorRequest {
    message: string;
    confirm?: { tool: string; args: Record<string, unknown> };
  }
  export type OrchestratorResult =
    | { status: 'ok'; summary: string; toolCalls: Array<{ tool: string; args: unknown }> }
    | { status: 'awaiting_confirmation'; pending: { tool: string; args: Record<string, unknown>; description: string }; summary: string }
    | { status: 'error'; error: { code: string; message: string } };
  export interface OrchestratorOptions {
    client: FactoryClient; model: ModelClient; modelName: string;
    maxTokensPerMessage?: number; maxSteps?: number;
  }
  export interface Orchestrator { handle(request: OrchestratorRequest): Promise<OrchestratorResult>; }
  export function createOrchestrator(options: OrchestratorOptions): Orchestrator;
  ```
  - **Tool set (enumerated, no shell/network):** read `list_work_orders`, `work_order_status`,
    `scheduler_status`, `observatory`, `list_approvals`, `list_interactions`; mutate
    `submit_work_order`, `github_import`, `transition_work_order`, `plan_dag`, `answer_interaction`,
    `answer_approval`, `gate_decision`, `github_open_pr`; control `pause`, `resume`,
    `emergency_stop`. Each `run` calls exactly one `FactoryClient` method (map documented in code).
  - **Loop contract (system prompt):** the model must reply with strict JSON —
    `{"tool":"<name>","args":{...}}` to act, or `{"final":"<summary>"}` to finish. Parse with
    `JSON.parse`; on parse failure or unknown tool, feed a one-line correction back and retry
    **once**, then return `{status:'error', error:{code:'ORCHESTRATOR_BAD_MODEL_OUTPUT', ...}}`.
  - **Confirmation gate:** a `read` tool runs immediately; a `mutate`/`control` tool is **not**
    executed — the loop returns `{status:'awaiting_confirmation', pending:{...}}`. When the request
    carries `confirm`, the orchestrator executes exactly that tool (via `toolByName`), **without**
    calling the model, and returns `ok`.
  - **Bounds:** at most `maxSteps` (default 8) model calls per request; each call sends
    `maxTokens: maxTokensPerMessage`. A `ModelUnavailableError` becomes
    `{status:'error', error:{code:'MODEL_UNAVAILABLE', message}}` (message already key-free).

- [ ] **Step 1: Write failing tests** with a **fake `ModelClient`** (a queue of scripted replies) and
  a **fake `FactoryClient`** (records every method call, returns canned DTOs):
  - Read path: model returns `{"tool":"list_work_orders","args":{}}` then
    `{"final":"2 work orders"}` → result `ok`, the fake client saw `listWorkOrders` once, and no
    mutate method was called.
  - Confirmation refusal: model returns `{"tool":"emergency_stop","args":{"actor":"me"}}` → result
    `awaiting_confirmation` and the fake client recorded **zero** calls.
  - Confirmation apply: same request but with `confirm:{tool:'emergency_stop',args:{actor:'me'}}` →
    result `ok`, the fake client saw `emergencyStop` once, and the model was **not** called.
  - Guardrail: `{"tool":"rm_rf","args":{}}` then the retry also bad → `error`
    `ORCHESTRATOR_BAD_MODEL_OUTPUT`, zero client calls.
  - Bound: a model that always returns a read tool call → stops at `maxSteps` and returns `error`
    `ORCHESTRATOR_STEP_LIMIT`.
  - `ModelUnavailableError` from the fake → `error` `MODEL_UNAVAILABLE`.
- [ ] **Step 2: Run — expect FAIL** (modules absent).
- [ ] **Step 3: Implement `tools.ts`** (the registry, one `run` per Factory API op) and
  **`orchestrator.ts`** (the loop + gate + bounds).
- [ ] **Step 4: Run the tests — expect PASS.**
- [ ] **Step 5: Full suite + tsc.**
- [ ] **Step 6: Commit.** `git commit -m "feat(orchestrator): tool registry + confirmation-gated NL loop (#48)"`

---

### Task 4: Wire the orchestrator into the server (+ client method)

**Model:** implementer `opencode/deepseek-v4.1-flash-free`; reviewer `opencode/glm-5.3-flash-free`.

**Files:**
- Modify: `src/factory/api/server.ts` (`FactoryServerDeps` `:63–88`, `route` `:339–668`, `STATUS_BY_CODE` `:105–127`)
- Modify: `src/factory/api/client.ts` (`FactoryClient` `:53–84`, `createFactoryClient` `:86–194`)
- Modify: `src/cli/factory.ts` (`ServerDepsOptions` `:247–324`, `buildServerDeps` `:513–667`)
- Test: `tests/factory/e12-orchestrator.test.ts` (append a route describe using `createApiHandler`)

**Interfaces:**
- Consumes: `createOrchestrator`/`Orchestrator`/`OrchestratorResult` (Task 3),
  `createHttpModelClient` (Task 2), the resolved `orchestrator:` config (Task 1), the E10.4 auth
  block (`server.ts:344–367`) which already gates every non-GET route.
- Produces:
  - `FactoryServerDeps.orchestrator?: Orchestrator` (new optional dep).
  - `route`: `POST /api/orchestrator/message` → `readJson<OrchestratorRequest>` →
    `deps.orchestrator.handle(body)` → `json(result)`; when `deps.orchestrator` is undefined →
    `apiError('ORCHESTRATOR_DISABLED', 'orchestrator is not configured', 503)` (add
    `ORCHESTRATOR_DISABLED: 503` to `STATUS_BY_CODE`). The route is mutating (POST) and therefore
    already requires a valid bearer token when `deps.auth` is set.
  - `FactoryClient.orchestratorMessage(request: OrchestratorRequest): Promise<OrchestratorResult>`
    (POST `/api/orchestrator/message`).
  - `buildServerDeps`: when `runtime.orchestrator` is present, read `process.env[runtime.orchestrator.apiKeyEnv]`
    (value used only as the `apiKey` option; **never logged/stored elsewhere**) and construct the
    `Orchestrator`; otherwise leave `orchestrator` undefined. Honor an optional
    `ServerDepsOptions.orchestrator?` test seam.

- [ ] **Step 1: Write failing route tests** via `createApiHandler(deps)` (pattern:
  `tests/factory/e10-integration.test.ts:2151,2212` + the `post(handler,path,body,token?)` helper
  `:2130–2146`):
  - With a stub `orchestrator` dep and **no** `auth`, `POST /api/orchestrator/message {message:'hi'}`
    returns the orchestrator's result.
  - With `auth` configured, the same POST **without** a token → `401 UNAUTHENTICATED`; **with** the
    bearer token → 200. (GET stays public; assert a GET to `/api/health` still succeeds unauthenticated.)
  - With no `orchestrator` dep → `503 ORCHESTRATOR_DISABLED`.
  - Client: `createFactoryClient(...).orchestratorMessage(...)` posts to the right path (assert via
    an injected `fetch`).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the deps field, the route branch, the status code, the client method, and
  the `buildServerDeps` composition (read the API key from env; never log it). Keep the route
  additive so all existing routes are untouched.
- [ ] **Step 4: Run the tests — expect PASS.**
- [ ] **Step 5: Full suite + tsc.**
- [ ] **Step 6: Commit.** `git commit -m "feat(api): POST /api/orchestrator/message + client method (#48)"`

---

### Task 5: GitHub "ready ticket" poller (import + claim)

**Model:** implementer `opencode/deepseek-v4.1-flash-free`; reviewer `opencode/glm-5.3-flash-free`.

**Files:**
- Modify: `src/factory/github/adapter.ts` (transport interface `:128–136`, `createGitHubRestTransport`
  `:205–241`) — add a read-all-issues-by-label method
- Create: `src/factory/github/poller.ts`
- Modify: `src/cli/factory.ts` (`buildServerDeps` `:588–605` GitHub adapter; start the poller in
  `cmdServe` `:794–839` alongside `deps.scheduler?.start()` `:819`)
- Test: `tests/factory/e12-orchestrator.test.ts` (append a poller describe with a fake transport)

**Interfaces:**
- Consumes: the existing `GitHubTransport`/adapter (`importIssue`, `openPR`) and the resolved
  `orchestrator.poller` config (`{label, intervalMs}`); the store (to dedupe already-imported issues).
- Produces:
  ```ts
  // adapter.ts (additive)
  export interface GitHubReadyIssue { number: number; title: string; url: string; body?: string; }
  // GitHubTransport gains: listIssuesByLabel(label: string): Promise<GitHubReadyIssue[]>;
  //   implemented in createGitHubRestTransport via GET /repos/:owner/:repo/issues?state=open&labels=:label
  // poller.ts
  export interface ReadyTicketPoller {
    start(): void; stop(): void;
    tick(): Promise<{ imported: number; skipped: number }>;
  }
  export interface ReadyTicketPollerOptions {
    adapter: GitHubAdapter;      // from the factory adapter module
    store: StateStore;
    label: string; intervalMs: number;
    alreadyImported?(issue: GitHubReadyIssue): boolean;   // dedupe seam
    onError?(error: unknown): void;
  }
  export function createReadyTicketPoller(options: ReadyTicketPollerOptions): ReadyTicketPoller;
  ```
  - `tick()` lists issues by label, skips any already imported (dedupe by issue number/URL — read
    the adapter/store to find the exact existing identity; reuse the same import+claim path the
    manual `/api/github/import` route uses, `server.ts:595–607`), imports the rest, and claims each
    via the Factory's normal claim transition. A transport/import error is caught, reported via
    `onError`, and never thrown out of `tick()`.
  - `start()`/`stop()` use a `setInterval`/`clearInterval` pair guarded against double-start.

- [ ] **Step 1: Write failing poller tests** with a fake transport returning two ready issues:
  - `tick()` imports both and returns `{imported:2, skipped:0}`.
  - A second `tick()` with the same issues returns `{imported:0, skipped:2}` (idempotent).
  - A transport that throws → `tick()` resolves `{imported:0, skipped:0}` and `onError` fired; the
    poller is still usable on the next `tick()`.
  - Assert the transport was called with `labels=<label>` / `state=open` (shape from the fake).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the transport method + poller; wire `start()` in `cmdServe` only when
  `runtime.orchestrator?.poller` is present, and `stop()` on shutdown.
- [ ] **Step 4: Run the tests — expect PASS.**
- [ ] **Step 5: Full suite + tsc.**
- [ ] **Step 6: Commit.** `git commit -m "feat(github): ready-ticket poller imports+claims open issues (#48)"`

## Self-Review

- **Spec coverage:** config `orchestrator:` → Task 1; generic `ModelClient` usable by the judge →
  Task 2; enumerated tool registry + no-direct-mutation + confirmation + token cap →
  Task 3; server route + auth + never-log-key → Task 4; ready-ticket poller (mocked transport) →
  Task 5. Acceptance criteria map: "create a work order for X" → Task 3 read/mutate loop + Task 4
  route; "gate/approval/e-stop refused then applied on confirmation" → Task 3 Steps 1 + Task 4;
  "ready GitHub issue imported+claimed by the poller (mocked transport)" → Task 5; "API key never
  logged; missing key/quota fails loudly" → Task 2 Step 1 + Task 4 Step 3; "`bun test` green" →
  every task's Step 5.
- **Out of scope for this plan (E12.2 / #49):** the web UI, the SPA static route, and the chat panel
  that consumes `POST /api/orchestrator/message`. They get their own plan after this one lands.
- **Type consistency:** one `ModelClient`/`Orchestrator`/`OrchestratorResult`/`OrchestratorTool`
  definition, reused verbatim across tasks. `OrchestratorRequest` is shared by the client method,
  the route, and the orchestrator.
- **Ruling recorded:** the issue's `POST /api/experimental/generate` one-shot is superseded by the
  issue's later, confirmed Inference-API section (`baseUrl https://opencode.ai/inference`,
  OpenAI Chat Completions / Anthropic Messages families, Bearer auth). The plan targets the
  confirmed shapes; `apiFamily` is config so a future family swap is contained.
