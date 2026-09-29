import { spawn, type ChildProcess } from 'node:child_process';

/**
 * E3.2 Herdr adapter boundary (spec §15 Worker API, §17 Execution Envelope).
 *
 * v0.1 Herdr is a thin process boundary: one runtime per worker. This module
 * pins the interface + the envelope; the concrete invocation is deliberately
 * boring (spawn/stop a `herdr` command). Tests NEVER spawn a real Herdr — they
 * substitute a fake `WorkerAdapter` (Ruling R5: hermetic tests, OS temp dirs).
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

/** Heartbeat snapshot of a running runtime (sync — the adapter caches it). */
export interface WorkerStatus {
  state: 'running' | 'completed' | 'failed' | 'waiting_input' | 'stopped';
  lastHeartbeatAt: string;
}

/**
 * The §15 Worker API. The Factory governs state; a Worker only executes and
 * reports. Every method that touches a runtime is async; `status` is a cached
 * synchronous heartbeat read.
 */
export interface WorkerAdapter {
  provision(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  status(): WorkerStatus;
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
 */
export function createHerdrWorker(options: HerdrOptions = {}): WorkerAdapter {
  const command = options.command ?? 'herdr';
  let child: ChildProcess | null = null;
  let result: WorkerResult | null = null;
  let heartbeatAt = new Date().toISOString();

  const heartbeat = (): void => {
    heartbeatAt = new Date().toISOString();
  };

  return {
    async provision(): Promise<void> {
      // v0.1: nothing to pre-provision; the runtime is started in `start()`.
      heartbeat();
    },
    async start(): Promise<void> {
      child = spawn(command, ['start'], {
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['pipe', 'ignore', 'ignore'],
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
    status(): WorkerStatus {
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
      if (!child?.stdin) {
        result = emptyResult('herdr runtime is not running');
        return;
      }
      child.stdin.write(`${JSON.stringify(envelope)}\n`);
      heartbeat();
    },
    async collectArtifacts(): Promise<WorkerResult> {
      return result ?? emptyResult('no report produced');
    },
    async destroy(): Promise<void> {
      child?.kill('SIGKILL');
      child = null;
      heartbeat();
    },
  };
}
