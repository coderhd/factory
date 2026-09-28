/**
 * Span-01 Lite client for admission-time triage (noul-only, Lite constraint).
 *
 * Definitions MUST match scripts/span-trial-questions.json — enforced by the
 * pack-parity test in router.test.ts. Bump PACK_VERSION together with it.
 */
import type { Complexity, Risk, SpanVerdict, TaskType } from "./router.js";

export const PACK_VERSION = "v2";
export const SPAN_URL = "https://openrouter.ai/api/alpha/decisions";
export const SPAN_MODEL = "respan/span-01-lite";

export const TASK_DEFINITIONS: Record<TaskType, string> = {
  "exploration": "Read-only question about the code: find, explain, list, or summarize.",
  "repository-analysis":
    "Map or survey the repository: codebase structure, overview, or inventory.",
  "planning": "Plan the work: spec, roadmap, breakdown, or work sequencing.",
  "architecture":
    "Make a system design decision: architecture, ADR, or structural trade-off.",
  "implementation": "Write new code or change existing code: implement a feature or fix.",
  "refactoring":
    "Restructure code without changing behavior: refactor, migrate, rename, or clean up.",
  "debugging": "Something is broken, failing, or crashing: diagnose and repair the defect.",
  "test-generation": "Write tests: generate, add coverage, or create unit tests.",
  "test-debugging": "A test is failing: diagnose the failing test or suite.",
  "ci-troubleshooting": "Fix a failing CI pipeline, build, GitHub Action, or workflow.",
  "documentation": "Write or update docs: readme, changelog, guide, or reference.",
  "code-review": "Peer-review a code change: diff, PR, commit, file, or patch.",
  "security-review":
    "Assess a security concern: vulnerability, CVE, injection, bypass, or hardening.",
  "adversarial-review":
    "Try to break this: attack the system, bypass controls, or defeat safeguards.",
  "second-opinion": "Give an independent second opinion on a decision or approach.",
  "large-context-analysis":
    "Analyze a large scope at once: whole repo, many files, or long context.",
};

export const COMPLEXITY_DEFINITIONS: Record<Complexity, string> = {
  "trivial": "The task is a one-line change, typo, or rename-only edit.",
  "simple": "The task is small, quick, or minor: a tweak with obvious scope.",
  "normal": "The task is a standard development chore with clear scope.",
  "complex":
    "The task is hard, ambiguous, or architecturally tangled: distributed behavior, races, or unclear requirements.",
};

export const RISK_DEFINITION =
  "The task carries production, security, billing, data-loss, or deployment blast radius if done wrong.";
export const RISK_THRESHOLD = 0.5;

export interface SpanQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export function buildSpanQuestions(): Record<string, SpanQuestion> {
  const questions: Record<string, SpanQuestion> = {};
  for (const [task, definition] of Object.entries(TASK_DEFINITIONS)) {
    questions[`task_${task}`] = {
      type: "noul",
      instructions: `Is this developer request a ${task} task?`,
      criteria: { true: definition, false: `This request is not a ${task} task.` },
    };
  }
  for (const [level, definition] of Object.entries(COMPLEXITY_DEFINITIONS)) {
    questions[`cx_${level}`] = {
      type: "noul",
      instructions: "How complex is this developer request?",
      criteria: { true: definition, false: "This does not describe the request complexity." },
    };
  }
  questions["high_risk"] = {
    type: "noul",
    instructions: "Does this developer request carry blast radius?",
    criteria: { true: RISK_DEFINITION, false: "This request is low-risk routine work." },
  };
  return questions;
}

interface SpanAnswers {
  [qid: string]: { noul?: number };
}

/** Map a Decisions-API answers payload to a SpanVerdict. Tolerates missing
 * keys (argmax over present answers); throws only when no usable signal. */
export function parseSpanAnswers(
  answers: Record<string, { noul?: number; [k: string]: unknown }>,
): SpanVerdict {
  const present = (qid: string): number | null => {
    const v = answers[qid]?.noul;
    return typeof v === "number" ? v : null;
  };
  const taskScores = (Object.keys(TASK_DEFINITIONS) as TaskType[])
    .map((t) => ({ t, p: present(`task_${t}`) }))
    .filter((x): x is { t: TaskType; p: number } => x.p !== null)
    .sort((a, b) => b.p - a.p);
  if (taskScores.length === 0) throw new Error("no task answers present");
  const task = taskScores[0].t;
  const confidence = taskScores[0].p;
  const margin = taskScores.length > 1 ? confidence - taskScores[1].p : 1.0;
  const cxScores = (Object.keys(COMPLEXITY_DEFINITIONS) as Complexity[])
    .map((c) => ({ c, p: present(`cx_${c}`) }))
    .filter((x): x is { c: Complexity; p: number } => x.p !== null)
    .sort((a, b) => b.p - a.p);
  if (cxScores.length === 0) throw new Error("no complexity answers present");
  const riskP = present("high_risk");
  const risk: Risk = riskP !== null && riskP > RISK_THRESHOLD ? "high" : "low";
  return { task, complexity: cxScores[0].c, confidence, margin, risk };
}

export type FetchFn = (
  url: string,
  body: unknown,
  timeoutMs: number,
  apiKey: string | null,
) => Promise<unknown>;

/** Call Span; throws on transport/parse failure (caller falls back to rules). */
export async function requestSpanVerdict(
  prompt: string,
  apiKey: string,
  fetchFn: FetchFn,
  timeoutMs = 10000,
): Promise<SpanVerdict> {
  const body = {
    model: SPAN_MODEL,
    questions: buildSpanQuestions(),
    state: prompt,
  };
  const payload = (await fetchFn(SPAN_URL, body, timeoutMs, apiKey)) as {
    answers?: SpanAnswers;
  };
  if (!payload || typeof payload !== "object" || !payload.answers) {
    throw new Error("unrecognized span payload");
  }
  return parseSpanAnswers(
    payload.answers as Record<string, { noul?: number }>,
  );
}
