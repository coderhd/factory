import type { WorkOrder } from '../domain/workOrder';
import type {
  ChangeSet,
  CheckEvidence,
  CheckResult,
  FailureRecord,
  SuiteResult,
} from './engine';
import { VerificationConfigurationError } from './engine';

/**
 * E5.2 (#19) independent semantic verifier (spec §9, §14.3).
 *
 * The verifier is an adversarial judge that tries to FALSIFY each acceptance
 * criterion — it is never handed the developer's reasoning transcript, only a
 * fresh context (Work Order, acceptance criteria, change set, the deterministic
 * and behavioral results, and a rubric). It runs behind a small injectable
 * `SemanticJudge` seam so tests use a fake judge and production can wire a
 * model. The verifier never mutates the implementation: it works on private
 * copies of everything it is given.
 *
 * Writer ≠ Verifier (§9): the judge's model identity must differ from the
 * generator's. A same-model sign-off is rejected at construction, before any
 * check runs. A different family is preferred and attested, but not required.
 */

/**
 * The verification tiers this slice knows about. `semantic` is #19's tier;
 * `deterministic` and `behavioral` are E5.1's.
 */
export type VerificationTier = 'deterministic' | 'behavioral' | 'semantic';

/** The provider/model identity recorded in provenance (spec §9). */
export interface ModelIdentity {
  provider: string;
  model: string;
  /** Optional deployment-defined version/hash. */
  version?: string;
  /** Optional model family, for the §9 "prefer a different family" signal. */
  family?: string;
}

/** The verification prompt/rubric identity recorded in provenance. */
export interface PromptProvenance {
  id: string;
  version: string;
}

/**
 * What the judge is allowed to see: fresh context only. There is deliberately
 * no field for the developer transcript, reasoning, or chat messages.
 */
export interface SemanticContext {
  workOrder: WorkOrder;
  criteria: string[];
  changeSet: ChangeSet;
  deterministic: SuiteResult;
  behavioral: SuiteResult;
  rubric: string[];
}

/** Input to `buildSemanticContext` — a closed shape with no transcript field. */
export interface SemanticContextInput {
  workOrder: WorkOrder;
  changeSet: ChangeSet;
  deterministic: SuiteResult;
  behavioral: SuiteResult;
  criteria?: string[];
  rubric?: string[];
}

/** One judge ruling on one acceptance criterion. */
export interface JudgeRuling {
  criterion: string;
  /** `true` means the judge found the criterion falsified (not met). */
  falsified: boolean;
  evidence: CheckEvidence;
  diagnosis?: string;
  action?: string;
}

/** The injectable semantic judge. Tests supply a fake; no network. */
export interface SemanticJudge {
  /** Judge identity, used for provenance and writer≠verifier enforcement. */
  identity: ModelIdentity;
  falsify(context: SemanticContext): JudgeRuling[] | Promise<JudgeRuling[]>;
}

/** One criterion's semantic verdict. */
export interface SemanticVerdict {
  criterion: string;
  status: 'pass' | 'fail';
  evidence: CheckEvidence;
  diagnosis: string | null;
  action: string | null;
}

/**
 * The semantic tier's structured failure. It carries exactly E5.1's
 * `FailureRecord` fields (`Omit<FailureRecord, 'category'>`), with the
 * `semantic` category — so every tier's failure is one shape.
 */
export interface SemanticFailure extends Omit<FailureRecord, 'category'> {
  category: 'semantic';
}

/** Independence signals recorded on the result (spec §9). */
export interface SemanticProvenance {
  modelDifferent: boolean;
  familyDifferent: boolean;
  freshContext: true;
}

export interface SemanticVerificationResult {
  changeSetId: string;
  /** The generator identity the verifier was checked against (attested). */
  generator: ModelIdentity;
  verifier: ModelIdentity;
  prompt: PromptProvenance;
  provenance: SemanticProvenance;
  verdicts: SemanticVerdict[];
  failures: SemanticFailure[];
  passed: boolean;
}

export interface SemanticVerifierOptions {
  judge: SemanticJudge;
  /** The writer identity. Required: without it distinctness cannot be proven. */
  generator: ModelIdentity;
  prompt: PromptProvenance;
  rubric: string[];
}

export interface SemanticVerifyInput {
  workOrder: WorkOrder;
  changeSet: ChangeSet;
  deterministic: SuiteResult;
  behavioral: SuiteResult;
  /** Defaults to the Work Order's acceptance criteria. */
  criteria?: string[];
}

export interface SemanticVerifier {
  readonly identity: ModelIdentity;
  verify(input: SemanticVerifyInput): Promise<SemanticVerificationResult>;
}

/**
 * The only top-level fields the context builder accepts. A developer transcript
 * (or any other field) is rejected rather than quietly carried into the judge's
 * context — fresh context is enforced, not merely documented.
 */
const CONTEXT_INPUT_KEYS = new Set([
  'workOrder',
  'changeSet',
  'deterministic',
  'behavioral',
  'criteria',
  'rubric',
]);

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** A stable `provider/model` key for records that want a single string. */
export function modelKey(identity: ModelIdentity): string {
  return `${identity.provider}/${identity.model}`;
}

function cloneEvidence(evidence: CheckEvidence): CheckEvidence {
  return evidence.artifacts
    ? { summary: evidence.summary, artifacts: [...evidence.artifacts] }
    : { summary: evidence.summary };
}

function cloneCheck(check: CheckResult): CheckResult {
  return { ...check, criteria: [...check.criteria], evidence: cloneEvidence(check.evidence) };
}

function cloneSuite(suite: SuiteResult): SuiteResult {
  return { category: suite.category, checks: suite.checks.map(cloneCheck), passed: suite.passed };
}

function cloneChangeSet(changeSet: ChangeSet): ChangeSet {
  return {
    id: changeSet.id,
    attemptId: changeSet.attemptId,
    taskId: changeSet.taskId,
    diff: changeSet.diff,
    artifactIds: [...changeSet.artifactIds],
  };
}

/**
 * A field-by-field copy (never a spread) so extra runtime fields smuggled onto
 * the Work Order cannot ride into the judge's fresh context.
 */
function cloneWorkOrder(workOrder: WorkOrder): WorkOrder {
  return {
    id: workOrder.id,
    intent: workOrder.intent,
    acceptanceCriteria: [...workOrder.acceptanceCriteria],
    riskTier: workOrder.riskTier,
    constraints: [...workOrder.constraints],
    outOfScope: [...workOrder.outOfScope],
    repository: workOrder.repository,
    requiredVerification: [...workOrder.requiredVerification],
    state: workOrder.state,
    createdAt: workOrder.createdAt,
    updatedAt: workOrder.updatedAt,
  };
}

function cloneIdentity(identity: ModelIdentity): ModelIdentity {
  const copy: ModelIdentity = { provider: identity.provider, model: identity.model };
  if (identity.version !== undefined) copy.version = identity.version;
  if (identity.family !== undefined) copy.family = identity.family;
  return copy;
}

/** Keep only well-formed evidence. A ruling with no usable evidence cannot pass. */
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

function assertIdentity(identity: ModelIdentity | null | undefined, role: string): void {
  if (!identity || !nonEmpty(identity.provider) || !nonEmpty(identity.model)) {
    throw new VerificationConfigurationError(
      `semantic verifier requires a ${role} identity with a non-empty provider and model`,
    );
  }
}

/**
 * Enforce writer ≠ verifier. Same model name is rejected regardless of provider:
 * a model cannot sign off its own change, and an opaque model id is the identity
 * that matters. Case/whitespace differences must not be a loophole.
 */
function assertIndependent(generator: ModelIdentity, verifier: ModelIdentity): void {
  if (normalize(generator.model) === normalize(verifier.model)) {
    throw new VerificationConfigurationError(
      `same-model self-sign-off rejected: the generator and verifier are both "${verifier.model}"; the writer cannot be its own verifier`,
    );
  }
}

/**
 * Build the verifier's fresh context, copying every input so the judge cannot
 * reach the caller's objects. Throws on any field outside the closed shape, so
 * a developer transcript can never reach the judge.
 */
export function buildSemanticContext(input: SemanticContextInput): SemanticContext {
  for (const key of Object.keys(input)) {
    if (!CONTEXT_INPUT_KEYS.has(key)) {
      throw new VerificationConfigurationError(
        `semantic context rejects field "${key}": the verifier gets fresh context only — the work order, acceptance criteria, change set, tier results and rubric — never a developer transcript`,
      );
    }
  }

  return {
    workOrder: cloneWorkOrder(input.workOrder),
    criteria: [...(input.criteria ?? input.workOrder.acceptanceCriteria)],
    changeSet: cloneChangeSet(input.changeSet),
    deterministic: cloneSuite(input.deterministic),
    behavioral: cloneSuite(input.behavioral),
    rubric: [...(input.rubric ?? [])],
  };
}

function failedVerdict(
  criterion: string,
  evidence: CheckEvidence,
  diagnosis: string,
  action: string,
): SemanticVerdict {
  return { criterion, status: 'fail', evidence, diagnosis, action };
}

function familyDiffers(generator: ModelIdentity, verifier: ModelIdentity): boolean {
  const generatorFamily = nonEmpty(generator.family);
  const verifierFamily = nonEmpty(verifier.family);
  if (!generatorFamily || !verifierFamily) return false;
  return normalize(generatorFamily) !== normalize(verifierFamily);
}

export function createSemanticVerifier(options: SemanticVerifierOptions): SemanticVerifier {
  const { judge, prompt, rubric } = options;

  assertIdentity(options.generator, 'generator');
  if (!judge || !judge.identity) {
    throw new VerificationConfigurationError('semantic verifier requires a judge');
  }
  assertIdentity(judge.identity, 'verifier');

  // Snapshot every option: a caller mutating its own objects after construction
  // must not be able to forge provenance or swap the rubric mid-flight.
  const generator = cloneIdentity(options.generator);
  const verifier = cloneIdentity(judge.identity);
  assertIndependent(generator, verifier);

  const verifierKey = modelKey(verifier);
  const promptProvenance: PromptProvenance = { id: prompt.id, version: prompt.version };
  const rubricItems = [...rubric];

  async function verify(input: SemanticVerifyInput): Promise<SemanticVerificationResult> {
    const criteria = [...(input.criteria ?? input.workOrder.acceptanceCriteria)];
    const context = buildSemanticContext({
      workOrder: input.workOrder,
      changeSet: input.changeSet,
      deterministic: input.deterministic,
      behavioral: input.behavioral,
      criteria,
      rubric: rubricItems,
    });

    // A judge that throws must surface as structured failures, not a crash.
    let rulings: JudgeRuling[] = [];
    let thrown: string | null = null;
    try {
      const reported = await judge.falsify(context);
      rulings = Array.isArray(reported) ? reported : [];
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    const verdicts: SemanticVerdict[] = criteria.map((criterion) => {
      if (thrown !== null) {
        return failedVerdict(
          criterion,
          { summary: `semantic judge threw: ${thrown}` },
          'semantic judge threw before ruling',
          'fix the judge error and re-run semantic verification',
        );
      }

      const ruling = rulings.find((candidate) => candidate && candidate.criterion === criterion);
      if (!ruling) {
        return failedVerdict(
          criterion,
          { summary: `semantic judge returned no ruling for "${criterion}"` },
          `no semantic ruling for "${criterion}"`,
          're-run semantic verification with a judge that rules on every criterion',
        );
      }

      const evidence = normalizeEvidence(ruling.evidence);
      if (!evidence) {
        return failedVerdict(
          criterion,
          { summary: `semantic judge ruled on "${criterion}" without evidence` },
          `semantic ruling for "${criterion}" carried no evidence`,
          'require the judge to attach evidence and re-run semantic verification',
        );
      }

      if (ruling.falsified === true) {
        return failedVerdict(
          criterion,
          evidence,
          nonEmpty(ruling.diagnosis) ?? `semantic judge falsified "${criterion}"`,
          nonEmpty(ruling.action) ?? `address "${criterion}" and re-run semantic verification`,
        );
      }

      return { criterion, status: 'pass', evidence, diagnosis: null, action: null };
    });

    const failures: SemanticFailure[] = verdicts
      .filter((verdict) => verdict.status === 'fail')
      .map((verdict) => ({
        category: 'semantic',
        criterion: verdict.criterion,
        verifier: verifierKey,
        evidence: cloneEvidence(verdict.evidence),
        diagnosis: verdict.diagnosis ?? `semantic verifier falsified "${verdict.criterion}"`,
        action: verdict.action ?? `address "${verdict.criterion}" and re-run semantic verification`,
      }));

    return {
      changeSetId: input.changeSet.id,
      generator: cloneIdentity(generator),
      verifier: cloneIdentity(verifier),
      prompt: { id: promptProvenance.id, version: promptProvenance.version },
      provenance: {
        modelDifferent: normalize(generator.model) !== normalize(verifier.model),
        familyDifferent: familyDiffers(generator, verifier),
        freshContext: true,
      },
      verdicts,
      failures,
      // An empty criterion set verifies nothing: never a vacuous pass.
      passed: criteria.length > 0 && verdicts.every((verdict) => verdict.status === 'pass'),
    };
  }

  return { identity: verifier, verify };
}
