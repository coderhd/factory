import { describe, expect, it } from 'bun:test';

import type { Attempt } from '../../src/factory/domain/workOrder';
import {
  BEHAVIORAL_CHECKS,
  CHECK_KINDS,
  DETERMINISTIC_CHECKS,
  changeSetFromAttempt,
  createVerificationEngine,
  type ChangeSet,
  type CheckCategory,
  type CheckKind,
  type CheckProvider,
  type VerificationRun,
} from '../../src/factory/verification/engine';

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
    const attempt: Attempt = {
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
    };

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
    const attempt = { id: 'attempt_empty', taskId: 'task_1', diff: null, artifactIds: [] };
    const changeSet = changeSetFromAttempt(attempt as Attempt);
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

  it('runs an empty engine as a vacuous pass', async () => {
    const run = await createVerificationEngine().verify(baseChangeSet);
    expect(run.deterministic.checks).toEqual([]);
    expect(run.behavioral.checks).toEqual([]);
    expect(run.criteria).toEqual([]);
    expect(run.failures).toEqual([]);
    expect(run.passed).toBe(true);
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
