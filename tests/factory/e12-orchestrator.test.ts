import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_FACTORY_CONFIG,
  parseFactoryConfig,
  resolveFactoryConfig,
  serializeFactoryConfig,
} from '../../src/factory/config/factoryConfig';
import {
  ModelUnavailableError,
  createHttpModelClient,
} from '../../src/factory/inference/modelClient';
import type {
  ModelClient,
  ModelFailureReason,
  ModelReply,
  ModelRequest,
} from '../../src/factory/inference/modelClient';
import type { FactoryClient } from '../../src/factory/api/client';
import { ORCHESTRATOR_TOOLS, toolByName } from '../../src/factory/orchestrator/tools';
import { createOrchestrator } from '../../src/factory/orchestrator/orchestrator';
import type { OrchestratorResult } from '../../src/factory/orchestrator/orchestrator';

/**
 * E12 (#48) — the `orchestrator:` config section. The Factory carries the
 * desired identity of the natural-language orchestrator (its inference endpoint,
 * API family, model, and the *name* of the environment variable holding the API
 * key — never the key itself), so later tasks can compose a live orchestrator
 * from a validated `factory.yaml`. Present, every field must be well-formed;
 * absent, nothing is wired.
 */

/**
 * A minimal valid `factory.yaml` (the `factory init` template) with the given
 * `orchestrator:` block appended. The base is serialized from
 * `DEFAULT_FACTORY_CONFIG`, so the fixture can only fail for orchestrator
 * reasons.
 */
function configWith(block: string): string {
  const base = serializeFactoryConfig({ ...DEFAULT_FACTORY_CONFIG });
  return `${base}${block}`;
}

const VALID_ORCHESTRATOR = [
  'orchestrator:',
  '  baseUrl: https://opencode.ai/inference',
  '  apiFamily: openai',
  '  model: glm-5.3-flash',
  '  apiKeyEnv: OPENCODE_API_KEY',
  '  maxTokensPerMessage: 2048',
  '  poller:',
  '    label: factory:ready',
  '    intervalMs: 60000',
  '',
].join('\n');

describe('E12 orchestrator: config section (#48)', () => {
  it('parses and resolves a configured orchestrator: section', () => {
    const text = configWith(VALID_ORCHESTRATOR);
    const parsed = parseFactoryConfig(text);
    if (!parsed.ok) {
      throw new Error(`fixture factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
    }
    expect(parsed.ok).toBe(true);

    const runtime = resolveFactoryConfig(parsed.config, { baseDir: process.cwd() });
    expect(runtime.orchestrator).toEqual({
      baseUrl: 'https://opencode.ai/inference',
      apiFamily: 'openai',
      model: 'glm-5.3-flash',
      apiKeyEnv: 'OPENCODE_API_KEY',
      maxTokensPerMessage: 2048,
      poller: { label: 'factory:ready', intervalMs: 60000 },
    });
    expect(runtime.orchestrator?.model).toBe('glm-5.3-flash');
  });

  it('defaults maxTokensPerMessage to 2048 and poller to absent when omitted', () => {
    const text = configWith(
      [
        'orchestrator:',
        '  baseUrl: https://opencode.ai/inference',
        '  apiFamily: anthropic',
        '  model: claude-sonnet-4',
        '  apiKeyEnv: ANTHROPIC_API_KEY',
        '',
      ].join('\n'),
    );
    const parsed = parseFactoryConfig(text);
    if (!parsed.ok) {
      throw new Error(`fixture factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
    }
    const runtime = resolveFactoryConfig(parsed.config, { baseDir: process.cwd() });
    expect(runtime.orchestrator?.maxTokensPerMessage).toBe(2048);
    expect(runtime.orchestrator?.poller).toBeUndefined();
  });

  it('leaves orchestrator undefined when the section is absent', () => {
    const parsed = parseFactoryConfig(configWith(''));
    if (!parsed.ok) {
      throw new Error(`baseline factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
    }
    expect(parsed.config.orchestrator).toBeUndefined();
    expect(
      resolveFactoryConfig(parsed.config, { baseDir: process.cwd() }).orchestrator,
    ).toBeUndefined();
  });

  it('rejects a baseUrl without an http(s) scheme at orchestrator.baseUrl', () => {
    const parsed = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: opencode.ai/inference',
          '  apiFamily: openai',
          '  model: glm-5.3-flash',
          '  apiKeyEnv: OPENCODE_API_KEY',
          '',
        ].join('\n'),
      ),
    );
    if (parsed.ok) throw new Error('a scheme-less orchestrator.baseUrl must not parse');
    expect(parsed.issues.some((issue) => issue.path === 'orchestrator.baseUrl')).toBe(true);
  });

  it('rejects an unsupported apiFamily at orchestrator.apiFamily', () => {
    const parsed = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: https://example.test/v1',
          '  apiFamily: gemini',
          '  model: gemini-2.0',
          '  apiKeyEnv: GEMINI_API_KEY',
          '',
        ].join('\n'),
      ),
    );
    if (parsed.ok) throw new Error('an unsupported orchestrator.apiFamily must not parse');
    expect(parsed.issues.some((issue) => issue.path === 'orchestrator.apiFamily')).toBe(true);
  });

  it('rejects an apiKeyEnv that is not an environment-variable name', () => {
    const parsed = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: https://example.test/v1',
          '  apiFamily: openai',
          '  model: glm-5.3-flash',
          '  apiKeyEnv: 1X',
          '',
        ].join('\n'),
      ),
    );
    if (parsed.ok) throw new Error('a non-env-var orchestrator.apiKeyEnv must not parse');
    expect(parsed.issues.some((issue) => issue.path === 'orchestrator.apiKeyEnv')).toBe(true);
  });

  it('rejects unknown keys inside orchestrator', () => {
    const parsed = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: https://example.test/v1',
          '  apiFamily: openai',
          '  model: glm-5.3-flash',
          '  apiKeyEnv: OPENCODE_API_KEY',
          '  temperature: 0.2',
          '',
        ].join('\n'),
      ),
    );
    if (parsed.ok) throw new Error('an unknown orchestrator key must not parse');
    expect(parsed.issues.some((issue) => issue.path === 'orchestrator.temperature')).toBe(true);
  });

  it('requires poller.label and a positive poller.intervalMs', () => {
    const missingLabel = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: https://example.test/v1',
          '  apiFamily: openai',
          '  model: glm-5.3-flash',
          '  apiKeyEnv: OPENCODE_API_KEY',
          '  poller:',
          '    intervalMs: 60000',
          '',
        ].join('\n'),
      ),
    );
    if (missingLabel.ok) throw new Error('a poller without a label must not parse');
    expect(missingLabel.issues.some((issue) => issue.path === 'orchestrator.poller.label')).toBe(true);

    const badInterval = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: https://example.test/v1',
          '  apiFamily: openai',
          '  model: glm-5.3-flash',
          '  apiKeyEnv: OPENCODE_API_KEY',
          '  poller:',
          '    label: factory:ready',
          '    intervalMs: 0',
          '',
        ].join('\n'),
      ),
    );
    if (badInterval.ok) throw new Error('a non-positive poller.intervalMs must not parse');
    expect(badInterval.issues.some((issue) => issue.path === 'orchestrator.poller.intervalMs')).toBe(
      true,
    );
  });

  it('round-trips the orchestrator: section through serialize → parse', () => {
    const parsed = parseFactoryConfig(configWith(VALID_ORCHESTRATOR));
    if (!parsed.ok) {
      throw new Error(`fixture factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
    }
    const serialized = serializeFactoryConfig(parsed.config);
    const reparsed = parseFactoryConfig(serialized);
    if (!reparsed.ok) {
      throw new Error(`round-tripped factory.yaml invalid: ${JSON.stringify(reparsed.issues)}`);
    }
    expect(reparsed.config.orchestrator).toEqual(parsed.config.orchestrator);
    expect(serializeFactoryConfig(reparsed.config)).toBe(serialized);
  });
});

// ---------------------------------------------------------------------------
// T2 — the generic ModelClient over the opencode inference API (hermetic:
// injected fetch, no network, the API key never echoed)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A `typeof fetch` stand-in that records every call and answers with a canned
 * `Response`. Mirrors the E6 GitHub transport's `recordingFetch` pattern
 * (`tests/factory/e6-github.test.ts:719`): nothing here touches the network.
 */
function recordingFetch(respond: (request: RecordedRequest) => Response): {
  impl: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const request = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    };
    calls.push(request);
    return respond(request);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('E12 orchestrator: ModelClient (#48)', () => {
  const BASE_URL = 'https://opencode.ai/inference';
  const KEY = 'test-key';
  const KEY_ENV = 'OPENCODE_API_KEY';

  it('openai family: POSTs the chat-completions URL, body, and bearer header; parses the reply', async () => {
    const { impl, calls } = recordingFetch(() =>
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'hello there' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
    const client = createHttpModelClient({
      baseUrl: `${BASE_URL}/`,
      apiFamily: 'openai',
      model: 'glm-5.3-flash',
      apiKey: KEY,
      apiKeyEnvName: KEY_ENV,
      fetch: impl,
    });

    const reply = await client.complete({
      system: 'be terse',
      turns: [{ role: 'user', content: 'hi' }],
      maxTokens: 128,
    });

    expect(reply).toEqual({ text: 'hello there', usage: { inputTokens: 11, outputTokens: 7 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    // The trailing slash on baseUrl is stripped before joining the family path.
    expect(calls[0]!.url).toBe(`${BASE_URL}/openai/v1/chat/completions`);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toEqual({
      model: 'glm-5.3-flash',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 128,
    });
  });

  it('anthropic family: hoists system, always sends max_tokens (default 2048), parses content[0].text', async () => {
    const { impl, calls } = recordingFetch(() =>
      jsonResponse({
        content: [{ type: 'text', text: 'hoisted reply' }],
        usage: { input_tokens: 21, output_tokens: 13 },
      }),
    );
    const client = createHttpModelClient({
      baseUrl: BASE_URL,
      apiFamily: 'anthropic',
      model: 'claude-sonnet-4',
      apiKey: KEY,
      apiKeyEnvName: KEY_ENV,
      fetch: impl,
    });

    const reply = await client.complete({
      system: 'be terse',
      turns: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });

    expect(reply).toEqual({ text: 'hoisted reply', usage: { inputTokens: 21, outputTokens: 13 } });
    expect(calls[0]!.url).toBe(`${BASE_URL}/anthropic/v1/messages`);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toEqual({
      model: 'claude-sonnet-4',
      max_tokens: 2048,
      system: 'be terse',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
  });

  it('anthropic family: honors an explicit maxTokens', async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse({ content: [{ text: 'ok' }] }));
    const client = createHttpModelClient({
      baseUrl: BASE_URL,
      apiFamily: 'anthropic',
      model: 'qwen3-max',
      apiKey: KEY,
      apiKeyEnvName: KEY_ENV,
      fetch: impl,
    });

    await client.complete({ turns: [{ role: 'user', content: 'hi' }], maxTokens: 512 });

    expect((calls[0]!.body as { max_tokens: number }).max_tokens).toBe(512);
    expect((calls[0]!.body as { system?: string }).system).toBeUndefined();
  });

  it('sends no Authorization header when apiKey is absent or empty (free models need no key)', async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = createHttpModelClient({
      baseUrl: BASE_URL,
      apiFamily: 'openai',
      model: 'deepseek-v4.1-flash-free',
      apiKey: '',
      apiKeyEnvName: KEY_ENV,
      fetch: impl,
    });

    await client.complete({ turns: [{ role: 'user', content: 'hi' }] });

    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('maps 401/403 → auth, 429 → quota, 500 → upstream, naming the env var and never the key', async () => {
    const cases: Array<{ status: number; reason: ModelFailureReason }> = [
      { status: 401, reason: 'auth' },
      { status: 403, reason: 'auth' },
      { status: 429, reason: 'quota' },
      { status: 500, reason: 'upstream' },
    ];
    for (const { status, reason } of cases) {
      const { impl } = recordingFetch(() => jsonResponse({ error: { message: 'nope' } }, status));
      const client = createHttpModelClient({
        baseUrl: BASE_URL,
        apiFamily: 'openai',
        model: 'glm-5.3-flash',
        apiKey: KEY,
        apiKeyEnvName: KEY_ENV,
        fetch: impl,
      });

      const error = await client
        .complete({ turns: [{ role: 'user', content: 'hi' }] })
        .then(() => null)
        .catch((thrown: unknown) => thrown as ModelUnavailableError);

      expect(error).toBeInstanceOf(ModelUnavailableError);
      expect(error!.reason).toBe(reason);
      expect(error!.message).toContain(KEY_ENV);
      expect(error!.message).not.toContain(KEY);
    }
  });

  it('maps a thrown fetch/timeout → transport, naming the env var and never the key', async () => {
    const { impl } = recordingFetch(() => {
      throw new Error('socket hang up');
    });
    const client = createHttpModelClient({
      baseUrl: BASE_URL,
      apiFamily: 'anthropic',
      model: 'claude-sonnet-4',
      apiKey: KEY,
      apiKeyEnvName: KEY_ENV,
      fetch: impl,
    });

    const error = await client
      .complete({ turns: [{ role: 'user', content: 'hi' }] })
      .then(() => null)
      .catch((thrown: unknown) => thrown as ModelUnavailableError);

    expect(error).toBeInstanceOf(ModelUnavailableError);
    expect(error!.reason).toBe('transport');
    expect(error!.message).toContain(KEY_ENV);
    expect(error!.message).not.toContain(KEY);
  });

  it('a fetch that never settles becomes a transport failure once timeoutMs elapses', async () => {
    // Abort-aware: like real `fetch`, the pending request rejects when the
    // client's timeout aborts the signal, so nothing dangles after the test.
    const hanging = ((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const client = createHttpModelClient({
      baseUrl: BASE_URL,
      apiFamily: 'openai',
      model: 'glm-5.3-flash',
      apiKeyEnvName: KEY_ENV,
      fetch: hanging,
      timeoutMs: 20,
    });

    const error = await client
      .complete({ turns: [{ role: 'user', content: 'hi' }] })
      .then(() => null)
      .catch((thrown: unknown) => thrown as ModelUnavailableError);

    expect(error).toBeInstanceOf(ModelUnavailableError);
    expect(error!.reason).toBe('transport');
    expect(error!.message).toContain(KEY_ENV);
  });
});

// ---------------------------------------------------------------------------
// T3 — the tool registry + the confirmation-gated orchestration loop (#48)
// ---------------------------------------------------------------------------

interface RecordedFactoryCall {
  method: string;
  args: unknown[];
}

/**
 * A recording `FactoryClient` stand-in. Every method access resolves to an async
 * function that records `{ method, args }` and answers with the canned DTO for
 * that method (or a canned function's result). A canned function that throws
 * rejects the call, exactly as a real `FactoryApiError` would. Nothing here
 * touches the network or Factory state — which is exactly how "the loop performs
 * no direct mutation" and "a refused confirmation makes zero calls" become
 * observable.
 */
function fakeFactoryClient(canned: Partial<Record<keyof FactoryClient, unknown>> = {}): {
  client: FactoryClient;
  calls: RecordedFactoryCall[];
  methods: () => string[];
} {
  const calls: RecordedFactoryCall[] = [];
  const client = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string') return undefined;
        return async (...args: unknown[]) => {
          calls.push({ method: property, args });
          const entry = canned[property as keyof FactoryClient];
          return typeof entry === 'function'
            ? (entry as (...a: unknown[]) => unknown)(...args)
            : entry;
        };
      },
    },
  ) as FactoryClient;
  return { client, calls, methods: () => calls.map((call) => call.method) };
}

/** A scripted `ModelClient`: one reply per call, then a hard error. */
function scriptedModelClient(replies: Array<string | Error>): {
  model: ModelClient;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let next = 0;
  const model: ModelClient = {
    async complete(request: ModelRequest): Promise<ModelReply> {
      requests.push(request);
      if (next >= replies.length) {
        throw new Error(
          'scripted model client exhausted: the orchestrator called the model more times than scripted',
        );
      }
      const reply = replies[next++]!;
      if (reply instanceof Error) throw reply;
      return { text: reply };
    },
  };
  return { model, requests };
}

/** The eight Factory methods that change state; a read path must never touch them. */
const MUTATING_METHODS = new Set<string>([
  'submitWorkOrder',
  'githubImportIssue',
  'transitionWorkOrder',
  'commitDag',
  'answerInteraction',
  'answerApproval',
  'applyGate',
  'githubOpenPullRequest',
  'pause',
  'resume',
  'emergencyStop',
]);

/** The plan's enumerated tool set, and the one Factory method each tool calls. */
const TOOL_METHOD: Record<string, keyof FactoryClient> = {
  list_work_orders: 'listWorkOrders',
  work_order_status: 'getWorkOrder',
  scheduler_status: 'schedulerStatus',
  observatory: 'observatory',
  list_approvals: 'listApprovals',
  list_interactions: 'listInteractions',
  submit_work_order: 'submitWorkOrder',
  github_import: 'githubImportIssue',
  transition_work_order: 'transitionWorkOrder',
  plan_dag: 'commitDag',
  answer_interaction: 'answerInteraction',
  answer_approval: 'answerApproval',
  gate_decision: 'applyGate',
  github_open_pr: 'githubOpenPullRequest',
  pause: 'pause',
  resume: 'resume',
  emergency_stop: 'emergencyStop',
};

/** Sample args that satisfy every tool's required fields (extra keys are ignored). */
const SAMPLE_ARGS: Record<string, unknown> = {
  id: 'wo-1',
  to: 'PLANNING',
  reason: 'because',
  decision: 'APPROVE',
  actor: 'operator',
  response: 'yes',
  status: 'PENDING',
  intent: 'do the thing',
  repository: 'acme/widgets',
  number: 7,
  evidenceBundleId: 'eb-1',
  payload: { nodes: [] },
};

describe('E12 orchestrator: tool registry (#48)', () => {
  it('exposes exactly the enumerated tools, each well-formed and uniquely named', () => {
    expect(ORCHESTRATOR_TOOLS).toHaveLength(17);
    expect(new Set(ORCHESTRATOR_TOOLS.map((tool) => tool.name)).size).toBe(17);
    expect(ORCHESTRATOR_TOOLS.map((tool) => tool.name).sort()).toEqual(
      Object.keys(TOOL_METHOD).sort(),
    );
    for (const tool of ORCHESTRATOR_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters['type']).toBe('object');
      expect(['read', 'mutate', 'control']).toContain(tool.kind);
      expect(typeof tool.run).toBe('function');
    }
  });

  it('classifies each tool as read, mutate, or control exactly as the plan enumerates', () => {
    const reads = [
      'list_work_orders',
      'work_order_status',
      'scheduler_status',
      'observatory',
      'list_approvals',
      'list_interactions',
    ];
    const mutates = [
      'submit_work_order',
      'github_import',
      'transition_work_order',
      'plan_dag',
      'answer_interaction',
      'answer_approval',
      'gate_decision',
      'github_open_pr',
    ];
    const controls = ['pause', 'resume', 'emergency_stop'];
    for (const name of reads) expect(toolByName(name)?.kind).toBe('read');
    for (const name of mutates) expect(toolByName(name)?.kind).toBe('mutate');
    for (const name of controls) expect(toolByName(name)?.kind).toBe('control');
    expect(reads.length + mutates.length + controls.length).toBe(17);
    expect(toolByName('rm_rf')).toBeUndefined();
  });

  it('every run delegates to exactly one FactoryClient method, and no tool reaches the shell', async () => {
    for (const tool of ORCHESTRATOR_TOOLS) {
      const factory = fakeFactoryClient({});
      await tool.run(SAMPLE_ARGS, factory.client);
      expect(factory.calls).toHaveLength(1);
      expect(factory.calls[0]!.method).toBe(TOOL_METHOD[tool.name]!);
    }
  });
});

describe('E12 orchestrator: loop + confirmation gate (#48)', () => {
  const MODEL = 'glm-5.3-flash';

  function resultOf(result: OrchestratorResult): OrchestratorResult {
    return result;
  }

  it('read path: runs a read tool, feeds the result back, and returns the model summary', async () => {
    const factory = fakeFactoryClient({
      listWorkOrders: [{ id: 'wo-1' }, { id: 'wo-2' }],
    });
    const { model, requests } = scriptedModelClient([
      '{"tool":"list_work_orders","args":{}}',
      '{"final":"2 work orders"}',
    ]);
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(await orchestrator.handle({ message: 'how many work orders?' }));

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.summary).toBe('2 work orders');
    expect(result.toolCalls).toEqual([{ tool: 'list_work_orders', args: {} }]);
    expect(factory.methods()).toEqual(['listWorkOrders']);
    expect(factory.methods().some((method) => MUTATING_METHODS.has(method))).toBe(false);
    // The read tool's DTO was fed back to the model as an observation.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.turns.some((turn) => turn.content.includes('wo-1'))).toBe(true);
    // Carry-forward from Task 2: max_tokens rides on every call (default 2048).
    expect(requests[0]!.maxTokens).toBe(2048);
    expect(requests[1]!.maxTokens).toBe(2048);
  });

  it('read loop: a throwing read tool reports ORCHESTRATOR_TOOL_FAILED and stops the loop', async () => {
    const factory = fakeFactoryClient({
      listWorkOrders: () => {
        throw new Error('factory unreachable');
      },
    });
    const { model, requests } = scriptedModelClient([
      '{"tool":"list_work_orders","args":{}}',
      '{"final":"this final must never be reached"}',
    ]);
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(await orchestrator.handle({ message: 'list the work orders' }));

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error(`expected error, got ${result.status}`);
    expect(result.error.code).toBe('ORCHESTRATOR_TOOL_FAILED');
    expect(result.error.message).toContain('factory unreachable');
    // The error plainly reports failure; it does not carry a success summary.
    expect((result as { summary?: unknown }).summary).toBeUndefined();
    // Exactly one client call, and the loop stopped: the second scripted model
    // reply was never consumed, so no further model call (or tool call) happened.
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]!.method).toBe('listWorkOrders');
    expect(requests).toHaveLength(1);
  });

  it('advertises every tool and the strict-JSON contract in the system prompt', async () => {    const factory = fakeFactoryClient();
    const { model, requests } = scriptedModelClient(['{"final":"nothing to do"}']);
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(await orchestrator.handle({ message: 'hello' }));

    expect(result.status).toBe('ok');
    const system = requests[0]!.system ?? '';
    for (const tool of ORCHESTRATOR_TOOLS) expect(system).toContain(tool.name);
    expect(system).toContain('{"tool"');
    expect(system).toContain('{"final"');
    expect(factory.calls).toHaveLength(0);
  });

  it('sends maxTokensPerMessage on every model call when overridden', async () => {
    const factory = fakeFactoryClient({ listWorkOrders: [] });
    const { model, requests } = scriptedModelClient([
      '{"tool":"list_work_orders","args":{}}',
      '{"final":"none"}',
    ]);
    const orchestrator = createOrchestrator({
      client: factory.client,
      model,
      modelName: MODEL,
      maxTokensPerMessage: 512,
    });

    await orchestrator.handle({ message: 'anything pending?' });

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.maxTokens === 512)).toBe(true);
  });

  it('confirmation refused: a mutate/control tool is never executed and zero client calls happen', async () => {
    const factory = fakeFactoryClient();
    const { model, requests } = scriptedModelClient(['{"tool":"emergency_stop","args":{"actor":"me"}}']);
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(await orchestrator.handle({ message: 'stop everything now' }));

    expect(result.status).toBe('awaiting_confirmation');
    if (result.status !== 'awaiting_confirmation') {
      throw new Error(`expected awaiting_confirmation, got ${result.status}`);
    }
    expect(result.pending.tool).toBe('emergency_stop');
    expect(result.pending.args).toEqual({ actor: 'me' });
    expect(result.pending.description.length).toBeGreaterThan(0);
    expect(factory.calls).toHaveLength(0);
    // The model was consulted exactly once (to propose), never to execute.
    expect(requests).toHaveLength(1);
  });

  it('confirmation applied: executes exactly the confirmed tool without calling the model', async () => {
    const factory = fakeFactoryClient({ emergencyStop: { paused: true, emergencyStopped: true } });
    const { model, requests } = scriptedModelClient([]);
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(
      await orchestrator.handle({
        message: 'stop everything now',
        confirm: { tool: 'emergency_stop', args: { actor: 'me' } },
      }),
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]!.method).toBe('emergencyStop');
    expect(factory.calls[0]!.args).toEqual(['me']);
    expect(result.toolCalls).toEqual([{ tool: 'emergency_stop', args: { actor: 'me' } }]);
    // The model is never called on the confirmation path.
    expect(requests).toHaveLength(0);
  });

  it('confirmation of an unknown tool is an error and makes zero client calls', async () => {
    const factory = fakeFactoryClient();
    const { model, requests } = scriptedModelClient([]);
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(
      await orchestrator.handle({ message: 'do it', confirm: { tool: 'rm_rf', args: {} } }),
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error(`expected error, got ${result.status}`);
    expect(result.error.code).toBe('ORCHESTRATOR_UNKNOWN_TOOL');
    expect(factory.calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('confirmation apply: a throwing tool reports ORCHESTRATOR_TOOL_FAILED, once, without the model', async () => {
    const factory = fakeFactoryClient({
      emergencyStop: () => {
        throw new Error('factory unreachable');
      },
    });
    const { model, requests } = scriptedModelClient([]);
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(
      await orchestrator.handle({
        message: 'stop everything now',
        confirm: { tool: 'emergency_stop', args: { actor: 'me' } },
      }),
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error(`expected error, got ${result.status}`);
    expect(result.error.code).toBe('ORCHESTRATOR_TOOL_FAILED');
    expect(result.error.message).toContain('factory unreachable');
    // Exactly the one confirmed call was attempted; the model was never consulted.
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]!.method).toBe('emergencyStop');
    expect(factory.calls[0]!.args).toEqual(['me']);
    expect(requests).toHaveLength(0);
  });

  it('guardrail: an unknown tool is corrected once, then a second offence errors with zero calls', async () => {
    const factory = fakeFactoryClient();
    const { model, requests } = scriptedModelClient([
      '{"tool":"rm_rf","args":{}}',
      '{"tool":"rm_rf","args":{}}',
    ]);
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(await orchestrator.handle({ message: 'nuke it' }));

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error(`expected error, got ${result.status}`);
    expect(result.error.code).toBe('ORCHESTRATOR_BAD_MODEL_OUTPUT');
    expect(factory.calls).toHaveLength(0);
    // Retried exactly once: two model calls, no third.
    expect(requests).toHaveLength(2);
  });

  it('guardrail: non-JSON output is corrected once, and a valid retry recovers', async () => {
    const factory = fakeFactoryClient();
    const { model, requests } = scriptedModelClient([
      'sorry, I cannot do that',
      '{"final":"recovered"}',
    ]);
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(await orchestrator.handle({ message: 'hello' }));

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.summary).toBe('recovered');
    expect(requests).toHaveLength(2);
    expect(factory.calls).toHaveLength(0);
  });

  it('a second offence after an accepted reply earns its own correction turn', async () => {
    const factory = fakeFactoryClient({ listWorkOrders: [] });
    const { model, requests } = scriptedModelClient([
      'not json yet',
      '{"tool":"list_work_orders","args":{}}',
      'bad again',
      '{"final":"recovered twice"}',
    ]);
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(await orchestrator.handle({ message: 'hello' }));

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.summary).toBe('recovered twice');
    expect(requests).toHaveLength(4);
    expect(factory.methods()).toEqual(['listWorkOrders']);
  });

  it('bound: a model that never finishes stops at maxSteps with ORCHESTRATOR_STEP_LIMIT', async () => {    const factory = fakeFactoryClient({ listWorkOrders: [] });
    const { model, requests } = scriptedModelClient([
      '{"tool":"list_work_orders","args":{}}',
      '{"tool":"list_work_orders","args":{}}',
      '{"tool":"list_work_orders","args":{}}',
      '{"tool":"list_work_orders","args":{}}',
      '{"tool":"list_work_orders","args":{}}',
    ]);
    const orchestrator = createOrchestrator({
      client: factory.client,
      model,
      modelName: MODEL,
      maxSteps: 3,
    });

    const result = resultOf(await orchestrator.handle({ message: 'loop forever' }));

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error(`expected error, got ${result.status}`);
    expect(result.error.code).toBe('ORCHESTRATOR_STEP_LIMIT');
    // Exactly maxSteps model calls — the cap is a hard bound, not a hint.
    expect(requests).toHaveLength(3);
    expect(factory.methods()).toEqual(['listWorkOrders', 'listWorkOrders', 'listWorkOrders']);
  });

  it('bound: defaults maxSteps to 8', async () => {
    const factory = fakeFactoryClient({ listWorkOrders: [] });
    const { model, requests } = scriptedModelClient(new Array(9).fill('{"tool":"list_work_orders","args":{}}'));
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(await orchestrator.handle({ message: 'loop forever' }));

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error(`expected error, got ${result.status}`);
    expect(result.error.code).toBe('ORCHESTRATOR_STEP_LIMIT');
    expect(requests).toHaveLength(8);
  });

  it('a ModelUnavailableError surfaces as MODEL_UNAVAILABLE and makes zero client calls', async () => {
    const factory = fakeFactoryClient();
    const { model } = scriptedModelClient([
      new ModelUnavailableError(
        'quota',
        'opencode inference openai request failed (quota): HTTP 429 (check OPENCODE_API_KEY)',
      ),
    ]);
    const orchestrator = createOrchestrator({ client: factory.client, model, modelName: MODEL });

    const result = resultOf(await orchestrator.handle({ message: 'what is going on?' }));

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error(`expected error, got ${result.status}`);
    expect(result.error.code).toBe('MODEL_UNAVAILABLE');
    expect(result.error.message).toContain('OPENCODE_API_KEY');
    expect(factory.calls).toHaveLength(0);
  });
});
