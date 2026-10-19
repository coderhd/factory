import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServerDeps, createSchedulerPolicy, type ServerDepsOptions } from '../../src/cli/factory';
import type { EvidenceBundle } from '../../src/factory/evidence/bundle';
import { commitDAG } from '../../src/factory/planning/dag';
import { check, DEFAULT_POLICY_VERSION, type PolicyDocument } from '../../src/factory/policy/policy';
import {
  completeAttempt,
  createAttempt,
  createWorkOrder,
  transitionTask,
  transitionWorkOrder,
  type Attempt,
  type Task,
  type WorkOrder,
} from '../../src/factory/domain/workOrder';
import type { CommandRunner, VerificationConfig } from '../../src/factory/verification/production';
import {
  createHerdrWorker,
  createHerdrWorkspaceManager,
  createProcessHerdrCli,
  renderTaskPrompt,
  type ExecutionEnvelope,
  type HerdrOptions,
  type WorkerAdapter,
  type WorkerAnswer,
  type WorkerResult,
  type WorkerStatus,
} from '../../src/factory/workers/herdr';
import { createApiHandler } from '../../src/factory/api/server';
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
import { PrBaseBlockedError, RepositoryBoundError } from '../../src/factory/github/adapter';
import {
  DEFAULT_FACTORY_CONFIG,
  parseFactoryConfig,
  resolveFactoryConfig,
  serializeFactoryConfig,
  type FactoryDesiredConfig,
} from '../../src/factory/config/factoryConfig';

// The single shared in-process `herdr` CLI fake (#46): used here and by the E3
// lifecycle suite, so both exercise the same double (no divergent fakes).
import { FakeHerdrCli, type HerdrDoc } from './helpers/fakeHerdr';

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

/** Write a tiny executable stub command and return its path (R5-permitted). */
function stubScript(name: string, body: string): string {
  const scriptPath = join(workDir, name);
  writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return scriptPath;
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
  /** E12 (#48): listing is not exercised by this suite. */
  async listIssuesByLabel(label: string): Promise<never> {
    throw new Error(`unexpected listIssuesByLabel(${label}) in this test`);
  }
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

    // Unknown github keys are refused (a typo must fail loudly). Critically,
    // only the four known keys ever reach the composition — a stray key like
    // `token.value` (a raw secret dressed as a mapping) is rejected too: the
    // token itself may only ever be an { env: NAME } reference.
    const unknownKey = parseFactoryConfig(
      `apiVersion: factory/v0.1\ngithub:\n  repositry: acme/widgets\n  token:\n    env: ${TOKEN_ENV}\n`,
    );
    if (unknownKey.ok) throw new Error('an unknown github key must not parse');
    expect(
      unknownKey.issues.some(
        (issue) => issue.path === 'github.repositry' && issue.message.includes('not a github config key'),
      ),
    ).toBe(true);
    expect(unknownKey.issues.some((issue) => issue.path === 'github.repository')).toBe(true);

    // A stray key beside a valid `env` reference is refused: only `env` is a
    // github.token key, so a raw secret dressed as `token.value` cannot ride in
    // just because a legal `env` sits next to it.
    const strayTokenKey = parseFactoryConfig(
      `apiVersion: factory/v0.1\ngithub:\n  repository: acme/widgets\n  token:\n    env: GITHUB_TOKEN\n    value: ghp_raw_secret\n`,
    );
    if (strayTokenKey.ok) throw new Error('a stray github.token key must not parse');
    expect(strayTokenKey.issues.some((issue) => issue.path === 'github.token.value')).toBe(true);

    // A token mapping with no env reference (the raw `value:` secret shape) is
    // still refused: the token itself may only ever be an { env: NAME } ref.
    const rawTokenValue = parseFactoryConfig(
      `apiVersion: factory/v0.1\ngithub:\n  repository: acme/widgets\n  token:\n    value: ghp_raw_secret\n`,
    );
    if (rawTokenValue.ok) throw new Error('a raw token.value secret must not parse');
    expect(rawTokenValue.issues.some((issue) => issue.path === 'github.token.env')).toBe(true);
    expect(rawTokenValue.issues.some((issue) => issue.path === 'github.token.value')).toBe(true);

    // Where a raw token would read even if accepted — it must not end up in
    // the resolved runtime config: only the env var name is carried.
    const runtime = runtimeFrom(configText());
    expect(JSON.stringify(runtime.github)).not.toContain(TEST_TOKEN);
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

  it('bounds every GitHub side effect to the configured github.repository (the token may touch only that repo)', async () => {
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = listener.port ?? 0;
    const runtime = runtimeFrom(configText(undefined, { hostname: '127.0.0.1', port }));
    const transport = new MockGitHub();
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      githubTransport: transport,
      serverBind: { hostname: '127.0.0.1', port },
    });
    listener.reload({ fetch: createApiHandler(deps) });
    const url = `http://127.0.0.1:${port}`;
    try {
      expect(deps.github).toBeDefined();
      const github = deps.github!;

      // Import is bounds-checked before any transport I/O.
      let thrown: unknown;
      try {
        await github.importIssue({ repository: 'other-org/other-repo', number: 9 });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RepositoryBoundError);
      expect((thrown as Error).message).toContain('acme/widgets');
      expect(transport.issueCalls).toHaveLength(0);

      // Branch creation is bounds-checked against the Work Order's repository.
      const wo = createWorkOrder(deps, { intent: 'x', acceptanceCriteria: ['x'], repository: 'other-org/other-repo' });
      let branchThrown: unknown;
      try {
        await github.createBranch(wo);
      } catch (error) {
        branchThrown = error;
      }
      expect(branchThrown).toBeInstanceOf(RepositoryBoundError);
      expect(transport.branchCalls).toHaveLength(0);

      // …and so is PR opening — through the API route (the adapter's client
      // needs a live E2 API to resolve the Work Order first).
      deps.store.set('evidence_bundles', 'eb_bound', {
        id: 'eb_bound',
        workOrderId: wo.id,
        complete: true,
        gates: { deterministic: true, behavioral: true, semantic: true, run: true },
      });
      const opened = await fetch(`${url}/api/github/pull-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ evidenceBundleId: 'eb_bound' }),
      });
      expect(opened.status).toBeGreaterThanOrEqual(400);
      expect(transport.prCalls).toHaveLength(0);

      // Control: the configured repository itself stays usable.
      transport.issues.set('acme/widgets#43', issueDTO());
      const imported = await github.importIssue({ repository: 'acme/widgets', number: 43 });
      expect(imported.created).toBe(true);
    } finally {
      listener.stop(true);
      deps.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E11.1 (#44) — herdr-once worker environment + opencode harness lifecycle.
// The adapter drives a dedicated `factory` herdr workspace (started once),
// one opencode harness tab per Attempt, and collects results from a report
// file + git. Hermetic throughout: the herdr CLI is an injected in-process
// fake; real herdr/opencode are never spawned; git runs only on a temp repo.
// The in-process fake `herdr` CLI is shared (`./helpers/fakeHerdr`, #46).
// ---------------------------------------------------------------------------

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

/** A never-running worker for tests that only need a dispatch to settle. */
function idleAdapter(): WorkerAdapter {
  return {
    provision: async () => {},
    start: async () => {},
    stop: async () => {},
    pause: async () => {},
    resume: async () => {},
    status: async () => ({ state: 'running', lastHeartbeatAt: new Date().toISOString() }),
    execute: async () => {},
    deliverAnswer: async () => {},
    collectArtifacts: () => new Promise<WorkerResult>(() => undefined),
    destroy: async () => {},
  };
}

describe('E11.1 herdr-once worker environment + opencode harness lifecycle (#44)', () => {
  // The outer per-test fixture (workDir/repoPath/TOKEN_ENV) governs here too.
  // The deleted nested hooks reassigned `workDir`, orphaning the outer temp dir
  // on every test in this describe (#46).
  function makeAdapter(
    cli: FakeHerdrCli,
    models: Record<string, string> = {},
    overrides: Partial<HerdrOptions> = {},
  ): WorkerAdapter {
    const workspace = createHerdrWorkspaceManager(cli, { label: 'factory', repoPath });
    return createHerdrWorker({
      cli,
      workspace,
      harness: 'opencode',
      models,
      repoPath,
      pollIntervalMs: 5,
      waitTimeoutMs: 500,
      ...overrides,
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

  it('runs one Attempt: create tab → agent start → prompt → report → tab close; zero tabs at rest', async () => {
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
    // Live #45: the interactive opencode TUI rejects `--model`; the routed model
    // is validated but never forwarded, and `agent start` carries a startup wait.
    expect(agentStart).not.toContain('--model');
    expect(agentStart).toContain('--timeout 120000');
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
    expect(resumed.observations).toContain('answered');
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

    // Mapped id: dispatch succeeds, and the mapped model is NOT forwarded to
    // the interactive TUI (#45) — validation only.
    cli.calls = [];
    cli.onPrompt = () => {
      writeReport(repoPath, { status: 'completed' });
    };
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath, model: 'implementer' });
    const agentStart = cli.callsMatching('agent').find((argv) => argv[1] === 'start')!.join(' ');
    expect(agentStart).not.toContain('--model');
  });

  it('passes the configured agent-start timeout to `agent start` as `--timeout`', async () => {
    const cli = new FakeHerdrCli();
    cli.onPrompt = () => writeReport(repoPath, { status: 'completed' });
    const adapter = makeAdapter(cli, {}, { agentStartTimeoutMs: 250_000 });
    await adapter.provision();
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath });

    const agentStart = cli.callsMatching('agent').find((argv) => argv[1] === 'start')!.join(' ');
    // Live #45: the CLI's startup default is 30000 ms and a cold pane can exceed
    // it; the adapter must ask for its own (longer) startup window.
    expect(agentStart).toContain('--timeout 250000');
  });

  it('retries `agent start` on `agent_pane_busy`, then completes (live pane-not-ready race)', async () => {
    const cli = new FakeHerdrCli();
    // Live #45: `agent start` immediately after `tab create` can answer
    // `{"error":{"code":"agent_pane_busy",...}}` (the pane is not yet an
    // available shell). One busy answer, then the retry succeeds.
    cli.agentStartErrors = [
      new Error(
        'herdr agent start x failed (exit 1):  — stdout: {"error":{"code":"agent_pane_busy","message":"agent target pane pane_0 is not an available shell"}}',
      ),
    ];
    cli.onPrompt = () => writeReport(repoPath, { status: 'completed', observations: ['retried'] });
    const adapter = makeAdapter(cli, {}, { paneReadyDelayMs: 1 });
    await adapter.provision();
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath });
    const result = await adapter.collectArtifacts();

    expect(result.status).toBe('completed');
    expect(result.observations).toContain('retried');
    // Retried once: two `agent start` invocations, and no tab leaked.
    expect(cli.callsMatching('agent').filter((argv) => argv[1] === 'start')).toHaveLength(2);
    expect(cli.openTabs()).toHaveLength(0);
  });

  it('does not retry a non-pane-busy `agent start` failure (surfaced loud, once)', async () => {
    const cli = new FakeHerdrCli();
    cli.agentStartErrors = [new Error('herdr agent start x failed (exit 1): no such harness kind')];
    const adapter = makeAdapter(cli, {}, { paneReadyDelayMs: 1 });
    await adapter.provision();
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath });
    const result = await adapter.collectArtifacts();

    expect(result.status).toBe('failed');
    expect(result.failure ?? '').toContain('no such harness kind');
    expect(cli.callsMatching('agent').filter((argv) => argv[1] === 'start')).toHaveLength(1);
    expect(cli.openTabs()).toHaveLength(0);
  });

  it('gives up after the bounded pane-busy attempts instead of retrying forever', async () => {
    const cli = new FakeHerdrCli();
    cli.agentStartErrors = Array.from(
      { length: 12 },
      () => new Error('herdr agent start x failed (exit 1): agent_pane_busy'),
    );
    const adapter = makeAdapter(cli, {}, { paneReadyDelayMs: 1, paneReadyAttempts: 3 });
    await adapter.provision();
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath });
    const result = await adapter.collectArtifacts();

    expect(result.status).toBe('failed');
    expect(result.failure ?? '').toContain('agent_pane_busy');
    expect(cli.callsMatching('agent').filter((argv) => argv[1] === 'start')).toHaveLength(3);
    expect(cli.openTabs()).toHaveLength(0);
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

  it('sweeps the previous life factory-*-tabs on ensure (a crashed Factory cannot strand harnesses in the long-lived server)', async () => {
    const cli = new FakeHerdrCli();
    // The herdr server survived a previous Factory life: our workspace still
    // carries a stale attempt tab and the user's own (unlabeled) pane.
    cli.workspaces.set('ws_factory', {
      id: 'ws_factory',
      label: 'factory',
      tabs: [
        { id: 'tab_stale_attempt', pane: 'pane_stale', cwd: repoPath, label: 'factory-attempt_old', closed: false },
        { id: 'tab_user_pane', pane: 'pane_user', cwd: repoPath, label: 'terminal', closed: false },
      ],
    });
    const workspace = createHerdrWorkspaceManager(cli, { label: 'factory', repoPath });
    const adapter = createHerdrWorker({ cli, workspace, repoPath, pollIntervalMs: 5, waitTimeoutMs: 500 });

    await adapter.provision();

    // Only OUR `factory-*` tab was killed; the user's pane is untouched — and
    // the sweep ran before the first run could be dispatched.
    const open = cli.openTabs();
    expect(open.map((tab) => tab.id)).toEqual(['tab_user_pane']);
    expect(cli.callsMatching('tab').some((argv) => argv.join(' ') === 'tab close tab_stale_attempt')).toBe(true);
    expect(cli.calls.some((argv) => argv.join(' ').includes('tab_user_pane'))).toBe(false);
  });

  it('plumbs workers.models from config through the default spawn: validated, not forwarded to the TUI argv', async () => {
    const cli = new FakeHerdrCli();
    cli.onPrompt = (_prompt, cwd) => {
      // The harness does the work (and commits, so the run carries evidence).
      execFileSync('git', ['-C', cwd, 'add', '-A'], { encoding: 'utf8' });
      writeFileSync(join(cwd, 'plumbed.txt'), 'change\n');
      execFileSync('git', ['-C', cwd, 'add', 'plumbed.txt'], { encoding: 'utf8' });
      execFileSync('git', ['-C', cwd, 'commit', '-q', '-m', 'plumb the workers.models map'], { encoding: 'utf8' });
      writeReport(cwd, { status: 'completed', observations: ['done'] });
    };
    const text = serializeFactoryConfig({
      ...DEFAULT_FACTORY_CONFIG,
      repository: { path: repoPath },
      workers: {
        ...DEFAULT_FACTORY_CONFIG.workers,
        models: { implementer: 'opencode/sonnet-x' },
      },
    } as FactoryDesiredConfig);
    const runtime = runtimeFrom(text);
    // No `spawn` seam: the production default-spawn path must carry the map.
    const deps = buildServerDeps(runtime, { reconcileOnBoot: false, herdrCli: cli });
    try {
      seedExecutableTask(deps);
      await tickAndSettle(deps.scheduler!);

      const start = cli.callsMatching('agent').find((argv) => argv[1] === 'start');
      expect(start).toBeDefined();
      // The map still routes (an unmapped id would fail loud), but the concrete
      // model never rides the interactive TUI argv (#45, live).
      expect(start!.join(' ')).not.toContain('--model');
      expect(start!.join(' ')).toContain('--timeout 120000');
      // The run was dispatched and settled: every seeded task left READY.
      expect(deps.store.list<Task>('tasks').every((task) => task.state !== 'READY')).toBe(true);
      expect(cli.openTabs()).toHaveLength(0);
    } finally {
      deps.store.close();
    }
  });

  it('rejects malformed workers.models at parse: non-mapping and non-string model values', () => {
    const base = serializeFactoryConfig({ ...DEFAULT_FACTORY_CONFIG, repository: { path: repoPath } });
    const nonMapping = parseFactoryConfig(
      base.replace('  harness: "opencode"', '  harness: "opencode"\n  models: [implementer]'),
    );
    expect(nonMapping.ok).toBe(false);
    if (!nonMapping.ok) {
      expect(nonMapping.issues.some((issue) => issue.path === 'workers.models')).toBe(true);
    }

    const nonString = parseFactoryConfig(
      base.replace('  harness: "opencode"', '  harness: "opencode"\n  models:\n    implementer: 7'),
    );
    expect(nonString.ok).toBe(false);
    if (!nonString.ok) {
      expect(
        nonString.issues.some(
          (issue) => issue.path === 'workers.models.implementer' && issue.message.includes('non-empty string'),
        ),
      ).toBe(true);
    }
  });

  it('deliverAnswer without a waiting harness fails loud (the error path is pinned, never a silent no-op)', async () => {
    const cli = new FakeHerdrCli();
    const adapter = makeAdapter(cli);
    await adapter.provision();
    await adapter.start();
    let thrown: unknown;
    try {
      await adapter.deliverAnswer({ interactionId: 'int_x', question: '?', response: 'answer' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('no waiting harness');
    // The adapter state is untouched: nothing settled, nothing ran.
    expect((await adapter.collectArtifacts()).failure ?? '').toContain('not running');
  });

  it('deliverAnswer on a thrown answer turn fails loud ("harness did not resume after the delivered answer") and releases the harness', async () => {
    const cli = new FakeHerdrCli();
    cli.agentState = 'blocked'; // a live, blocked harness that never reports
    const adapter = makeAdapter(cli);
    await adapter.provision();
    await adapter.start();
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath });
    const waiting = await adapter.collectArtifacts();
    expect(waiting.status).toBe('waiting_input');
    expect(cli.openTabs()).toHaveLength(1); // the harness is alive while blocked

    // The answer turn's harness channel dies: the prompt throws a named error
    // and no fresh report arrives. `deliverAnswer` must surface the underlying
    // cause (never wedge the task, never throw out of the durable interaction
    // path) and release the stranded harness.
    cli.promptError = new Error('herdr answer channel died mid-turn');
    await adapter.deliverAnswer({ interactionId: 'int_1', question: '?', response: 'resume' });

    const settled = await adapter.collectArtifacts();
    expect(settled.status).toBe('failed');
    expect(settled.failure ?? '').toContain('harness did not resume after the delivered answer');
    expect(settled.failure ?? '').toContain('herdr answer channel died mid-turn');
    // Released: the stranded harness was torn down (zero tabs at rest).
    expect(cli.openTabs()).toHaveLength(0);
    expect((await adapter.status()).state).toBe('failed');
  });

  it('treats a transient agent-get probe failure as unknown state and keeps polling to the deadline', async () => {
    const underlying = new FakeHerdrCli();
    underlying.agentState = 'idle'; // turn ended, nothing reported yet
    const realRun = underlying.run.bind(underlying);
    let gets = 0;
    underlying.run = async (args: readonly string[]): Promise<HerdrDoc> => {
      if (args[0] === 'agent' && args[1] === 'get') {
        gets += 1;
        if (gets === 1) throw new Error('herdr socket hiccup');
      }
      return realRun(args);
    };
    const adapter = makeAdapter(underlying);
    await adapter.provision();
    await adapter.start();
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath });
    const result = await adapter.collectArtifacts();

    // The probe hiccup did not kill the healthy harness: polling continued and
    // the run failed only on the legitimate report deadline (loud), with the
    // transient error NOT reported as the failure cause.
    expect(result.status).toBe('failed');
    expect(result.failure ?? '').not.toContain('socket hiccup');
    expect(result.failure ?? '').toContain('report');
    expect(underlying.openTabs()).toHaveLength(0);
    expect(gets).toBeGreaterThanOrEqual(2);
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

  it('does not re-settle a stale report across turns: an answered turn that blocks again surfaces the live blocked state', async () => {
    const cli = new FakeHerdrCli();
    // Turn 1 converges via the report file itself (a report-based
    // waiting_input — the file, not the pane state, is the settled question).
    let prompts = 0;
    cli.agentState = 'running';
    cli.onPrompt = () => {
      prompts += 1;
      if (prompts === 1) writeReport(repoPath, {
        status: 'waiting_input',
        interactions: [{ question: 'STALE QUESTION from report.json' }],
      });
      // Turn 2's harness blocks again and does NOT rewrite the report.
    };
    const adapter = makeAdapter(cli);
    await adapter.provision();
    await adapter.start();
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath });
    const first = await adapter.collectArtifacts();
    expect(first.status).toBe('waiting_input');
    expect(first.interactions[0]!.question).toContain('STALE QUESTION');

    // Turn 2: the harness blocks without rewriting the report; the adapter
    // must surface the live blocked state (agent read), never the stale file.
    cli.agentState = 'blocked';
    await adapter.deliverAnswer({ interactionId: 'i', question: 'STALE', response: 'answer 1' });
    const second = await adapter.collectArtifacts();
    expect(second.status).toBe('waiting_input');
    expect(second.interactions[0]!.question).toContain('ambiguous'); // agent-read text
    expect(second.interactions[0]!.question).not.toContain('STALE QUESTION');
  });

  it('clears a rejected workspace ensure so provisioning retries (transient herdr outage)', async () => {
    const underlying = new FakeHerdrCli();
    // First workspace list transiently fails (socket not yet up).
    const realList = underlying.run.bind(underlying);
    let lists = 0;
    underlying.run = async (args: readonly string[]): Promise<HerdrDoc> => {
      if (args[0] === 'workspace' && args[1] === 'list') {
        lists += 1;
        if (lists === 1) throw new Error('herdr socket not ready');
      }
      return realList(args);
    };

    const workspace = createHerdrWorkspaceManager(underlying, { label: 'factory', repoPath });
    let firstError: unknown;
    try {
      await workspace.ensure();
    } catch (error) {
      firstError = error;
    }
    expect((firstError as Error).message).toContain('socket not ready');

    await workspace.ensure(); // retries — not poisoned by the cached rejection
    await workspace.ensure(); // memoized success
    expect(lists).toBe(2);
    expect(
      underlying.calls.filter((argv) => argv.join(' ').startsWith('workspace create')),
    ).toHaveLength(1);
  });

  it('surfaces a git evidence read failure as an observation instead of silently empty evidence', async () => {
    const cli = new FakeHerdrCli();
    cli.onPrompt = () => {
      writeReport(repoPath, { status: 'completed', observations: ['work done'] });
    };
    const adapter = makeAdapter(cli);
    await adapter.provision();
    await adapter.start();
    await adapter.execute({ ...TEST_ENVELOPE, worktree: repoPath, baseCommit: 'does-not-exist' });
    const result = await adapter.collectArtifacts();
    expect(result.status).toBe('completed');
    expect(result.observations).toContain('work done');
    expect(result.observations.some((entry) => entry.includes('git evidence read failed'))).toBe(true);
  });

  it('createProcessHerdrCli: parses JSON, and fails loud on a non-zero exit and on non-JSON output', async () => {
    const herdr = createProcessHerdrCli(
      stubScript('herdr-cli-good.sh', 'echo \'{"result":{"state":"idle"}}\''),
    );
    expect((await herdr.run(['agent', 'get', 'x'])).result).toEqual({ state: 'idle' });

    const failing = createProcessHerdrCli(stubScript('herdr-cli-exit.sh', 'echo "boom" >&2\nexit 3'));
    let exitError: unknown;
    try {
      await failing.run(['agent', 'get', 'x']);
    } catch (error) {
      exitError = error;
    }
    expect((exitError as Error).message).toContain('exit 3');
    expect((exitError as Error).message).toContain('boom');

    const noisy = createProcessHerdrCli(stubScript('herdr-cli-noise.sh', 'echo "not json"'));
    let noiseError: unknown;
    try {
      await noisy.run(['agent', 'get', 'x']);
    } catch (error) {
      noiseError = error;
    }
    expect((noiseError as Error).message).toContain('non-JSON');

    // The error argv is a *truncated preview*: a multi-KB prompt (whole prompt/
    // diff payloads ride argv) must never land verbatim in a durable log line.
    const hugePrompt = 'X'.repeat(5_000);
    const long = createProcessHerdrCli(stubScript('herdr-cli-exit2.sh', 'echo "boom" >&2\nexit 2'));
    let longError: unknown;
    try {
      await long.run(['agent', 'prompt', 'a', hugePrompt]);
    } catch (error) {
      longError = error;
    }
    expect((longError as Error).message.length).toBeLessThan(500);
    expect((longError as Error).message).not.toContain(hugePrompt.slice(100));
    expect((longError as Error).message).toContain('agent prompt a');
  });
});

// ---------------------------------------------------------------------------
// E11.2 (#42) — production semantic-judge provider + CLI wiring.
// The judge runs as an opencode harness in a fresh pane (its own tab, a
// different model than the developer), prompted with the Work Order, criteria,
// change set, deterministic/behavioral results and rubric — never the developer
// transcript — and returns per-criterion rulings through a verdict file.
// Hermetic throughout (R5): the herdr CLI is an injected fake, the worker and
// command seams are fakes; real herdr/opencode are never spawned.
// ---------------------------------------------------------------------------

/** A fake command runner: every configured check passes without a subprocess. */
const passingRunner: CommandRunner = async (input) => ({
  exitCode: 0,
  stdout: `${input.command} ok`,
  stderr: '',
});

const JUDGE_VERIFICATION: VerificationConfig = {
  judge: {
    provider: 'opencode',
    model: 'judge-claude',
    family: 'judge-family',
    harness: 'opencode',
  },
  prompt: { id: 'factory-verify', version: '1' },
  rubric: ['Rule on every acceptance criterion; falsified=true only when you can show it unmet.'],
  checks: [
    { id: 'typecheck', category: 'deterministic', kind: 'typecheck', command: 'bun run typecheck' },
    { id: 'e2e', category: 'behavioral', kind: 'playwright', command: 'bun run e2e' },
  ],
};

/** Fake worker for the scheduler's implementer side (never runs a harness). */
class IdleFakeHerdr implements WorkerAdapter {
  async provision(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async status(): Promise<WorkerStatus> {
    return { state: 'running', lastHeartbeatAt: new Date().toISOString() };
  }
  async execute(_envelope: ExecutionEnvelope): Promise<void> {}
  async collectArtifacts(): Promise<WorkerResult> {
    return new Promise<WorkerResult>(() => undefined as never);
  }
  async deliverAnswer(_answer: WorkerAnswer): Promise<void> {}
  async destroy(): Promise<void> {}
}

describe('E11.2 production semantic judge + CLI wiring (#42)', () => {
  // The outer per-test fixture (workDir/repoPath/TOKEN_ENV) governs here too:
  // the deleted nested hooks reassigned `workDir`, orphaning the outer temp dir
  // on every test in this describe (#46).
  function verificationText(verification?: VerificationConfig): string {
    const withKeys: FactoryDesiredConfig = {
      ...DEFAULT_FACTORY_CONFIG,
      repository: { path: repoPath },
    };
    return verification
      ? serializeFactoryConfig({ ...withKeys, verification })
      : serializeFactoryConfig(withKeys);
  }

  function runtimeFromT(text: string): ReturnType<typeof resolveFactoryConfig> {
    const parsed = parseFactoryConfig(text);
    if (!parsed.ok) throw new Error(`fixture factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
    return resolveFactoryConfig(parsed.config, { baseDir: workDir });
  }

  /** Seed a WO with one task and drive it straight to SUCCESS (`model` = writer). */
  function seedAndDriveToSuccess(
    deps: {
      store: ReturnType<typeof buildServerDeps>['store'];
      events: ReturnType<typeof buildServerDeps>['events'];
    },
    model: string,
    taskCount = 1,
  ): { wo: WorkOrder; tasks: Task[] } {
    const wo = createWorkOrder(deps, {
      intent: 'E11.2 judge subject',
      acceptanceCriteria: ['the helper is exported'],
    });
    for (const to of ['READY', 'PLANNING'] as const) transitionWorkOrder(deps, wo.id, { to });
    const dag = commitDAG(
      deps,
      wo.id,
      {
        nodes: Array.from({ length: taskCount }, (_, index) => ({
          nodeId: String.fromCharCode(97 + index),
          title: `Node ${index + 1}`,
        })),
      },
    );
    transitionWorkOrder(deps, wo.id, { to: 'EXECUTING' });
    const tasks = dag.nodes.map((node) => deps.store.get<Task>('tasks', node.taskId)!);
    for (const task of tasks) {
      const attempt = createAttempt(deps, { taskId: task.id, model });
      completeAttempt(deps, attempt.id, {
        outcome: 'success',
        diff: 'diff --git a/helper.ts b/helper.ts\n+export const helper = 1;',
        artifactIds: [],
      });
      for (const to of ['READY', 'ASSIGNED', 'RUNNING', 'SUCCESS'] as const) transitionTask(deps, task.id, { to });
    }
    return { wo, tasks };
  }

  /** Tick until a predicate holds (verification is async; routing is on-tick). */
  async function tickUntil(
    scheduler: NonNullable<ReturnType<typeof buildServerDeps>['scheduler']>,
    deps: { store: ReturnType<typeof buildServerDeps>['store'] },
    check: () => boolean,
    what: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      scheduler.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    }
  }

  /** What the fake judge harness does when prompted: report + verdict files. */
  function fakeJudgeScenario(
    cli: FakeHerdrCli,
    verdict: unknown,
  ): { prompts: string[]; cwds: string[] } {
    const prompts: string[] = [];
    const cwds: string[] = [];
    cli.onPrompt = (prompt, cwd) => {
      prompts.push(prompt);
      cwds.push(cwd);
      mkdirSync(join(cwd, '.factory'), { recursive: true });
      writeFileSync(
        join(cwd, '.factory', 'report.json'),
        JSON.stringify({ status: 'completed', observations: ['judged'], artifacts: [], interactions: [], verificationRequests: [], failure: null }),
      );
      writeFileSync(join(cwd, '.factory', 'judge-verdict.json'), JSON.stringify(verdict));
    };
    return { prompts, cwds };
  }

  it('composes the harness judge from verification config: fresh tab, fresh-context prompt, verdict file, teardown → HUMAN_GATE with a persisted bundle', async () => {
    const cli = new FakeHerdrCli();
    const verdict = {
      rulings: [
        {
          criterion: 'the helper is exported',
          falsified: false,
          evidence: { summary: 'diff exports helper' },
        },
      ],
    };
    const { prompts, cwds } = fakeJudgeScenario(cli, verdict);
    const runtime = runtimeFromT(verificationText(JUDGE_VERIFICATION));
    // Production path: no `verifier`, no `verification.judge` seam — the judge is
    // composed from config onto the (injected, fake) herdr CLI.
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      spawn: () => new IdleFakeHerdr(),
      verification: { runCommand: passingRunner },
      herdrCli: cli,
    });
    try {
      const { wo, tasks } = seedAndDriveToSuccess(deps, 'writer-xl');
      await tickUntil(deps.scheduler!, deps, () =>
        deps.store.get<WorkOrder>('work_orders', wo.id)!.state === 'HUMAN_GATE', 'HUMAN_GATE');

      // The bundle is persisted and complete; task VERIFIED; WO at HUMAN_GATE.
      const bundles = deps.store.list<EvidenceBundle>('evidence_bundles');
      expect(bundles).toHaveLength(1);
      expect(bundles[0]!.complete).toBe(true);
      expect(bundles[0]!.workOrderId).toBe(wo.id);
      expect(deps.store.get<Task>('tasks', tasks[0].id)!.state).toBe('VERIFIED');

      // The judge ran as an opencode harness in its own fresh tab, and was torn
      // down (zero tabs at rest). Its concrete model is validated by routing but
      // is NOT forwarded to the interactive TUI (#45, live).
      const judgeStart = cli.callsMatching('agent').find((argv) => argv[1] === 'start')!.join(' ');
      expect(judgeStart).toContain('--kind opencode');
      expect(judgeStart).not.toContain('--model');
      const judgeTabCreate = cli.callsMatching('tab').find((argv) => argv[1] === 'create')!.join(' ');
      expect(judgeTabCreate).toContain('--no-focus');
      expect(cli.openTabs()).toHaveLength(0);

      // The judge's fresh-context prompt carries the WO + criteria + change set
      // + deterministic results + rubric + the verdict/report contract — and
      // never any developer transcript.
      expect(prompts).toHaveLength(1);
      const prompt = prompts[0]!;
      expect(prompt).toContain('E11.2 judge subject');
      expect(prompt).toContain('the helper is exported');
      expect(prompt).toContain('+export const helper = 1;');
      expect(prompt).toContain('bun run typecheck ok');
      expect(prompt).toContain('bun run e2e ok');
      expect(prompt).toContain('Rule on every acceptance criterion');
      expect(prompt).toContain('judge-verdict.json');
      expect(prompt.toLowerCase()).not.toContain('transcript');
      // The judge pane's cwd is its own fresh directory (not the repo checkout).
      expect(cwds[0]).not.toBe(repoPath);
    } finally {
      deps.store.close();
    }
  });

  it('enforces writer ≠ verifier through the composed judge: same model as the developer → no bundle, REWORK', async () => {
    const cli = new FakeHerdrCli();
    fakeJudgeScenario(cli, {}); // would happily report if the judge ever ran
    const runtime = runtimeFromT(
      verificationText({ ...JUDGE_VERIFICATION, judge: { ...JUDGE_VERIFICATION.judge, model: 'writer-xl' } }),
    );
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      spawn: () => new IdleFakeHerdr(),
      verification: { runCommand: passingRunner },
      herdrCli: cli,
    });
    try {
      const { wo, tasks } = seedAndDriveToSuccess(deps, 'writer-xl');
      await tickUntil(deps.scheduler!, deps, () =>
        deps.store.get<Task>('tasks', tasks[0].id)!.state === 'REWORK', 'REWORK');

      expect(deps.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      const rejection = deps.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.rejected');
      expect((rejection!.payload as { diagnosis: string }).diagnosis).toMatch(/same-model self-sign-off/i);
      // The judge harness was never prompted — refusal happens before any run.
      expect(cli.callsMatching('agent').find((argv) => argv[1] === 'prompt')).toBeUndefined();
    } finally {
      deps.store.close();
    }
  });

  it('refuses verifier composition at boot when workers.models maps a routed capability to the judge model', () => {
    // The deployment maps the implementer (a generic routed id) to the same
    // concrete model the judge runs: every judgment would be attested as
    // independent while being a same-model self-sign-off. Boot refuses — fail
    // closed, loud — instead of carrying a nominal live guard.
    const text = serializeFactoryConfig({
      ...DEFAULT_FACTORY_CONFIG,
      repository: { path: repoPath },
      workers: { ...DEFAULT_FACTORY_CONFIG.workers, models: { implementer: 'opencode/judge-claude' } },
      verification: JUDGE_VERIFICATION,
    } as FactoryDesiredConfig);
    const runtime = runtimeFromT(text);
    let thrown: unknown;
    try {
      buildServerDeps(runtime, { reconcileOnBoot: false, herdrCli: new FakeHerdrCli() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('writer ≠ verifier');
    expect((thrown as Error).message).toContain('workers.models.implementer');

    // A distinct concrete model composes fine (the guard is equality-only).
    const distinct = serializeFactoryConfig({
      ...DEFAULT_FACTORY_CONFIG,
      repository: { path: repoPath },
      workers: { ...DEFAULT_FACTORY_CONFIG.workers, models: { implementer: 'opencode/sonnet-x' } },
      verification: JUDGE_VERIFICATION,
    } as FactoryDesiredConfig);
    const deps = buildServerDeps(runtimeFromT(distinct), { reconcileOnBoot: false, herdrCli: new FakeHerdrCli() });
    deps.store.close();
  });

  it('fails closed when the judge harness produces no verdict file: every criterion fails, REWORK, no bundle', async () => {    const cli = new FakeHerdrCli();
    cli.onPrompt = (prompt, cwd) => {
      void prompt;
      mkdirSync(join(cwd, '.factory'), { recursive: true });
      writeFileSync(
        join(cwd, '.factory', 'report.json'),
        JSON.stringify({ status: 'completed', observations: [], artifacts: [], interactions: [], verificationRequests: [], failure: null }),
      );
      // no judge-verdict.json — the run completes but produces no verdict
    };
    const runtime = runtimeFromT(verificationText(JUDGE_VERIFICATION));
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      spawn: () => new IdleFakeHerdr(),
      verification: { runCommand: passingRunner },
      herdrCli: cli,
    });
    try {
      const { wo, tasks } = seedAndDriveToSuccess(deps, 'writer-xl');
      await tickUntil(deps.scheduler!, deps, () =>
        deps.store.get<Task>('tasks', tasks[0].id)!.state === 'REWORK', 'REWORK');

      expect(deps.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(deps.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      // Zero tabs at rest even on the failed judgment.
      expect(cli.openTabs()).toHaveLength(0);
      // The verdict run is diagnosed, not just parked: the structured event
      // carries the judge's own "no verdict file" failure AND the structured
      // per-criterion diagnosis (`FailureRecord.diagnosis`, a non-empty string).
      const failure = deps.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.failed');
      const record = (failure!.payload as {
        failures: Array<{ evidence: { summary: string }; diagnosis: string }>;
      }).failures[0]!;
      expect(record.evidence.summary).toContain('no verdict file');
      expect(record.diagnosis.length).toBeGreaterThan(0);
      expect(record.diagnosis).toContain('semantic judge');
    } finally {
      deps.store.close();
    }
  });

  it('tears down a BLOCKED judge pane (no answer channel): REWORK, no bundle, zero tabs at rest', async () => {
    const cli = new FakeHerdrCli();
    // The judge harness blocks (approval UI) and writes nothing: the judge has
    // no deliverAnswer channel, so the pane must be killed, not stranded.
    cli.agentState = 'blocked';
    const runtime = runtimeFromT(verificationText(JUDGE_VERIFICATION));
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      spawn: () => new IdleFakeHerdr(),
      verification: { runCommand: passingRunner },
      herdrCli: cli,
    });
    try {
      const { wo, tasks } = seedAndDriveToSuccess(deps, 'writer-xl');
      await tickUntil(deps.scheduler!, deps, () =>
        deps.store.get<Task>('tasks', tasks[0].id)!.state === 'REWORK', 'REWORK');

      expect(deps.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(deps.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      // The blocked pane is closed: zero harnesses at rest.
      expect(cli.openTabs()).toHaveLength(0);
      // The stranded judgment is diagnosed, not silently parked: the structured
      // failure carries both the evidence summary and the per-criterion
      // diagnosis (`FailureRecord.diagnosis`).
      const failure = deps.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.failed');
      const record = (failure!.payload as {
        failures: Array<{ evidence: { summary: string }; diagnosis: string }>;
      }).failures[0]!;
      expect(record.evidence.summary).toContain('semantic judge');
      expect(record.diagnosis.length).toBeGreaterThan(0);
      expect(record.diagnosis).toContain('semantic judge');
    } finally {
      deps.store.close();
    }
  });

  it('tears down a FAILED judge run: the failure is a loud structured semantic failure, zero tabs at rest', async () => {
    const cli = new FakeHerdrCli();
    cli.onPrompt = (prompt, cwd) => {
      void prompt;
      mkdirSync(join(cwd, '.factory'), { recursive: true });
      writeFileSync(
        join(cwd, '.factory', 'report.json'),
        JSON.stringify({ status: 'failed', failure: 'judge harness crashed mid-verdict', observations: [], artifacts: [], interactions: [], verificationRequests: [] }),
      );
    };
    const runtime = runtimeFromT(verificationText(JUDGE_VERIFICATION));
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      spawn: () => new IdleFakeHerdr(),
      verification: { runCommand: passingRunner },
      herdrCli: cli,
    });
    try {
      const { wo, tasks } = seedAndDriveToSuccess(deps, 'writer-xl');
      await tickUntil(deps.scheduler!, deps, () =>
        deps.store.get<Task>('tasks', tasks[0].id)!.state === 'REWORK', 'REWORK');

      expect(deps.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
      expect(deps.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('REWORK');
      expect(cli.openTabs()).toHaveLength(0);
      // The judge's own failure is carried into the structured diagnosis.
      const failure = deps.events
        .readEvents({ aggregateType: 'work_order', aggregateId: wo.id })
        .find((event) => event.type === 'verification.failed');
      const record = (failure!.payload as {
        failures: Array<{ evidence: { summary: string }; diagnosis: string }>;
      }).failures[0]!;
      expect(record.evidence.summary).toContain('judge harness crashed mid-verdict');
      expect(record.diagnosis.length).toBeGreaterThan(0);
      expect(record.diagnosis).toContain('semantic judge');
    } finally {
      deps.store.close();
    }
  });

  it('serializes concurrent verifications: two SUCCESS tasks each get their own judged run, both reach HUMAN_GATE', async () => {
    const cli = new FakeHerdrCli();
    const verdict = {
      rulings: [
        {
          criterion: 'the helper is exported',
          falsified: false,
          evidence: { summary: 'diff exports helper' },
        },
      ],
    };
    const { prompts } = fakeJudgeScenario(cli, verdict);
    const runtime = runtimeFromT(verificationText(JUDGE_VERIFICATION));
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      spawn: () => new IdleFakeHerdr(),
      verification: { runCommand: passingRunner },
      herdrCli: cli,
    });
    try {
      // Two tasks reach SUCCESS in the same tick, so the scheduler kicks two
      // verifications concurrently at the single shared judge.
      const { wo } = seedAndDriveToSuccess(deps, 'writer-xl', 2);
      await tickUntil(deps.scheduler!, deps, () =>
        deps.store.get<WorkOrder>('work_orders', wo.id)!.state === 'HUMAN_GATE', 'HUMAN_GATE');

      // Both tasks verified; two complete bundles; no spurious REWORK.
      const bundles = deps.store.list<EvidenceBundle>('evidence_bundles');
      expect(bundles).toHaveLength(2);
      for (const bundle of bundles) expect(bundle.complete).toBe(true);
      for (const task of deps.store.list<Task>('tasks')) {
        expect(task.state).toBe('VERIFIED');
      }
      // Each verification ran its own judged run — and (with the judge's run
      // mutex) no run was cross-killed into a failed/superseded judgment.
      expect(prompts).toHaveLength(2);
      expect(cli.openTabs()).toHaveLength(0);
    } finally {
      deps.store.close();
    }
  });

  it('fails closed when no verification section is configured: the SUCCESS task parks with a loud diagnostic', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      const runtime = runtimeFromT(verificationText(undefined));
      const deps = buildServerDeps(runtime, {
        reconcileOnBoot: false,
        spawn: () => new IdleFakeHerdr(),
        herdrCli: new FakeHerdrCli(),
      });
      try {
        const { wo, tasks } = seedAndDriveToSuccess(deps, 'writer-xl');
        await tickUntil(deps.scheduler!, deps, () =>
          errors.some((line) => /verifier/i.test(line)), 'the missing-verifier diagnostic');

        expect(deps.store.list<EvidenceBundle>('evidence_bundles')).toHaveLength(0);
        expect(deps.store.get<Task>('tasks', tasks[0].id)!.state).toBe('SUCCESS');
        expect(deps.store.get<WorkOrder>('work_orders', wo.id)!.state).toBe('EXECUTING');
      } finally {
        deps.store.close();
      }
    } finally {
      console.error = originalError;
    }
  });

  it('validates the judge harness kind in config: empty harness is refused with a dotted path; round-trips when present', () => {
    const bad = serializeFactoryConfig({
      ...DEFAULT_FACTORY_CONFIG,
      repository: { path: repoPath },
      verification: { ...JUDGE_VERIFICATION, judge: { ...JUDGE_VERIFICATION.judge, harness: '' } },
    } as FactoryDesiredConfig);
    const parsedBad = parseFactoryConfig(bad);
    expect(parsedBad.ok).toBe(false);
    if (!parsedBad.ok) {
      expect(parsedBad.issues.some((issue) => issue.path === 'verification.judge.harness')).toBe(true);
    }

    const good = serializeFactoryConfig({
      ...DEFAULT_FACTORY_CONFIG,
      repository: { path: repoPath },
      verification: JUDGE_VERIFICATION,
    } as FactoryDesiredConfig);
    const parsed = parseFactoryConfig(good);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.verification!.judge).toEqual(JUDGE_VERIFICATION.judge);
      const resolved = resolveFactoryConfig(parsed.config, { baseDir: workDir });
      // Resolved: the harness rides the judge config (defaulted).
      expect(resolved.verification!.judge.harness).toBe('opencode');
    }
  });
});

// ---------------------------------------------------------------------------
// E11.4 (#41) — the policy/rules configuration surface. An inline `policy:`
// section (or a `policyFile:` reference) in `factory.yaml` loads, validates and
// overrides the embedded E7 policy; absent, the embedded default stays
// authoritative (byte-identical, fail closed). Invalid policies are rejected
// loudly — never silently degraded toward a permissive default.
// Hermetic throughout: temp dirs, no network, no real harness spawns.
// ---------------------------------------------------------------------------

/** The custom deployment policy the override tests run against. */
const CUSTOM_POLICY: PolicyDocument = {
  version: 'e11-fixtures-1',
  organization: {
    capabilities: {
      // Denies what the embedded default allows at org level.
      'repo.read': [{ decision: 'DENY', ruleId: 'org:repo.read' }],
      // Restricts what the embedded default grants broadly: only `docs/**`
      // writes are granted; everything else (whole-worktree `**` included) is
      // outside that scope → DENY.
      'repo.write': [{ decision: 'ALLOW', scope: { paths: ['docs/**'] }, ruleId: 'org:repo.write' }],
    },
  },
};

/** A policy configuration fixture built over the default desired config. */
function policyConfigText(policy?: PolicyDocument): string {
  return serializeFactoryConfig({
    ...DEFAULT_FACTORY_CONFIG,
    repository: { path: repoPath },
    ...(policy ? { policy } : {}),
  } as FactoryDesiredConfig);
}

/**
 * Parse a fixture `factory.yaml` whose trailing lines are appended after the
 * base (valid) config text, so any issue reported is caused only by those
 * lines — never by missing required sections.
 */
function parseWithAppended(appended: string) {
  const base = serializeFactoryConfig({
    ...DEFAULT_FACTORY_CONFIG,
    repository: { path: repoPath },
  });
  return parseFactoryConfig(`${base}${appended}`);
}

/** Seed a Work Order driven to EXECUTING with one READY task, over real deps. */
function seedExecutableTask(
  deps: {
    store: ReturnType<typeof buildServerDeps>['store'];
    events: ReturnType<typeof buildServerDeps>['events'];
  },
): { wo: WorkOrder; task: Task } {
  const wo = createWorkOrder(deps, {
    intent: 'E11.4 policy subject',
    acceptanceCriteria: ['done'],
  });
  for (const to of ['READY', 'PLANNING'] as const) transitionWorkOrder(deps, wo.id, { to });
  const dag = commitDAG(deps, wo.id, { nodes: [{ nodeId: 'a', title: 'Node 1' }] });
  transitionWorkOrder(deps, wo.id, { to: 'EXECUTING' });
  return { wo, task: deps.store.get<Task>('tasks', dag.nodes[0]!.taskId)! };
}

/** Tick + settle up to a budget of iterations; returns nothing (assert after). */
async function tickAndSettle(
  scheduler: NonNullable<ReturnType<typeof buildServerDeps>['scheduler']>,
  iterations = 10,
): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('E11.4 policy/rules configuration surface (#41)', () => {
  it('loads an inline policy: overrides check verdicts vs the embedded default and stamps the custom version', () => {
    const runtime = runtimeFrom(policyConfigText(CUSTOM_POLICY));
    const deps = buildServerDeps(runtime, { reconcileOnBoot: false, herdrCli: new FakeHerdrCli() });
    try {
      // The loaded policy is exactly the configured document.
      expect(runtime.policy).toEqual(CUSTOM_POLICY);
      const { wo, task } = seedExecutableTask(deps);

      // repo.read: the embedded default says ALLOW; the configured org rule is DENY.
      expect(
        check(
          { store: deps.store, events: deps.events, policy: runtime.policy },
          { taskId: task.id, workOrderId: wo.id },
          { capability: 'repo.read', resource: { path: 'notes.md' } },
        ),
      ).toBe('DENY');

      // Control, same seeds: without the override the embedded default speaks
      // (stays ALLOW) under its own `<embedded>` version — absent config
      // changes nothing.
      expect(
        check(
          { store: deps.store, events: deps.events },
          { taskId: task.id, workOrderId: wo.id },
          { capability: 'repo.read', resource: { path: 'notes.md' } },
        ),
      ).toBe('ALLOW');

      // Durable decisions stamp the policy version that resolved them (ADR 14
      // §11: audit trails never mix policy versions).
      const versions = deps.store
        .list<{ policyVersion: string }>('policy_decisions')
        .map((record) => record.policyVersion);
      expect(versions).toContain('e11-fixtures-1');
      expect(versions).toContain(DEFAULT_POLICY_VERSION);
    } finally {
      deps.store.close();
    }
  });

  it('honours the loaded policy through the assignment + write-time gates and the scheduler end-to-end', async () => {
    const runtime = runtimeFrom(policyConfigText(CUSTOM_POLICY));
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      spawn: () => new IdleFakeHerdr(),
      herdrCli: new FakeHerdrCli(),
    });
    try {
      const { wo, task } = seedExecutableTask(deps);

      // Gate level: the assignment gate (repo.write on the worktree branch,
      // whole-worktree `'**'` binding) is outside the configured `docs/**`
      // scope → DENY. The write-time path gate folds the same scope over the
      // change set: inside → allowed, outside → denied.
      const gateDeps = { store: deps.store, events: deps.events, policy: runtime.policy };
      const schedulerPolicy = createSchedulerPolicy(gateDeps);
      expect(schedulerPolicy.canAssign(task, wo)).toBe('DENY');
      expect(schedulerPolicy.canWriteChangeSet).toBeDefined();
      expect(schedulerPolicy.canWriteChangeSet!(task, wo, 'wo-x/impl', ['docs/guide.md']).allowed).toBe(true);
      expect(schedulerPolicy.canWriteChangeSet!(task, wo, 'wo-x/impl', ['src/app.ts']).allowed).toBe(false);

      // End-to-end through buildServerDeps: the scheduler composed with the
      // loaded policy never assigns the task — it stays READY.
      await tickAndSettle(deps.scheduler!);
      expect(deps.store.get<Task>('tasks', task.id)!.state).toBe('READY');

      // Control: same seeds, no policy section — the embedded default assigns
      // (the READY result is behavioral, not a broken fixture).
      const defaultDeps = buildServerDeps(runtimeFrom(policyConfigText()), {
        reconcileOnBoot: false,
        spawn: () => new IdleFakeHerdr(),
        herdrCli: new FakeHerdrCli(),
      });
      try {
        const { task: defaultTask } = seedExecutableTask(defaultDeps);
        await tickAndSettle(defaultDeps.scheduler!);
        expect(defaultDeps.store.get<Task>('tasks', defaultTask.id)!.state).not.toBe('READY');
      } finally {
        defaultDeps.store.close();
      }
    } finally {
      deps.store.close();
    }
  });

  it('absent policy: the embedded default is used unchanged (nothing in config or runtime)', () => {
    const runtime = runtimeFrom(policyConfigText());
    expect(runtime.policy).toBeUndefined();
    expect(policyConfigText()).not.toContain('policy:');
  });

  it('round-trips: parse → resolve → serialize → parse is stable', () => {
    const text = policyConfigText(CUSTOM_POLICY);
    const first = parseFactoryConfig(text);
    if (!first.ok) throw new Error(`first parse failed: ${JSON.stringify(first.issues)}`);
    expect(first.config.policy).toEqual(CUSTOM_POLICY);
    expect(resolveFactoryConfig(first.config, { baseDir: workDir }).policy).toEqual(CUSTOM_POLICY);
    const second = parseFactoryConfig(serializeFactoryConfig(first.config));
    if (!second.ok) throw new Error(`second parse failed: ${JSON.stringify(second.issues)}`);
    expect(second.config.policy).toEqual(CUSTOM_POLICY);
    expect(serializeFactoryConfig(second.config)).toBe(text);
  });

  it('rejects an invalid inline policy loudly at parse: unknown capability, bad decision, malformed scope', () => {
    const unknownCapability = parseWithAppended(
      [
        'policy:',
        '  version: e11-bad-1',
        '  organization:',
        '    capabilities:',
        '      repo.frobnicate:',
        '        - decision: deny',
      ].join('\n'),
    );
    if (unknownCapability.ok) throw new Error('an unknown capability must not parse');
    expect(
      unknownCapability.issues.some(
        (issue) =>
          issue.path === 'policy.organization.capabilities.repo.frobnicate' &&
          issue.message.includes('known capability'),
      ),
    ).toBe(true);

    const badDecision = parseWithAppended(
      [
        'policy:',
        '  version: e11-bad-2',
        '  organization:',
        '    capabilities:',
        '      repo.write:',
        '        - decision: maybe',
      ].join('\n'),
    );
    if (badDecision.ok) throw new Error('an invalid decision must not parse');
    expect(badDecision.issues.some((issue) => issue.path.includes('repo.write') && issue.path.includes('decision'))).toBe(true);

    const malformedScope = parseWithAppended(
      [
        'policy:',
        '  version: e11-bad-3',
        '  organization:',
        '    capabilities:',
        '      repo.write:',
        '        - decision: allow',
        '          scope:',
        '            paths: src/**',
        '      repo.read:',
        '        - decision: allow',
        '          scope:',
        '            filesystem: anything',
      ].join('\n'),
    );
    if (malformedScope.ok) throw new Error('a malformed scope must not parse');
    expect(malformedScope.issues.some((issue) => issue.path === 'policy.organization.capabilities.repo.write[0].scope.paths')).toBe(true);
    expect(malformedScope.issues.some((issue) => issue.path === 'policy.organization.capabilities.repo.read[0].scope.filesystem')).toBe(true);

    const emptyCapabilities = parseWithAppended(
      [
        'policy:',
        '  version: e11-bad-5',
        '  organization:',
        '    capabilities: {}',
      ].join('\n'),
    );
    if (emptyCapabilities.ok) throw new Error('an empty capabilities mapping must not parse');
    expect(
      emptyCapabilities.issues.some(
        (issue) =>
          issue.path === 'policy.organization.capabilities' &&
          issue.message.includes('at least one capability'),
      ),
    ).toBe(true);
  });

  it('rejects a duplicated key inside the policy section loudly (before a last-win decode): inline', () => {
    // `repo.read` listed twice — decoded, only the second rule would survive
    // (the written `deny` silently dropped in favor of `allow`).
    const duplicated = parseWithAppended(
      [
        'policy:',
        '  version: e11-dup-1',
        '  organization:',
        '    capabilities:',
        '      repo.read:',
        '        - decision: deny',
        '      repo.read:',
        '        - decision: allow',
      ].join('\n'),
    );
    if (duplicated.ok) throw new Error('a duplicated policy key must not parse');
    expect(
      duplicated.issues.some(
        (issue) =>
          issue.path === 'policy.organization.capabilities.repo.read' &&
          issue.message.includes('duplicate key'),
      ),
    ).toBe(true);

    // A repeated *version* key under the policy root is caught too.
    const duplicatedVersion = parseWithAppended(
      [
        'policy:',
        '  version: e11-dup-2',
        '  organization:',
        '    capabilities:',
        '      repo.read:',
        '        - decision: deny',
        '  version: e11-dup-2',
      ].join('\n'),
    );
    if (duplicatedVersion.ok) throw new Error('a duplicated policy version key must not parse');
    expect(duplicatedVersion.issues.some((issue) => issue.path === 'policy.version')).toBe(true);

    // A duplicated key in a referenced policy file fails closed at load.
    writeFileSync(
      join(workDir, 'dup-policy.yaml'),
      [
        'version: e11-dup-file',
        'organization:',
        '  capabilities:',
        '    repo.read:',
        '      - decision: deny',
        '    repo.read:',
        '      - decision: allow',
      ].join('\n'),
    );
    const withFile = parseFactoryConfig(
      `${serializeFactoryConfig({
        ...DEFAULT_FACTORY_CONFIG,
        repository: { path: repoPath },
      })}policyFile: ./dup-policy.yaml\n`,
    );
    if (!withFile.ok) throw new Error(`fixture invalid: ${JSON.stringify(withFile.issues)}`);
    let thrown: unknown;
    try {
      resolveFactoryConfig(withFile.config, { baseDir: workDir });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('dup-policy.yaml');
    expect((thrown as Error).message).toContain('duplicate');
  });

  it('round-trips an inline policy whose projects map is empty (emitted inline, not as a childless key)', () => {
    const emptyProjects: PolicyDocument = {
      version: 'e11-empty-projects',
      organization: { capabilities: { 'repo.read': [{ decision: 'DENY' }] } },
      projects: {},
    };
    const text = policyConfigText(emptyProjects);
    expect(text).toContain('projects: {}');
    const first = parseFactoryConfig(text);
    if (!first.ok) throw new Error(`parse failed: ${JSON.stringify(first.issues)}`);
    expect(first.config.policy).toEqual(emptyProjects);
    expect(resolveFactoryConfig(first.config, { baseDir: workDir }).policy).toEqual(emptyProjects);
    const second = parseFactoryConfig(serializeFactoryConfig(first.config));
    if (!second.ok) throw new Error(`re-parse failed: ${JSON.stringify(second.issues)}`);
    expect(second.config.policy).toEqual(emptyProjects);
    expect(serializeFactoryConfig(second.config)).toBe(text);
  });

  it('rejects version markers and ambiguous sources loudly: <embedded> version, policy + policyFile together', () => {
    const embeddedMarker = parseWithAppended(
      [
        `policy:`,
        `  version: ${DEFAULT_POLICY_VERSION}`,
        '  organization:',
        '    capabilities:',
        '      repo.read:',
        '        - decision: deny',
      ].join('\n'),
    );
    if (embeddedMarker.ok) throw new Error('the <embedded> version marker must not be configurable');
    expect(embeddedMarker.issues.some((issue) => issue.path === 'policy.version')).toBe(true);

    const bothSources = parseWithAppended(
      [
        'policyFile: ./policy.yaml',
        'policy:',
        '  version: e11-bad-4',
        '  organization:',
        '    capabilities:',
        '      repo.read:',
        '        - decision: deny',
      ].join('\n'),
    );
    if (bothSources.ok) throw new Error('an inline policy and a policyFile reference together must not parse');
    expect(bothSources.issues.some((issue) => issue.path === 'policy')).toBe(true);

    const badFileRef = parseWithAppended('policyFile: 42\n');
    if (badFileRef.ok) throw new Error('a non-string policyFile must not parse');
    expect(badFileRef.issues.some((issue) => issue.path === 'policyFile')).toBe(true);
  });

  it('loads a referenced policyFile resolved against the config dir; unreadable or invalid content fails closed loudly', () => {
    const policyPath = join(workDir, 'policy.yaml');
    writeFileSync(
      policyPath,
      [
        'version: e11-file-1',
        'organization:',
        '  capabilities:',
        '    repo.read:',
        '      - decision: allow',
        '    repo.write:',
        '      - decision: deny',
      ].join('\n'),
    );
    const config = parseFactoryConfig(
      `${serializeFactoryConfig({
        ...DEFAULT_FACTORY_CONFIG,
        repository: { path: repoPath },
      })}policyFile: ./policy.yaml\n`,
    );
    if (!config.ok) throw new Error(`fixture invalid: ${JSON.stringify(config.issues)}`);
    const runtime = resolveFactoryConfig(config.config, { baseDir: workDir });
    expect(runtime.policy).toEqual({
      version: 'e11-file-1',
      organization: {
        capabilities: {
          'repo.read': [{ decision: 'ALLOW' }],
          'repo.write': [{ decision: 'DENY' }],
        },
      },
    });

    // A referenced file whose content is invalid is rejected loudly at load —
    // never silently degraded toward the (permissive-leaning) default.
    writeFileSync(join(workDir, 'bad-policy.yaml'), 'version: x\norganization: {}\n');
    const invalid = parseFactoryConfig(
      `${serializeFactoryConfig({
        ...DEFAULT_FACTORY_CONFIG,
        repository: { path: repoPath },
      })}policyFile: ./bad-policy.yaml\n`,
    );
    if (!invalid.ok) throw new Error(`fixture invalid: ${JSON.stringify(invalid.issues)}`);
    let thrown: unknown;
    try {
      resolveFactoryConfig(invalid.config, { baseDir: workDir });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('bad-policy.yaml');
    expect((thrown as Error).message).toContain('capabilities');

    // A referenced file that does not exist fails loud too.
    const missing = parseFactoryConfig(
      `${serializeFactoryConfig({
        ...DEFAULT_FACTORY_CONFIG,
        repository: { path: repoPath },
      })}policyFile: ./missing-policy.yaml\n`,
    );
    if (!missing.ok) throw new Error(`fixture invalid: ${JSON.stringify(missing.issues)}`);
    let missingThrow: unknown;
    try {
      resolveFactoryConfig(missing.config, { baseDir: workDir });
    } catch (error) {
      missingThrow = error;
    }
    expect(missingThrow).toBeInstanceOf(Error);
    expect((missingThrow as Error).message).toContain('missing-policy.yaml');
  });

  it('normalizes the template lowercase inline policy: decision tokens land as engine verdicts end to end', async () => {
    // Exactly the shipped `factory.yaml` template's lowercase shape. The raw
    // decode used to flow into runtime.policy verbatim, so `decision: "allow"`
    // never matched the engine's `ALLOW` literal: an allow never allowed, a
    // require_human never gated, and the audit stamped an invalid token.
    const text = policyConfigText();
    const lowercase = parseFactoryConfig(
      `${text}policy:\n  version: e11-lowercase-1\n  organization:\n    capabilities:\n      repo.write:\n        - decision: allow\n          scope: { branchPattern: "wo-*/**", excludePaths: ["infra/**"] }\n      repo.read:\n        - decision: allow\n`,
    );
    if (!lowercase.ok) throw new Error(`lowercase policy invalid: ${JSON.stringify(lowercase.issues)}`);
    const runtime = resolveFactoryConfig(lowercase.config, { baseDir: workDir });

    // The resolved policy carries the *built* document: uppercase verdicts.
    expect(
      runtime.policy!.organization.capabilities['repo.write']!.map((rule) => rule.decision),
    ).toEqual(['ALLOW']);
    expect(
      runtime.policy!.organization.capabilities['repo.read']!.map((rule) => rule.decision),
    ).toEqual(['ALLOW']);

    // End to end: the same loaded policy drives the scheduler's assignment
    // gate (the `!== 'ALLOW'` comparison) and the write-time path gate.
    const deps = buildServerDeps(runtime, {
      reconcileOnBoot: false,
      herdrCli: new FakeHerdrCli(),
      // A settle-closed worker: the point is the assignment gate, not a run.
      spawn: () => idleAdapter(),
    });
    try {
      const { wo, task } = seedExecutableTask(deps);
      const schedulerPolicy = createSchedulerPolicy({
        store: deps.store,
        events: deps.events,
        ...(runtime.policy ? { policy: runtime.policy } : {}),
      });
      expect(schedulerPolicy.canAssign(task, wo)).toBe('ALLOW');
      expect(schedulerPolicy.canWriteChangeSet!(task, wo, 'wo-x/impl', ['src/app.ts']).allowed).toBe(true);
      expect(schedulerPolicy.canWriteChangeSet!(task, wo, 'wo-x/impl', ['infra/x.md']).allowed).toBe(false);

      // The scheduler (which compares the verdict literal) accepts: assigned.
      await tickAndSettle(deps.scheduler!);
      expect(deps.store.get<Task>('tasks', task.id)!.state).not.toBe('READY');

      // Durable decisions stamp the configured (lowercase-sourced) version.
      const versions = deps.store
        .list<{ policyVersion: string }>('policy_decisions')
        .map((record) => record.policyVersion);
      expect(versions).toContain('e11-lowercase-1');
    } finally {
      deps.store.close();
    }
  });

  it('rejects a duplicated root-level policyFile key loudly (it would silently swap the policy source)', () => {
    const duplicated = parseWithAppended('policyFile: ./other-policy.yaml\npolicyFile: ./policy.yaml\n');
    if (duplicated.ok) throw new Error('a duplicated policyFile key must not parse');
    expect(
      duplicated.issues.some(
        (issue) => issue.path === 'policyFile' && issue.message.includes('duplicate key'),
      ),
    ).toBe(true);
  });
});
