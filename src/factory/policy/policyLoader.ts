import { readFileSync } from 'node:fs';

import { FactoryError } from '../domain/errors';
import { findDuplicateYamlKeys, parseYamlText } from '../config/yaml';
import {
  CAPABILITIES,
  DEFAULT_POLICY_VERSION,
  type Capability,
  type CapabilityRule,
  type PolicyDocument,
  type PolicyLevel,
  type PolicyScope,
  type PolicyVerdict,
} from './policy';

/**
 * E11.4 (#41) — the `policy:` configuration surface (ADR 14 §11). A deployment
 * may configure the policy source of truth in `factory.yaml`: an inline
 * `policy:` document or a `policyFile:` reference to a separate YAML file. The
 * embedded `createDefaultPolicy()` remains the fail-closed default when the
 * section is absent; this module parses + validates a configured document into
 * E7's `PolicyDocument` shape and rejects **loudly** (an actionable issue list)
 * anything it cannot prove well-formed.
 *
 * Deliberately strict and boring: unknown capability ids, unknown decision
 * tokens, malformed scopes (including an empty `capabilities` mapping — nothing
 * to define is a typo, not a policy), unknown keys, and the `<embedded>` version
 * marker are all load failures — a misconfigured policy must never silently
 * degrade toward a permissive default (monotonic narrowing and the engine's
 * deployment-fixed ceilings stay authoritative regardless; a configured level
 * can only narrow — the fold enforces that at decision time).
 */

export interface PolicyParseIssue {
  /** Dotted path of the offending value (capability ids kept verbatim). */
  path: string;
  message: string;
}

export type PolicyParse =
  | { ok: true; policy: PolicyDocument }
  | { ok: false; issues: PolicyParseIssue[] };

/** The decision tokens a policy document may use (ADR 14 §11 shape; case-insensitive). */
const DECISION_BY_TOKEN: Record<string, PolicyVerdict> = {
  allow: 'ALLOW',
  deny: 'DENY',
  require_human: 'REQUIRE_HUMAN',
};

const DOCUMENT_KEYS = ['version', 'organization', 'projects'];
const LEVEL_KEYS = ['capabilities'];
const RULE_KEYS = ['decision', 'scope', 'ruleId'];
const SCOPE_KEYS = ['paths', 'excludePaths', 'branchPattern', 'env', 'dataClass'];
const ENVS = ['staging', 'production'];
const DATA_CLASSES = ['synthetic', 'customer-data'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

type IssueFn = (path: string, message: string) => void;

/** Nudge: the token→verdict map with a type-narrowed lookup (never `undefined`). */
type DecisionToken = keyof typeof DECISION_BY_TOKEN;

function isDecisionToken(token: string): token is DecisionToken {
  return token in DECISION_BY_TOKEN;
}

/**
 * Parse + validate a raw (already YAML-decoded) policy document. One pass:
 * each rule is validated and built together, so the built document is exactly
 * the validated shape (no re-derivation that could drift apart).
 */
export function parsePolicyDocument(raw: unknown): PolicyParse {
  const issues: PolicyParseIssue[] = [];
  const issue: IssueFn = (path, message) => {
    issues.push({ path, message });
  };
  const parseErr = (): PolicyParse => ({ ok: false, issues });

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ path: '', message: 'policy must be a mapping' }] };
  }
  const doc = raw as { [key: string]: unknown };

  for (const key of Object.keys(doc)) {
    if (!DOCUMENT_KEYS.includes(key)) {
      issue(key, `"${key}" is not a policy document key (use ${DOCUMENT_KEYS.join('/')})`);
    }
  }
  if (!isNonEmptyString(doc.version)) {
    issue('version', 'version is required (a non-empty policy version string, never the embedded marker)');
  } else if (doc.version === DEFAULT_POLICY_VERSION) {
    issue(
      'version',
      `"${DEFAULT_POLICY_VERSION}" is the embedded-default marker; a configured policy must stamp its own distinct version`,
    );
  }

  if (!isPlainObject(doc.organization)) {
    issue('organization', 'organization level is required');
  } else {
    validateLevel(doc.organization, 'organization', issue);
  }
  if (doc.projects !== undefined) {
    if (!isPlainObject(doc.projects)) {
      issue('projects', 'projects must be a mapping keyed by the Work Order repository name');
    } else {
      for (const [repository, level] of Object.entries(doc.projects)) {
        if (!isNonEmptyString(repository)) {
          issue('projects', 'every project key must be a non-empty repository name');
          continue;
        }
        validateLevel(level, `projects.${repository}`, issue);
      }
    }
  }

  if (issues.length > 0) return parseErr();

  const policy: PolicyDocument = {
    version: doc.version as string,
    organization: buildLevel(doc.organization as unknown),
  };
  if (doc.projects !== undefined) {
    const projects: PolicyDocument['projects'] = {};
    for (const [repository, level] of Object.entries(doc.projects as Record<string, unknown>)) {
      projects[repository] = buildLevel(level);
    }
    policy.projects = projects;
  }
  return { ok: true, policy };
}

function validateLevel(level: unknown, prefix: string, issue: IssueFn): void {  if (!isPlainObject(level)) {
    issue(prefix, 'a policy level must be a mapping');
    return;
  }
  for (const key of Object.keys(level)) {
    if (!LEVEL_KEYS.includes(key)) {
      issue(`${prefix}.${key}`, `"${key}" is not a policy level key (use capabilities; the engine's deployment-fixed ceilings are not configurable in v0.1)`);
    }
  }
  if (!isPlainObject(level.capabilities)) {
    issue(`${prefix}.capabilities`, 'capabilities is required (a mapping of capability id → rules)');
    return;
  }
  if (Object.keys(level.capabilities).length === 0) {
    issue(`${prefix}.capabilities`, 'capabilities must define at least one capability (an empty mapping defines nothing — omit the key, or a typo was meant here)');
    return;
  }
  for (const [capability, rawRules] of Object.entries(level.capabilities)) {
    if (!(CAPABILITIES as readonly string[]).includes(capability)) {
      issue(
        `${prefix}.capabilities.${capability}`,
        `"${capability}" is not a known capability (${CAPABILITIES.join(', ')})`,
      );
      continue;
    }
    const rules = Array.isArray(rawRules) ? rawRules : [rawRules];
    if (rules.length === 0) {
      issue(`${prefix}.capabilities.${capability}`, 'a rules entry must not be empty');
      continue;
    }
    rules.forEach((rule, index) => validateRule(rule, `${prefix}.capabilities.${capability}[${index}]`, issue));
  }
}

function validateScope(scope: unknown, base: string, issue: IssueFn): void {
  if (!isPlainObject(scope)) {
    issue(base, 'scope must be a mapping');
    return;
  }
  for (const key of Object.keys(scope)) {
    if (!SCOPE_KEYS.includes(key)) {
      issue(
        `${base}.${key}`,
        `"${key}" is not a scope qualifier (use paths/excludePaths/branchPattern/env/dataClass)`,
      );
    }
  }
  for (const key of ['paths', 'excludePaths'] as const) {
    if (scope[key] !== undefined && !isStringList(scope[key])) {
      issue(`${base}.${key}`, `${key} must be a non-empty list of non-empty path globs`);
    }
  }
  if (scope.branchPattern !== undefined && !isNonEmptyString(scope.branchPattern)) {
    issue(`${base}.branchPattern`, 'branchPattern must be a non-empty glob string');
  }
  if (scope.env !== undefined && !ENVS.includes(scope.env as string)) {
    issue(`${base}.env`, `env must be one of ${ENVS.join(' / ')}`);
  }
  if (scope.dataClass !== undefined && !DATA_CLASSES.includes(scope.dataClass as string)) {
    issue(`${base}.dataClass`, `dataClass must be one of ${DATA_CLASSES.join(' / ')}`);
  }
}

function validateRule(rule: unknown, base: string, issue: IssueFn): void {
  if (!isPlainObject(rule)) {
    issue(base, 'a policy rule must be a mapping');
    return;
  }
  for (const key of Object.keys(rule)) {
    if (!RULE_KEYS.includes(key)) {
      issue(`${base}.${key}`, `"${key}" is not a policy rule key (use decision/scope/ruleId)`);
    }
  }
  const rawDecision = rule.decision;
  if (typeof rawDecision !== 'string' || !isNonEmptyString(rawDecision)) {
    issue(`${base}.decision`, 'decision is required (allow / deny / require_human)');
  } else if (!isDecisionToken(rawDecision.trim().toLowerCase())) {
    issue(
      `${base}.decision`,
      `decision "${rawDecision}" is not a valid decision (use allow, deny or require_human)`,
    );
  }
  if (rule.ruleId !== undefined && !isNonEmptyString(rule.ruleId)) {
    issue(`${base}.ruleId`, 'ruleId must be a non-empty string when present');
  }
  if (rule.scope !== undefined) validateScope(rule.scope, `${base}.scope`, issue);
}

function buildRule(raw: unknown): CapabilityRule {
  const rule = raw as Record<string, unknown>;
  const token = (rule.decision as string).trim().toLowerCase();
  // The decision token is validated; the fallback keeps the build total (and
  // fail-closed) even if validate/build call order is ever refactored.
  const decision = isDecisionToken(token) ? DECISION_BY_TOKEN[token] : 'DENY';
  return {
    decision,
    ...('ruleId' in rule ? { ruleId: rule.ruleId as string } : {}),
    ...(rule.scope !== undefined ? { scope: rule.scope as PolicyScope } : {}),
  };
}

function buildLevel(raw: unknown): PolicyLevel {
  const level = raw as Record<string, unknown>;
  const capabilities: PolicyLevel['capabilities'] = {};
  for (const [capability, rawRules] of Object.entries(level.capabilities as Record<string, unknown>)) {
    const rules = Array.isArray(rawRules) ? rawRules : [rawRules];
    capabilities[capability as Capability] = rules.map(buildRule);
  }
  return { capabilities };
}

/**
 * Load and validate a policy document from a YAML file (the `policyFile:`
 * reference). Throws a loud {@link FactoryError} (`POLICY_INVALID`) naming the
 * file for an unreadable file, unparseable YAML, **duplicated keys** (Bun YAML
 * decodes a duplicate mapping key last-win — a written `deny` could silently
 * lose to a later `allow`), or a malformed document — so a deployment never
 * boots on an invalid policy.
 */
export function loadPolicyDocumentFile(path: string): PolicyDocument {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new FactoryError(
      'POLICY_INVALID',
      `policy file is unreadable: ${path} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const duplicates = findDuplicateYamlKeys(text);
  if (duplicates.length > 0) {
    throw new FactoryError(
      'POLICY_INVALID',
      `${path}: duplicate key(s) ${duplicates.map((duplicate) => `"${duplicate.path}"`).join(', ')} — YAML would silently keep the last value; list each key once`,
    );
  }
  const parsed = parseYamlText(text);
  if ('error' in parsed) {
    throw new FactoryError('POLICY_INVALID', `${path}: invalid YAML — ${parsed.error}`);
  }
  const validated = parsePolicyDocument(parsed.value);
  if (!validated.ok) {
    throw new FactoryError(
      'POLICY_INVALID',
      `${path}: invalid policy — ${validated.issues.map((issue) => `${issue.path || 'policy'}: ${issue.message}`).join('; ')}`,
    );
  }
  return validated.policy;
}
