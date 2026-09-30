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
  type GitHubTransport,
  type IssueRef,
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
    return {
      repository: input.repository,
      number: this.prNumber,
      url: `https://github.com/${input.repository}/pull/${this.prNumber}`,
      head: input.head,
      base: input.base,
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
  /** Every URL the adapter drove through the Factory client (loopback only). */
  factoryRequests: string[];
  stop(): void;
}

const FACTORY_BASE_URL = 'http://factory.local:8787';

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
  const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    factoryRequests.push(url);
    return fetch(input as never, init);
  }) as unknown as typeof fetch;

  const client = createFactoryClient({ baseUrl: server.url, fetch: recordingFetch });
  const transport = new MockGitHubTransport();
  const adapter = createGitHubAdapter({
    transport,
    client,
    factoryBaseUrl: FACTORY_BASE_URL,
  });

  return {
    store,
    events,
    transport,
    client,
    adapter,
    factoryRequests,
    stop(): void {
      server.stop();
      store.close();
    },
  };
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
// T2 — branch creation
// ---------------------------------------------------------------------------

describe('E6.1 GitHub branch creation', () => {
  it('creates a deterministic Work-Order branch from the default base', async () => {
    const h = harness();
    try {
      const issue = issueFixture();
      h.transport.issues.set(issueKey(issue), issue);
      const { workOrder } = await h.adapter.importIssue({
        repository: issue.repository,
        number: issue.number,
      });

      const branch = await h.adapter.createBranch(workOrder);

      expect(branch.name).toBe(`factory/${workOrder.id}`);
      expect(branch.repository).toBe('acme/widgets');
      expect(h.transport.branchCalls).toEqual([
        { repository: 'acme/widgets', branch: `factory/${workOrder.id}`, baseBranch: 'main' },
      ]);
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
      expect(branch.name).toBe(`factory/${workOrder.id}`);
      expect(h.transport.branchCalls[0]?.baseBranch).toBe('develop');
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
      expect(call.head).toBe(`factory/${workOrder.id}`);
      expect(call.base).toBe('main');

      // The PR body links both the Work Order and the immutable Evidence Bundle.
      const woLink = `${FACTORY_BASE_URL}/api/work-orders/${workOrder.id}`;
      const evidenceLink = `${FACTORY_BASE_URL}/api/observatory/work-orders/${workOrder.id}/drill-down`;
      expect(call.body).toContain(`[${workOrder.id}](${woLink})`);
      expect(call.body).toContain(`[${bundle.id}](${evidenceLink})`);

      expect(pr.url).toBe('https://github.com/acme/widgets/pull/101');
      expect(pr.head).toBe(`factory/${workOrder.id}`);
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

  it('no module other than the adapter references the GitHub transport seam', () => {
    const integrators = sourceFiles(join(repoRoot, 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes('GitHubTransport'))
      .map((file) => file.slice(repoRoot.length + 1))
      .sort();

    expect(integrators).toEqual(['src/factory/github/adapter.ts']);
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
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
