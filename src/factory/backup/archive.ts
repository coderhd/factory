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

/**
 * E2 Factory-level backup/restore (spec §20). A backup is a self-contained
 * `tar.gz` archive containing Factory state, evidence/artifacts, knowledge,
 * configuration and the Factory/schema versions, so a fresh machine can be
 * restored without Git (Git remains source of truth for source code).
 *
 * This is an operator/deployment artifact, not a Factory state mutation: the
 * running server owns execution state, while backup/restore read and
 * materialize files on disk. The mechanism is real and testable on OS temp
 * dirs; no Docker daemon is required.
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

/**
 * Snapshot state + artifacts + knowledge + config + versions into `outFile`.
 * The SQLite copy uses `VACUUM INTO`, which yields a consistent standalone
 * database even while the live server holds the source open (WAL included).
 */
export function createBackup(options: CreateBackupOptions): BackupManifest {
  const now = options.now ?? (() => new Date().toISOString());
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

/** Extract an archive onto a fresh directory and return its restored layout. */
export function restoreBackup(options: RestoreBackupOptions): RestoredBackup {
  if (!existsSync(options.archive)) {
    throw new Error(`backup archive not found: ${options.archive}`);
  }
  const intoDir = resolve(options.intoDir);
  mkdirSync(intoDir, { recursive: true });
  execFileSync('tar', ['-xzf', resolve(options.archive), '-C', intoDir]);

  const manifest = JSON.parse(
    readFileSync(join(intoDir, 'manifest.json'), 'utf8'),
  ) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error(`unsupported backup format: ${String(manifest.format)}`);
  }

  return {
    intoDir,
    manifest,
    configText: readFileSync(join(intoDir, 'config', 'factory.yaml'), 'utf8'),
    stateDbPath: join(intoDir, 'state', 'factory.db'),
    artifactsDir: join(intoDir, 'artifacts'),
    knowledgeDir: join(intoDir, 'knowledge'),
  };
}
