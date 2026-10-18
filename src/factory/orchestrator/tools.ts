/**
 * The E12 (#48) orchestrator tool registry.
 *
 * This is the natural-language orchestrator's *entire* action surface. Every
 * tool is a thin, declared wrapper over exactly one `FactoryClient` method — no
 * shell, no arbitrary network, no direct `StateStore` access. That property is
 * what makes the orchestrator safe to hand a model: whatever the model proposes,
 * the only thing it can reach is the Factory's own API, where the server stays
 * the sole mutation authority and every §5.2/§7 gate still applies.
 *
 * Each tool carries a `kind`:
 *  - `read`    — safe to execute immediately (`list_work_orders`, `observatory`, …).
 *  - `mutate`  — changes Factory state; the loop *never* executes one on its own.
 *  - `control` — pauses/stops/resumes the Factory; likewise never auto-executed.
 *
 * `mutate`/`control` tools only ever run after an explicit, out-of-band human
 * confirmation carried on the next `OrchestratorRequest` (see `orchestrator.ts`).
 *
 * Tool → FactoryClient method map (one method per tool):
 *
 *   read    list_work_orders        → listWorkOrders()
 *           work_order_status       → getWorkOrder(id)
 *           scheduler_status        → schedulerStatus()
 *           observatory             → observatory()
 *           list_approvals          → listApprovals(status?)
 *           list_interactions       → listInteractions(status?)
 *   mutate  submit_work_order       → submitWorkOrder(intent)
 *           github_import           → githubImportIssue(request)
 *           transition_work_order   → transitionWorkOrder(id, transition)
 *           plan_dag                → commitDag(id, payload)
 *           answer_interaction      → answerInteraction(id, response, actor?)
 *           answer_approval         → answerApproval(id, answer)
 *           gate_decision           → applyGate(id, decision)
 *           github_open_pr          → githubOpenPullRequest(request)
 *   control pause                   → pause(actor)
 *           resume                  → resume(actor)
 *           emergency_stop          → emergencyStop(actor)
 */

import type { FactoryClient } from '../api/client';
import type { ApprovalAnswerRequest, GateDecision } from '../api/contract';
import type { InteractionDto } from '../api/contract';
import type { RiskTier, WorkOrderIntent, WorkOrderState, WorkOrderTransition } from '../domain/workOrder';
import type { DAGProposalPayload } from '../planning/dag';
import type { ApprovalRecord } from '../policy/policy';

export type ToolKind = 'read' | 'mutate' | 'control';

export interface OrchestratorTool {
  name: string;
  description: string;
  /** JSON schema for the tool's `args`, shown to the model verbatim. */
  parameters: Record<string, unknown>;
  kind: ToolKind;
  run(args: Record<string, unknown>, client: FactoryClient): Promise<unknown>;
}

// --- argument coercion -----------------------------------------------------
// `args` reaches a tool as untyped JSON straight from the model, so each read is
// validated here and a malformed argument is a loud, nameable error rather than
// a silently-`undefined` call into the Factory API.

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing required string argument "${key}"`);
  }
  return value;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`missing required number argument "${key}"`);
  }
  return value;
}

function optStrArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`argument "${key}" must be an array of strings`);
  }
  return value as string[];
}

function obj(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`missing required object argument "${key}"`);
  }
  return value as Record<string, unknown>;
}

/** Drop `undefined` fields so optional DTO members stay absent on the wire. */
function defined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

// --- schema fragments ------------------------------------------------------

const NO_ARGS: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const WORK_ORDER_STATES: readonly string[] = [
  'DRAFT',
  'READY',
  'PLANNING',
  'EXECUTING',
  'WAITING_INPUT',
  'VERIFYING',
  'FAILED',
  'REWORK',
  'EVIDENCE_READY',
  'HUMAN_GATE',
  'REJECTED',
  'APPROVED',
  'MERGED',
];

// --- the registry ----------------------------------------------------------

export const ORCHESTRATOR_TOOLS: readonly OrchestratorTool[] = [
  // ---- read tools: safe to execute immediately -----------------------------
  {
    name: 'list_work_orders',
    description: 'List every Work Order with its current state.',
    parameters: NO_ARGS,
    kind: 'read',
    run: (_args, client) => client.listWorkOrders(),
  },
  {
    name: 'work_order_status',
    description: 'Read one Work Order snapshot: its tasks, attempts, interactions, and DAG.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The Work Order id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    kind: 'read',
    run: (args, client) => client.getWorkOrder(str(args, 'id')),
  },
  {
    name: 'scheduler_status',
    description: 'Read the scheduler status: concurrency, queue, and what it is waiting on.',
    parameters: NO_ARGS,
    kind: 'read',
    run: (_args, client) => client.schedulerStatus(),
  },
  {
    name: 'observatory',
    description:
      'Read the Observatory metrics: verified changes per day, throughput per human hour, rework, and cost.',
    parameters: NO_ARGS,
    kind: 'read',
    run: (_args, client) => client.observatory(),
  },
  {
    name: 'list_approvals',
    description: 'List policy approval records, optionally filtered by status.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['PENDING', 'ANSWERED', 'SPENT'] },
      },
      additionalProperties: false,
    },
    kind: 'read',
    run: (args, client) =>
      client.listApprovals(optStr(args, 'status') as ApprovalRecord['status'] | undefined),
  },
  {
    name: 'list_interactions',
    description: 'List human interactions (worker questions), optionally filtered by status.',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['PENDING', 'ANSWERED'] } },
      additionalProperties: false,
    },
    kind: 'read',
    run: (args, client) =>
      client.listInteractions(optStr(args, 'status') as InteractionDto['status'] | undefined),
  },

  // ---- mutate tools: never executed without explicit human confirmation ----
  {
    name: 'submit_work_order',
    description: 'Create a Work Order from an intent. Requires explicit human confirmation.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'What the Factory should accomplish.' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        riskTier: { type: 'string', enum: ['GREEN', 'YELLOW', 'RED'] },
        constraints: { type: 'array', items: { type: 'string' } },
        outOfScope: { type: 'array', items: { type: 'string' } },
        repository: { type: 'string', description: 'owner/name.' },
        requiredVerification: { type: 'array', items: { type: 'string' } },
      },
      required: ['intent'],
      additionalProperties: false,
    },
    kind: 'mutate',
    run: (args, client) =>
      client.submitWorkOrder(
        defined({
          intent: str(args, 'intent'),
          acceptanceCriteria: optStrArray(args, 'acceptanceCriteria'),
          riskTier: optStr(args, 'riskTier') as RiskTier | undefined,
          constraints: optStrArray(args, 'constraints'),
          outOfScope: optStrArray(args, 'outOfScope'),
          repository: optStr(args, 'repository'),
          requiredVerification: optStrArray(args, 'requiredVerification'),
        }),
      ),
  },
  {
    name: 'github_import',
    description: 'Reconcile a GitHub issue into a Work Order. Requires explicit human confirmation.',
    parameters: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'owner/name.' },
        number: { type: 'number', description: 'The GitHub issue number.' },
      },
      required: ['repository', 'number'],
      additionalProperties: false,
    },
    kind: 'mutate',
    run: (args, client) =>
      client.githubImportIssue({ repository: str(args, 'repository'), number: num(args, 'number') }),
  },
  {
    name: 'transition_work_order',
    description: "Move a Work Order to a new state. Requires explicit human confirmation.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The Work Order id.' },
        to: { type: 'string', enum: WORK_ORDER_STATES },
        reason: { type: 'string' },
      },
      required: ['id', 'to'],
      additionalProperties: false,
    },
    kind: 'mutate',
    run: (args, client) =>
      client.transitionWorkOrder(
        str(args, 'id'),
        defined({
          to: str(args, 'to') as WorkOrderState,
          reason: optStr(args, 'reason'),
        }) as WorkOrderTransition,
      ),
  },
  {
    name: 'plan_dag',
    description:
      'Commit a task DAG proposal for a Work Order. Requires explicit human confirmation.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The Work Order id.' },
        payload: {
          type: 'object',
          description: 'DAGProposalPayload: { nodes: [{ nodeId, title, dependsOn?, notes? }], rationale? }',
          properties: {
            nodes: { type: 'array', items: { type: 'object' } },
            rationale: { type: 'string' },
          },
          required: ['nodes'],
        },
      },
      required: ['id', 'payload'],
      additionalProperties: false,
    },
    kind: 'mutate',
    run: (args, client) =>
      client.commitDag(str(args, 'id'), obj(args, 'payload') as unknown as DAGProposalPayload),
  },
  {
    name: 'answer_interaction',
    description: "Answer a worker's pending question. Requires explicit human confirmation.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The interaction id.' },
        response: { type: 'string' },
        actor: { type: 'string', description: 'The operator identity recorded as the answerer.' },
      },
      required: ['id', 'response'],
      additionalProperties: false,
    },
    kind: 'mutate',
    run: (args, client) =>
      client.answerInteraction(str(args, 'id'), str(args, 'response'), optStr(args, 'actor')),
  },
  {
    name: 'answer_approval',
    description: 'Answer a policy approval park. Requires explicit human confirmation.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The approval id.' },
        decision: { type: 'string', enum: ['APPROVAL', 'DENY'] },
        actor: { type: 'string' },
        comment: { type: 'string' },
      },
      required: ['id', 'decision', 'actor'],
      additionalProperties: false,
    },
    kind: 'mutate',
    run: (args, client) =>
      client.answerApproval(
        str(args, 'id'),
        defined({
          decision: str(args, 'decision') as ApprovalAnswerRequest['decision'],
          actor: str(args, 'actor'),
          comment: optStr(args, 'comment'),
        }),
      ),
  },
  {
    name: 'gate_decision',
    description: 'Apply a human-gate decision to a Work Order. Requires explicit human confirmation.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The Work Order id.' },
        decision: { type: 'string', enum: ['APPROVE', 'REWORK', 'REJECT'] },
      },
      required: ['id', 'decision'],
      additionalProperties: false,
    },
    kind: 'mutate',
    run: (args, client) => client.applyGate(str(args, 'id'), str(args, 'decision') as GateDecision),
  },
  {
    name: 'github_open_pr',
    description:
      'Open a PR linking a durable Evidence Bundle receipt. Requires explicit human confirmation.',
    parameters: {
      type: 'object',
      properties: {
        evidenceBundleId: { type: 'string', description: 'The durable Evidence Bundle id.' },
        baseBranch: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['evidenceBundleId'],
      additionalProperties: false,
    },
    kind: 'mutate',
    run: (args, client) =>
      client.githubOpenPullRequest(
        defined({
          evidenceBundleId: str(args, 'evidenceBundleId'),
          baseBranch: optStr(args, 'baseBranch'),
          title: optStr(args, 'title'),
        }),
      ),
  },

  // ---- control tools: never executed without explicit human confirmation ----
  {
    name: 'pause',
    description: 'Pause new autonomous work (state and evidence preserved). Requires confirmation.',
    parameters: {
      type: 'object',
      properties: { actor: { type: 'string', description: 'The operator identity.' } },
      required: ['actor'],
      additionalProperties: false,
    },
    kind: 'control',
    run: (args, client) => client.pause(str(args, 'actor')),
  },
  {
    name: 'resume',
    description: 'Resume autonomous work after a pause or stop. Requires confirmation.',
    parameters: {
      type: 'object',
      properties: { actor: { type: 'string', description: 'The operator identity.' } },
      required: ['actor'],
      additionalProperties: false,
    },
    kind: 'control',
    run: (args, client) => client.resume(str(args, 'actor')),
  },
  {
    name: 'emergency_stop',
    description:
      'Emergency-stop the Factory: blocks assignments, provisioning, and external side effects. Requires confirmation.',
    parameters: {
      type: 'object',
      properties: { actor: { type: 'string', description: 'The operator identity.' } },
      required: ['actor'],
      additionalProperties: false,
    },
    kind: 'control',
    run: (args, client) => client.emergencyStop(str(args, 'actor')),
  },
];

const BY_NAME: ReadonlyMap<string, OrchestratorTool> = new Map(
  ORCHESTRATOR_TOOLS.map((tool) => [tool.name, tool]),
);

/** Resolve a tool by its advertised name; `undefined` for anything unknown. */
export function toolByName(name: string): OrchestratorTool | undefined {
  return BY_NAME.get(name);
}
