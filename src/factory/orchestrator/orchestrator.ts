/**
 * The E12 (#48) natural-language orchestrator: a bounded, confirmation-gated
 * tool loop over the Factory API.
 *
 * Shape of a request:
 *  1. The operator's `message` becomes the first user turn.
 *  2. The model is asked, in a strict-JSON protocol, either to call one tool
 *     (`{"tool":"<name>","args":{...}}`) or to finish (`{"final":"<summary>"}`).
 *  3. A `read` tool runs immediately and its DTO is fed back as the next user
 *     turn, so the model can act on real Factory state.
 *  4. A `mutate`/`control` tool is **never executed by the loop**. The loop
 *     stops and returns `awaiting_confirmation` naming the tool and its args.
 *     The tool runs only when a later request carries `confirm`, at which point
 *     the orchestrator executes exactly that tool via `toolByName` and does not
 *     consult the model at all.
 *
 * Bounds and failure modes are explicit, never open-ended:
 *  - at most `maxSteps` (default 8) model calls per request → `ORCHESTRATOR_STEP_LIMIT`;
 *  - a reply that is not the strict-JSON protocol, or names an unknown tool, is
 *    corrected once and then rejected → `ORCHESTRATOR_BAD_MODEL_OUTPUT`;
 *  - a `ModelUnavailableError` → `MODEL_UNAVAILABLE` (its message is already key-free).
 *
 * The API key never appears here: it lives in the injected `ModelClient`.
 */

import type { FactoryClient } from '../api/client';
import { ModelUnavailableError } from '../inference/modelClient';
import type { ModelClient, ModelTurn } from '../inference/modelClient';
import { ORCHESTRATOR_TOOLS, toolByName } from './tools';
import type { OrchestratorTool } from './tools';

export interface OrchestratorRequest {
  message: string;
  confirm?: { tool: string; args: Record<string, unknown> };
}

export type OrchestratorResult =
  | { status: 'ok'; summary: string; toolCalls: Array<{ tool: string; args: unknown }> }
  | {
      status: 'awaiting_confirmation';
      pending: { tool: string; args: Record<string, unknown>; description: string };
      summary: string;
    }
  | { status: 'error'; error: { code: string; message: string } };

export interface OrchestratorOptions {
  client: FactoryClient;
  model: ModelClient;
  modelName: string;
  maxTokensPerMessage?: number;
  maxSteps?: number;
}

export interface Orchestrator {
  handle(request: OrchestratorRequest): Promise<OrchestratorResult>;
}

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOKENS_PER_MESSAGE = 2048;

/**
 * The strict-JSON protocol, restated to the model on every request. Every tool's
 * name, kind, description, and argument schema is advertised verbatim: the model
 * can only ever name a tool the registry declares.
 */
function buildSystemPrompt(modelName: string): string {
  const catalogue = ORCHESTRATOR_TOOLS.map(
    (tool) =>
      `- ${tool.name} (${tool.kind}): ${tool.description}\n  parameters: ${JSON.stringify(tool.parameters)}`,
  ).join('\n');
  return [
    `You are the Factory orchestrator, running on the model "${modelName}".`,
    'You can act on the Factory only through the tools below. You have no shell and no network.',
    '',
    'Reply with exactly one strict JSON object and nothing else — no prose, no code fences:',
    '  {"tool":"<name>","args":{...}}   to call one tool, or',
    '  {"final":"<summary>"}            to finish and report to the operator.',
    'After a tool call, its result arrives as the next user message; then reply again.',
    'Read tools may be called freely. Mutating and control tools are not executed until a human confirms them.',
    'Never invent a tool name. Any reply that is not one of the two shapes above is rejected.',
    '',
    'Tools:',
    catalogue,
  ].join('\n');
}

/** The one-line correction fed back once when a reply breaks the protocol. */
const CORRECTION =
  'Your last reply was rejected. Reply with a single strict JSON object and nothing else: ' +
  'either {"tool":"<name>","args":{...}} using a listed tool, or {"final":"<summary>"}.';

type ParsedReply =
  | { kind: 'tool'; tool: OrchestratorTool; args: Record<string, unknown> }
  | { kind: 'final'; summary: string }
  | { kind: 'invalid'; reason: string };

/**
 * Parse a model reply against the protocol. Pure and total: every non-conforming
 * reply becomes an `invalid` carrying a one-line reason for the correction turn.
 */
function parseReply(text: string): ParsedReply {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'the reply was not valid JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'the reply was not a JSON object' };
  }
  const record = value as Record<string, unknown>;
  if (typeof record['final'] === 'string') {
    return { kind: 'final', summary: record['final'] };
  }
  if (typeof record['tool'] === 'string') {
    const tool = toolByName(record['tool']);
    if (!tool) return { kind: 'invalid', reason: `unknown tool "${record['tool']}"` };
    const args = record['args'] ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { kind: 'invalid', reason: 'tool "args" must be a JSON object' };
    }
    return { kind: 'tool', tool, args: args as Record<string, unknown> };
  }
  return { kind: 'invalid', reason: 'the reply had neither a "tool" nor a "final" key' };
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** Serialize a tool DTO for the model; never throw on an exotic value. */
function serialize(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return '[unserializable result]';
  }
}

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxTokens = options.maxTokensPerMessage ?? DEFAULT_MAX_TOKENS_PER_MESSAGE;
  const system = buildSystemPrompt(options.modelName);

  function error(code: string, message: string): OrchestratorResult {
    return { status: 'error', error: { code, message } };
  }

  async function handle(request: OrchestratorRequest): Promise<OrchestratorResult> {
    // The confirmation path: a human has explicitly authorized exactly one tool.
    // Execute it and return — the model is never consulted here.
    if (request.confirm) {
      const tool = toolByName(request.confirm.tool);
      if (!tool) {
        return error('ORCHESTRATOR_UNKNOWN_TOOL', `unknown tool: ${request.confirm.tool}`);
      }
      try {
        await tool.run(request.confirm.args, options.client);
      } catch (thrown) {
        return error('ORCHESTRATOR_TOOL_FAILED', `${tool.name}: ${messageOf(thrown)}`);
      }
      return {
        status: 'ok',
        summary: `Executed ${tool.name}.`,
        toolCalls: [{ tool: tool.name, args: request.confirm.args }],
      };
    }

    const turns: ModelTurn[] = [{ role: 'user', content: request.message }];
    const toolCalls: Array<{ tool: string; args: unknown }> = [];
    let steps = 0;
    // Each offending reply earns exactly one correction turn; an accepted reply
    // resets the allowance. `maxSteps` still bounds the whole exchange.
    let correctable = true;

    // Bounded by maxSteps model calls; every exit is explicit.
    for (;;) {
      if (steps >= maxSteps) {
        return error(
          'ORCHESTRATOR_STEP_LIMIT',
          `exceeded the ${maxSteps}-step limit without a final answer`,
        );
      }
      steps += 1;

      let text: string;
      try {
        // maxTokens rides on every call: the per-message cap is a hard bound.
        const reply = await options.model.complete({ system, turns, maxTokens });
        text = reply.text;
      } catch (thrown) {
        if (thrown instanceof ModelUnavailableError) {
          return error('MODEL_UNAVAILABLE', thrown.message);
        }
        throw thrown;
      }

      const parsed = parseReply(text);

      if (parsed.kind === 'invalid') {
        if (!correctable) {
          return error(
            'ORCHESTRATOR_BAD_MODEL_OUTPUT',
            `model reply rejected after one correction: ${parsed.reason}`,
          );
        }
        correctable = false;
        turns.push({ role: 'assistant', content: text });
        turns.push({ role: 'user', content: `${CORRECTION} (${parsed.reason})` });
        continue;
      }

      // The reply was understood; the next offence gets a fresh correction turn.
      correctable = true;

      if (parsed.kind === 'final') {
        return { status: 'ok', summary: parsed.summary, toolCalls };
      }

      // A read tool runs immediately; its DTO becomes the next observation.
      if (parsed.tool.kind === 'read') {
        let observation: unknown;
        try {
          observation = await parsed.tool.run(parsed.args, options.client);
        } catch (thrown) {
          return error('ORCHESTRATOR_TOOL_FAILED', `${parsed.tool.name}: ${messageOf(thrown)}`);
        }
        toolCalls.push({ tool: parsed.tool.name, args: parsed.args });
        turns.push({ role: 'assistant', content: text });
        turns.push({
          role: 'user',
          content: `Tool ${parsed.tool.name} returned:\n${serialize(observation)}`,
        });
        continue;
      }

      // mutate/control: the loop never executes it. Hand it to the human.
      return {
        status: 'awaiting_confirmation',
        pending: {
          tool: parsed.tool.name,
          args: parsed.args,
          description: `Confirm ${parsed.tool.name}: ${parsed.tool.description}`,
        },
        summary: `Awaiting confirmation to call ${parsed.tool.name}.`,
      };
    }
  }

  return { handle };
}
