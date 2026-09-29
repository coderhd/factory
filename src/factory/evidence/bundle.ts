import type { Attempt, WorkOrder } from '../domain/workOrder';
import type {
  ChangeSet,
  CheckEvidence,
  SuiteResult,
  VerificationRun,
} from '../verification/engine';
import { VerificationConfigurationError } from '../verification/engine';
import {
  modelKey,
  type ModelIdentity,
  type PromptProvenance,
  type SemanticVerificationResult,
  type VerificationTier,
} from '../verification/semantic';

/**
 * E5.2 (#19) immutable Evidence Bundle assembler (spec §5.4, §14.4).
 *
 * The bundle is the durable receipt for a change set: every acceptance
 * criterion is mapped to concrete proof drawn from the verification tiers, with
 * the gates, model/prompt provenance, per-tier sign-off and attempt history.
 * An acceptance criterion with no proof is an explicit gap (`uncovered`), not a
 * silent pass. `complete` also fails closed on the §9 Writer ≠ Verifier
 * attestation: a receipt whose semantic result does not attest
 * `provenance.modelDifferent` is never promotion-grade, whatever its gates say.
 * The bundle is deep-frozen once produced and is a copy of its inputs, so
 * neither the caller nor a later mutation can rewrite the receipt.
 *
 * The run-level gate is E5.1's `run.passed`. A per-category `SuiteResult.passed`
 * is only meaningful when that suite actually executed checks, so tier gates
 * require a non-empty suite — a vacuous `every` over an empty suite is never
 * coverage.
 */

/** One tier's concrete proof for one acceptance criterion. */
export interface ProofRef {
  tier: VerificationTier;
  verifier: string;
  status: 'pass' | 'fail';
  evidence: CheckEvidence;
}

/** An acceptance criterion and the proof gathered for it. */
export interface CriterionProof {
  criterion: string;
  /** `uncovered` means no tier produced proof — an explicit gap, never a silent pass. */
  status: 'pass' | 'fail' | 'uncovered';
  proofs: ProofRef[];
}

/** The verification gates recorded on the bundle. */
export interface EvidenceGates {
  deterministic: boolean;
  behavioral: boolean;
  semantic: boolean;
  /** E5.1's run-level gate. Authoritative; per-category results are not coverage. */
  run: boolean;
}

/** One tier's sign-off. `signedOff` requires the tier to have actually executed. */
export interface TierSignOff {
  tier: VerificationTier;
  signedOff: boolean;
  verifiers: string[];
}

/** Model/prompt provenance for the change (spec §9). */
export interface BundleProvenance {
  generator: ModelIdentity;
  verifier: ModelIdentity;
  prompt: PromptProvenance;
  modelDifferent: boolean;
  familyDifferent: boolean;
  freshContext: boolean;
}

/** A curated attempt-history entry: execution history, not a transcript. */
export interface AttemptHistoryEntry {
  attemptId: string;
  model: string | null;
  outcome: string | null;
  failureCount: number;
  artifactIds: string[];
  createdAt: string;
}

export interface EvidenceBundle {
  id: string;
  workOrderId: string;
  changeSetId: string;
  createdAt: string;
  criteria: CriterionProof[];
  gates: EvidenceGates;
  provenance: BundleProvenance;
  tierSignOff: TierSignOff[];
  attempts: AttemptHistoryEntry[];
  /** Context only, never a gate: the agent's self-assessment is advisory (spec §14.4). */
  advisory: { selfAssessment: string | null };
  /**
   * True only when every AC is covered by passing proof, both run and semantic
   * gates pass, and the semantic result attests writer ≠ verifier
   * (`provenance.modelDifferent`). The bundle is the durable receipt the
   * promotion gate consumes, so a result that does not attest an independent
   * verifier fails closed here rather than certifying a self-signed change.
   */
  complete: boolean;
}

export interface EvidenceBundleInput {
  workOrder: WorkOrder;
  changeSet: ChangeSet;
  /** E5.1's deterministic + behavioral run for this change set. */
  run: VerificationRun;
  /** E5.2's independent semantic result for this change set. */
  semantic: SemanticVerificationResult;
  /** E1 attempt/rework history, oldest first. */
  attempts: Attempt[];
  /** Optional id override (tests); defaults to a generated `eb_` id. */
  id?: string;
  /** Optional clock override; defaults to now. */
  now?: string;
}

function cloneIdentity(identity: ModelIdentity): ModelIdentity {
  const copy: ModelIdentity = { provider: identity.provider, model: identity.model };
  if (identity.version !== undefined) copy.version = identity.version;
  if (identity.family !== undefined) copy.family = identity.family;
  return copy;
}

function cloneEvidence(evidence: CheckEvidence): CheckEvidence {
  return evidence.artifacts
    ? { summary: evidence.summary, artifacts: [...evidence.artifacts] }
    : { summary: evidence.summary };
}

function executed(suite: SuiteResult): boolean {
  return suite.checks.length > 0;
}

function verifiersOf(suite: SuiteResult): string[] {
  return [...new Set(suite.checks.map((check) => check.verifier))];
}

/** Work Order ACs first, then any criterion the run or judge added — in order. */
function criterionOrder(
  workOrder: WorkOrder,
  run: VerificationRun,
  semantic: SemanticVerificationResult,
): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const push = (criterion: string) => {
    if (!seen.has(criterion)) {
      seen.add(criterion);
      order.push(criterion);
    }
  };
  workOrder.acceptanceCriteria.forEach(push);
  run.criteria.forEach((criterion) => push(criterion.criterion));
  semantic.verdicts.forEach((verdict) => push(verdict.criterion));
  return order;
}

function buildCriteria(
  workOrder: WorkOrder,
  run: VerificationRun,
  semantic: SemanticVerificationResult,
): CriterionProof[] {
  const checks = [...run.deterministic.checks, ...run.behavioral.checks];
  const semanticVerifier = modelKey(semantic.verifier);

  return criterionOrder(workOrder, run, semantic).map((criterion) => {
    const proofs: ProofRef[] = [];

    const engineCriterion = run.criteria.find((candidate) => candidate.criterion === criterion);
    if (engineCriterion) {
      for (const checkId of engineCriterion.checkIds) {
        for (const check of checks.filter((candidate) => candidate.checkId === checkId)) {
          proofs.push({
            tier: check.category,
            verifier: check.verifier,
            status: check.status,
            evidence: cloneEvidence(check.evidence),
          });
        }
      }
    }

    const verdict = semantic.verdicts.find((candidate) => candidate.criterion === criterion);
    if (verdict) {
      proofs.push({
        tier: 'semantic',
        verifier: semanticVerifier,
        status: verdict.status,
        evidence: cloneEvidence(verdict.evidence),
      });
    }

    const status: CriterionProof['status'] =
      proofs.length === 0 ? 'uncovered' : proofs.some((proof) => proof.status === 'fail') ? 'fail' : 'pass';
    return { criterion, status, proofs };
  });
}

function toHistory(attempt: Attempt): AttemptHistoryEntry {
  return {
    attemptId: attempt.id,
    model: attempt.model,
    outcome: attempt.outcome,
    failureCount: attempt.failureHistory.length,
    artifactIds: [...attempt.artifactIds],
    createdAt: attempt.createdAt,
  };
}

/** Freeze an object graph so the receipt cannot be rewritten after production. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Assemble the immutable Evidence Bundle. Copies every input, refuses to mix
 * tiers that describe different change sets, and deep-freezes the result.
 */
export function buildEvidenceBundle(input: EvidenceBundleInput): Readonly<EvidenceBundle> {
  const { workOrder, changeSet, run, semantic, attempts } = input;

  if (run.changeSetId !== changeSet.id) {
    throw new VerificationConfigurationError(
      `cannot assemble evidence: the run describes change set "${run.changeSetId}" but the change set is "${changeSet.id}"`,
    );
  }
  if (semantic.changeSetId !== changeSet.id) {
    throw new VerificationConfigurationError(
      `cannot assemble evidence: the semantic result describes change set "${semantic.changeSetId}" but the change set is "${changeSet.id}"`,
    );
  }

  const criteria = buildCriteria(workOrder, run, semantic);
  const gates: EvidenceGates = {
    deterministic: executed(run.deterministic) && run.deterministic.passed,
    behavioral: executed(run.behavioral) && run.behavioral.passed,
    semantic: semantic.passed,
    run: run.passed,
  };
  const tierSignOff: TierSignOff[] = [
    {
      tier: 'deterministic',
      signedOff: gates.deterministic,
      verifiers: verifiersOf(run.deterministic),
    },
    { tier: 'behavioral', signedOff: gates.behavioral, verifiers: verifiersOf(run.behavioral) },
    {
      tier: 'semantic',
      signedOff: semantic.verdicts.length > 0 && semantic.passed,
      verifiers: [modelKey(semantic.verifier)],
    },
  ];

  const generatorAttempt = attempts.find((attempt) => attempt.id === changeSet.attemptId) ?? null;

  const complete =
    criteria.length > 0 &&
    criteria.every((criterion) => criterion.status === 'pass') &&
    gates.run &&
    gates.semantic &&
    // Fail closed on the §9 Writer ≠ Verifier attestation, exactly as the tiers
    // fail closed on vacuous passes: `gates.semantic` records that the judge
    // passed, not that it was independent of the writer.
    semantic.provenance.modelDifferent;

  const bundle: EvidenceBundle = {
    id: input.id ?? `eb_${crypto.randomUUID()}`,
    workOrderId: workOrder.id,
    changeSetId: changeSet.id,
    createdAt: input.now ?? new Date().toISOString(),
    criteria,
    gates,
    provenance: {
      generator: cloneIdentity(semantic.generator),
      verifier: cloneIdentity(semantic.verifier),
      prompt: { id: semantic.prompt.id, version: semantic.prompt.version },
      modelDifferent: semantic.provenance.modelDifferent,
      familyDifferent: semantic.provenance.familyDifferent,
      freshContext: semantic.provenance.freshContext,
    },
    tierSignOff,
    attempts: attempts.map(toHistory),
    advisory: { selfAssessment: generatorAttempt ? generatorAttempt.outcome : null },
    complete,
  };

  return deepFreeze(bundle);
}
