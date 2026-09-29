import type { Attempt } from '../domain/workOrder';

/**
 * E5.1 (#18) verification engine harness (spec §9, §14.1, §14.2, §14.4).
 *
 * A change set is verified by pluggable check providers registered under a
 * category. The runner executes every registered check against the change set
 * and records a per-check result, a per-acceptance-criterion result keyed by
 * the caller's mapping, and a structured failure record for every failing
 * check. Verification never mutates the implementation under test, and a
 * failing check is never a bare throw or a silent pass.
 *
 * The semantic tier (independent falsifying verifier) and the Evidence Bundle
 * are later E5 slices; this module is only the deterministic + behavioral
 * harness and the seam they plug into.
 */

/** The four-tier architecture's deterministic tier (spec §14.1). */
export const DETERMINISTIC_CHECKS = [
  'typecheck',
  'lint',
  'unit',
  'integration',
  'build',
  'security',
] as const;

/** The four-tier architecture's behavioral tier (spec §14.2). */
export const BEHAVIORAL_CHECKS = ['playwright', 'api', 'contract', 'visual', 'db', 'e2e'] as const;

export type CheckCategory = 'deterministic' | 'behavioral';
export type DeterministicKind = (typeof DETERMINISTIC_CHECKS)[number];
export type BehavioralKind = (typeof BEHAVIORAL_CHECKS)[number];
export type CheckKind = DeterministicKind | BehavioralKind;

/** The check kinds a category may host. A provider's kind must belong to its category. */
export const CHECK_KINDS: Readonly<Record<CheckCategory, readonly CheckKind[]>> = {
  deterministic: DETERMINISTIC_CHECKS,
  behavioral: BEHAVIORAL_CHECKS,
};

/**
 * The E3 change set under verification: the diff and artifacts an Attempt
 * produced (spec §5.3). It is a read-only target — the engine never writes it.
 */
export interface ChangeSet {
  id: string;
  attemptId: string;
  taskId: string;
  diff: string | null;
  artifactIds: string[];
}

/** Derive the change set the verification engine consumes from an E1 Attempt (E3). */
export function changeSetFromAttempt(attempt: Attempt): ChangeSet {
  return {
    id: `cs_${attempt.id}`,
    attemptId: attempt.id,
    taskId: attempt.taskId,
    diff: attempt.diff,
    artifactIds: [...attempt.artifactIds],
  };
}

/** Concrete evidence a check produces (spec §14.4: each criterion maps to evidence). */
export interface CheckEvidence {
  summary: string;
  artifacts?: string[];
}

/** What a check returns. A failure must carry a diagnosis and a suggested action. */
export type CheckOutcome =
  | { passed: true; evidence: CheckEvidence }
  | { passed: false; evidence: CheckEvidence; diagnosis: string; action: string };

/** What a check is given to run against. The engine hands it a defensive copy. */
export interface CheckContext {
  changeSet: ChangeSet;
}

/** A pluggable verification check registered by category. */
export interface CheckProvider {
  /** Stable verifier identity recorded on results and failures. */
  id: string;
  category: CheckCategory;
  kind: CheckKind;
  run(context: CheckContext): CheckOutcome | Promise<CheckOutcome>;
}

/** One check's record: pass/fail plus the evidence behind it. */
export interface CheckResult {
  checkId: string;
  category: CheckCategory;
  kind: CheckKind;
  verifier: string;
  /** Acceptance criteria this check was mapped to (may be empty). */
  criteria: string[];
  status: 'pass' | 'fail';
  evidence: CheckEvidence;
  diagnosis: string | null;
  action: string | null;
}

/** One acceptance criterion's verdict, keyed by the caller's mapping (spec §14.4). */
export interface CriterionResult {
  criterion: string;
  /** `unmapped` when no check covers the criterion — an explicit gap, not a pass. */
  status: 'pass' | 'fail' | 'unmapped';
  checkIds: string[];
}

/** A category's worth of check results. */
export interface SuiteResult {
  category: CheckCategory;
  checks: CheckResult[];
  passed: boolean;
}

/** The structured verification failure (spec §14.4). Never a bare throw. */
export interface FailureRecord {
  category: CheckCategory;
  criterion: string | null;
  verifier: string;
  evidence: CheckEvidence;
  diagnosis: string;
  action: string;
}

/** The outcome of one verification run over one change set. */
export interface VerificationRun {
  changeSetId: string;
  deterministic: SuiteResult;
  behavioral: SuiteResult;
  criteria: CriterionResult[];
  failures: FailureRecord[];
  passed: boolean;
}

/** Caller-supplied acceptance-criterion mapping for a run. */
export interface VerifyOptions {
  /** The Work Order's acceptance criteria, in order. */
  criteria?: string[];
  /** Maps each acceptance criterion to the checks that verify it. */
  criterionChecks?: Record<string, string[]>;
}

export interface VerificationEngine {
  registerCheck(provider: CheckProvider): void;
  listChecks(category?: CheckCategory): CheckProvider[];
  verify(changeSet: ChangeSet, options?: VerifyOptions): Promise<VerificationRun>;
}

function assertProvider(provider: CheckProvider): void {
  if (typeof provider.id !== 'string' || provider.id.trim().length === 0) {
    throw new Error('a check provider requires a non-empty id');
  }
  const kinds = CHECK_KINDS[provider.category];
  if (!kinds) {
    throw new Error(`unknown check category: ${provider.category}`);
  }
  if (!kinds.includes(provider.kind)) {
    throw new Error(
      `check "${provider.id}" claims category "${provider.category}" with incompatible kind "${provider.kind}"`,
    );
  }
}

/** A change set copy: providers run against a private target, never the caller's object. */
function cloneChangeSet(changeSet: ChangeSet): ChangeSet {
  return {
    id: changeSet.id,
    attemptId: changeSet.attemptId,
    taskId: changeSet.taskId,
    diff: changeSet.diff,
    artifactIds: [...changeSet.artifactIds],
  };
}

/** Keep only well-formed evidence. A check with no usable evidence cannot pass. */
function normalizeEvidence(value: unknown): CheckEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { summary?: unknown; artifacts?: unknown };
  if (typeof candidate.summary !== 'string' || candidate.summary.trim().length === 0) {
    return null;
  }
  const evidence: CheckEvidence = { summary: candidate.summary };
  if (Array.isArray(candidate.artifacts)) {
    evidence.artifacts = candidate.artifacts.filter((item): item is string => typeof item === 'string');
  }
  return evidence;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

interface CheckBase {
  checkId: string;
  category: CheckCategory;
  kind: CheckKind;
  verifier: string;
  criteria: string[];
}

function failedResult(
  base: CheckBase,
  evidence: CheckEvidence,
  diagnosis: string,
  action: string,
): CheckResult {
  return { ...base, status: 'fail', evidence, diagnosis, action };
}

async function runCheck(
  provider: CheckProvider,
  criteria: string[],
  context: CheckContext,
): Promise<CheckResult> {
  const base: CheckBase = {
    checkId: provider.id,
    category: provider.category,
    kind: provider.kind,
    verifier: provider.id,
    criteria: [...criteria],
  };

  let reported: unknown;
  try {
    reported = await provider.run(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failedResult(
      base,
      { summary: `${provider.id} check threw: ${message}` },
      `${provider.id} check threw before reporting a result`,
      `fix the ${provider.id} check error and re-run verification`,
    );
  }

  const outcome = reported as {
    passed?: unknown;
    evidence?: unknown;
    diagnosis?: unknown;
    action?: unknown;
  } | null;

  const evidence = normalizeEvidence(outcome?.evidence);
  if (!evidence) {
    return failedResult(
      base,
      { summary: `${provider.id} returned no usable evidence` },
      `${provider.id} check returned a ${outcome?.passed === true ? 'pass' : 'fail'} without evidence`,
      `make the ${provider.id} check emit evidence and re-run verification`,
    );
  }

  if (outcome?.passed === true) {
    return { ...base, status: 'pass', evidence, diagnosis: null, action: null };
  }
  return failedResult(
    base,
    evidence,
    nonEmpty(outcome?.diagnosis) ?? `${provider.id} check failed`,
    nonEmpty(outcome?.action) ?? `inspect ${provider.id} evidence and re-run verification`,
  );
}

function suite(category: CheckCategory, checks: CheckResult[]): SuiteResult {
  const scoped = checks.filter((check) => check.category === category);
  return { category, checks: scoped, passed: scoped.every((check) => check.status === 'pass') };
}

export function createVerificationEngine(): VerificationEngine {
  const providers: CheckProvider[] = [];

  function registerCheck(provider: CheckProvider): void {
    assertProvider(provider);
    if (providers.some((registered) => registered.id === provider.id)) {
      throw new Error(`duplicate check id: ${provider.id}`);
    }
    providers.push(provider);
  }

  function listChecks(category?: CheckCategory): CheckProvider[] {
    return category
      ? providers.filter((provider) => provider.category === category)
      : providers.slice();
  }

  async function verify(changeSet: ChangeSet, options: VerifyOptions = {}): Promise<VerificationRun> {
    const criteria = [...(options.criteria ?? [])];
    const mapping = options.criterionChecks ?? {};
    const registered = new Set(providers.map((provider) => provider.id));

    for (const [criterion, checkIds] of Object.entries(mapping)) {
      for (const checkId of checkIds) {
        if (!registered.has(checkId)) {
          throw new Error(`criterion "${criterion}" maps to unknown check "${checkId}"`);
        }
      }
    }

    // Invert the caller's criterion -> checks mapping, preserving criterion order.
    const criteriaFor = new Map<string, string[]>();
    for (const criterion of criteria) {
      for (const checkId of mapping[criterion] ?? []) {
        const list = criteriaFor.get(checkId) ?? [];
        if (!list.includes(criterion)) list.push(criterion);
        criteriaFor.set(checkId, list);
      }
    }

    const context: CheckContext = { changeSet: cloneChangeSet(changeSet) };
    const checks: CheckResult[] = [];
    for (const provider of providers) {
      checks.push(await runCheck(provider, criteriaFor.get(provider.id) ?? [], context));
    }

    const deterministic = suite('deterministic', checks);
    const behavioral = suite('behavioral', checks);

    const criterionResults: CriterionResult[] = criteria.map((criterion) => {
      const checkIds = [...new Set(mapping[criterion] ?? [])];
      const status =
        checkIds.length === 0
          ? 'unmapped'
          : checkIds.every((checkId) => checks.some((c) => c.checkId === checkId && c.status === 'pass'))
            ? 'pass'
            : 'fail';
      return { criterion, status, checkIds };
    });

    const failures: FailureRecord[] = [];
    for (const check of checks) {
      if (check.status !== 'fail') continue;
      // A failing check mapped to no criterion still surfaces (criterion null).
      const targets: Array<string | null> = check.criteria.length > 0 ? check.criteria : [null];
      for (const criterion of targets) {
        failures.push({
          category: check.category,
          criterion,
          verifier: check.verifier,
          evidence: check.evidence,
          diagnosis: check.diagnosis ?? `${check.verifier} check failed`,
          action: check.action ?? `inspect ${check.verifier} evidence and re-run verification`,
        });
      }
    }

    const passed =
      deterministic.passed &&
      behavioral.passed &&
      criterionResults.every((criterion) => criterion.status === 'pass');

    return {
      changeSetId: changeSet.id,
      deterministic,
      behavioral,
      criteria: criterionResults,
      failures,
      passed,
    };
  }

  return { registerCheck, listChecks, verify };
}
