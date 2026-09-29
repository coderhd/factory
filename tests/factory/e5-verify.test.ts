import { describe, expect, it } from 'bun:test';

import type { Attempt, WorkOrder } from '../../src/factory/domain/workOrder';
import {
  BEHAVIORAL_CHECKS,
  CHECK_KINDS,
  DETERMINISTIC_CHECKS,
  changeSetFromAttempt,
  createVerificationEngine,
  type ChangeSet,
  type CheckCategory,
  type CheckEvidence,
  type CheckKind,
  type CheckProvider,
  type FailureRecord,
  type SuiteResult,
  VerificationConfigurationError,
  type VerificationRun,
} from '../../src/factory/verification/engine';
import {
  buildSemanticContext,
  createSemanticVerifier,
  type JudgeRuling,
  type ModelIdentity,
  type PromptProvenance,
  type SemanticJudge,
  type SemanticVerificationResult,
  type SemanticVerifyInput,
} from '../../src/factory/verification/semantic';
import {
  buildEvidenceBundle,
  type CriterionProof,
  type EvidenceBundleInput,
} from '../../src/factory/evidence/bundle';

/**
 * E5.1 (#18) verification engine harness. All checks here are FAKE providers —
 * no `tsc`, no Playwright, no network, no Docker. This file TDDs the pluggable
 * check-provider seam, the runner and the structured failure records; the real
 * providers and the semantic/evidence tiers land in later E5 slices.
 */

const baseChangeSet: ChangeSet = {
  id: 'cs_1',
  attemptId: 'attempt_1',
  taskId: 'task_1',
  diff: 'diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;',
  artifactIds: ['art_log', 'art_screenshot'],
};

/** A complete E1 Attempt fixture — the one place the cross-module shape is pinned. */
function makeAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: 'attempt_42',
    taskId: 'task_42',
    model: 'provider/model',
    workerId: 'worker_1',
    context: 'fresh',
    skills: ['typescript'],
    diff: 'diff --git a/b c/d',
    artifactIds: ['art_1'],
    interactionIds: [],
    verificationRunIds: [],
    environment: 'local',
    outcome: 'success',
    failureHistory: [],
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

/** A fake check that passes. */
function passing(
  id: string,
  category: CheckCategory,
  kind: CheckKind,
  summary = `${id}: ok`,
): CheckProvider {
  return { id, category, kind, run: () => ({ passed: true, evidence: { summary } }) };
}

/** A fake check that fails with a structured diagnosis + suggested action. */
function failing(
  id: string,
  category: CheckCategory,
  kind: CheckKind,
  overrides: Partial<{ summary: string; diagnosis: string; action: string }> = {},
): CheckProvider {
  return {
    id,
    category,
    kind,
    run: () => ({
      passed: false,
      evidence: {
        summary: overrides.summary ?? `${id}: assertion failed`,
        artifacts: [`${id}.log`],
      },
      diagnosis: overrides.diagnosis ?? `${id} reported failures`,
      action: overrides.action ?? `fix ${id} findings and re-run verification`,
    }),
  };
}

/** The canonical deterministic + behavioral fake suite used across cases. */
function standardEngine() {
  const engine = createVerificationEngine();
  engine.registerCheck(passing('typecheck', 'deterministic', 'typecheck'));
  engine.registerCheck(passing('lint', 'deterministic', 'lint'));
  engine.registerCheck(failing('unit', 'deterministic', 'unit'));
  engine.registerCheck(passing('build', 'deterministic', 'build'));
  engine.registerCheck(passing('playwright', 'behavioral', 'playwright'));
  engine.registerCheck(passing('contract', 'behavioral', 'contract'));
  return engine;
}

describe('E5.1 check taxonomy (spec §14.1/§14.2)', () => {
  it('exposes the canonical deterministic and behavioral check kinds', () => {
    expect([...DETERMINISTIC_CHECKS]).toEqual([
      'typecheck',
      'lint',
      'unit',
      'integration',
      'build',
      'security',
    ]);
    expect([...BEHAVIORAL_CHECKS]).toEqual([
      'playwright',
      'api',
      'contract',
      'visual',
      'db',
      'e2e',
    ]);
    expect([...CHECK_KINDS.deterministic]).toEqual([...DETERMINISTIC_CHECKS]);
    expect([...CHECK_KINDS.behavioral]).toEqual([...BEHAVIORAL_CHECKS]);
  });
});

describe('E5.1 change set conformance to E1/E3 shapes', () => {
  it('derives a change set from an E1 Attempt without mutating it', () => {
    const attempt: Attempt = makeAttempt();

    const changeSet = changeSetFromAttempt(attempt);

    expect(changeSet).toEqual({
      id: 'cs_attempt_42',
      attemptId: 'attempt_42',
      taskId: 'task_42',
      diff: 'diff --git a/b c/d',
      artifactIds: ['art_1'],
    });
    // Copied, not shared: mutating the change set must not touch the Attempt.
    changeSet.artifactIds.push('injected');
    expect(attempt.artifactIds).toEqual(['art_1']);
  });

  it('accepts a null diff (a failed Attempt with no change) unchanged', () => {
    const attempt = makeAttempt({ id: 'attempt_empty', diff: null, artifactIds: [] });
    const changeSet = changeSetFromAttempt(attempt);
    expect(changeSet.diff).toBeNull();
    expect(changeSet.artifactIds).toEqual([]);
  });
});

describe('E5.1 category registration', () => {
  it('registers checks by category and lists them, filtered or not', () => {
    const engine = standardEngine();

    expect(engine.listChecks().map((check) => check.id)).toEqual([
      'typecheck',
      'lint',
      'unit',
      'build',
      'playwright',
      'contract',
    ]);
    expect(engine.listChecks('deterministic').map((check) => check.id)).toEqual([
      'typecheck',
      'lint',
      'unit',
      'build',
    ]);
    expect(engine.listChecks('behavioral').map((check) => check.id)).toEqual([
      'playwright',
      'contract',
    ]);
  });

  it('rejects a check whose kind does not belong to its category', () => {
    const engine = createVerificationEngine();
    expect(() =>
      engine.registerCheck(passing('playwright', 'deterministic', 'playwright')),
    ).toThrow('incompatible kind');
    expect(() =>
      engine.registerCheck(passing('tsc', 'behavioral', 'typecheck')),
    ).toThrow('incompatible kind');
    expect(engine.listChecks()).toEqual([]);
  });

  it('rejects a duplicate check id instead of silently overriding it', () => {
    const engine = createVerificationEngine();
    engine.registerCheck(passing('tsc', 'deterministic', 'typecheck'));
    expect(() => engine.registerCheck(passing('tsc', 'deterministic', 'typecheck'))).toThrow(
      'duplicate check id: tsc',
    );
    expect(engine.listChecks()).toHaveLength(1);
  });

  it('rejects a check registered under an unknown category', () => {
    const engine = createVerificationEngine();
    expect(() =>
      engine.registerCheck({
        ...passing('mystery', 'deterministic', 'typecheck'),
        category: 'chaos' as unknown as CheckCategory,
      }),
    ).toThrow('unknown check category: chaos');
    expect(engine.listChecks()).toEqual([]);
  });

  it('rejects a provider whose id is empty or whitespace', () => {
    const engine = createVerificationEngine();
    expect(() => engine.registerCheck(passing('', 'deterministic', 'typecheck'))).toThrow(
      'non-empty id',
    );
    expect(() => engine.registerCheck(passing('   ', 'behavioral', 'e2e'))).toThrow(
      'non-empty id',
    );
    expect(engine.listChecks()).toEqual([]);
  });

  it('raises a structured configuration error, not a bare Error, for wiring mistakes', () => {
    const engine = createVerificationEngine();
    let caught: unknown;
    try {
      engine.registerCheck(passing('', 'deterministic', 'typecheck'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VerificationConfigurationError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as VerificationConfigurationError).category).toBe('configuration');
  });
});

describe('E5.1 runner: deterministic + behavioral suites, per-criterion results', () => {
  it('runs both suites and records a per-check result for every registered check', async () => {
    const run = await standardEngine().verify(baseChangeSet);

    expect(run.changeSetId).toBe('cs_1');
    expect(run.deterministic.category).toBe('deterministic');
    expect(run.behavioral.category).toBe('behavioral');

    expect(run.deterministic.checks.map((check) => [check.checkId, check.status])).toEqual([
      ['typecheck', 'pass'],
      ['lint', 'pass'],
      ['unit', 'fail'],
      ['build', 'pass'],
    ]);
    expect(run.behavioral.checks.map((check) => [check.checkId, check.status])).toEqual([
      ['playwright', 'pass'],
      ['contract', 'pass'],
    ]);

    for (const check of [...run.deterministic.checks, ...run.behavioral.checks]) {
      expect(check.verifier).toBe(check.checkId);
      expect(check.evidence.summary.length).toBeGreaterThan(0);
    }

    expect(run.deterministic.passed).toBe(false);
    expect(run.behavioral.passed).toBe(true);
    expect(run.passed).toBe(false);
  });

  it('keys per-criterion results by the caller-supplied mapping', async () => {
    const engine = standardEngine();
    const run = await engine.verify(baseChangeSet, {
      criteria: ['AC-typecheck', 'AC-unit', 'AC-browser'],
      criterionChecks: {
        'AC-typecheck': ['typecheck', 'lint'],
        'AC-unit': ['unit'],
        'AC-browser': ['playwright'],
      },
    });

    expect(run.criteria).toEqual([
      { criterion: 'AC-typecheck', status: 'pass', checkIds: ['typecheck', 'lint'] },
      { criterion: 'AC-unit', status: 'fail', checkIds: ['unit'] },
      { criterion: 'AC-browser', status: 'pass', checkIds: ['playwright'] },
    ]);

    // Evidence stays attached to the check that produced it.
    const unit = run.deterministic.checks.find((check) => check.checkId === 'unit');
    expect(unit?.evidence).toEqual({ summary: 'unit: assertion failed', artifacts: ['unit.log'] });
  });

  it('records an unmapped acceptance criterion explicitly, never a silent pass', async () => {
    const engine = standardEngine();
    const run = await engine.verify(baseChangeSet, {
      criteria: ['AC-covered', 'AC-gap'],
      criterionChecks: { 'AC-covered': ['typecheck'] },
    });

    expect(run.criteria).toEqual([
      { criterion: 'AC-covered', status: 'pass', checkIds: ['typecheck'] },
      { criterion: 'AC-gap', status: 'unmapped', checkIds: [] },
    ]);
    expect(run.passed).toBe(false);
  });

  it('passes a fully green run and records no failures', async () => {
    const engine = createVerificationEngine();
    engine.registerCheck(passing('typecheck', 'deterministic', 'typecheck'));
    engine.registerCheck(passing('playwright', 'behavioral', 'playwright'));

    const run: VerificationRun = await engine.verify(baseChangeSet, {
      criteria: ['AC-1'],
      criterionChecks: { 'AC-1': ['typecheck', 'playwright'] },
    });

    expect(run.passed).toBe(true);
    expect(run.failures).toEqual([]);
    expect(run.deterministic.passed).toBe(true);
    expect(run.behavioral.passed).toBe(true);
    expect(run.deterministic.checks[0]?.status).toBe('pass');
    expect(run.deterministic.checks[0]?.diagnosis).toBeNull();
  });

  it('supports asynchronous providers', async () => {
    const engine = createVerificationEngine();
    engine.registerCheck({
      id: 'async-e2e',
      category: 'behavioral',
      kind: 'e2e',
      run: async () => ({ passed: true, evidence: { summary: 'async e2e ok' } }),
    });

    const run = await engine.verify(baseChangeSet);
    expect(run.behavioral.checks).toEqual([
      {
        checkId: 'async-e2e',
        category: 'behavioral',
        kind: 'e2e',
        verifier: 'async-e2e',
        criteria: [],
        status: 'pass',
        evidence: { summary: 'async e2e ok' },
        diagnosis: null,
        action: null,
      },
    ]);
  });

  it('rejects a mapping that names an unregistered check', async () => {
    await expect(
      standardEngine().verify(baseChangeSet, {
        criteria: ['AC-1'],
        criterionChecks: { 'AC-1': ['does-not-exist'] },
      }),
    ).rejects.toThrow('unknown check');
  });

  it('fails closed on an empty run instead of a vacuous pass', async () => {
    const run = await createVerificationEngine().verify(baseChangeSet);
    expect(run.deterministic.checks).toEqual([]);
    expect(run.behavioral.checks).toEqual([]);
    expect(run.criteria).toEqual([]);
    expect(run.failures).toEqual([]);
    // No check executed, so the run proved nothing: never a silent pass.
    expect(run.passed).toBe(false);
  });

  it('fails closed when criteria are supplied but no check is registered', async () => {
    const run = await createVerificationEngine().verify(baseChangeSet, {
      criteria: ['AC-1'],
      criterionChecks: { 'AC-1': [] },
    });
    expect(run.criteria).toEqual([{ criterion: 'AC-1', status: 'unmapped', checkIds: [] }]);
    expect(run.passed).toBe(false);
  });
});

describe('E5.1 structured failure records', () => {
  it('emits exactly the spec fields for a failed check', async () => {
    const engine = createVerificationEngine();
    engine.registerCheck(
      failing('unit', 'deterministic', 'unit', {
        summary: '2 of 9 tests failed',
        diagnosis: 'total() drops the last item',
        action: 'fix the reducer in src/cart.ts',
      }),
    );

    const run = await engine.verify(baseChangeSet, {
      criteria: ['AC-cart'],
      criterionChecks: { 'AC-cart': ['unit'] },
    });

    expect(run.failures).toHaveLength(1);
    const failure = run.failures[0]!;
    expect(Object.keys(failure).sort()).toEqual([
      'action',
      'category',
      'criterion',
      'diagnosis',
      'evidence',
      'verifier',
    ]);
    expect(failure).toEqual({
      category: 'deterministic',
      criterion: 'AC-cart',
      verifier: 'unit',
      evidence: { summary: '2 of 9 tests failed', artifacts: ['unit.log'] },
      diagnosis: 'total() drops the last item',
      action: 'fix the reducer in src/cart.ts',
    });
  });

  it('attributes an unmapped failing check with a null criterion (never silent)', async () => {
    const run = await standardEngine().verify(baseChangeSet);

    expect(run.failures).toHaveLength(1);
    expect(run.failures[0]?.criterion).toBeNull();
    expect(run.failures[0]?.verifier).toBe('unit');
    expect(run.failures[0]?.diagnosis).toBe('unit reported failures');
    expect(run.failures[0]?.action).toBe('fix unit findings and re-run verification');
  });

  it('emits one structured failure per criterion when one check covers several', async () => {
    const engine = createVerificationEngine();
    engine.registerCheck(failing('lint', 'deterministic', 'lint'));

    const run = await engine.verify(baseChangeSet, {
      criteria: ['AC-a', 'AC-b'],
      criterionChecks: { 'AC-a': ['lint'], 'AC-b': ['lint'] },
    });

    expect(run.failures.map((failure) => failure.criterion)).toEqual(['AC-a', 'AC-b']);
    expect(run.criteria.map((criterion) => criterion.status)).toEqual(['fail', 'fail']);
  });

  it('turns a thrown provider into a structured failure instead of a crash', async () => {
    const engine = createVerificationEngine();
    engine.registerCheck({
      id: 'flaky',
      category: 'deterministic',
      kind: 'security',
      run: () => {
        throw new Error('scanner binary missing');
      },
    });

    const run = await engine.verify(baseChangeSet);

    expect(run.deterministic.checks[0]?.status).toBe('fail');
    expect(run.failures).toHaveLength(1);
    const failure = run.failures[0]!;
    expect(failure.verifier).toBe('flaky');
    expect(failure.evidence.summary).toContain('scanner binary missing');
    expect(failure.diagnosis.length).toBeGreaterThan(0);
    expect(failure.action.length).toBeGreaterThan(0);
  });

  it('turns a malformed provider result into a structured failure instead of a crash', async () => {
    const engine = createVerificationEngine();
    engine.registerCheck({
      id: 'malformed',
      category: 'behavioral',
      kind: 'visual',
      run: () => null as unknown as ReturnType<CheckProvider['run']>,
    });

    const run = await engine.verify(baseChangeSet);

    expect(run.behavioral.checks[0]?.status).toBe('fail');
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0]?.verifier).toBe('malformed');
    expect(run.passed).toBe(false);
  });

  it('refuses to pass a check that supplied no evidence', async () => {
    const engine = createVerificationEngine();
    engine.registerCheck({
      id: 'evidence-less',
      category: 'deterministic',
      kind: 'build',
      // Defensive runtime shape: no evidence at all despite claiming a pass.
      run: () => ({ passed: true }) as unknown as ReturnType<CheckProvider['run']>,
    });

    const run = await engine.verify(baseChangeSet);

    expect(run.deterministic.checks[0]?.status).toBe('fail');
    expect(run.failures[0]?.diagnosis).toContain('evidence');
    expect(run.passed).toBe(false);
  });
});

describe('E5.1 engine mutates nothing', () => {
  it('leaves the change set and verify options untouched, even if a provider tries to write', async () => {
    const changeSet: ChangeSet = {
      id: 'cs_mut',
      attemptId: 'attempt_mut',
      taskId: 'task_mut',
      diff: 'diff --git a/x b/x',
      artifactIds: ['art_1'],
    };
    const changeSetSnapshot = structuredClone(changeSet);
    const criteria = ['AC-1'];
    const criterionChecks = { 'AC-1': ['mutator'] };
    const optionsSnapshot = structuredClone({ criteria, criterionChecks });

    const engine = createVerificationEngine();
    engine.registerCheck({
      id: 'mutator',
      category: 'deterministic',
      kind: 'lint',
      run: (context) => {
        // A misbehaving provider must not be able to reach the caller's object.
        context.changeSet.artifactIds.push('injected');
        context.changeSet.diff = 'overwritten';
        return { passed: true, evidence: { summary: 'ok' } };
      },
    });

    await engine.verify(changeSet, { criteria, criterionChecks });

    expect(changeSet).toEqual(changeSetSnapshot);
    expect({ criteria, criterionChecks }).toEqual(optionsSnapshot);
    expect(engine.listChecks().map((check) => check.id)).toEqual(['mutator']);
  });

  it('records verdicts as fresh records, not references into provider return values', async () => {
    const evidence = { summary: 'shared evidence', artifacts: ['a.log'] };
    const engine = createVerificationEngine();
    engine.registerCheck({
      id: 'shared',
      category: 'deterministic',
      kind: 'unit',
      run: () => ({ passed: true, evidence }),
    });

    const run = await engine.verify(baseChangeSet);
    expect(run.deterministic.checks[0]?.evidence).not.toBe(evidence);
    expect(run.deterministic.checks[0]?.evidence).toEqual(evidence);
    // Mutating the engine's copy cannot corrupt the provider's object.
    run.deterministic.checks[0]!.evidence.artifacts?.push('later');
    expect(evidence.artifacts).toEqual(['a.log']);
  });
});

/**
 * E5.2 (#19) independent semantic verifier + immutable Evidence Bundle. The
 * judge is always a FAKE (hermetic; no model, no network); the verifier must
 * falsify ACs from fresh context, never the developer transcript, and never be
 * the same model that wrote the change.
 */

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo_1',
    intent: 'Add a cart total',
    acceptanceCriteria: ['AC-cart-total', 'AC-cart-empty'],
    riskTier: 'YELLOW',
    constraints: [],
    outOfScope: [],
    repository: null,
    requiredVerification: [],
    state: 'VERIFYING',
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

const generatorIdentity: ModelIdentity = {
  provider: 'opencode-go',
  model: 'writer-1',
  family: 'fam-writer',
};
const judgeIdentity: ModelIdentity = {
  provider: 'opencode-go',
  model: 'judge-1',
  family: 'fam-judge',
};
const promptProvenance: PromptProvenance = { id: 'semantic-rubric', version: 'v1' };

function suiteOf(category: CheckCategory, passed = true): SuiteResult {
  return { category, checks: [], passed };
}

function semanticInput(overrides: Partial<SemanticVerifyInput> = {}): SemanticVerifyInput {
  return {
    workOrder: makeWorkOrder(),
    changeSet: baseChangeSet,
    deterministic: suiteOf('deterministic'),
    behavioral: suiteOf('behavioral'),
    ...overrides,
  };
}

function passRulings(criteria: string[], identity: ModelIdentity = judgeIdentity): JudgeRuling[] {
  return criteria.map((criterion) => ({
    criterion,
    falsified: false,
    evidence: { summary: `${criterion}: survived "${identity.model}" falsification` },
  }));
}

function falsifyingRulings(criteria: string[]): JudgeRuling[] {
  return criteria.map((criterion) => ({
    criterion,
    falsified: true,
    evidence: { summary: `${criterion}: counterexample found in the diff` },
    diagnosis: `${criterion} not satisfied`,
    action: `fix ${criterion}`,
  }));
}

function judgeReturning(rulings: JudgeRuling[], identity: ModelIdentity = judgeIdentity): SemanticJudge {
  return { identity, falsify: () => rulings };
}

function semanticVerifier(judge: SemanticJudge, generator: ModelIdentity = generatorIdentity) {
  return createSemanticVerifier({
    judge,
    generator,
    prompt: promptProvenance,
    rubric: ['seek counterexamples, not confirmation'],
  });
}

const FRESH_CONTEXT_KEYS = [
  'behavioral',
  'changeSet',
  'criteria',
  'deterministic',
  'rubric',
  'workOrder',
];

describe('E5.2 semantic verifier: fresh context (spec §9)', () => {
  it('carries the work order, ACs, change set, tier results and rubric — and nothing else', () => {
    const context = buildSemanticContext({
      workOrder: makeWorkOrder(),
      changeSet: baseChangeSet,
      deterministic: suiteOf('deterministic'),
      behavioral: suiteOf('behavioral'),
      rubric: ['seek counterexamples'],
    });

    expect(Object.keys(context).sort()).toEqual(FRESH_CONTEXT_KEYS);
    expect(context.criteria).toEqual(['AC-cart-total', 'AC-cart-empty']);
    expect(context.rubric).toEqual(['seek counterexamples']);
    expect(context.changeSet).toEqual(baseChangeSet);
    expect('transcript' in context).toBe(false);
  });

  it('refuses a developer transcript supplied to the context builder', () => {
    expect(() =>
      buildSemanticContext({
        workOrder: makeWorkOrder(),
        changeSet: baseChangeSet,
        deterministic: suiteOf('deterministic'),
        behavioral: suiteOf('behavioral'),
        rubric: [],
        transcript: 'the developer reasoned like so...',
      } as unknown as Parameters<typeof buildSemanticContext>[0]),
    ).toThrow('rejects field "transcript"');
  });

  it('hands the judge a private change set, never the caller object', async () => {
    const changeSet: ChangeSet = { ...baseChangeSet, artifactIds: ['art_1'] };
    const snapshot = structuredClone(changeSet);
    const judge: SemanticJudge = {
      identity: judgeIdentity,
      falsify: (context) => {
        // A misbehaving judge must not be able to reach the caller's object.
        context.changeSet.artifactIds.push('injected');
        context.changeSet.diff = 'overwritten';
        return passRulings(context.criteria);
      },
    };

    await semanticVerifier(judge).verify(semanticInput({ changeSet }));

    expect(changeSet).toEqual(snapshot);
  });

  it('honours a caller-supplied criterion list over the work order default', async () => {
    const judge = judgeReturning(passRulings(['AC-subset']));
    const result = await semanticVerifier(judge).verify(semanticInput({ criteria: ['AC-subset'] }));
    expect(result.verdicts.map((verdict) => verdict.criterion)).toEqual(['AC-subset']);
  });

  it('drops runtime fields smuggled onto the work order', () => {
    const workOrder = {
      ...makeWorkOrder(),
      transcript: 'developer reasoning',
    } as unknown as WorkOrder;

    const context = buildSemanticContext({
      workOrder,
      changeSet: baseChangeSet,
      deterministic: suiteOf('deterministic'),
      behavioral: suiteOf('behavioral'),
      rubric: [],
    });

    expect('transcript' in context.workOrder).toBe(false);
    expect(JSON.stringify(context)).not.toContain('developer reasoning');
  });
});

describe('E5.2 writer ≠ verifier (spec §9)', () => {
  it('rejects a same-model self-sign-off', () => {
    const judge = judgeReturning([], generatorIdentity);
    expect(() => semanticVerifier(judge, generatorIdentity)).toThrow('same-model self-sign-off');
  });

  it('rejects the same model name even when the provider differs', () => {
    const judge = judgeReturning([], { provider: 'other-provider', model: 'writer-1', family: 'fam-judge' });
    expect(() => semanticVerifier(judge)).toThrow('same-model self-sign-off');
  });

  it('rejects a model id that only differs by case or whitespace', () => {
    const judge = judgeReturning([], { provider: 'opencode-go', model: '  WRITER-1 ', family: 'fam-judge' });
    expect(() => semanticVerifier(judge)).toThrow('same-model self-sign-off');
  });

  it('refuses to verify when the generator identity is missing', () => {
    expect(() =>
      createSemanticVerifier({
        judge: judgeReturning([]),
        generator: undefined as unknown as ModelIdentity,
        prompt: promptProvenance,
        rubric: [],
      }),
    ).toThrow('generator identity');
  });

  it('accepts an independent model and attests model/family difference', async () => {
    const result = await semanticVerifier(
      judgeReturning(passRulings(['AC-cart-total', 'AC-cart-empty'])),
    ).verify(semanticInput());

    expect(result.provenance).toEqual({ modelDifferent: true, familyDifferent: true, freshContext: true });
    expect(result.generator).toEqual(generatorIdentity);
    expect(result.verifier).toEqual(judgeIdentity);
    expect(result.prompt).toEqual(promptProvenance);
    expect(result.changeSetId).toBe('cs_1');
  });

  it('permits a different model in the same family but records familyDifferent=false', async () => {
    const sameFamilyJudge = judgeReturning(passRulings(['AC-cart-total', 'AC-cart-empty']), {
      provider: 'opencode-go',
      model: 'judge-2',
      family: 'fam-writer',
    });
    const result = await semanticVerifier(sameFamilyJudge).verify(semanticInput());

    expect(result.provenance.modelDifferent).toBe(true);
    expect(result.provenance.familyDifferent).toBe(false);
    expect(result.passed).toBe(true);
  });

  it('snapshots the generator identity, so later mutation cannot forge provenance', async () => {
    const mutableGenerator: ModelIdentity = {
      provider: 'opencode-go',
      model: 'writer-1',
      family: 'fam-writer',
    };
    const verifier = semanticVerifier(
      judgeReturning(passRulings(['AC-cart-total', 'AC-cart-empty'])),
      mutableGenerator,
    );

    // Forge the generator's identity after construction.
    mutableGenerator.model = 'judge-1';

    const result = await verifier.verify(semanticInput());
    expect(result.generator.model).toBe('writer-1');
    expect(result.provenance.modelDifferent).toBe(true);
  });
});

describe('E5.2 semantic falsification (spec §14.3)', () => {
  it('falsifies every AC and feeds the same structured failure shape', async () => {
    const judge = judgeReturning(falsifyingRulings(['AC-cart-total', 'AC-cart-empty']));

    const result = await semanticVerifier(judge).verify(semanticInput());

    expect(result.verdicts.map((verdict) => [verdict.criterion, verdict.status])).toEqual([
      ['AC-cart-total', 'fail'],
      ['AC-cart-empty', 'fail'],
    ]);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);

    const failure = result.failures[0]!;
    // Exactly E5.1's FailureRecord fields: same shape, `semantic` category.
    const failureKeys: Array<keyof FailureRecord> = [
      'category',
      'criterion',
      'verifier',
      'evidence',
      'diagnosis',
      'action',
    ];
    expect(Object.keys(failure).sort()).toEqual([...failureKeys].sort());
    expect(failure.category).toBe('semantic');
    expect(failure.criterion).toBe('AC-cart-total');
    expect(failure.verifier).toBe('opencode-go/judge-1');
    expect(failure.evidence.summary).toContain('counterexample');
    expect(failure.diagnosis).toBe('AC-cart-total not satisfied');
    expect(failure.action).toBe('fix AC-cart-total');
  });

  it('fails closed when the judge returns no ruling for an AC', async () => {
    const judge = judgeReturning([
      { criterion: 'AC-cart-total', falsified: false, evidence: { summary: 'no counterexample' } },
    ]);
    const result = await semanticVerifier(judge).verify(semanticInput());

    expect(result.verdicts.map((verdict) => verdict.status)).toEqual(['pass', 'fail']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.criterion).toBe('AC-cart-empty');
    expect(result.failures[0]!.diagnosis).toContain('no semantic ruling');
    expect(result.passed).toBe(false);
  });

  it('turns a thrown judge into structured failures, never a crash', async () => {
    const judge: SemanticJudge = {
      identity: judgeIdentity,
      falsify: () => {
        throw new Error('judge model offline');
      },
    };
    const result = await semanticVerifier(judge).verify(semanticInput());

    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]!.evidence.summary).toContain('judge model offline');
    expect(result.failures[0]!.diagnosis.length).toBeGreaterThan(0);
    expect(result.failures[0]!.action.length).toBeGreaterThan(0);
  });

  it('refuses to pass a ruling that carried no evidence', async () => {
    const judge = judgeReturning([
      { criterion: 'AC-cart-total', falsified: false, evidence: undefined as unknown as CheckEvidence },
    ]);
    const result = await semanticVerifier(judge).verify(semanticInput({ criteria: ['AC-cart-total'] }));

    expect(result.verdicts[0]!.status).toBe('fail');
    expect(result.failures[0]!.diagnosis).toContain('no evidence');
    expect(result.passed).toBe(false);
  });

  it('fails closed on an empty acceptance-criterion set', async () => {
    const result = await semanticVerifier(judgeReturning([])).verify(semanticInput({ criteria: [] }));

    expect(result.verdicts).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(false);
  });

  it('passes only when every AC survives falsification', async () => {
    const judge = judgeReturning(passRulings(['AC-cart-total', 'AC-cart-empty']));
    const result = await semanticVerifier(judge).verify(semanticInput());

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.verdicts.every((verdict) => verdict.status === 'pass')).toBe(true);
  });
});

/** A real E5.1 run covering both ACs with a deterministic and a behavioral check. */
async function greenRun(): Promise<VerificationRun> {
  const engine = createVerificationEngine();
  engine.registerCheck(passing('typecheck', 'deterministic', 'typecheck'));
  engine.registerCheck(passing('playwright', 'behavioral', 'playwright'));
  return engine.verify(baseChangeSet, {
    criteria: ['AC-cart-total', 'AC-cart-empty'],
    criterionChecks: { 'AC-cart-total': ['typecheck'], 'AC-cart-empty': ['playwright'] },
  });
}

async function passedSemantic(): Promise<SemanticVerificationResult> {
  return semanticVerifier(judgeReturning(passRulings(['AC-cart-total', 'AC-cart-empty']))).verify(
    semanticInput(),
  );
}

function generatorAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return makeAttempt({ id: 'attempt_1', taskId: 'task_1', outcome: 'success', artifactIds: ['art_1'], ...overrides });
}

async function greenBundleInput(): Promise<EvidenceBundleInput> {
  return {
    workOrder: makeWorkOrder(),
    changeSet: baseChangeSet,
    run: await greenRun(),
    semantic: await passedSemantic(),
    attempts: [generatorAttempt()],
    now: '2026-09-30T12:00:00.000Z',
  };
}

const EVIDENCE_BUNDLE_KEYS = [
  'advisory',
  'attempts',
  'changeSetId',
  'complete',
  'createdAt',
  'criteria',
  'gates',
  'id',
  'provenance',
  'tierSignOff',
  'workOrderId',
];

describe('E5.2 Evidence Bundle: every AC maps to proof (spec §5.4/§14.4)', () => {
  it('contains ac→proof, gates, provenance, tier sign-off and attempt history', async () => {
    const bundle = buildEvidenceBundle(await greenBundleInput());

    expect(Object.keys(bundle).sort()).toEqual(EVIDENCE_BUNDLE_KEYS);
    expect(bundle.id.startsWith('eb_')).toBe(true);
    expect(bundle.workOrderId).toBe('wo_1');
    expect(bundle.changeSetId).toBe('cs_1');
    expect(bundle.createdAt).toBe('2026-09-30T12:00:00.000Z');

    expect(bundle.criteria.map((criterion) => [criterion.criterion, criterion.status])).toEqual([
      ['AC-cart-total', 'pass'],
      ['AC-cart-empty', 'pass'],
    ]);
    expect(bundle.criteria[0]!.proofs.map((proof) => [proof.tier, proof.verifier, proof.status])).toEqual([
      ['deterministic', 'typecheck', 'pass'],
      ['semantic', 'opencode-go/judge-1', 'pass'],
    ]);

    expect(bundle.gates).toEqual({ deterministic: true, behavioral: true, semantic: true, run: true });
    expect(bundle.provenance).toEqual({
      generator: generatorIdentity,
      verifier: judgeIdentity,
      prompt: promptProvenance,
      modelDifferent: true,
      familyDifferent: true,
      freshContext: true,
    });
    expect(bundle.tierSignOff).toEqual([
      { tier: 'deterministic', signedOff: true, verifiers: ['typecheck'] },
      { tier: 'behavioral', signedOff: true, verifiers: ['playwright'] },
      { tier: 'semantic', signedOff: true, verifiers: ['opencode-go/judge-1'] },
    ]);
    expect(bundle.attempts).toEqual([
      {
        attemptId: 'attempt_1',
        model: 'provider/model',
        outcome: 'success',
        failureCount: 0,
        artifactIds: ['art_1'],
        createdAt: '2026-09-30T00:00:00.000Z',
      },
    ]);
    expect(bundle.complete).toBe(true);
  });

  it('marks an AC with no proof as uncovered and fails the bundle closed', async () => {
    const input = await greenBundleInput();
    const bundle = buildEvidenceBundle({
      ...input,
      workOrder: makeWorkOrder({
        acceptanceCriteria: ['AC-cart-total', 'AC-cart-empty', 'AC-untested'],
      }),
    });

    expect(bundle.criteria.find((criterion) => criterion.criterion === 'AC-untested')).toEqual({
      criterion: 'AC-untested',
      status: 'uncovered',
      proofs: [],
    });
    expect(bundle.criteria.map((criterion) => criterion.status)).toEqual(['pass', 'pass', 'uncovered']);
    expect(bundle.complete).toBe(false);
  });

  it('gates on the run-level result, never a vacuously-passing per-category suite', async () => {
    const emptyRun: VerificationRun = {
      changeSetId: 'cs_1',
      deterministic: { category: 'deterministic', checks: [], passed: true },
      behavioral: { category: 'behavioral', checks: [], passed: true },
      criteria: [],
      failures: [],
      passed: false,
    };
    const bundle = buildEvidenceBundle({ ...(await greenBundleInput()), run: emptyRun });

    // Per-category `passed` is vacuously true; that is not tier coverage.
    expect(emptyRun.deterministic.passed).toBe(true);
    expect(emptyRun.behavioral.passed).toBe(true);
    expect(bundle.gates.deterministic).toBe(false);
    expect(bundle.gates.behavioral).toBe(false);
    expect(bundle.gates.run).toBe(false);
    expect(bundle.complete).toBe(false);
  });

  it('does not treat an empty acceptance-criterion set as complete', async () => {
    const input = await greenBundleInput();
    const bundle = buildEvidenceBundle({
      ...input,
      workOrder: makeWorkOrder({ acceptanceCriteria: [] }),
      run: await createVerificationEngine().verify(baseChangeSet),
      semantic: await semanticVerifier(judgeReturning([])).verify(semanticInput({ criteria: [] })),
    });

    expect(bundle.criteria).toEqual([]);
    expect(bundle.complete).toBe(false);
  });

  it('refuses to assemble a bundle whose tiers describe a different change set', async () => {
    const input = await greenBundleInput();
    expect(() =>
      buildEvidenceBundle({ ...input, changeSet: { ...baseChangeSet, id: 'cs_other' } }),
    ).toThrow('change set');
  });

  it('records a curated attempt history, never the developer transcript', async () => {
    const attempt = generatorAttempt({
      diff: 'diff --git a/secret.ts b/secret.ts',
      interactionIds: ['chat_1'],
      failureHistory: [{ at: '2026-09-30T00:00:00.000Z', failure: 'flaky test' }],
    });
    const bundle = buildEvidenceBundle({ ...(await greenBundleInput()), attempts: [attempt] });

    expect(Object.keys(bundle.attempts[0]!).sort()).toEqual([
      'artifactIds',
      'attemptId',
      'createdAt',
      'failureCount',
      'model',
      'outcome',
    ]);
    expect(bundle.attempts[0]!.failureCount).toBe(1);
    expect(JSON.stringify(bundle)).not.toContain('secret.ts');
    expect(JSON.stringify(bundle)).not.toContain('chat_1');
  });

  it('records the agent self-assessment as advisory and never gates on it', async () => {
    const falsified = await semanticVerifier(
      judgeReturning(falsifyingRulings(['AC-cart-total'])),
    ).verify(semanticInput());

    const bundle = buildEvidenceBundle({ ...(await greenBundleInput()), semantic: falsified });

    expect(bundle.advisory.selfAssessment).toBe('success');
    expect(bundle.complete).toBe(false);
    expect(bundle.criteria.find((criterion) => criterion.criterion === 'AC-cart-total')!.status).toBe(
      'fail',
    );
  });

  it('is immutable once produced', async () => {
    const bundle = buildEvidenceBundle(await greenBundleInput());

    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.criteria)).toBe(true);
    expect(Object.isFrozen(bundle.criteria[0])).toBe(true);
    expect(Object.isFrozen(bundle.criteria[0]!.proofs)).toBe(true);
    expect(Object.isFrozen(bundle.criteria[0]!.proofs[0]!.evidence)).toBe(true);
    expect(Object.isFrozen(bundle.provenance)).toBe(true);
    expect(Object.isFrozen(bundle.gates)).toBe(true);
    expect(Object.isFrozen(bundle.attempts)).toBe(true);

    expect(() =>
      (bundle.criteria as CriterionProof[]).push({ criterion: 'x', status: 'pass', proofs: [] }),
    ).toThrow();
    expect(() => {
      (bundle as { complete: boolean }).complete = false;
    }).toThrow();
    expect(() => {
      (bundle.criteria[0] as { status: string }).status = 'fail';
    }).toThrow();
  });

  it('copies its inputs, so later mutation cannot rewrite the receipt', async () => {
    const input = await greenBundleInput();
    const bundle = buildEvidenceBundle(input);
    const before = structuredClone(bundle);

    input.semantic.verdicts[0]!.evidence.summary = 'tampered';
    input.run.criteria[0]!.status = 'fail';
    input.attempts[0]!.artifactIds.push('injected');
    input.changeSet.artifactIds.push('injected');

    expect(bundle).toEqual(before);
  });

  it('does not mutate the implementation while assembling evidence', async () => {
    const input = await greenBundleInput();
    const snapshot = {
      changeSet: structuredClone(input.changeSet),
      run: structuredClone(input.run),
      semantic: structuredClone(input.semantic),
    };

    buildEvidenceBundle(input);

    expect(input.changeSet).toEqual(snapshot.changeSet);
    expect(input.run).toEqual(snapshot.run);
    expect(input.semantic).toEqual(snapshot.semantic);
  });
});
