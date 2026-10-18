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
import type { ModelFailureReason } from '../../src/factory/inference/modelClient';

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
