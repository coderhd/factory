import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFactoryClient } from '../../src/factory/api/client';
import { startFactoryServer } from '../../src/factory/api/server';
import {
  buildEvidenceBundle,
  type EvidenceBundle,
} from '../../src/factory/evidence/bundle';
import { createEmptyEvidenceReadPort } from '../../src/factory/observatory/observatory';
import { openEventLog } from '../../src/factory/events/log';
import { openStateStore, type StateStore } from '../../src/factory/state/store';
import { createVerificationEngine } from '../../src/factory/verification/engine';
import { createSemanticVerifier } from '../../src/factory/verification/semantic';
import type { WorkOrder } from '../../src/factory/domain/workOrder';
import { checkDetailed as policyCheck, answerApproval, emergencyStop, type ApprovalRecord } from '../../src/factory/policy/policy';
import { type PolicyDocument } from '../../src/factory/policy/policy';
import {
  acceptanceCriteriaFromIssue,
  buildPullRequestBody,
  createGitHubAdapter,
  createGitHubRestTransport,
  GitHubTransportError,
  issueSourceRef,
  ISSUE_SOURCE_PREFIX,
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
 * E6.1 (#20) GitHub import + PR opening, spec §4.2/§28.
 *
 * Hermetic: the GitHub transport is a mock (Ruling R6) — there is no live
 * GitHub and no network. The Work Order reconcile path goes through the E2 API
 * over loopback so the server stays the sole mutation authority, and the PR
 * body is asserted to link the E1 Work Order and the E5 Evidence Bundle.
 */

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'factory-e6-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Providers under test: GitHub transport mock + Factory server harness
// ---------------------------------------------------------------------------

/** The mocked GitHub transport (Ruling R6): records every call, hits no network. */
class MockGitHubTransport implements GitHubTransport {
  issues = new Map<string, GitHubIssue>();
  issueCalls: IssueRef[] = [];
  branchCalls: CreateBranchInput[] = [];
  prCalls: CreatePullRequestInput[] = [];
  /** PR detail the merge gate's hygiene checks read back (keyed by PR number). */
  prDetails = new Map<number, GitHubPullRequestDetail>();
  getPrCalls: PullRequestRef[] = [];
  mergeCalls: MergePullRequestInput[] = [];
  failGetIssue = false;
  private prNumber = 100;

  async getIssue(ref: IssueRef): Promise<GitHubIssue> {
    this.issueCalls.push({ ...ref });
    if (this.failGetIssue) throw new Error('github transport unavailable');
    const issue = this.issues.get(issueKey(ref));
    if (!issue) throw new Error(`no such issue: ${issueKey(ref)}`);
    return issue;
  }

  async createBranch(input: CreateBranchInput) {
    this.branchCalls.push({ ...input });
    return { repository: input.repository, name: input.branch, sha: 'sha_base' };
  }

  async createPullRequest(input: CreatePullRequestInput) {
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
    this.getPrCalls.push({ ...ref });
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
      message: 'Pull Request successfully merged',
    };
  }
}

const issueKey = (ref: IssueRef): string => `${ref.repository}#${ref.number}`;

const issueFixture = (overrides: Partial<GitHubIssue> = {}): GitHubIssue => ({
  repository: 'acme/widgets',
  number: 42,
  title: 'Add the widget counter',
  body: [
    'We want a counter that persists.',
    '',
    'Acceptance criteria:',
    '- [ ] counter increments',
    '- [x] counter persists across restarts',
    '- not a checkbox',
  ].join('\n'),
  labels: ['enhancement'],
  url: 'https://github.com/acme/widgets/issues/42',
  ...overrides,
});

interface Harness {
  store: StateStore;
  events: ReturnType<typeof openEventLog>;
  transport: MockGitHubTransport;
  client: ReturnType<typeof createFactoryClient>;
  adapter: ReturnType<typeof createGitHubAdapter>;
  /** Optional policy override; defaults to the embedded policy. */
  policy?: PolicyDocument;
  /** Every URL the adapter drove through the Factory client (loopback only). */
  factoryRequests: string[];
  stop(): void;
}

const FACTORY_BASE_URL = 'http://factory.local:8787';

/**
 * The E6 change-set branch: the E3 `wo-<id>/task-<…>` namespace, with the leaf
 * keyed on the **Work Order** (E6 opens one PR per Work Order). E3's worktree
 * branch keys the leaf on the **Task** (`taskWorktreeBranch`); the leaves differ
 * while the namespace (and so policy scope) agrees. Per-task alignment: #37.
 */
const expectedBranchName = (workOrderId: string): string =>
  `wo-${workOrderId}/task-${workOrderId.slice(0, 8)}`;

function harness(): Harness {
  const store = openStateStore(join(workDir, 'factory.db'));
  const events = openEventLog(store.db);
  const server = startFactoryServer(
    { store, events, evidence: createEmptyEvidenceReadPort() },
    { port: 0, hostname: '127.0.0.1' },
  );

  // A recording wrapper where the client is constructed, so we can prove every
  // HTTP request the adapter causes goes to the Factory server — never GitHub.
  const factoryRequests: string[] = [];
  const recordingFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    factoryRequests.push(url);
    return fetch(input as never, init);
  }) as unknown as typeof fetch;

  const client = createFactoryClient({ baseUrl: server.url, fetch: recordingFetch });
  const transport = new MockGitHubTransport();
  const h: Harness = {
    store,
    events,
    transport,
    client,
    adapter: null as unknown as ReturnType<typeof createGitHubAdapter>,
    factoryRequests,
    stop(): void {
      server.stop();
      store.close();
    },
  };
  h.adapter = createGitHubAdapter({
    transport,
    client,
    factoryBaseUrl: FACTORY_BASE_URL,
    // E7 policy (deps-first `checkDetailed`) wired as the adapter's
    // authorization port; the store/events are the same ones the loopback
    // server owns. The outcome carries resolvedBy/spentApprovalId/approvalActor
    // so the merge gate can bind the ALLOW to the approving human. Tests may
    // override `h.policy` before exercising a gated path.
    checkPolicy: (subject, action) => policyCheck({ store, events, policy: h.policy }, subject, action),
    // E9.8: the durable Evidence Bundle read-back — the merge gate's source of
    // truth. Tests persist the bundle (as E9.4's scheduler does) before merging.
    readEvidence: (id) => store.get<EvidenceBundle>('evidence_bundles', id),
  });

  return h;
}

// ---------------------------------------------------------------------------
// T1 — issue import reconciles to a Work Order (E2 API is the only writer)
// ---------------------------------------------------------------------------

describe('E6.1 GitHub issue import → Work Order (spec §4.2, §28)', () => {
  it('imports an issue into a DRAFT Work Order through the E2 API', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);

      const { workOrder, created } = await h.adapter.importIssue({
        repository: issue.repository,
        number: issue.number,
      });

      expect(created).toBe(true);
      expect(workOrder.state).toBe('DRAFT');
      expect(workOrder.repository).toBe('acme/widgets');
      expect(workOrder.intent).toBe('Add the widget counter');
      // Intent + acceptance criteria captured from the issue body checkboxes.
      expect(workOrder.acceptanceCriteria).toEqual([
        'counter increments',
        'counter persists across restarts',
      ]);
      // Provenance marker is durable on the WO so re-imports reconcile.
      expect(workOrder.constraints).toContain(issueSourceRef(issue));
      expect(workOrder.constraints).toContain(`${ISSUE_SOURCE_PREFIX}acme/widgets#42`);

      // The server (sole mutation authority) actually wrote Factory state.
      expect(h.store.get<WorkOrder>('work_orders', workOrder.id)).not.toBeNull();
      expect(h.events.readEvents().some((e) => e.type === 'work_order.created')).toBe(true);
      expect(h.transport.issueCalls).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  it('is idempotent: re-importing the same issue maps to the same WO, never a duplicate', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);

      const first = await h.adapter.importIssue({ repository: issue.repository, number: 42 });
      const second = await h.adapter.importIssue({ repository: issue.repository, number: 42 });

      expect(second.created).toBe(false);
      expect(second.workOrder.id).toBe(first.workOrder.id);
      expect(h.store.list<WorkOrder>('work_orders')).toHaveLength(1);
      // The issue is re-fetched (source of truth is GitHub) but not re-created.
      expect(h.transport.issueCalls).toHaveLength(2);
    } finally {
      h.stop();
    }
  });

  it('keeps distinct issues distinct and does not reconcile a different repository', async () => {
    const h = harness();
    try {
      const a = issueFixture({ repository: 'acme/widgets', number: 42 });
      const b = issueFixture({ repository: 'acme/widgets', number: 43, title: 'Other work' });
      const otherRepo = issueFixture({ repository: 'acme/gadgets', number: 42 });
      for (const issue of [a, b, otherRepo]) h.transport.issues.set(issueKey(issue), issue);

      const first = await h.adapter.importIssue({ repository: 'acme/widgets', number: 42 });
      const distinct = await h.adapter.importIssue({ repository: 'acme/widgets', number: 43 });
      const crossRepo = await h.adapter.importIssue({ repository: 'acme/gadgets', number: 42 });

      expect(new Set([first.workOrder.id, distinct.workOrder.id, crossRepo.workOrder.id]).size).toBe(3);
      expect(h.store.list<WorkOrder>('work_orders')).toHaveLength(3);
    } finally {
      h.stop();
    }
  });

  it('fails closed when the transport cannot fetch the issue (no WO created)', async () => {
    const h = harness();
    try {
      h.transport.failGetIssue = true;
      await expect(h.adapter.importIssue({ repository: 'acme/widgets', number: 42 })).rejects.toThrow(
        /github transport unavailable/,
      );
      expect(h.store.list<WorkOrder>('work_orders')).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('captures no acceptance criteria when the issue body has no checkboxes', () => {
    const issue = issueFixture({ body: 'Just prose, no task list.' });
    expect(acceptanceCriteriaFromIssue(issue)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T2 — branch creation (policy-gated: `branch.create`, E7 §8-1)
// ---------------------------------------------------------------------------

describe('E6.1 GitHub branch creation', () => {
  it('creates a deterministic Work-Order branch from the default base after a branch.create ALLOW', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);
      const { workOrder } = await h.adapter.importIssue({
        repository: issue.repository,
        number: issue.number,
      });
      // The E6 branch is the E3 namespace `wo-<woId>/task-<short>`; the embedded
      // `branch.create` scope binds `wo-*&#47;**`, so it is authorized as-is
      // with no bespoke deployment grant.

      const branch = await h.adapter.createBranch(workOrder);

      expect(branch.name).toBe(expectedBranchName(workOrder.id));
      expect(branch.repository).toBe('acme/widgets');
      expect(h.transport.branchCalls).toEqual([
        { repository: 'acme/widgets', branch: expectedBranchName(workOrder.id), baseBranch: 'main' },
      ]);
      // The side effect was authorized by an ALLOW decision for `branch.create`.
      const decision = h.store
        .list<{ action: { capability: string }; decision: string }>('policy_decisions')
        .find((row) => row.action.capability === 'branch.create');
      expect(decision?.decision).toBe('ALLOW');
    } finally {
      h.stop();
    }
  });

  it('honours an explicit base branch', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);
      const { workOrder } = await h.adapter.importIssue({
        repository: issue.repository,
        number: issue.number,
      });

      const branch = await h.adapter.createBranch(workOrder, 'develop');
      expect(branch.name).toBe(expectedBranchName(workOrder.id));
      expect(h.transport.branchCalls[0]?.baseBranch).toBe('develop');
    } finally {
      h.stop();
    }
  });

  it('fails closed when e-stop is active: no GitHub branch is created', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);
      const { workOrder } = await h.adapter.importIssue({
        repository: issue.repository,
        number: issue.number,
      });
      emergencyStop({ store: h.store, events: h.events }, { actor: 'operator-1' });

      await expect(h.adapter.createBranch(workOrder)).rejects.toMatchObject({
        name: 'PolicyBlockedError',
        capability: 'branch.create',
        verdict: 'DENY',
      });
      expect(h.transport.branchCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('fails closed when no policy check is wired (no ungoverned branch)', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);
      const { workOrder } = await h.adapter.importIssue({
        repository: issue.repository,
        number: issue.number,
      });
      const unpolicied = createGitHubAdapter({
        transport: h.transport,
        client: h.client,
        factoryBaseUrl: FACTORY_BASE_URL,
      });

      await expect(unpolicied.createBranch(workOrder)).rejects.toMatchObject({        name: 'PolicyBlockedError',
        verdict: 'NO_POLICY',
      });
      expect(h.transport.branchCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — openPR(evidence): PR body links the E1 Work Order + E5 Evidence Bundle
// ---------------------------------------------------------------------------

/** Build a genuine E5 Evidence Bundle for `workOrder` (the receipt the PR links). */
async function realBundle(workOrder: WorkOrder): Promise<EvidenceBundle> {
  const criteria = workOrder.acceptanceCriteria;
  const engine = createVerificationEngine();
  engine.registerCheck({
    id: 'unit',
    category: 'deterministic',
    kind: 'unit',
    run: () => ({ passed: true, evidence: { summary: 'unit: ok' } }),
  });
  engine.registerCheck({
    id: 'security',
    category: 'deterministic',
    kind: 'security',
    run: () => ({ passed: true, evidence: { summary: 'security: ok' } }),
  });
  engine.registerCheck({
    id: 'contract',
    category: 'behavioral',
    kind: 'contract',
    run: () => ({ passed: true, evidence: { summary: 'contract: ok' } }),
  });
  const changeSet = {
    id: 'cs_e6',
    attemptId: 'attempt_e6',
    taskId: 'task_e6',
    diff: 'diff --git a/counter b/counter',
    artifactIds: [],
  };
  const run = await engine.verify(changeSet, {
    criteria,
    criterionChecks: {
      [criteria[0]!]: ['unit'],
      [criteria[1]!]: ['contract'],
    },
  });
  const semantic = await createSemanticVerifier({
    judge: {
      identity: { provider: 'other', model: 'judge-model' },
      falsify: (context) =>
        context.criteria.map((criterion) => ({
          criterion,
          falsified: false,
          evidence: { summary: `${criterion}: survived falsification` },
        })),
    },
    generator: { provider: 'writer', model: 'writer-model' },
    prompt: { id: 'verify', version: '1' },
    rubric: ['seek counterexamples'],
  }).verify({
    workOrder,
    changeSet,
    deterministic: run.deterministic,
    behavioral: run.behavioral,
    criteria,
  });

  return buildEvidenceBundle({ workOrder, changeSet, run, semantic, attempts: [] });
}

describe('E6.1 openPR(evidence): PR body links the WO and Evidence Bundle', () => {
  it('opens a PR whose body links the Work Order and the E5 Evidence Bundle', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);
      const { workOrder } = await h.adapter.importIssue({
        repository: issue.repository,
        number: issue.number,
      });
      const bundle = await realBundle(workOrder);
      expect(bundle.complete).toBe(true);

      const pr = await h.adapter.openPR(bundle);

      expect(h.transport.prCalls).toHaveLength(1);
      const call = h.transport.prCalls[0]!;
      expect(call.repository).toBe('acme/widgets');
      expect(call.head).toBe(expectedBranchName(workOrder.id));
      expect(call.base).toBe('main');

      // The PR body links both the Work Order and the immutable Evidence Bundle.
      const woLink = `${FACTORY_BASE_URL}/api/work-orders/${workOrder.id}`;
      const evidenceLink = `${FACTORY_BASE_URL}/api/observatory/work-orders/${workOrder.id}/drill-down`;
      expect(call.body).toContain(`[${workOrder.id}](${woLink})`);
      expect(call.body).toContain(`[${bundle.id}](${evidenceLink})`);

      expect(pr.url).toBe('https://github.com/acme/widgets/pull/101');
      expect(pr.head).toBe(expectedBranchName(workOrder.id));

      // The side effect was authorized by an ALLOW decision for `pr.create`.
      const decision = h.store
        .list<{ action: { capability: string }; decision: string }>('policy_decisions')
        .find((row) => row.action.capability === 'pr.create');
      expect(decision?.decision).toBe('ALLOW');
    } finally {
      h.stop();
    }
  });

  it('fails closed on openPR when e-stop is active: no GitHub PR is opened', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);
      const { workOrder } = await h.adapter.importIssue({
        repository: issue.repository,
        number: issue.number,
      });
      const bundle = await realBundle(workOrder);
      emergencyStop({ store: h.store, events: h.events }, { actor: 'operator-1' });

      await expect(h.adapter.openPR(bundle)).rejects.toMatchObject({
        name: 'PolicyBlockedError',
        capability: 'pr.create',
        verdict: 'DENY',
      });
      expect(h.transport.prCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('fails closed on openPR when no policy check is wired (no ungoverned PR)', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);
      const { workOrder } = await h.adapter.importIssue({
        repository: issue.repository,
        number: issue.number,
      });
      const bundle = await realBundle(workOrder);
      const unpolicied = createGitHubAdapter({
        transport: h.transport,
        client: h.client,
        factoryBaseUrl: FACTORY_BASE_URL,
      });

      await expect(unpolicied.openPR(bundle)).rejects.toMatchObject({
        name: 'PolicyBlockedError',
        verdict: 'NO_POLICY',
      });
      expect(h.transport.prCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('resolves the Work Order from the bundle through the E2 API (not a second local read)', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);
      const { workOrder } = await h.adapter.importIssue({
        repository: issue.repository,
        number: issue.number,
      });
      const bundle = await realBundle(workOrder);

      await h.adapter.openPR(bundle);

      expect(
        h.factoryRequests.some((url) => url.endsWith(`/api/work-orders/${workOrder.id}`)),
      ).toBe(true);
    } finally {
      h.stop();
    }
  });

  it('fails closed when the Work Order has no repository to open a PR against', async () => {
    const h = harness();
    try {
      const workOrder = await h.client.submitWorkOrder({ intent: 'orphan change', acceptanceCriteria: ['x'] });
      const bundle = {
        id: 'eb_orphan',
        workOrderId: workOrder.id,
        complete: true,
        gates: { deterministic: true, behavioral: true, semantic: true, run: true },
      };
      await expect(h.adapter.openPR(bundle)).rejects.toThrow(/no repository/);
      expect(h.transport.prCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('renders the verification gates and completeness on the PR body', () => {
    const body = buildPullRequestBody({
      workOrder: {
        id: 'wo_1',
        intent: 'x',
        acceptanceCriteria: [],
        riskTier: 'YELLOW',
        constraints: [],
        outOfScope: [],
        repository: 'acme/widgets',
        requiredVerification: [],
        state: 'EVIDENCE_READY',
        createdAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:00:00.000Z',
      },
      evidence: {
        id: 'eb_1',
        workOrderId: 'wo_1',
        complete: true,
        gates: { deterministic: true, behavioral: false, semantic: true, run: true },
      },
      factoryBaseUrl: FACTORY_BASE_URL,
    });

    expect(body).toContain('Evidence Bundle');
    expect(body).toContain('eb_1');
    expect(body).toContain('behavioral: FAIL');
    expect(body).toContain('complete: true');
  });
});

// ---------------------------------------------------------------------------
// T4 — the adapter is the only external integration; the path is hermetic
// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('E6.1 adapter is the sole GitHub integration (spec §4.2)', () => {
  const repoRoot = join(import.meta.dir, '..', '..');

  it('only the adapter and its composition root reference the GitHub transport seam', () => {
    const integrators = sourceFiles(join(repoRoot, 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes('GitHubTransport'))
      .map((file) => file.slice(repoRoot.length + 1))
      .sort();

    // The adapter owns the seam; the CLI composition root (`buildGitHubAdapter`)
    // injects a transport, mirroring `buildServerDeps`. No other module does.
    expect(integrators).toEqual([
      'src/cli/factory.ts',
      'src/factory/github/adapter.ts',
    ]);
  });

  it('the GitHub REST transport is the only GitHub network code in src', () => {
    const networkFiles = sourceFiles(join(repoRoot, 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes('api.github.com'))
      .map((file) => file.slice(repoRoot.length + 1))
      .sort();

    expect(networkFiles).toEqual(['src/factory/github/adapter.ts']);
  });

  it('drives the whole import → branch → PR path over the Factory server, never GitHub', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);

      const { workOrder } = await h.adapter.importIssue({
        repository: issue.repository,
        number: issue.number,
      });
      await h.adapter.createBranch(workOrder);
      await h.adapter.openPR(await realBundle(workOrder));

      // Every HTTP request caused by the adapter went to the Factory server.
      expect(h.factoryRequests.length).toBeGreaterThan(0);
      expect(h.factoryRequests.every((url) => url.startsWith(`http://127.0.0.1:`))).toBe(true);
      expect(h.factoryRequests.some((url) => url.includes('github.com'))).toBe(false);
      // GitHub was reached only through the injected transport seam.
      expect(h.transport.issueCalls).toHaveLength(1);
      expect(h.transport.branchCalls).toHaveLength(1);
      expect(h.transport.prCalls).toHaveLength(1);
    } finally {
      h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// T5 — the concrete GitHub REST transport (hermetic: injected fetch, no network)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function recordingFetch(respond: (request: RecordedRequest) => Response): {
  impl: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const request = { method, url, body, headers };
    calls.push(request);
    return respond(request);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('E6.1 GitHub REST transport (injected fetch, never live GitHub)', () => {
  const token = 'secret-token';

  it('fetches and maps an issue (labels as strings or objects)', async () => {
    const { impl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            title: 'Add counter',
            body: '- [ ] increments',
            html_url: 'https://github.com/acme/widgets/issues/7',
            labels: ['bug', { name: 'p1' }, 42],
          }),
          { status: 200 },
        ),
    );
    const transport = createGitHubRestTransport({ token, fetch: impl });

    const issue = await transport.getIssue({ repository: 'acme/widgets', number: 7 });

    expect(issue).toEqual({
      repository: 'acme/widgets',
      number: 7,
      title: 'Add counter',
      body: '- [ ] increments',
      labels: ['bug', 'p1'],
      url: 'https://github.com/acme/widgets/issues/7',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/widgets/issues/7');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('creates a branch by resolving the base ref, then pointing a new ref at its sha', async () => {
    const { impl, calls } = recordingFetch((request) =>
      new Response(
        JSON.stringify(
          request.method === 'GET'
            ? { object: { sha: 'abc123' } }
            : { ref: 'refs/heads/factory/wo_1' },
        ),
        { status: request.method === 'GET' ? 200 : 201 },
      ),
    );
    const transport = createGitHubRestTransport({ token, fetch: impl });

    const branch = await transport.createBranch({
      repository: 'acme/widgets',
      branch: 'factory/wo_1',
      baseBranch: 'main',
    });

    expect(branch).toEqual({ repository: 'acme/widgets', name: 'factory/wo_1', sha: 'abc123' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.github.com/repos/acme/widgets/git/ref/heads/main',
      'POST https://api.github.com/repos/acme/widgets/git/refs',
    ]);
    expect(calls[1]!.body).toEqual({ ref: 'refs/heads/factory/wo_1', sha: 'abc123' });
  });

  it('opens a PR and maps the GitHub response back', async () => {
    const { impl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            number: 12,
            html_url: 'https://github.com/acme/widgets/pull/12',
            head: { ref: 'factory/wo_1' },
            base: { ref: 'main' },
          }),
          { status: 201 },
        ),
    );
    const transport = createGitHubRestTransport({ token, fetch: impl });

    const pr = await transport.createPullRequest({
      repository: 'acme/widgets',
      title: 'Add counter',
      body: 'links here',
      head: 'factory/wo_1',
      base: 'main',
    });

    expect(pr).toEqual({
      repository: 'acme/widgets',
      number: 12,
      url: 'https://github.com/acme/widgets/pull/12',
      head: 'factory/wo_1',
      base: 'main',
    });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/widgets/pulls');
    expect(calls[0]!.body).toEqual({
      title: 'Add counter',
      body: 'links here',
      head: 'factory/wo_1',
      base: 'main',
    });
  });

  it('fails loudly with the HTTP status on a non-2xx GitHub response', async () => {
    const { impl } = recordingFetch(
      () => new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 }),
    );
    const transport = createGitHubRestTransport({ token, fetch: impl });

    await expect(transport.getIssue({ repository: 'acme/widgets', number: 7 })).rejects.toMatchObject({
      status: 422,
    });
    await expect(transport.getIssue({ repository: 'acme/widgets', number: 7 })).rejects.toBeInstanceOf(
      GitHubTransportError,
    );
  });
});

// ---------------------------------------------------------------------------
// T6 — merge(gate): Factory-authorized merge (E6.2 #21; spec §4.2, §5.1, §28)
// ---------------------------------------------------------------------------

/**
 * Merge is the production deployment (ADR 14 / policy §8-3): it may happen only
 * when the Work Order is APPROVED, E7's `deploy.execute { env: production }`
 * check consumes an operator APPROVAL into ALLOW, the PR is hygine-clean and
 * links the Evidence Bundle, and the actor is not the change's writer. All
 * transport I/O stays on the injected mock (no live GitHub).
 */

/** The single production binding the merge path authorizes (policy §8-3). */
const MERGE_ACTION = { capability: 'deploy.execute', resource: { env: 'production' } } as const;

const ON_THE_WAY_TO_GATE = [
  'READY',
  'PLANNING',
  'EXECUTING',
  'VERIFYING',
  'EVIDENCE_READY',
  'HUMAN_GATE',
] as const;

async function importWorkOrder(h: Harness): Promise<WorkOrder> {
  const issue = issueFixture();
  h.transport.issues.set(issueKey(issue), issue);
  const { workOrder } = await h.adapter.importIssue({
    repository: issue.repository,
    number: issue.number,
  });
  return workOrder;
}

/** Drive a freshly imported Work Order up to HUMAN_GATE through the E2 API. */
async function advanceToHumanGate(h: Harness, workOrder: WorkOrder): Promise<WorkOrder> {
  let current = workOrder;
  for (const to of ON_THE_WAY_TO_GATE) {
    current = await h.client.transitionWorkOrder(workOrder.id, { to });
  }
  return current;
}

/** APPROVE the human gate (spec §5.1 HUMAN_GATE → APPROVED). */
async function approve(h: Harness, workOrder: WorkOrder): Promise<WorkOrder> {
  return h.client.applyGate(workOrder.id, 'APPROVE');
}

/** Import → … → APPROVED → a real E5 bundle (persisted) → an opened PR. */
async function approvedWorkOrderWithPr(
  h: Harness,
): Promise<{ workOrder: WorkOrder; bundle: EvidenceBundle; pr: GitHubPullRequest }> {
  const workOrder = await approve(h, await advanceToHumanGate(h, await importWorkOrder(h)));
  const bundle = await realBundle(workOrder);
  // E9.8: the durable receipt must exist before the merge gate will consider it.
  h.store.set('evidence_bundles', bundle.id, bundle);
  const pr = await h.adapter.openPR(bundle);
  return { workOrder, bundle, pr };
}

/**
 * Park the E7 approval for the production merge and have an operator answer it.
 * `answeredBy` defaults to the actor who will perform the merge; pass a
 * different value to prove the merge gate binds the actor to the approval.
 */
function parkMergeApproval(
  h: Harness,
  workOrderId: string,
  answeredBy: string,
): ApprovalRecord {
  const deps = { store: h.store, events: h.events };
  expect(policyCheck(deps, { taskId: null, workOrderId }, MERGE_ACTION).verdict).toBe('REQUIRE_HUMAN');
  const parked = h.store
    .list<ApprovalRecord>('interactions')
    .find((interaction) => interaction.type === 'APPROVAL')!;
  answerApproval(deps, parked.id, { decision: 'APPROVAL', actor: answeredBy });
  return h.store.get<ApprovalRecord>('interactions', parked.id)!;
}

function mergeGate(
  workOrderId: string,
  bundle: EvidenceBundle,
  pr: GitHubPullRequest,
  overrides: { actor?: string; pullRequest?: PullRequestRef } = {},
) {
  return {
    workOrderId,
    pullRequest: overrides.pullRequest ?? { repository: pr.repository, number: pr.number },
    evidence: bundle,
    actor: overrides.actor ?? 'operator-1',
  };
}

describe('E6.2 merge(gate): blocked until APPROVED + ALLOW + hygiene + no self-merge', () => {
  it('blocks a merge until the Work Order is APPROVED', async () => {
    const h = harness();
    try {
      const workOrder = await advanceToHumanGate(h, await importWorkOrder(h));
      const bundle = await realBundle(workOrder);
      const pr = await h.adapter.openPR(bundle);

      await expect(h.adapter.merge(mergeGate(workOrder.id, bundle, pr))).rejects.toMatchObject({
        name: 'MergeBlockedError',
        reason: 'WORK_ORDER_NOT_APPROVED',
      });
      expect(h.transport.mergeCalls).toHaveLength(0);
      expect(h.transport.getPrCalls).toHaveLength(0);
      expect((await h.client.getWorkOrder(workOrder.id)).workOrder.state).toBe('HUMAN_GATE');
    } finally {
      h.stop();
    }
  });

  it('blocks a merge without the E7 policy ALLOW (parks the approval instead)', async () => {
    const h = harness();
    try {
      const { workOrder, bundle, pr } = await approvedWorkOrderWithPr(h);

      await expect(h.adapter.merge(mergeGate(workOrder.id, bundle, pr))).rejects.toMatchObject({
        name: 'MergeBlockedError',
        reason: 'POLICY_NOT_ALLOWED',
      });
      expect(h.transport.mergeCalls).toHaveLength(0);
      // The production merge parked a PENDING approval on E7's ledger instead of merging.
      const approvals = h.store
        .list<ApprovalRecord>('interactions')
        .filter((interaction) => interaction.type === 'APPROVAL');
      expect(approvals).toHaveLength(1);
      expect(approvals[0]!.status).toBe('PENDING');
      expect((await h.client.getWorkOrder(workOrder.id)).workOrder.state).toBe('APPROVED');
    } finally {
      h.stop();
    }
  });

  it('blocks a merge when the approving human differs from the merging actor (actor not bound)', async () => {
    const h = harness();
    try {
      const { workOrder, bundle, pr } = await approvedWorkOrderWithPr(h);
      // The approval was authorized by operator-2, but operator-1 tries to merge.
      const approval = parkMergeApproval(h, workOrder.id, 'operator-2');

      await expect(
        h.adapter.merge(mergeGate(workOrder.id, bundle, pr, { actor: 'operator-1' })),
      ).rejects.toMatchObject({
        name: 'MergeBlockedError',
        reason: 'APPROVAL_ACTOR_MISMATCH',
      });
      expect(h.transport.mergeCalls).toHaveLength(0);
      // The verdict resolves to ALLOW by consuming the approval; the merge is
      // then refused because the actor is not the approver. The approval is
      // already spent (the E7 check is the last pre-I/O gate and has a side
      // effect) — the mismatch blocks the merge, not the spend.
      expect(h.store.get<ApprovalRecord>('interactions', approval.id)!.status).toBe('SPENT');
      expect((await h.client.getWorkOrder(workOrder.id)).workOrder.state).toBe('APPROVED');
    } finally {
      h.stop();
    }
  });

  it('blocks a self-merge: the writer identity may not be the approver/merger', async () => {
    const h = harness();
    try {
      const { workOrder, bundle, pr } = await approvedWorkOrderWithPr(h);
      const writer = `${bundle.provenance.generator.provider}/${bundle.provenance.generator.model}`;

      // No approval is parked: the no-self-merge guard fails closed before the
      // policy check would consume anything.
      await expect(
        h.adapter.merge(mergeGate(workOrder.id, bundle, pr, { actor: writer })),
      ).rejects.toMatchObject({ name: 'MergeBlockedError', reason: 'SELF_MERGE' });
      expect(h.transport.mergeCalls).toHaveLength(0);
      expect(h.store.list<ApprovalRecord>('interactions')).toHaveLength(0);
      expect((await h.client.getWorkOrder(workOrder.id)).workOrder.state).toBe('APPROVED');
    } finally {
      h.stop();
    }
  });

  it('blocks a merge whose PR body does not link the Evidence Bundle', async () => {
    const h = harness();
    try {
      const { workOrder, bundle, pr } = await approvedWorkOrderWithPr(h);
      // Tamper with the live PR: the change-set receipt link is gone.
      h.transport.prDetails.set(pr.number, {
        ...h.transport.prDetails.get(pr.number)!,
        body: '## Factory change set\n\n(links removed)',
      });

      await expect(h.adapter.merge(mergeGate(workOrder.id, bundle, pr))).rejects.toMatchObject({
        name: 'MergeBlockedError',
        reason: 'EVIDENCE_LINK_MISSING',
      });
      expect(h.transport.mergeCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('blocks a merge when the PR head is not the Work Order Factory branch (failing hygiene)', async () => {
    const h = harness();
    try {
      const { workOrder, bundle, pr } = await approvedWorkOrderWithPr(h);
      h.transport.prDetails.set(pr.number, {
        ...h.transport.prDetails.get(pr.number)!,
        head: 'someone-elses-branch',
      });

      await expect(h.adapter.merge(mergeGate(workOrder.id, bundle, pr))).rejects.toMatchObject({
        name: 'MergeBlockedError',
        reason: 'HYGIENE_FAILED',
      });
      expect(h.transport.mergeCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('blocks a merge of an already-merged PR (no double merge)', async () => {
    const h = harness();
    try {
      const { workOrder, bundle, pr } = await approvedWorkOrderWithPr(h);
      h.transport.prDetails.set(pr.number, {
        ...h.transport.prDetails.get(pr.number)!,
        merged: true,
        state: 'closed',
      });

      await expect(h.adapter.merge(mergeGate(workOrder.id, bundle, pr))).rejects.toMatchObject({
        name: 'MergeBlockedError',
        reason: 'HYGIENE_FAILED',
      });
      expect(h.transport.mergeCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('blocks a merge when e-stop is active before any GitHub I/O', async () => {
    const h = harness();
    try {
      const { workOrder, bundle, pr } = await approvedWorkOrderWithPr(h);
      parkMergeApproval(h, workOrder.id, 'operator-1');
      emergencyStop({ store: h.store, events: h.events }, { actor: 'operator-1' });

      await expect(h.adapter.merge(mergeGate(workOrder.id, bundle, pr))).rejects.toMatchObject({
        name: 'MergeBlockedError',
        reason: 'POLICY_NOT_ALLOWED',
      });
      expect(h.transport.mergeCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('blocks a merge whose PR targets a different base branch', async () => {
    const h = harness();
    try {
      const { workOrder, bundle, pr } = await approvedWorkOrderWithPr(h);
      h.transport.prDetails.set(pr.number, {
        ...h.transport.prDetails.get(pr.number)!,
        base: 'develop',
      });

      await expect(h.adapter.merge(mergeGate(workOrder.id, bundle, pr))).rejects.toMatchObject({
        name: 'MergeBlockedError',
        reason: 'HYGIENE_FAILED',
      });
      expect(h.transport.mergeCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('blocks a merge when the durable Evidence Bundle is incomplete or for another Work Order', async () => {
    const h = harness();
    try {
      const { workOrder, bundle, pr } = await approvedWorkOrderWithPr(h);

      // E9.8: the persisted receipt is the source of truth. A durable INCOMPLETE
      // receipt blocks the merge even if the caller's copy claims complete.
      h.store.set('evidence_bundles', bundle.id, { ...bundle, complete: false });
      await expect(
        h.adapter.merge(mergeGate(workOrder.id, { ...bundle, complete: true }, pr)),
      ).rejects.toMatchObject({ name: 'MergeBlockedError', reason: 'EVIDENCE_INCOMPLETE' });

      // A durable receipt for a different Work Order is refused too.
      h.store.set('evidence_bundles', bundle.id, { ...bundle, workOrderId: 'wo_other' });
      await expect(h.adapter.merge(mergeGate(workOrder.id, bundle, pr))).rejects.toMatchObject({
        name: 'MergeBlockedError',
        reason: 'EVIDENCE_MISMATCH',
      });
      expect(h.transport.mergeCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('fails closed when no policy check is wired (no production merge without policy)', async () => {
    const h = harness();
    try {
      const { workOrder, bundle, pr } = await approvedWorkOrderWithPr(h);
      const unpolicied = createGitHubAdapter({
        transport: h.transport,
        client: h.client,
        factoryBaseUrl: FACTORY_BASE_URL,
        // The durable receipt is present, so the merge reaches the policy gate
        // and fails closed there (the point of this test).
        readEvidence: (id) => h.store.get<EvidenceBundle>('evidence_bundles', id),
      });

      await expect(unpolicied.merge(mergeGate(workOrder.id, bundle, pr))).rejects.toMatchObject({
        name: 'MergeBlockedError',
        reason: 'POLICY_NOT_ALLOWED',
      });
      expect(h.transport.mergeCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  it('merges end-to-end (import → WO → PR → merge) on APPROVED + consumed ALLOW + hygiene', async () => {
    const h = harness();
    try {
      const { workOrder, bundle, pr } = await approvedWorkOrderWithPr(h);
      const approval = parkMergeApproval(h, workOrder.id, 'operator-1');

      const outcome = await h.adapter.merge(mergeGate(workOrder.id, bundle, pr));

      // GitHub was asked to merge exactly the PR, pinned to the verified head
      // SHA, through the injected transport.
      expect(h.transport.mergeCalls).toEqual([
        { repository: 'acme/widgets', number: pr.number, sha: 'sha_head_1' },
      ]);
      expect(h.transport.getPrCalls).toEqual([{ repository: 'acme/widgets', number: pr.number }]);
      expect(outcome.merge.merged).toBe(true);
      expect(outcome.merge.sha).toBe('merge_sha');

      // The Factory-owned APPROVED → MERGED transition landed in durable state...
      const stored = h.store.get<WorkOrder>('work_orders', workOrder.id)!;
      expect(stored.state).toBe('MERGED');
      expect(outcome.workOrder.state).toBe('MERGED');
      // ...and the operator approval is spent exactly once, bound to the decision.
      const spent = h.store.get<ApprovalRecord>('interactions', approval.id)!;
      expect(spent.status).toBe('SPENT');
      expect(spent.response?.actor).toBe('operator-1');
      expect(spent.spentByDecisionId).toBeString();

      // The whole path went over the Factory server — never GitHub.
      expect(h.factoryRequests.length).toBeGreaterThan(0);
      expect(h.factoryRequests.every((url) => url.startsWith('http://127.0.0.1:'))).toBe(true);
      expect(h.factoryRequests.some((url) => url.includes('github.com'))).toBe(false);
      // The PR the merge consumed linked the Work Order and the Evidence Bundle.
      const body = h.transport.prCalls[0]!.body;
      expect(body).toContain(`[${bundle.id}](${FACTORY_BASE_URL}/api/observatory/work-orders/${workOrder.id}/drill-down)`);
    } finally {
      h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// T7 — the REST transport's PR-read + merge calls (injected fetch, no network)
// ---------------------------------------------------------------------------

describe('E6.2 GitHub REST transport: read + merge a pull request', () => {
  const token = 'secret-token';

  it('reads a pull request, then merges it (PUT /pulls/{n}/merge)', async () => {
    const { impl, calls } = recordingFetch((request) =>
      new Response(
        JSON.stringify(
          request.method === 'GET'
            ? {
                number: 12,
                html_url: 'https://github.com/acme/widgets/pull/12',
                head: { ref: 'factory/wo_1', sha: 'head-sha-1' },
                base: { ref: 'main' },
                body: 'links the bundle',
                state: 'open',
                merged: false,
              }
            : { sha: 'deadbeef', merged: true, message: 'Pull Request successfully merged' },
        ),
        { status: 200 },
      ),
    );
    const transport = createGitHubRestTransport({ token, fetch: impl });

    const detail = await transport.getPullRequest({ repository: 'acme/widgets', number: 12 });
    expect(detail).toEqual({
      repository: 'acme/widgets',
      number: 12,
      url: 'https://github.com/acme/widgets/pull/12',
      head: 'factory/wo_1',
      headSha: 'head-sha-1',
      base: 'main',
      body: 'links the bundle',
      state: 'open',
      merged: false,
    });

    // The merge is pinned to the verified head SHA (no TOCTOU).
    const result = await transport.mergePullRequest({
      repository: 'acme/widgets',
      number: 12,
      sha: 'head-sha-1',
    });
    expect(result).toEqual({
      repository: 'acme/widgets',
      number: 12,
      merged: true,
      sha: 'deadbeef',
      message: 'Pull Request successfully merged',
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.github.com/repos/acme/widgets/pulls/12',
      'PUT https://api.github.com/repos/acme/widgets/pulls/12/merge',
    ]);
    expect(calls[1]!.body).toEqual({ sha: 'head-sha-1' });
  });

  it('fails loudly with the HTTP status when GitHub refuses the merge', async () => {
    const { impl } = recordingFetch(
      () => new Response(JSON.stringify({ message: 'Pull Request is not mergeable' }), { status: 405 }),
    );
    const transport = createGitHubRestTransport({ token, fetch: impl });

    await expect(
      transport.mergePullRequest({ repository: 'acme/widgets', number: 12 }),
    ).rejects.toMatchObject({ status: 405 });
  });
});
