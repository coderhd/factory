import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { parseFactoryConfig, resolveFactoryConfig } from '../config/factoryConfig';

/**
 * E2 Factory-level backup/restore (spec §20). A backup is a self-contained
 * `tar.gz` archive containing Factory state, evidence/artifacts, knowledge,
 * configuration and the Factory/schema versions, so a fresh machine can be
 * restored without Git (Git remains source of truth for source code).
 *
 * This is an operator/deployment artifact, not a Factory state mutation: the
 * running server owns execution state, while backup/restore read and
 * materialize files on disk. `restoreBackup` additionally lays the bundle out
 * as a bootable deployment (config at the root + storage under the configured
 * paths), so a fresh machine can `factory start` the restored instance. The
 * mechanism is real and testable on OS temp dirs; no Docker daemon is required.
 */

export const BACKUP_FORMAT = 'factory-backup/v1';

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  factoryVersion: string;
  schemaVersion: string;
  apiVersion: string;
  /** Relative paths of every file in the archive, including this manifest. */
  entries: string[];
}

export interface CreateBackupOptions {
  /** Live SQLite state database to snapshot (a consistent copy is taken). */
  stateDbPath: string;
  artifactsDir: string;
  knowledgeDir: string;
  configText: string;
  outFile: string;
  factoryVersion: string;
  schemaVersion: string;
  apiVersion?: string;
  now?: () => string;
}

export interface RestoreBackupOptions {
  archive: string;
  intoDir: string;
  /**
   * Allow restoring into a directory that already has contents. Without this
   * the restore refuses a non-empty target before touching disk, so a mistyped
   * `--into` cannot silently clobber a live install.
   */
  force?: boolean;
}

export interface RestoredBackup {
  intoDir: string;
  manifest: BackupManifest;
  configText: string;
  stateDbPath: string;
  artifactsDir: string;
  knowledgeDir: string;
}

function walkFiles(root: string, dir: string = root, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, path, acc);
    else acc.push(relative(root, path));
  }
  return acc;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** Every backup must carry these entries; a manifest claiming otherwise is rejected. */
const REQUIRED_ENTRIES = ['manifest.json', 'config/factory.yaml', 'state/factory.db'] as const;

/**
 * Read and validate `manifest.json` straight out of the archive (via
 * `tar -xOf`, which writes nothing to disk). Rejects a corrupt archive or a
 * wrong-format/incomplete manifest before any extraction happens.
 */
function peekManifest(archive: string): BackupManifest {
  let manifestText: string;
  try {
    manifestText = execFileSync('tar', ['-xOf', archive, 'manifest.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error(`backup archive is unreadable or corrupt: ${archive}`);
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestText) as BackupManifest;
  } catch {
    throw new Error(`backup archive has an invalid manifest: ${archive}`);
  }
  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error(
      `unsupported backup format: ${String(manifest.format)} (expected ${BACKUP_FORMAT})`,
    );
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error(`backup archive manifest is missing entries: ${archive}`);
  }
  for (const entry of REQUIRED_ENTRIES) {
    if (!manifest.entries.includes(entry)) {
      throw new Error(`backup archive is missing required entry: ${entry}`);
    }
  }
  return manifest;
}

/**
 * Snapshot state + artifacts + knowledge + config + versions into `outFile`.
 * The SQLite copy uses `VACUUM INTO`, which yields a consistent standalone
 * database even while the live server holds the source open (WAL included).
 */
export function createBackup(options: CreateBackupOptions): BackupManifest {
  const now = options.now ?? (() => new Date().toISOString());
  // Refuse to mint a backup from a state DB that does not exist: opening it
  // would create a zero-byte database and archive empty state, masking the
  // operator's mistake instead of reporting it.
  if (!existsSync(options.stateDbPath)) {
    throw new Error(
      `state database not found: ${options.stateDbPath}; run "factory init" or start the server first`,
    );
  }
  const staging = mkdtempSync(join(tmpdir(), 'factory-backup-'));
  try {
    mkdirSync(join(staging, 'config'), { recursive: true });
    mkdirSync(join(staging, 'state'), { recursive: true });
    writeFileSync(join(staging, 'config', 'factory.yaml'), options.configText);

    const snapshot = new Database(options.stateDbPath);
    try {
      snapshot.exec(`VACUUM INTO '${escapeSqlLiteral(join(staging, 'state', 'factory.db'))}'`);
    } finally {
      snapshot.close();
    }

    for (const [source, name] of [
      [options.artifactsDir, 'artifacts'],
      [options.knowledgeDir, 'knowledge'],
    ] as const) {
      if (!existsSync(source)) continue;
      const destination = join(staging, name);
      mkdirSync(destination, { recursive: true });
      cpSync(source, destination, { recursive: true });
    }

    const entries = ['manifest.json', ...walkFiles(staging).sort()];
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      createdAt: now(),
      factoryVersion: options.factoryVersion,
      schemaVersion: options.schemaVersion,
      apiVersion: options.apiVersion ?? 'factory/v0.1',
      entries,
    };
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const outFile = resolve(options.outFile);
    mkdirSync(dirname(outFile), { recursive: true });
    execFileSync('tar', ['-czf', outFile, '-C', staging, '.']);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Extract an archive onto a target directory and return its restored layout. */
export function restoreBackup(options: RestoreBackupOptions): RestoredBackup {
  if (!existsSync(options.archive)) {
    throw new Error(`backup archive not found: ${options.archive}`);
  }
  const archive = resolve(options.archive);
  const intoDir = resolve(options.intoDir);

  // Refuse to clobber a live install unless the operator opts in. This runs
  // before anything is written, so a mistyped `--into` is a no-op.
  if (!options.force && existsSync(intoDir) && readdirSync(intoDir).length > 0) {
    throw new Error(`restore target is not empty: ${intoDir}; pass --force to restore anyway`);
  }

  // Validate the archive (readable, right format, required entries) before
  // extracting, so a corrupt/wrong-format archive leaves nothing behind.
  const manifest = peekManifest(archive);

  // Unpack into a throwaway staging dir first, then materialize the deployment.
  // Nothing lands in `intoDir` until both gates above have passed.
  const staging = mkdtempSync(join(tmpdir(), 'factory-restore-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', staging]);
    const configText = readFileSync(join(staging, 'config', 'factory.yaml'), 'utf8');
    const paths = resolveRestoredPaths(intoDir, configText);

    // A restored backup must boot: write the config at the target root and the
    // state/artifacts/knowledge under the configured storage paths, so
    // `factory start --dir <intoDir>` starts the restored instance unchanged.
    mkdirSync(intoDir, { recursive: true });
    writeFileSync(join(intoDir, 'factory.yaml'), configText);
    copyIfExists(join(staging, 'manifest.json'), join(intoDir, 'manifest.json'));
    for (const [source, destination] of [
      [join(staging, 'state'), paths.state],
      [join(staging, 'artifacts'), paths.artifacts],
      [join(staging, 'knowledge'), paths.knowledge],
    ] as const) {
      copyIfExists(source, destination);
    }

    return {
      intoDir,
      manifest,
      configText,
      stateDbPath: paths.db,
      artifactsDir: paths.artifacts,
      knowledgeDir: paths.knowledge,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Resolve where a restored backup's storage lives relative to `intoDir`. */
function resolveRestoredPaths(
  intoDir: string,
  configText: string,
): { state: string; artifacts: string; knowledge: string; db: string } {
  const parsed = parseFactoryConfig(configText);
  if (!parsed.ok) {
    throw new Error('backup archive has an invalid config/factory.yaml');
  }
  const runtime = resolveFactoryConfig(parsed.config, { baseDir: intoDir });
  return {
    state: runtime.paths.state,
    artifacts: runtime.paths.artifacts,
    knowledge: runtime.paths.knowledge,
    db: runtime.paths.db,
  };
}

function copyIfExists(source: string, destination: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}
