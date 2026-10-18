import {
  issueSourceRef,
  type GitHubAdapter,
  type GitHubReadyIssue,
} from './adapter';
import type { WorkOrder } from '../domain/workOrder';
import type { StateStore } from '../state/store';

/**
 * E12 (#48): the GitHub "ready ticket" poller (spec §4.2/§28; operating-guide
 * §7 "check for ready tickets and claim work").
 *
 * The manual `/api/github/import` route imports **one** issue on operator
 * demand. This poller is the auto-claim the operators expect: on every
 * interval it lists the open issues carrying a configured label and imports
 * each through the **same** path the route uses —
 * `GitHubAdapter.importIssue` — so a ready ticket becomes a Factory Work Order
 * with no new mutation authority (the server stays the sole writer; spec §22).
 *
 * There is no separate "claim" transition in the codebase: `importIssue` *is*
 * the claim. It reconciles on the Work Order's durable provenance marker
 * (`source:github/<repo>#<num>`, `issueSourceRef`) and is therefore idempotent
 * — a second sighting returns the existing Work Order (`created: false`) rather
 * than duplicating it. The poller's dedupe is the same identity read back from
 * the store, so an already-imported ticket is skipped before any GitHub I/O.
 *
 * Error isolation: a listing or import failure is caught, reported through
 * `onError`, and never thrown out of `tick()`; the poller stays usable for the
 * next interval. The GitHub token is never logged (transport errors carry a
 * method, path and status only).
 */

export interface ReadyTicketPoller {
  /** Begin polling at `intervalMs`. Idempotent: a second call is a no-op. */
  start(): void;
  /** Stop polling. Idempotent: a call after stop is a no-op. */
  stop(): void;
  /** Run one poll now; returns how many tickets were imported vs skipped. */
  tick(): Promise<{ imported: number; skipped: number }>;
}

export interface ReadyTicketPollerOptions {
  /** The E6 adapter — the same import path the manual `/api/github/import` route uses. */
  adapter: GitHubAdapter;
  /** Durable Factory state, read (never written) to dedupe already-imported issues. */
  store: StateStore;
  /** The GitHub label that marks a ticket ready for the Factory. */
  label: string;
  /** Poll cadence, in milliseconds. */
  intervalMs: number;
  /**
   * Dedupe seam. Defaults to the Work Order provenance marker the import path
   * itself writes (`issueSourceRef`), read from `store`. Override to dedupe on
   * a different identity.
   */
  alreadyImported?(issue: GitHubReadyIssue): boolean;
  /**
   * Error sink for a failed tick. Defaults to a redacted `console.error` so a
   * failure is never silently swallowed. The GitHub token is never included.
   */
  onError?(error: unknown): void;
}

/** The Work Order provenance marker for a ready issue, as the import path writes it. */
function isAlreadyImported(store: StateStore, issue: GitHubReadyIssue): boolean {
  const marker = issueSourceRef(issue);
  return store
    .list<WorkOrder>('work_orders')
    .some(
      (workOrder) => workOrder.repository === issue.repository && workOrder.constraints.includes(marker),
    );
}

export function createReadyTicketPoller(options: ReadyTicketPollerOptions): ReadyTicketPoller {
  const alreadyImported =
    options.alreadyImported ?? ((issue: GitHubReadyIssue) => isAlreadyImported(options.store, issue));
  const onError =
    options.onError ??
    ((error: unknown): void => {
      // Redacted: the transport error text names method/path/status, never the token.
      console.error(
        `github ready-ticket poller: tick failed (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    });

  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;
    try {
      const issues = await options.adapter.listIssuesByLabel(options.label);
      for (const issue of issues) {
        if (alreadyImported(issue)) {
          skipped += 1;
          continue;
        }
        // The exact import+claim path the manual route uses. `importIssue` is
        // idempotent on the `source:github/<repo>#<num>` marker, so a race (a
        // ticket imported between the check above and here) reconciles instead
        // of duplicating — it just reports as skipped, not imported.
        const result = await options.adapter.importIssue({
          repository: issue.repository,
          number: issue.number,
        });
        if (result.created) imported += 1;
        else skipped += 1;
      }
    } catch (error) {
      // Nothing escapes a tick: report the honest partial counts and stay usable.
      onError(error);
    }
    return { imported, skipped };
  }

  function start(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      void tick();
    }, options.intervalMs);
  }

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick };
}
