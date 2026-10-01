# Policy configuration surface (E11.4, #41)

ADR 14 §11 sketches a versioned YAML policy source of truth. This implements the
v0.1 loader: a `policy:` section in `factory.yaml` (inline) or a `policyFile:`
reference (resolved against the config directory) is parsed and validated into
E7's `PolicyDocument` (`src/factory/policy/policy.ts`) by
`src/factory/policy/policyLoader.ts`, then carried on the resolved runtime config
into `buildServerDeps` (`src/cli/factory.ts`).

## What it changes

- **Configured:** the loaded document is the deployment's policy. It is passed to
  `createSchedulerPolicy` (the assignment gate `canAssign` and the write-time
  `repoWriteGate`/`canWriteChangeSet`) and to the E6 GitHub adapter's
  `checkDetailed` gate. Because `check`/`checkDetailed` read `deps.policy`, every
  durable decision from the server composes through it.
- **Absent:** the embedded default (`createDefaultPolicy()`, version
  `<embedded>`) stays authoritative — byte-identical to pre-loader behavior.
  This is the fail-closed default, unchanged.

## Fail closed

An invalid policy never silently falls back to a permissive one:

- inline `policy:` — rejected loudly at parse (`parseFactoryConfig` collects
  dotted-path issues; `factory init`/`start`/`serve` refuse to load);
- `policyFile:` — the *reference* is validated at parse (fs-free); the file's
  *content* is read + validated at resolve (`loadPolicyDocumentFile`), throwing
  `FactoryError('POLICY_INVALID')` for an unreadable file, bad YAML, or a
  malformed document. `loadConfig` prints one actionable line and exits 1.

Loudly rejected: unknown capability ids (against the
`CAPABILITIES` allowlist), unknown decision tokens (must be
`allow|deny|require_human`, case-insensitive), malformed scopes (unknown
qualifiers; `paths`/`excludePaths` must be non-empty glob lists; `branchPattern`
a non-empty glob; `env` ∈ `staging|production`; `dataClass` ∈
`synthetic|customer-data`), unknown keys at any level, a version stamp equal to
the reserved `<embedded>` marker, and setting an inline policy together with a
`policyFile`.

## Invariants (unchanged, enforced at decision time)

- Monotonic narrowing: the engine's Org → Project → WO → Task fold means a child
  level can never widen a parent; the loaded policy feeds the same fold.
- Deployment-fixed ceilings (production.write/secrets.read, customer-data
  production reads, production deploys) are engine-owned and not configurable in
  v0.1 (an over-ceiling expression is coerced to the ceiling and marked
  `ceiling-violation`); a level key `ceilings` in the YAML is rejected as an
  unknown key. Risk tiers still start Yellow, Green is earned, Red/high risk
  never auto-promote.

## Serialization / round trip

`serializeFactoryConfig` emits the section (quoted scalars) and
`parse → resolve → serialize → parse` is stable, so `factory init` rewriting a
configured `factory.yaml` preserves the policy document.

See ADR 14 (`factory-docs/architecture/policy-and-risk-model.md` §11) for the
normative shape sketch, and §7 for the worked narrowing examples the loaded
levels plug into.
