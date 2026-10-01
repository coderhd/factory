import type { FactoryClient } from '../api/client';
import type { WorkOrder } from '../domain/workOrder';
import type { EvidenceBundle } from '../evidence/bundle';
import type { PolicyDecisionOutcome, PolicyResource, PolicyVerdict } from '../policy/policy';

/**
 * E6 GitHub adapter (spec §4.2 GitHub-only MVP; §28 ownership walkthrough).
 *
 * E6.1 (#20) built the import → Work Order → branch → PR-opening path. E6.2
 * (#21) adds the **merge gate** (`merge(gate)`): the Factory-authorized merge.
 * Every GitHub side effect is policy-gated at the Factory (E7 §8-1): branch
 * creation is a `branch.create` check, PR opening is a `pr.create` check, and
 * the merge is a `deploy.execute { env: production }` policy check (ADR 14 /
 * policy §8-3) that can only ever resolve to `ALLOW` by consuming an operator
 * `APPROVAL` through E7's ledger. While the Factory is emergency-stopped, E7's
 * stage-1 gate returns `DENY` for every one of these consequential external
 * actions, so a stopped Factory cannot mutate GitHub.
 *
 * The merge gate's additional gates, all checked before any GitHub merge I/O:
 *   - the Work Order is `APPROVED`,
 *   - the Evidence Bundle is read back from the **durable** `evidence_bundles`
 *     receipt by id (a fabricated in-memory bundle with no receipt is refused),
 *     and the PR links it (hygiene),
 *   - the PR is still open, targets the configured base, and is the Work Order's
 *     own change-set branch,
 *   - the actor is not the change's writer (no self-merge, spec §29 invariant 4),
 *   - the E7 policy check returns `ALLOW` **and** the consumed `APPROVAL` was
 *     authorized by the same actor performing the merge (the actor is bound to
 *     the human approval, not taken on the caller's word),
 *   - the merge is pinned to the PR head SHA read back here, so the commit that
 *     was verified is exactly the commit that is merged (no TOCTOU).
 *
 * GitHub is the only external system in the MVP, and this module is the only
 * place in the Factory that talks to it. Everything GitHub-shaped arrives
 * through the injected {@link GitHubTransport} seam, so the provider is a
 * one-line swap and tests are hermetic (Ruling R6: mock the transport, no
 * network). The adapter never mutates Factory state directly: it reconciles and
 * creates Work Orders through the E2 API client, and every external action
 * authorizes through the caller-wired E7 `check`, because the server is the sole
 * mutation authority (spec §29 invariants 1/12/13).
 */

/** A GitHub repository + issue number: the durable identity of an import. */
export interface IssueRef {
  /** `owner/name`. */
  repository: string;
  number: number;
}

/** The issue fields the adapter consumes (a project on the transport's DTO). */
export interface GitHubIssue extends IssueRef {
  title: string;
  body: string;
  labels: string[];
  url: string;
}

export interface GitHubBranch {
  repository: string;
  name: string;
  sha: string;
}

export interface GitHubPullRequest {
  repository: string;
  number: number;
  url: string;
  /** The head (change-set) branch. */
  head: string;
  /** The base branch the PR targets. */
  base: string;
}

/** A pull request's durable identity (repository + number). */
export interface PullRequestRef {
  repository: string;
  number: number;
}

/** The PR fields the merge gate's hygiene checks read back from GitHub. */
export interface GitHubPullRequestDetail extends GitHubPullRequest {
  /** The rendered PR body; must carry the Work Order + Evidence Bundle links. */
  body: string;
  /** The commit the PR head currently points at (the head-SHA pin input). */
  headSha: string;
  state: 'open' | 'closed';
  merged: boolean;
}

export interface CreateBranchInput {
  repository: string;
  branch: string;
  baseBranch: string;
}

export interface CreatePullRequestInput {
  repository: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface MergePullRequestInput {
  repository: string;
  number: number;
  /**
   * The PR head SHA the gate verified. GitHub rejects the merge if the head has
   * moved since, so verified-code ≠ merged-code is impossible (no TOCTOU).
   */
  sha?: string;
}

/** The result of a Factory-authorized merge. */
export interface GitHubMergeResult {
  repository: string;
  number: number;
  merged: boolean;
  sha: string;
  message: string;
}

/**
 * The provider seam. The MVP ships exactly one GitHub transport; a future
 * provider implements this interface and nothing else in the path changes.
 * Implementations perform the actual GitHub I/O (REST/GraphQL/`gh`).
 */
export interface GitHubTransport {
  getIssue(ref: IssueRef): Promise<GitHubIssue>;
  createBranch(input: CreateBranchInput): Promise<GitHubBranch>;
  createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest>;
  /** Read a PR back, for the merge gate's hygiene checks. */
  getPullRequest(ref: PullRequestRef): Promise<GitHubPullRequestDetail>;
  /** Merge a PR. Called only after the merge gate has authorized it. */
  mergePullRequest(input: MergePullRequestInput): Promise<GitHubMergeResult>;
}

/** A failed GitHub API call. Carries the HTTP status, never a bare throw. */
export class GitHubTransportError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubTransportError';
  }
}

export interface GitHubRestTransportOptions {
  /** GitHub token (fine-grained PAT / app installation token). */
  token: string;
  /** Defaults to the public GitHub REST API. */
  apiBaseUrl?: string;
  /** Defaults to `factory-github-adapter`. */
  userAgent?: string;
  /** Injectable transport for hermetic tests; defaults to global `fetch`. */
  fetch?: typeof fetch;
}

interface GitHubLabelDto {
  name?: unknown;
}

interface GitHubIssueDto {
  title?: unknown;
  body?: unknown;
  html_url?: unknown;
  labels?: unknown;
}

interface GitHubPrDto {
  number?: unknown;
  html_url?: unknown;
  head?: { ref?: unknown; sha?: unknown };
  base?: { ref?: unknown };
}

interface GitHubPrDetailDto extends GitHubPrDto {
  body?: unknown;
  state?: unknown;
  merged?: unknown;
}

interface GitHubMergeDto {
  sha?: unknown;
  merged?: unknown;
  message?: unknown;
}

function labelName(label: unknown): string | null {
  if (typeof label === 'string') return label;
  if (label && typeof label === 'object' && typeof (label as GitHubLabelDto).name === 'string') {
    return (label as GitHubLabelDto).name as string;
  }
  return null;
}

/**
 * The concrete MVP GitHub transport: a small REST client over the injected
 * `fetch` (global by default). This is the Factory's only outbound network
 * code; tests inject a fake `fetch` so nothing ever hits live GitHub (R6).
 */
export function createGitHubRestTransport(options: GitHubRestTransportOptions): GitHubTransport {
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const userAgent = options.userAgent ?? 'factory-github-adapter';

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': userAgent,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const detail = (payload as { message?: unknown } | null)?.message;
      throw new GitHubTransportError(
        response.status,
        method,
        path,
        `github ${method} ${path} failed: ${response.status} ${typeof detail === 'string' ? detail : ''}`.trim(),
      );
    }
    return payload as T;
  }

  return {
    async getIssue(ref: IssueRef): Promise<GitHubIssue> {
      const issue = await request<GitHubIssueDto>(
        'GET',
        `/repos/${ref.repository}/issues/${ref.number}`,
      );
      return {
        repository: ref.repository,
        number: ref.number,
        title: typeof issue.title === 'string' ? issue.title : '',
        body: typeof issue.body === 'string' ? issue.body : '',
        labels: Array.isArray(issue.labels)
          ? issue.labels.map(labelName).filter((name): name is string => name !== null)
          : [],
        url: typeof issue.html_url === 'string' ? issue.html_url : '',
      };
    },

    async createBranch(input: CreateBranchInput): Promise<GitHubBranch> {
      // Resolve the base branch's commit, then point a new ref at it.
      const base = await request<{ object?: { sha?: unknown } }>(
        'GET',
        `/repos/${input.repository}/git/ref/heads/${input.baseBranch}`,
      );
      const sha = typeof base.object?.sha === 'string' ? base.object.sha : '';
      await request('POST', `/repos/${input.repository}/git/refs`, {
        ref: `refs/heads/${input.branch}`,
        sha,
      });
      return { repository: input.repository, name: input.branch, sha };
    },

    async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
      const pr = await request<GitHubPrDto>('POST', `/repos/${input.repository}/pulls`, {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
      });
      return {
        repository: input.repository,
        number: typeof pr.number === 'number' ? pr.number : 0,
        url: typeof pr.html_url === 'string' ? pr.html_url : '',
        head: typeof pr.head?.ref === 'string' ? pr.head.ref : input.head,
        base: typeof pr.base?.ref === 'string' ? pr.base.ref : input.base,
      };
    },

    async getPullRequest(ref: PullRequestRef): Promise<GitHubPullRequestDetail> {
      const pr = await request<GitHubPrDetailDto>(
        'GET',
        `/repos/${ref.repository}/pulls/${ref.number}`,
      );
      return {
        repository: ref.repository,
        number: typeof pr.number === 'number' ? pr.number : ref.number,
        url: typeof pr.html_url === 'string' ? pr.html_url : '',
        head: typeof pr.head?.ref === 'string' ? pr.head.ref : '',
        headSha: typeof pr.head?.sha === 'string' ? pr.head.sha : '',
        base: typeof pr.base?.ref === 'string' ? pr.base.ref : '',
        body: typeof pr.body === 'string' ? pr.body : '',
        state: pr.state === 'closed' ? 'closed' : 'open',
        merged: pr.merged === true,
      };
    },

    async mergePullRequest(input: MergePullRequestInput): Promise<GitHubMergeResult> {
      const result = await request<GitHubMergeDto>(
        'PUT',
        `/repos/${input.repository}/pulls/${input.number}/merge`,
        // The head-SHA pin: GitHub refuses the merge if the head moved.
        input.sha === undefined ? undefined : { sha: input.sha },
      );
      return {
        repository: input.repository,
        number: input.number,
        merged: result.merged === true,
        sha: typeof result.sha === 'string' ? result.sha : '',
        message: typeof result.message === 'string' ? result.message : '',
      };
    },
  };
}

/**
 * Provenance marker embedded on a Work Order's constraints so a re-import of
 * the same issue reconciles to the same Work Order instead of duplicating it.
 * Deterministic and durable — no side map to lose across restarts.
 */
export const ISSUE_SOURCE_PREFIX = 'source:github/';

export function issueSourceRef(ref: IssueRef): string {
  return `${ISSUE_SOURCE_PREFIX}${ref.repository}#${ref.number}`;
}

/** Markdown task-list lines (`- [ ]` / `- [x]`) from an issue body become ACs. */
const TASK_ITEM = /^\s*(?:[-*]|\d+\.)\s+\[[ xX]\]\s+(.+?)\s*$/;

export function acceptanceCriteriaFromIssue(issue: GitHubIssue): string[] {
  return issue.body
    .split(/\r?\n/)
    .map((line) => TASK_ITEM.exec(line)?.[1])
    .filter((criterion): criterion is string => criterion !== undefined);
}

/**
 * The minimal Evidence Bundle receipt the PR body links. E5's immutable
 * `EvidenceBundle` satisfies it structurally; narrower than the full bundle so
 * the GitHub path never grows a dependency on verification internals.
 */
export type EvidenceReceipt = Pick<EvidenceBundle, 'id' | 'workOrderId' | 'complete' | 'gates'>;

export interface PullRequestBodyInput {
  workOrder: WorkOrder;
  evidence: EvidenceReceipt;
  factoryBaseUrl: string;
}

function gateLabel(passed: boolean): string {
  return passed ? 'PASS' : 'FAIL';
}

/** The PR body links the Factory Work Order (spec §28). */
export function workOrderLinkUrl(factoryBaseUrl: string, workOrderId: string): string {
  return `${factoryBaseUrl.replace(/\/+$/, '')}/api/work-orders/${workOrderId}`;
}

/** The Observatory drill-down that surfaces the change's evidence (spec §28). */
export function evidenceLinkUrl(factoryBaseUrl: string, workOrderId: string): string {
  return `${factoryBaseUrl.replace(/\/+$/, '')}/api/observatory/work-orders/${workOrderId}/drill-down`;
}

/**
 * The PR body links the Factory Work Order and the Evidence Bundle (spec §28:
 * the PR carries the receipt to the human gate). Links point at the E2 API:
 * the Work Order resource and the Observatory drill-down that surfaces the
 * change's verification/evidence stages.
 */
export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const { workOrder, evidence } = input;
  const workOrderUrl = workOrderLinkUrl(input.factoryBaseUrl, workOrder.id);
  const evidenceUrl = evidenceLinkUrl(input.factoryBaseUrl, workOrder.id);
  const gates = evidence.gates;

  return [
    '## Factory change set',
    '',
    'Opened by the Factory GitHub adapter from a reconciled Work Order.',
    '',
    `- Work Order: [${workOrder.id}](${workOrderUrl})`,
    `- Evidence Bundle: [${evidence.id}](${evidenceUrl})`,
    `- Verification gates: deterministic: ${gateLabel(gates.deterministic)} · behavioral: ${gateLabel(
      gates.behavioral,
    )} · semantic: ${gateLabel(gates.semantic)} · run: ${gateLabel(gates.run)}`,
    `- Evidence complete: ${evidence.complete}`,
    '',
  ].join('\n');
}

export interface ImportIssueResult {
  workOrder: WorkOrder;
  /** `true` when this import created the Work Order; `false` on a reconcile. */
  created: boolean;
}

// ---------------------------------------------------------------------------
// E6.2 merge gate: APPROVED + policy ALLOW + hygiene + no self-merge
// ---------------------------------------------------------------------------

/**
 * The E7 policy port the GitHub path consumes (deps-first `checkDetailed(subject,
 * action)` wired by the caller: `(subject, action) => checkDetailed({ store,
 * events }, subject, action)`). It returns the verdict **plus** how it was
 * resolved (`resolvedBy`), the consumed approval instance (`spentApprovalId`)
 * and the human who authorized it (`approvalActor`) — so the merge gate can bind
 * the `ALLOW` to the operator whose `APPROVAL` produced it instead of trusting a
 * caller-supplied actor. The merge requires `ALLOW` for
 * `deploy.execute { env: production }` — the only §13.2 capability that covers a
 * production merge (ADR 14 / policy §8-3) — which for every risk tier floors at
 * `REQUIRE_HUMAN` and so is reachable only by consuming an operator `APPROVAL`.
 * Branch/PR creation consume it too: `branch.create` / `pr.create` (§8-1). The
 * port fails closed when absent.
 */
export type PolicyCheck = (
  subject: { taskId: string | null; workOrderId: string },
  action: { capability: string; resource?: PolicyResource },
) => PolicyDecisionOutcome;

/** Thrown when a non-merge GitHub side effect is refused by policy (§8-1/§10). */
export class PolicyBlockedError extends Error {
  constructor(
    readonly capability: string,
    readonly verdict: PolicyVerdict | 'NO_POLICY',
  ) {
    super(
      verdict === 'NO_POLICY'
        ? `github action blocked: no policy check is configured for ${capability}`
        : `github action blocked: policy verdict ${verdict} for ${capability}`,
    );
    this.name = 'PolicyBlockedError';
  }
}

/** The Evidence Bundle receipt + model provenance the merge gate consumes. */
export type MergeEvidence = Pick<
  EvidenceBundle,
  'id' | 'workOrderId' | 'complete' | 'gates' | 'provenance'
>;

/**
 * The durable Evidence Bundle read-back port. The merge gate **looks the bundle
 * up by id** here (production: the store's `evidence_bundles` rows) and refuses
 * a caller-supplied bundle that has no durable receipt — the persisted receipt
 * is the source of truth (spec §28; E9.4 persists it). Absent the port, the
 * merge fails closed: an in-memory claim can never authorize a merge.
 */
export type EvidenceReader = (bundleId: string) => EvidenceBundle | null;

/** The inputs to `merge(gate)`: the promotion authorization. */
export interface MergeGate {
  /** The Work Order being promoted; must be `APPROVED` (spec §5.1). */
  workOrderId: string;
  /** The PR to merge. */
  pullRequest: PullRequestRef;
  /**
   * The promotion-grade Evidence Bundle receipt the PR links. Only its `id` is
   * trusted as a pointer: the merge re-reads the bundle from the durable
   * `evidence_bundles` receipt (`readEvidence`) — an in-memory bundle with no
   * persisted receipt cannot authorize a merge.
   */
  evidence: MergeEvidence;
  /**
   * The operator identity approving and performing the merge (the Promoter).
   * Must differ from the change's writer (spec §29 invariant 4).
   */
  actor: string;
}

/** The outcome of an authorized merge: the GitHub result + the MERGED Work Order. */
export interface MergeOutcome {
  merge: GitHubMergeResult;
  /** The Work Order after the Factory-owned `APPROVED → MERGED` transition. */
  workOrder: WorkOrder;
}

/** Why the merge gate refused to merge. */
export type MergeBlockReason =
  | 'WORK_ORDER_NOT_APPROVED'
  | 'EVIDENCE_NOT_PERSISTED'
  | 'EVIDENCE_INCOMPLETE'
  | 'EVIDENCE_MISMATCH'
  | 'SELF_MERGE'
  | 'HYGIENE_FAILED'
  | 'EVIDENCE_LINK_MISSING'
  | 'POLICY_NOT_ALLOWED'
  | 'APPROVAL_ACTOR_MISMATCH';

/** A refused merge. `reason` is a closed code; the message is human-facing. */
export class MergeBlockedError extends Error {
  constructor(
    readonly reason: MergeBlockReason,
    message: string,
  ) {
    super(message);
    this.name = 'MergeBlockedError';
  }
}

export interface GitHubAdapterOptions {
  /** The only GitHub I/O in the Factory. */
  transport: GitHubTransport;
  /** The E2 client — the sole mutation authority for Factory state. */
  client: FactoryClient;
  /** Base URL used to build the PR body's Factory links. */
  factoryBaseUrl: string;
  /** Default PR base branch. Defaults to `main`. */
  baseBranch?: string;
  /**
   * Branch naming policy. Defaults to `wo-<workOrderId>/task-<workOrderIdShort>`.
   *
   * This is **namespace-consistent** with the E3 worktree branch and the E7
   * embedded `branch.create`/`repo.write` scope (`wo-*&#47;**`): all three share
   * the `wo-<workOrderId>/task-<…>` prefix the Factory is authorized to write.
   * The **leaf differs**, intentionally: this PR branch is keyed on the Work Order
   * (one PR per Work Order, **aggregating** its Tasks), whereas
   * `taskWorktreeBranch(taskId, workOrderId)` keys the E3 worktree leaf on the
   * Task (`task-<taskId8>`). #37 resolved this as the aggregation model (not
   * per-task alignment): a multi-Task Work Order's PR cannot equal any single
   * Task's leaf, so the two are kept namespace-consistent while the PR leaf keys
   * the aggregate. `tests/factory/e10-integration.test.ts` asserts the namespace
   * consistency and that the live policy authorizes both shapes.
   */
  branchName?: (workOrder: WorkOrder) => string;
  /**
   * The E7 policy gate every GitHub side-effect authorizes through
   * (`branch.create`, `pr.create`, `deploy.execute { env: production }`).
   * Required by the adapter; every path fails closed when it is absent.
   */
  checkPolicy?: PolicyCheck;
  /**
   * The durable Evidence Bundle read-back (the merge gate's source of truth).
   * Required for a merge; absent, the merge fails closed — an in-memory bundle
   * can never authorize a production merge.
   */
  readEvidence?: EvidenceReader;
}

export interface GitHubAdapter {
  /**
   * Fetch an issue and reconcile it to a Work Order through the E2 API.
   * Idempotent: re-importing the same issue returns the existing Work Order
   * (`created: false`) — intent, acceptance criteria and repository are
   * captured on first import.
   */
  importIssue(ref: IssueRef): Promise<ImportIssueResult>;
  /**
   * Create the change-set branch for a Work Order after a `branch.create` policy
   * check (fails closed via {@link PolicyBlockedError} on no port / non-ALLOW).
   */
  createBranch(workOrder: WorkOrder, baseBranch?: string): Promise<GitHubBranch>;
  /**
   * Open a PR for the Work Order behind `evidence`, with the Work Order and
   * Evidence Bundle linked in the body, after a `pr.create` policy check (fails
   * closed via {@link PolicyBlockedError} on no port / non-ALLOW).
   */
  openPR(
    evidence: EvidenceReceipt,
    options?: { baseBranch?: string; title?: string },
  ): Promise<GitHubPullRequest>;
  /**
   * Merge the PR behind `gate` — the Factory-authorized production deployment.
   * Fails closed (throws {@link MergeBlockedError}) unless the Work Order is
   * APPROVED, the Evidence Bundle **has a durable receipt** that is complete and
   * linked, hygiene passes, the actor is not the writer, E7's
   * `deploy.execute { env: production }` check returns ALLOW resolved by an
   * operator APPROVAL, and `gate.actor` is the human that authorized that
   * APPROVAL. The merge is pinned to the PR head SHA read back here. On success,
   * records the Factory-owned `APPROVED → MERGED` transition.
   */
  merge(gate: MergeGate): Promise<MergeOutcome>;
}

export function createGitHubAdapter(options: GitHubAdapterOptions): GitHubAdapter {
  const { transport, client, factoryBaseUrl, checkPolicy, readEvidence } = options;
  const baseBranch = options.baseBranch ?? 'main';
  // The Work Order's change-set branch. Shares the E3 `wo-<workOrderId>/task-<…>`
  // namespace (and so the embedded policy scope); the leaf is keyed on the Work
  // Order because E6 opens one PR per Work Order, not per Task.
  const branchName =
    options.branchName ??
    ((workOrder: WorkOrder) => `wo-${workOrder.id}/task-${workOrder.id.slice(0, 8)}`);

  function requireRepository(workOrder: WorkOrder): string {
    if (!workOrder.repository) {
      throw new Error(`work order ${workOrder.id} has no repository`);
    }
    return workOrder.repository;
  }

  async function importIssue(ref: IssueRef): Promise<ImportIssueResult> {
    const issue = await transport.getIssue(ref);
    const marker = issueSourceRef(issue);

    const existing = (await client.listWorkOrders()).find(
      (workOrder) =>
        workOrder.repository === issue.repository && workOrder.constraints.includes(marker),
    );
    if (existing) return { workOrder: existing, created: false };

    const workOrder = await client.submitWorkOrder({
      intent: issue.title,
      acceptanceCriteria: acceptanceCriteriaFromIssue(issue),
      repository: issue.repository,
      constraints: [marker],
    });
    return { workOrder, created: true };
  }

  /** Authorize a non-merge GitHub side effect; fail closed on no port / non-ALLOW. */
  function requirePolicy(
    capability: 'branch.create' | 'pr.create',
    workOrderId: string,
    resource?: PolicyResource,
  ): PolicyDecisionOutcome {
    if (!checkPolicy) throw new PolicyBlockedError(capability, 'NO_POLICY');
    const result = checkPolicy({ taskId: null, workOrderId }, { capability, resource });
    if (result.verdict !== 'ALLOW') throw new PolicyBlockedError(capability, result.verdict);
    return result;
  }

  async function createBranch(
    workOrder: WorkOrder,
    base = baseBranch,
  ): Promise<GitHubBranch> {
    const repository = requireRepository(workOrder);
    const branch = branchName(workOrder);
    // E7 §8-1: branch creation is a consequential external side effect; the
    // Factory authorizes it (and blocks it under e-stop) before any GitHub I/O.
    // The default `branch.create` scope binds `branchPattern: wo-*/**` and E6's
    // branch is `factory/<wo>`; a deployment narrows/grant that pattern when it
    // wants E6 branches authorized (v0.1 default policy denies an unbound or
    // out-of-pattern ref, per §4 "resolves DENY via the scope").
    requirePolicy('branch.create', workOrder.id, { branch });
    return transport.createBranch({
      repository,
      branch,
      baseBranch: base,
    });
  }

  async function openPR(
    evidence: EvidenceReceipt,
    openOptions: { baseBranch?: string; title?: string } = {},
  ): Promise<GitHubPullRequest> {
    const { workOrder } = await client.getWorkOrder(evidence.workOrderId);
    const repository = requireRepository(workOrder);
    // E7 §8-1: opening a PR is a `pr.create` check before any GitHub I/O.
    requirePolicy('pr.create', workOrder.id, { branch: branchName(workOrder) });

    return transport.createPullRequest({
      repository,
      title: openOptions.title ?? workOrder.intent,
      body: buildPullRequestBody({
        workOrder,
        evidence,
        factoryBaseUrl,
      }),
      head: branchName(workOrder),
      base: openOptions.baseBranch ?? baseBranch,
    });
  }

  /**
   * The Factory-authorized merge (E6.2, #21). Ordered fail-closed: every static
   * gate (APPROVED, evidence, self-merge, PR hygiene) is checked *before* the
   * E7 policy `check` so a rejected merge never consumes the operator's
   * `APPROVAL`; the policy check is the last gate before GitHub I/O.
   */
  async function merge(gate: MergeGate): Promise<MergeOutcome> {
    // 1. The human gate must have passed (spec §5.1, §29 invariant 20/21).
    const { workOrder } = await client.getWorkOrder(gate.workOrderId);
    if (workOrder.state !== 'APPROVED') {
      throw new MergeBlockedError(
        'WORK_ORDER_NOT_APPROVED',
        `merge blocked: work order ${workOrder.id} is ${workOrder.state}, not APPROVED`,
      );
    }

    // 2. The change must be promotion-grade, and the receipt must be durable:
    // the bundle is looked up by id from the persisted `evidence_bundles` — an
    // in-memory bundle the caller fabricated has no receipt and cannot authorize
    // a merge. The caller's claim is only a *pointer* (its id); the durable row
    // is the source of truth (spec §28; E9.4 persists it).
    const claim = gate.evidence;
    if (!readEvidence) {
      throw new MergeBlockedError(
        'EVIDENCE_NOT_PERSISTED',
        'merge blocked: no durable Evidence Bundle reader is configured; an in-memory bundle cannot authorize a merge',
      );
    }
    const evidence = readEvidence(claim.id);
    if (!evidence) {
      throw new MergeBlockedError(
        'EVIDENCE_NOT_PERSISTED',
        `merge blocked: Evidence Bundle ${claim.id} has no durable receipt in evidence_bundles`,
      );
    }
    if (evidence.workOrderId !== workOrder.id) {
      throw new MergeBlockedError(
        'EVIDENCE_MISMATCH',
        `merge blocked: evidence bundle ${evidence.id} is for work order ${evidence.workOrderId}, not ${workOrder.id}`,
      );
    }
    if (!evidence.complete) {
      throw new MergeBlockedError(
        'EVIDENCE_INCOMPLETE',
        `merge blocked: evidence bundle ${evidence.id} is not complete`,
      );
    }

    // 3. No self-merge (spec §29 invariant 4: Writer ≠ Verifier ≠ Promoter). The
    // writer identity is the bundle's generator (`provider/model`, E5 attestation).
    const writer = `${evidence.provenance.generator.provider}/${evidence.provenance.generator.model}`;
    if (gate.actor === writer) {
      throw new MergeBlockedError(
        'SELF_MERGE',
        `merge blocked: actor "${gate.actor}" is the change's writer; writer may not approve or merge its own work`,
      );
    }

    // 4. Hygiene: the live PR must be this Work Order's open, unmerged change set
    // targeting the configured base and carrying the Work Order + Evidence links.
    const repository = requireRepository(workOrder);
    if (gate.pullRequest.repository !== repository) {
      throw new MergeBlockedError(
        'HYGIENE_FAILED',
        `merge blocked: pull request is for ${gate.pullRequest.repository}, not ${repository}`,
      );
    }
    const pullRequest = await transport.getPullRequest({
      repository,
      number: gate.pullRequest.number,
    });
    if (pullRequest.merged || pullRequest.state !== 'open') {
      throw new MergeBlockedError(
        'HYGIENE_FAILED',
        `merge blocked: pull request ${repository}#${gate.pullRequest.number} is already merged or closed`,
      );
    }
    if (pullRequest.head !== branchName(workOrder)) {
      throw new MergeBlockedError(
        'HYGIENE_FAILED',
        `merge blocked: pull request head "${pullRequest.head}" is not the Work Order branch "${branchName(workOrder)}"`,
      );
    }
    if (pullRequest.base !== baseBranch) {
      throw new MergeBlockedError(
        'HYGIENE_FAILED',
        `merge blocked: pull request base "${pullRequest.base}" is not "${baseBranch}"`,
      );
    }
    // The head-SHA pin: the gate merges exactly the commit it verified. Without a
    // head SHA there is nothing to pin, so the merge fails closed rather than
    // merging whatever the branch happens to point at.
    if (!pullRequest.headSha) {
      throw new MergeBlockedError(
        'HYGIENE_FAILED',
        `merge blocked: pull request ${repository}#${pullRequest.number} has no head SHA to pin`,
      );
    }
    const expectedEvidenceLink = `[${evidence.id}](${evidenceLinkUrl(factoryBaseUrl, workOrder.id)})`;
    const expectedWorkOrderLink = `[${workOrder.id}](${workOrderLinkUrl(factoryBaseUrl, workOrder.id)})`;
    if (!pullRequest.body.includes(expectedEvidenceLink)) {
      throw new MergeBlockedError(
        'EVIDENCE_LINK_MISSING',
        `merge blocked: pull request ${pullRequest.number} does not link Evidence Bundle ${evidence.id}`,
      );
    }
    if (!pullRequest.body.includes(expectedWorkOrderLink)) {
      throw new MergeBlockedError(
        'EVIDENCE_LINK_MISSING',
        `merge blocked: pull request ${pullRequest.number} does not link Work Order ${workOrder.id}`,
      );
    }

    // 5. Policy ALLOW for the production merge (ADR 14 / policy §8-3). This is
    // the only gate with a side effect (consuming the operator APPROVAL), so it
    // runs after every static gate. Absent port ⇒ fail closed. The ALLOW must be
    // resolved by a human approval, and that approval must have been authorized
    // by the very actor performing the merge — `gate.actor` is a claim, not
    // evidence, so it is bound here to the consumed `APPROVAL`'s response actor.
    if (!checkPolicy) {
      throw new MergeBlockedError(
        'POLICY_NOT_ALLOWED',
        'merge blocked: no policy check is configured for the production merge',
      );
    }
    const policy = checkPolicy(
      { taskId: null, workOrderId: workOrder.id },
      { capability: 'deploy.execute', resource: { env: 'production' } },
    );
    if (policy.verdict !== 'ALLOW') {
      throw new MergeBlockedError(
        'POLICY_NOT_ALLOWED',
        `merge blocked: policy verdict ${policy.verdict} for deploy.execute { env: production }`,
      );
    }
    if (policy.resolvedBy !== 'human-approval' || !policy.spentApprovalId) {
      throw new MergeBlockedError(
        'POLICY_NOT_ALLOWED',
        `merge blocked: policy ALLOW for deploy.execute { env: production } was not authorized by an operator APPROVAL (resolvedBy ${policy.resolvedBy})`,
      );
    }
    if (policy.approvalActor !== gate.actor) {
      throw new MergeBlockedError(
        'APPROVAL_ACTOR_MISMATCH',
        `merge blocked: actor "${gate.actor}" did not authorize the consumed APPROVAL (authorized by "${policy.approvalActor}")`,
      );
    }

    // 6. Merged on GitHub (pinned to the verified head SHA), then the
    // Factory-owned APPROVED → MERGED transition.
    const merged = await transport.mergePullRequest({
      repository,
      number: pullRequest.number,
      sha: pullRequest.headSha,
    });
    const transitioned = await client.transitionWorkOrder(workOrder.id, {
      to: 'MERGED',
      reason: `merged ${repository}#${pullRequest.number} under policy ALLOW`,
    });
    return { merge: merged, workOrder: transitioned };
  }

  return { importIssue, createBranch, openPR, merge };
}
