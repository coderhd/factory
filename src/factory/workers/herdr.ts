import { spawn, type ChildProcess } from 'node:child_process';

/**
 * E3.2 Herdr adapter boundary (spec §15 Worker API, §17 Execution Envelope).
 *
 * v0.1 Herdr is a thin process boundary: one runtime per worker. This module
 * pins the interface + the envelope and the NDJSON wire protocol (§6.1):
 *
 *   Factory → runtime: one JSON `ExecutionEnvelope` + `\n` on the runtime's stdin.
 *   runtime → Factory: newline-delimited JSON on stdout; each line is a
 *   `WorkerResult` report. `collectArtifacts` reads back the next report.
 *
 * The concrete invocation is deliberately boring (spawn/stop a `herdr` command).
 * Tests NEVER spawn real Herdr — they substitute a fake `WorkerAdapter`, or a
 * stub `herdr` executable in a temp dir (Ruling R5: hermetic tests, OS temp dirs).
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

/** Heartbeat snapshot of a running runtime (spec §15; async per §6.1). */
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
  collectArtifacts(): Promise<WorkerResult>;
  destroy(): Promise<void>;
}

export interface HerdrOptions {
  /** The `herdr` executable to invoke. Defaults to `herdr`. */
  command?: string;
  /** Extra environment for the runtime process. */
  env?: Record<string, string>;
}

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

/**
 * The production Herdr runtime. A thin process boundary only: it starts a
 * `herdr` runtime, hands it the envelope, and reads back a report. It makes no
 * governance decisions — those stay in the Factory.
 *
 * Read-back protocol (§6.1, NDJSON): `execute` writes one JSON envelope line to
 * the runtime's stdin; the runtime writes newline-delimited JSON `WorkerResult`
 * reports to stdout. `collectArtifacts` resolves with the next valid report, or
 * with a failed `WorkerResult` if the runtime exits without one. Malformed
 * stdout lines are ignored as runtime log noise — a missing report is loud, not
 * a silent success.
 */
export function createHerdrWorker(options: HerdrOptions = {}): WorkerAdapter {
  const command = options.command ?? 'herdr';
  let child: ChildProcess | null = null;
  let result: WorkerResult | null = null;
  let heartbeatAt = new Date().toISOString();
  let stdoutBuffer = '';
  // Every parked `collectArtifacts` call gets its own resolver; a single slot
  // would let a second concurrent collect clobber (and leak) the first.
  let reportWaiters: Array<(value: WorkerResult) => void> = [];

  const heartbeat = (): void => {
    heartbeatAt = new Date().toISOString();
  };

  const settleReport = (report: WorkerResult): void => {
    result = report;
    const waiters = reportWaiters;
    reportWaiters = [];
    for (const resolve of waiters) resolve(report);
  };

  /**
   * Discard every trace of a prior run before a new one begins. The release
   * rule keeps a worker's adapter alive across assignments, so a reused worker
   * must never observe the previous assignment's settled report, buffered
   * stdout or waiters (otherwise `status()` reports the old run's state and
   * `collectArtifacts()` returns the old run's `WorkerResult`). A collect still
   * parked here is a caller bug — the scheduler serializes polls per worker —
   * and is settled as a failure rather than silently leaked.
   */
  const resetRunState = (): void => {
    const waiters = reportWaiters;
    reportWaiters = [];
    for (const resolve of waiters) {
      resolve(emptyResult('execution superseded before a report arrived'));
    }
    result = null;
    stdoutBuffer = '';
  };

  const ingestLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Non-JSON stdout is runtime log noise, not a report line.
      return;
    }
    const report = parsed as Partial<WorkerResult> | null;
    if (!report || typeof report.status !== 'string') return;
    settleReport({
      status: report.status as WorkerReportStatus,
      commits: report.commits ?? [],
      artifacts: report.artifacts ?? [],
      interactions: report.interactions ?? [],
      observations: report.observations ?? [],
      verificationRequests: report.verificationRequests ?? [],
      diff: report.diff ?? null,
      failure: report.failure ?? null,
    });
  };

  const onStdout = (chunk: Buffer | string): void => {
    stdoutBuffer += chunk.toString();
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      ingestLine(line);
      newline = stdoutBuffer.indexOf('\n');
    }
  };

  return {
    async provision(): Promise<void> {
      // v0.1: nothing to pre-provision; the runtime is started in `start()`.
      heartbeat();
    },
    async start(): Promise<void> {
      resetRunState();
      child = spawn(command, ['start'], {
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      child.stdout?.on('data', onStdout);
      // A runtime that closes stdin early must not raise an unhandled EPIPE.
      child.stdin?.on('error', () => undefined);
      child.on('error', () => {
        if (!result) settleReport(emptyResult('herdr runtime failed to start'));
      });
      child.once('close', () => {
        if (stdoutBuffer.length > 0) {
          ingestLine(stdoutBuffer);
          stdoutBuffer = '';
        }
        // No report on exit is a real failure — never a silent success and
        // never a collector that hangs forever.
        if (!result) settleReport(emptyResult('herdr runtime exited without emitting a report'));
      });
      heartbeat();
    },
    async stop(): Promise<void> {
      child?.kill();
      child = null;
      heartbeat();
    },
    async pause(): Promise<void> {
      child?.kill('SIGSTOP');
    },
    async resume(): Promise<void> {
      child?.kill('SIGCONT');
    },
    async status(): Promise<WorkerStatus> {
      const state = result
        ? result.status === 'completed'
          ? 'completed'
          : result.status === 'waiting_input'
            ? 'waiting_input'
            : 'failed'
        : child
          ? 'running'
          : 'stopped';
      return { state, lastHeartbeatAt: heartbeatAt };
    },
    async execute(envelope: ExecutionEnvelope): Promise<void> {
      // A fresh run on a possibly-reused adapter: clear the prior run's report,
      // buffered stdout and waiters before dispatching so this run cannot
      // observe the previous assignment's state.
      resetRunState();
      if (!child?.stdin) {
        result = emptyResult('herdr runtime is not running');
        return;
      }
      child.stdin.write(`${JSON.stringify(envelope)}\n`);
      heartbeat();
    },
    async collectArtifacts(): Promise<WorkerResult> {
      if (result) return result;
      if (!child) return emptyResult('herdr runtime is not running');
      // Block until the runtime emits its next report (or exits without one).
      // Concurrent collects all resolve with that same next report rather than
      // overwriting one another's resolver.
      return new Promise<WorkerResult>((resolve) => {
        reportWaiters.push(resolve);
      });
    },
    async destroy(): Promise<void> {
      child?.kill('SIGKILL');
      child = null;
      heartbeat();
    },
  };
}
