import { FactoryError } from '../domain/errors';
import {
  TASK_CREATED,
  type Task,
  type TaskDependency,
  type WorkOrder,
  type WorkOrderDeps,
} from '../domain/workOrder';
import type { DomainEvent } from '../events/log';

/**
 * E3.2 planning: DAG proposal → validation → append-only commit.
 *
 * Authority split (spec §7.1, invariant "Planner proposes; Factory commits"):
 * the Planner composes a proposal and never writes durable state; the Factory
 * records, validates and commits versions. Committed versions live ONLY as
 * `dag.committed` event payloads (append-only at the DB level), so a version is
 * never mutated or overwritten.
 */

export const DAG_PROPOSED = 'dag.proposed';
export const DAG_REJECTED = 'dag.rejected';
export const DAG_COMMITTED = 'dag.committed';

/** `PlanningDeps` is E1's `WorkOrderDeps` (Ruling R9 deps-first shape). */
export type PlanningDeps = WorkOrderDeps;

/** One proposed DAG node. `nodeId` is planner-local and unique in the payload. */
export interface ProposalNode {
  nodeId: string;
  title: string;
  dependsOn?: string[];
  notes?: string;
}

/** The exact planner → Factory payload. The call binds the Work Order id. */
export interface DAGProposalPayload {
  nodes: ProposalNode[];
  rationale?: string;
}

/** What `proposeDAG` records (an advisory audit entry only). */
export interface RecordedProposal {
  id: string;
  workOrderId: string;
  proposedVersion: number;
  payload: DAGProposalPayload;
  proposedAt: string;
}

/** A committed node: the planner-local id kept for traceability + the task id. */
export interface CommittedNode {
  nodeId: string;
  taskId: string;
  title: string;
  dependsOnTaskIds: string[];
}

/** An immutable committed version document (`DAGv1`, `DAGv2`, …). */
export interface DAGVersion {
  id: string;
  workOrderId: string;
  version: number;
  nodes: CommittedNode[];
  createdAt: string;
}

export type DagRuleCode =
  | 'DAG_WO_STATE'
  | 'DAG_IN_FLIGHT'
  | 'DAG_EMPTY'
  | 'DAG_MALFORMED'
  | 'DAG_DUPLICATE_NODE'
  | 'DAG_UNKNOWN_DEP'
  | 'DAG_SELF_DEP'
  | 'DAG_CYCLE';

export interface DagRejection {
  rule: DagRuleCode;
  message: string;
}

export type DagValidation = { ok: true } | { ok: false; reasons: DagRejection[] };

const REPLAN_STATES = ['EXECUTING', 'WAITING_INPUT', 'REWORK'];
const IN_FLIGHT_STATES = ['ASSIGNED', 'RUNNING', 'WAITING_INPUT'];

const rejected = (reasons: DagRejection[]): DagValidation => ({ ok: false, reasons });

/** All committed versions of a Work Order, ascending, folded from the event log. */
export function projectDAGVersions(
  events: readonly DomainEvent[],
  workOrderId: string,
): DAGVersion[] {
  const versions: DAGVersion[] = [];
  for (const event of events) {
    if (event.type !== DAG_COMMITTED) continue;
    const dag = (event.payload as { dag?: DAGVersion }).dag;
    if (dag && dag.workOrderId === workOrderId) versions.push(dag);
  }
  return versions.sort((a, b) => a.version - b.version);
}

/** All committed versions for a Work Order, ascending. */
export function listDAGVersions(deps: PlanningDeps, workOrderId: string): DAGVersion[] {
  const events = deps.events.readEvents({ aggregateType: 'work_order', aggregateId: workOrderId });
  return projectDAGVersions(events, workOrderId);
}

/** The active (highest) committed version, or `null` if none was committed. */
export function getActiveDAG(deps: PlanningDeps, workOrderId: string): DAGVersion | null {
  const versions = listDAGVersions(deps, workOrderId);
  return versions.length > 0 ? versions[versions.length - 1] : null;
}

function nextVersion(deps: PlanningDeps, workOrderId: string): number {
  const versions = listDAGVersions(deps, workOrderId);
  return versions.length > 0 ? versions[versions.length - 1].version + 1 : 1;
}

/**
 * E3.2 validation. Pure (no writes): returns ALL applicable reasons, in the
 * order R1 → R2 → R3 → R4–R8, so the planner gets complete feedback.
 */
export function validateDAG(
  deps: PlanningDeps,
  workOrderId: string,
  payload: DAGProposalPayload,
): DagValidation {
  const reasons: DagRejection[] = [];

  // R1 — DAG_WO_STATE.
  const workOrder = deps.store.get<WorkOrder>('work_orders', workOrderId);
  if (!workOrder) {
    return rejected([
      { rule: 'DAG_WO_STATE', message: `work order ${workOrderId} not found` },
    ]);
  }
  const version = nextVersion(deps, workOrderId);
  if (version === 1) {
    if (workOrder.state !== 'PLANNING') {
      reasons.push({
        rule: 'DAG_WO_STATE',
        message: `work order ${workOrderId} is ${workOrder.state}; first DAG commit requires PLANNING`,
      });
    }
  } else if (!REPLAN_STATES.includes(workOrder.state)) {
    reasons.push({
      rule: 'DAG_WO_STATE',
      message: `work order ${workOrderId} is ${workOrder.state}; REPLAN requires EXECUTING, WAITING_INPUT, or REWORK`,
    });
  }

  // R2 — DAG_IN_FLIGHT (REPLAN only): live executions must settle first.
  if (version > 1) {
    const active = getActiveDAG(deps, workOrderId);
    if (active) {
      for (const node of active.nodes) {
        const task = deps.store.get<Task>('tasks', node.taskId);
        if (task && IN_FLIGHT_STATES.includes(task.state)) {
          reasons.push({
            rule: 'DAG_IN_FLIGHT',
            message: `task ${node.taskId} (DAG v${active.version}) is ${task.state}; REPLAN requires no active task in ASSIGNED, RUNNING, or WAITING_INPUT`,
          });
        }
      }
    }
  }

  // R3 — DAG_EMPTY. Stops node-level rules when empty.
  if (!payload || !Array.isArray(payload.nodes) || payload.nodes.length === 0) {
    reasons.push({
      rule: 'DAG_EMPTY',
      message: 'proposal contains no nodes; a DAG must define at least one task',
    });
    return rejected(reasons);
  }

  if (typeof payload.rationale !== 'undefined' && typeof payload.rationale !== 'string') {
    reasons.push({ rule: 'DAG_MALFORMED', message: 'rationale must be a string when present' });
  }

  // R4 — DAG_MALFORMED.
  const wellFormed: ProposalNode[] = [];
  payload.nodes.forEach((raw, index) => {
    const node = raw as Partial<ProposalNode> | null;
    if (!node || typeof node !== 'object') {
      reasons.push({ rule: 'DAG_MALFORMED', message: `node #${index}: must be an object` });
      return;
    }
    let ok = true;
    if (typeof node.nodeId !== 'string' || node.nodeId.length === 0) {
      reasons.push({
        rule: 'DAG_MALFORMED',
        message: `node #${index}: nodeId is required and must be a non-empty string`,
      });
      ok = false;
    }
    const label = typeof node.nodeId === 'string' && node.nodeId.length > 0 ? node.nodeId : `#${index}`;
    if (typeof node.title !== 'string' || node.title.length === 0) {
      reasons.push({
        rule: 'DAG_MALFORMED',
        message: `node ${label}: title is required and must be a non-empty string`,
      });
      ok = false;
    }
    if (node.dependsOn !== undefined && !Array.isArray(node.dependsOn)) {
      reasons.push({
        rule: 'DAG_MALFORMED',
        message: `node ${label}: dependsOn must be an array of strings`,
      });
      ok = false;
    } else if (Array.isArray(node.dependsOn) && node.dependsOn.some((d) => typeof d !== 'string')) {
      reasons.push({
        rule: 'DAG_MALFORMED',
        message: `node ${label}: dependsOn must be an array of strings`,
      });
      ok = false;
    }
    if (node.notes !== undefined && typeof node.notes !== 'string') {
      reasons.push({ rule: 'DAG_MALFORMED', message: `node ${label}: notes must be a string when present` });
      ok = false;
    }
    if (ok) wellFormed.push(node as ProposalNode);
  });

  // R5 — DAG_DUPLICATE_NODE.
  const seen = new Set<string>();
  const unique: ProposalNode[] = [];
  for (const node of wellFormed) {
    if (seen.has(node.nodeId)) {
      reasons.push({
        rule: 'DAG_DUPLICATE_NODE',
        message: `nodeId ${node.nodeId} is defined more than once; nodeIds must be unique within a proposal`,
      });
      continue;
    }
    seen.add(node.nodeId);
    unique.push(node);
  }

  // R6 — DAG_UNKNOWN_DEP; R7 — DAG_SELF_DEP.
  for (const node of unique) {
    for (const dep of node.dependsOn ?? []) {
      if (dep === node.nodeId) {
        reasons.push({ rule: 'DAG_SELF_DEP', message: `${node.nodeId} depends on itself` });
      } else if (!seen.has(dep)) {
        reasons.push({
          rule: 'DAG_UNKNOWN_DEP',
          message: `${node.nodeId} depends on ${dep}, which is not a nodeId in this proposal`,
        });
      }
    }
  }

  // R8 — DAG_CYCLE (self-edges reported as R7, unknown deps as R6).
  const graph = new Map<string, string[]>();
  for (const node of unique) {
    graph.set(
      node.nodeId,
      (node.dependsOn ?? []).filter((dep) => dep !== node.nodeId && seen.has(dep)),
    );
  }
  const cycle = detectCycle(graph);
  if (cycle) {
    reasons.push({
      rule: 'DAG_CYCLE',
      message: `dependency cycle detected: ${cycle.join(' → ')}`,
    });
  }

  return reasons.length > 0 ? rejected(reasons) : { ok: true };
}

/** DFS three-colour cycle detection; returns one cycle path or `null`. */
function detectCycle(graph: Map<string, string[]>): string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const id of graph.keys()) colour.set(id, WHITE);

  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    colour.set(id, GREY);
    stack.push(id);
    for (const next of graph.get(id) ?? []) {
      if (colour.get(next) === GREY) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (colour.get(next) === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    colour.set(id, BLACK);
    return null;
  };

  for (const id of graph.keys()) {
    if (colour.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** Record a proposal (audit only). Performs no graph validation and no commit. */
export function proposeDAG(
  deps: PlanningDeps,
  workOrderId: string,
  payload: DAGProposalPayload,
): RecordedProposal {
  const workOrder = deps.store.get<WorkOrder>('work_orders', workOrderId);
  if (!workOrder) {
    throw new FactoryError('WORK_ORDER_NOT_FOUND', `work order not found: ${workOrderId}`);
  }
  const proposedVersion = nextVersion(deps, workOrderId);
  const legal =
    proposedVersion === 1
      ? workOrder.state === 'PLANNING'
      : REPLAN_STATES.includes(workOrder.state);
  if (!legal) {
    throw new FactoryError(
      'DAG_INVALID',
      `work order ${workOrderId} is ${workOrder.state}; cannot propose DAG v${proposedVersion}`,
    );
  }

  const proposal: RecordedProposal = {
    id: `prop_${crypto.randomUUID()}`,
    workOrderId,
    proposedVersion,
    payload,
    proposedAt: new Date().toISOString(),
  };
  deps.events.appendEvent({
    type: DAG_PROPOSED,
    aggregateType: 'work_order',
    aggregateId: workOrderId,
    payload: { proposal },
  });
  return proposal;
}

/**
 * Validate then commit. An invalid payload appends one `dag.rejected` event and
 * throws `FactoryError('DAG_INVALID')`; nothing else changes. A valid payload
 * materializes all Task rows, dependency rows and the version document in one
 * transaction, so the three representations (V-agree) cannot disagree.
 */
export function commitDAG(
  deps: PlanningDeps,
  workOrderId: string,
  payload: DAGProposalPayload,
): DAGVersion {
  const validation = validateDAG(deps, workOrderId, payload);
  if (!validation.ok) {
    deps.events.appendEvent({
      type: DAG_REJECTED,
      aggregateType: 'work_order',
      aggregateId: workOrderId,
      payload: { payload, reasons: validation.reasons },
    });
    throw new FactoryError(
      'DAG_INVALID',
      validation.reasons.map((reason) => `${reason.rule}: ${reason.message}`).join('; '),
    );
  }

  const version = nextVersion(deps, workOrderId);
  const now = new Date().toISOString();

  return deps.store.db.transaction((): DAGVersion => {
    const taskIdByNode = new Map<string, string>();
    for (const node of payload.nodes) {
      taskIdByNode.set(node.nodeId, `task_${crypto.randomUUID()}`);
    }

    const nodes: CommittedNode[] = payload.nodes.map((node) => ({
      nodeId: node.nodeId,
      taskId: taskIdByNode.get(node.nodeId)!,
      title: node.title,
      dependsOnTaskIds: (node.dependsOn ?? []).map((dep) => taskIdByNode.get(dep)!),
    }));

    // 1. Task rows + task.created events (E1's exact shapes for replay).
    for (const node of nodes) {
      const task: Task = {
        id: node.taskId,
        workOrderId,
        title: node.title,
        state: 'PLANNED',
        dependsOn: node.dependsOnTaskIds,
        createdAt: now,
        updatedAt: now,
      };
      deps.store.set('tasks', task.id, task);
      deps.events.appendEvent({
        type: TASK_CREATED,
        aggregateType: 'task',
        aggregateId: task.id,
        payload: { task },
      });
    }

    // 2. Edge rows, after all Task rows so the schema FKs enforce endpoints.
    for (const node of nodes) {
      for (const dependsOnTaskId of node.dependsOnTaskIds) {
        const edge: TaskDependency = {
          id: `dep_${crypto.randomUUID()}`,
          taskId: node.taskId,
          dependsOnTaskId,
          createdAt: now,
          updatedAt: now,
        };
        deps.store.set('task_dependencies', edge.id, edge);
      }
    }

    // 3. The immutable version document.
    const dag: DAGVersion = {
      id: `dag_${crypto.randomUUID()}`,
      workOrderId,
      version,
      nodes,
      createdAt: now,
    };
    deps.events.appendEvent({
      type: DAG_COMMITTED,
      aggregateType: 'work_order',
      aggregateId: workOrderId,
      payload: { dag },
    });

    return dag;
  })();
}
