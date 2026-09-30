import type { WorkOrder } from '../domain/workOrder';
import type { WorkerManagerDeps } from '../workers/manager';
import type { PolicyDecisionRecord, PolicyVerdict } from './policy';

/**
 * E7 risk tier machinery (design `policy-and-risk-model.md` §6; ADR 14 point 4).
 *
 * The contract is deliberately split:
 *  - `classifyRisk(wo)` is the **durable** classifier. It reads exactly one Work
 *    Order field (`wo.riskTier`) and performs **no** text inference over
 *    constraints / out-of-scope / acceptance criteria. Any future inference must
 *    be a separately named function, never folded into this one.
 *  - `escalateFor(capability, resource)` is the **check-time** observation. It is
 *    deterministic and no-LLM: hitting the security taxonomy, production, or
 *    customer data ⇒ `RED`; otherwise it returns the `GREEN` no-escalation
 *    sentinel. `GREEN` here means "no opinion" — the fold, not this operand,
 *    keeps the Work Order's floor.
 *
 * `tighterTier` is the tier analogue of the policy fold: it never lowers a tier.
 * `ratchetTier` is the durable, monotone, idempotent raise driven by `check`
 * (§6.3): it writes `risk.tier_changed` + a `policy_decisions` evidence row in
 * the same transaction as the decision that observed the escalation.
 */

/** Sensitivity class of a capability (design §4). */
export type Sensitivity = 'low' | 'medium' | 'high';

/**
 * Deployment security taxonomy (design §6.3). Patterns match anywhere in the
 * resource path, so `src/auth/login.ts` matches `**​/auth/**`.
 */
export const SECURITY_TAXONOMY: readonly string[] = [
  '**/auth/**',
  '**/*password*',
  '**/secrets/**',
  '**/infra/prod/**',
];

/** Event type for a durable tier ratchet (design §6.3). */
export const RISK_TIER_CHANGED = 'risk.tier_changed';

const TIER_RANK: Record<'GREEN' | 'YELLOW' | 'RED', number> = {
  GREEN: 0,
  YELLOW: 1,
  RED: 2,
};

const globCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**​/` matches zero or more leading path segments.
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const compiled = new RegExp(`^${source}$`);
  globCache.set(pattern, compiled);
  return compiled;
}

/** Match one glob pattern against a value (`**` crosses `/`, `*` does not). */
export function matchesGlob(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

/** True when any pattern matches the value. */
export function matchesAnyGlob(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, value));
}

/**
 * The durable classifier (design §6.3). Durable, WO-only: exactly
 * `wo.riskTier`, never inferred from other Work Order fields.
 */
export function classifyRisk(wo: Pick<WorkOrder, 'riskTier'>): 'GREEN' | 'YELLOW' | 'RED' {
  return wo.riskTier;
}

export interface EscalationResource {
  path?: string;
  branch?: string;
  env?: string;
  dataClass?: string;
}

/**
 * Check-time observation (design §6.3). Returns `RED` when the action binding
 * hits the security taxonomy / production / customer data, else the `GREEN`
 * no-escalation sentinel. Deterministic; no LLM.
 */
export function escalateFor(
  capability: string,
  resource?: EscalationResource,
): 'GREEN' | 'YELLOW' | 'RED' {
  if (resource?.path && matchesAnyGlob(SECURITY_TAXONOMY, resource.path)) return 'RED';
  if (resource?.env === 'production') return 'RED';
  if (resource?.dataClass === 'customer-data') return 'RED';
  return 'GREEN';
}

/** Fold two tiers, returning the stricter. Never lowers. */
export function tighterTier(
  a: 'GREEN' | 'YELLOW' | 'RED',
  b: 'GREEN' | 'YELLOW' | 'RED',
): 'GREEN' | 'YELLOW' | 'RED' {
  return TIER_RANK[b] > TIER_RANK[a] ? b : a;
}

/**
 * The stage-3 tier floor (design §8.1): the minimum restrictiveness the
 * effective tier demands for a capability sensitivity class. The gate can only
 * ever restrict.
 */
export function tierFloor(tier: 'GREEN' | 'YELLOW' | 'RED', sensitivity: Sensitivity): PolicyVerdict {
  if (tier === 'RED') return 'REQUIRE_HUMAN';
  return sensitivity === 'high' ? 'REQUIRE_HUMAN' : 'ALLOW';
}

/**
 * Durable, monotone, idempotent tier ratchet (design §6.3). Raises
 * `wo.riskTier` to `observed` and appends `risk.tier_changed` + a
 * `policy_decisions` evidence row. Returns `true` when it raised, `false` when
 * the observation did not exceed the durable tier (no rows written).
 *
 * The caller runs this inside the same transaction as the decision that
 * observed the escalation, so state and log can never disagree.
 */
export function ratchetTier(
  deps: Pick<WorkerManagerDeps, 'store' | 'events'>,
  workOrderId: string,
  observed: 'GREEN' | 'YELLOW' | 'RED',
  evidence: PolicyDecisionRecord,
): boolean {
  const wo = deps.store.get<WorkOrder>('work_orders', workOrderId);
  if (!wo) return false;
  if (TIER_RANK[observed] <= TIER_RANK[wo.riskTier]) return false;

  const now = new Date().toISOString();
  const updated: WorkOrder = { ...wo, riskTier: observed, updatedAt: now };
  const record: PolicyDecisionRecord = {
    id: `pd_${crypto.randomUUID()}`,
    task: evidence.task,
    workOrderId,
    attemptId: evidence.attemptId,
    action: evidence.action,
    risk: observed,
    decision: evidence.decision,
    rules: ['risk.tier_changed', `from:${wo.riskTier}`, `to:${observed}`, `evidence:${evidence.id}`],
    policyVersion: evidence.policyVersion,
    resolvedBy: 'policy',
    createdAt: now,
  };

  deps.store.set('work_orders', workOrderId, updated);
  deps.store.set('policy_decisions', record.id, record);
  deps.events.appendEvent({
    type: RISK_TIER_CHANGED,
    aggregateType: 'work_order',
    aggregateId: workOrderId,
    payload: { workOrder: updated, from: wo.riskTier, to: observed, evidenceDecisionId: evidence.id },
  });
  deps.events.appendEvent({
    type: 'policy.decision',
    aggregateType: 'policy_decision',
    aggregateId: record.id,
    payload: { record },
  });
  return true;
}
