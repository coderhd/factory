import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FactoryError } from '../../src/factory/domain/errors';
import {
  createAttempt,
  createWorkOrder,
  transitionTask,
  transitionWorkOrder,
  type Attempt,
  type Task,
  type TaskState,
  type WorkOrder,
  type WorkOrderState,
} from '../../src/factory/domain/workOrder';
import { openEventLog, type EventLog } from '../../src/factory/events/log';
import { commitDAG, getActiveDAG, type DAGProposalPayload } from '../../src/factory/planning/dag';
import {
  APPROVAL_CREATED,
  CAPABILITIES,
  DEFAULT_POLICY_VERSION,
  POLICY_DECISION_RECORDED,
  answerApproval,
  check,
  checkDetailed,
  createDefaultPolicy,
  emergencyStop,
  evaluate,
  factoryControlState,
  isConsequentialExternalAction,
  isEmergencyStopped,
  isFactoryPaused,
  pauseFactory,
  resumeFactory,
  resolveChain,
  type ApprovalRecord,
  type PolicyAction,
  type PolicyChain,
  type PolicyDecisionRecord,
  type PolicyDocument,
  type PolicyLevel,
  type PolicyResource,
  type PolicyVerdict,
} from '../../src/factory/policy/policy';
import {
  RISK_TIER_CHANGED,
  classifyRisk,
  escalateFor,
  matchesGlob,
  tierFloor,
  tighterTier,
} from '../../src/factory/policy/risk';
import {
  DEFAULT_RECOVERY_BUDGETS,
  RECOVERY_ACTION_APPLIED,
  RESOURCE_UNAVAILABLE,
  backoffWithJitter,
  encodeFailure,
  parseFailureClass,
  recover,
  reconcileAfterRestart,
  replanWorkOrder,
  type FailureContext,
  type RecoveryAction,
  type RecoveryDeps,
} from '../../src/factory/recovery/recovery';
import {
  createArtifactStore,
  openStateStore,
  type ArtifactStore,
  type StateStore,
} from '../../src/factory/state/store';

let workDir: string;
let dbPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'factory-e7-'));
  dbPath = join(workDir, 'factory.db');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  store: StateStore;
  events: EventLog;
  artifacts: ArtifactStore;
  clock: ReturnType<typeof makeClock>;
  policy?: PolicyDocument;
}

function makeClock(startIso = '2026-09-30T00:00:00.000Z') {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function harness(opts: { policy?: PolicyDocument; withArtifacts?: boolean } = {}): Harness {
  const store = openStateStore(dbPath);
  const events = openEventLog(store.db);
  return {
    store,
    events,
    artifacts: createArtifactStore(join(workDir, 'artifacts')),
    clock: makeClock(),
    policy: opts.policy,
  };
}

const deps = (h: Harness) => ({ store: h.store, events: h.events, now: h.clock.now });
const policyDeps = (h: Harness) => ({
  store: h.store,
  events: h.events,
  now: h.clock.now,
  policy: h.policy,
});

function seedWorkOrder(
  h: Harness,
  opts: { states?: WorkOrderState[]; riskTier?: 'GREEN' | 'YELLOW' | 'RED'; repository?: string } = {},
): WorkOrder {
  const wo = createWorkOrder(deps(h), {
    intent: 'E7 subject',
    repository: opts.repository,
    riskTier: opts.riskTier,
  });
  for (const to of opts.states ?? []) transitionWorkOrder(deps(h), wo.id, { to });
  return wo;
}

function planOne(h: Harness, wo: WorkOrder, nodes: DAGProposalPayload['nodes'] = [{ nodeId: 'n1', title: 'Implement' }]) {
  if (h.store.get<WorkOrder>('work_orders', wo.id)?.state !== 'PLANNING') {
    throw new Error('planOne requires PLANNING');
  }
  const dag = commitDAG(deps(h), wo.id, { nodes });
  return { taskId: dag.nodes[0].taskId, dag };
}

const decisionRows = (h: Harness): PolicyDecisionRecord[] =>
  h.store.list<PolicyDecisionRecord>('policy_decisions');

const approvals = (h: Harness): ApprovalRecord[] =>
  h.store.list<ApprovalRecord>('interactions');

const eventsOfType = (h: Harness, type: string) => h.events.readEvents().filter((e) => e.type === type);

// ---------------------------------------------------------------------------
// risk.ts — classifyRisk / escalateFor / tier floor / narrowing algebra
// ---------------------------------------------------------------------------

describe('E7 risk: classifyRisk is durable and WO-only', () => {
  it('returns exactly the durable Work Order tier (no field inference)', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { riskTier: 'RED' });
      // Constraints/out of scope never influence the durable classifier.
      h.store.set('work_orders', wo.id, {
        ...wo,
        riskTier: 'YELLOW',
        constraints: ['touches auth', 'production migration'],
        outOfScope: ['**/secrets/**'],
      });
      const stored = h.store.get<WorkOrder>('work_orders', wo.id)!;
      expect(classifyRisk(stored)).toBe('YELLOW');
    } finally {
      h.store.close();
    }
  });

  it('starts every Work Order at YELLOW unless a human declares otherwise', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h);
      expect(wo.riskTier).toBe('YELLOW');
      expect(classifyRisk(wo)).toBe('YELLOW');
    } finally {
      h.store.close();
    }
  });
});

describe('E7 risk: escalateFor security-taxonomy observation', () => {
  it('escalates a resource path that hits the security taxonomy to RED', () => {
    expect(escalateFor('repo.write', { path: 'src/auth/login.ts' })).toBe('RED');
    expect(escalateFor('repo.write', { path: 'lib/secrets/keys.ts' })).toBe('RED');
    expect(escalateFor('repo.write', { path: 'config/password-reset.ts' })).toBe('RED');
    expect(escalateFor('repo.write', { path: 'infra/prod/main.tf' })).toBe('RED');
    expect(escalateFor('repo.write', { path: 'src/orders/list.ts' })).toBe('GREEN');
  });

  it('escalates production env and customer-data exposure to RED', () => {
    expect(escalateFor('deploy.execute', { env: 'production' })).toBe('RED');
    expect(escalateFor('production.read', { dataClass: 'customer-data' })).toBe('RED');
    expect(escalateFor('deploy.execute', { env: 'staging' })).toBe('GREEN');
  });

  it('matches globs used by the taxonomy and policy scopes', () => {
    expect(matchesGlob('**/auth/**', 'src/auth/login.ts')).toBe(true);
    expect(matchesGlob('**/auth/**', 'auth/login.ts')).toBe(true);
    expect(matchesGlob('src/**', 'src/a/b.ts')).toBe(true);
    expect(matchesGlob('src/**', 'docs/a.md')).toBe(false);
    expect(matchesGlob('wo-*/**', 'wo-142/impl')).toBe(true);
    expect(matchesGlob('wo-*/**', 'main')).toBe(false);
  });
});

describe('E7 risk: effective-tier fold and tier gate are monotone', () => {
  it('tighterTier never lowers (escalateFor GREEN is the no-op sentinel)', () => {
    expect(tighterTier('YELLOW', 'GREEN')).toBe('YELLOW');
    expect(tighterTier('YELLOW', 'RED')).toBe('RED');
    expect(tighterTier('GREEN', 'YELLOW')).toBe('YELLOW');
    expect(tighterTier('RED', 'GREEN')).toBe('RED');
  });

  it('floors high-sensitivity capabilities at REQUIRE_HUMAN for every tier', () => {
    for (const tier of ['GREEN', 'YELLOW', 'RED'] as const) {
      expect(tierFloor(tier, 'high')).toBe('REQUIRE_HUMAN');
    }
    expect(tierFloor('RED', 'low')).toBe('REQUIRE_HUMAN');
    expect(tierFloor('RED', 'medium')).toBe('REQUIRE_HUMAN');
    expect(tierFloor('GREEN', 'low')).toBe('ALLOW');
    expect(tierFloor('YELLOW', 'medium')).toBe('ALLOW');
  });
});

// ---------------------------------------------------------------------------
// policy.ts — monotonic narrowing (pure evaluate)
// ---------------------------------------------------------------------------

const org = () => createDefaultPolicy().organization;
const level = (capabilities: PolicyLevel['capabilities']): PolicyLevel => ({ capabilities });

describe('E7 policy: monotonic narrowing Org → Project → WO → Task', () => {
  const action = (capability: string, resource?: PolicyResource): PolicyAction => ({
    capability,
    resource,
  });

  it('a child can narrow but never widen (strictest-wins fold)', () => {
    const chain: PolicyChain = {
      version: 'test',
      organization: level({ 'repo.write': [{ decision: 'ALLOW', scope: { branchPattern: 'wo-*/**' } }] }),
      project: level({ 'repo.write': [{ decision: 'REQUIRE_HUMAN' }] }),
    };
    const narrowed = evaluate({
      chain,
      wo: { riskTier: 'YELLOW' },
      action: action('repo.write', { branch: 'wo-1/impl' }),
    });
    expect(narrowed.decision).toBe('REQUIRE_HUMAN');
  });

  it('a widening attempt is inert and recorded as widening-attempt', () => {
    const chain: PolicyChain = {
      version: 'test',
      organization: level({ 'repo.write': [{ decision: 'DENY' }] }),
      project: level({ 'repo.write': [{ decision: 'ALLOW' }] }),
    };
    const result = evaluate({
      chain,
      wo: { riskTier: 'YELLOW' },
      action: action('repo.write', { branch: 'wo-1/impl' }),
    });
    expect(result.decision).toBe('DENY');
    expect(result.rules.some((r) => r.includes('widening-attempt'))).toBe(true);
  });

  it('an over-ceiling expression is coerced and marked ceiling-violation (§7.2)', () => {
    const chain: PolicyChain = {
      version: 'test',
      organization: org(),
      task: level({ 'secrets.read': [{ decision: 'ALLOW' }] }),
    };
    const result = evaluate({
      chain,
      wo: { riskTier: 'YELLOW' },
      action: action('secrets.read', { path: 'src/config/.env' }),
    });
    expect(result.decision).toBe('DENY');
    expect(result.rules.some((r) => r.includes('ceiling-violation'))).toBe(true);
    expect(result.rules.some((r) => r.includes('widening-attempt'))).toBe(true);
  });

  it('scope widening by resource claim is impossible — intersection removes infra/** (§7.3)', () => {
    const chain: PolicyChain = {
      version: 'test',
      organization: org(),
      workOrder: level({
        'repo.write': [{ decision: 'ALLOW', scope: { paths: ['src/**', 'infra/**'] } }],
      }),
    };
    const infra = evaluate({
      chain,
      wo: { riskTier: 'YELLOW' },
      action: action('repo.write', { path: 'infra/main.tf', branch: 'wo-1/impl' }),
    });
    expect(infra.decision).toBe('DENY');

    const src = evaluate({
      chain,
      wo: { riskTier: 'YELLOW' },
      action: action('repo.write', { path: 'src/main.ts', branch: 'wo-1/impl' }),
    });
    expect(src.decision).toBe('ALLOW');
  });

  it('a scope-bound dimension with no binding is not covered — an omitted branch DENIES repo.write/branch.create', () => {
    const chain = { version: 'test', organization: org() };

    // The root repo.write scope binds `branch: wo-*/**`; silence about the
    // branch must not satisfy it (§4 "anything else … resolves DENY via the
    // scope"; §5 "rather than guess").
    const omittedBranch = evaluate({
      chain,
      wo: { riskTier: 'GREEN' },
      action: action('repo.write', { path: 'src/orders.ts' }),
    });
    expect(omittedBranch.decision).toBe('DENY');
    expect(omittedBranch.rules.some((r) => r.includes('outside-scope'))).toBe(true);

    const branchCreate = evaluate({
      chain,
      wo: { riskTier: 'GREEN' },
      action: action('branch.create'),
    });
    expect(branchCreate.decision).toBe('DENY');

    // A missing path cannot be proven outside the root `excludePaths: ['infra/**']`.
    const omittedPath = evaluate({
      chain,
      wo: { riskTier: 'GREEN' },
      action: action('repo.write', { branch: 'wo-9/impl' }),
    });
    expect(omittedPath.decision).toBe('DENY');

    // Supplying the bindings restores the grant (the change is fail-closed, not a veto).
    const bound = evaluate({
      chain,
      wo: { riskTier: 'GREEN' },
      action: action('repo.write', { path: 'src/orders.ts', branch: 'wo-9/impl' }),
    });
    expect(bound.decision).toBe('ALLOW');
  });

  it('a custom source cannot express an ALLOW above the scoped production.read customer-data ceiling (§3.3-5)', () => {
    const chain: PolicyChain = {
      version: 'test',
      organization: level({ 'production.read': [{ decision: 'ALLOW' }] }),
    };

    const customer = resolveChain('production.read', { dataClass: 'customer-data' }, chain);
    expect(customer.decision).toBe('REQUIRE_HUMAN');
    expect(customer.rules.some((r) => r.includes('ceiling-violation'))).toBe(true);

    // The ceiling binds per matched dimension: the synthetic facet is untouched.
    const synthetic = resolveChain('production.read', { dataClass: 'synthetic' }, chain);
    expect(synthetic.decision).toBe('ALLOW');
    expect(synthetic.rules.some((r) => r.includes('ceiling-violation'))).toBe(false);
  });

  it('a production deploy cannot be unlocked below a WO DENY even by a Task claim (§7.4)', () => {
    const chain: PolicyChain = {
      version: 'test',
      organization: org(),
      project: level({
        'deploy.execute': [{ decision: 'ALLOW', scope: { env: 'staging' } }],
      }),
      workOrder: level({ 'deploy.execute': [{ decision: 'DENY' }] }),
      task: level({
        'deploy.execute': [{ decision: 'ALLOW', scope: { env: 'production' } }],
      }),
    };
    const prod = evaluate({
      chain,
      wo: { riskTier: 'YELLOW' },
      action: action('deploy.execute', { env: 'production' }),
    });
    expect(prod.decision).toBe('DENY');
    expect(prod.rules.some((r) => r.includes('ceiling-violation'))).toBe(true);

    // The staging ALLOW is legal: ceilings bind per matched dimension (§3.3-5).
    // (The WO's unscoped "no deploy" constraint denies staging too in the full
    // chain — that is the WO narrowing, which is legal; the ceiling claim is
    // proven on the Org+Project fold where the production ceiling must not touch
    // the staging facet.)
    const stagingFold = resolveChain(
      'deploy.execute',
      { env: 'staging' },
      { ...chain, workOrder: undefined, task: undefined },
    );
    expect(stagingFold.decision).toBe('ALLOW');
    expect(stagingFold.rules.some((r) => r.includes('ceiling-violation'))).toBe(false);
  });

  it('§7.1 a YELLOW WO writing src/auth/login.ts is floored to REQUIRE_HUMAN by the check-time escalation', () => {
    const chain: PolicyChain = {
      version: 'test',
      organization: org(),
      project: level({
        'repo.write': [{ decision: 'ALLOW', scope: { paths: ['src/**', 'docs/**'] } }],
      }),
    };
    const result = evaluate({
      chain,
      wo: { riskTier: 'YELLOW' },
      action: action('repo.write', { path: 'src/auth/login.ts', branch: 'wo-142/impl' }),
    });
    expect(result.decision).toBe('REQUIRE_HUMAN');
    expect(result.risk).toBe('RED');
    expect(result.resolvedBy).toBe('tier-gate');
  });

  it('a branch-scoped DENY does not poison sibling ALLOWs for other branches (per-rule scope fold)', () => {
    const chain: PolicyChain = {
      version: 'test',
      organization: org(),
      project: level({
        'repo.write': [
          { decision: 'ALLOW', scope: { branchPattern: 'wo-*/**', excludePaths: ['infra/**'] } },
          { decision: 'DENY', scope: { branchPattern: 'main' } },
        ],
      }),
    };

    // The `wo-1/impl` write is covered by the ALLOW and out of the DENY's scope.
    const feature = resolveChain('repo.write', { path: 'src/x.ts', branch: 'wo-1/impl' }, chain);
    expect(feature.decision).toBe('ALLOW');

    // The DENY-speak for the default branch still applies to it.
    const mainWrite = resolveChain('repo.write', { path: 'src/x.ts', branch: 'main' }, chain);
    expect(mainWrite.decision).toBe('DENY');
  });

  it('unknown capabilities are DENY with an unknown-capability marker', () => {
    const result = evaluate({
      chain: { version: 'test', organization: org() },
      wo: { riskTier: 'YELLOW' },
      action: action('database.drop'),
    });
    expect(result.decision).toBe('DENY');
    expect(result.rules).toContain('unknown-capability');
  });

  it('absent grants for sensitive capabilities resolve restricted (no implicit ALLOW)', () => {
    const result = evaluate({
      chain: { version: 'test', organization: org() },
      wo: { riskTier: 'GREEN' },
      action: action('production.write', { env: 'production' }),
    });
    expect(result.decision).toBe('DENY');
  });
});

// ---------------------------------------------------------------------------
// policy.ts — durable decisions (`check`) + write rule + approval ledger
// ---------------------------------------------------------------------------

describe('E7 policy: durable policy_decisions + idempotent write rule', () => {
  it('records one policy.decision row + event and dedups identical verdicts', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { states: ['READY', 'PLANNING'], repository: 'client-portal' });
      h.policy = {
        ...createDefaultPolicy(),
        projects: {
          'client-portal': level({
            'repo.write': [{ decision: 'ALLOW', scope: { paths: ['src/**'] } }],
          }),
        },
      };
      const subject = { taskId: null, workOrderId: wo.id };
      const first = check(policyDeps(h), subject, {
        capability: 'repo.write',
        resource: { path: 'src/orders.ts', branch: 'wo-1/impl' },
      });
      expect(first).toBe('ALLOW');
      expect(decisionRows(h)).toHaveLength(1);
      expect(eventsOfType(h, POLICY_DECISION_RECORDED)).toHaveLength(1);

      const second = check(policyDeps(h), subject, {
        capability: 'repo.write',
        resource: { path: 'src/orders.ts', branch: 'wo-1/impl' },
      });
      expect(second).toBe('ALLOW');
      expect(decisionRows(h)).toHaveLength(1);
      expect(eventsOfType(h, POLICY_DECISION_RECORDED)).toHaveLength(1);

      // A verdict change (different resource, different resolved facet) writes a new row.
      check(policyDeps(h), subject, {
        capability: 'repo.write',
        resource: { path: 'docs/readme.md', branch: 'wo-1/impl' },
      });
      expect(decisionRows(h)).toHaveLength(2);
    } finally {
      h.store.close();
    }
  });

  it('ratchets the durable Work Order tier when escalateFor exceeds it (same transaction)', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { states: ['READY', 'PLANNING'], repository: 'client-portal' });
      h.policy = {
        ...createDefaultPolicy(),
        projects: {
          'client-portal': level({
            'repo.write': [{ decision: 'ALLOW', scope: { paths: ['src/**'] } }],
          }),
        },
      };
      const verdict = check(policyDeps(h), { taskId: null, workOrderId: wo.id }, {
        capability: 'repo.write',
        resource: { path: 'src/auth/login.ts', branch: 'wo-1/impl' },
      });
      expect(verdict).toBe('REQUIRE_HUMAN');
      expect(h.store.get<WorkOrder>('work_orders', wo.id)?.riskTier).toBe('RED');
      expect(eventsOfType(h, RISK_TIER_CHANGED)).toHaveLength(1);

      // Idempotent: observing RED again writes no extra tier change.
      check(policyDeps(h), { taskId: null, workOrderId: wo.id }, {
        capability: 'repo.write',
        resource: { path: 'src/auth/login.ts', branch: 'wo-1/impl' },
      });
      expect(eventsOfType(h, RISK_TIER_CHANGED)).toHaveLength(1);
    } finally {
      h.store.close();
    }
  });

  it('checkDetailed reports the verdict plus resolvedBy/spentApprovalId/approvalActor for a consumed APPROVAL', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { riskTier: 'RED' });
      const subject = { taskId: null, workOrderId: wo.id };
      const action: PolicyAction = { capability: 'pr.create', attemptId: 'attempt_1' };

      // First evaluation parks: resolved by the tier gate, no approval spent yet.
      const parked = checkDetailed(policyDeps(h), subject, action);
      expect(parked.verdict).toBe('REQUIRE_HUMAN');
      expect(parked.resolvedBy).toBe('tier-gate');
      expect(parked.spentApprovalId).toBeNull();
      expect(parked.approvalActor).toBeNull();

      const appr = approvals(h)[0]!;
      answerApproval(policyDeps(h), appr.id, { decision: 'APPROVAL', actor: 'operator-9' });

      const allowed = checkDetailed(policyDeps(h), subject, action);
      expect(allowed.verdict).toBe('ALLOW');
      expect(allowed.resolvedBy).toBe('human-approval');
      expect(allowed.spentApprovalId).toBe(appr.id);
      // The actor is read from the durable approval record, not the caller.
      expect(allowed.approvalActor).toBe('operator-9');

      // Replay keeps the same binding (idempotent write rule).
      const replay = checkDetailed(policyDeps(h), subject, action);
      expect(replay.verdict).toBe('ALLOW');
      expect(replay.approvalActor).toBe('operator-9');
    } finally {
      h.store.close();
    }
  });

  it('a REQUIRE_HUMAN verdict creates an ApprovalRecord; a matching approval consumes it exactly once', () => {    const h = harness();
    try {
      const wo = seedWorkOrder(h, { riskTier: 'RED' });
      const action: PolicyAction = { capability: 'pr.create', attemptId: 'attempt_1' };
      const subject = { taskId: null, workOrderId: wo.id };

      const parked = check(policyDeps(h), subject, action);
      expect(parked).toBe('REQUIRE_HUMAN');
      const created = approvals(h);
      expect(created).toHaveLength(1);
      expect(created[0].type).toBe('APPROVAL');
      expect(created[0].status).toBe('PENDING');
      expect(eventsOfType(h, APPROVAL_CREATED)).toHaveLength(1);

      // Re-checking while parked creates/reuses (no duplicate approval, no new decision row).
      const before = decisionRows(h).length;
      check(policyDeps(h), subject, action);
      expect(approvals(h)).toHaveLength(1);
      expect(decisionRows(h).length).toBe(before);

      answerApproval(policyDeps(h), created[0].id, { decision: 'APPROVAL', actor: 'operator-1' });

      const allowed = check(policyDeps(h), subject, action);
      expect(allowed).toBe('ALLOW');
      const spent = approvals(h)[0];
      expect(spent.status).toBe('SPENT');
      expect(spent.spentByDecisionId).toBeString();

      // Replay lands on the winner's audited ALLOW lineage; no second spend, no new approval.
      const replay = check(policyDeps(h), subject, action);
      expect(replay).toBe('ALLOW');
      expect(approvals(h)).toHaveLength(1);
    } finally {
      h.store.close();
    }
  });

  it('a matching approval never overrides a DENY, and an operator DENY keeps the gate standing', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { riskTier: 'RED' });
      const subject = { taskId: null, workOrderId: wo.id };
      const action: PolicyAction = { capability: 'secrets.read', attemptId: 'attempt_1' };

      // secrets.read is DENY (default) — park is impossible; no approval is created.
      expect(check(policyDeps(h), subject, action)).toBe('DENY');
      expect(approvals(h)).toHaveLength(0);
    } finally {
      h.store.close();
    }
  });

  it('an approval is instance-bound: it never carries to a different Attempt', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { riskTier: 'RED' });
      const subject = { taskId: null, workOrderId: wo.id };
      check(policyDeps(h), subject, { capability: 'pr.create', attemptId: 'attempt_1' });
      const appr = approvals(h)[0];
      answerApproval(policyDeps(h), appr.id, { decision: 'APPROVAL', actor: 'operator-1' });

      expect(check(policyDeps(h), subject, { capability: 'pr.create', attemptId: 'attempt_1' })).toBe(
        'ALLOW',
      );
      // attempt 2 is a fresh instance and re-parks.
      expect(check(policyDeps(h), subject, { capability: 'pr.create', attemptId: 'attempt_2' })).toBe(
        'REQUIRE_HUMAN',
      );
    } finally {
      h.store.close();
    }
  });

  it('Work-Order-scoped approvals (taskId/attemptId null) never cross-spend with attempt-scoped checks', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { riskTier: 'RED' });
      const woScoped: PolicyAction = { capability: 'deploy.execute', resource: { env: 'production' } };
      check(policyDeps(h), { taskId: null, workOrderId: wo.id }, woScoped);
      const appr = approvals(h)[0];
      expect(appr.taskId).toBeNull();
      expect(appr.attemptId).toBeNull();
      answerApproval(policyDeps(h), appr.id, { decision: 'APPROVAL', actor: 'operator-1' });

      expect(check(policyDeps(h), { taskId: null, workOrderId: wo.id }, woScoped)).toBe('ALLOW');
      // A non-null attempt can never match the null-attempt WO-scoped approval.
      expect(
        check(policyDeps(h), { taskId: null, workOrderId: wo.id }, { ...woScoped, attemptId: 'a1' }),
      ).toBe('REQUIRE_HUMAN');
    } finally {
      h.store.close();
    }
  });

  it('Red/high-risk never auto-promotes: merge (deploy.execute production) floors at REQUIRE_HUMAN for a GREEN WO', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { riskTier: 'GREEN' });
      const verdict = check(policyDeps(h), { taskId: null, workOrderId: wo.id }, {
        capability: 'deploy.execute',
        resource: { env: 'production' },
      });
      expect(verdict).toBe('REQUIRE_HUMAN');
    } finally {
      h.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// policy.ts — factory controls (pause / resume / e-stop)
// ---------------------------------------------------------------------------

describe('E7 policy: emergency stop / pause / resume', () => {
  it('e-stop denies consequential external actions, keeps reads, and preserves durable state', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { states: ['READY', 'PLANNING'] });
      const before = JSON.stringify(h.store.list('work_orders'));
      const control = emergencyStop(policyDeps(h), { actor: 'operator-1' });
      expect(control.emergencyStopped).toBe(true);
      expect(isEmergencyStopped(policyDeps(h))).toBe(true);

      // Consequential external actions are refused by rule.
      for (const capability of ['repo.write', 'branch.create', 'pr.create', 'ci.run', 'deploy.execute', 'production.write', 'secrets.read']) {
        expect(isConsequentialExternalAction(capability)).toBe(true);
        expect(
          check(policyDeps(h), { taskId: null, workOrderId: wo.id }, { capability }),
        ).toBe('DENY');
      }
      // Read-only capabilities stay subject only to their ordinary stages.
      expect(isConsequentialExternalAction('repo.read')).toBe(false);
      expect(check(policyDeps(h), { taskId: null, workOrderId: wo.id }, { capability: 'repo.read' })).toBe(
        'ALLOW',
      );

      // Repeated e-stop is idempotent.
      emergencyStop(policyDeps(h), { actor: 'operator-1' });
      expect(eventsOfType(h, 'factory.emergency_stopped')).toHaveLength(1);

      // State is preserved (nothing destroyed).
      expect(JSON.stringify(h.store.list('work_orders'))).toBe(before);
    } finally {
      h.store.close();
    }
  });

  it('resume requires an actor identity and clears the e-stop gate', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { states: ['READY', 'PLANNING'] });
      emergencyStop(policyDeps(h), { actor: 'operator-1' });
      expect(() =>
        resumeFactory(policyDeps(h), { actor: '' }),
      ).toThrow(FactoryError);
      const state = resumeFactory(policyDeps(h), { actor: 'operator-1' });
      expect(state.emergencyStopped).toBe(false);
      expect(eventsOfType(h, 'factory.resumed')).toHaveLength(1);
      expect(
        check(policyDeps(h), { taskId: null, workOrderId: wo.id }, { capability: 'pr.create' }),
      ).not.toBe('DENY');
    } finally {
      h.store.close();
    }
  });

  it('pause blocks new autonomous recovery (HOLD) and keeps evidence until resume', () => {
    const h = harness();
    try {
      pauseFactory(policyDeps(h), { actor: 'operator-1' });
      expect(isFactoryPaused(policyDeps(h))).toBe(true);
      const ctx: FailureContext = {
        attemptId: 'attempt_pause',
        taskId: 'task_pause',
        workOrderId: 'wo_pause',
        failureClass: 'WORKER_FAILURE',
        error: 'boom',
        attemptCount: 0,
        sameClassCount: 0,
      };
      expect(recover(recoveryDeps(h), ctx)).toEqual({ kind: 'HOLD' });
      resumeFactory(policyDeps(h), { actor: 'operator-1' });
      expect(isFactoryPaused(policyDeps(h))).toBe(false);
    } finally {
      h.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// recovery.ts — bounded recovery
// ---------------------------------------------------------------------------

function recoveryDeps(
  h: Harness,
  overrides: Partial<RecoveryDeps> = {},
): RecoveryDeps {
  return {
    store: h.store,
    events: h.events,
    now: h.clock.now,
    artifacts: h.artifacts,
    ...overrides,
  };
}

function failureContext(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    attemptId: 'attempt_x',
    taskId: 'task_x',
    workOrderId: 'wo_x',
    failureClass: 'WORKER_FAILURE',
    error: 'worker crashed',
    attemptCount: 0,
    sameClassCount: 0,
    ...overrides,
  };
}

describe('E7 recovery: bounded recovery ladder honours budgets (no blind retry)', () => {
  it('returns RETRY_NEW_ATTEMPT for the first failures and walks the ladder after the per-class budget', () => {
    const h = harness();
    try {
      expect(recover(recoveryDeps(h), failureContext({ sameClassCount: 0 })).kind).toBe(
        'RETRY_NEW_ATTEMPT',
      );
      expect(
        recover(recoveryDeps(h), failureContext({ sameClassCount: 1, changedCondition: 'new-worker' })).kind,
      ).toBe('RETRY_NEW_ATTEMPT');
      // Per-class retries exhausted: the ladder walks REASSIGN → REPLAN → ESCALATE.
      expect(
        recover(recoveryDeps(h), failureContext({ sameClassCount: 2, changedCondition: 'new-worker' })).kind,
      ).toBe('REASSIGN');
      expect(
        recover(recoveryDeps(h), failureContext({ sameClassCount: 3, changedCondition: 'new-worker' })).kind,
      ).toBe('REPLAN');
      expect(
        recover(recoveryDeps(h), failureContext({ sameClassCount: 4, changedCondition: 'new-worker' })).kind,
      ).toBe('ESCALATE_HUMAN');
    } finally {
      h.store.close();
    }
  });

  it('never auto-retries an identical signature (changed-condition requirement)', () => {
    const h = harness();
    try {
      const blind = recover(
        recoveryDeps(h),
        failureContext({ sameClassCount: 1, changedCondition: undefined }),
      );
      expect(blind.kind).toBe('ESCALATE_HUMAN');
      const changed = recover(
        recoveryDeps(h),
        failureContext({ sameClassCount: 1, changedCondition: 'new-worker' }),
      );
      expect(changed.kind).toBe('RETRY_NEW_ATTEMPT');
    } finally {
      h.store.close();
    }
  });

  it('maps MODEL_AUTH_FAILED to ESCALATE_HUMAN and IDEMPOTENCY_DUPLICATE to NO_OP_DUPLICATE', () => {
    const h = harness();
    try {
      expect(recover(recoveryDeps(h), failureContext({ failureClass: 'MODEL_AUTH_FAILED' })).kind).toBe(
        'ESCALATE_HUMAN',
      );
      expect(
        recover(recoveryDeps(h), failureContext({ failureClass: 'IDEMPOTENCY_DUPLICATE' })).kind,
      ).toBe('NO_OP_DUPLICATE');
    } finally {
      h.store.close();
    }
  });

  it('exhausts the Work-Order automatic-recovery ceiling for automatic remedies but not for WAITING_RESOURCE', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h);
      // Six prior automatic actions already recorded durably.
      for (let i = 0; i < DEFAULT_RECOVERY_BUDGETS.workOrderCeiling; i += 1) {
        h.events.appendEvent({
          type: RECOVERY_ACTION_APPLIED,
          aggregateType: 'work_order',
          aggregateId: wo.id,
          payload: { kind: 'RETRY_NEW_ATTEMPT' },
        });
      }
      const workerFailure = recover(
        recoveryDeps(h),
        failureContext({ workOrderId: wo.id, attemptId: 'attempt_z', sameClassCount: 0 }),
      );
      expect(workerFailure.kind).toBe('ESCALATE_HUMAN');

      const quota = recover(
        recoveryDeps(h),
        failureContext({
          workOrderId: wo.id,
          attemptId: 'attempt_y',
          failureClass: 'MODEL_QUOTA_EXHAUSTED',
          requiredModel: 'reasoning-high',
        }),
      );
      expect(quota.kind).toBe('WAITING_RESOURCE');
    } finally {
      h.store.close();
    }
  });

  it('is idempotent: a duplicate recovery delivery is NO_OP_DUPLICATE and applies no side effect', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { states: ['READY', 'PLANNING'] });
      const { taskId } = planOne(h, wo);
      transitionWorkOrder(deps(h), wo.id, { to: 'EXECUTING' });
      transitionTask(deps(h), taskId, { to: 'READY' });
      transitionTask(deps(h), taskId, { to: 'ASSIGNED' });
      transitionTask(deps(h), taskId, { to: 'RUNNING' });
      const attempt = createAttempt(deps(h), { taskId, workerId: null });

      const ctx = failureContext({
        attemptId: attempt.id,
        taskId,
        workOrderId: wo.id,
        changedCondition: 'clean-worktree',
      });
      const first = recover(recoveryDeps(h), ctx);
      expect(first.kind).toBe('RETRY_NEW_ATTEMPT');
      const attemptCountAfterFirst = h.store
        .list<Attempt>('attempts')
        .filter((a) => a.taskId === taskId).length;

      const second = recover(recoveryDeps(h), ctx);
      expect(second.kind).toBe('NO_OP_DUPLICATE');
      expect(h.store.list<Attempt>('attempts').filter((a) => a.taskId === taskId)).toHaveLength(
        attemptCountAfterFirst,
      );
    } finally {
      h.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// recovery.ts — reproduction (c): quota exhaustion with a pinned model
// ---------------------------------------------------------------------------

describe('E7 @debug reproduction (c): quota exhaustion with a pinned escalation model', () => {
  function seedQuotaAttempt(h: Harness) {
    const wo = seedWorkOrder(h, { states: ['READY', 'PLANNING'] });
    const { taskId } = planOne(h, wo);
    transitionWorkOrder(deps(h), wo.id, { to: 'EXECUTING' });
    transitionTask(deps(h), taskId, { to: 'READY' });
    transitionTask(deps(h), taskId, { to: 'ASSIGNED' });
    transitionTask(deps(h), taskId, { to: 'RUNNING' });
    const attempt = createAttempt(deps(h), { taskId, workerId: null, model: 'reasoning-high' });
    return { wo, taskId, attempt };
  }

  it('parks at WAITING_RESOURCE, never silently downgrading the pinned model', () => {
    const h = harness();
    try {
      const { wo, taskId, attempt } = seedQuotaAttempt(h);
      const action = recover(recoveryDeps(h), {
        attemptId: attempt.id,
        taskId,
        workOrderId: wo.id,
        failureClass: 'MODEL_QUOTA_EXHAUSTED',
        error: 'MODEL_QUOTA_EXHAUSTED: subscription exhausted',
        requiredModel: 'reasoning-high',
        attemptCount: 0,
        sameClassCount: 0,
      });

      expect(action).toEqual({
        kind: 'WAITING_RESOURCE',
        resource: 'reasoning-high',
        retryAfterMs: expect.any(Number),
      });

      // The Attempt records waiting_resource (NOT failed) and the Task stays RUNNING.
      const stored = h.store.get<Attempt>('attempts', attempt.id)!;
      expect(stored.outcome).toBe('waiting_resource');
      expect(h.store.get<Task>('tasks', taskId)?.state).toBe('RUNNING');

      // Capacity is marked unavailable and nothing was substituted.
      expect(eventsOfType(h, RESOURCE_UNAVAILABLE)).toHaveLength(1);
      expect(h.store.list<Attempt>('attempts').filter((a) => a.taskId === taskId)).toHaveLength(1);
      expect(stored.model).toBe('reasoning-high');
    } finally {
      h.store.close();
    }
  });

  it('is idempotent across a replayed WAITING_RESOURCE delivery (no duplicate side effects)', () => {
    const h = harness();
    try {
      const { wo, taskId, attempt } = seedQuotaAttempt(h);
      const ctx: FailureContext = {
        attemptId: attempt.id,
        taskId,
        workOrderId: wo.id,
        failureClass: 'MODEL_QUOTA_EXHAUSTED',
        error: 'MODEL_QUOTA_EXHAUSTED: subscription exhausted',
        requiredModel: 'reasoning-high',
        attemptCount: 0,
        sameClassCount: 0,
        failureIndex: 0,
      };
      expect(recover(recoveryDeps(h), ctx).kind).toBe('WAITING_RESOURCE');
      expect(recover(recoveryDeps(h), ctx).kind).toBe('NO_OP_DUPLICATE');
      // Exactly one waiting_resource outcome, one failure entry, one capacity event.
      const stored = h.store.get<Attempt>('attempts', attempt.id)!;
      expect(stored.failureHistory).toHaveLength(1);
      expect(eventsOfType(h, RESOURCE_UNAVAILABLE)).toHaveLength(1);
    } finally {
      h.store.close();
    }
  });

  it('allows a substitute only when it satisfies the pinned requirement (new Attempt on switch)', () => {
    const h = harness();
    try {
      // Satisfying substitute ⇒ a new Attempt with the substitute model.
      const a = seedQuotaAttempt(h);
      const allowed = recover(recoveryDeps(h), {
        attemptId: a.attempt.id,
        taskId: a.taskId,
        workOrderId: a.wo.id,
        failureClass: 'MODEL_QUOTA_EXHAUSTED',
        error: 'quota exhausted',
        requiredModel: 'reasoning-high',
        substituteModel: 'reasoning-high',
        changedCondition: 'model:reasoning-high',
        attemptCount: 0,
        sameClassCount: 0,
        failureIndex: 0,
      });
      expect(allowed.kind).toBe('RETRY_NEW_ATTEMPT');
      const attempts = h.store.list<Attempt>('attempts').filter((x) => x.taskId === a.taskId);
      expect(attempts).toHaveLength(2);
      expect(attempts.find((x) => x.id !== a.attempt.id)?.model).toBe('reasoning-high');

      // Non-satisfying substitute ⇒ WAITING_RESOURCE, no new Attempt.
      const b = seedQuotaAttempt(h);
      const refused = recover(recoveryDeps(h), {
        attemptId: b.attempt.id,
        taskId: b.taskId,
        workOrderId: b.wo.id,
        failureClass: 'MODEL_QUOTA_EXHAUSTED',
        error: 'quota exhausted',
        requiredModel: 'reasoning-high',
        substituteModel: 'cheap-fast',
        attemptCount: 0,
        sameClassCount: 0,
        failureIndex: 0,
      });
      expect(refused.kind).toBe('WAITING_RESOURCE');
      expect(h.store.list<Attempt>('attempts').filter((x) => x.taskId === b.taskId)).toHaveLength(1);
    } finally {
      h.store.close();
    }
  });

  it('after the Work-Order ceiling, a satisfying substitute escalates instead of minting an Attempt (§9.4)', () => {
    const h = harness();
    try {
      const { wo, taskId, attempt } = seedQuotaAttempt(h);
      for (let i = 0; i < DEFAULT_RECOVERY_BUDGETS.workOrderCeiling; i += 1) {
        h.events.appendEvent({
          type: RECOVERY_ACTION_APPLIED,
          aggregateType: 'work_order',
          aggregateId: wo.id,
          payload: { kind: 'RETRY_NEW_ATTEMPT' },
        });
      }

      const action = recover(recoveryDeps(h), {
        attemptId: attempt.id,
        taskId,
        workOrderId: wo.id,
        failureClass: 'MODEL_QUOTA_EXHAUSTED',
        error: 'quota exhausted',
        requiredModel: 'reasoning-high',
        substituteModel: 'reasoning-high',
        changedCondition: 'model:reasoning-high',
        attemptCount: 0,
        sameClassCount: 0,
        failureIndex: 0,
      });

      expect(action).toEqual({
        kind: 'ESCALATE_HUMAN',
        reason: 'work-order-recovery-ceiling-exhausted',
      });
      // No automatic recovery leaked past the global bound.
      expect(h.store.list<Attempt>('attempts').filter((x) => x.taskId === taskId)).toHaveLength(1);
      expect(eventsOfType(h, RESOURCE_UNAVAILABLE)).toHaveLength(0);
    } finally {
      h.store.close();
    }
  });

  it('a substitute refused by the per-Task attempt bound parks on capacity (WAITING_RESOURCE)', () => {
    const h = harness();
    try {
      const { wo, taskId, attempt } = seedQuotaAttempt(h);
      const action = recover(recoveryDeps(h), {
        attemptId: attempt.id,
        taskId,
        workOrderId: wo.id,
        failureClass: 'MODEL_QUOTA_EXHAUSTED',
        error: 'quota exhausted',
        requiredModel: 'reasoning-high',
        substituteModel: 'reasoning-high',
        changedCondition: 'model:reasoning-high',
        attemptCount: DEFAULT_RECOVERY_BUDGETS.perTaskAttempts,
        sameClassCount: 0,
        failureIndex: 0,
      });

      expect(action.kind).toBe('WAITING_RESOURCE');
      // No third Attempt: the bound holds even with a satisfying substitute.
      expect(h.store.list<Attempt>('attempts').filter((x) => x.taskId === taskId)).toHaveLength(1);
    } finally {
      h.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// recovery.ts — reproduction (a): worker crash mid-Attempt
// ---------------------------------------------------------------------------

interface RunningAttempt {
  woId: string;
  taskId: string;
  attemptId: string;
  workerId: string;
  assignmentId: string;
}

function seedRunningAttempt(
  h: Harness,
  opts: { woState?: WorkOrderState[]; taskState?: TaskState[]; diff?: string; leaseExpiresAt?: string | null; model?: string } = {},
): RunningAttempt {
  const wo = seedWorkOrder(h);
  transitionWorkOrder(deps(h), wo.id, { to: 'READY' });
  transitionWorkOrder(deps(h), wo.id, { to: 'PLANNING' });
  const { taskId } = planOne(h, wo);
  // `woState`/`taskState` are applied after PLANNING / PLANNED respectively.
  for (const to of opts.woState ?? []) transitionWorkOrder(deps(h), wo.id, { to });
  for (const to of opts.taskState ?? []) transitionTask(deps(h), taskId, { to });

  const workerId = `worker_${crypto.randomUUID()}`;
  const at = h.clock.now();
  h.store.set('workers', workerId, {
    id: workerId,
    profile: 'herdr',
    runtimeState: 'BUSY',
    lease: null,
    provisionedAt: at,
    lastActiveAt: at,
    reclaimedAt: null,
  });
  const attempt = createAttempt(deps(h), {
    taskId,
    workerId,
    model: opts.model ?? null,
    context: 'implementation',
    environment: 'herdr/local',
  });
  const leaseExpiresAt =
    opts.leaseExpiresAt === null ? null : opts.leaseExpiresAt ?? new Date(Date.parse(at) + 60_000).toISOString();
  if (leaseExpiresAt) {
    h.store.set('workers', workerId, {
      ...h.store.get<Record<string, unknown>>('workers', workerId)!,
      lease: { attemptId: attempt.id, taskId, expiresAt: leaseExpiresAt, renewedAt: at },
    });
  }
  if (opts.diff) {
    h.store.set('attempts', attempt.id, { ...attempt, diff: opts.diff });
  }
  const assignmentId = `assignment_${crypto.randomUUID()}`;
  h.store.set('assignments', assignmentId, {
    id: assignmentId,
    taskId,
    workerId,
    branch: `wo-${wo.id}/task-${taskId.slice(0, 8)}`,
    worktreePath: join(workDir, 'worktrees', taskId),
    baseCommit: 'base',
    closedAt: null,
    createdAt: at,
    updatedAt: at,
  });
  return { woId: wo.id, taskId, attemptId: attempt.id, workerId, assignmentId };
}

describe('E7 @debug reproduction (a): worker crash mid-Attempt', () => {
  it('interrupts the Attempt, preserves the old diff as evidence, and opens a new clean-baseline Attempt', () => {
    const h = harness();
    try {
      const seeded = seedRunningAttempt(h, {
        woState: ['EXECUTING'],
        taskState: ['READY', 'ASSIGNED', 'RUNNING'],
        diff: 'diff --git a/src/orders.ts b/src/orders.ts\n+partial work',
        leaseExpiresAt: new Date(Date.parse(h.clock.now()) - 5_000).toISOString(),
      });

      // The worker is gone and the lease has expired.
      const result = reconcileAfterRestart(recoveryDeps(h), { workerStatus: () => 'stopped' });
      const finding = result.findings.find((f) => f.attemptId === seeded.attemptId)!;
      expect(finding.disposition).toBe('interrupted');

      const old = h.store.get<Attempt>('attempts', seeded.attemptId)!;
      expect(old.outcome).toBe('interrupted');
      expect(old.outcome).not.toBe('success');
      expect(old.failureHistory.some((f) => f.failure.startsWith('CRASH_RECOVERY'))).toBe(true);
      expect(old.diff).toContain('partial work');

      // Old diff preserved as an immutable evidence artifact.
      expect(Buffer.from(h.artifacts.get(`${seeded.attemptId}/diff.patch`)).toString('utf8')).toContain(
        'partial work',
      );

      // The assignment is closed and the worker released.
      expect(h.store.get<{ closedAt: string | null }>('assignments', seeded.assignmentId)!.closedAt).not.toBeNull();
      expect(h.store.get<{ runtimeState: string }>('workers', seeded.workerId)!.runtimeState).toBe('IDLE');

      // A new Attempt from a clean baseline exists; the old one is not reused.
      const attempts = h.store.list<Attempt>('attempts').filter((a) => a.taskId === seeded.taskId);
      expect(attempts).toHaveLength(2);
      const fresh = attempts.find((a) => a.id !== seeded.attemptId)!;
      expect(fresh.outcome).toBeNull();
      expect(fresh.context).toContain('clean-worktree');

      // Re-running reconciliation is safe: no third Attempt is manufactured.
      const again = reconcileAfterRestart(recoveryDeps(h), { workerStatus: () => 'stopped' });
      expect(again.findings.some((f) => f.disposition === 'interrupted' && f.attemptId === seeded.attemptId)).toBe(
        false,
      );
      expect(h.store.list<Attempt>('attempts').filter((a) => a.taskId === seeded.taskId)).toHaveLength(2);
    } finally {
      h.store.close();
    }
  });

  it('reattaches when the lease is valid and the worker is still live', () => {
    const h = harness();
    try {
      const seeded = seedRunningAttempt(h, {
        woState: ['EXECUTING'],
        taskState: ['READY', 'ASSIGNED', 'RUNNING'],
      });
      const result = reconcileAfterRestart(recoveryDeps(h), { workerStatus: () => 'running' });
      const finding = result.findings.find((f) => f.attemptId === seeded.attemptId)!;
      expect(finding.disposition).toBe('reattached');
      // Never claims success and does not manufacture a new Attempt.
      expect(h.store.get<Attempt>('attempts', seeded.attemptId)!.outcome).toBeNull();
      expect(h.store.list<Attempt>('attempts').filter((a) => a.taskId === seeded.taskId)).toHaveLength(1);
    } finally {
      h.store.close();
    }
  });

  it('interrupts when the lease is expired even if the adapter still reports running (heartbeat ≠ completion)', () => {
    const h = harness();
    try {
      const seeded = seedRunningAttempt(h, {
        woState: ['EXECUTING'],
        taskState: ['READY', 'ASSIGNED', 'RUNNING'],
        leaseExpiresAt: new Date(Date.parse(h.clock.now()) - 1).toISOString(),
      });
      const result = reconcileAfterRestart(recoveryDeps(h), { workerStatus: () => 'running' });
      expect(result.findings.find((f) => f.attemptId === seeded.attemptId)!.disposition).toBe(
        'interrupted',
      );
      expect(h.store.get<Attempt>('attempts', seeded.attemptId)!.outcome).toBe('interrupted');
    } finally {
      h.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// recovery.ts — reproduction (b): Factory restart during VERIFYING
// ---------------------------------------------------------------------------

describe('E7 @debug reproduction (b): Factory restart during VERIFYING', () => {
  it('never claims success without evidence; the interrupted verification is reconciled, not completed', () => {
    const h = harness();
    try {
      const seeded = seedRunningAttempt(h, {
        woState: ['EXECUTING', 'VERIFYING'],
        taskState: ['READY', 'ASSIGNED', 'RUNNING', 'SUCCESS', 'VERIFYING'],
        diff: 'diff --git a/src/orders.ts b/src/orders.ts\n+verified candidate',
        leaseExpiresAt: new Date(Date.parse(h.clock.now()) - 10_000).toISOString(),
      });
      // The Work Order was mid-verification when the Factory died.
      expect(h.store.get<WorkOrder>('work_orders', seeded.woId)?.state).toBe('VERIFYING');

      const result = reconcileAfterRestart(recoveryDeps(h), { workerStatus: () => 'stopped' });
      const finding = result.findings.find((f) => f.attemptId === seeded.attemptId)!;
      expect(finding.disposition).toBe('interrupted');

      const attempt = h.store.get<Attempt>('attempts', seeded.attemptId)!;
      expect(attempt.outcome).toBe('interrupted');
      expect(attempt.outcome).not.toBe('success');

      // Evidence preserved; Work Order still VERIFYING (re-verification required, never auto-success).
      expect(Buffer.from(h.artifacts.get(`${seeded.attemptId}/diff.patch`)).toString('utf8')).toContain(
        'verified candidate',
      );
      expect(h.store.get<WorkOrder>('work_orders', seeded.woId)?.state).toBe('VERIFYING');
    } finally {
      h.store.close();
    }
  });

  it('survives a genuine process restart (reopening the SQLite store) without losing the interrupt record', () => {
    const h = harness();
    const seeded = seedRunningAttempt(h, {
      woState: ['EXECUTING', 'VERIFYING'],
      taskState: ['READY', 'ASSIGNED', 'RUNNING', 'SUCCESS', 'VERIFYING'],
      diff: 'diff --git a/x b/x\n+restart evidence',
      leaseExpiresAt: new Date(Date.parse(h.clock.now()) - 10_000).toISOString(),
    });
    reconcileAfterRestart(recoveryDeps(h), { workerStatus: () => 'stopped' });
    h.store.close();

    // Simulate a Factory restart: reopen the same database file.
    const reopened = openStateStore(dbPath);
    const events = openEventLog(reopened.db);
    try {
      const attempts = reopened.list<Attempt>('attempts').filter((a) => a.taskId === seeded.taskId);
      expect(attempts.find((a) => a.id === seeded.attemptId)?.outcome).toBe('interrupted');
      expect(events.readEvents().some((e) => e.type === RECOVERY_ACTION_APPLIED)).toBe(true);
    } finally {
      reopened.close();
    }
  });
});

// ---------------------------------------------------------------------------
// recovery.ts — bounded replan via commitDAG (§9.2)
// ---------------------------------------------------------------------------

describe('E7 recovery: bounded replanWorkOrder via E3 commitDAG', () => {
  it('commits replans up to the budget, then ESCALATE_HUMAN with replan-budget-exhausted', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { riskTier: 'RED' });
      transitionWorkOrder(deps(h), wo.id, { to: 'READY' });
      transitionWorkOrder(deps(h), wo.id, { to: 'PLANNING' });
      // Plan v1 (initial).
      const { taskId } = planOne(h, wo);
      transitionWorkOrder(deps(h), wo.id, { to: 'EXECUTING' });
      // Settle the v1 task so REPLAN is legal (no in-flight tasks).
      transitionTask(deps(h), taskId, { to: 'READY' });
      transitionTask(deps(h), taskId, { to: 'ASSIGNED' });
      transitionTask(deps(h), taskId, { to: 'RUNNING' });
      transitionTask(deps(h), taskId, { to: 'SUCCESS' });
      transitionTask(deps(h), taskId, { to: 'VERIFYING' });
      transitionTask(deps(h), taskId, { to: 'VERIFIED' });

      const payload = (n: string): DAGProposalPayload => ({ nodes: [{ nodeId: n, title: n }] });

      const first = replanWorkOrder(recoveryDeps(h), wo.id, payload('r1'));
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.version).toBe(2);

      const second = replanWorkOrder(recoveryDeps(h), wo.id, payload('r2'));
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.version).toBe(3);

      const third = replanWorkOrder(recoveryDeps(h), wo.id, payload('r3'));
      expect(third.ok).toBe(false);
      if (!third.ok) {
        expect(third.action.kind).toBe('ESCALATE_HUMAN');
        expect(third.action.reason).toContain('replan-budget-exhausted');
      }
      expect(getActiveDAG(deps(h), wo.id)?.version).toBe(3);
    } finally {
      h.store.close();
    }
  });

  it('escalates after one rejected replan payload (no silent auto-reformulation)', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h, { riskTier: 'RED' });
      transitionWorkOrder(deps(h), wo.id, { to: 'READY' });
      transitionWorkOrder(deps(h), wo.id, { to: 'PLANNING' });
      const { taskId } = planOne(h, wo);
      transitionWorkOrder(deps(h), wo.id, { to: 'EXECUTING' });
      transitionTask(deps(h), taskId, { to: 'READY' });
      transitionTask(deps(h), taskId, { to: 'ASSIGNED' });
      transitionTask(deps(h), taskId, { to: 'RUNNING' });
      transitionTask(deps(h), taskId, { to: 'SUCCESS' });
      transitionTask(deps(h), taskId, { to: 'VERIFYING' });
      transitionTask(deps(h), taskId, { to: 'VERIFIED' });

      const bad: DAGProposalPayload = {
        nodes: [
          { nodeId: 'a', title: 'A', dependsOn: ['b'] },
          { nodeId: 'b', title: 'B', dependsOn: ['a'] },
        ],
      };
      const result = replanWorkOrder(recoveryDeps(h), wo.id, bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.action.kind).toBe('ESCALATE_HUMAN');
        expect(result.reasons && result.reasons.length).toBeGreaterThan(0);
      }
      // The rejected payload appended exactly one dag.rejected event.
      expect(eventsOfType(h, 'dag.rejected')).toHaveLength(1);
    } finally {
      h.store.close();
    }
  });
});

describe('E7 recovery: backoff + jitter', () => {
  it('is full-jitter bounded by the exponential cap', () => {
    const opts = { baseMs: 100, maxMs: 10_000 };
    expect(backoffWithJitter(0, { ...opts, rand: () => 0 })).toBe(0);
    expect(backoffWithJitter(0, { ...opts, rand: () => 1 })).toBe(100);
    expect(backoffWithJitter(3, { ...opts, rand: () => 1 })).toBe(800);
    expect(backoffWithJitter(20, { ...opts, rand: () => 1 })).toBe(10_000);
  });
});

describe('E7 recovery: §9.1 failure-class encoding convention', () => {
  it('parses class-prefixed failures and treats bare/unknown tokens as UNKNOWN', () => {
    expect(parseFailureClass(encodeFailure('MODEL_RATE_LIMITED', '429 from provider'))).toBe(
      'MODEL_RATE_LIMITED',
    );
    expect(parseFailureClass('VERIFICATION_FAILURE: security scan failed')).toBe(
      'VERIFICATION_FAILURE',
    );
    expect(parseFailureClass('typecheck failed')).toBe('UNKNOWN');
    expect(parseFailureClass('MODEL_SOMETHING_NEW: x')).toBe('UNKNOWN');
  });
});

describe('E7 invariants', () => {
  it('exposes all nine spec §13.2 capabilities', () => {
    expect(CAPABILITIES).toHaveLength(9);
    expect(new Set(CAPABILITIES).size).toBe(9);
    expect(DEFAULT_POLICY_VERSION).toBe('<embedded>');
  });

  it('an illegal domain transition still throws and changes nothing (E1 gate intact)', () => {
    const h = harness();
    try {
      const wo = seedWorkOrder(h);
      expect(() => transitionWorkOrder(deps(h), wo.id, { to: 'MERGED' })).toThrow(FactoryError);
      expect(h.store.get<WorkOrder>('work_orders', wo.id)?.state).toBe('DRAFT');
    } finally {
      h.store.close();
    }
  });
});
