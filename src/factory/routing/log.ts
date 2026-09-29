import type { RoutingDecisionRecord } from './decisionModel';

/**
 * `routing.log` line format (E4.2; design spec §8, s1s2 routing design §6).
 *
 * One routing decision per line, as a single compact JSON object with a fixed
 * key order, so lines are byte-stable, greppable, and parseable without a
 * schema registry. The key set and order are the `RoutingDecisionRecord`
 * interface fields, declared in `decisionModel.ts` and documented in
 * `factory-docs/architecture/routing-decision-log.md`. Hosts append the line
 * (plus a trailing newline) wherever they keep their routing log — the dev
 * environment uses `.factory/routing.log`; the Factory runtime keeps the file
 * location outside this module (no I/O here).
 */

/**
 * Format one decision record as its `routing.log` line (no trailing newline).
 * Pure and deterministic: the same record always produces the same bytes,
 * independent of the field insertion order of the object it was handed.
 */
export function formatRoutingLogLine(record: RoutingDecisionRecord): string {
  const {
    id,
    workOrderId,
    taskId,
    source,
    task,
    complexity,
    risk,
    context,
    selected,
    candidates,
    reason,
    unavailable,
    budget,
    createdAt,
  } = record;
  return JSON.stringify({
    id,
    workOrderId,
    taskId,
    source,
    task,
    complexity,
    risk,
    context,
    selected,
    candidates,
    reason,
    unavailable,
    budget: {
      monthlyRemaining: budget.monthlyRemaining,
      weeklyRemaining: budget.weeklyRemaining,
      fiveHourRemaining: budget.fiveHourRemaining,
    },
    createdAt,
  });
}
