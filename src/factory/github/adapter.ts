import type { FactoryClient } from '../api/client';
import type { WorkOrder } from '../domain/workOrder';
import type { EvidenceBundle } from '../evidence/bundle';

/**
 * E6.1 (#20) GitHub adapter: the import → Work Order → branch → PR-opening path
 * (spec §4.2 GitHub-only MVP; §28 ownership walkthrough).
 *
 * GitHub is the only external system in the MVP, and this module is the only
 * place in the Factory that talks to it. Everything GitHub-shaped arrives
 * through the injected {@link GitHubTransport} seam, so the provider is a
 * one-line swap and tests are hermetic (Ruling R6: mock the transport, no
 * network). The adapter never mutates Factory state directly: it reconciles and
 * creates Work Orders through the E2 API client, because the server is the sole
 * mutation authority (spec §29 invariants 1/12/13).
 *
 * The merge gate (`merge(gate)`: hygiene, no-self-merge, APPROVED + policy ALLOW)
 * is deliberately absent — that is epic #21, behind this same seam.
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

/**
 * The provider seam. The MVP ships exactly one GitHub transport; a future
 * provider implements this interface and nothing else in the path changes.
 * Implementations perform the actual GitHub I/O (REST/GraphQL/`gh`).
 */
export interface GitHubTransport {
  getIssue(ref: IssueRef): Promise<GitHubIssue>;
  createBranch(input: CreateBranchInput): Promise<GitHubBranch>;
  createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest>;
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
  head?: { ref?: unknown };
  base?: { ref?: unknown };
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

/**
 * The PR body links the Factory Work Order and the Evidence Bundle (spec §28:
 * the PR carries the receipt to the human gate). Links point at the E2 API:
 * the Work Order resource and the Observatory drill-down that surfaces the
 * change's verification/evidence stages.
 */
export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const { workOrder, evidence } = input;
  const base = input.factoryBaseUrl.replace(/\/+$/, '');
  const workOrderUrl = `${base}/api/work-orders/${workOrder.id}`;
  const evidenceUrl = `${base}/api/observatory/work-orders/${workOrder.id}/drill-down`;
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

export interface GitHubAdapterOptions {
  /** The only GitHub I/O in the Factory. */
  transport: GitHubTransport;
  /** The E2 client — the sole mutation authority for Factory state. */
  client: FactoryClient;
  /** Base URL used to build the PR body's Factory links. */
  factoryBaseUrl: string;
  /** Default PR base branch. Defaults to `main`. */
  baseBranch?: string;
  /** Branch naming policy. Defaults to `factory/<workOrderId>`. */
  branchName?: (workOrder: WorkOrder) => string;
}

export interface GitHubAdapter {
  /**
   * Fetch an issue and reconcile it to a Work Order through the E2 API.
   * Idempotent: re-importing the same issue returns the existing Work Order
   * (`created: false`) — intent, acceptance criteria and repository are
   * captured on first import.
   */
  importIssue(ref: IssueRef): Promise<ImportIssueResult>;
  /** Create the change-set branch for a Work Order. */
  createBranch(workOrder: WorkOrder, baseBranch?: string): Promise<GitHubBranch>;
  /**
   * Open a PR for the Work Order behind `evidence`, with the Work Order and
   * Evidence Bundle linked in the body.
   */
  openPR(
    evidence: EvidenceReceipt,
    options?: { baseBranch?: string; title?: string },
  ): Promise<GitHubPullRequest>;
}

export function createGitHubAdapter(options: GitHubAdapterOptions): GitHubAdapter {
  const { transport, client, factoryBaseUrl } = options;
  const baseBranch = options.baseBranch ?? 'main';
  const branchName = options.branchName ?? ((workOrder: WorkOrder) => `factory/${workOrder.id}`);

  function requireRepository(workOrder: WorkOrder): string {
    if (!workOrder.repository) {
      throw new Error(`work order ${workOrder.id} has no repository to open a PR against`);
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

  async function createBranch(
    workOrder: WorkOrder,
    base = baseBranch,
  ): Promise<GitHubBranch> {
    const repository = requireRepository(workOrder);
    return transport.createBranch({
      repository,
      branch: branchName(workOrder),
      baseBranch: base,
    });
  }

  async function openPR(
    evidence: EvidenceReceipt,
    openOptions: { baseBranch?: string; title?: string } = {},
  ): Promise<GitHubPullRequest> {
    const { workOrder } = await client.getWorkOrder(evidence.workOrderId);
    const repository = requireRepository(workOrder);

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

  return { importIssue, createBranch, openPR };
}
