import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildGitHubAdapter, buildServerDeps } from '../../src/cli/factory';
import { createFactoryClient } from '../../src/factory/api/client';
import { startFactoryServer } from '../../src/factory/api/server';
import {
  DEFAULT_FACTORY_CONFIG,
  parseFactoryConfig,
  resolveFactoryConfig,
  serializeFactoryConfig,
  type FactoryRuntimeConfig,
} from '../../src/factory/config/factoryConfig';
import type { Attempt, Task, WorkOrder } from '../../src/factory/domain/workOrder';
import type { EvidenceBundle } from '../../src/factory/evidence/bundle';
import { DAG_COMMITTED, type DAGVersion } from '../../src/factory/planning/dag';
import { EVIDENCE_BUNDLE_RECORDED, VERIFICATION_FAILED } from '../../src/factory/scheduler/scheduler';
import { RECOVERY_ACTION_APPLIED, recover } from '../../src/factory/recovery/recovery';
import { TELEMETRY_ATTEMPT_RECORDED, readAttemptTelemetry } from '../../src/factory/telemetry/telemetry';
import { createVerificationEngine } from '../../src/factory/verification/engine';
import { createE5Verifier, type WorkVerifier } from '../../src/factory/verification/orchestrator';
import type { SemanticJudge } from '../../src/factory/verification/semantic';
import { openStateStore, type StateStore } from '../../src/factory/state/store';
import {
  type ExecutionEnvelope,
  type WorkerAdapter,
  type WorkerAnswer,
  type WorkerResult,
  type WorkerStatus,
} from '../../src/factory/workers/herdr';
import { taskWorktreeBranch } from '../../src/factory/worktrees/worktree';
import type { RoutingDecisionRecord } from '../../src/factory/routing/decisionModel';
import type { PolicyDecisionRecord } from '../../src/factory/policy/policy';
import { checkDetailed } from '../../src/factory/policy/policy';
import {
  type CreateBranchInput,
  type CreatePullRequestInput,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubPullRequestDetail,
  type GitHubTransport,
  type IssueRef,
  type MergePullRequestInput,
  type PullRequestRef,
} from '../../src/factory/github/adapter';

/**
 * E9.10 (#36) — the end-to-end acceptance test: the roadmap #1 trace
 * (`factory-docs/implementation/roadmap.md`: `factory start` executes an
 * imported Work Order end to end) as one hermetic test.
 *
 * The trace is driven through the **real** composition — `buildServerDeps`
 * (the production spine: real policy, routing, verification, telemetry,
 * worktrees), the real E3 scheduler, the real E5 verification/evidence
 * modules, and the real E6 `buildGitHubAdapter` composition root — over a
 * temp `git init` repo and OS temp dirs. The runtime boundary is a scripted
 * fake Herdr adapter (Ruling R5: never spawn a real runtime) and the GitHub
 * boundary is a mocked transport (Ruling R6: no network). No Docker, no LLM.
 *
 * `import → plan (DAG commit) → 2 concurrent tasks in isolated worktrees →
 * QUESTION/WAITING_INPUT → failure+recovery → verify fail+rework → Evidence
 * Bundle → human gate → PR/merge with evidence link → telemetry → restart`.
 *
 * Every step asserts **durable** evidence — state + event log + the persisted
 * Evidence Bundle — not merely the final state.
 *
 * ## One seam is exercised at its module level, deliberately
 *
 * The live scheduler has no caller that re-dispatches a failed/reworked Task
 * (E7's bounded recovery is wired into boot reconciliation and the circuit,
 * and the *live dependency-failure producer* is tracked in #37). So the trace's
 * `failure+recovery` step calls the real E7 `recover()` entry point exactly as
 * a runtime caller would — the same module-level seam the E9.6 suite exercises
 * — to open a new clean-baseline Attempt, and the Factory's documented
 * rework/replan path (`commitDAG` v2 in REWORK; §5.1 `REWORK → EXECUTING`) is
 * driven to re-execute. Nothing is faked: the store, policy, recovery,
 * verification and evidence modules are the production ones.
 */

let workDir: string;
let repoPath: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(root: string): string {
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' });
  git(['config', 'user.email', 'factory-e2e@example.com'], repo);
  git(['config', 'user.name', 'Factory E2E'], repo);
  writeFileSync(join(repo, 'README.md'), '# e2e fixture repo\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  return repo;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'factory-e9e2e-'));
  repoPath = initRepo(workDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A `factory.yaml` runtime pointed at the fixture repo, two concurrent slots. */
function runtimeFrom(): FactoryRuntimeConfig {
  const text = serializeFactoryConfig({
    ...DEFAULT_FACTORY_CONFIG,
    repository: { path: repoPath },
    scheduler: {
      ...DEFAULT_FACTORY_CONFIG.scheduler,
      // Two concurrent Tasks prove the isolated-worktree concurrency claim.
      maxConcurrentTasks: 2,
      provisioning: { ...DEFAULT_FACTORY_CONFIG.scheduler.provisioning, max: 5 },
    },
  });
  const parsed = parseFactoryConfig(text);
  if (!parsed.ok) throw new Error(`fixture factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
  const runtime = resolveFactoryConfig(parsed.config, { baseDir: workDir });
  mkdirSync(runtime.paths.state, { recursive: true });
  return runtime;
}

// ---------------------------------------------------------------------------
// Scripted fake Herdr boundary (Ruling R5)
// ---------------------------------------------------------------------------

/**
 * A Herdr adapter whose report per assignment is released by the test. `execute`
 * records the envelope's Task, `collectArtifacts` parks until `release(report)`
 * supplies the runtime's next report, and `deliverAnswer` records the answer
 * channel (the runtime continuing after a `waiting_input`).
 *
 * Parking the collect (rather than returning a terminal report immediately)
 * lets the test sequence the two concurrent Tasks deterministically — the
 * scheduler's `pending` guard means a parked collect is not re-polled.
 */
class ScriptedHerdr implements WorkerAdapter {
  taskId: string | null = null;
  envelope: ExecutionEnvelope | null = null;
  delivered: WorkerAnswer[] = [];
  private waiter: ((result: WorkerResult) => void) | null = null;
  private queued: WorkerResult[] = [];

  async provision(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async status(): Promise<WorkerStatus> {
    return { state: 'running', lastHeartbeatAt: new Date().toISOString() };
  }
  async execute(envelope: ExecutionEnvelope): Promise<void> {
    this.envelope = envelope;
    this.taskId = envelope.taskId;
  }
  async collectArtifacts(): Promise<WorkerResult> {
    if (this.queued.length > 0) return structuredClone(this.queued.shift()!);
    return new Promise<WorkerResult>((resolve) => {
      this.waiter = resolve;
    });
  }
  async deliverAnswer(answer: WorkerAnswer): Promise<void> {
    this.delivered.push(answer);
  }
  async destroy(): Promise<void> {}

  /** Hand the parked runtime its next report (or queue it for the next poll). */
  release(result: WorkerResult): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter(structuredClone(result));
    else this.queued.push(structuredClone(result));
  }
}

function completedResult(diff: string): WorkerResult {
  return {
    status: 'completed',
    commits: [{ sha: `sha_${crypto.randomUUID().slice(0, 8)}`, message: 'implement' }],
    artifacts: [],
    interactions: [],
    observations: [],
    verificationRequests: [],
    diff,
    failure: null,
  };
}

function waitingResult(question: string): WorkerResult {
  return {
    status: 'waiting_input',
    commits: [],
    artifacts: [],
    interactions: [{ question }],
    observations: [],
    verificationRequests: [],
    diff: null,
    failure: null,
  };
}

// ---------------------------------------------------------------------------
// Scripted E5 verifier (real engine + semantic verifier; fake judge, no LLM)
// ---------------------------------------------------------------------------

/**
 * Build the real E5-backed {@link WorkVerifier} over a verification engine with
 * deterministic + behavioral checks and an independent fake judge. `failOnce`
 * makes named Tasks fail their *next* verification exactly once (the
 * fault-injection the trace's `verify fail+rework` needs); the same task then
 * verifies cleanly, as a real rework would.
 */
function buildVerifier(store: StateStore, options: { failOnce?: Set<string> } = {}): WorkVerifier {
  const failOnce = options.failOnce ?? new Set<string>();
  const engine = createVerificationEngine();
  engine.registerCheck({
    id: 'typecheck',
    category: 'deterministic',
    kind: 'typecheck',
    run: (context) =>
      failOnce.has(context.changeSet.taskId)
        ? {
            passed: false,
            evidence: { summary: 'typecheck failed' },
            diagnosis: 'counter does not compile',
            action: 'fix the type error and re-run verification',
          }
        : { passed: true, evidence: { summary: 'typecheck ok' } },
  });
  engine.registerCheck({
    id: 'playwright',
    category: 'behavioral',
    kind: 'playwright',
    run: () => ({ passed: true, evidence: { summary: 'playwright ok' } }),
  });
  const judge: SemanticJudge = {
    identity: { provider: 'judge-co', model: 'judge-1', family: 'judge-family' },
    falsify: (context) =>
      context.criteria.map((criterion) => ({
        criterion,
        falsified: false,
        evidence: { summary: `judge reviewed "${criterion}"` },
        diagnosis: `judge falsified "${criterion}"`,
        action: `address "${criterion}"`,
      })),
  };
  const verifier = createE5Verifier({
    store,
    engine,
    judge,
    prompt: { id: 'e2e-verify', version: '1' },
    rubric: ['Does the change set satisfy the criterion as written?'],
    provider: 'factory',
    now: () => '2026-09-30T12:00:00.000Z',
  });
  // Consume the one-shot failure when the failing check actually runs: wrap the
  // verifier so the fault is released only after a failed verification lands.
  if (options.failOnce) {
    const wrapped: WorkVerifier = {
      async verify(subject) {
        const outcome = await verifier.verify(subject);
        failOnce.delete(subject.task.id);
        return outcome;
      },
    };
    return wrapped;
  }
  return verifier;
}

// ---------------------------------------------------------------------------
// Mocked GitHub transport (Ruling R6)
// ---------------------------------------------------------------------------

class MockGitHubTransport implements GitHubTransport {
  issues = new Map<string, GitHubIssue>();
  branchCalls: CreateBranchInput[] = [];
  prCalls: CreatePullRequestInput[] = [];
  mergeCalls: MergePullRequestInput[] = [];
  prDetails = new Map<number, GitHubPullRequestDetail>();
  private prNumber = 900;

  issueKey = (ref: IssueRef): string => `${ref.repository}#${ref.number}`;

  async getIssue(ref: IssueRef): Promise<GitHubIssue> {
    const issue = this.issues.get(this.issueKey(ref));
    if (!issue) throw new Error(`no such issue: ${this.issueKey(ref)}`);
    return issue;
  }

  async createBranch(input: CreateBranchInput) {
    this.branchCalls.push({ ...input });
    return { repository: input.repository, name: input.branch, sha: 'sha_base' };
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    this.prCalls.push({ ...input });
    this.prNumber += 1;
    const pr: GitHubPullRequest = {
      repository: input.repository,
      number: this.prNumber,
      url: `https://github.com/${input.repository}/pull/${this.prNumber}`,
      head: input.head,
      base: input.base,
    };
    this.prDetails.set(pr.number, {
      ...pr,
      headSha: 'sha_head_1',
      body: input.body,
      state: 'open',
      merged: false,
    });
    return pr;
  }

  async getPullRequest(ref: PullRequestRef): Promise<GitHubPullRequestDetail> {
    const pr = this.prDetails.get(ref.number);
    if (!pr || pr.repository !== ref.repository) {
      throw new Error(`no such pull request: ${ref.repository}#${ref.number}`);
    }
    return { ...pr };
  }

  async mergePullRequest(input: MergePullRequestInput) {
    this.mergeCalls.push({ ...input });
    const pr = this.prDetails.get(input.number);
    if (pr) this.prDetails.set(input.number, { ...pr, merged: true, state: 'closed' });
    return {
      repository: input.repository,
      number: input.number,
      merged: true,
      sha: 'merge_sha',
      message: 'Pull request merged',
    };
  }
}

const ISSUE: GitHubIssue = {
  repository: 'acme/widgets',
  number: 7,
  title: 'Add the widget counter',
  body: ['Acceptance criteria:', '- [ ] counter increments', '- [x] counter persists'].join('\n'),
  labels: ['enhancement'],
  url: 'https://github.com/acme/widgets/issues/7',
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface E2EHarness {
  runtime: FactoryRuntimeConfig;
  store: StateStore;
  events: ReturnType<typeof buildServerDeps>['events'];
  deps: ReturnType<typeof buildServerDeps>;
  server: ReturnType<typeof startFactoryServer>;
  client: ReturnType<typeof createFactoryClient>;
  adapters: ScriptedHerdr[];
  transport: MockGitHubTransport;
  github: ReturnType<typeof buildGitHubAdapter>;
  /** A second SQLite handle the verifier reads through (same WAL database). */
  readStore: StateStore;
  tickAndSettle(): Promise<void>;
  /** Run ticks until `predicate` holds (fail loudly if the budget is exhausted). */
  until(label: string, predicate: () => boolean, maxTicks?: number): Promise<void>;
  adapterFor(taskId: string): ScriptedHerdr;
  close(): void;
}

function createHarness(options: { failOnce?: Set<string> } = {}): E2EHarness {
  const runtime = runtimeFrom();
  // The E5 verifier reads the store; open a dedicated handle on the same
  // database so the verifier survives the deps' store lifecycle. Opening the
  // same WAL database twice is safe (`CREATE TABLE IF NOT EXISTS`).
  const readStore = openStateStore(runtime.paths.db);
  const verifier = buildVerifier(readStore, options);
  const adapters: ScriptedHerdr[] = [];
  const deps = buildServerDeps(runtime, {
    spawn: () => {
      const adapter = new ScriptedHerdr();
      adapters.push(adapter);
      return adapter;
    },
    verifier,
  });
  const server = startFactoryServer(deps);
  const client = createFactoryClient({ baseUrl: server.url });
  const transport = new MockGitHubTransport();
  const github = buildGitHubAdapter({
    transport,
    client,
    factoryBaseUrl: server.url,
    store: deps.store,
    events: deps.events,
  });
  return {
    runtime,
    store: deps.store,
    events: deps.events,
    deps,
    server,
    client,
    adapters,
    transport,
    github,
    readStore,
    async tickAndSettle(): Promise<void> {
      deps.scheduler!.tick();
      // A collect settles through a chain of adapter/manager promises; a real
      // macrotask (not just a microtask) lets the completion reach the queue.
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    async until(label: string, predicate: () => boolean, maxTicks = 20): Promise<void> {
      for (let i = 0; i < maxTicks; i += 1) {
        // A collect and its routing happen across two ticks (the collect settles
        // on a microtask, the routing runs at the next tick's entry), so each
        // iteration runs a full collect→route cycle.
        await this.tickAndSettle();
        if (predicate()) return;
        await this.tickAndSettle();
        if (predicate()) return;
      }
      throw new Error(`E2E trace: "${label}" was not reached within the tick budget`);
    },
    adapterFor(taskId: string): ScriptedHerdr {
      const adapter = adapters.find((candidate) => candidate.taskId === taskId && candidate.envelope !== null);
      if (!adapter) throw new Error(`no adapter dispatched for task ${taskId}`);
      return adapter;
    },
    close(): void {
      server.stop();
      deps.store.close();
      readStore.close();
    },
  };
}

/** A Task's latest Attempt with the given outcome (or the latest overall). */
function attemptFor(store: StateStore, taskId: string, outcome?: string): Attempt | undefined {
  return store
    .list<Attempt>('attempts')
    .filter((attempt) => attempt.taskId === taskId && (outcome === undefined || attempt.outcome === outcome))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .at(-1);
}

const taskById = (store: StateStore, id: string): Task => store.get<Task>('tasks', id)!;

// ---------------------------------------------------------------------------
// The trace
// ---------------------------------------------------------------------------

describe('E9.10 end-to-end acceptance — the roadmap #1 trace', () => {
  it('runs import → plan → concurrency → question → recovery → rework → evidence → gate → merge → telemetry → restart, with durable evidence at every step', async () => {
    const failOnce = new Set<string>();
    const h = createHarness({ failOnce });
    let restartDeps: ReturnType<typeof buildServerDeps> | null = null;
    let toreDown = false;
    try {
      // == 1. IMPORT ========================================================
      h.transport.issues.set(h.transport.issueKey(ISSUE), ISSUE);
      const imported = await h.github.importIssue({ repository: ISSUE.repository, number: ISSUE.number });
      const woId = imported.workOrder.id;
      expect(imported.created).toBe(true);

      const importedRow = h.store.get<WorkOrder>('work_orders', woId)!;
      expect(importedRow.state).toBe('DRAFT');
      expect(importedRow.repository).toBe('acme/widgets');
      expect(importedRow.acceptanceCriteria).toEqual(['counter increments', 'counter persists']);
      // Durable: the creation event exists and a re-import reconciles (idempotent).
      expect(
        h.events.readEvents({ aggregateType: 'work_order', aggregateId: woId }).map((event) => event.type),
      ).toContain('work_order.created');
      const reimport = await h.github.importIssue({ repository: ISSUE.repository, number: ISSUE.number });
      expect(reimport.created).toBe(false);
      expect(reimport.workOrder.id).toBe(woId);
      expect(h.store.list<WorkOrder>('work_orders')).toHaveLength(1);

      // == 2. PLAN (DAG COMMIT) =============================================
      await h.client.transitionWorkOrder(woId, { to: 'READY' });
      await h.client.transitionWorkOrder(woId, { to: 'PLANNING' });
      const v1 = await h.client.commitDag(woId, {
        rationale: 'two independent slices',
        nodes: [
          { nodeId: 'increment', title: 'Increment counter' },
          { nodeId: 'persist', title: 'Persist counter' },
        ],
      });
      expect(v1.dag.version).toBe(1);
      expect(v1.dag.nodes).toHaveLength(2);
      const [taskAId, taskBId] = v1.dag.nodes.map((node) => node.taskId) as [string, string];
      expect(h.store.list<Task>('tasks').filter((task) => task.workOrderId === woId)).toHaveLength(2);
      expect(h.store.list<Task>('tasks').every((task) => task.state === 'PLANNED')).toBe(true);
      // Durable: the immutable v1 version is folded from the event log.
      const committed = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: woId })
        .filter((event) => event.type === DAG_COMMITTED)
        .map((event) => (event.payload as { dag: DAGVersion }).dag);
      expect(committed).toHaveLength(1);
      expect(committed[0]!.version).toBe(1);

      await h.client.transitionWorkOrder(woId, { to: 'EXECUTING' });

      // == 3. TWO CONCURRENT TASKS IN ISOLATED WORKTREES ====================
      await h.tickAndSettle();

      expect(taskById(h.store, taskAId).state).toBe('RUNNING');
      expect(taskById(h.store, taskBId).state).toBe('RUNNING');
      const assignments = h.store
        .list<{ taskId: string; branch: string; worktreePath: string }>('assignments')
        .filter((row) => row.taskId === taskAId || row.taskId === taskBId);
      expect(assignments).toHaveLength(2);
      const branches = assignments.map((row) => row.branch);
      const worktrees = assignments.map((row) => row.worktreePath);
      expect(new Set(branches).size).toBe(2);
      expect(new Set(worktrees).size).toBe(2);
      for (const assignment of assignments) {
        expect(existsSync(assignment.worktreePath)).toBe(true);
        expect(assignment.worktreePath.startsWith(h.runtime.paths.root)).toBe(true);
        // The Factory's branch namespace (`wo-<wo>/task-<short>`) — the namespace
        // the E7 policy scope authorizes.
        expect(assignment.branch).toBe(taskWorktreeBranch(assignment.taskId, woId));
      }
      // Durable: a routed model + a routing_decisions provenance row per Task.
      const routing = h.store.list<RoutingDecisionRecord>('routing_decisions');
      expect(routing).toHaveLength(2);
      expect(routing.map((row) => row.taskId).sort()).toEqual([taskAId, taskBId].sort());
      // Durable: the assignment policy decision (repo.write) is recorded.
      const policy = h.store.list<PolicyDecisionRecord>('policy_decisions');
      expect(policy.some((row) => row.action.capability === 'repo.write')).toBe(true);
      // Durable: each assignment is recorded in the event log.
      const assignmentEvents = h.events
        .readEvents()
        .filter((event) => event.type === 'assignment.created');
      expect(assignmentEvents).toHaveLength(2);

      // == 4. QUESTION / WAITING_INPUT ======================================
      const adapterA = h.adapterFor(taskAId);
      adapterA.release(waitingResult('which counter storage should I use?'));
      await h.until('a-waiting', () => taskById(h.store, taskAId).state === 'WAITING_INPUT');

      expect(taskById(h.store, taskAId).state).toBe('WAITING_INPUT');
      const questions = h.store
        .list<{ id: string; type: string; status: string; taskId: string; question: string }>('interactions')
        .filter((row) => row.type === 'QUESTION');
      expect(questions).toHaveLength(1);
      expect(questions[0]!.status).toBe('PENDING');
      expect(questions[0]!.question).toBe('which counter storage should I use?');
      // The WAITING_INPUT transition is durable in the event log.
      expect(
        h.events
          .readEvents({ aggregateType: 'task', aggregateId: taskAId })
          .some(
            (event) =>
              event.type === 'task.transitioned' &&
              (event.payload as { task: Task }).task.state === 'WAITING_INPUT',
          ),
      ).toBe(true);

      const answered = await h.client.answerInteraction(questions[0]!.id, 'use SQLite', 'operator-1');
      expect(answered.task.state).toBe('RUNNING');
      expect(adapterA.delivered.map((answer) => answer.response)).toEqual(['use SQLite']);

      // The runtime continues after the answer and reports completion.
      adapterA.release(completedResult('diff --git a/src/counter.ts b/src/counter.ts\n+export const counter = 1;'));
      await h.until('a-success', () => taskById(h.store, taskAId).state === 'SUCCESS');
      expect(taskById(h.store, taskAId).state).toBe('SUCCESS');

      await h.until('a-verified', () => taskById(h.store, taskAId).state === 'VERIFIED');
      expect(taskById(h.store, taskAId).state).toBe('VERIFIED');
      // The Work Order is not gated while its sibling Task is still executing.
      expect(h.store.get<WorkOrder>('work_orders', woId)!.state).toBe('EXECUTING');
      const bundleA = h.store.list<EvidenceBundle>('evidence_bundles');
      expect(bundleA).toHaveLength(1);
      expect(bundleA[0]!.complete).toBe(true);
      expect(bundleA[0]!.workOrderId).toBe(woId);

      // == 5. FAILURE + RECOVERY (Task B completes, then fails verification) =
      const adapterB = h.adapterFor(taskBId);
      // Inject the failure *before* Task B's completion is routed, so its
      // verification (kicked on the next tick) fails the first time.
      failOnce.add(taskBId);
      adapterB.release(completedResult('diff --git a/src/store.ts b/src/store.ts\n+export const store = 1;'));
      await h.until('b-succeeds', () => taskById(h.store, taskBId).state === 'SUCCESS');
      expect(taskById(h.store, taskBId).state).toBe('SUCCESS');

      // Task B's verification fails: fail closed → REWORK.
      await h.until('b-rework', () => taskById(h.store, taskBId).state === 'REWORK');
      expect(taskById(h.store, taskBId).state).toBe('REWORK');
      expect(h.store.get<WorkOrder>('work_orders', woId)!.state).toBe('REWORK');
      // No bundle for the failed change set — verification never passes silently.
      expect(h.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(1);
      const verFailures = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: woId })
        .filter((event) => event.type === VERIFICATION_FAILED);
      expect(verFailures).toHaveLength(1);
      const failure = (verFailures[0]!.payload as { failures: Array<{ verifier: string; diagnosis: string }> })
        .failures;
      expect(failure.some((record) => record.verifier === 'typecheck')).toBe(true);
      expect(failure.some((record) => record.diagnosis.includes('does not compile'))).toBe(true);

      // E7 bounded recovery: a VERIFICATION_FAILURE opens a new clean-baseline
      // Attempt (module-level seam; the live producer is tracked in #37).
      const failedAttempt = attemptFor(h.store, taskBId)!;
      const recovery = recover(
        { store: h.store, events: h.events },
        {
          attemptId: failedAttempt.id,
          taskId: taskBId,
          workOrderId: woId,
          failureClass: 'VERIFICATION_FAILURE',
          error: 'typecheck failed',
          changedCondition: 'clean-worktree',
          failureIndex: failedAttempt.failureHistory.length,
        },
      );
      expect(recovery.kind).toBe('RETRY_NEW_ATTEMPT');
      const cleanAttempts = h.store
        .list<Attempt>('attempts')
        .filter((attempt) => attempt.taskId === taskBId && attempt.environment === 'clean-worktree');
      expect(cleanAttempts).toHaveLength(1);
      expect(cleanAttempts[0]!.outcome).toBeNull();
      const recoveryEvents = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: woId })
        .filter((event) => event.type === RECOVERY_ACTION_APPLIED);
      expect(recoveryEvents).toHaveLength(1);
      expect((recoveryEvents[0]!.payload as { kind: string }).kind).toBe('RETRY_NEW_ATTEMPT');

      // == 6. REWORK → RE-EXECUTE (the Factory's rework/replan path) ========
      // REWORK is a documented REPLAN state (§5.1); the Factory re-plans and
      // re-executes rather than leaving the rework parked.
      const v2 = await h.client.commitDag(woId, {
        rationale: 'rework: fix the counter type error',
        nodes: [
          { nodeId: 'increment-2', title: 'Increment counter (rework)' },
          { nodeId: 'persist-2', title: 'Persist counter (rework)' },
        ],
      });
      expect(v2.dag.version).toBe(2);
      expect(
        h.events
          .readEvents({ aggregateType: 'work_order', aggregateId: woId })
          .filter((event) => event.type === DAG_COMMITTED)
          .length,
      ).toBe(2);
      await h.client.transitionWorkOrder(woId, { to: 'EXECUTING' });
      const [taskA2Id, taskB2Id] = v2.dag.nodes.map((node) => node.taskId) as [string, string];

      await h.until('a2b2-running', () => taskById(h.store, taskA2Id).state === 'RUNNING' && taskById(h.store, taskB2Id).state === 'RUNNING');
      expect(taskById(h.store, taskA2Id).state).toBe('RUNNING');
      expect(taskById(h.store, taskB2Id).state).toBe('RUNNING');

      h.adapterFor(taskA2Id).release(completedResult('diff --git a/src/counter.ts b/src/counter.ts\n+export const counter = 2;'));
      h.adapterFor(taskB2Id).release(completedResult('diff --git a/src/store.ts b/src/store.ts\n+export const store = 2;'));
      await h.until('a2b2-success', () => taskById(h.store, taskA2Id).state === 'SUCCESS' && taskById(h.store, taskB2Id).state === 'SUCCESS');
      expect(taskById(h.store, taskA2Id).state).toBe('SUCCESS');
      expect(taskById(h.store, taskB2Id).state).toBe('SUCCESS');

      // == 7. EVIDENCE BUNDLE + HUMAN GATE ==================================
      await h.until('human-gate', () => h.store.get<WorkOrder>('work_orders', woId)!.state === 'HUMAN_GATE');
      expect(taskById(h.store, taskA2Id).state).toBe('VERIFIED');
      expect(taskById(h.store, taskB2Id).state).toBe('VERIFIED');
      expect(h.store.get<WorkOrder>('work_orders', woId)!.state).toBe('HUMAN_GATE');

      const bundles = h.store.list<EvidenceBundle>('evidence_bundles');
      expect(bundles).toHaveLength(3); // A(v1) + A2 + B2
      const bundle = bundles.find((candidate) => candidate.changeSetId === `cs_${attemptFor(h.store, taskA2Id)!.id}`)!;
      expect(bundle).toBeDefined();
      expect(bundle.complete).toBe(true);
      expect(bundle.gates).toMatchObject({ deterministic: true, behavioral: true, semantic: true, run: true });
      expect(bundle.criteria.every((criterion) => criterion.status === 'pass')).toBe(true);
      // Each assembled bundle is recorded in the same transaction that persists it.
      const recorded = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: woId })
        .filter((event) => event.type === EVIDENCE_BUNDLE_RECORDED);
      expect(recorded).toHaveLength(3);

      // The human gate is a Factory-owned approval over the durable evidence.
      const woStates = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: woId })
        .filter((event) => event.type === 'work_order.transitioned')
        .map((event) => (event.payload as { workOrder: WorkOrder }).workOrder.state);
      expect(woStates).toContain('EVIDENCE_READY');
      expect(woStates.indexOf('EVIDENCE_READY')).toBeLessThan(woStates.indexOf('HUMAN_GATE'));
      const gated = await h.client.applyGate(woId, 'APPROVE');
      expect(gated.state).toBe('APPROVED');
      expect(
        h.events
          .readEvents({ aggregateType: 'work_order', aggregateId: woId })
          .some(
            (event) =>
              event.type === 'work_order.transitioned' &&
              (event.payload as { workOrder: WorkOrder }).workOrder.state === 'APPROVED',
          ),
      ).toBe(true);

      // == 8. PR / MERGE WITH EVIDENCE LINK =================================
      const branch = await h.github.createBranch(gated);
      expect(branch.name).toBe(`wo-${woId}/task-${woId.slice(0, 8)}`);
      expect(h.transport.branchCalls).toHaveLength(1);

      const pr = await h.github.openPR(bundle, { title: gated.intent });
      expect(pr.head).toBe(branch.name);
      expect(h.transport.prCalls).toHaveLength(1);
      // The PR body links the Work Order and the Evidence Bundle (§28).
      expect(h.transport.prCalls[0]!.body).toContain(bundle.id);
      expect(h.transport.prCalls[0]!.body).toContain(woId);

      // Park + answer the production merge approval (the only §13.2 path to ALLOW):
      // the real E7 `checkDetailed` parks a `deploy.execute { env: production }`
      // approval, the operator answers it through the API, and the merge consumes it.
      const mergePolicy = checkDetailed(
        { store: h.store, events: h.events },
        { taskId: null, workOrderId: woId },
        { capability: 'deploy.execute', resource: { env: 'production' } },
      );
      expect(mergePolicy.verdict).toBe('REQUIRE_HUMAN');
      const parked = (
        await h.client.listApprovals('PENDING')
      ).filter((row) => row.binding.capability === 'deploy.execute');
      expect(parked).toHaveLength(1);
      const answeredApproval = await h.client.answerApproval(parked[0]!.id, {
        decision: 'APPROVAL',
        actor: 'operator-1',
      });
      expect(answeredApproval.status).toBe('ANSWERED');

      const outcome = await h.github.merge({
        workOrderId: woId,
        pullRequest: { repository: pr.repository, number: pr.number },
        evidence: bundle,
        actor: 'operator-1',
      });
      expect(outcome.merge.merged).toBe(true);
      expect(outcome.workOrder.state).toBe('MERGED');
      // Durable: the merge was pinned to the verified head SHA, and the Work
      // Order's MERGED transition is logged.
      expect(h.transport.mergeCalls).toEqual([
        { repository: 'acme/widgets', number: pr.number, sha: 'sha_head_1' },
      ]);
      expect(h.store.get<WorkOrder>('work_orders', woId)!.state).toBe('MERGED');
      const mergedEvent = h.events
        .readEvents({ aggregateType: 'work_order', aggregateId: woId })
        .some(
          (event) =>
            event.type === 'work_order.transitioned' &&
            (event.payload as { workOrder: WorkOrder }).workOrder.state === 'MERGED',
        );
      expect(mergedEvent).toBe(true);

      // == 9. TELEMETRY =====================================================
      const attemptIds = h.store
        .list<Attempt>('attempts')
        .filter((attempt) => attempt.outcome === 'success')
        .map((attempt) => attempt.id);
      expect(attemptIds.length).toBeGreaterThanOrEqual(4);
      for (const attemptId of attemptIds) {
        const receipts = h.events
          .readEvents({ aggregateType: 'attempt', aggregateId: attemptId })
          .filter((event) => event.type === TELEMETRY_ATTEMPT_RECORDED);
        expect(receipts).toHaveLength(1);
        const record = readAttemptTelemetry(h.events, attemptId)!;
        expect(record).not.toBeNull();
        expect(record.layers.outcome.outcome).toBe('success');
      }
      const observatory = await h.client.observatory();
      expect(observatory.verifiedPerDay.length).toBeGreaterThan(0);
      expect(observatory.verifiedPerDay[0]!.verifiedChanges).toBeGreaterThanOrEqual(1);
      expect(observatory.rework).toBeGreaterThanOrEqual(1);
      // The §23 drill-down resolves the full seven-stage chain.
      const drill = await h.client.drillDown(woId);
      expect(drill.chain.map((step) => step.stage)).toEqual([
        'work_order',
        'task',
        'attempt',
        'trace',
        'verification',
        'evidence',
        'human_decision',
      ]);

      // == 10. RESTART ======================================================
      // Tear down the live server and rebuild the deps on the same database —
      // the boot path `factory start` takes (E9.6 reconciliation runs first).
      const durableBefore = {
        events: h.events.readEvents().length,
        bundles: h.store.list<EvidenceBundle>('evidence_bundles').length,
        tasks: h.store.list<Task>('tasks').length,
      };
      h.server.stop();
      h.store.close();
      h.readStore.close();
      toreDown = true;

      restartDeps = buildServerDeps(h.runtime, { spawn: () => new ScriptedHerdr() });

      expect(restartDeps.store.get<WorkOrder>('work_orders', woId)!.state).toBe('MERGED');
      expect(restartDeps.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(3);
      expect(restartDeps.store.list<Task>('tasks')).toHaveLength(durableBefore.tasks);
      // The append-only event log — the execution history — survives the restart.
      expect(restartDeps.events.readEvents().length).toBeGreaterThanOrEqual(durableBefore.events);
      // Reconciliation is idempotent across a second boot over the same data.
      const second = buildServerDeps(h.runtime, { spawn: () => new ScriptedHerdr() });
      try {
        expect(second.store.get<WorkOrder>('work_orders', woId)!.state).toBe('MERGED');
        expect(second.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(3);
      } finally {
        second.store.close();
      }
    } finally {
      restartDeps?.store.close();
      // The restart step tears the harness down itself; only close it here when
      // the trace failed before reaching that point.
      if (!toreDown) h.close();
    }
  }, 30000);
});
