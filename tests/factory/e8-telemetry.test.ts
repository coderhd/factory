import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FactoryError } from '../../src/factory/domain/errors';
import {
  completeAttempt,
  createAttempt,
  createTask,
  createWorkOrder,
  transitionTask,
  transitionWorkOrder,
  type Attempt,
  type Task,
  type WorkOrder,
  type WorkOrderDeps,
} from '../../src/factory/domain/workOrder';
import type { EvidenceBundle } from '../../src/factory/evidence/bundle';
import { openEventLog, type EventLog } from '../../src/factory/events/log';
import type { EvidenceReadPort, VerifiedChange } from '../../src/factory/observatory/observatory';
import type { PolicyDecisionRecord } from '../../src/factory/policy/policy';
import type { RouteInput, RoutingDecisionRecord } from '../../src/factory/routing/decisionModel';
import { persistRoutingDecision } from '../../src/factory/routing/persist';
import { selectModel, toRoutingDecisionRecord } from '../../src/factory/routing/rules';
import { openStateStore, type StateStore } from '../../src/factory/state/store';
import type { VerificationRun } from '../../src/factory/verification/engine';
import {
  TELEMETRY_ATTEMPT_RECORDED,
  TELEMETRY_LAYERS,
  projectAttemptTelemetry,
  projectDrillDown,
  projectTelemetryMetrics,
  readAttemptTelemetry,
  recordAttemptTelemetry,
  type AttemptObservables,
  type TelemetryDeps,
} from '../../src/factory/telemetry/telemetry';
import {
  BENCHMARK_CORPUS,
  DOGFOODING_CORPUS,
  IMPROVEMENT_LEVELS,
  IMPROVEMENT_STAGES,
  benchmarkImprovement,
  observeImprovements,
  promoteImprovement,
  proposeImprovement,
  qualifyImprovement,
  readImprovement,
  type BenchmarkInput,
} from '../../src/factory/improve/loop';

/**
 * E8.1 (#24) telemetry layers + self-improvement v0. Everything here is
 * hermetic: temp SQLite state, fake evidence port, no network, no model calls.
 *
 * The tests TDD the two E8 artifacts against the merged E1/E4/E5 modules:
 *  - six telemetry layers recorded per Attempt, with the decision layer
 *    capturing the *why* (model/skill/context/risk/allow-deny/replan/gate);
 *  - the full §23 drill-down chain WO → Task → Attempt → trace → verification
 *    → evidence → decision, navigable with honest stubs where data is missing;
 *  - Improvement-as-Work Observe → Propose → Benchmark → Qualify → Promote as
 *    Work Orders, Levels 1–2 only, with no auto-mutation of production.
 */

let workDir: string;
let store: StateStore;
let events: EventLog;
let deps: TelemetryDeps;

class FakeEvidence implements EvidenceReadPort {
  changes: VerifiedChange[] = [];
  listVerifiedChanges(): VerifiedChange[] {
    return this.changes;
  }
}

let evidence: FakeEvidence;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'factory-e8-'));
  store = openStateStore(join(workDir, 'factory.db'));
  events = openEventLog(store.db);
  evidence = new FakeEvidence();
  deps = { store, events, evidence };
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seedWorkOrder(intent = 'telemetry fixture'): WorkOrder {
  return createWorkOrder({ store, events }, { intent, acceptanceCriteria: ['AC-1'] });
}

function seedAttempt(task: Task, overrides: Partial<Attempt> = {}): Attempt {
  const attempt = createAttempt(
    { store, events },
    { taskId: task.id, model: 'generalist', workerId: null, context: 'repo-summary', skills: ['typescript'] },
  );
  const completed = completeAttempt(
    { store, events },
    attempt.id,
    {
      outcome: 'success',
      verificationRunIds: overrides.verificationRunIds ?? [],
      failureHistory: overrides.failureHistory ?? [],
    },
  );
  // Drive the Task to SUCCESS so outcome telemetry reflects a finished Attempt.
  if (store.get<Task>('tasks', task.id)?.state === 'PLANNED') {
    const path: Array<Parameters<typeof transitionTask>[2]['to']> = [
      'READY',
      'ASSIGNED',
      'RUNNING',
      'SUCCESS',
    ];
    for (const to of path) transitionTask({ store, events }, task.id, { to });
  }
  return completed;
}

const routeInput: RouteInput = {
  task: 'implementation',
  complexity: 'complex',
  risk: 'medium',
  context: 'large',
};

function seedRoutingDecision(wo: WorkOrder, task: Task): RoutingDecisionRecord {
  const record = toRoutingDecisionRecord(selectModel(routeInput), {
    id: 'rd_1',
    workOrderId: wo.id,
    taskId: task.id,
    createdAt: '2026-09-30T08:00:00.000Z',
  });
  persistRoutingDecision({ store, events }, record);
  return record;
}

function verificationRun(attempt: Attempt, passed = true): VerificationRun {
  return {
    changeSetId: `cs_${attempt.id}`,
    deterministic: { category: 'deterministic', checks: [], passed },
    behavioral: { category: 'behavioral', checks: [], passed },
    criteria: [],
    failures: [],
    passed,
  };
}

function evidenceBundle(wo: WorkOrder, attempt: Attempt, complete = true): EvidenceBundle {
  return {
    id: `eb_${attempt.id}`,
    workOrderId: wo.id,
    changeSetId: `cs_${attempt.id}`,
    createdAt: '2026-09-30T09:00:00.000Z',
    criteria: [],
    gates: { deterministic: true, behavioral: true, semantic: true, run: true },
    provenance: {
      generator: { provider: 'opencode-go', model: 'writer-1' },
      verifier: { provider: 'opencode-go', model: 'judge-1' },
      prompt: { id: 'rubric', version: 'v1' },
      modelDifferent: true,
      familyDifferent: true,
      freshContext: true,
    },
    tierSignOff: [],
    attempts: [],
    advisory: { selfAssessment: 'success' },
    complete,
  };
}

function seedInteraction(task: Task, id: string, status: 'PENDING' | 'ANSWERED'): void {
  store.set('interactions', id, {
    id,
    taskId: task.id,
    type: 'QUESTION',
    question: 'which schema?',
    status,
    response: status === 'ANSWERED' ? 'use v2' : null,
  });
}

function seedPolicyDecision(task: Task, decision: 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN'): void {
  // Typed as the real E7 `PolicyDecisionRecord` so a reader/fixture drift is a
  // compile error, not a silently empty decision layer.
  const record: PolicyDecisionRecord = {
    id: `pd_${decision}`,
    task: task.id,
    workOrderId: task.workOrderId,
    attemptId: null,
    action: { capability: 'repo.write' },
    risk: 'YELLOW',
    decision,
    rules: [`org:repo.write:${decision}`],
    policyVersion: '<embedded>',
    resolvedBy: 'policy',
    createdAt: '2026-09-30T08:00:00.000Z',
  };
  store.set('policy_decisions', record.id, record);
}

/** Drive a Work Order all the way to a HUMAN_GATE decision so gate telemetry has real data. */
function seedHumanGate(wo: WorkOrder, decision: 'APPROVED' | 'REJECTED' | 'REWORK'): void {
  const steps: Array<Parameters<typeof transitionWorkOrder>[2]['to']> = [
    'READY',
    'PLANNING',
    'EXECUTING',
    'VERIFYING',
    'EVIDENCE_READY',
    'HUMAN_GATE',
  ];
  for (const to of steps) transitionWorkOrder({ store, events }, wo.id, { to });
  transitionWorkOrder({ store, events }, wo.id, { to: decision, reason: `${decision} by human` });
}

// ---------------------------------------------------------------------------
// E8.1 — six telemetry layers per Attempt
// ---------------------------------------------------------------------------

describe('E8.1 telemetry layers (spec §24)', () => {
  it('names exactly the six spec layers, in order', () => {
    expect([...TELEMETRY_LAYERS]).toEqual([
      'outcome',
      'human_leverage',
      'execution',
      'quality',
      'economics',
      'decision',
    ]);
  });

  it('records all six layers for one Attempt and appends exactly one telemetry event', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);
    seedRoutingDecision(wo, task);

    const before = events.count();
    const record = recordAttemptTelemetry(deps, attempt.id, {
      economics: { modelCost: 1.5, toolCost: 0.5, currency: 'USD' },
      toolCalls: [{ at: '2026-09-30T08:05:00.000Z', ref: 'read_file', detail: 'src/x.ts' }],
    });

    expect(Object.keys(record.layers).sort()).toEqual([...TELEMETRY_LAYERS].sort());
    for (const layer of TELEMETRY_LAYERS) {
      expect(record.layers[layer]).toBeDefined();
    }
    expect(record.attemptId).toBe(attempt.id);
    expect(record.taskId).toBe(task.id);
    expect(record.workOrderId).toBe(wo.id);

    // Durable: exactly one append-only telemetry receipt, read back byte-for-byte.
    expect(events.count()).toBe(before + 1);
    const recorded = events
      .readEvents({ aggregateType: 'attempt', aggregateId: attempt.id })
      .filter((event) => event.type === TELEMETRY_ATTEMPT_RECORDED);
    expect(recorded).toHaveLength(1);
    expect(readAttemptTelemetry(events, attempt.id)).toEqual(record);
  });

  it('derives the execution, quality and economics layers from the merged E1/E5 shapes', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);

    const record = recordAttemptTelemetry(deps, attempt.id, {
      economics: { modelCost: 2, toolCost: 0.25 },
      toolCalls: [{ at: '2026-09-30T08:05:00.000Z', ref: 'grep', detail: 'TODO' }],
    });

    expect(record.layers.execution.model).toBe('generalist');
    expect(record.layers.execution.skills).toEqual(['typescript']);
    expect(record.layers.execution.context).toBe('repo-summary');
    expect(record.layers.execution.trace.map((step) => step.kind)).toContain('model_call');
    expect(record.layers.execution.trace.map((step) => step.kind)).toContain('retrieval');
    expect(record.layers.execution.trace.map((step) => step.kind)).toContain('tool_call');

    expect(record.layers.outcome.outcome).toBe('success');
    expect(record.layers.outcome.taskState).toBe('SUCCESS');
    expect(record.layers.quality.firstPass).toBe(true);
    expect(record.layers.quality.reworkCount).toBe(0);

    expect(record.layers.economics).toEqual({
      modelCost: 2,
      toolCost: 0.25,
      totalCost: 2.25,
      currency: 'USD',
    });
  });

  it('captures the decision why: model / skill / context / risk / allow-deny / replan / gate', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task, {
      failureHistory: [
        { at: '2026-09-30T08:10:00.000Z', failure: 'typecheck failed', recovery: 'replan' },
      ],
    });
    seedRoutingDecision(wo, task);
    seedPolicyDecision(task, 'DENY');
    seedInteraction(task, 'interaction_1', 'ANSWERED');
    seedHumanGate(wo, 'APPROVED');

    const decision = recordAttemptTelemetry(deps, attempt.id).layers.decision;

    // why this model — from E4's durable routing decision.
    expect(decision.model).toHaveLength(1);
    expect(decision.model[0]!.ref).toBe('rd_1');
    expect(decision.model[0]!.selected).toBe('loop-solver');
    expect(decision.model[0]!.reason).toContain('task=implementation');
    // why this skill / what context: E1 Attempt holds the what; the why is honest-null here.
    expect(decision.skill.selected).toEqual(['typescript']);
    expect(decision.skill.reason).toBeNull();
    expect(decision.context.retrieved).toBe('repo-summary');
    // risk assigned.
    expect(decision.risk).toBe('YELLOW');
    // allow/deny.
    expect(decision.allowDenyStatus).toBe('available');
    expect(decision.allowDeny).toEqual([
      { ref: 'pd_DENY', action: 'repo.write', decision: 'DENY', rules: ['org:repo.write:DENY'] },
    ]);
    // replanning.
    expect(decision.replan).toEqual([
      { at: '2026-09-30T08:10:00.000Z', failure: 'typecheck failed', recovery: 'replan' },
    ]);
    // human gate.
    expect(decision.gate).toHaveLength(1);
    expect(decision.gate[0]!.to).toBe('APPROVED');
    expect(decision.gate[0]!.reason).toBe('APPROVED by human');
  });

  it('marks allow-deny as an honest stub when no policy decision exists', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);

    const decision = recordAttemptTelemetry(deps, attempt.id).layers.decision;
    expect(decision.allowDeny).toEqual([]);
    expect(decision.allowDenyStatus).toBe('stub');
    expect(decision.replan).toEqual([]);
    expect(decision.gate).toEqual([]);
  });

  it('counts rework and first-pass honestly across repeated Attempts', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    seedAttempt(task);
    seedAttempt(task);
    const third = seedAttempt(task);

    const record = recordAttemptTelemetry(deps, third.id);
    expect(record.layers.quality.reworkCount).toBe(2);
    expect(record.layers.quality.firstPass).toBe(false);
  });

  it('reads human leverage from the E2/E5 evidence read port', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);
    evidence.changes = [
      {
        id: 'vc_1',
        workOrderId: wo.id,
        taskId: task.id,
        attemptId: attempt.id,
        verifiedAt: '2026-09-30T09:00:00.000Z',
        humanMinutes: 30,
        linesChanged: 40,
        model: 'generalist',
        workerId: null,
      },
    ];
    seedInteraction(task, 'interaction_1', 'PENDING');
    seedInteraction(task, 'interaction_2', 'ANSWERED');

    const leverage = recordAttemptTelemetry(deps, attempt.id).layers.human_leverage;
    expect(leverage.humanMinutes).toBe(30);
    expect(leverage.questions).toBe(2);
    expect(leverage.interventions).toBe(1);
  });

  it('counts only QUESTION interactions as human-leverage questions', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);
    seedInteraction(task, 'interaction_q', 'PENDING');
    // A non-QUESTION interaction row must not inflate the question count.
    store.set('interactions', 'interaction_note', {
      id: 'interaction_note',
      taskId: task.id,
      type: 'NOTE',
      question: 'for your information',
      status: 'PENDING',
      response: null,
    });

    const leverage = recordAttemptTelemetry(deps, attempt.id).layers.human_leverage;
    expect(leverage.questions).toBe(1);
  });

  it('projects telemetry without persisting, and returns null for an unknown Attempt', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);
    const before = events.count();

    const projected = projectAttemptTelemetry(deps, attempt.id);
    expect(projected).not.toBeNull();
    expect(projected!.layers.execution.model).toBe('generalist');
    expect(events.count()).toBe(before);

    expect(projectAttemptTelemetry(deps, 'attempt_missing')).toBeNull();
    expect(readAttemptTelemetry(events, 'attempt_missing')).toBeNull();
  });

  it('refuses to record telemetry for an unknown Attempt', () => {
    let caught: unknown;
    try {
      recordAttemptTelemetry(deps, 'attempt_missing');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FactoryError);
    expect((caught as FactoryError).code).toBe('ATTEMPT_NOT_FOUND');
  });

  it('does not mutate the Attempt, Task or Work Order while recording', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);
    const snapshot = {
      attempt: structuredClone(store.get<Attempt>('attempts', attempt.id)),
      task: structuredClone(store.get<Task>('tasks', task.id)),
      workOrder: structuredClone(store.get<WorkOrder>('work_orders', wo.id)),
    };

    recordAttemptTelemetry(deps, attempt.id);

    expect(store.get<Attempt>('attempts', attempt.id)).toEqual(snapshot.attempt);
    expect(store.get<Task>('tasks', task.id)).toEqual(snapshot.task);
    expect(store.get<WorkOrder>('work_orders', wo.id)).toEqual(snapshot.workOrder);
  });
});

// ---------------------------------------------------------------------------
// E8.1 — drill-down projection
// ---------------------------------------------------------------------------

describe('E8.1 drill-down (spec §23)', () => {
  const stages = [
    'work_order',
    'task',
    'attempt',
    'trace',
    'verification',
    'evidence',
    'human_decision',
  ];

  it('projects the full navigable chain with trace/verification/evidence/decision resolved', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);
    recordAttemptTelemetry(deps, attempt.id);

    const run = verificationRun(attempt);
    store.set('verification_runs', run.changeSetId, run);
    store.set('attempts', attempt.id, { ...attempt, verificationRunIds: [run.changeSetId] });
    const bundle = evidenceBundle(wo, attempt);
    store.set('evidence_bundles', bundle.id, bundle);
    seedInteraction(task, 'interaction_1', 'PENDING');

    const drillDown = projectDrillDown(deps, wo.id);
    expect(drillDown).not.toBeNull();
    expect(drillDown!.chain.map((step) => step.stage)).toEqual(stages);

    const byStage = new Map(drillDown!.chain.map((step) => [step.stage, step]));
    expect(byStage.get('work_order')?.refs).toEqual([wo.id]);
    expect(byStage.get('task')?.refs).toEqual([task.id]);
    expect(byStage.get('attempt')?.refs).toEqual([attempt.id]);
    expect(byStage.get('trace')?.status).toBe('available');
    expect(byStage.get('trace')?.refs).toEqual([attempt.id]);
    expect(byStage.get('verification')?.status).toBe('available');
    expect(byStage.get('verification')?.refs).toEqual([run.changeSetId]);
    expect(byStage.get('evidence')?.status).toBe('available');
    expect(byStage.get('evidence')?.refs).toEqual([bundle.id]);
    expect(byStage.get('human_decision')?.status).toBe('available');
    expect(byStage.get('human_decision')?.refs).toEqual(['interaction_1']);
  });

  it('resolves verification from the E5 evidence port when no run row is stored', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);
    evidence.changes = [
      {
        id: 'vc_port',
        workOrderId: wo.id,
        taskId: task.id,
        attemptId: attempt.id,
        verifiedAt: '2026-09-30T09:00:00.000Z',
        humanMinutes: 10,
        linesChanged: 5,
        model: 'generalist',
        workerId: null,
      },
    ];

    const verification = projectDrillDown(deps, wo.id)!.chain.find(
      (step) => step.stage === 'verification',
    );
    expect(verification?.status).toBe('available');
    expect(verification?.refs).toEqual(['vc_port']);
  });

  it('keeps stages without data as honest stubs, never fabricated', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    createAttempt({ store, events }, { taskId: task.id, model: 'generalist' });

    const drillDown = projectDrillDown(deps, wo.id);
    const byStage = new Map(drillDown!.chain.map((step) => [step.stage, step]));
    expect(byStage.get('trace')?.status).toBe('stub');
    expect(byStage.get('trace')?.refs).toEqual([]);
    expect(byStage.get('verification')?.status).toBe('stub');
    expect(byStage.get('evidence')?.status).toBe('stub');
    expect(byStage.get('human_decision')?.status).toBe('stub');

    expect(projectDrillDown(deps, 'wo_missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E8.1 — Observatory metrics
// ---------------------------------------------------------------------------

describe('E8.1 Observatory metrics (spec §23)', () => {
  it('projects verified/day, throughput/human-hour, rework and cost', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);
    const second = seedAttempt(task); // one rework on the same Task
    recordAttemptTelemetry(deps, attempt.id, { economics: { modelCost: 1, toolCost: 0.5 } });
    recordAttemptTelemetry(deps, second.id, { economics: { modelCost: 0.5, toolCost: 0.25 } });

    evidence.changes = [
      {
        id: 'vc_1',
        workOrderId: wo.id,
        taskId: task.id,
        attemptId: attempt.id,
        verifiedAt: '2026-09-28T10:00:00.000Z',
        humanMinutes: 30,
        linesChanged: 100,
        model: 'generalist',
        workerId: null,
      },
      {
        id: 'vc_2',
        workOrderId: wo.id,
        taskId: task.id,
        attemptId: second.id,
        verifiedAt: '2026-09-28T12:00:00.000Z',
        humanMinutes: 30,
        linesChanged: 50,
        model: 'generalist',
        workerId: null,
      },
    ];

    const metrics = projectTelemetryMetrics(deps);
    expect(metrics.verifiedPerDay).toEqual([
      { day: '2026-09-28', verifiedChanges: 2, linesChanged: 150 },
    ]);
    expect(metrics.throughputPerHumanHour.verifiedChangesPerHumanHour).toBe(2);
    expect(metrics.rework).toBe(1);
    expect(metrics.cost).toEqual({ total: 2.25, currency: 'USD' });
  });

  it('reports zero metrics on an empty Factory without fabricating evidence', () => {
    const metrics = projectTelemetryMetrics(deps);
    expect(metrics.verifiedPerDay).toEqual([]);
    expect(metrics.throughputPerHumanHour.verifiedChanges).toBe(0);
    expect(metrics.rework).toBe(0);
    expect(metrics.cost).toEqual({ total: 0, currency: 'USD' });
  });

  it('counts a re-recorded Attempt once, using its latest receipt, in Observatory cost', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);
    // `recordAttemptTelemetry` may fire more than once per Attempt; the metric
    // must follow latest-wins (as `readAttemptTelemetry` does), not sum both.
    recordAttemptTelemetry(deps, attempt.id, { economics: { modelCost: 1, toolCost: 0.5 } });
    const latest = recordAttemptTelemetry(deps, attempt.id, { economics: { modelCost: 4, toolCost: 1 } });

    expect(readAttemptTelemetry(events, attempt.id)).toEqual(latest);
    expect(projectTelemetryMetrics(deps).cost).toEqual({ total: 5, currency: 'USD' });
  });
});

// ---------------------------------------------------------------------------
// E8.1 — Improvement-as-Work Loop (Levels 1–2 only)
// ---------------------------------------------------------------------------

const benchmarkInput: BenchmarkInput = {
  corpus: BENCHMARK_CORPUS,
  baseline: {
    verifiedOutcome: 10,
    humanEffort: 120,
    wallTimeMinutes: 300,
    cost: 20,
    firstPass: 0.6,
    rework: 4,
    quality: 0.8,
    interventions: 6,
  },
  candidate: {
    verifiedOutcome: 10,
    humanEffort: 90,
    wallTimeMinutes: 280,
    cost: 18,
    firstPass: 0.7,
    rework: 3,
    quality: 0.8,
    interventions: 5,
  },
};

function observeThenPropose(level: 1 | 2) {
  const signals = observeImprovements(projectTelemetryMetrics(deps));
  const observed = proposeImprovement({ store, events }, {
    level,
    title: 'Digest repeated context',
    intent: 'Feed prior Attempt experience into future context',
    acceptanceCriteria: ['rework drops without model changes'],
    rationale: 'rework observed in telemetry',
    observedFrom: signals.map((signal) => signal.id),
    candidate: 'experience-digest/v2',
    corpus: DOGFOODING_CORPUS,
  });
  return { signals, observed };
}

describe('E8.1 Improvement-as-Work loop (spec §26; self-improving-factory Level 1–2)', () => {
  it('names the improvement stages and confines levels to 1–2', () => {
    expect([...IMPROVEMENT_STAGES]).toEqual([
      'observe',
      'propose',
      'benchmark',
      'qualify',
      'promote',
    ]);
    expect([...IMPROVEMENT_LEVELS]).toEqual([1, 2]);
  });

  it('observes weaknesses from telemetry and proposes them as a real Work Order', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    const attempt = seedAttempt(task);
    seedAttempt(task); // rework so the observation has something to find
    recordAttemptTelemetry(deps, attempt.id);
    seedAttempt(task);

    const { signals, observed } = observeThenPropose(2);

    expect(signals.map((signal) => signal.signal)).toContain('rework');
    expect(observed.proposal.level).toBe(2);
    expect(observed.proposal.kind).toBe('experience_memory');
    expect(observed.proposal.state).toBe('PROPOSED');

    // It lands as a durable, first-class Work Order — not an auto-applied change.
    const landed = store.get<WorkOrder>('work_orders', observed.workOrder.id);
    expect(landed).not.toBeNull();
    expect(landed!.state).toBe('DRAFT');
    expect(landed!.intent).toBe('Feed prior Attempt experience into future context');
    expect(landed!.acceptanceCriteria).toEqual(['rework drops without model changes']);
    expect(readImprovement(events, observed.proposal.id)).toEqual(observed.proposal);
  });

  it('rejects Levels 3 and 4 (scaffold/model improvement) as out of scope', () => {
    for (const level of [0, 3, 4] as number[]) {
      let caught: unknown;
      try {
        proposeImprovement({ store, events }, { ...observeThenPropose(2).observed.proposal, level } as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FactoryError);
      expect((caught as FactoryError).code).toBe('IMPROVEMENT_LEVEL_OUT_OF_SCOPE');
    }
  });

  it('benchmarks candidates against a baseline on the benchmark corpus only', () => {
    const { observed } = observeThenPropose(2);
    const { proposal, benchmark } = benchmarkImprovement({ store, events }, observed.proposal.id, benchmarkInput);

    expect(proposal.state).toBe('BENCHMARKED');
    expect(benchmark.corpus).toBe(BENCHMARK_CORPUS);
    expect(benchmark.baseline).toEqual(benchmarkInput.baseline);
    expect(benchmark.candidate).toEqual(benchmarkInput.candidate);

    // Dogfooding observations are never benchmark evidence: the corpus stays distinct.
    let caught: unknown;
    try {
      benchmarkImprovement({ store, events }, observed.proposal.id, {
        ...benchmarkInput,
        corpus: DOGFOODING_CORPUS,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FactoryError);
    expect((caught as FactoryError).code).toBe('BENCHMARK_CORPUS_REQUIRED');
  });

  it('qualifies an improved candidate and rejects a non-improving one', () => {
    const { observed } = observeThenPropose(2);
    const { benchmark } = benchmarkImprovement({ store, events }, observed.proposal.id, benchmarkInput);

    const qualified = qualifyImprovement({ store, events }, observed.proposal.id, benchmark);
    expect(qualified.state).toBe('QUALIFIED');

    const second = observeThenPropose(1).observed;
    const noGain = benchmarkImprovement({ store, events }, second.proposal.id, {
      ...benchmarkInput,
      candidate: { ...benchmarkInput.baseline },
    });
    const rejected = qualifyImprovement({ store, events }, second.proposal.id, noGain.benchmark);
    expect(rejected.state).toBe('REJECTED');
  });

  it('refuses to qualify an un-benchmarked or mis-attributed improvement', () => {
    const { observed } = observeThenPropose(2);
    const { benchmark } = benchmarkImprovement({ store, events }, observed.proposal.id, benchmarkInput);

    // An improvement that never ran the benchmark cannot be qualified.
    const fresh = observeThenPropose(1).observed;
    expect(() => qualifyImprovement({ store, events }, fresh.proposal.id, benchmark)).toThrow(
      'not benchmarked',
    );

    // A benchmark from another improvement cannot qualify this one.
    let caught: unknown;
    try {
      qualifyImprovement({ store, events }, observed.proposal.id, {
        ...benchmark,
        proposalId: 'imp_other',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FactoryError);
    expect((caught as FactoryError).code).toBe('IMPROVEMENT_BENCHMARK_MISMATCH');
  });

  it('qualifies only against the benchmark recorded in the trail, never a caller-supplied one', () => {
    const { observed } = observeThenPropose(2);
    // The recorded run is a regression: the candidate matches the baseline on
    // every axis, so `isImprovement` is false and qualification must reject.
    const { benchmark: recorded } = benchmarkImprovement({ store, events }, observed.proposal.id, {
      ...benchmarkInput,
      candidate: { ...benchmarkInput.baseline },
    });

    // A caller forges improving metrics while keeping the recorded run's id.
    // Qualification still decides from the recorded (regressing) run.
    const forged = { ...recorded, candidate: { ...benchmarkInput.candidate } };
    const decision = qualifyImprovement({ store, events }, observed.proposal.id, forged);
    expect(decision.state).toBe('REJECTED');
    expect(readImprovement(events, observed.proposal.id)!.state).toBe('REJECTED');

    // The decision names the recorded run, never a fabricated one.
    const rejectedEvent = events
      .readEvents({ aggregateType: 'improvement_proposal', aggregateId: observed.proposal.id })
      .filter((event) => event.type === 'improvement.rejected')
      .at(-1);
    expect((rejectedEvent!.payload as { benchmarkId: string }).benchmarkId).toBe(recorded.id);

    // A caller-invented benchmark id names a run that never existed and is refused.
    const second = observeThenPropose(2).observed;
    const { benchmark } = benchmarkImprovement({ store, events }, second.proposal.id, benchmarkInput);
    let caught: unknown;
    try {
      qualifyImprovement({ store, events }, second.proposal.id, { ...benchmark, id: 'bench_forged' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FactoryError);
    expect((caught as FactoryError).code).toBe('IMPROVEMENT_BENCHMARK_MISMATCH');
  });

  it('keeps the proposal state machine forward-only: no re-benchmark after qualify or promote', () => {
    const { observed } = observeThenPropose(2);
    const { benchmark } = benchmarkImprovement({ store, events }, observed.proposal.id, benchmarkInput);
    qualifyImprovement({ store, events }, observed.proposal.id, benchmark);

    // QUALIFIED has recorded a decision: it may not regress to BENCHMARKED.
    let caught: unknown;
    try {
      benchmarkImprovement({ store, events }, observed.proposal.id, benchmarkInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FactoryError);
    expect((caught as FactoryError).code).toBe('IMPROVEMENT_NOT_BENCHMARKABLE');
    expect(readImprovement(events, observed.proposal.id)!.state).toBe('QUALIFIED');

    promoteImprovement({ store, events }, observed.proposal.id);
    // PROMOTED is terminal: it may not be re-benchmarked under the same id.
    expect(() => benchmarkImprovement({ store, events }, observed.proposal.id, benchmarkInput)).toThrow(
      'forward-only',
    );
    expect(readImprovement(events, observed.proposal.id)!.state).toBe('PROMOTED');
  });

  it('allows a rejected candidate to be re-benchmarked as explicit iteration', () => {
    const { observed } = observeThenPropose(2);
    const { benchmark: regression } = benchmarkImprovement({ store, events }, observed.proposal.id, {
      ...benchmarkInput,
      candidate: { ...benchmarkInput.baseline },
    });
    expect(qualifyImprovement({ store, events }, observed.proposal.id, regression).state).toBe('REJECTED');

    // Iteration is explicit: re-benchmark the same proposal, then re-qualify.
    const { benchmark: improved } = benchmarkImprovement({ store, events }, observed.proposal.id, benchmarkInput);
    expect(readImprovement(events, observed.proposal.id)!.state).toBe('BENCHMARKED');
    expect(qualifyImprovement({ store, events }, observed.proposal.id, improved).state).toBe('QUALIFIED');
  });

  it('promotes only a qualified improvement, and only then does work start', () => {
    const { observed } = observeThenPropose(2);

    // Un-qualified: promotion is refused and the Work Order stays DRAFT.
    expect(() => promoteImprovement({ store, events }, observed.proposal.id)).toThrow(
      'not qualified',
    );
    expect(store.get<WorkOrder>('work_orders', observed.workOrder.id)!.state).toBe('DRAFT');

    const { benchmark } = benchmarkImprovement({ store, events }, observed.proposal.id, benchmarkInput);
    qualifyImprovement({ store, events }, observed.proposal.id, benchmark);

    const promoted = promoteImprovement({ store, events }, observed.proposal.id);
    expect(promoted.proposal.state).toBe('PROMOTED');
    expect(promoted.authority).toBe('human_gate');
    expect(promoted.workOrder.state).toBe('READY');
  });

  it('never mutates production behavior without qualify/promote (no auto-mutation, no weights/scaffold)', () => {
    const wo = seedWorkOrder();
    const task = createTask({ store, events }, { workOrderId: wo.id, title: 'T' });
    seedAttempt(task);
    seedRoutingDecision(wo, task);

    const routingBefore = structuredClone(store.list<RoutingDecisionRecord>('routing_decisions'));

    const { observed } = observeThenPropose(2);
    benchmarkImprovement({ store, events }, observed.proposal.id, benchmarkInput);

    // Observing, proposing and benchmarking changed no production record: only
    // the improvement's own event trail and its DRAFT Work Order exist.
    expect(store.list<RoutingDecisionRecord>('routing_decisions')).toEqual(routingBefore);
    expect(store.list('policy_decisions')).toEqual([]);
    expect(store.list('workers')).toEqual([]);
    expect(store.get<WorkOrder>('work_orders', observed.workOrder.id)!.state).toBe('DRAFT');
    expect(store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('DRAFT');

    // Promotion is the only step that starts work, via the ordinary §5.1 edge.
    const { benchmark } = benchmarkImprovement({ store, events }, observed.proposal.id, benchmarkInput);
    qualifyImprovement({ store, events }, observed.proposal.id, benchmark);
    promoteImprovement({ store, events }, observed.proposal.id);

    expect(store.list<RoutingDecisionRecord>('routing_decisions')).toEqual(routingBefore);
    expect(store.get<WorkOrder>('work_orders', observed.workOrder.id)!.state).toBe('READY');
  });

  it('keeps the loop free of production-mutating code (no weights, no scaffold mutation)', () => {
    const dir = fileURLToPath(new URL('../../src/factory/improve', import.meta.url));
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n');
    for (const forbidden of [
      'fine-tune',
      'finetune',
      'weights',
      'writeFileSync',
      'routing_decisions',
      'policy_decisions',
    ]) {
      expect(sources.includes(forbidden), `improve loop must not reference ${forbidden}`).toBe(false);
    }
  });
});
