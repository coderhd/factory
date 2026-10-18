/**
 * The generic model client for the E12 (#48) natural-language orchestrator.
 *
 * It speaks the opencode inference API (`https://opencode.ai/inference`) in its
 * two wire families — OpenAI Chat Completions and Anthropic Messages — over a
 * single small seam (`ModelClient`). Following the repo's existing outbound-HTTP
 * pattern (the E6 GitHub REST transport, `src/factory/github/adapter.ts:205`,
 * and `FactoryClient`), the `fetch` implementation is injected so tests are
 * hermetic and nothing here reaches the network.
 *
 * Two rules are load-bearing:
 *  - `fetch` is injected, so hermetic tests exercise the exact wire shape.
 *  - The API key is never logged and never interpolated into an error. Errors
 *    name the *environment variable* (`apiKeyEnvName`) that would carry the key,
 *    which is what an operator needs to fix the problem — not the secret itself.
 *
 * Free opencode models are callable without a key, so a missing key is not a
 * hard error: the request is attempted and any upstream `401`/`403`/`429` is
 * surfaced loudly as a typed `ModelUnavailableError`.
 */

export type ModelRole = 'system' | 'user' | 'assistant';

export interface ModelTurn {
  role: ModelRole;
  content: string;
}

export interface ModelRequest {
  system?: string;
  turns: ModelTurn[];
  maxTokens?: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelReply {
  text: string;
  usage?: ModelUsage;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelReply>;
}

export type ModelApiFamily = 'openai' | 'anthropic';

export type ModelFailureReason = 'auth' | 'quota' | 'transport' | 'upstream';

/** A failed inference call. Carries a typed reason and an operator-facing message. */
export class ModelUnavailableError extends Error {
  constructor(
    readonly reason: ModelFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

export interface HttpModelClientOptions {
  baseUrl: string;
  apiFamily: ModelApiFamily;
  model: string;
  /** Already read from the environment by the caller. Never logged. */
  apiKey?: string;
  /** For error text only — the key's environment variable *name*, never its value. */
  apiKeyEnvName: string;
  /** Injectable transport for hermetic tests; defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Optional per-request timeout; an exceeded timeout is a `transport` failure. */
  timeoutMs?: number;
}

/** `max_tokens` is required by the Anthropic Messages API; 2048 when unset. */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 2048;

const OPENAI_PATH = '/openai/v1/chat/completions';
const ANTHROPIC_PATH = '/anthropic/v1/messages';

interface OpenAiChatDto {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

interface AnthropicMessagesDto {
  content?: Array<{ text?: unknown }>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/** Map an HTTP status to a failure reason; every other non-2xx is `upstream`. */
function reasonForStatus(status: number): ModelFailureReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  return 'upstream';
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Never let a secret leak through an error string. Any occurrence of the key is
 * replaced; the message otherwise stays useful for diagnosis.
 */
function redact(text: string, secret?: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

/**
 * The concrete opencode inference client. `baseUrl` is joined with the family
 * path (a trailing `/` is stripped first); the `Authorization` header rides
 * along only when `apiKey` is a non-empty string.
 */
export function createHttpModelClient(options: HttpModelClientOptions): ModelClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const path = options.apiFamily === 'anthropic' ? ANTHROPIC_PATH : OPENAI_PATH;

  function failure(reason: ModelFailureReason, detail: string): ModelUnavailableError {
    const prefix = `opencode inference ${options.apiFamily} request failed (${reason})`;
    return new ModelUnavailableError(
      reason,
      redact(detail.length > 0 ? `${prefix}: ${detail}` : prefix, options.apiKey),
    );
  }

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Only a non-empty key is sent; free models need none. The key is never logged.
    if (typeof options.apiKey === 'string' && options.apiKey.length > 0) {
      headers.authorization = `Bearer ${options.apiKey}`;
    }
    return headers;
  }

  function buildBody(request: ModelRequest): unknown {
    if (options.apiFamily === 'anthropic') {
      // Anthropic hoists the system prompt out of `messages` and requires `max_tokens`.
      const systems = [
        ...(request.system ? [request.system] : []),
        ...request.turns.filter((turn) => turn.role === 'system').map((turn) => turn.content),
      ];
      const turns = request.turns.filter((turn) => turn.role !== 'system');
      return {
        model: options.model,
        max_tokens: request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
        ...(systems.length > 0 ? { system: systems.join('\n\n') } : {}),
        messages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
      };
    }
    // OpenAI carries the system prompt as the leading message.
    const messages = [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...request.turns.map((turn) => ({ role: turn.role, content: turn.content })),
    ];
    return {
      model: options.model,
      messages,
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    };
  }

  function parseBody(payload: unknown): ModelReply {
    if (options.apiFamily === 'anthropic') {
      const dto = (payload ?? {}) as AnthropicMessagesDto;
      const text = typeof dto.content?.[0]?.text === 'string' ? (dto.content[0]!.text as string) : '';
      const usage = dto.usage
        ? { inputTokens: toNumber(dto.usage.input_tokens), outputTokens: toNumber(dto.usage.output_tokens) }
        : undefined;
      return usage ? { text, usage } : { text };
    }
    const dto = (payload ?? {}) as OpenAiChatDto;
    const content = dto.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : '';
    const usage = dto.usage
      ? { inputTokens: toNumber(dto.usage.prompt_tokens), outputTokens: toNumber(dto.usage.completion_tokens) }
      : undefined;
    return usage ? { text, usage } : { text };
  }

  async function callFetch(url: string, init: RequestInit): Promise<Response> {
    const timeoutMs = options.timeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) return await fetchImpl(url, init);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(failure('transport', `timed out after ${timeoutMs}ms (check ${options.apiKeyEnvName})`));
        }, timeoutMs);
      });
      return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    async complete(request: ModelRequest): Promise<ModelReply> {
      const url = `${baseUrl}${path}`;
      let response: Response;
      try {
        response = await callFetch(url, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(buildBody(request)),
        });
      } catch (error) {
        if (error instanceof ModelUnavailableError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw failure(
          'transport',
          `${detail} (check ${options.apiKeyEnvName})`,
        );
      }

      const text = await response.text().catch(() => '');
      let payload: unknown = null;
      if (text.length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }

      if (!response.ok) {
        const detail =
          typeof (payload as { error?: { message?: unknown } } | null)?.error?.message === 'string'
            ? ((payload as { error: { message: string } }).error.message)
            : '';
        throw failure(
          reasonForStatus(response.status),
          `HTTP ${response.status}${detail.length > 0 ? ` ${detail}` : ''} (check ${options.apiKeyEnvName})`,
        );
      }

      return parseBody(payload);
    },
  };
}
