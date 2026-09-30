import { FactoryError } from '../domain/errors';
import type { WorkOrder } from '../domain/workOrder';
import type { EventLog } from '../events/log';
import type { PolicyVerdict } from '../scheduler/scheduler';
import type { StateStore } from '../state/store';
import {
  classifyRisk,
  escalateFor,
  matchesAnyGlob,
  ratchetTier,
  tierFloor,
  tighterTier,
  type Sensitivity,
} from './risk';

/**
 * E7 policy engine (design `architecture/policy-and-risk-model.md`; ADR 14).
 *
 * The engine is `evaluate()` (pure, §5 stages 1–4) + `check()` (durable, §5.1
 * write rule). Policy is monotonic-narrowing: per capability the effective
 * decision is the `tighter` fold Org → Project → WO → Task, silence inherits,
 * scopes intersect, and deployment ceilings cap every level. A child can never
 * widen a parent. `ALLOW` is the only verdict that lets E3 assign or E6 act.
 *
 * `recover()`/`emergencyStop()` semantics the engine honours live in
 * `./risk.ts` (tiers) and `../recovery/recovery.ts` (bounded recovery); the
 * factory control state and the e-stop gate live here.
 */

export type { PolicyVerdict };

export const CAPABILITIES = [
  'repo.read',
  'repo.write',
  'branch.create',
  'pr.create',
  'ci.run',
  'production.read',
  'production.write',
  'deploy.execute',
  'secrets.read',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Policy version stamped on every decision when the embedded defaults are used. */
export const DEFAULT_POLICY_VERSION = '<embedded>';

export const POLICY_DECISION_RECORDED = 'policy.decision';
export const APPROVAL_CREATED = 'interaction.approval_created';
export const APPROVAL_ANSWERED = 'interaction.approval_answered';
export const APPROVAL_SPENT = 'interaction.approval_spent';

export const FACTORY_EMERGENCY_STOPPED = 'factory.emergency_stopped';
export const FACTORY_PAUSED = 'factory.paused';
export const FACTORY_RESUMED = 'factory.resumed';

const SENSITIVITY: Record<Capability, Sensitivity> = {
  'repo.read': 'low',
  'repo.write': 'medium',
  'branch.create': 'low',
  'pr.create': 'medium',
  'ci.run': 'medium',
  'production.read': 'high',
  'production.write': 'high',
  'deploy.execute': 'high',
  'secrets.read': 'high',
};

export type Env = 'staging' | 'production';
export type DataClass = 'synthetic' | 'customer-data';

/** The scope qualifiers a grant may carry (design §3.5). */
export interface PolicyScope {
  /** Include path globs; a resource must match at least one when present. */
  paths?: string[];
  /** Exclude path globs; a resource matching any is outside the grant. */
  excludePaths?: string[];
  branchPattern?: string;
  env?: Env;
  dataClass?: DataClass;
}

/** The action binding a decision is evaluated for. */
export interface PolicyResource {
  path?: string;
  branch?: string;
  env?: Env;
  dataClass?: DataClass;
}

export interface CapabilityRule {
  decision: PolicyVerdict;
  scope?: PolicyScope;
  ruleId?: string;
}

export interface PolicyLevel {
  capabilities: Partial<Record<Capability, CapabilityRule[]>>;
}

export interface PolicyDocument {
  version: string;
  organization: PolicyLevel;
  /** Per-repository policy, keyed by the Work Order `repository` name. */
  projects?: Record<string, PolicyLevel>;
}

/** The resolved Org → Project → WO → Task chain for one Work Order. */
export interface PolicyChain {
  version: string;
  organization: PolicyLevel;
  project?: PolicyLevel;
  workOrder?: PolicyLevel;
  task?: PolicyLevel;
}

export interface TaskRef {
  taskId: string | null;
  workOrderId: string;
}

export interface PolicyAction {
  capability: string;
  resource?: PolicyResource;
  /** The live Attempt this decision binds to (approval instance key). */
  attemptId?: string | null;
}

/** The durable §5.1 decision record. */
export interface PolicyDecisionRecord {
  id: string;
  task: string | null;
  workOrderId: string | null;
  attemptId: string | null;
  action: { capability: string; resource?: PolicyResource };
  risk: 'GREEN' | 'YELLOW' | 'RED';
  decision: PolicyVerdict;
  rules: string[];
  policyVersion: string;
  resolvedBy: 'policy' | 'tier-gate' | 'human-approval' | 'e-stop';
  interactionId?: string;
  createdAt: string;
}

/** The §5.2 approval ledger document (lives in E1's `interactions` collection). */
export interface ApprovalRecord {
  id: string;
  type: 'APPROVAL';
  workOrderId: string;
  taskId: string | null;
  attemptId: string | null;
  binding: { capability: string; resource?: PolicyResource };
  question: string;
  workerId: string | null;
  status: 'PENDING' | 'ANSWERED' | 'SPENT';
  response: null | {
    decision: 'APPROVAL' | 'DENY';
    actor: string;
    answeredAt: string;
    comment?: string;
  };
  spentAt?: string;
  spentByDecisionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Evaluation {
  decision: PolicyVerdict;
  risk: 'GREEN' | 'YELLOW' | 'RED';
  rules: string[];
  resolvedBy: 'policy' | 'tier-gate' | 'human-approval' | 'e-stop';
  policyVersion: string;
  interactionId?: string;
  spentApprovalId?: string;
}

export interface EvaluateInput {
  chain: PolicyChain;
  wo: Pick<WorkOrder, 'riskTier'> & { id?: string };
  action: PolicyAction;
  taskId?: string | null;
  approvals?: readonly ApprovalRecord[];
  emergencyStopped?: boolean;
}

export interface PolicyCheckDeps {
  store: StateStore;
  events: EventLog;
  now?: () => string;
  policy?: PolicyDocument;
}

const VERDICT_RANK: Record<PolicyVerdict, number> = {
  ALLOW: 0,
  REQUIRE_HUMAN: 1,
  DENY: 2,
};

const tighter = (a: PolicyVerdict, b: PolicyVerdict): PolicyVerdict =>
  VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a;

function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** The deployment-fixed ceiling for a capability, bound per matched dimension (§3.3-5). */
export function ceilingFor(capability: Capability, resource?: PolicyResource): PolicyVerdict {
  switch (capability) {
    case 'production.write':
    case 'secrets.read':
      return 'REQUIRE_HUMAN';
    case 'production.read':
      // Ceiling is scoped to `dataClass: customer-data` (§4); synthetic/staging
      // reads keep the default's `ALLOW`. An over-ceiling expression on the
      // customer-data facet is coerced and marked `ceiling-violation`.
      return resource?.dataClass === 'customer-data' ? 'REQUIRE_HUMAN' : 'ALLOW';
    case 'deploy.execute':
      return resource?.env === 'production' ? 'REQUIRE_HUMAN' : 'ALLOW';
    default:
      return 'ALLOW';
  }
}

function defaultRules(capability: Capability): CapabilityRule[] {
  switch (capability) {
    case 'repo.read':
      return [{ decision: 'ALLOW', ruleId: 'org:repo.read' }];
    case 'repo.write':
      return [
        {
          decision: 'ALLOW',
          scope: { branchPattern: 'wo-*/**', excludePaths: ['infra/**'] },
          ruleId: 'org:repo.write',
        },
      ];
    case 'branch.create':
      return [{ decision: 'ALLOW', scope: { branchPattern: 'wo-*/**' }, ruleId: 'org:branch.create' }];
    case 'pr.create':
      return [{ decision: 'ALLOW', ruleId: 'org:pr.create' }];
    case 'ci.run':
      return [{ decision: 'ALLOW', ruleId: 'org:ci.run' }];
    case 'production.read':
      return [
        {
          decision: 'REQUIRE_HUMAN',
          scope: { dataClass: 'customer-data' },
          ruleId: 'org:production.read',
        },
        { decision: 'ALLOW', scope: { dataClass: 'synthetic' }, ruleId: 'org:production.read' },
      ];
    case 'production.write':
      return [{ decision: 'DENY', ruleId: 'org:production.write' }];
    case 'deploy.execute':
      return [
        { decision: 'REQUIRE_HUMAN', scope: { env: 'production' }, ruleId: 'org:deploy.execute' },
        { decision: 'ALLOW', scope: { env: 'staging' }, ruleId: 'org:deploy.execute' },
      ];
    case 'secrets.read':
      return [{ decision: 'DENY', ruleId: 'org:secrets.read' }];
  }
}

/** The embedded v0.1 deployment policy (design §4 + §11). */
export function createDefaultPolicy(): PolicyDocument {
  const capabilities: PolicyLevel['capabilities'] = {};
  for (const capability of CAPABILITIES) capabilities[capability] = defaultRules(capability);
  return { version: DEFAULT_POLICY_VERSION, organization: { capabilities } };
}

/** The root default for a capability when no level on the chain speaks (§3.3-3). */
function baseDecision(capability: Capability, resource?: PolicyResource): PolicyVerdict {
  switch (capability) {
    case 'repo.read':
    case 'pr.create':
    case 'ci.run':
      return 'ALLOW';
    case 'production.read':
      return resource?.dataClass === 'synthetic' ? 'ALLOW' : 'REQUIRE_HUMAN';
    case 'deploy.execute':
      return resource?.env === 'staging' ? 'ALLOW' : 'REQUIRE_HUMAN';
    case 'repo.write':
    case 'branch.create':
    case 'production.write':
    case 'secrets.read':
      return 'DENY';
  }
}

/** Selector dimensions gate whether a rule is about the resource's facet (§3.3-5). */
function selectorsMatch(scope: PolicyScope | undefined, resource?: PolicyResource): boolean {
  if (!scope) return true;
  if (scope.env !== undefined && scope.env !== resource?.env) return false;
  if (scope.dataClass !== undefined && scope.dataClass !== resource?.dataClass) return false;
  return true;
}

/**
 * Set dimensions (paths / excludePaths / branch) must jointly cover the
 * resource, else the rule does not speak to it (§3.3-4/§3.3-5). Fail-closed on
 * a missing binding: a scope that constrains a set dimension can only be
 * satisfied by an action that actually supplies that dimension — an omitted
 * `branch`/`path` cannot silently satisfy a root scope. This is what makes the
 * §4 default `repo.write`/`branch.create` scope (the Factory branch prefix plus
 * an `infra/**` exclusion) resolve `DENY` for a default-branch or
 * otherwise unbound write instead of leaking an `ALLOW` (§5: a capability whose
 * root scope requires a binding resolves restricted rather than guess).
 */
function coversSetDims(scope: PolicyScope | undefined, resource?: PolicyResource): boolean {
  if (!scope) return true;
  if (scope.paths && scope.paths.length > 0) {
    const path = resource?.path;
    if (!path || !matchesAnyGlob(scope.paths, path)) return false;
  }
  if (scope.excludePaths && scope.excludePaths.length > 0) {
    const path = resource?.path;
    // A missing path cannot be proven outside the excluded set: not covered.
    if (!path || matchesAnyGlob(scope.excludePaths, path)) return false;
  }
  if (scope.branchPattern) {
    const branch = resource?.branch;
    if (!branch || !matchesGlobSafe(scope.branchPattern, branch)) return false;
  }
  return true;
}

function matchesGlobSafe(pattern: string, value: string): boolean {
  return matchesAnyGlob([pattern], value);
}

interface ResolvedChain {
  decision: PolicyVerdict;
  rules: string[];
}

/** Fold Org → Project → WO → Task for one (capability, resource) (§3). */
export function resolveChain(
  capability: Capability,
  resource: PolicyResource | undefined,
  chain: PolicyChain,
): ResolvedChain {
  const levels: Array<{ name: string; level: PolicyLevel | undefined }> = [
    { name: 'org', level: chain.organization },
    { name: 'project', level: chain.project },
    { name: 'wo', level: chain.workOrder },
    { name: 'task', level: chain.task },
  ];

  const rules: string[] = [];
  let decision: PolicyVerdict | null = null;
  let covered = true;
  let participated = false;
  const ceiling = ceilingFor(capability, resource);

  for (const { name, level } of levels) {
    const candidates = level?.capabilities[capability];
    if (!candidates || candidates.length === 0) continue;
    const matching = candidates.filter((rule) => selectorsMatch(rule.scope, resource));
    if (matching.length === 0) continue;
    participated = true;

    // Only rules whose set-dims actually cover the resource speak to it (§3.3-4/
    // §3.3-5). Folding every selector-matching rule would let one branch-scoped
    // DENY poison sibling ALLOWs for other branches (e.g. `{ALLOW@wo-*/**,
    // DENY@main}` must not deny a `wo-1/impl` write). A level that speaks (its
    // selectors match) but has no covering rule still fails closed: it grants
    // nothing, so the resource is outside that level's scope.
    const covering = matching.filter((rule) => coversSetDims(rule.scope, resource));
    if (covering.length === 0) {
      covered = false;
      continue;
    }

    let levelDecision: PolicyVerdict | null = null;
    for (const rule of covering) {
      let effective = rule.decision;
      if (VERDICT_RANK[effective] < VERDICT_RANK[ceiling]) {
        effective = ceiling;
        rules.push(`${name}:${capability}@ceiling-violation`);
      }
      levelDecision = levelDecision === null ? effective : tighter(levelDecision, effective);
    }

    if (decision !== null && levelDecision !== null && VERDICT_RANK[levelDecision] < VERDICT_RANK[decision]) {
      rules.push(`${name}:${capability}@widening-attempt`);
    }
    rules.push(`${name}:${capability}:${levelDecision}`);
    decision = decision === null ? levelDecision : tighter(decision, levelDecision!);
  }

  if (!participated) {
    rules.push(`org:${capability}:default`);
    return { decision: baseDecision(capability, resource), rules };
  }
  if (!covered) {
    rules.push(`${capability}@outside-scope`);
    return { decision: 'DENY', rules };
  }
  return { decision: decision ?? baseDecision(capability, resource), rules };
}

function resourceKey(resource?: PolicyResource): string {
  if (!resource) return '';
  const entries = Object.entries(resource)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function bindingsMatch(
  approval: { capability: string; resource?: PolicyResource },
  capability: string,
  resource?: PolicyResource,
): boolean {
  return approval.capability === capability && resourceKey(approval.resource) === resourceKey(resource);
}

function findInstanceApproval(
  approvals: readonly ApprovalRecord[],
  key: { workOrderId: string; taskId: string | null; attemptId: string | null; capability: string; resource?: PolicyResource },
): ApprovalRecord | null {
  return (
    approvals.find(
      (approval) =>
        approval.type === 'APPROVAL' &&
        approval.workOrderId === key.workOrderId &&
        approval.taskId === key.taskId &&
        approval.attemptId === key.attemptId &&
        bindingsMatch(approval.binding, key.capability, key.resource),
    ) ?? null
  );
}

/** The e-stop consequential set rule (§5 stage 1 / §10-3): everything that mutates externally. */
export function isConsequentialExternalAction(capability: string, resource?: PolicyResource): boolean {
  switch (capability) {
    case 'repo.read':
      return false;
    case 'production.read':
      return false;
    case 'repo.write':
      // A worktree write is work, not an external side effect; anything else mutates externally.
      return !(resource?.branch && matchesAnyGlob(['wo-*/**'], resource.branch));
    case 'branch.create':
    case 'pr.create':
    case 'ci.run':
    case 'deploy.execute':
    case 'production.write':
    case 'secrets.read':
      return true;
    default:
      return false;
  }
}

/**
 * `evaluate()` — the pure stage 1–4 pipeline (design §5). No writes. Stage 4 is
 * the single sanctioned relaxation: consuming an unspent, instance-matching
 * operator `APPROVAL` turns a standing `REQUIRE_HUMAN` into `ALLOW` (never a
 * `DENY`).
 */
export function evaluate(input: EvaluateInput): Evaluation {
  const { chain, wo, action } = input;
  const taskId = input.taskId ?? null;
  const attemptId = action.attemptId ?? null;
  const risk = tighterTier(classifyRisk(wo), escalateFor(action.capability, action.resource));
  const rules: string[] = [];
  if (risk !== classifyRisk(wo)) rules.push(`escalateFor:${risk}`);

  if (!isCapability(action.capability)) {
    return {
      decision: 'DENY',
      risk,
      rules: [...rules, 'unknown-capability'],
      resolvedBy: 'policy',
      policyVersion: chain.version,
    };
  }
  const capability = action.capability;

  // Stage 1 — emergency-stop gate.
  if (input.emergencyStopped && isConsequentialExternalAction(capability, action.resource)) {
    rules.push('e-stop');
    return { decision: 'DENY', risk, rules, resolvedBy: 'e-stop', policyVersion: chain.version };
  }

  // Stage 2 — chain resolution.
  const resolved = resolveChain(capability, action.resource, chain);
  rules.push(...resolved.rules);
  let decision = resolved.decision;
  let resolvedBy: Evaluation['resolvedBy'] = 'policy';

  // Stage 3 — tier gate (can only restrict).
  const floor = tierFloor(risk, SENSITIVITY[capability]);
  const gated = tighter(decision, floor);
  if (gated !== decision) {
    rules.push(`tier-gate:${risk}:${SENSITIVITY[capability]}`);
    resolvedBy = 'tier-gate';
  }
  decision = gated;

  // Stage 4 — human-approval consumption.
  if (decision === 'REQUIRE_HUMAN') {
    const match = findInstanceApproval(input.approvals ?? [], {
      workOrderId: wo.id ?? '',
      taskId,
      attemptId,
      capability,
      resource: action.resource,
    });
    if (match && match.response?.decision === 'APPROVAL') {
      if (match.status === 'SPENT') {
        rules.push('human-approval:replay');
        return {
          decision: 'ALLOW',
          risk,
          rules,
          resolvedBy: 'human-approval',
          interactionId: match.id,
          spentApprovalId: match.id,
          policyVersion: chain.version,
        };
      }
      if (match.status === 'ANSWERED') {
        rules.push('human-approval');
        return {
          decision: 'ALLOW',
          risk,
          rules,
          resolvedBy: 'human-approval',
          interactionId: match.id,
          spentApprovalId: match.id,
          policyVersion: chain.version,
        };
      }
    }
  }

  return { decision, risk, rules, resolvedBy, policyVersion: chain.version };
}

// ---------------------------------------------------------------------------
// Durable check() — §5.1 write rule
// ---------------------------------------------------------------------------

function resolveAttemptId(deps: PolicyCheckDeps, taskId: string | null): string | null {
  if (!taskId) return null;
  const attempts = deps.store
    .list<{ id: string; taskId: string; createdAt: string }>('attempts')
    .filter((attempt) => attempt.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return attempts.length > 0 ? attempts[attempts.length - 1].id : null;
}

function findPriorDecision(
  deps: PolicyCheckDeps,
  subject: TaskRef,
  attemptId: string | null,
  action: PolicyAction,
  decision: PolicyVerdict,
): PolicyDecisionRecord | null {
  return (
    deps.store.list<PolicyDecisionRecord>('policy_decisions').find(
      (record) =>
        record.workOrderId === subject.workOrderId &&
        record.task === subject.taskId &&
        record.attemptId === attemptId &&
        record.action.capability === action.capability &&
        resourceKey(record.action.resource) === resourceKey(action.resource) &&
        record.decision === decision,
    ) ?? null
  );
}

function createOrReuseApproval(
  deps: PolicyCheckDeps,
  subject: TaskRef,
  attemptId: string | null,
  action: PolicyAction,
  at: string,
): ApprovalRecord {
  const existing = findInstanceApproval(deps.store.list<ApprovalRecord>('interactions'), {
    workOrderId: subject.workOrderId,
    taskId: subject.taskId,
    attemptId,
    capability: action.capability,
    resource: action.resource,
  });
  if (existing) return existing;

  const approval: ApprovalRecord = {
    id: `appr_${crypto.randomUUID()}`,
    type: 'APPROVAL',
    workOrderId: subject.workOrderId,
    taskId: subject.taskId,
    attemptId,
    binding: { capability: action.capability, resource: action.resource },
    question: `Approve ${action.capability} for work order ${subject.workOrderId}`,
    workerId: null,
    status: 'PENDING',
    response: null,
    createdAt: at,
    updatedAt: at,
  };
  deps.store.set('interactions', approval.id, approval);
  deps.events.appendEvent({
    type: APPROVAL_CREATED,
    aggregateType: 'interaction',
    aggregateId: approval.id,
    payload: { approval },
  });
  return approval;
}

function spendApproval(deps: PolicyCheckDeps, approvalId: string, decisionId: string, at: string): void {
  const approval = deps.store.get<ApprovalRecord>('interactions', approvalId);
  if (!approval || approval.status === 'SPENT') return;
  const spent: ApprovalRecord = {
    ...approval,
    status: 'SPENT',
    spentAt: at,
    spentByDecisionId: decisionId,
    updatedAt: at,
  };
  deps.store.set('interactions', approvalId, spent);
  deps.events.appendEvent({
    type: APPROVAL_SPENT,
    aggregateType: 'interaction',
    aggregateId: approvalId,
    payload: { approval: spent, decisionId },
  });
}

/**
 * The resolved decision as the enforcement entry point reports it. Callers that
 * only need the verdict use `check`; callers that must bind the authorization to
 * its resolver (the E6 merge gate) use `checkDetailed`.
 */
export interface PolicyDecisionOutcome {
  verdict: PolicyVerdict;
  resolvedBy: Evaluation['resolvedBy'];
  /** The consumed approval instance, when the verdict came from one. */
  spentApprovalId: string | null;
  /** The human whose APPROVAL authorized the verdict (`null` otherwise). */
  approvalActor: string | null;
}

function approvalActorFor(deps: PolicyCheckDeps, approvalId: string | null | undefined): string | null {
  if (!approvalId) return null;
  const approval = deps.store.get<ApprovalRecord>('interactions', approvalId);
  return approval?.response?.actor ?? null;
}

/**
 * The enforcement entry point (design §2). Evaluates purely, then records the
 * verdict durably under the §5.1 write rule: a decision instance with an
 * identical verdict writes nothing; a first evaluation or a verdict change
 * writes a `policy_decisions` row + `policy.decision` event — plus an approval
 * create/reuse on park, a spend on stage-4 consumption, and the §6.3 tier
 * ratchet — in one transaction.
 *
 * Returns the verdict plus the resolver identity (`resolvedBy`), the consumed
 * approval instance (`spentApprovalId`) and the human who authorized it
 * (`approvalActor`), so a caller can bind an `ALLOW` to the operator whose
 * `APPROVAL` produced it rather than trusting a caller-supplied actor.
 */
export function checkDetailed(
  deps: PolicyCheckDeps,
  subject: TaskRef,
  action: PolicyAction,
): PolicyDecisionOutcome {
  const now = deps.now ?? (() => new Date().toISOString());
  const wo = deps.store.get<WorkOrder>('work_orders', subject.workOrderId);
  if (!wo) {
    throw new FactoryError('WORK_ORDER_NOT_FOUND', `work order not found: ${subject.workOrderId}`);
  }
  const chain = createPolicyChain(deps, subject.workOrderId);
  const attemptId = action.attemptId !== undefined ? action.attemptId : resolveAttemptId(deps, subject.taskId);

  return deps.store.db.transaction((): PolicyDecisionOutcome => {
    const evaluation = evaluate({
      chain,
      wo,
      action: { ...action, attemptId },
      taskId: subject.taskId,
      approvals: deps.store.list<ApprovalRecord>('interactions'),
      emergencyStopped: isEmergencyStopped(deps),
    });

    const prior = findPriorDecision(deps, subject, attemptId, action, evaluation.decision);
    if (prior) {
      return {
        verdict: evaluation.decision,
        resolvedBy: prior.resolvedBy,
        spentApprovalId: prior.interactionId ?? null,
        approvalActor: approvalActorFor(deps, prior.interactionId),
      };
    }

    const t = now();
    const record: PolicyDecisionRecord = {
      id: `pd_${crypto.randomUUID()}`,
      task: subject.taskId,
      workOrderId: subject.workOrderId,
      attemptId,
      action: { capability: action.capability, resource: action.resource },
      risk: evaluation.risk,
      decision: evaluation.decision,
      rules: evaluation.rules,
      policyVersion: evaluation.policyVersion,
      resolvedBy: evaluation.resolvedBy,
      ...(evaluation.interactionId ? { interactionId: evaluation.interactionId } : {}),
      createdAt: t,
    };
    deps.store.set('policy_decisions', record.id, record);
    deps.events.appendEvent({
      type: POLICY_DECISION_RECORDED,
      aggregateType: 'policy_decision',
      aggregateId: record.id,
      payload: { record },
    });

    if (evaluation.decision === 'REQUIRE_HUMAN') {
      createOrReuseApproval(deps, subject, attemptId, action, t);
    }
    if (evaluation.spentApprovalId) {
      spendApproval(deps, evaluation.spentApprovalId, record.id, t);
    }
    if (evaluation.risk !== wo.riskTier) {
      ratchetTier(
        { store: deps.store, events: deps.events, now },
        subject.workOrderId,
        evaluation.risk,
        record,
      );
    }

    return {
      verdict: evaluation.decision,
      resolvedBy: evaluation.resolvedBy,
      spentApprovalId: evaluation.spentApprovalId ?? null,
      approvalActor: approvalActorFor(deps, evaluation.spentApprovalId),
    };
  })();
}

/** The verdict-only enforcement entry point (see {@link checkDetailed}). */
export function check(deps: PolicyCheckDeps, subject: TaskRef, action: PolicyAction): PolicyVerdict {
  return checkDetailed(deps, subject, action).verdict;
}

// ---------------------------------------------------------------------------
// Write-time `repo.write` path gating (RE6: the `infra/**` exclusion)
// ---------------------------------------------------------------------------

/** One changed path from a unified diff: the `b/<path>` side of a `diff --git`. */
const DIFF_HEADER = /^diff --git a\/.+ b\/(.+)$/gm;

/**
 * The changed paths a git diff touches (the write-time input for path-scoped
 * `repo.write`). Reads only the `diff --git a/… b/<path>` headers, which git
 * emits for every touched file — no hunk parsing, no heuristic content
 * sniffing. Deterministic and deduplicated, in first-seen order.
 *
 * Only the **new** (`b/<path>`) side is read. For a rename, git emits the source
 * and destination on that header (`a/<old> b/<new>`), so the destination is
 * gated and the source path is not. A **delete** is gated: git emits
 * `diff --git a/<path> b/<path>` (the same path on the `b/` side), so the
 * removed path is captured and gated like any other. The `repo.write` concern is
 * the path the change set names, which this header gives for adds, edits and
 * deletes alike.
 */
export function changedPathsFromDiff(diff: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  DIFF_HEADER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DIFF_HEADER.exec(diff)) !== null) {
    const path = match[1];
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export interface RepoWriteGateResult {
  allowed: boolean;
  /** The changed paths whose `repo.write` verdict was not `ALLOW`. */
  denied: string[];
}

/**
 * The write-time path-scoped `repo.write` gate (design §4; RE5(b)/RE6): the
 * assignment gate binds `path:'**'` for the whole worktree, but the actual
 * change's paths are only known once the diff exists. This folds E7's `check`
 * over every changed path on the Task's real worktree branch, so the embedded
 * `infra/**` exclusion (or any deployment narrowing) is enforced against the
 * change set — not merely the branch.
 *
 * Fail-closed on paths that are not `ALLOW`: `REQUIRE_HUMAN` and `DENY` both deny
 * the change set here (the caller routes it to REWORK), unlike the assignment
 * gate which leaves a Task READY on `REQUIRE_HUMAN`. The asymmetry is deliberate
 * — a change set that has already been written cannot park pending a human; it
 * must be reworked or escalated rather than verified.
 *
 * No changed paths (an empty diff) is a vacuous allow: nothing was written, so
 * there is nothing to gate. The caller treats a no-diff SUCCESS change set the
 * same as any other; the short-circuit is explicit so the case is visible.
 */
export function repoWriteGate(
  deps: PolicyCheckDeps,
  subject: TaskRef,
  branch: string,
  paths: readonly string[],
): RepoWriteGateResult {
  if (paths.length === 0) return { allowed: true, denied: [] };
  const denied = paths.filter(
    (path) =>
      check(deps, subject, { capability: 'repo.write', resource: { branch, path } }) !== 'ALLOW',
  );
  return { allowed: denied.length === 0, denied };
}

/** Build the resolved chain for a Work Order from deployment + durable state. */
export function createPolicyChain(
  deps: { store: StateStore; policy?: PolicyDocument },
  workOrderId: string,
): PolicyChain {
  const policy = deps.policy ?? createDefaultPolicy();
  const wo = deps.store.get<WorkOrder>('work_orders', workOrderId);
  const project = wo?.repository ? policy.projects?.[wo.repository] : undefined;
  return {
    version: policy.version,
    organization: policy.organization,
    project,
    workOrder: wo ? buildWorkOrderLevel(wo) : undefined,
  };
}

const CONSTRAINT_RE = /^policy:([a-z.]+)=(allow|deny|require_human)$/i;
const DECISION_BY_TOKEN: Record<string, PolicyVerdict> = {
  allow: 'ALLOW',
  deny: 'DENY',
  require_human: 'REQUIRE_HUMAN',
};

/**
 * Derive the WO-level narrowing from the E1 WorkOrder entity (design §3.1). The
 * E1 fields are deliberately unstructured, so v0.1 reads two documented forms:
 * `policy:<capability>=<allow|deny|require_human>` constraints, and
 * `outOfScope` globs (excluded from `repo.read`/`repo.write`). Anything else is
 * ignored — the WO level stays silent and inherits.
 */
export function buildWorkOrderLevel(wo: WorkOrder): PolicyLevel | undefined {
  const capabilities: PolicyLevel['capabilities'] = {};
  for (const constraint of wo.constraints) {
    const match = CONSTRAINT_RE.exec(constraint.trim());
    if (!match) continue;
    const capability = match[1] as Capability;
    if (!isCapability(capability)) continue;
    (capabilities[capability] ??= []).push({
      decision: DECISION_BY_TOKEN[match[2].toLowerCase()],
      ruleId: `wo:${capability}`,
    });
  }
  if (wo.outOfScope.length > 0) {
    for (const capability of ['repo.read', 'repo.write'] as const) {
      (capabilities[capability] ??= []).push({
        decision: 'ALLOW',
        scope: { excludePaths: [...wo.outOfScope] },
        ruleId: `wo:${capability}:out-of-scope`,
      });
    }
  }
  return Object.keys(capabilities).length > 0 ? { capabilities } : undefined;
}

// ---------------------------------------------------------------------------
// Approved-by-human answers (E2's answer loop) — recorded, identity required
// ---------------------------------------------------------------------------

export function answerApproval(
  deps: Pick<PolicyCheckDeps, 'store' | 'events' | 'now'>,
  approvalId: string,
  response: { decision: 'APPROVAL' | 'DENY'; actor: string; comment?: string },
): ApprovalRecord {
  if (!response.actor) {
    throw new FactoryError('APPROVAL_ACTOR_REQUIRED', 'an APPROVAL answer requires an operator identity');
  }
  const approval = deps.store.get<ApprovalRecord>('interactions', approvalId);
  if (!approval || approval.type !== 'APPROVAL') {
    throw new FactoryError('APPROVAL_NOT_FOUND', `approval not found: ${approvalId}`);
  }
  if (approval.status === 'SPENT') {
    throw new FactoryError('APPROVAL_SPENT', `approval already spent: ${approvalId}`);
  }
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const answered: ApprovalRecord = {
    ...approval,
    status: 'ANSWERED',
    response: {
      decision: response.decision,
      actor: response.actor,
      answeredAt: at,
      ...(response.comment ? { comment: response.comment } : {}),
    },
    updatedAt: at,
  };
  deps.store.set('interactions', approvalId, answered);
  deps.events.appendEvent({
    type: APPROVAL_ANSWERED,
    aggregateType: 'interaction',
    aggregateId: approvalId,
    payload: { approval: answered },
  });
  return answered;
}

// ---------------------------------------------------------------------------
// Factory-level controls: pause / resume / emergency-stop (§10)
// ---------------------------------------------------------------------------

export interface FactoryControlState {
  paused: boolean;
  emergencyStopped: boolean;
}

interface FactoryControlEvent {
  type: string;
  payload?: { actor?: string };
}

/** Fold the durable factory control events (the flag is event-derived, §10). */
export function factoryControlState(
  deps: Pick<PolicyCheckDeps, 'events'>,
): FactoryControlState {
  const state: FactoryControlState = { paused: false, emergencyStopped: false };
  for (const event of deps.events.readEvents({
    aggregateType: 'factory',
    aggregateId: 'factory',
  })) {
    const type = (event as unknown as FactoryControlEvent).type;
    if (type === FACTORY_EMERGENCY_STOPPED) state.emergencyStopped = true;
    else if (type === FACTORY_PAUSED) state.paused = true;
    else if (type === FACTORY_RESUMED) {
      state.paused = false;
      state.emergencyStopped = false;
    }
  }
  return state;
}

export function isEmergencyStopped(deps: Pick<PolicyCheckDeps, 'events'>): boolean {
  return factoryControlState(deps).emergencyStopped;
}

export function isFactoryPaused(deps: Pick<PolicyCheckDeps, 'events'>): boolean {
  return factoryControlState(deps).paused;
}

function assertActor(actor: string): void {
  if (!actor) {
    throw new FactoryError('OPERATOR_REQUIRED', 'factory controls require an operator identity');
  }
}

/**
 * Emergency stop (§10). Durable and idempotent: repeated invocations are
 * no-ops. It blocks new assignments/provisioning/external side effects through
 * `check`'s stage-1 gate and preserves all state and evidence (it destroys
 * nothing).
 */
export function emergencyStop(
  deps: Pick<PolicyCheckDeps, 'store' | 'events' | 'now'>,
  opts: { actor: string },
): FactoryControlState {
  assertActor(opts.actor);
  const current = factoryControlState(deps);
  if (current.emergencyStopped) return current;
  const at = (deps.now ?? (() => new Date().toISOString()))();
  deps.events.appendEvent({
    type: FACTORY_EMERGENCY_STOPPED,
    aggregateType: 'factory',
    aggregateId: 'factory',
    payload: { actor: opts.actor, at },
  });
  return factoryControlState(deps);
}

/** Manual pause (§10): blocks new autonomous work, preserves evidence. */
export function pauseFactory(
  deps: Pick<PolicyCheckDeps, 'store' | 'events' | 'now'>,
  opts: { actor: string },
): FactoryControlState {
  assertActor(opts.actor);
  const current = factoryControlState(deps);
  if (current.paused) return current;
  const at = (deps.now ?? (() => new Date().toISOString()))();
  deps.events.appendEvent({
    type: FACTORY_PAUSED,
    aggregateType: 'factory',
    aggregateId: 'factory',
    payload: { actor: opts.actor, at },
  });
  return factoryControlState(deps);
}

/** Explicit human resume (§10); clears pause and e-stop. No timer auto-resumes. */
export function resumeFactory(
  deps: Pick<PolicyCheckDeps, 'store' | 'events' | 'now'>,
  opts: { actor: string },
): FactoryControlState {
  assertActor(opts.actor);
  const current = factoryControlState(deps);
  if (!current.paused && !current.emergencyStopped) return current;
  const at = (deps.now ?? (() => new Date().toISOString()))();
  deps.events.appendEvent({
    type: FACTORY_RESUMED,
    aggregateType: 'factory',
    aggregateId: 'factory',
    payload: { actor: opts.actor, at },
  });
  return factoryControlState(deps);
}
