import { execFile } from 'node:child_process';
import { rm as rmFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * E11.1 worker runtime (#44, spec §15–§17). The real Herdr is a long-lived
 * terminal-multiplexer **server** that hosts coding-agent harnesses in panes.
 * This module is the herdr-CLI-driven adapter:
 *
 *   - the server provides the worker **environment**: a dedicated `factory`
 *     workspace, ensured once per server lifetime and reused across attempts;
 *   - each Attempt gets an isolated **tab** (cwd = the Task worktree) and an
 *     `opencode` harness started/prompted **on demand** in it;
 *   - structured results come from the worktree's `.factory/report.json` file
 *     plus git (commits, diff); a missing report is a loud failure, never a
 *     silent success;
 *   - a `blocked` harness (approval/question UI) maps to `waiting_input`; the
 *     human answer is delivered back via `agent prompt` and the task converges;
 *   - when a run settles, the tab is closed — zero harnesses at rest.
 *
 * Every herdr invocation goes through the injectable {@link HerdrCli} seam
 * (Ruling R5/RG6): tests inject an in-process fake and never spawn a real
 * `herdr` or `opencode`. The `WorkerAdapter`/`WorkerResult` contracts are
 * unchanged — only the runtime underneath them is new.
 */

/** Factory → Worker payload for one Attempt (spec §17). */
export interface ExecutionEnvelope {
  workOrderId: string;
  taskId: string;
  attemptId: string;
  repository: string;
  baseCommit: string;
  branch: string;
  worktree: string;
  authorizationCapabilities: string[];
  initialContext: string;
  retrievalEndpoint: string | null;
  skills: string[];
  requiredVerification: string[];
  /**
   * E11.1 (#44): the Attempt's **generic** routed capability id (E9.3, e.g.
   * `implementer`). The adapter resolves the concrete model from the
   * `workers.models` configuration at dispatch time; the Attempt itself keeps
   * the generic id.
   */
  model?: string | null;
}

/** A commit produced by an Attempt. */
export interface WorkerCommit {
  sha: string;
  message: string;
}

/** An evidence artifact produced by an Attempt (stored via ArtifactStore). */
export interface WorkerArtifact {
  name: string;
  data: string;
}

/** A question the Worker needs a human answer to (spec §12). */
export interface WorkerInteraction {
  question: string;
}

/**
 * A human answer delivered back into a running runtime (spec §12). The Factory
 * persists the durable interaction; this is the live channel that lets a
 * `waiting_input` harness continue instead of sitting parked.
 */
export interface WorkerAnswer {
  interactionId: string;
  question: string;
  response: string;
}

export type WorkerReportStatus = 'completed' | 'failed' | 'waiting_input';

/** Worker → Factory report collected by the scheduler's collect step (spec §17). */
export interface WorkerResult {
  status: WorkerReportStatus;
  commits: WorkerCommit[];
  artifacts: WorkerArtifact[];
  interactions: WorkerInteraction[];
  observations: string[];
  verificationRequests: string[];
  diff: string | null;
  failure: string | null;
}

/** Heartbeat snapshot of a running runtime (spec §15). */
export interface WorkerStatus {
  state: 'running' | 'completed' | 'failed' | 'waiting_input' | 'stopped';
  lastHeartbeatAt: string;
}

/**
 * The §15 Worker API. The Factory governs state; a Worker only executes and
 * reports. Every method that touches a runtime is async, `status` included
 * (design §6.1 pins `Promise<WorkerStatus>`).
 */
export interface WorkerAdapter {
  provision(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  status(): Promise<WorkerStatus>;
  execute(envelope: ExecutionEnvelope): Promise<void>;
  deliverAnswer(answer: WorkerAnswer): Promise<void>;
  collectArtifacts(): Promise<WorkerResult>;
  destroy(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The HerdrCli seam
// ---------------------------------------------------------------------------

/**
 * One parsed `herdr <args>` invocation's JSON document. The real CLI nests its
 * payload under `.result` (e.g. `.result.workspace`, `.result.tab`,
 * `.result.root_pane`); helpers below accept either nesting so the production
 * and fake runners agree on one call surface.
 */
export interface HerdrCliOutput {
  result?: unknown;
  [key: string]: unknown;
}

/** The `herdr` CLI seam (RG6): every adapter command goes through it. */
export interface HerdrCli {
  run(args: readonly string[]): Promise<HerdrCliOutput>;
}

/** The payload of a herdr document — `.result` when present, else the doc. */
function resultOf(doc: HerdrCliOutput): unknown {
  return doc && typeof doc === 'object' && 'result' in doc ? doc.result : doc;
}

/** Read a string field out of a parsed herdr payload. */
function field(payload: unknown, key: string): string {
  if (payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>)[key] === 'string') {
    return (payload as Record<string, unknown>)[key] as string;
  }
  throw new Error(`herdr payload is missing "${key}"`);
}

/**
 * The production runner: one `herdr <args>` subprocess per invocation: the
 * herdr *server* is long-lived; the CLI talks to it over its socket and exits.
 * Stdout must parse as a JSON document; a non-zero exit is a thrown error with
 * the CLI's stderr — never a silent success.
 */
export function createProcessHerdrCli(command = 'herdr'): HerdrCli {
  const run = (args: readonly string[]): Promise<HerdrCliOutput> =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        { encoding: 'utf8' },
        (error: (Error & { code?: number | string }) | null, stdout: string | Buffer, stderr: string | Buffer) => {
          if (error) {
            reject(
              new Error(
                `herdr ${args.join(' ')} failed (exit ${error.code ?? 'unknown'}): ${String(stderr).trim() || error.message}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(String(stdout)) as HerdrCliOutput);
          } catch {
            reject(new Error(`herdr ${args.join(' ')} printed non-JSON output: ${String(stdout).slice(0, 200)}`));
          }
        },
      );
    });
  return { run };
}

// ---------------------------------------------------------------------------
// The worker environment: the dedicated `factory` workspace (started once)
// ---------------------------------------------------------------------------

export interface HerdrWorkspaceOptions {
  /** The workspace label the Factory owns. Never the user's focused ones. */
  label: string;
  /** The repo the workspace is anchored to (herdr workspace cwd). */
  repoPath: string;
}

/**
 * The herdr workspace holder. `ensure()` is memoized: herdr is started once
 * (it is a long-lived server), the workspace is created only if a server-side
 * `workspace list` does not already know the label, and the returned id is
 * reused across attempts and adapters. Only the Factory's own label is ever
 * touched — user panes/workspaces are invisible to this module.
 */
export interface HerdrWorkspaceManager {
  ensure(): Promise<{ workspace: string; rootPane: string }>;
}

export function createHerdrWorkspaceManager(cli: HerdrCli, options: HerdrWorkspaceOptions): HerdrWorkspaceManager {
  let ensured: Promise<{ workspace: string; rootPane: string }> | null = null;
  return {
    ensure(): Promise<{ workspace: string; rootPane: string }> {
      // A rejected ensure must not be memoized forever: one transient failure
      // (e.g. herdr's socket not yet up) would poison every later provision
      // until restart. Reject → drop the memo so the next provision retries
      // (recovery stays bounded). The drop is checked against this call's own
      // guard promise, so a concurrent successful ensure is never cleared.
      if (!ensured) {
        const attempt = (async () => {
          const listing = resultOf(await cli.run(['workspace', 'list']));
          const entries = Array.isArray(listing) ? listing : [];
          for (const entry of entries) {
            if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).label === options.label) {
              return { workspace: field(entry, 'id'), rootPane: '' };
            }
          }
          const created = resultOf(
            await cli.run([
              'workspace',
              'create',
              '--label',
              options.label,
              '--cwd',
              options.repoPath,
              '--no-focus',
            ]),
          );
          return { workspace: field(created, 'workspace'), rootPane: field(created, 'root_pane') };
        })();
        const guard = attempt.catch((error: unknown) => {
          if (ensured === guard) ensured = null;
          throw error;
        });
        ensured = guard;
      }
      return ensured;
    },
  };
}

// ---------------------------------------------------------------------------
// Task prompt (§17 Execution Envelope → harness instructions)
// ---------------------------------------------------------------------------

/**
 * Render the ExecutionEnvelope as the harness prompt: where to work, what the
 * Work Order wants, which acceptance criteria and verification apply, and the
 * report contract (`commit your work` + write `.factory/report.json`).
 */
export function renderTaskPrompt(envelope: ExecutionEnvelope): string {
  const lines = [
    'You are executing a step of a Factory Work Order.',
    '',
    `Work exclusively in the git worktree: ${envelope.worktree}`,
    `Branch: ${envelope.branch}`,
    `Base commit: ${envelope.baseCommit}`,
    '',
    'Work Order / Task context:',
    envelope.initialContext,
    '',
    ...(envelope.requiredVerification.length > 0
      ? ['Required verification:', ...envelope.requiredVerification.map((entry) => `- ${entry}`), '']
      : []),
    'When you are done:',
    '1. Commit your work (meaningful commit messages) in the worktree on the branch above.',
    '2. Write a JSON report to `' + join(envelope.worktree, '.factory', 'report.json') + '` with fields:',
    '   `status` ("completed" | "failed" | "waiting_input"), `observations` (string[]),',
    '   `verificationRequests` (string[]), `interactions` ({"question": string}[], for',
    '   waiting_input only), `failure` (string|null). Without this report the run is a failure.',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The harness report file contract
// ---------------------------------------------------------------------------

/** The parsed `.factory/report.json` the harness writes in the worktree. */
interface HarnessReport {
  status: WorkerReportStatus;
  artifacts: WorkerArtifact[];
  interactions: WorkerInteraction[];
  observations: string[];
  verificationRequests: string[];
  failure: string | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Parse + validate the report file; `null` means missing/invalid (loud). */
function parseHarnessReport(text: string): HarnessReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const report = parsed as Record<string, unknown>;
  const status = report.status;
  if (status !== 'completed' && status !== 'failed' && status !== 'waiting_input') return null;
  const trimmed: HarnessReport = {
    status,
    artifacts: Array.isArray(report.artifacts)
      ? (report.artifacts as WorkerArtifact[]).filter((a) => a && isNonEmptyString((a as WorkerArtifact).name))
      : [],
    interactions: Array.isArray(report.interactions)
      ? (report.interactions as WorkerInteraction[]).filter((q) => q && isNonEmptyString((q as WorkerInteraction).question))
      : [],
    observations: Array.isArray(report.observations)
      ? (report.observations as unknown[]).filter(isNonEmptyString)
      : [],
    verificationRequests: Array.isArray(report.verificationRequests)
      ? (report.verificationRequests as unknown[]).filter(isNonEmptyString)
      : [],
    failure: isNonEmptyString(report.failure) ? report.failure : null,
  };
  // A `waiting_input` report without any question is a silent stall — refuse it.
  if (trimmed.status === 'waiting_input' && trimmed.interactions.length === 0) return null;
  return trimmed;
}

const REPORT_RELATIVE = join('.factory', 'report.json');

/** Git evidence read (§17): commits since base + the base diff. */
async function gitEvidence(
  worktree: string,
  baseCommit: string,
): Promise<{ commits: WorkerCommit[]; diff: string | null; gitError: string | null }> {
  const run = (args: readonly string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      // A change set's diff can exceed the default 1 MB child-process buffer,
      // which would silently truncate valid work into "no evidence"; 50 MB is
      // well past any real review diff.
      execFile(
        'git',
        [...args],
        { cwd: worktree, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
        (error: Error | null, stdout: string | Buffer) => (error ? reject(error) : resolve(String(stdout))),
      );
    });
  try {
    const log = await run(['log', '--format=%H%x00%s', `${baseCommit}..HEAD`]);
    const commits = log
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const nul = line.indexOf('\u0000');
        return { sha: line.slice(0, nul < 0 ? line.length : nul), message: line.slice(nul + 1) };
      });
    const diff = (await run(['diff', baseCommit])).trim();
    return { commits, diff: diff.length > 0 ? diff : null, gitError: null };
  } catch (error) {
    // Git evidence is enrichment; the report file is the loud completion gate.
    // But a read failure is not silently "no evidence": it is surfaced as an
    // observation so the collected report says so.
    return {
      commits: [],
      diff: null,
      gitError: `git evidence read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface HerdrOptions {
  /** The herdr CLI seam (RG6). Required — the caller injects it. */
  cli: HerdrCli;
  /** The dedicated workspace manager (ensured once, shared, memoized). */
  workspace: HerdrWorkspaceManager;
  /** The harness kind started in each pane. Default `opencode`. */
  harness?: string;
  /** capability-id → concrete model map (factory.yaml `workers.models`). */
  models?: Record<string, string>;
  /** The repository the workspace is anchored to. */
  repoPath?: string;
  /** How long a prompt waits, and the overall per-run deadline, in ms. */
  waitTimeoutMs?: number;
  /** Poll cadence while waiting for the report file. */
  pollIntervalMs?: number;
}

const DEFAULT_HARNESS = 'opencode';
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

const emptyResult = (failure: string): WorkerResult => ({
  status: 'failed',
  commits: [],
  artifacts: [],
  interactions: [],
  observations: [],
  verificationRequests: [],
  diff: null,
  failure,
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The E11.1 herdr adapter. One instance per Worker; the herdr server + the
 * `factory` workspace are shared and started once. Harnesses (tabs) are
 * spawned per Attempt and closed when the run settles — zero at rest.
 */
export function createHerdrWorker(options: HerdrOptions): WorkerAdapter {
  const cli = options.cli;
  const harness = options.harness ?? DEFAULT_HARNESS;
  const models = options.models ?? {};
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const repoPath = options.repoPath ?? '.';

  let heartbeatAt = new Date().toISOString();
  /** The live run; `null` at rest (zero harnesses between attempts). */
  let run: {
    envelope: ExecutionEnvelope;
    agentName: string;
    tab: string;
  } | null = null;
  let result: WorkerResult | null = null;
  /** `true` while a prompt/answer re-poll is in flight (status = running). */
  let polling = false;
  let reportWaiters: Array<(value: WorkerResult) => void> = [];

  const heartbeat = (): void => {
    heartbeatAt = new Date().toISOString();
  };

  const settle = (report: WorkerResult): void => {
    result = report;
    const waiters = reportWaiters;
    reportWaiters = [];
    for (const waiter of waiters) waiter(report);
  };

  const releaseRun = async (): Promise<void> => {
    if (!run) return;
    const tab = run.tab;
    run = null;
    heartbeat();
    try {
      await cli.run(['tab', 'close', tab]);
    } catch {
      // Best-effort teardown; a missing tab is not a failed run.
    }
  };

  /** Read the settled report without TS flow-narrowing across re-assignments. */
  const currentResult = (): WorkerResult | null => result;

  /** Discard stale collect waiters before a run reuses the adapter. */
  const resetRunState = (): void => {
    const waiters = reportWaiters;
    reportWaiters = [];
    for (const waiter of waiters) waiter(emptyResult('execution superseded before a report arrived'));
    result = null;
  };

  /** Resolve the concrete model from the Attempt's generic routed id (#44). */
  const resolveModel = (envelope: ExecutionEnvelope): string | null => {
    if (!envelope.model) return null;
    const mapped = models[envelope.model];
    if (!mapped) {
      throw new Error(
        `no concrete model configured for routed capability "${envelope.model}" (workers.models is not configured or lacks the id)`,
      );
    }
    return mapped;
  };

  /**
   * One harness turn: prompt the agent, then poll for the report file, mapping
   * the harness state. Resolves when a terminal/waiting report is settled.
   */
  const turn = async (runState: { envelope: ExecutionEnvelope; agentName: string }, prompt: string): Promise<void> => {
    // Each turn collects its own report: the previous turn's file would be
    // re-settled verbatim (stale question loop) if the harness blocks again
    // without rewriting it. Remove it before prompting.
    await rmFile(join(runState.envelope.worktree, REPORT_RELATIVE)).catch(() => undefined);
    await cli.run([
      'agent',
      'prompt',
      runState.agentName,
      prompt,
      '--wait',
      '--timeout',
      String(waitTimeoutMs),
    ]);
    const deadline = Date.now() + waitTimeoutMs;
    for (;;) {
      const reportText = await readFile(join(runState.envelope.worktree, REPORT_RELATIVE), 'utf8').catch(
        () => null,
      );
      const parsed = reportText === null ? null : parseHarnessReport(reportText);
      if (parsed) {
        const git = await gitEvidence(runState.envelope.worktree, runState.envelope.baseCommit);
      const gitObservations =
        git.gitError !== null ? [...parsed.observations, git.gitError] : parsed.observations;
      if (parsed.status === 'waiting_input') {
          // A worker question is not a completion: settle waiting and keep the
          // harness alive so `deliverAnswer` can resume this exact one.
          heartbeat();
          settle({
            status: 'waiting_input',
            commits: git.commits,
            artifacts: parsed.artifacts,
            interactions: parsed.interactions,
            observations: gitObservations,
            verificationRequests: parsed.verificationRequests,
            diff: git.diff,
            failure: null,
          });
          return;
        }
        heartbeat();
        settle({
          status: parsed.status,
          commits: git.commits,
          artifacts: parsed.artifacts,
          interactions: parsed.interactions,
          observations: gitObservations,
          verificationRequests: parsed.verificationRequests,
          diff: git.diff,
          failure: parsed.failure ?? (parsed.status === 'failed' ? 'worker reported failure without a detail' : null),
        });
        return;
      }
      // The turn ended but nothing was reported: observe the harness state.
      const state = field(resultOf(await cli.run(['agent', 'get', runState.agentName])), 'state');
      if (state === 'blocked') {
        // The approval/question UI is up. Read the recent pane text as the live
        // question; the tap into the harness stays open for `deliverAnswer`.
        const readOutput = resultOf(
          await cli.run([
            'agent',
            'read',
            runState.agentName,
            '--source',
            'recent-unwrapped',
            '--lines',
            '50',
          ]),
        );
        const text =
          readOutput && typeof readOutput === 'object' && isNonEmptyString((readOutput as Record<string, unknown>).text)
            ? (readOutput as Record<string, unknown>).text as string
            : 'the harness is blocked and its pane text could not be read';
        heartbeat();
        settle({
          status: 'waiting_input',
          commits: [],
          artifacts: [],
          interactions: [{ question: text.trim() }],
          observations: [],
          verificationRequests: [],
          diff: null,
          failure: null,
        });
        return;
      }
      if (Date.now() >= deadline) {
        await releaseRun();
        heartbeat();
        settle(
          emptyResult(`harness did not write ${REPORT_RELATIVE} within ${waitTimeoutMs}ms`),
        );
        return;
      }
      await sleep(pollIntervalMs);
    }
  };

  return {
    async provision(): Promise<void> {
      // The herdr server + `factory` workspace: started once, memoized, reused.
      await options.workspace.ensure();
      heartbeat();
    },

    async start(): Promise<void> {
      // The environment is the server; nothing per-worker to boot here — the
      // workspace was ensured in provision, tabs are per-run (on demand).
      heartbeat();
    },

    async pause(): Promise<void> {
      // herdr has no harness pause primitive; a pause is a Factory-level lease
      // concern. Kept as a heartbeat-only no-op for the WorkerAdapter shape.
      heartbeat();
    },

    async resume(): Promise<void> {
      heartbeat();
    },

    async status(): Promise<WorkerStatus> {
      heartbeat();
      // An in-flight answer re-poll runs the harness again even though the
      // settled report still says waiting_input (it is about to be replaced).
      if (!result || polling) return { state: 'running', lastHeartbeatAt: heartbeatAt };
      const state =
        result.status === 'completed'
          ? 'completed'
          : result.status === 'waiting_input'
            ? 'waiting_input'
            : 'failed';
      return { state, lastHeartbeatAt: heartbeatAt };
    },

    async execute(envelope): Promise<void> {
      // Zero-at-rest is local: a caller dispatching again before releasing
      // must not orphan the prior harness.
      if (run) await releaseRun();
      // A fresh run on a possibly-reused adapter must not observe the previous
      // run's report or parked collectors.
      resetRunState();
      heartbeat();
      let runState: { envelope: ExecutionEnvelope; agentName: string; tab: string } | null = null;
      try {
        const { workspace } = await options.workspace.ensure();
        const concrete = resolveModel(envelope);
        const tabResult = resultOf(
          await cli.run([
            'tab',
            'create',
            '--workspace',
            workspace,
            '--cwd',
            envelope.worktree,
            '--label',
            `factory-${envelope.attemptId}`,
            '--no-focus',
          ]),
        );
        runState = { envelope, agentName: `factory-${envelope.attemptId}`, tab: field(tabResult, 'tab') };
        // Register the live run immediately after the tab exists, so a later
        // failure (e.g. agent start) tears the pane down in `releaseRun`.
        run = runState;
        const agentArgs = [
          'agent',
          'start',
          runState.agentName,
          '--kind',
          harness,
          '--pane',
          field(tabResult, 'root_pane'),
        ];
        if (concrete) {
          // The model rides the harness argv after the `--` separator; no
          // dangling separator when the run is unrouted.
          agentArgs.push('--', '--model', concrete);
        }
        await cli.run(agentArgs);
        polling = true;
        await turn(runState, renderTaskPrompt(envelope));
      } catch (error) {
        // Loud failure with no leaked pane: close the tab (if one was created)
        // and settle a failed result rather than a silent hang.
        if (runState) await releaseRun();
        heartbeat();
        settle(emptyResult(`harness dispatch failed: ${error instanceof Error ? error.message : String(error)}`));
        return;
      } finally {
        polling = false;
      }
      if (currentResult()?.status !== 'waiting_input' && runState) {
        // Terminal run: kill the harness immediately (zero at rest).
        await releaseRun();
      }
    },

    async deliverAnswer(answer): Promise<void> {
      // An answer belongs to a live waiting harness — anything else is loud.
      if (!run || result?.status !== 'waiting_input') {
        throw new Error('no waiting harness to deliver an answer to');
      }
      // Invalidate the settled waiting report so parked collectors get this
      // answer's own fresh report, not the pre-answer question again.
      result = null;
      heartbeat();
      polling = true;
      let answerError: unknown = null;
      try {
        await turn(run, answer.response);
      } catch (error) {
        // Surface the underlying cause rather than leave the task wedged.
        answerError = error;
      } finally {
        polling = false;
      }
      const settled = currentResult();
      if (settled === null) {
        await releaseRun();
        heartbeat();
        settle(
          emptyResult(
            answerError !== null
              ? `harness did not resume after the delivered answer: ${
                  answerError instanceof Error ? answerError.message : String(answerError)
                }`
              : 'harness did not resume after the delivered answer',
          ),
        );
      } else if (settled.status !== 'waiting_input') {
        // Terminal after the answer: converge — kill the harness.
        await releaseRun();
      }
    },

    async collectArtifacts(): Promise<WorkerResult> {
      if (result) return result;
      if (!run && !polling) return emptyResult('herdr harness is not running');
      return new Promise<WorkerResult>((resolve) => {
        reportWaiters.push(resolve);
      });
    },

    async stop(): Promise<void> {
      await releaseRun();
    },

    async destroy(): Promise<void> {
      await releaseRun();
    },
  };
}
