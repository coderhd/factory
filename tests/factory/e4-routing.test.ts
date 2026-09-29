import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTask, createWorkOrder, type WorkOrderDeps } from '../../src/factory/domain/workOrder';
import { openEventLog } from '../../src/factory/events/log';
import { openStateStore } from '../../src/factory/state/store';
import type {
  BudgetState,
  DecisionModel,
  ModelId,
  RouteInput,
  RoutingDecisionRecord,
} from '../../src/factory/routing/decisionModel';
import {
  BUDGET_GATES,
  FULL_BUDGET,
  MODEL_TIER,
  RulesDecisionModel,
  applyOverride,
  budgetAllows,
  candidatesFor,
  parseRouteOverride,
  selectModel,
  toRoutingDecisionRecord,
} from '../../src/factory/routing/rules';

/** Build a RouteInput with defaults for the dimensions a case does not care about. */
const ri = (
  task: RouteInput['task'],
  complexity: RouteInput['complexity'] = 'normal',
  risk: RouteInput['risk'] = 'low',
  context: RouteInput['context'] = 'small',
): RouteInput => ({ task, complexity, risk, context });

const ROUTING_RUNTIME_SOURCES = [
  fileURLToPath(new URL('../../src/factory/routing/decisionModel.ts', import.meta.url)),
  fileURLToPath(new URL('../../src/factory/routing/rules.ts', import.meta.url)),
];

/**
 * Provider tokens that must never appear in runtime semantics. The dev router
 * (`.opencode/plugins/factory-guard/router.ts`) is reference-only; its concrete
 * model IDs stay in the dev mapping layer, never in the runtime seam.
 */
const PROVIDER_TOKENS = [
  'glm-5.3',
  'qwen3.8',
  'mimo-v2.6',
  'deepseek-v4.1',
  'grok-4.7',
  'kimi-k3',
  'gpt-6-luna',
  'opencode-go',
  'Jev',
  'Span',
];

describe('E4.1 generic routing seam', () => {
  it('keeps provider model IDs out of runtime semantics', () => {
    for (const source of ROUTING_RUNTIME_SOURCES) {
      const code = readFileSync(source, 'utf8');
      for (const token of PROVIDER_TOKENS) {
        expect(code.includes(token), `${source} must not name ${token}`).toBe(false);
      }
    }
  });

  it('exposes DecisionModel as an implementation-neutral seam', () => {
    const rules: DecisionModel = new RulesDecisionModel();
    const input = ri('debugging', 'complex', 'medium', 'small');
    expect(rules.recommend(input)).toEqual(candidatesFor(input));

    // A challenger (shadow candidate, ensemble, human process, ...) sits behind
    // the same seam without introducing a new typed concept.
    const challenger: DecisionModel = { recommend: () => ['explorer'] };
    expect(challenger.recommend(input)).toEqual(['explorer']);
  });
});

describe('E4.1 deterministic capability matrix (ported)', () => {
  it('maps every task shape to the ported ordered candidate list', () => {
    const cases: Array<[RouteInput, ModelId[]]> = [
      [ri('exploration'), ['explorer', 'generalist', 'implementer']],
      [ri('repository-analysis'), ['explorer', 'generalist', 'implementer']],
      [ri('large-context-analysis', 'normal', 'low', 'large'), ['loop-solver', 'explorer', 'generalist', 'implementer']],
      [ri('large-context-analysis', 'normal', 'low', 'xlarge'), ['loop-solver', 'explorer', 'generalist', 'implementer']],
      [ri('exploration', 'normal', 'low', 'medium'), ['explorer', 'generalist', 'implementer']],
      [ri('implementation', 'trivial'), ['generalist', 'implementer', 'explorer']],
      [ri('implementation', 'simple'), ['generalist', 'implementer', 'explorer']],
      [ri('implementation', 'complex'), ['loop-solver', 'reviewer', 'planner', 'implementer']],
      [ri('implementation'), ['implementer', 'generalist', 'loop-solver']],
      [ri('refactoring', 'complex'), ['loop-solver', 'reviewer', 'planner', 'implementer']],
      [ri('refactoring'), ['implementer', 'generalist', 'loop-solver']],
      [ri('debugging'), ['loop-solver', 'reviewer', 'planner']],
      [ri('test-debugging'), ['loop-solver', 'reviewer', 'planner']],
      [ri('ci-troubleshooting'), ['loop-solver', 'reviewer', 'planner']],
      [ri('test-generation'), ['implementer', 'generalist', 'explorer']],
      [ri('documentation'), ['implementer', 'generalist', 'explorer']],
      [ri('planning'), ['planner', 'reviewer', 'frontier']],
      [ri('architecture'), ['planner', 'frontier', 'reviewer']],
      [ri('code-review'), ['reviewer', 'planner', 'loop-solver']],
      [ri('code-review', 'normal', 'high'), ['frontier', 'adversarial', 'reviewer']],
      [ri('security-review'), ['frontier', 'adversarial', 'diversifier']],
      [ri('adversarial-review'), ['frontier', 'adversarial', 'diversifier']],
      [ri('second-opinion'), ['independent-opinion', 'reviewer', 'diversifier']],
    ];
    for (const [input, expected] of cases) {
      expect(candidatesFor(input), `task=${input.task}`).toEqual(expected);
    }
  });

  it('is deterministic: the same input yields the same decision', () => {
    const input = ri('planning', 'complex', 'medium', 'medium');
    const first = selectModel(input);
    const second = selectModel(input);
    expect(second).toEqual(first);
    expect(first.selected).toBe('planner');
  });

  it('selects capability-first with a healthy budget and carries the snapshot', () => {
    const input = ri('debugging', 'complex', 'medium', 'large');
    const decision = selectModel(input);
    expect(decision.selected).toBe('loop-solver');
    expect(decision.candidates).toEqual(['loop-solver', 'reviewer', 'planner']);
    expect(decision.metadata).toEqual({ ...input, unavailable: [], budget: FULL_BUDGET });
    expect(decision.reason).toContain('task=debugging');
    expect(decision.reason).toContain('mid tier');
  });
});

describe('E4.1 budget gates', () => {
  it('enforces the escalation gate: monthly >= 30%, weekly >= 30%, 5h >= 20%', () => {
    expect(BUDGET_GATES.escalation).toEqual({
      monthlyRemaining: 0.3,
      weeklyRemaining: 0.3,
      fiveHourRemaining: 0.2,
    });
    expect(budgetAllows('frontier', { monthlyRemaining: 0.3, weeklyRemaining: 0.3, fiveHourRemaining: 0.2 })).toBe(true);
    expect(budgetAllows('frontier', { monthlyRemaining: 0.29, weeklyRemaining: 1, fiveHourRemaining: 1 })).toBe(false);
    expect(budgetAllows('adversarial', { monthlyRemaining: 1, weeklyRemaining: 0.29, fiveHourRemaining: 1 })).toBe(false);
    expect(budgetAllows('diversifier', { monthlyRemaining: 1, weeklyRemaining: 1, fiveHourRemaining: 0.19 })).toBe(false);
  });

  it('enforces the mid gate: monthly >= 10%, weekly >= 10%, 5h >= 5%', () => {
    expect(BUDGET_GATES.mid).toEqual({
      monthlyRemaining: 0.1,
      weeklyRemaining: 0.1,
      fiveHourRemaining: 0.05,
    });
    expect(budgetAllows('planner', { monthlyRemaining: 0.1, weeklyRemaining: 0.1, fiveHourRemaining: 0.05 })).toBe(true);
    expect(budgetAllows('reviewer', { monthlyRemaining: 0.09, weeklyRemaining: 1, fiveHourRemaining: 1 })).toBe(false);
    expect(budgetAllows('loop-solver', { monthlyRemaining: 1, weeklyRemaining: 0.09, fiveHourRemaining: 1 })).toBe(false);
  });

  it('never gates cheap models', () => {
    const drained: BudgetState = { monthlyRemaining: 0, weeklyRemaining: 0, fiveHourRemaining: 0 };
    expect(BUDGET_GATES.cheap).toEqual(drained);
    expect(budgetAllows('generalist', drained)).toBe(true);
    expect(budgetAllows('explorer', drained)).toBe(true);
    expect(budgetAllows('implementer', drained)).toBe(true);
  });

  it('skips budget-blocked candidates in order and never jumps to max', () => {
    // High-risk code review: [frontier, adversarial, reviewer]; escalation gated
    // so the walk lands on the mid candidate, in list order.
    const decision = selectModel(ri('code-review', 'normal', 'high'), {
      monthlyRemaining: 0.29,
      weeklyRemaining: 1,
      fiveHourRemaining: 1,
    });
    expect(decision.candidates).toEqual(['frontier', 'adversarial', 'reviewer']);
    expect(decision.selected).toBe('reviewer');
    expect(MODEL_TIER[decision.selected]).toBe('mid');
    expect(decision.metadata.budget).toEqual({
      monthlyRemaining: 0.29,
      weeklyRemaining: 1,
      fiveHourRemaining: 1,
    });
  });

  it('falls back to the cheapest unblocked pool model when every candidate is gated', () => {
    // Security review lists only escalation candidates; with the escalation
    // gate closed the last resort is the cheapest pool model, never the most
    // expensive one.
    const decision = selectModel(ri('security-review'), {
      monthlyRemaining: 0.29,
      weeklyRemaining: 0.29,
      fiveHourRemaining: 0.19,
    });
    expect(decision.selected).toBe('explorer');
    expect(MODEL_TIER[decision.selected]).toBe('cheap');
    expect(decision.reason).toContain('last-resort');
  });
});

describe('E4.1 availability fallback', () => {
  it('skips unavailable candidates in order', () => {
    const input = ri('implementation'); // [implementer, generalist, loop-solver]
    expect(selectModel(input, FULL_BUDGET, ['implementer']).selected).toBe('generalist');
    expect(selectModel(input, FULL_BUDGET, ['implementer', 'generalist']).selected).toBe('loop-solver');
  });

  it('stays on the cheapest pool model, never max, when the whole list is unavailable', () => {
    const decision = selectModel(ri('implementation'), FULL_BUDGET, [
      'implementer',
      'generalist',
      'loop-solver',
    ]);
    expect(decision.selected).toBe('explorer');
    expect(MODEL_TIER[decision.selected]).toBe('cheap');
    expect(decision.reason).toContain('last-resort');
  });
});

describe('E4.1 manual override', () => {
  it('parses /route <model> against the known pool', () => {
    expect(parseRouteOverride('/route frontier')).toBe('frontier');
    expect(parseRouteOverride('please /Route Reviewer now')).toBe('reviewer');
    expect(parseRouteOverride('/route not-a-model')).toBeNull();
    expect(parseRouteOverride('/route')).toBeNull();
    expect(parseRouteOverride('no command here')).toBeNull();
    // A deployment with its own model catalog resolves its own identifiers.
    expect(parseRouteOverride('/route m-1', ['m-1'])).toBe('m-1');
    expect(parseRouteOverride('/route frontier', ['m-1'])).toBeNull();
  });

  it('makes the override win over the rules recommendation', () => {
    const input = ri('architecture'); // rules would select 'planner'
    expect(selectModel(input).selected).toBe('planner');

    const decision = applyOverride(input, 'implementer');
    expect(decision.selected).toBe('implementer');
    expect(decision.candidates).toEqual(candidatesFor(input));
    expect(decision.reason).toContain('manual override');
    expect(decision.metadata).toEqual({ ...input, unavailable: [], budget: FULL_BUDGET });
  });

  it('does not budget-gate an override', () => {
    const drained: BudgetState = { monthlyRemaining: 0, weeklyRemaining: 0, fiveHourRemaining: 0 };
    const decision = applyOverride(ri('architecture'), 'frontier', drained);
    expect(decision.selected).toBe('frontier');
    expect(decision.metadata.budget).toEqual(drained);
  });

  it('falls back to the rules selection when the override is unavailable', () => {
    const input = ri('planning'); // [planner, reviewer, frontier]
    const decision = applyOverride(input, 'planner', FULL_BUDGET, ['planner']);
    expect(decision.selected).toBe('reviewer');
    expect(decision.reason).not.toContain('manual override');
  });
});

describe('E4.1 routing decision provenance', () => {
  let workDir: string;
  let dbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'factory-e4-'));
    dbPath = join(workDir, 'factory.db');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('carries the full task/complexity/risk/context/budget snapshot', () => {
    const input = ri('planning', 'complex', 'medium', 'medium');
    const decision = selectModel(input, FULL_BUDGET, ['planner']);
    expect(decision.selected).toBe('reviewer');

    const record = toRoutingDecisionRecord(decision, {
      source: 'rules',
      workOrderId: 'wo_1',
      taskId: 'task_1',
      id: 'rd_1',
      createdAt: '2026-09-29T00:00:00.000Z',
    });
    expect(record).toEqual({
      id: 'rd_1',
      workOrderId: 'wo_1',
      taskId: 'task_1',
      source: 'rules',
      task: 'planning',
      complexity: 'complex',
      risk: 'medium',
      context: 'medium',
      selected: 'reviewer',
      candidates: ['planner', 'reviewer', 'frontier'],
      reason: decision.reason,
      unavailable: ['planner'],
      budget: FULL_BUDGET,
      createdAt: '2026-09-29T00:00:00.000Z',
    });
  });

  it('defaults provenance ids and times when not supplied', () => {
    const decision = applyOverride(ri('planning'), 'frontier');
    const record = toRoutingDecisionRecord(decision, { source: 'override' });
    expect(record.id).toMatch(/^rd_/);
    expect(record.workOrderId).toBeNull();
    expect(record.taskId).toBeNull();
    expect(record.source).toBe('override');
    expect(record.selected).toBe('frontier');
    expect(new Date(record.createdAt).toISOString()).toBe(record.createdAt);
  });

  it('stub-persists to the E1 routing_decisions table with full provenance', () => {
    // #17 (E4.2) owns the concrete writer (state row + event + routing.log).
    // Here the record only has to round-trip through E1's existing seams,
    // keyed by a real Work Order and Task created in the deps-first shape.
    const store = openStateStore(dbPath);
    const events = openEventLog(store.db);
    const deps: WorkOrderDeps = { store, events };
    const workOrder = createWorkOrder(deps, { intent: 'route this work' });
    const task = createTask(deps, { workOrderId: workOrder.id, title: 'First task' });

    const decision = selectModel(ri('planning', 'complex', 'medium', 'medium'), FULL_BUDGET, ['planner']);
    const record = toRoutingDecisionRecord(decision, {
      source: 'rules',
      workOrderId: workOrder.id,
      taskId: task.id,
    });

    store.set('routing_decisions', record.id, record);
    expect(store.get<RoutingDecisionRecord>('routing_decisions', record.id)).toEqual(record);
    store.close();
  });
});
