import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServerDeps, type ServerDepsOptions } from '../../src/cli/factory';
import {
  createHerdrWorker,
  createHerdrWorkspaceManager,
  renderTaskPrompt,
  type ExecutionEnvelope,
  type HerdrCli,
  type WorkerAdapter,
} from '../../src/factory/workers/herdr';
import { createApiHandler } from '../../src/factory/api/server';
import type { WorkOrder } from '../../src/factory/domain/workOrder';
import type {
  CreateBranchInput,
  CreatePullRequestInput,
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDetail,
  GitHubMergeResult,
  GitHubTransport,
  IssueRef,
  MergePullRequestInput,
  PullRequestRef,
} from '../../src/factory/github/adapter';
import { PrBaseBlockedError } from '../../src/factory/github/adapter';
import {
  DEFAULT_FACTORY_CONFIG,
  parseFactoryConfig,
  resolveFactoryConfig,
  serializeFactoryConfig,
  type FactoryDesiredConfig,
} from '../../src/factory/config/factoryConfig';

/**
 * E11.3 (#43) — outbound GitHub transport/token configuration. A running
 * `factory start` composes the E6 adapter from a validated `github:` section in
 * `factory.yaml` (the token is a *reference to* an environment variable, never
 * a raw secret in the file), so the GitHub operator routes stop 404-ing in a
 * real process. Hermetic throughout (R6): the GitHub transport is mocked, the
 * E2 API is a real loopback listener, and no network is touched.
 */

const TOKEN_ENV = 'FACTORY_E11_TEST_GITHUB_TOKEN';
const TEST_TOKEN = 'e11-hermetic-test-token-do-not-log';

let workDir: string;
let repoPath: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(root: string): string {
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' });
  git(['config', 'user.email', 'factory-test@example.com'], repo);
  git(['config', 'user.name', 'Factory Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  return repo;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'factory-e11-'));
  repoPath = initRepo(workDir);
  process.env[TOKEN_ENV] = TEST_TOKEN;
});

afterEach(() => {
  delete process.env[TOKEN_ENV];
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

class MockGitHub implements GitHubTransport {
  issues = new Map<string, GitHubIssue>();
  issueCalls: IssueRef[] = [];
  branchCalls: CreateBranchInput[] = [];
  prCalls: CreatePullRequestInput[] = [];
  private prNumber = 700;

  async getIssue(ref: IssueRef): Promise<GitHubIssue> {
    this.issueCalls.push({ ...ref });
    const issue = this.issues.get(`${ref.repository}#${ref.number}`);
    if (!issue) throw new Error(`no such issue: ${ref.repository}#${ref.number}`);
    return issue;
  }
  async createBranch(input: CreateBranchInput) {
    this.branchCalls.push({ ...input });
    return { repository: input.repository, name: input.branch, sha: 'sha_base' };
  }
  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
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
  async getPullRequest(ref: PullRequestRef): Promise<GitHubPullRequestDetail> {
    throw new Error(`unexpected getPullRequest in this test: ${ref.repository}#${ref.number}`);
  }
  async mergePullRequest(input: MergePullRequestInput): Promise<GitHubMergeResult> {
    throw new Error(`unexpected mergePullRequest in this test: ${input.number}`);
  }
}

/** Build the desired config text for a deployment with a `github:` section. */
function configText(
  github: NonNullable<FactoryDesiredConfig['github']> = {
    repository: 'acme/widgets',
    token: { env: TOKEN_ENV },
  },
  server: NonNullable<FactoryDesiredConfig['server']> = DEFAULT_FACTORY_CONFIG.server,
): string {
  return serializeFactoryConfig({
    ...DEFAULT_FACTORY_CONFIG,
    repository: { path: repoPath },
    server,
    github,
  } as FactoryDesiredConfig);
}

/** The unconfigured baseline: serializes with no `github:` section. */
function unconfiguredText(): string {
  return serializeFactoryConfig({ ...DEFAULT_FACTORY_CONFIG, repository: { path: repoPath } });
}

function runtimeFrom(text: string): ReturnType<typeof resolveFactoryConfig> {
  const parsed = parseFactoryConfig(text);
  if (!parsed.ok) throw new Error(`fixture factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
  return resolveFactoryConfig(parsed.config, { baseDir: workDir });
}

type PassthroughOptions = Omit<ServerDepsOptions, 'github' | 'githubTransport' | 'serverBind'>;

function issueDTO(): GitHubIssue {
  return {
    repository: 'acme/widgets',
    number: 43,
    title: 'Outbound GitHub transport/token configuration',
    body: 'Acceptance:\n- [ ] routes work end to end',
    labels: ['enhancement'],
    url: 'https://github.com/acme/widgets/issues/43',
  };
}

describe('E11.3 GitHub transport/token configuration (#43)', () => {
  it('composes the adapter from the github: config and serves import → PR end to end (transport mocked)', async () => {
    // Reserve the effective bind port the config declares, so the composed E2
    // client (apiBaseUrl) and the PR links (factoryBaseUrl) land there.
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = listener.port ?? 0;
    const runtime = runtimeFrom(
      configText(undefined, { hostname: '127.0.0.1', port }),
    );
    const transport = new MockGitHub();
    transport.issues.set('acme/widgets#43', issueDTO());

    // The production path: config + env token + mocked transport — no
    // `options.github` override, the adapter comes out of the `github:` config.
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      githubTransport: transport,
    });
    listener.reload({ fetch: createApiHandler(deps) });
    const url = `http://127.0.0.1:${port}`;
    try {
      expect(deps.github).toBeDefined();

      // Import: issue → Work Order through the real route + live policy.
      const imported = await fetch(`${url}/api/github/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository: 'acme/widgets', number: 43 }),
      });
      expect(imported.status).toBe(201);
      const importedBody = (await imported.json()) as { workOrder: WorkOrder; created: boolean };
      expect(importedBody.created).toBe(true);
      expect(importedBody.workOrder.repository).toBe('acme/widgets');
      expect(transport.issueCalls).toHaveLength(1);

      // Open a PR from the durable evidence receipt; the body must carry the
      // Factory links resolved from the effective bind.
      const bundle = {
        id: 'eb_e11_1',
        workOrderId: importedBody.workOrder.id,
        complete: true,
        gates: { deterministic: true, behavioral: true, semantic: true, run: true },
      };
      deps.store.set('evidence_bundles', bundle.id, bundle);
      const opened = await fetch(`${url}/api/github/pull-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ evidenceBundleId: bundle.id }),
      });
      expect(opened.status).toBe(201);
      expect(transport.prCalls).toHaveLength(1);
      expect(transport.prCalls[0]!.body).toContain(
        `[${bundle.id}](${url}/api/observatory/work-orders/${importedBody.workOrder.id}/drill-down)`,
      );
      expect(transport.prCalls[0]!.head).toBe(
        `wo-${importedBody.workOrder.id}/task-${importedBody.workOrder.id.slice(0, 8)}`,
      );

      // Secret hygiene: the runtime config carries the env *name*, never the
      // token, and neither the token nor a raw secret appears anywhere in the
      // resolved config the server would persist or log.
      expect(JSON.stringify(runtime.github)).not.toContain(TEST_TOKEN);
      expect(runtime.github).toMatchObject({ repository: 'acme/widgets', tokenEnv: TOKEN_ENV });
    } finally {
      listener.stop(true);
      deps.store.close();
    }
  });

  it('fails closed: no github: section → no adapter (routes 404); no env token → boot abort', async () => {
    // Unconfigured → no adapter, routes 404. Still fail-closed.
    delete process.env[TOKEN_ENV];
    const unconfigured = buildServerDeps(runtimeFrom(unconfiguredText()), {
      reconcileOnBoot: false,
    });
    expect(unconfigured.github).toBeUndefined();
    unconfigured.store.close();

    // Configured but the token env var is unset → boot aborts with the env var
    // *name* (never a secret) rather than serving ungoverned routes.
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = listener.port ?? 0;
    const runtime = runtimeFrom(configText(undefined, { hostname: '127.0.0.1', port }));
    let thrown: unknown;
    try {
      buildServerDeps(runtime, { reconcileOnBoot: false, githubTransport: new MockGitHub() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(TOKEN_ENV);
    expect((thrown as Error).message).not.toContain(TEST_TOKEN);
    listener.stop(true);
  });

  it('rejects malformed github: config and never accepts a raw token in the file', () => {
    // A raw token in the file is refused — only an env reference is valid.
    const rawToken = parseFactoryConfig(
      [
        'apiVersion: factory/v0.1',
        'factoryVersion: 0.1.0',
        'github:',
        `  repository: acme/widgets`,
        '  token: ghp_raw_secret_never_persisted',
      ].join('\n'),
    );
    if (rawToken.ok) {
      throw new Error('a raw github token in factory.yaml must not parse');
    }
    expect(rawToken.issues.some((issue) => issue.path === 'github.token')).toBe(true);

    // Bad repository shape.
    const badRepo = parseFactoryConfig(
      `apiVersion: factory/v0.1\ngithub:\n  repository: not-owner-slash\n  token:\n    env: ${TOKEN_ENV}\n`,
    );
    if (badRepo.ok) {
      throw new Error('a malformed github.repository must not parse');
    }
    expect(badRepo.issues.some((issue) => issue.path === 'github.repository')).toBe(true);

    // Where a raw token would read even if accepted — it must not end up in
    // the resolved runtime config: only the env var name is carried.
    const runtime = runtimeFrom(configText());
    expect(JSON.stringify(runtime.github)).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(runtimeFrom(configText()))).not.toMatch(/ghp_/);
  });

  it('resolves the adapter base URL from the effective bind (--port/--hostname override)', async () => {
    // The YAML says 8787; the effective bind is the reserved listener port.
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const effectivePort = listener.port ?? 0;
    const runtime = runtimeFrom(
      configText(undefined, { hostname: '127.0.0.1', port: 8787 }),
    );
    const transport = new MockGitHub();
    transport.issues.set('acme/widgets#43', issueDTO());
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      githubTransport: transport,
      serverBind: { hostname: '127.0.0.1', port: effectivePort },
    });
    listener.reload({ fetch: createApiHandler(deps) });
    const url = `http://127.0.0.1:${effectivePort}`;
    try {
      const imported = await fetch(`${url}/api/github/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository: 'acme/widgets', number: 43 }),
      });
      expect(imported.status).toBe(201);
      const importedBody = (await imported.json()) as { workOrder: WorkOrder };
      const bundle = {
        id: 'eb_e11_bind',
        workOrderId: importedBody.workOrder.id,
        complete: true,
        gates: { deterministic: true, behavioral: true, semantic: true, run: true },
      };
      deps.store.set('evidence_bundles', bundle.id, bundle);
      const opened = await fetch(`${url}/api/github/pull-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ evidenceBundleId: bundle.id }),
      });
      expect(opened.status).toBe(201);
      // The PR links point at the *effective* bind, not the YAML `server.port`.
      expect(transport.prCalls).toHaveLength(1);
      expect(transport.prCalls[0]!.body).toContain(
        `(${url}/api/observatory/work-orders/${importedBody.workOrder.id}/drill-down)`,
      );
      expect(transport.prCalls[0]!.body).not.toContain(':8787/');
    } finally {
      listener.stop(true);
      deps.store.close();
    }
  });

  it('policy-gates the caller-chosen PR base (only the configured base is targetable)', async () => {
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = listener.port ?? 0;
    const runtime = runtimeFrom(
      configText({ repository: 'acme/widgets', token: { env: TOKEN_ENV }, baseBranch: 'main' }, {
        hostname: '127.0.0.1',
        port,
      }),
    );
    const transport = new MockGitHub();
    transport.issues.set('acme/widgets#43', issueDTO());
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      githubTransport: transport,
    });
    listener.reload({ fetch: createApiHandler(deps) });
    const url = `http://127.0.0.1:${port}`;
    try {
      const imported = await fetch(`${url}/api/github/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository: 'acme/widgets', number: 43 }),
      });
      const importedBody = (await imported.json()) as { workOrder: WorkOrder };
      const bundle = {
        id: 'eb_e11_base',
        workOrderId: importedBody.workOrder.id,
        complete: true,
        gates: { deterministic: true, behavioral: true, semantic: true, run: true },
      };
      deps.store.set('evidence_bundles', bundle.id, bundle);

      // A caller-chosen base outside the configured base is refused (policy), and
      // the transport is never called.
      const refused = await fetch(`${url}/api/github/pull-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ evidenceBundleId: bundle.id, baseBranch: 'release/1.0' }),
      });
      expect(refused.status).toBe(403);
      expect(transport.prCalls).toHaveLength(0);

      // The configured base (and default/omitted base) is allowed.
      const allowed = await fetch(`${url}/api/github/pull-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ evidenceBundleId: bundle.id, baseBranch: 'main' }),
      });
      expect(allowed.status).toBe(201);
      expect(transport.prCalls).toHaveLength(1);

      // Adapter-level: the same gate, exercised directly.
      let thrown: unknown;
      try {
        await deps.github!.openPR(bundle, { baseBranch: 'somewhere-else' });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PrBaseBlockedError);
      expect(transport.prCalls).toHaveLength(1);
    } finally {
      listener.stop(true);
      deps.store.close();
    }
  });

  it('embeds a routable host for a wildcard bind; a concrete effective hostname still wins', async () => {
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const effectivePort = listener.port ?? 0;
    const transport = new MockGitHub();
    transport.issues.set('acme/widgets#43', issueDTO());
    const url = `http://127.0.0.1:${effectivePort}`;
    const listenerReload = (deps: ReturnType<typeof buildServerDeps>): void => {
      listener.reload({ fetch: createApiHandler(deps) });
    };

    async function openPrFor(serverBind: { hostname: string; port: number }): Promise<string> {
      // The YAML binds 127.0.0.1 (routable fallback for the wildcard case).
      const runtime = runtimeFrom(
        configText(undefined, { hostname: '127.0.0.1', port: effectivePort }),
      );
      const deps = buildServerDeps(runtime, {
        reconcileOnBoot: false,
        githubTransport: transport,
        serverBind,
      });
      // The shared listener serves this build's deps for the duration.
      listenerReload(deps);
      try {
        const imported = await fetch(`${url}/api/github/import`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repository: 'acme/widgets', number: 43 }),
        });
        // 201 created, or 200 reconciled (a prior WO survives in the shared
        // state dir); either way the Work Order exists for the PR.
        if (imported.status !== 200 && imported.status !== 201) {
          throw new Error(`import failed: ${imported.status} ${await imported.text()}`);
        }
        const { workOrder } = (await imported.json()) as { workOrder: WorkOrder };
        const bundle = {
          id: `eb_bind_${serverBind.hostname.replace(/[^a-z0-9]/gi, '_')}`,
          workOrderId: workOrder.id,
          complete: true,
          gates: { deterministic: true, behavioral: true, semantic: true, run: true },
        };
        deps.store.set('evidence_bundles', bundle.id, bundle);
        const opened = await fetch(`${url}/api/github/pull-requests`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ evidenceBundleId: bundle.id }),
        });
        expect(opened.status).toBe(201);
        const pr = transport.prCalls.at(-1)!;
        return pr.body;
      } finally {
        deps.store.close();
      }
    }

    try {
      // Container path: effective bind 0.0.0.0 — the PR link is the routable
      // fallback (the YAML hostname 127.0.0.1), never the wildcard.
      const wildcardBody = await openPrFor({ hostname: '0.0.0.0', port: effectivePort });
      expect(wildcardBody).toContain(
        `(${url}/api/observatory/work-orders/`,
      );
      expect(wildcardBody).not.toContain('0.0.0.0');

      // A concrete effective hostname (localhost here) wins over the YAML
      // fallback (127.0.0.1): the advertised host is the effective one.
      const concreteBody = await openPrFor({ hostname: 'localhost', port: effectivePort });
      expect(concreteBody).toContain(`http://localhost:${effectivePort}/api/`);
    } finally {
      listener.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// E11.1 (#44) — herdr-once worker environment + opencode harness lifecycle.
// The adapter drives a dedicated `factory` herdr workspace (started once),
// one opencode harness tab per Attempt, and collects results from a report
// file + git. Hermetic throughout: the herdr CLI is an injected in-process
// fake; real herdr/opencode are never spawned; git runs only on a temp repo.
// ---------------------------------------------------------------------------

/** A workspace the fake herdr server tracks. */
interface FakeWorkspace {
  id: string;
  label: string;
  tabs: FakeTab[];
}

/** A tab the fake herdr server tracks (so tests can assert zero tabs at rest). */
interface FakeTab {
  id: string;
  pane: string;
  cwd: string;
  closed: boolean;
}

/** The parsed herdr CLI document shape the adapter consumes (`.result.*`). */
type HerdrDoc = Record<string, unknown>;

/**
 * An in-process fake `herdr` CLI (the hermetic seam). It records every
 * invocation, tracks a workspace + tabs, answers `agent get` with a
 * configurable state, and lets a test decide what `agent prompt` does (e.g.
 * "the harness wrote its report and committed").
 */
class FakeHerdrCli implements HerdrCli {
  calls: string[][] = [];
  workspaces = new Map<string, FakeWorkspace>();
  agentState = 'running';
  /** Set by the test: invoked on `agent prompt <name> <text>` before settling. */
  onPrompt: ((prompt: string, cwd: string) => void) | null = null;
  /** Extra text a `--wait` prompt reports back; drives nothing but gets recorded. */
  onAnswer = true;
  onCreateTabHook: ((cwd: string) => void) | null = null;

  callsMatching(prefix: string): string[][] {
    return this.calls.filter((args) => args[0] === prefix);
  }

  openTabs(): FakeTab[] {
    const tabs: FakeTab[] = [];
    for (const ws of this.workspaces.values()) tabs.push(...ws.tabs);
    return tabs.filter((tab) => !tab.closed);
  }

  async run(args: readonly string[]): Promise<HerdrDoc> {
    const argv = [...args];
    this.calls.push(argv);
    const value = (key: string): string => {
      const index = argv.indexOf(`--${key}`);
      if (index < 0 || argv[index + 1] === undefined) throw new Error(`missing --${key}`);
      return argv[index + 1]!;
    };
    const sub = argv[1];
    if (argv[0] === 'workspace' && sub === 'list') {
      return { result: [...this.workspaces.values()].map((ws) => ({ id: ws.id, label: ws.label })) };
    }
    if (argv[0] === 'workspace' && sub === 'create') {
      const label = value('label');
      const id = `ws_${label}`;
      if (this.workspaces.has(id)) throw new Error(`workspace already exists: ${label}`);
      this.workspaces.set(id, { id, label, tabs: [] });
      return { result: { workspace: id, tab: 't0', root_pane: 'p0' } };
    }
    if (argv[0] === 'tab' && sub === 'create') {
      const wsId = value('workspace');
      const ws = this.workspaces.get(wsId);
      if (!ws) throw new Error(`no such workspace: ${wsId}`);
      const cwd = value('cwd');
      if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
      this.onCreateTabHook?.(cwd);
      const tab: FakeTab = {
        id: `tab_${ws.tabs.length}`,
        pane: `pane_${ws.tabs.length}`,
        cwd,
        closed: false,
      };
      ws.tabs.push(tab);
      return { result: { tab: tab.id, root_pane: tab.pane } };
    }
    if (argv[0] === 'agent' && sub === 'start') {
      return { result: { agent: argv[2] } };
    }
    if (argv[0] === 'agent' && (sub === 'prompt' || sub === 'send-keys')) {
      const text = argv[2] ?? '';
      const tab = this.openTabs().at(-1);
      if (tab) this.onPrompt?.(text, tab.cwd);
      return { result: { ok: true } };
    }
    if (argv[0] === 'agent' && sub === 'get') {
      return { result: { state: this.agentState } };
    }
    if (argv[0] === 'agent' && sub === 'read') {
      return { result: { text: 'How should I handle the ambiguous acceptance criterion?' } };
    }
    if (argv[0] === 'tab' && sub === 'close') {
      const tabId = argv[2];
      for (const ws of this.workspaces.values()) {
        for (const tab of ws.tabs) if (tab.id === tabId) tab.closed = true;
      }
      return { result: {} };
    }
    throw new Error(`unexpected herdr invocation: ${argv.join(' ')}`);
  }
}

const TEST_ENVELOPE: ExecutionEnvelope = {
  workOrderId: 'wo_44',
  taskId: 'task_44',
  attemptId: 'attempt_44',
  repository: '/tmp/repo',
  baseCommit: 'base0',
  branch: 'wo/task-44',
  // `worktree` is replaced per test with the fixture repo/worktree path.
  worktree: '/tmp/worktree',
  authorizationCapabilities: [],
  initialContext: 'Work Order: ship it\nAcceptance: tests green\nTask: implement',
  retrievalEndpoint: null,
  skills: [],
  requiredVerification: ['bun test'],
  model: null,
};

describe('E11.1 herdr-once worker environment + opencode harness lifecycle (#44)', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'factory-e111-'));
    repoPath = initRepo(workDir);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function makeAdapter(cli: FakeHerdrCli, models: Record<string, string> = {}): WorkerAdapter {
    const workspace = createHerdrWorkspaceManager(cli, { label: 'factory', repoPath });
    return createHerdrWorker({
      cli,
      workspace,
      harness: 'opencode',
      models,
      repoPath,
      pollIntervalMs: 5,
      waitTimeoutMs: 500,
    });
  }

  function commitChange(worktree: string, message: string): string {
    writeFileSync(join(worktree, 'task-44.txt'), `change: ${message}\n`);
    execFileSync('git', ['add', 'task-44.txt'], { cwd: worktree });
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: worktree });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  }

  function writeReport(
    worktree: string,
    report: Partial<{
      status: string;
      commits: unknown[];
      artifacts: unknown[];
      interactions: unknown[];
      observations: string[];
      verificationRequests: string[];
      failure: string | null;
    }>,
  ): void {
    mkdirSync(join(worktree, '.factory'), { recursive: true });
    writeFileSync(join(worktree, '.factory', 'report.json'), JSON.stringify(report));
  }

  it('runs one Attempt: create tab → agent start (with model) → prompt → report → tab close; zero tabs at rest', async () => {
    const cli = new FakeHerdrCli();
    const adapter = makeAdapter(cli, { implementer: 'opencode/sonnet-x' });
    const envelope: ExecutionEnvelope = {
      ...TEST_ENVELOPE,
      repository: repoPath,
      worktree: repoPath,
      baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim(),
      model: 'implementer',
    };
    // The "harness" does the work: commit + report, like the prompt asks.
    cli.onPrompt = () => {
      commitChange(repoPath, 'implement task 44');
      writeReport(repoPath, {
        status: 'completed',
        artifacts: [],
        interactions: [],
        observations: ['done'],
        verificationRequests: ['bun test'],
        failure: null,
      });
    };

    await adapter.provision();
    await adapter.start();
    await adapter.execute(envelope);
    const result = await adapter.collectArtifacts();

    // Sequence: workspace ensured once, one tab for this Attempt, one agent.
    expect(cli.callsMatching('workspace').map((argv) => argv.join(' '))).toEqual([
      'workspace list',
      `workspace create --label factory --cwd ${repoPath} --no-focus`,
    ]);
    const tabCreate = cli
      .callsMatching('tab')
      .find((argv) => argv[1] === 'create')!
      .join(' ');
    expect(tabCreate).toContain(`--workspace ws_factory`);
    expect(tabCreate).toContain(`--cwd ${repoPath}`);
    expect(tabCreate).toContain(`--no-focus`);
    const agentStart = cli.callsMatching('agent').find((argv) => argv[1] === 'start')!.join(' ');
    expect(agentStart).toContain('--kind opencode');
    expect(agentStart).toContain('--pane pane_0');
    expect(agentStart).toContain('-- --model opencode/sonnet-x');
    const prompt = cli.callsMatching('agent').find((argv) => argv[1] === 'prompt')!.join(' ');
    expect(prompt).toContain('--wait');
    expect(prompt).toContain(envelope.branch);
    expect(prompt).toContain('/.factory/report.json');

    // The collected WorkerResult merges git evidence with the report file.
    expect(result.status).toBe('completed');
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]!.message).toBe('implement task 44');
    expect(result.diff).toContain('task-44.txt');
    expect(result.observations).toEqual(['done']);
    expect(result.verificationRequests).toEqual(['bun test']);
    expect(result.failure).toBeNull();
    // Terminal run: harness killed on demand — zero tabs at rest.
    expect(cli.openTabs()).toHaveLength(0);
    expect((await adapter.status()).state).toBe('completed');
  });

  it('fails loudly when the harness never writes a report (no silent success)', async () => {
    const cli = new FakeHerdrCli();
    cli.agentState = 'idle'; // turn ended, but nothing was reported
    const adapter = makeAdapter(cli);
    await adapter.provision();
    await adapter.start();
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath });
    const result = await adapter.collectArtifacts();

    expect(result.status).toBe('failed');
    expect(result.failure ?? '').toContain('report');
    expect(cli.openTabs()).toHaveLength(0); // the failed tab was closed too
    expect((await adapter.status()).state).toBe('failed');
  });

  it('maps a blocked harness to WAITING_INPUT with a question, keeps the tab, and an answer resumes to completion', async () => {
    const cli = new FakeHerdrCli();
    cli.agentState = 'blocked'; // approval/question UI is up; no report yet
    const adapter = makeAdapter(cli);
    await adapter.provision();
    await adapter.start();
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath });
    const waiting = await adapter.collectArtifacts();

    expect(waiting.status).toBe('waiting_input');
    expect(waiting.interactions.length).toBeGreaterThan(0);
    // Blocked, not dead: the tab (harness) must still be alive.
    expect(cli.openTabs()).toHaveLength(1);
    expect((await adapter.status()).state).toBe('waiting_input');

    // The human answers through the durable interaction; the delivered answer
    // resumes the harness, which then completes and reports.
    cli.agentState = 'idle';
    cli.onPrompt = () => {
      if (!cli.onAnswer) return;
      commitChange(repoPath, 'post-answer work');
      writeReport(repoPath, { status: 'completed', observations: ['answered'] });
      cli.onAnswer = false;
    };
    await adapter.deliverAnswer({ interactionId: 'int_1', question: '?', response: 'use the existing helper' });

    const resumed = await adapter.collectArtifacts();
    expect(resumed.status).toBe('completed');
    expect(resumed.observations).toEqual(['answered']);
    expect(cli.openTabs()).toHaveLength(0); // converged → harness killed
    expect((await adapter.status()).state).toBe('completed');
  });

  it('resolves the concrete model from the generic capability id at dispatch; unmapped id fails loud', async () => {
    const cli = new FakeHerdrCli();
    const adapter = makeAdapter(cli, { implementer: 'opencode/sonnet-x' });
    await adapter.provision();
    await adapter.start();
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath, model: 'explorer' });
    const result = await adapter.collectArtifacts();

    // 'explorer' is not in the configured map → loud dispatch failure, no tab
    // leaked, and no harness was ever started.
    expect(result.status).toBe('failed');
    expect(result.failure ?? '').toContain('explorer');
    expect(cli.callsMatching('agent').find((argv) => argv[1] === 'start')).toBeUndefined();
    expect(cli.openTabs()).toHaveLength(0);

    // Mapped id: the --model flag carries the concrete model.
    cli.calls = [];
    cli.onPrompt = () => {
      writeReport(repoPath, { status: 'completed' });
    };
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath, model: 'implementer' });
    const agentStart = cli.callsMatching('agent').find((argv) => argv[1] === 'start')!.join(' ');
    expect(agentStart).toContain('-- --model opencode/sonnet-x');
  });

  it('ensures the factory workspace once and reuses it across adapters, never touching other workspaces', async () => {
    const cli = new FakeHerdrCli();
    // A user workspace already exists in the server; the factory workspace does not.
    cli.workspaces.set('ws_personal', { id: 'ws_personal', label: 'personal', tabs: [] });
    const workspace = createHerdrWorkspaceManager(cli, { label: 'factory', repoPath });
    const adapterA = createHerdrWorker({ cli, workspace, repoPath, pollIntervalMs: 5, waitTimeoutMs: 500 });
    const adapterB = createHerdrWorker({ cli, workspace, repoPath, pollIntervalMs: 5, waitTimeoutMs: 500 });
    await adapterA.provision();
    await adapterA.provision(); // idempotent within/across adapters
    await adapterB.provision();

    const createCalls = cli.calls.filter((argv) => argv.join(' ').startsWith('workspace create'));
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.join(' ')).toContain('--label factory');
    expect(createCalls[0]!.join(' ')).not.toContain('personal');
    expect(cli.calls.every((argv) => !argv.join(' ').includes('personal'))).toBe(true);

    // Without a factory workspace, the label exists check returns it next time.
    expect(cli.openTabs()).toHaveLength(0);
  });

  it('renders the execution envelope as the task prompt (worktree, branch, base, report path)', () => {
    const prompt = renderTaskPrompt(TEST_ENVELOPE);
    expect(prompt).toContain(TEST_ENVELOPE.worktree);
    expect(prompt).toContain(TEST_ENVELOPE.branch);
    expect(prompt).toContain(TEST_ENVELOPE.baseCommit);
    expect(prompt).toContain('.factory/report.json');
    expect(prompt).toContain('bun test');
    expect(prompt).toContain(TEST_ENVELOPE.initialContext);
    expect(prompt).toContain('commit');
  });
});
