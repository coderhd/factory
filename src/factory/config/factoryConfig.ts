import { join, resolve } from 'node:path';

import { CHECK_KINDS, type CheckCategory } from '../verification/engine';

/**
 * E2 desired → runtime configuration (spec §20). `factory.yaml` describes the
 * *desired* Factory deployment; this module validates it and resolves it into
 * the *runtime* configuration the server/compose runtime consumes. It is
 * deliberately not `compose.yaml` (spec §20): the deployment manager resolves
 * desired config into runtime config, and the compose file is one rendering.
 *
 * Boring by design: whole-value validation that collects every issue with a
 * stable dotted path, so `factory init`/`start` can reject malformed config
 * with actionable feedback instead of throwing.
 */

export const FACTORY_API_VERSION = 'factory/v0.1';
export const FACTORY_VERSION = '0.1.0';
export const FACTORY_SCHEMA_VERSION = '1';

/**
 * E10.1 (#39) production verification configuration (spec §9, §14). The desired
 * config names the independent semantic judge, the prompt/rubric provenance it
 * runs under, and the deterministic/behavioral command checks to register on
 * the E5 engine. It is optional: absent, the server wires no verifier and fails
 * closed exactly as before. Present, the production composition module turns it
 * into a live `WorkVerifier`.
 */
export interface VerificationCheckDesired {
  /** Stable verifier identity recorded on results and failures. */
  id: string;
  category: CheckCategory;
  kind: string;
  /** The command a check runs; pass/fail is derived from its exit code. */
  command: string;
}

export interface VerificationDesired {
  /** The judge identity — must differ from the writing model (writer ≠ verifier). */
  judge: { provider: string; model: string; family?: string; version?: string };
  prompt: { id: string; version: string };
  rubric: string[];
  checks: VerificationCheckDesired[];
}

export interface FactoryDesiredConfig {
  apiVersion: string;
  factoryVersion: string;
  server: {
    hostname: string;
    port: number;
    /**
     * E10.4 (#40) optional control-plane authentication: a shared bearer
     * credential and the operator identity it authenticates. Present, every
     * mutating route requires `Authorization: Bearer <token>` and human-action
     * actors come from `actor`. Absent, the trust boundary is the loopback
     * bind (a non-loopback bind is a config error).
     */
    auth?: { token: string; actor: string };
  };
  storage: { state: string; artifacts: string; knowledge: string };
  /** The local repository the Factory creates per-Task worktrees from (§15/§17). */
  repository: { path: string };
  scheduler: {
    maxConcurrentTasks: number;
    tickIntervalMs: number;
    provisioning: {
      enabled: boolean;
      min: number;
      max: number;
      idleTimeoutMs: number;
      defaultProfile: string;
    };
  };
  worktrees: { rootDir: string; baseBranch: string };
  workers: { profiles: string[] };
  /** Optional production verification surface (E10.1, #39); absent → fail closed. */
  verification?: VerificationDesired;
  image: { repository: string; tag: string };
  compose: {
    healthcheck: { intervalSeconds: number; timeoutSeconds: number; retries: number };
  };
}

export interface FactoryRuntimeConfig {
  apiVersion: string;
  factoryVersion: string;
  schemaVersion: string;
  server: { hostname: string; port: number; url: string; auth?: { token: string; actor: string } };
  paths: { root: string; state: string; artifacts: string; knowledge: string; db: string };
  repository: { path: string };
  scheduler: {
    maxConcurrentTasks: number;
    tickIntervalMs: number;
    provisioning: FactoryDesiredConfig['scheduler']['provisioning'];
  };
  worktrees: { rootDir: string; baseBranch: string };
  workers: { profiles: string[] };
  /** Optional production verification surface, carried through resolution. */
  verification?: VerificationDesired;
  image: { repository: string; tag: string; ref: string };
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ConfigParse =
  | { ok: true; config: FactoryDesiredConfig }
  | { ok: false; issues: ConfigIssue[] };

export const DEFAULT_FACTORY_CONFIG: FactoryDesiredConfig = {
  apiVersion: FACTORY_API_VERSION,
  factoryVersion: FACTORY_VERSION,
  server: { hostname: '127.0.0.1', port: 8787 },
  storage: {
    state: '.factory/state',
    artifacts: '.factory/artifacts',
    knowledge: '.factory/knowledge',
  },
  // The Factory's own checkout is the default worktree source; an operator
  // points this at the repository Work Orders execute against.
  repository: { path: '.' },
  scheduler: {
    maxConcurrentTasks: 3,
    tickIntervalMs: 1000,
    provisioning: {
      enabled: true,
      min: 0,
      max: 5,
      idleTimeoutMs: 600_000,
      defaultProfile: 'herdr',
    },
  },
  worktrees: { rootDir: '.factory/worktrees', baseBranch: 'main' },
  workers: { profiles: ['herdr'] },
  image: { repository: 'ghcr.io/coderhd/factory', tag: FACTORY_VERSION },
  compose: { healthcheck: { intervalSeconds: 10, timeoutSeconds: 5, retries: 3 } },
};

function parseYaml(text: string): { value: unknown } | { error: string } {
  try {
    const yaml = (Bun as unknown as { YAML: { parse(input: string): unknown } }).YAML;
    return { value: yaml.parse(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** The hostnames that may serve the control plane unauthenticated (§20). */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/** Validate a `factory.yaml` document; returns every issue with a dotted path. */
export function parseFactoryConfig(text: string): ConfigParse {
  const parsed = parseYaml(text);
  if ('error' in parsed) {
    return { ok: false, issues: [{ path: '', message: `invalid YAML: ${parsed.error}` }] };
  }
  const root = parsed.value;
  if (!isPlainObject(root)) {
    return { ok: false, issues: [{ path: '', message: 'factory.yaml must be a mapping' }] };
  }

  const issues: ConfigIssue[] = [];
  const issue = (path: string, message: string): void => {
    issues.push({ path, message });
  };

  if (root.apiVersion !== FACTORY_API_VERSION) {
    issue('apiVersion', `apiVersion must be "${FACTORY_API_VERSION}"`);
  }
  if (!isNonEmptyString(root.factoryVersion)) {
    issue('factoryVersion', 'factoryVersion is required');
  }

  if (!isPlainObject(root.server)) {
    issue('server', 'server is required');
  } else {
    if (!isNonEmptyString(root.server.hostname)) issue('server.hostname', 'hostname is required');
    if (!isPositiveInteger(root.server.port) || root.server.port > 65535) {
      issue('server.port', 'port must be an integer between 1 and 65535');
    }
    // E10.4 (#40): auth is optional for a loopback/dev bind, but a deployment
    // that exposes the control plane off-loopback must configure it — the
    // config *fails closed* instead of serving mutating routes unauthenticated.
    if (root.server.auth !== undefined) {
      if (!isPlainObject(root.server.auth)) {
        issue('server.auth', 'server.auth must be a mapping');
      } else {
        if (!isNonEmptyString(root.server.auth.token)) {
          issue('server.auth.token', 'token is required when auth is configured');
        } else if (root.server.auth.token.trim().length < 24) {
          issue(
            'server.auth.token',
            'token must be a high-entropy secret of at least 24 characters (never a passphrase)',
          );
        }
        if (!isNonEmptyString(root.server.auth.actor)) {
          issue(
            'server.auth.actor',
            'actor is required when auth is configured (the authenticated operator identity)',
          );
        }
      }
    } else if (typeof root.server.hostname === 'string' && !isLoopbackHostname(root.server.hostname)) {
      issue(
        'server.auth',
        'server.auth is required when binding a non-loopback hostname (the control plane must not be writable unauthenticated)',
      );
    }
  }

  if (!isPlainObject(root.storage)) {
    issue('storage', 'storage is required');
  } else {
    for (const key of ['state', 'artifacts', 'knowledge'] as const) {
      if (!isNonEmptyString(root.storage[key])) {
        issue(`storage.${key}`, `${key} storage path is required`);
      }
    }
  }

  if (!isPlainObject(root.repository)) {
    issue('repository', 'repository is required');
  } else if (!isNonEmptyString(root.repository.path)) {
    // The scheduler cannot create a worktree without a repo to create it from,
    // so a missing path is a hard, loud failure at config load.
    issue('repository.path', 'repository.path is required');
  }

  if (!isPlainObject(root.scheduler)) {
    issue('scheduler', 'scheduler is required');
  } else {
    if (!isPositiveInteger(root.scheduler.maxConcurrentTasks)) {
      issue('scheduler.maxConcurrentTasks', 'maxConcurrentTasks must be an integer >= 1');
    }
    if (!isPositiveInteger(root.scheduler.tickIntervalMs)) {
      issue('scheduler.tickIntervalMs', 'tickIntervalMs must be an integer >= 1');
    }
    if (!isPlainObject(root.scheduler.provisioning)) {
      issue('scheduler.provisioning', 'scheduler.provisioning is required');
    } else {
      const provisioning = root.scheduler.provisioning;
      if (typeof provisioning.enabled !== 'boolean') {
        issue('scheduler.provisioning.enabled', 'enabled must be a boolean');
      }
      if (!isNonNegativeInteger(provisioning.min)) {
        issue('scheduler.provisioning.min', 'min must be an integer >= 0');
      }
      if (!isPositiveInteger(provisioning.max)) {
        issue('scheduler.provisioning.max', 'max must be an integer >= 1');
      }
      if (
        isNonNegativeInteger(provisioning.min) &&
        isPositiveInteger(provisioning.max) &&
        provisioning.min > provisioning.max
      ) {
        issue('scheduler.provisioning.min', 'min must not exceed max');
      }
      if (!isPositiveInteger(provisioning.idleTimeoutMs)) {
        issue('scheduler.provisioning.idleTimeoutMs', 'idleTimeoutMs must be an integer >= 1');
      }
      if (!isNonEmptyString(provisioning.defaultProfile)) {
        issue('scheduler.provisioning.defaultProfile', 'defaultProfile is required');
      }
    }
  }

  if (!isPlainObject(root.worktrees)) {
    issue('worktrees', 'worktrees is required');
  } else {
    if (!isNonEmptyString(root.worktrees.rootDir)) {
      issue('worktrees.rootDir', 'worktrees.rootDir is required');
    }
    if (!isNonEmptyString(root.worktrees.baseBranch)) {
      issue('worktrees.baseBranch', 'worktrees.baseBranch is required');
    }
  }

  if (!isPlainObject(root.workers)) {
    issue('workers', 'workers is required');
  } else if (
    !Array.isArray(root.workers.profiles) ||
    root.workers.profiles.length === 0 ||
    root.workers.profiles.some((profile) => !isNonEmptyString(profile))
  ) {
    issue('workers.profiles', 'profiles must be a non-empty list of strings');
  }

  // E10.1 (#39): the optional verification section. Absent is valid (the server
  // wires no verifier and fails closed); present, every field must be well-formed
  // so production composition never runs a misconfigured judge or check.
  if (root.verification !== undefined) {
    if (!isPlainObject(root.verification)) {
      issue('verification', 'verification must be a mapping');
    } else {
      const verification = root.verification;
      if (!isPlainObject(verification.judge)) {
        issue('verification.judge', 'verification.judge is required');
      } else {
        if (!isNonEmptyString(verification.judge.provider)) {
          issue('verification.judge.provider', 'judge.provider is required');
        }
        if (!isNonEmptyString(verification.judge.model)) {
          issue('verification.judge.model', 'judge.model is required');
        }
        if (
          verification.judge.family !== undefined &&
          !isNonEmptyString(verification.judge.family)
        ) {
          issue('verification.judge.family', 'judge.family must be a non-empty string when present');
        }
        if (
          verification.judge.version !== undefined &&
          !isNonEmptyString(verification.judge.version)
        ) {
          issue('verification.judge.version', 'judge.version must be a non-empty string when present');
        }
      }
      if (!isPlainObject(verification.prompt)) {
        issue('verification.prompt', 'verification.prompt is required');
      } else {
        if (!isNonEmptyString(verification.prompt.id)) {
          issue('verification.prompt.id', 'prompt.id is required');
        }
        if (!isNonEmptyString(verification.prompt.version)) {
          issue('verification.prompt.version', 'prompt.version is required');
        }
      }
      if (
        !Array.isArray(verification.rubric) ||
        verification.rubric.length === 0 ||
        verification.rubric.some((item) => !isNonEmptyString(item))
      ) {
        issue('verification.rubric', 'rubric must be a non-empty list of strings');
      }
      if (!Array.isArray(verification.checks) || verification.checks.length === 0) {
        issue('verification.checks', 'verification.checks must be a non-empty list of command checks');
      } else {
        const seen = new Set<string>();
        verification.checks.forEach((raw, index) => {
          const base = `verification.checks[${index}]`;
          if (!isPlainObject(raw)) {
            issue(base, 'each check must be a mapping');
            return;
          }
          if (!isNonEmptyString(raw.id)) {
            issue(`${base}.id`, 'check.id is required');
          } else if (seen.has(raw.id)) {
            issue(`${base}.id`, `duplicate check id: ${raw.id}`);
          } else {
            seen.add(raw.id);
          }
          const category = raw.category;
          if (category !== 'deterministic' && category !== 'behavioral') {
            issue(`${base}.category`, 'category must be "deterministic" or "behavioral"');
          } else if (!isNonEmptyString(raw.kind) || !CHECK_KINDS[category].includes(raw.kind as never)) {
            issue(
              `${base}.kind`,
              `kind must be one of the ${category} checks (${CHECK_KINDS[category].join(', ')})`,
            );
          }
          if (!isNonEmptyString(raw.command)) {
            issue(`${base}.command`, 'check.command is required');
          }
        });
      }
    }
  }

  if (!isPlainObject(root.image)) {
    issue('image', 'image is required');
  } else {
    if (!isNonEmptyString(root.image.repository)) issue('image.repository', 'repository is required');
    if (!isNonEmptyString(root.image.tag)) {
      issue('image.tag', 'tag is required (explicit version, never latest)');
    } else if (root.image.tag.trim() === 'latest') {
      issue('image.tag', 'tag must be an explicit version, never "latest"');
    }
  }

  if (!isPlainObject(root.compose) || !isPlainObject(root.compose.healthcheck)) {
    issue('compose.healthcheck', 'compose.healthcheck is required');
  } else {
    for (const key of ['intervalSeconds', 'timeoutSeconds', 'retries'] as const) {
      if (!isPositiveInteger(root.compose.healthcheck[key])) {
        issue(`compose.healthcheck.${key}`, `${key} must be an integer >= 1`);
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config: root as unknown as FactoryDesiredConfig };
}

/** Resolve desired config into absolute runtime paths + a pinned image ref. */
export function resolveFactoryConfig(
  config: FactoryDesiredConfig,
  options: { baseDir?: string } = {},
): FactoryRuntimeConfig {
  const root = resolve(options.baseDir ?? process.cwd());
  const state = resolve(root, config.storage.state);
  return {
    apiVersion: config.apiVersion,
    factoryVersion: config.factoryVersion,
    schemaVersion: FACTORY_SCHEMA_VERSION,
    server: {
      hostname: config.server.hostname,
      port: config.server.port,
      url: `http://${config.server.hostname}:${config.server.port}`,
      ...(config.server.auth ? { auth: { ...config.server.auth } } : {}),
    },
    paths: {
      root,
      state,
      artifacts: resolve(root, config.storage.artifacts),
      knowledge: resolve(root, config.storage.knowledge),
      db: join(state, 'factory.db'),
    },
    repository: { path: resolve(root, config.repository.path) },
    scheduler: {
      maxConcurrentTasks: config.scheduler.maxConcurrentTasks,
      tickIntervalMs: config.scheduler.tickIntervalMs,
      provisioning: { ...config.scheduler.provisioning },
    },
    worktrees: {
      rootDir: resolve(root, config.worktrees.rootDir),
      baseBranch: config.worktrees.baseBranch,
    },
    workers: { profiles: [...config.workers.profiles] },
    ...(config.verification
      ? {
          verification: {
            judge: { ...config.verification.judge },
            prompt: { ...config.verification.prompt },
            rubric: [...config.verification.rubric],
            checks: config.verification.checks.map((check) => ({ ...check })),
          },
        }
      : {}),
    image: {
      repository: config.image.repository,
      tag: config.image.tag,
      ref: `${config.image.repository}:${config.image.tag}`,
    },
  };
}

/** Render a desired config as the canonical `factory.yaml` text `init` writes. */
export function serializeFactoryConfig(config: FactoryDesiredConfig): string {
  const lines = [
    `apiVersion: ${config.apiVersion}`,
    `factoryVersion: ${config.factoryVersion}`,
    'server:',
    `  hostname: ${config.server.hostname}`,
    `  port: ${config.server.port}`,
    // The token is emitted quoted so the YAML stays parseable for any secret
    // content; keep the secret itself out of version control (see compose.yaml).
    ...(config.server.auth
      ? [
          '  auth:',
          `    token: ${JSON.stringify(config.server.auth.token)}`,
          `    actor: ${JSON.stringify(config.server.auth.actor)}`,
        ]
      : []),
    'storage:',
    `  state: ${config.storage.state}`,
    `  artifacts: ${config.storage.artifacts}`,
    `  knowledge: ${config.storage.knowledge}`,
    'repository:',
    `  path: ${config.repository.path}`,
    'scheduler:',
    `  maxConcurrentTasks: ${config.scheduler.maxConcurrentTasks}`,
    `  tickIntervalMs: ${config.scheduler.tickIntervalMs}`,
    '  provisioning:',
    `    enabled: ${config.scheduler.provisioning.enabled}`,
    `    min: ${config.scheduler.provisioning.min}`,
    `    max: ${config.scheduler.provisioning.max}`,
    `    idleTimeoutMs: ${config.scheduler.provisioning.idleTimeoutMs}`,
    `    defaultProfile: ${config.scheduler.provisioning.defaultProfile}`,
    'worktrees:',
    `  rootDir: ${config.worktrees.rootDir}`,
    `  baseBranch: ${config.worktrees.baseBranch}`,
    'workers:',
    '  profiles:',
    ...config.workers.profiles.map((profile) => `    - ${profile}`),
    ...(config.verification
      ? [
          'verification:',
          '  judge:',
          `    provider: ${JSON.stringify(config.verification.judge.provider)}`,
          `    model: ${JSON.stringify(config.verification.judge.model)}`,
          ...(config.verification.judge.family
            ? [`    family: ${JSON.stringify(config.verification.judge.family)}`]
            : []),
          ...(config.verification.judge.version
            ? [`    version: ${JSON.stringify(config.verification.judge.version)}`]
            : []),
          '  prompt:',
          `    id: ${JSON.stringify(config.verification.prompt.id)}`,
          `    version: ${JSON.stringify(config.verification.prompt.version)}`,
          '  rubric:',
          // Rubric items and commands are arbitrary text (colons, quotes, `&&`),
          // so quote them as JSON scalars — a valid YAML double-quoted scalar —
          // rather than emit YAML that a `:` or `#` would break.
          ...config.verification.rubric.map((item) => `    - ${JSON.stringify(item)}`),
          '  checks:',
          ...config.verification.checks.flatMap((check) => [
            `    - id: ${JSON.stringify(check.id)}`,
            `      category: ${JSON.stringify(check.category)}`,
            `      kind: ${JSON.stringify(check.kind)}`,
            `      command: ${JSON.stringify(check.command)}`,
          ]),
        ]
      : []),
    'image:',
    `  repository: ${config.image.repository}`,
    `  tag: "${config.image.tag}"`,
    'compose:',
    '  healthcheck:',
    `    intervalSeconds: ${config.compose.healthcheck.intervalSeconds}`,
    `    timeoutSeconds: ${config.compose.healthcheck.timeoutSeconds}`,
    `    retries: ${config.compose.healthcheck.retries}`,
  ];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// compose.yaml structure validation (spec §20; no Docker daemon required)
// ---------------------------------------------------------------------------

export interface ComposeIssue {
  path: string;
  message: string;
}

export type ComposeValidation = { ok: true } | { ok: false; issues: ComposeIssue[] };

function isPinnedImage(image: string): boolean {
  if (image.includes('@sha256:')) return true;
  const lastColon = image.lastIndexOf(':');
  if (lastColon < 0) return false;
  const tag = image.slice(lastColon + 1);
  return tag.length > 0 && tag !== 'latest';
}

/**
 * Validate a `compose.yaml` structure: every service pins an explicit image
 * version (never `latest`), has a healthcheck, and references only top-level
 * declared named volumes. This is a structural check — tests never need Docker.
 */
export function validateCompose(text: string): ComposeValidation {
  const parsed = parseYaml(text);
  if ('error' in parsed) {
    return { ok: false, issues: [{ path: '', message: `invalid YAML: ${parsed.error}` }] };
  }
  const root = parsed.value;
  if (!isPlainObject(root) || !isPlainObject(root.services) || Object.keys(root.services).length === 0) {
    return { ok: false, issues: [{ path: 'services', message: 'compose must define at least one service' }] };
  }

  const issues: ComposeIssue[] = [];
  const declaredVolumes = isPlainObject(root.volumes) ? new Set(Object.keys(root.volumes)) : new Set<string>();

  for (const [name, rawService] of Object.entries(root.services)) {
    if (!isPlainObject(rawService)) {
      issues.push({ path: `services.${name}`, message: `service ${name} must be a mapping` });
      continue;
    }
    const image = rawService.image;
    if (!isNonEmptyString(image)) {
      issues.push({ path: `services.${name}.image`, message: `service ${name} requires an image` });
    } else if (!isPinnedImage(image)) {
      issues.push({
        path: `services.${name}.image`,
        message: `service ${name} image "${image}" must pin an explicit version (never latest)`,
      });
    }

    if (!isPlainObject(rawService.healthcheck) || rawService.healthcheck.test === undefined) {
      issues.push({
        path: `services.${name}.healthcheck`,
        message: `service ${name} requires a healthcheck`,
      });
    }

    if (Array.isArray(rawService.volumes)) {
      for (const entry of rawService.volumes) {
        if (typeof entry !== 'string') continue;
        const source = entry.split(':')[0];
        if (source.startsWith('.') || source.startsWith('/') || source.startsWith('~')) continue;
        if (!declaredVolumes.has(source)) {
          issues.push({
            path: `services.${name}.volumes`,
            message: `volume "${source}" is referenced but not declared under top-level volumes`,
          });
        }
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}
