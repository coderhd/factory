import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFactoryClient, type FactoryClient } from '../factory/api/client';
import { startFactoryServer, type FactoryServerDeps } from '../factory/api/server';
import { createBackup, restoreBackup } from '../factory/backup/archive';
import {
  DEFAULT_FACTORY_CONFIG,
  isLoopbackHostname,
  parseFactoryConfig,
  resolveFactoryConfig,
  serializeFactoryConfig,
  type FactoryRuntimeConfig,
} from '../factory/config/factoryConfig';
import type { EvidenceBundle } from '../factory/evidence/bundle';
import {
  createGitHubAdapter,
  createGitHubRestTransport,
  type GitHubAdapter,
  type GitHubTransport,
} from '../factory/github/adapter';
import { openEventLog, type EventLog } from '../factory/events/log';
import { createEvidenceReadPort } from '../factory/observatory/observatory';
import { check, checkDetailed, repoWriteGate, type PolicyDocument } from '../factory/policy/policy';
import type { DAGProposalPayload } from '../factory/planning/dag';
import { reconcileAfterRestart } from '../factory/recovery/recovery';
import type { CircuitConfig } from '../factory/recovery/circuitBreaker';
import { createScheduler, type SchedulerPolicy } from '../factory/scheduler/scheduler';
import { createArtifactStore, openStateStore, type StateStore } from '../factory/state/store';
import {
  createProductionVerifier,
  type CommandRunner,
} from '../factory/verification/production';
import type { SemanticJudge } from '../factory/verification/semantic';
import type { WorkVerifier } from '../factory/verification/orchestrator';
import {
  createProcessHerdrCli,
  createHerdrWorker,
  createHerdrWorkspaceManager,
  type HerdrCli,
} from '../factory/workers/herdr';
import { createHarnessSemanticJudge } from '../factory/verification/judgeHarness';
import { createWorkerManager, type SpawnWorker, type WorkerProfile } from '../factory/workers/manager';
import { createWorktreeManager, taskWorktreeBranch } from '../factory/worktrees/worktree';

/**
 * The E2 `factory` CLI (spec §20 operator interface): `init`, `start`, `stop`,
 * `status`, `update`, `backup`, `restore`, plus `wo submit/status/answer` and
 * `observatory`. Every client command goes through the API client — the CLI
 * never touches the store directly — so the server stays the sole mutation
 * authority. Lifecycle + backup/restore are operator/deployment operations on
 * local files.
 */

export interface CliIO {
  cwd?: string;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    const values = flags.get(key) ?? [];
    if (next !== undefined && !next.startsWith('--')) {
      values.push(next);
      i += 1;
    } else {
      values.push('true');
    }
    flags.set(key, values);
  }
  return { positionals, flags };
}

const flag = (args: ParsedArgs, name: string): string | undefined => args.flags.get(name)?.[0];
const hasFlag = (args: ParsedArgs, name: string): boolean => args.flags.has(name);

function resolveDir(args: ParsedArgs, io: CliIO): string {
  return resolve(flag(args, 'dir') ?? io.cwd ?? process.cwd());
}

const configPath = (dir: string): string => join(dir, 'factory.yaml');
const runtimeFilePath = (dir: string): string => join(dir, '.factory', 'runtime.json');

/**
 * E10.4 (#40): the control-plane bearer credential for client commands —
 * `--token <token>` or the `FACTORY_TOKEN` environment variable. The secret
 * flows into the Authorization header and is never logged.
 */
function credentialOptions(args: ParsedArgs): { token?: string } {
  const token = flag(args, 'token') ?? process.env.FACTORY_TOKEN;
  return token ? { token } : {};
}

interface RuntimeFile {
  pid: number;
  url: string;
  port: number;
  dir: string;
  startedAt: string;
}

function readRuntimeFile(dir: string): RuntimeFile | null {
  const path = runtimeFilePath(dir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RuntimeFile;
  } catch {
    return null;
  }
}

function writeRuntimeFile(dir: string, info: RuntimeFile): void {
  mkdirSync(join(dir, '.factory'), { recursive: true });
  writeFileSync(runtimeFilePath(dir), `${JSON.stringify(info, null, 2)}\n`);
}

function clearRuntimeFile(dir: string): void {
  rmSync(runtimeFilePath(dir), { force: true });
}

/** True when a process with `pid` currently exists (signal 0 probe). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

interface LoadedConfig {
  text: string;
  runtime: FactoryRuntimeConfig;
}

function loadConfig(dir: string, io: CliIO): LoadedConfig | null {
  const path = configPath(dir);
  if (!existsSync(path)) {
    io.err(`factory.yaml not found at ${path}; run "factory init" first`);
    return null;
  }
  const text = readFileSync(path, 'utf8');
  const parsed = parseFactoryConfig(text);
  if (!parsed.ok) {
    for (const issue of parsed.issues) io.err(`${issue.path || 'factory.yaml'}: ${issue.message}`);
    return null;
  }
  // E11.4 (#41): resolving a referenced `policyFile:` may fail closed (unread-
  // able file, invalid document). Same contract as a malformed YAML: one
  // actionable line, exit 1 — never a boot with a degraded policy.
  let runtime: FactoryRuntimeConfig;
  try {
    runtime = resolveFactoryConfig(parsed.config, { baseDir: dir });
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  return { text, runtime };
}

function ensureStorageDirs(runtime: FactoryRuntimeConfig): void {
  for (const path of [runtime.paths.state, runtime.paths.artifacts, runtime.paths.knowledge]) {
    mkdirSync(path, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * The E3 `SchedulerPolicy` adapter (E9.1 ruling RE5): assignment is an E7
 * `repo.write` decision on the Task's real worktree branch
 * (`wo-<workOrderId>/task-<short>`), binding `path: '**'` — the whole-worktree
 * binding at assignment time. The **write-time** path gate (E9.8, RE6) folds
 * `repo.write` over the change set's actual changed paths, so the embedded
 * `infra/**` exclusion is enforced against the diff and not merely the branch.
 * `ALLOW` assigns; a `REQUIRE_HUMAN`/`DENY` verdict leaves the Task `READY` and
 * is surfaced by the scheduler's `blockedPolicy`.
 */
export function createSchedulerPolicy(deps: {
  store: StateStore;
  events: EventLog;
  /**
   * E11.4 (#41): the deployment policy (the loaded `policy:` config). Absent,
   * the E7 engine falls back to the embedded defaults — byte-identical to the
   * pre-loader behavior.
   */
  policy?: PolicyDocument;
}): SchedulerPolicy {
  return {
    canAssign: (task, workOrder) =>
      check(deps, { taskId: task.id, workOrderId: workOrder.id }, {
        capability: 'repo.write',
        resource: { branch: taskWorktreeBranch(task.id, workOrder.id), path: '**' },
      }),
    canWriteChangeSet: (task, workOrder, branch, paths) =>
      repoWriteGate(deps, { taskId: task.id, workOrderId: workOrder.id }, branch, paths),
  };
}

/**
 * Overridable seams for {@link buildServerDeps}. Production uses the real Herdr
 * adapter factory and wall-clock `now`; tests inject a fake adapter (Ruling R5:
 * hermetic — never spawn a real runtime) and a deterministic clock.
 */
export interface ServerDepsOptions {
  spawn?: SpawnWorker;
  now?: () => string;
  /**
   * E9.4 verification seam. Tests wire a verifier here; production instead
   * composes one from the resolved `verification:` config (E10.1, #39) via
   * {@link createProductionVerifier}. Absent both, the scheduler fails closed —
   * a SUCCESS Task is never promoted without a persisted Evidence Bundle.
   */
  verifier?: WorkVerifier;
  /**
   * E10.1 (#39) production verifier seams. These are the *deployment*
   * implementations the composed verifier needs — the model-calling judge and
   * the command executor — never a verifier itself, so the composition under
   * test is the real `buildServerDeps` path. Tests inject hermetic fakes here
   * (fake judge, no subprocess); production leaves them unset for the real
   * implementations.
   */
  verification?: {
    judge?: SemanticJudge;
    runCommand?: CommandRunner;
  };
  /**
   * E10.3 (#37) circuit-breaker tuning for the live dependency producer. Wired
   * onto the scheduler; defaults to the module defaults.
   */
  circuit?: Partial<CircuitConfig>;
  /**
   * E9.6 boot reconciliation. On a real server start this runs first (spec
   * §18.3), so a crash that left an in-flight Attempt behind is interrupted and
   * recovered before the scheduler loop begins. Defaults to `true`; tests that
   * build deps over pre-seeded state can opt out.
   */
  reconcileOnBoot?: boolean;
  /**
   * E10.3 (#37) GitHub route composition. When supplied, `buildServerDeps`
   * constructs the E6 adapter here — the **only** place a `GitHubTransport` is
   * injected — wiring it to the real E7 `checkDetailed` policy and the durable
   * `evidence_bundles` read-back, and attaches it to `FactoryServerDeps.github`
   * so the server's operator routes can import an issue and open a PR. The
   * transport itself (production: the REST client; tests: a mock) is the
   * caller's; auth/config is out of #37's scope. Absent, no adapter is built and
   * the GitHub routes 404 (fail closed).
   */
  github?: {
    transport: GitHubTransport;
    /**
     * Base URL of the E2 API the adapter's client mutates through. Defaults to
     * the resolved `server.url` (the running process's own API). Tests that bind
     * the server to an ephemeral port pass the bound URL here.
     */
    apiBaseUrl?: string;
    /** Factory base URL used to render the PR body's links. Defaults to `server.url`. */
    factoryBaseUrl?: string;
  };
  /**
   * E11.3 (#43) hermetic transport seam for a config-composed adapter. When the
   * resolved config carries a `github:` section, `buildServerDeps` composes the
   * adapter from it (env token + REST transport); tests inject a mock here so
   * nothing ever reaches live GitHub (R6). Ignored when `github` is supplied.
   */
  githubTransport?: GitHubTransport;
  /**
   * E11.3 (#43) the *effective* bind (`--hostname`/`--port` overrides, E10.4).
   * When the adapter is composed from config, its E2 `apiBaseUrl` and PR-link
   * `factoryBaseUrl` resolve from this — not from the YAML `server.*` — so a
   * server started with overrides advertises the URL it actually serves.
   * Absent, the effective bind is the resolved `server.hostname`/`port`.
   */
  serverBind?: { hostname: string; port: number };
  /**
   * E11.1 (#44) hermetic seam for the worker runtime: an in-process fake
   * `herdr` CLI. When supplied, the production `spawn` composes every worker
   * adapter against it — no real `herdr`/`opencode` is ever spawned. Ignored
   * when `spawn` is supplied.
   */
  herdrCli?: HerdrCli;
}

/**
 * The supported worker profiles, as a runtime list. `WorkerProfile` is a union
 * of string literals; this array is the single runtime source of truth for the
 * membership check below, and the `satisfies` keeps it exhaustive.
 */
const SUPPORTED_WORKER_PROFILES = ['herdr'] as const satisfies readonly WorkerProfile[];

/**
 * Resolve `provisioning.defaultProfile` into a `WorkerProfile`, failing loudly
 * on a value the runtime cannot honour. `factory.yaml` validation only checks
 * the string is non-empty, so this closes the gap between "a string was
 * configured" and "a profile this deployment actually supports and declares".
 * Throws (rather than casting) so a misconfiguration is visible at boot, not
 * silently provisioned.
 */
function resolveDefaultWorkerProfile(runtime: FactoryRuntimeConfig): WorkerProfile {
  const configured = runtime.scheduler.provisioning.defaultProfile;
  const profiles = runtime.workers.profiles;
  if (!(SUPPORTED_WORKER_PROFILES as readonly string[]).includes(configured)) {
    throw new Error(
      `scheduler.provisioning.defaultProfile "${configured}" is not a supported worker profile (supported: ${SUPPORTED_WORKER_PROFILES.join(', ')})`,
    );
  }
  if (!profiles.includes(configured)) {
    throw new Error(
      `scheduler.provisioning.defaultProfile "${configured}" is not declared in workers.profiles (${profiles.join(', ')})`,
    );
  }
  return configured as WorkerProfile;
}

/**
 * Resolve the production `WorkVerifier` for this boot (E10.1, #39). An explicit
 * `verifier` option wins (the injectable test seam). Otherwise, when the
 * resolved config carries a `verification:` section, compose the real E5-backed
 * verifier from it. The `judge` argument is the `SemanticJudge` implementation
 * the composition binds (E11.2, #42): production passes the harness-backed
 * judge when none was injected; tests may inject a hermetic fake judge seam.
 * Composition is fail-closed: a misconfiguration is logged loudly and **no**
 * verifier is wired, so a SUCCESS Task parks rather than being promoted on a
 * half-built verifier. When the section is absent, this returns `undefined` —
 * exactly the pre-#39 behaviour.
 */
function resolveVerifier(
  runtime: FactoryRuntimeConfig,
  options: ServerDepsOptions,
  store: StateStore,
  judge?: SemanticJudge,
): WorkVerifier | undefined {
  if (options.verifier) return options.verifier;
  if (!runtime.verification) return undefined;
  try {
    return createProductionVerifier({
      config: runtime.verification,
      store,
      workingDirectory: runtime.repository.path,
      ...(judge ? { judge } : {}),
      ...(options.verification?.runCommand ? { runCommand: options.verification.runCommand } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  } catch (error) {
    console.error(
      `scheduler: verifier composition failed (${error instanceof Error ? error.message : String(error)}); no verifier wired — SUCCESS Tasks will not be verified or promoted`,
    );
    return undefined;
  }
}

/**
 * The fail-closed token gate (E11.3, #43): when the resolved config carries a
 * `github:` section, the token's env variable must hold a value at boot, or the
 * serve path refuses to start. The error names the env var, never any secret.
 * Returns `null` when the section is absent (nothing to fail closed about).
 */
export function githubTokenMissingError(runtime: FactoryRuntimeConfig): string | null {
  if (!runtime.github) return null;
  const token = process.env[runtime.github.tokenEnv];
  if (token !== undefined && token.trim().length > 0) return null;
  return (
    `refusing to start: the github: config names token env variable "${runtime.github.tokenEnv}", ` +
    'which is not set — export it (the token itself is never configured in factory.yaml) or remove the github: section (fails closed)'
  );
}

/** The GitHub seam inputs the adapter composition consumes (E11.3, #43). */
interface GitHubCompositionInputs {
  transport: GitHubTransport;
  apiBaseUrl: string;
  factoryBaseUrl: string;
  baseBranch: string;
}

/**
 * The GitHub seam composition source (E11.3, #43), resolved as an ordered
 * preference: an explicit `options.github` seam (tests) wins; then a resolved
 * `github:` config section (token read from the env var it names, REST
 * transport, base URLs from the effective bind); otherwise `null` — no adapter
 * is composed and the GitHub routes 404 (fail closed).
 */
function resolveGitHubInputs(
  runtime: FactoryRuntimeConfig,
  options: ServerDepsOptions,
): GitHubCompositionInputs | null {
  const failClosed = (): never => {
    // Unreachable when `runtime.github` is absent: callers check the section
    // first, so the token error is always present here.
    throw new Error(githubTokenMissingError(runtime) ?? 'github adapter is unconfigured');
  };

  if (options.github) {
    // Explicit seam (tests): the caller owns apiBaseUrl/factoryBaseUrl defaults
    // against the resolved server URL; baseBranch stays the worktrees default.
    return {
      transport: options.github.transport,
      apiBaseUrl: options.github.apiBaseUrl ?? runtime.server.url,
      factoryBaseUrl: options.github.factoryBaseUrl ?? runtime.server.url,
      baseBranch: runtime.worktrees.baseBranch,
    };
  }
  if (!runtime.github) return null;
  {
    const token = process.env[runtime.github.tokenEnv] ?? failClosed();
    if (token.trim().length === 0) failClosed();
    const hostname = options.serverBind?.hostname ?? runtime.server.hostname;
    const port = options.serverBind?.port ?? runtime.server.port;
    const effectiveUrl = `http://${bindLinkHostname(hostname, runtime.server.hostname)}:${port}`;
    return {
      transport:
        options.githubTransport ??
        createGitHubRestTransport({
          token,
          apiBaseUrl: runtime.github.apiBaseUrl,
        }),
      apiBaseUrl: effectiveUrl,
      factoryBaseUrl: effectiveUrl,
      baseBranch: runtime.github.baseBranch,
    };
  }
}

function isWildcardHostname(hostname: string): boolean {
  return hostname === '0.0.0.0' || hostname === '::' || hostname.trim().length === 0;
}

/**
 * The hostname that is safe to embed in *outbound* links (E11.3, #43). The
 * effective bind wins for a concrete host, but a deployment that binds
 * `0.0.0.0`/`::` (e.g. the container path, `--hostname 0.0.0.0` per compose.yaml)
 * would advertise `http://0.0.0.0:<port>` in PR bodies — the bind is correct,
 * the link is unclickable. A wildcard bind therefore falls back to the YAML
 * `server.hostname` when it is routable, else the loopback; the effective port
 * is kept (the bound port is what the deployment exposes).
 */
function bindLinkHostname(hostname: string, configuredHostname: string): string {
  if (hostname !== '0.0.0.0' && hostname !== '::') return hostname;
  return isWildcardHostname(configuredHostname) ? '127.0.0.1' : configuredHostname;
}

export function buildServerDeps(
  runtime: FactoryRuntimeConfig,
  options: ServerDepsOptions = {},
): FactoryServerDeps {
  // Validate the provisioning profile before opening any resource, so a
  // misconfiguration fails fast without leaving a half-built store behind.
  const defaultProfile = resolveDefaultWorkerProfile(runtime);
  // E11.3 (#43): resolve the GitHub seam *before* any resource is opened — a
  // configured `github:` section without its token env var aborts boot (fail
  // closed) instead of leaving a half-built server behind.
  const githubInputs = resolveGitHubInputs(runtime, options);
  ensureStorageDirs(runtime);
  const store = openStateStore(runtime.paths.db);
  const events = openEventLog(store.db);
  // E11.1 (#44)/E11.2 (#42): the herdr CLI runner and the dedicated `factory`
  // workspace manager are server-scoped, shared by every worker adapter AND the
  // semantic judge's harness — the environment is ensured once and reused;
  // harnesses spawn/kill on demand, zero at rest.
  const herdrCli = options.herdrCli ?? createProcessHerdrCli('herdr');
  const herdrWorkspace = createHerdrWorkspaceManager(herdrCli, {
    label: runtime.workers.workspaceLabel ?? 'factory',
    repoPath: runtime.repository.path,
  });
  // E11.2 (#42): the model-calling judge seam. An explicitly injected judge
  // (tests) wins; otherwise, when a `verification:` section is configured, the
  // production judge is the harness-backed one — an opencode harness in a fresh
  // pane, driven over the same shared herdr CLI. A `verification:` section
  // without a config-composable judge is refused by `createProductionVerifier`
  // (fail closed, inside `resolveVerifier`).
  const judge =
    options.verification?.judge ??
    (runtime.verification
      ? createHarnessSemanticJudge({
          cli: herdrCli,
          workspace: herdrWorkspace,
          identity: {
            provider: runtime.verification.judge.provider,
            model: runtime.verification.judge.model,
            ...(runtime.verification.judge.family ? { family: runtime.verification.judge.family } : {}),
            ...(runtime.verification.judge.version ? { version: runtime.verification.judge.version } : {}),
          },
          harness: runtime.verification.judge.harness,
        })
      : undefined);
  const verifier = resolveVerifier(runtime, options, store, judge);
  const workers = createWorkerManager({
    store,
    events,
    spawn:
      options.spawn ??
      (() =>
        createHerdrWorker({
          cli: herdrCli,
          workspace: herdrWorkspace,
          harness: runtime.workers.harness ?? 'opencode',
          models: runtime.workers.models ?? {},
          repoPath: runtime.repository.path,
        })),
    ...(options.now ? { now: options.now } : {}),
  });
  const worktrees = createWorktreeManager({
    rootDir: runtime.worktrees.rootDir,
    baseBranch: runtime.worktrees.baseBranch,
  });
  const artifacts = createArtifactStore(runtime.paths.artifacts);
  // One store-backed evidence reader serves both the Observatory projection and
  // E9.7's per-Attempt telemetry (human-leverage layer) — a single read seam.
  const evidence = createEvidenceReadPort(store);
  // E10.3 (#37): compose the E6 GitHub adapter into the running process. Its
  // client speaks the E2 API (the sole mutation authority), its policy gate is
  // the real E7 `checkDetailed`, and its evidence read-back is the durable
  // `evidence_bundles` receipt — the same sources the server itself uses.
  // E11.3 (#43): the inputs come from the resolved `github:` config (env token,
  // REST transport, effective-bind URLs) when no explicit seam is supplied;
  // absent both, nothing is built (routes 404).
  const github = githubInputs
    ? buildGitHubAdapter({
        transport: githubInputs.transport,
        client: createFactoryClient({
          baseUrl: githubInputs.apiBaseUrl,
          ...(runtime.server.auth ? { token: runtime.server.auth.token } : {}),
        }),
        factoryBaseUrl: githubInputs.factoryBaseUrl,
        store,
        events,
        // E11.4 (#41): the E6 gates run against the loaded deployment policy.
        ...(runtime.policy ? { policy: runtime.policy } : {}),
        baseBranch: githubInputs.baseBranch,
      })
    : undefined;
  // E9.6 boot reconciliation (spec §18.3): walk durable state → event history →
  // RUNNING Attempts → worker leases before the loop starts. Post-restart no
  // adapter is live, so every lease is treated as stopped (via
  // `ReconcileOptions.workerStatus`): an in-flight Attempt is interrupted (never
  // claimed successful), its diff preserved as evidence, its Assignment closed,
  // and recovery opens a new clean-baseline Attempt.
  if (options.reconcileOnBoot !== false) {
    reconcileAfterRestart(
      {
        store,
        events,
        artifacts,
        ...(options.now ? { now: options.now } : {}),
      },
      { workerStatus: () => 'stopped' },
    );
  }
  // The resolved `factory.yaml` scheduler config drives the real E3 scheduler,
  // so an edited desired config changes the running instance. The serve path
  // owns the loop lifecycle (start/stop around the listener).
  const scheduler = createScheduler(
    {
      store,
      events,
      workers,
      worktrees,
      repoPath: runtime.repository.path,
      artifacts,
      policy: createSchedulerPolicy({
        store,
        events,
        // E11.4 (#41): the loaded `policy:` config (or referenced file) drives
        // assignment and the write-time path gate; absent → embedded default.
        ...(runtime.policy ? { policy: runtime.policy } : {}),
      }),
      telemetry: { evidence },
      ...(options.now ? { now: options.now } : {}),
      ...(verifier ? { verifier } : {}),
      ...(options.circuit ? { circuit: options.circuit } : {}),
    },
    {
      maxConcurrentTasks: runtime.scheduler.maxConcurrentTasks,
      tickIntervalMs: runtime.scheduler.tickIntervalMs,
      provisioning: {
        ...runtime.scheduler.provisioning,
        defaultProfile,
      },
    },
  );
  return {
    store,
    events,
    evidence,
    scheduler,
    ...(github ? { github } : {}),
    // E10.4 (#40): carry the resolved bearer credential + principal into the
    // API surface so authenticated deployments gate mutating routes.
    ...(runtime.server.auth ? { auth: { ...runtime.server.auth } } : {}),
    version: runtime.factoryVersion,
    schemaVersion: runtime.schemaVersion,
  };
}

/**
 * The E6 composition root (E9.8, #34): construct the GitHub adapter with the
 * **real** deps — the E2 client (sole mutation authority), the E7
 * `checkDetailed` policy (so `branch.create`/`pr.create`/merge gates run against
 * live policy), and the durable `evidence_bundles` read-back (so the merge gate
 * trusts the persisted receipt, never a caller-supplied bundle). Production
 * supplies the concrete transport (a GitHub REST client); tests mock it (R6).
 *
 * The Factory never constructs a second GitHub path: this is the only place the
 * E6 adapter is wired, mirroring `buildServerDeps`.
 */
export function buildGitHubAdapter(input: {
  transport: GitHubTransport;
  client: FactoryClient;
  factoryBaseUrl: string;
  store: StateStore;
  events: EventLog;
  /**
   * E11.4 (#41): the loaded deployment policy. When configured, the E6 gates
   * (`branch.create`/`pr.create`/merge) evaluate against it; absent, they
   * evaluate against the embedded default.
   */
  policy?: PolicyDocument;
  baseBranch?: string;
}): GitHubAdapter {
  return createGitHubAdapter({
    transport: input.transport,
    client: input.client,
    factoryBaseUrl: input.factoryBaseUrl,
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    checkPolicy: (subject, action) =>
      checkDetailed(
        { store: input.store, events: input.events, ...(input.policy ? { policy: input.policy } : {}) },
        subject,
        action,
      ),
    readEvidence: (id) => input.store.get<EvidenceBundle>('evidence_bundles', id),
  });
}

async function cmdInit(args: ParsedArgs, io: CliIO): Promise<number> {
  const dir = resolveDir(args, io);
  mkdirSync(dir, { recursive: true });
  const path = configPath(dir);
  if (existsSync(path)) {
    const parsed = parseFactoryConfig(readFileSync(path, 'utf8'));
    if (!parsed.ok) {
      for (const issue of parsed.issues) io.err(`${issue.path || 'factory.yaml'}: ${issue.message}`);
      return 1;
    }
    ensureStorageDirs(resolveFactoryConfig(parsed.config, { baseDir: dir }));
    io.out(`factory.yaml already present and valid: ${path}`);
    return 0;
  }
  writeFileSync(path, serializeFactoryConfig(DEFAULT_FACTORY_CONFIG));
  ensureStorageDirs(resolveFactoryConfig(DEFAULT_FACTORY_CONFIG, { baseDir: dir }));
  io.out(path);
  return 0;
}

async function cmdStatus(args: ParsedArgs, io: CliIO): Promise<number> {
  const dir = resolveDir(args, io);
  const explicitUrl = flag(args, 'url');
  const runtimeFile = readRuntimeFile(dir);
  const url = explicitUrl ?? runtimeFile?.url;
  if (!url) {
    io.out(JSON.stringify({ status: 'stopped' }));
    return 0;
  }
  try {
    const client = createFactoryClient({ baseUrl: url, fetch: io.fetch });
    const health = await client.health();
    io.out(
      JSON.stringify({
        status: 'running',
        url,
        instanceId: health.instanceId,
        version: health.version,
        schemaVersion: health.schemaVersion,
      }),
    );
  } catch {
    io.out(JSON.stringify({ status: 'stopped', url }));
  }
  return 0;
}

/**
 * E10.4 (#40), serve-time fail-closed re-check: config validation sees only the
 * YAML `server.hostname`, but `--hostname` (the container path) can widen the
 * *effective* bind past it. A non-loopback effective bind without
 * `server.auth` is refused here too — mutating routes must not be reachable
 * off-loopback unauthenticated.
 */
function effectiveBindAuthError(hostname: string, runtime: FactoryRuntimeConfig): string | null {
  if (isLoopbackHostname(hostname) || runtime.server.auth) return null;
  return (
    `refusing to bind ${hostname}: the control plane requires a bearer credential when the ` +
    'effective bind is not loopback — configure server.auth { token, actor } in factory.yaml ' +
    '(see factory-docs/implementation/control-plane-auth.md)'
  );
}

/**
 * E11.3 (#43): the serve path wraps `buildServerDeps` so a fail-closed abort
 * (e.g. `github:` configured without its token env var) prints a single
 * actionable line and exits 1 — the message names the env var, never a secret.
 */
function buildServerDepsGuarded(
  runtime: FactoryRuntimeConfig,
  options: ServerDepsOptions,
): { deps: ReturnType<typeof buildServerDeps> } | { error: string } {
  try {
    return { deps: buildServerDeps(runtime, options) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function cmdServe(args: ParsedArgs, io: CliIO): Promise<number> {
  const dir = resolveDir(args, io);
  const loaded = loadConfig(dir, io);
  if (!loaded) return 1;
  const port = flag(args, 'port') !== undefined ? Number(flag(args, 'port')) : loaded.runtime.server.port;
  // The bind address is the resolved `server.hostname` (spec §20); `--hostname`
  // overrides it for a container, where the loopback default is unreachable
  // through a mapped port. A non-loopback effective bind requires auth (E10.4).
  const hostname = flag(args, 'hostname') ?? loaded.runtime.server.hostname;
  const bindError = effectiveBindAuthError(hostname, loaded.runtime);
  if (bindError) {
    io.err(bindError);
    return 1;
  }

  const depsOrError = buildServerDepsGuarded(loaded.runtime, {
    serverBind: { hostname, port },
  });
  if ('error' in depsOrError) {
    io.err(depsOrError.error);
    return 1;
  }
  const deps = depsOrError.deps;
  const handle = startFactoryServer(deps, { port, hostname });
  // Actually run the E3 scheduler loop for the life of the server (spec §7.2).
  deps.scheduler?.start();
  writeRuntimeFile(dir, {
    pid: process.pid,
    url: handle.url,
    port: handle.port,
    dir,
    startedAt: new Date().toISOString(),
  });
  io.out(handle.url);

  const shutdown = (): void => {
    deps.scheduler?.stop();
    clearRuntimeFile(dir);
    handle.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await new Promise<never>(() => {});
  return 0;
}

async function cmdStart(args: ParsedArgs, io: CliIO): Promise<number> {
  const dir = resolveDir(args, io);
  const loaded = loadConfig(dir, io);
  if (!loaded) return 1;
  const port = flag(args, 'port') ?? String(loaded.runtime.server.port);
  const hostname = flag(args, 'hostname') ?? loaded.runtime.server.hostname;
  // Fail fast on an unauthenticated wide bind **before** spawning the child
  // (E10.4): the serve child's error output is not visible to the caller.
  const bindError = effectiveBindAuthError(hostname, loaded.runtime);
  if (bindError) {
    io.err(bindError);
    return 1;
  }
  // E11.3 (#43): same fail-fast for a configured `github:` section whose token
  // env var is unset — the detached child's error is not visible to the caller.
  const tokenError = githubTokenMissingError(loaded.runtime);
  if (tokenError) {
    io.err(tokenError);
    return 1;
  }

  if (!hasFlag(args, 'detached')) {
    const withPort = { ...args, flags: withFlag(args, 'port', port) };
    const withPortAndHostname = { ...withPort, flags: withFlag(withPort, 'hostname', hostname) };
    return cmdServe(withPortAndHostname, io);
  }

  // Guard on an existing runtime.json: a live server must not be shadowed by a
  // second doomed child (port EADDRINUSE reported as success), and a stale pid
  // file must not be mistaken for the server we are about to start.
  const existing = readRuntimeFile(dir);
  if (existing) {
    if (isProcessAlive(existing.pid)) {
      io.err(
        `factory server already running at ${existing.url} (pid ${existing.pid}); run "factory stop" first`,
      );
      return 1;
    }
    clearRuntimeFile(dir);
  }

  const cliFile = fileURLToPath(import.meta.url);
  const child = Bun.spawn(
    [process.execPath, cliFile, '__serve', '--dir', dir, '--port', port, '--hostname', hostname],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: process.env,
    },
  );
  child.unref();

  // The child writes runtime.json once it is listening; wait for it.
  for (let i = 0; i < 50; i += 1) {
    const runtimeFile = readRuntimeFile(dir);
    if (runtimeFile) {
      io.out(runtimeFile.url);
      return 0;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  io.err('server did not start within 5s');
  return 1;
}

function withFlag(args: ParsedArgs, name: string, value: string): Map<string, string[]> {
  const flags = new Map(args.flags);
  flags.set(name, [value]);
  return flags;
}

async function cmdStop(args: ParsedArgs, io: CliIO): Promise<number> {
  const dir = resolveDir(args, io);
  const runtimeFile = readRuntimeFile(dir);
  if (!runtimeFile) {
    io.out(JSON.stringify({ status: 'stopped', stopped: false }));
    return 0;
  }
  try {
    process.kill(runtimeFile.pid, 'SIGTERM');
  } catch {
    // Already gone — clearing the runtime file is still correct.
  }
  clearRuntimeFile(dir);
  io.out(JSON.stringify({ status: 'stopped', stopped: true, pid: runtimeFile.pid }));
  return 0;
}

async function cmdUpdate(args: ParsedArgs, io: CliIO): Promise<number> {
  const dir = resolveDir(args, io);
  const loaded = loadConfig(dir, io);
  if (!loaded) return 1;
  // Spec §20 upgrade procedure: mandatory pre-upgrade backup first.
  const backup = join(dir, '.factory', 'backups', `pre-upgrade-${timestamp()}.tar.gz`);
  createBackup({
    stateDbPath: loaded.runtime.paths.db,
    artifactsDir: loaded.runtime.paths.artifacts,
    knowledgeDir: loaded.runtime.paths.knowledge,
    configText: loaded.text,
    outFile: backup,
    factoryVersion: loaded.runtime.factoryVersion,
    schemaVersion: loaded.runtime.schemaVersion,
  });
  io.out(
    JSON.stringify({
      configValid: true,
      image: loaded.runtime.image.ref,
      backup: resolve(backup),
    }),
  );
  return 0;
}

async function cmdBackup(args: ParsedArgs, io: CliIO): Promise<number> {
  const dir = resolveDir(args, io);
  const loaded = loadConfig(dir, io);
  if (!loaded) return 1;
  const outFile = flag(args, 'out') ?? join(dir, '.factory', 'backups', `backup-${timestamp()}.tar.gz`);
  createBackup({
    stateDbPath: loaded.runtime.paths.db,
    artifactsDir: loaded.runtime.paths.artifacts,
    knowledgeDir: loaded.runtime.paths.knowledge,
    configText: loaded.text,
    outFile,
    factoryVersion: loaded.runtime.factoryVersion,
    schemaVersion: loaded.runtime.schemaVersion,
  });
  io.out(resolve(outFile));
  return 0;
}

async function cmdRestore(args: ParsedArgs, io: CliIO): Promise<number> {
  const archive = args.positionals[1];
  const intoDir = flag(args, 'into');
  if (!archive || !intoDir) {
    io.err('usage: factory restore <archive> --into <dir> [--force]');
    return 1;
  }
  restoreBackup({ archive, intoDir, force: hasFlag(args, 'force') });
  io.out(resolve(intoDir));
  return 0;
}

// ---------------------------------------------------------------------------
// Client commands (all go through the API)
// ---------------------------------------------------------------------------

function resolveUrl(args: ParsedArgs, io: CliIO): string | null {
  const explicit = flag(args, 'url');
  if (explicit) return explicit;
  const runtimeFile = readRuntimeFile(resolveDir(args, io));
  if (runtimeFile) return runtimeFile.url;
  const loaded = loadConfig(resolveDir(args, io), { ...io, err: () => undefined });
  return loaded?.runtime.server.url ?? null;
}

async function cmdWo(args: ParsedArgs, io: CliIO): Promise<number> {
  const sub = args.positionals[1];
  const url = resolveUrl(args, io);
  if (!url) {
    io.err('no server URL; pass --url or start the server first');
    return 1;
  }
  const client = createFactoryClient({
    baseUrl: url,
    fetch: io.fetch,
    // E10.4 (#40): the bearer credential for authenticated deployments.
    ...credentialOptions(args),
  });

  if (sub === 'submit') {
    const intent = flag(args, 'intent');
    if (!intent) {
      io.err('usage: factory wo submit --intent <text> [--acceptance <criterion>] [--url <url>]');
      return 1;
    }
    const workOrder = await client.submitWorkOrder({
      intent,
      acceptanceCriteria: args.flags.get('acceptance'),
      repository: flag(args, 'repo'),
    });
    io.out(JSON.stringify(workOrder));
    return 0;
  }

  if (sub === 'status') {
    const id = args.positionals[2];
    if (!id) {
      io.err('usage: factory wo status <workOrderId>');
      return 1;
    }
    io.out(JSON.stringify(await client.getWorkOrder(id)));
    return 0;
  }

  if (sub === 'list') {
    io.out(JSON.stringify(await client.listWorkOrders()));
    return 0;
  }

  if (sub === 'plan') {
    const id = args.positionals[2];
    const dagFile = flag(args, 'dag');
    if (!id || !dagFile) {
      io.err('usage: factory wo plan <workOrderId> --dag <file> [--url <url>]');
      return 1;
    }
    const path = resolve(io.cwd ?? process.cwd(), dagFile);
    if (!existsSync(path)) {
      io.err(`dag file not found: ${path}`);
      return 1;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      io.err(`dag file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { nodes?: unknown }).nodes)) {
      io.err('dag file must be a JSON object with a "nodes" array');
      return 1;
    }
    io.out(JSON.stringify(await client.commitDag(id, payload as DAGProposalPayload)));
    return 0;
  }

  if (sub === 'answer') {
    const id = args.positionals[2];
    const response = args.positionals.slice(3).join(' ') || flag(args, 'response');
    if (!id || !response) {
      io.err('usage: factory wo answer <interactionId> <response> [--actor <id>]');
      return 1;
    }
    io.out(JSON.stringify(await client.answerInteraction(id, response, flag(args, 'actor'))));
    return 0;
  }

  io.err(`unknown wo subcommand: ${sub ?? ''}`);
  return 1;
}

/**
 * E10.3 (#37) GitHub operator surface (spec §4.2/§28). `factory github import
 * --repo <owner/name> --issue <n>` reconciles an issue into a Work Order;
 * `factory github pr --bundle <evidenceBundleId>` opens a PR that links the
 * durable Evidence Bundle. Both call the API — the server composes the E6
 * adapter, and the CLI never talks to GitHub.
 */
async function cmdGithub(args: ParsedArgs, io: CliIO): Promise<number> {
  const sub = args.positionals[1];
  const url = resolveUrl(args, io);
  if (!url) {
    io.err('no server URL; pass --url or start the server first');
    return 1;
  }
  const client = createFactoryClient({
    baseUrl: url,
    fetch: io.fetch,
    // E10.4 (#40): the bearer credential for authenticated deployments.
    ...credentialOptions(args),
  });

  if (sub === 'import') {
    const repository = flag(args, 'repo');
    const number = flag(args, 'issue');
    if (!repository || !number) {
      io.err('usage: factory github import --repo <owner/name> --issue <number> [--url <url>]');
      return 1;
    }
    const parsed = Number(number);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      io.err(`--issue must be a positive integer (got "${number}")`);
      return 1;
    }
    io.out(JSON.stringify(await client.githubImportIssue({ repository, number: parsed })));
    return 0;
  }

  if (sub === 'pr') {
    const evidenceBundleId = flag(args, 'bundle');
    if (!evidenceBundleId) {
      io.err('usage: factory github pr --bundle <evidenceBundleId> [--base <branch>] [--title <text>] [--url <url>]');
      return 1;
    }
    const base = flag(args, 'base');
    const title = flag(args, 'title');
    io.out(
      JSON.stringify(
        await client.githubOpenPullRequest({
          evidenceBundleId,
          ...(base ? { baseBranch: base } : {}),
          ...(title ? { title } : {}),
        }),
      ),
    );
    return 0;
  }

  io.err(`unknown github subcommand: ${sub ?? ''}`);
  return 1;
}

async function cmdObservatory(args: ParsedArgs, io: CliIO): Promise<number> {
  const url = resolveUrl(args, io);
  if (!url) {
    io.err('no server URL; pass --url or start the server first');
    return 1;
  }
  const client = createFactoryClient({
    baseUrl: url,
    fetch: io.fetch,
    // E10.4 (#40): the bearer credential for authenticated deployments.
    ...credentialOptions(args),
  });
  io.out(JSON.stringify(await client.observatory()));
  return 0;
}

/**
 * E9.6 factory-level controls (spec §10/§18.11): `factory control
 * <status|pause|resume|emergency-stop> [--actor <id>]`. The durable flag and
 * its event are E7's; the CLI only calls the API, so the server remains the
 * sole mutation authority.
 */
async function cmdControl(args: ParsedArgs, io: CliIO): Promise<number> {
  const sub = args.positionals[1];
  const url = resolveUrl(args, io);
  if (!url) {
    io.err('no server URL; pass --url or start the server first');
    return 1;
  }
  const client = createFactoryClient({
    baseUrl: url,
    fetch: io.fetch,
    // E10.4 (#40): the bearer credential for authenticated deployments.
    ...credentialOptions(args),
  });

  if (sub === 'status') {
    io.out(JSON.stringify(await client.factoryControls()));
    return 0;
  }
  if (sub === 'pause' || sub === 'resume' || sub === 'emergency-stop') {
    const actor = flag(args, 'actor');
    if (!actor) {
      io.err(`usage: factory control ${sub} --actor <id> [--token <tok>] [--url <url>]`);
      return 1;
    }
    const controls =
      sub === 'pause'
        ? await client.pause(actor)
        : sub === 'resume'
          ? await client.resume(actor)
          : await client.emergencyStop(actor);
    io.out(JSON.stringify(controls));
    return 0;
  }

  io.err(`unknown control subcommand: ${sub ?? ''}`);
  return 1;
}

async function cmdApprovals(args: ParsedArgs, io: CliIO): Promise<number> {
  const sub = args.positionals[1];
  const url = resolveUrl(args, io);
  if (!url) {
    io.err('no server URL; pass --url or start the server first');
    return 1;
  }
  const client = createFactoryClient({
    baseUrl: url,
    fetch: io.fetch,
    // E10.4 (#40): the bearer credential for authenticated deployments.
    ...credentialOptions(args),
  });

  if (sub === 'list') {
    const status = flag(args, 'status') as 'PENDING' | 'ANSWERED' | 'SPENT' | undefined;
    io.out(JSON.stringify(await client.listApprovals(status)));
    return 0;
  }

  if (sub === 'answer') {
    const id = args.positionals[2];
    const decision = flag(args, 'decision');
    const actor = flag(args, 'actor');
    if (!id || (decision !== 'APPROVAL' && decision !== 'DENY') || !actor) {
      io.err('usage: factory approvals answer <approvalId> --decision APPROVAL|DENY --actor <id> [--comment <text>] [--url <url>]');
      return 1;
    }
    const comment = flag(args, 'comment');
    const approval = await client.answerApproval(id, {
      decision,
      actor,
      ...(comment ? { comment } : {}),
    });
    io.out(JSON.stringify(approval));
    return 0;
  }

  io.err(`unknown approvals subcommand: ${sub ?? ''}`);
  return 1;
}

const HELP = [
  'factory <command>',
  '',
  '  init [--dir <dir>]                     write/validate factory.yaml',
  '  start [--dir <dir>] [--detached]       start the Factory server',
  '  stop [--dir <dir>]                     stop the Factory server',
  '  status [--dir <dir>] [--url <url>]     report server status',
  '  update [--dir <dir>]                   validate config + pre-upgrade backup',
  '  backup [--dir <dir>] [--out <file>]    write a backup archive',
  '  restore <archive> --into <dir> [--force]  restore a backup archive',
  '  wo submit --intent <text> [--url]      create a Work Order (DRAFT)',
  '  wo status <workOrderId> [--url]        read Work Order status',
  '  wo plan <workOrderId> --dag <file>     commit a planner DAG proposal',
  '  wo answer <interactionId> <response> [--actor <id>]  answer a QUESTION (--actor is overridden when the server requires a credential)',
  '  approvals list [--status <state>]      list policy approvals',
  '  approvals answer <approvalId> --decision APPROVAL|DENY --actor <id>  answer an approval',
  '  observatory [--url]                    read Observatory projections',
  '  github import --repo <owner/name> --issue <n>  import a GitHub issue into a Work Order',
  '  github pr --bundle <evidenceBundleId>  open a PR linking the Evidence Bundle',
  '  control status [--url]                 read pause/e-stop controls',
  '  control <pause|resume|emergency-stop> --actor <id>  set a factory control (--actor is overridden when the server requires a credential)',
  '',
  "  Client commands accept --token <tok> (or $FACTORY_TOKEN) when the server",
  '  requires a bearer credential (E10.4).',
].join('\n');

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positionals[0];
  try {
    switch (command) {
      case 'init':
        return await cmdInit(args, io);
      case 'start':
        return await cmdStart(args, io);
      case '__serve':
        return await cmdServe(args, io);
      case 'stop':
        return await cmdStop(args, io);
      case 'status':
        return await cmdStatus(args, io);
      case 'update':
        return await cmdUpdate(args, io);
      case 'backup':
        return await cmdBackup(args, io);
      case 'restore':
        return await cmdRestore(args, io);
      case 'wo':
        return await cmdWo(args, io);
      case 'approvals':
        return await cmdApprovals(args, io);
      case 'observatory':
        return await cmdObservatory(args, io);
      case 'github':
        return await cmdGithub(args, io);
      case 'control':
        return await cmdControl(args, io);
      case 'help':
      case undefined:
        io.out(HELP);
        return 0;
      default:
        io.err(`unknown command: ${command}`);
        io.out(HELP);
        return 1;
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  if (code !== 0) process.exit(code);
}
