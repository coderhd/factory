import { join, resolve } from 'node:path';

import { CHECK_KINDS, type CheckCategory } from '../verification/engine';
import { loadPolicyDocumentFile, parsePolicyDocument } from '../policy/policyLoader';
import type { PolicyDocument, PolicyLevel, PolicyScope } from '../policy/policy';

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
  /**
   * The judge identity — must differ from the writing model (writer ≠ verifier).
   * `harness` names the coding-agent harness the judge's fresh pane runs
   * (E11.2, #42); it defaults to `opencode` at resolve time.
   */
  judge: { provider: string; model: string; family?: string; version?: string; harness?: string };
  prompt: { id: string; version: string };
  rubric: string[];
  checks: VerificationCheckDesired[];
}

/**
 * E11.3 (#43) outbound GitHub configuration. The file carries a **reference**
 * to the token — an environment-variable name — never the token itself, so no
 * secret is ever persisted or logged (spec §20, §28). The token's value is read
 * from the environment only at serve time and consumed by the transport.
 */
export interface GitHubDesiredConfig {
  /** `owner/name` the Factory imports issues from and opens change sets on. */
  repository: string;
  /** The token as an `{ env: VARIABLE_NAME }` reference; a raw token is refused. */
  token: { env: string };
  /** GitHub (Enterprise) REST API base; defaults to the public GitHub REST API. */
  apiBaseUrl?: string;
  /** The default base branch a Factory change-set PR targets. Defaults to `main`. */
  baseBranch?: string;
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
  /**
   * E11.1 (#44) worker runtime configuration. `profiles` stays the E11 baseline
   * (`herdr`); `harness` names the coding-agent harness a tab runs
   * (`opencode`), `workspaceLabel` the dedicated herdr workspace the Factory
   * owns ("factory", never the user's focused panes), and `models` maps E9.3's
   * generic capability ids to concrete harness models.
   */
  workers: {
    profiles: string[];
    harness?: string;
    workspaceLabel?: string;
    models?: Record<string, string>;
  };
  /** Optional production verification surface (E10.1, #39); absent → fail closed. */
  verification?: VerificationDesired;
  /** Optional outbound GitHub config (E11.3, #43); absent → no adapter, routes 404. */
  github?: GitHubDesiredConfig;
  /**
   * E11.4 (#41): the policy source of truth (ADR 14 §11 shape), validated into
   * E7's `PolicyDocument`. Present, it is the deployment's override of the
   * embedded defaults and lands via `buildServerDeps` in the scheduler
   * (`canAssign`), the write-time `repoWriteGate`, and every `check`/`checkDe-
   * tailed` call the server composes. Absent, the embedded default stays
   * authoritative — fail closed, unchanged.
   */
  policy?: PolicyDocument;
  /**
   * E11.4 (#41): a referenced policy file, resolved against the config
   * directory at resolve time. Parse stays fs-free: the reference is validated
   * here, the file's *content* at resolve (both loudly, fail closed).
   */
  policyFile?: string;
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
  /** E11.1 (#44): worker runtime config, resolved (harness/label defaulted). */
  workers: {
    profiles: string[];
    harness: string;
    workspaceLabel: string;
    models: Record<string, string>;
  };
  /** Optional production verification surface, carried through resolution. */
  verification?: VerificationDesired;
  /**
   * The resolved GitHub config (E11.3, #43). Only the token's env **name** is
   * carried — never the token's value — so a persisted runtime file or a log
   * line can never expose the secret. `apiBaseUrl` is carried as configured;
   * the transport defaults it to the public GitHub REST API (the literal stays
   * only in the adapter module).
   */
  github?: { repository: string; tokenEnv: string; apiBaseUrl?: string; baseBranch: string };
  /** E11.4 (#41): the loaded policy document; absent when no `policy:` source is configured. */
  policy?: PolicyDocument;
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
  workers: {
    profiles: ['herdr'],
    harness: 'opencode',
    workspaceLabel: 'factory',
    models: {},
  },
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

/**
 * The hostnames that may serve the control plane unauthenticated (§20).
 * Exported for the serve path's effective-bind re-check (E10.4, #40): config
 * validation sees only the YAML hostname, `--hostname` can widen the bind.
 */
export function isLoopbackHostname(hostname: string): boolean {
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
  } else {
    // E11.1 (#44): the optional worker-runtime fields. Absent ones default at
    // resolve time (`opencode` / `factory`); present ones must be well-formed
    // so an adapter is never composed from a typo'd harness or model map.
    if (root.workers.harness !== undefined && !isNonEmptyString(root.workers.harness)) {
      issue('workers.harness', 'harness must be a non-empty string when present');
    }
    if (root.workers.workspaceLabel !== undefined && !isNonEmptyString(root.workers.workspaceLabel)) {
      issue('workers.workspaceLabel', 'workspaceLabel must be a non-empty string when present');
    }
    if (root.workers.models !== undefined) {
      if (!isPlainObject(root.workers.models)) {
        issue('workers.models', 'models must be a mapping of capability id → concrete model');
      } else {
        for (const [capability, model] of Object.entries(root.workers.models)) {
          if (!isNonEmptyString(model)) {
            issue(`workers.models.${capability}`, 'each model must be a non-empty string');
          }
        }
      }
    }
  }

  // E11.4 (#41): the optional policy source of truth (ADR 14 §11). Absent, the
  // embedded defaults stay authoritative — fail closed, unchanged. Present, the
  // document must be well-formed: an invalid policy is rejected loudly here
  // (never silently degraded toward a permissive default). An inline `policy:`
  // and a `policyFile:` reference are mutually exclusive; a referenced file's
  // *content* is validated at resolve time (parse is fs-free), still loudly,
  // before anything boots.
  if (root.policy !== undefined || root.policyFile !== undefined) {
    if (root.policy !== undefined && root.policyFile !== undefined) {
      issue('policy', 'set either an inline policy or a policyFile reference, never both');
    } else if (root.policy !== undefined) {
      const parsedPolicy = parsePolicyDocument(root.policy);
      if (!parsedPolicy.ok) {
        for (const policyIssue of parsedPolicy.issues) {
          issue(
            policyIssue.path ? `policy.${policyIssue.path}` : 'policy',
            policyIssue.message,
          );
        }
      }
    } else if (!isNonEmptyString(root.policyFile)) {
      issue('policyFile', 'policyFile must be a non-empty path string when configured');
    }
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
        // E11.2 (#42): the judge's harness kind. Absent it defaults to `opencode`
        // at resolve time; present it must be a real harness name.
        if (verification.judge.harness !== undefined && !isNonEmptyString(verification.judge.harness)) {
          issue('verification.judge.harness', 'judge.harness must be a non-empty string when present');
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

  // E11.3 (#43): the optional outbound `github:` section. Absent is valid (no
  // adapter is composed and the GitHub routes 404 — fail closed); present, the
  // token must be an env-var *reference* — a raw token in the file is refused.
  if (root.github !== undefined) {
    if (!isPlainObject(root.github)) {
      issue('github', 'github must be a mapping');
    } else {
      const github = root.github;
      if (
        !isNonEmptyString(github.repository) ||
        !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(github.repository.trim())
      ) {
        issue('github.repository', 'repository must be "owner/name"');
      }
      if (typeof github.token === 'string') {
        issue(
          'github.token',
          'token must be an { env: VARIABLE_NAME } reference — never a raw token in the file',
        );
      } else if (!isPlainObject(github.token)) {
        issue('github.token', 'token must be a mapping with an env reference (e.g. env: GITHUB_TOKEN)');
      } else if (
        !isNonEmptyString(github.token.env) ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(github.token.env)
      ) {
        issue('github.token.env', 'token.env must name an environment variable (never the token itself)');
      }
      if (
        github.apiBaseUrl !== undefined &&
        (!isNonEmptyString(github.apiBaseUrl) || !/^https?:\/\//.test(github.apiBaseUrl))
      ) {
        issue('github.apiBaseUrl', 'apiBaseUrl must be an http(s) URL when present');
      }
      if (github.baseBranch !== undefined && !isNonEmptyString(github.baseBranch)) {
        issue('github.baseBranch', 'baseBranch must be a non-empty string when present');
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
  // E11.4 (#41): resolve the policy source of truth. An inline document is
  // deep-copied (the runtime config is its own copy); a `policyFile:` reference
  // is read + validated here — an unreadable file or an invalid document throws
  // a loud `FactoryError` (fail closed), never a permissive fallback.
  const policy = config.policy
    ? (JSON.parse(JSON.stringify(config.policy)) as PolicyDocument)
    : config.policyFile
      ? loadPolicyDocumentFile(resolve(root, config.policyFile))
      : undefined;
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
    workers: {
      profiles: [...config.workers.profiles],
      harness: config.workers.harness ?? 'opencode',
      workspaceLabel: config.workers.workspaceLabel ?? 'factory',
      models: { ...(config.workers.models ?? {}) },
    },
    ...(config.verification
      ? {
          verification: {
            judge: {
              ...config.verification.judge,
              // E11.2 (#42): the judge's harness kind, defaulted to `opencode`.
              harness: config.verification.judge.harness ?? 'opencode',
            },
            prompt: { ...config.verification.prompt },
            rubric: [...config.verification.rubric],
            checks: config.verification.checks.map((check) => ({ ...check })),
          },
        }
      : {}),
    ...(config.github
      ? {
          github: {
            repository: config.github.repository.trim(),
            // Only the env var *name* is carried; the value is read from the
            // environment at serve time and never logged or persisted (#43).
            tokenEnv: config.github.token.env,
            apiBaseUrl: config.github.apiBaseUrl,
            // Trimmed like `repository` (and like the route trims caller
            // input), so stray whitespace can't silently block the configured
            // PR base during the policy gate.
            baseBranch: (config.github.baseBranch ?? 'main').trim(),
          },
        }
      : {}),
    ...(policy ? { policy } : {}),
    image: {
      repository: config.image.repository,
      tag: config.image.tag,
      ref: `${config.image.repository}:${config.image.tag}`,
    },
  };
}

const policyQuoted = (value: string): string => JSON.stringify(value);

function serializePolicyScope(indent: string, scope: PolicyScope): string[] {
  const lines = [`${indent}scope:`];
  for (const key of ['paths', 'excludePaths'] as const) {
    if (scope[key] !== undefined) {
      lines.push(`${indent}  ${key}:`);
      for (const pattern of scope[key]!) lines.push(`${indent}    - ${policyQuoted(pattern)}`);
    }
  }
  if (scope.branchPattern !== undefined) lines.push(`${indent}  branchPattern: ${policyQuoted(scope.branchPattern)}`);
  if (scope.env !== undefined) lines.push(`${indent}  env: ${policyQuoted(scope.env)}`);
  if (scope.dataClass !== undefined) lines.push(`${indent}  dataClass: ${policyQuoted(scope.dataClass)}`);
  return lines;
}

function serializePolicyLevel(key: string, indent: string, level: PolicyLevel): string[] {
  const lines = [`${indent}${key}:`, `${indent}  capabilities:`];
  for (const [capability, rules] of Object.entries(level.capabilities)) {
    if (!rules || rules.length === 0) continue;
    lines.push(`${indent}    ${policyQuoted(capability)}:`);
    for (const rule of rules) {
      lines.push(`${indent}      - decision: ${policyQuoted(rule.decision)}`);
      if (rule.ruleId !== undefined) lines.push(`${indent}        ruleId: ${policyQuoted(rule.ruleId)}`);
      if (rule.scope !== undefined) lines.push(...serializePolicyScope(`${indent}        `, rule.scope));
    }
  }
  return lines;
}

/**
 * The optional `policy:` section (E11.4, #41; ADR 14 §11) — an inline validated
 * `PolicyDocument` or a `policyFile:` reference. Absent, nothing is emitted
 * (the embedded default stays authoritative). Strings are emitted quoted (JSON
 * scalars are YAML scalars) so capability ids, globs and rule ids containing
 * `:`/`#` cannot break the document.
 */
function serializePolicySection(config: FactoryDesiredConfig): string[] {
  if (config.policyFile !== undefined) return [`policyFile: ${policyQuoted(config.policyFile)}`];
  const policy = config.policy;
  if (!policy) return [];
  const lines = ['policy:', `  version: ${policyQuoted(policy.version)}`];
  lines.push(...serializePolicyLevel('organization', '  ', policy.organization));
  if (policy.projects !== undefined) {
    lines.push('  projects:');
    for (const [repository, level] of Object.entries(policy.projects)) {
      lines.push(...serializePolicyLevel(repository, '    ', level));
    }
  }
  return lines;
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
    // E11.1 (#44): the worker runtime section. `models` maps E9.3's generic
    // capability ids (implementer, explorer, …) to the concrete harness models.
    `  harness: ${JSON.stringify(config.workers.harness ?? 'opencode')}`,
    `  workspaceLabel: ${JSON.stringify(config.workers.workspaceLabel ?? 'factory')}`,
    ...(config.workers.models && Object.keys(config.workers.models).length > 0
      ? [
          '  models:',
          ...Object.entries(config.workers.models).map(
            ([capability, model]) => `    ${JSON.stringify(capability)}: ${JSON.stringify(model)}`,
          ),
        ]
      : []),
    // E11.3 (#43): only the token's env *name* is written — never the token.
    ...(config.github
      ? [
          'github:',
          `  repository: ${JSON.stringify(config.github.repository)}`,
          '  token:',
          `    env: ${JSON.stringify(config.github.token.env)}`,
          ...(config.github.apiBaseUrl
            ? [`  apiBaseUrl: ${JSON.stringify(config.github.apiBaseUrl)}`]
            : []),
          ...(config.github.baseBranch
            ? [`  baseBranch: ${JSON.stringify(config.github.baseBranch)}`]
            : []),
        ]
      : []),
    // E11.4 (#41): the optional policy source of truth rides here, before the
    // verification section.
    ...serializePolicySection(config),
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
          ...(config.verification.judge.harness !== undefined
            ? [`    harness: ${JSON.stringify(config.verification.judge.harness)}`]
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
