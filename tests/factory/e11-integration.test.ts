import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServerDeps, type ServerDepsOptions } from '../../src/cli/factory';
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
});
