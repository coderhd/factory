import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SuiteResult } from './engine';
import {
  createHerdrWorker,
  type ExecutionEnvelope,
  type HerdrCli,
  type HerdrWorkspaceManager,
} from '../workers/herdr';
import type { JudgeRuling, ModelIdentity, SemanticContext, SemanticJudge } from './semantic';

/**
 * E11.2 (#42) — the production `SemanticJudge`: the independent verifier runs
 * as an opencode harness in a **fresh herdr pane** (its own tab, a different
 * model than the developer — writer ≠ verifier), prompted with the Work Order,
 * acceptance criteria, change set, deterministic/behavioral results and rubric —
 * **never the developer transcript** — and returns per-criterion falsification
 * rulings through a report file.
 *
 * This reuses #44's herdr plumbing wholesale (the injectable `HerdrCli` seam,
 * the workspace-ensured once, tab-per-run, `agent start --kind <harness>`,
 * `agent prompt --wait`, the report-file collection and the zero-at-rest
 * teardown) rather than duplicating it: the judge is just a second worker
 * adapter over the shared `factory` workspace, whose pane cwd is its own fresh
 * temporary directory. Two files define the judged run's contract:
 *
 *   - `.factory/report.json` — the #44 worker report (completion gate);
 *   - `.factory/judge-verdict.json` — the structured verdict (ruling per
 *     acceptance criterion).
 *
 * Hermetic (R5): the CLI is injected; production passes the real process CLI
 * from {@link createProcessHerdrCli}. No judge path spawns anything itself.
 */

/** The verdict file (relative to the judge pane's cwd). */
export const JUDGE_VERDICT_RELATIVE = join('.factory', 'judge-verdict.json');

/** Render suite results into the judge prompt's evidence section. */
function suiteLines(label: string, suite: SuiteResult): string[] {
  const lines = [`${label} (${suite.checks.length} check(s)):`];
  if (suite.checks.length === 0) {
    lines.push('  (no checks ran — this tier proves nothing)');
    return lines;
  }
  for (const check of suite.checks) {
    lines.push(
      `- ${check.checkId} [${check.kind}] passed=${check.status === 'pass'}: ${check.evidence.summary}`,
    );
  }
  return lines;
}

/**
 * Render the judge's fresh-context prompt. Every field the judge may reason
 * over is materialised here; anything left out (deliberately: the developer's
 * transcript, reasoning or chat history) does not exist in the document.
 */
export function renderJudgePrompt(context: SemanticContext): string {
  return [
    'You are the Factory independent semantic verifier.',
    'Writer ≠ Verifier: you did not produce this change, and you receive FRESH CONTEXT ONLY.',
    'Judge only from the material below — try to FALSIFY each acceptance criterion.',
    '',
    `Work Order ${context.workOrder.id} (risk tier ${context.workOrder.riskTier}) intent:`,
    context.workOrder.intent,
    '',
    `Acceptance criteria — rule on EVERY one (${context.criteria.length}):`,
    ...context.criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    'Change set to verify:',
    context.changeSet.diff && context.changeSet.diff.trim().length > 0
      ? context.changeSet.diff
      : '(empty diff)',
    '',
    ...suiteLines('Deterministic verification results', context.deterministic),
    '',
    ...suiteLines('Behavioral verification results', context.behavioral),
    ...(context.rubric.length > 0 ? ['', 'Rubric:', ...context.rubric.map((item) => `- ${item}`)] : []),
    '',
    'Verdict contract — when your judgment is complete, write BOTH files in the current directory:',
    `1. \`${JUDGE_VERDICT_RELATIVE}\` — JSON:`,
    '   {"rulings":[{"criterion":"<exact criterion text>","falsified":true|false,',
    '     "evidence":{"summary":"<what you actually observed>","artifacts":["<path>", "..."(optional)]},',
    '     "diagnosis":"<why it failed, required when falsified>",',
    '     "action":"<what to do about it, required when falsified"}]}',
    '   One ruling per criterion, `criterion` verbatim from the list above.',
    '   `falsified=true` means you found the criterion NOT met. Every ruling needs a non-empty evidence.summary.',
    `2. \`.factory/report.json\` — the run report: {"status":"completed","observations":[ "..."],"artifacts":[],"interactions":[],"verificationRequests":[],"failure":null}`,
    'Without both files the run fails closed — a missing verdict is never a pass.',
    '',
    'Do not modify the change set or the repository; your only artifacts are the two files above.',
  ].join('\n');
}

/** One parsed ruling, as loose as the file may legitimately be. */
interface RawRuling {
  criterion: unknown;
  falsified: unknown;
  evidence?: unknown;
  diagnosis?: unknown;
  action?: unknown;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Parse + validate the verdict file into `JudgeRuling`s. Anything missing or
 * malformed is a thrown error — a judge that cannot articulate its ruling per
 * criterion with evidence produces structured failures (never a pass).
 */
export function parseJudgeVerdict(text: string): JudgeRuling[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`semantic judge verdict file is not valid JSON: ${JUDGE_VERDICT_RELATIVE}`);
  }
  const doc = parsed as { rulings?: unknown };
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rulings)) {
    throw new Error(
      `semantic judge verdict file must be an object with a "rulings" array: ${JUDGE_VERDICT_RELATIVE}`,
    );
  }
  return doc.rulings.map((raw: unknown, index: number): JudgeRuling => {
    const ruling = raw as RawRuling;
    if (!ruling || typeof ruling !== 'object' || !isNonEmptyString(ruling.criterion)) {
      throw new Error(`semantic judge ruling ${index} has no criterion: ${JUDGE_VERDICT_RELATIVE}`);
    }
    if (typeof ruling.falsified !== 'boolean') {
      throw new Error(
        `semantic judge ruling for "${ruling.criterion}" has no boolean "falsified": ${JUDGE_VERDICT_RELATIVE}`,
      );
    }
    const evidenceObj = ruling.evidence;
    let evidence: { summary: string; artifacts?: string[] } | null = null;
    if (evidenceObj && typeof evidenceObj === 'object' && isNonEmptyString((evidenceObj as { summary?: unknown }).summary)) {
      evidence = { summary: (evidenceObj as { summary: string }).summary };
      const artifacts = (evidenceObj as { artifacts?: unknown }).artifacts;
      if (Array.isArray(artifacts)) {
        const names = artifacts.filter((item): item is string => isNonEmptyString(item));
        if (names.length > 0) evidence.artifacts = names;
      }
    }
    if (!evidence) {
      throw new Error(
        `semantic judge ruling for "${ruling.criterion}" carries no evidence summary: ${JUDGE_VERDICT_RELATIVE}`,
      );
    }
    return {
      criterion: ruling.criterion,
      falsified: ruling.falsified,
      evidence,
      ...(isNonEmptyString(ruling.diagnosis) ? { diagnosis: ruling.diagnosis } : {}),
      ...(isNonEmptyString(ruling.action) ? { action: ruling.action } : {}),
    };
  });
}

export interface HarnessSemanticJudgeOptions {
  /** The herdr CLI seam (RG6) — shared with the worker adapters. */
  cli: HerdrCli;
  /** The shared workspace manager (the `factory` workspace, ensured once). */
  workspace: HerdrWorkspaceManager;
  /** The judge's identity from config — the provenance the bundle attests. */
  identity: ModelIdentity;
  /** The harness kind the judge's pane runs. Default `opencode`. */
  harness?: string;
  /** The concrete model passed to `agent start -- --model`. Defaults to `provider/model`. */
  modelArg?: string;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Build the harness-backed {@link SemanticJudge}. One instance per server;
 * each `falsify` runs its own fresh tab/pane over a fresh temp directory and
 * tears it down — zero harnesses at rest between judgments.
 */
export function createHarnessSemanticJudge(options: HarnessSemanticJudgeOptions): SemanticJudge {
  const identity = options.identity;
  const modelArg = options.modelArg ?? `${identity.provider}/${identity.model}`;
  // The judge is routed through the generic capability id `verifier`, mapped to
  // its concrete model exactly like the workers map their capabilities.
  let runCount = 0;
  const worker = createHerdrWorker({
    cli: options.cli,
    workspace: options.workspace,
    ...(options.harness ? { harness: options.harness } : {}),
    models: { verifier: modelArg },
    pollIntervalMs: options.pollIntervalMs,
    waitTimeoutMs: options.waitTimeoutMs,
  });

  return {
    identity,
    async falsify(context: SemanticContext): Promise<JudgeRuling[]> {
      // A fresh directory per judgment: the pane's cwd, report and verdict live
      // here, isolated from the repository and cleaned up afterwards.
      const dir = mkdtempSync(join(tmpdir(), 'factory-judge-'));
      try {
        const envelope: ExecutionEnvelope = {
          workOrderId: context.workOrder.id,
          taskId: 'verification',
          attemptId: `verifier-${context.workOrder.id}-${(runCount += 1)}`,
          repository: dir,
          baseCommit: 'HEAD',
          branch: 'factory-verifier',
          worktree: dir,
          authorizationCapabilities: [],
          initialContext: renderJudgePrompt(context),
          retrievalEndpoint: null,
          skills: [],
          requiredVerification: [],
          model: 'verifier',
        };
        await worker.provision();
        await worker.start();
        await worker.execute(envelope);
        const result = await worker.collectArtifacts();
        if (result.status !== 'completed') {
          throw new Error(
            `semantic judge harness failed: ${result.failure ?? result.status}`,
          );
        }
        const verdictPath = join(dir, JUDGE_VERDICT_RELATIVE);
        const text = await readFile(verdictPath, 'utf8').catch(() => null);
        if (text === null) {
          throw new Error(
            `semantic judge harness finished but wrote no verdict file (${verdictPath}); nothing can pass without a verdict`,
          );
        }
        return parseJudgeVerdict(text);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
