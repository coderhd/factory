import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFactoryClient } from '../factory/api/client';
import { startFactoryServer, type FactoryServerDeps } from '../factory/api/server';
import { createBackup, restoreBackup } from '../factory/backup/archive';
import {
  DEFAULT_FACTORY_CONFIG,
  parseFactoryConfig,
  resolveFactoryConfig,
  serializeFactoryConfig,
  type FactoryRuntimeConfig,
} from '../factory/config/factoryConfig';
import { openEventLog, type EventLog } from '../factory/events/log';
import { createEvidenceReadPort } from '../factory/observatory/observatory';
import { check } from '../factory/policy/policy';
import type { DAGProposalPayload } from '../factory/planning/dag';
import { reconcileAfterRestart } from '../factory/recovery/recovery';
import { createScheduler, type SchedulerPolicy } from '../factory/scheduler/scheduler';
import { createArtifactStore, openStateStore, type StateStore } from '../factory/state/store';
import type { WorkVerifier } from '../factory/verification/orchestrator';
import { createHerdrWorker } from '../factory/workers/herdr';
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
  return { text, runtime: resolveFactoryConfig(parsed.config, { baseDir: dir }) };
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
 * binding at assignment time. Path-level `repo.write` enforcement (the embedded
 * default's `infra&#47;**` exclusion applied to an actual change path) is **not
 * yet wired anywhere**: the assignment gate is today's only `repo.write` check,
 * and E6 gates only `branch.create`/`pr.create`. That write-time path-scoped
 * enforcer is pending and owned by E9.8 (#34). `ALLOW` assigns; a
 * `REQUIRE_HUMAN`/`DENY` verdict leaves the Task `READY` and is surfaced by the
 * scheduler's `blockedPolicy`.
 */
export function createSchedulerPolicy(deps: {
  store: StateStore;
  events: EventLog;
}): SchedulerPolicy {
  return {
    canAssign: (task, workOrder) =>
      check(deps, { taskId: task.id, workOrderId: workOrder.id }, {
        capability: 'repo.write',
        resource: { branch: taskWorktreeBranch(task.id, workOrder.id), path: '**' },
      }),
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
   * E9.4 verification seam. Production wires an E5-backed verifier here;
   * absent, the scheduler fails closed — a SUCCESS Task is never promoted
   * without a persisted Evidence Bundle.
   */
  verifier?: WorkVerifier;
  /**
   * E9.6 boot reconciliation. On a real server start this runs first (spec
   * §18.3), so a crash that left an in-flight Attempt behind is interrupted and
   * recovered before the scheduler loop begins. Defaults to `true`; tests that
   * build deps over pre-seeded state can opt out.
   */
  reconcileOnBoot?: boolean;
}

export function buildServerDeps(
  runtime: FactoryRuntimeConfig,
  options: ServerDepsOptions = {},
): FactoryServerDeps {
  ensureStorageDirs(runtime);
  const store = openStateStore(runtime.paths.db);
  const events = openEventLog(store.db);
  const workers = createWorkerManager({
    store,
    events,
    spawn: options.spawn ?? (() => createHerdrWorker()),
    ...(options.now ? { now: options.now } : {}),
  });
  const worktrees = createWorktreeManager({
    rootDir: runtime.worktrees.rootDir,
    baseBranch: runtime.worktrees.baseBranch,
  });
  const artifacts = createArtifactStore(runtime.paths.artifacts);
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
      policy: createSchedulerPolicy({ store, events }),
      ...(options.verifier ? { verifier: options.verifier } : {}),
    },
    {
      maxConcurrentTasks: runtime.scheduler.maxConcurrentTasks,
      tickIntervalMs: runtime.scheduler.tickIntervalMs,
      provisioning: {
        ...runtime.scheduler.provisioning,
        defaultProfile: runtime.scheduler.provisioning.defaultProfile as WorkerProfile,
      },
    },
  );
  return {
    store,
    events,
    evidence: createEvidenceReadPort(store),
    scheduler,
    version: runtime.factoryVersion,
    schemaVersion: runtime.schemaVersion,
  };
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

async function cmdServe(args: ParsedArgs, io: CliIO): Promise<number> {
  const dir = resolveDir(args, io);
  const loaded = loadConfig(dir, io);
  if (!loaded) return 1;
  const port = flag(args, 'port') !== undefined ? Number(flag(args, 'port')) : loaded.runtime.server.port;

  const deps = buildServerDeps(loaded.runtime);
  const handle = startFactoryServer(deps, { port });
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

  if (!hasFlag(args, 'detached')) {
    return cmdServe({ ...args, flags: withFlag(args, 'port', port) }, io);
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
  const child = Bun.spawn([process.execPath, cliFile, '__serve', '--dir', dir, '--port', port], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: process.env,
  });
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
  const client = createFactoryClient({ baseUrl: url, fetch: io.fetch });

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

async function cmdObservatory(args: ParsedArgs, io: CliIO): Promise<number> {
  const url = resolveUrl(args, io);
  if (!url) {
    io.err('no server URL; pass --url or start the server first');
    return 1;
  }
  const client = createFactoryClient({ baseUrl: url, fetch: io.fetch });
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
  const client = createFactoryClient({ baseUrl: url, fetch: io.fetch });

  if (sub === 'status') {
    io.out(JSON.stringify(await client.factoryControls()));
    return 0;
  }
  if (sub === 'pause' || sub === 'resume' || sub === 'emergency-stop') {
    const actor = flag(args, 'actor');
    if (!actor) {
      io.err(`usage: factory control ${sub} --actor <id> [--url <url>]`);
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
  const client = createFactoryClient({ baseUrl: url, fetch: io.fetch });

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
  '  wo answer <interactionId> <response> [--actor <id>]  answer a QUESTION',
  '  approvals list [--status <state>]      list policy approvals',
  '  approvals answer <approvalId> --decision APPROVAL|DENY --actor <id>  answer an approval',
  '  observatory [--url]                    read Observatory projections',
  '  control status [--url]                 read pause/e-stop controls',
  '  control <pause|resume|emergency-stop> --actor <id>  set a factory control',
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
