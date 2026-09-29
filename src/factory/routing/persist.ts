import type { EventLog } from '../events/log';
import type { StateStore } from '../state/store';
import type { RoutingDecisionRecord } from './decisionModel';

/**
 * Concrete routing-decision persistence for the Factory runtime (E4.2;
 * design spec §8 "Routing recommendations are recorded"; controller ruling
 * R11). This is the writer E4.1 deliberately left out: it stores the full
 * provenance record in E1's `routing_decisions` collection and appends its
 * event in one transaction, mirroring E1's `createWorkOrder` discipline.
 */

/** Event type for a persisted routing decision (append-only log). */
export const ROUTING_DECISION_RECORDED = 'routing.decision_recorded';

/** The E1 deps-first shape (ruling R9): authoritative state + event log. */
export interface RoutingDeps {
  store: StateStore;
  events: EventLog;
}

/**
 * Persist one `RoutingDecisionRecord`: state row + event, atomically. A
 * failure while appending the event rolls the row back, so the store and the
 * log can never disagree about which decisions were recorded. Returns the
 * stored record. The `routing.log` line for the same record is produced by
 * `formatRoutingLogLine` in `./log` — the durable store stays the source of
 * truth and the text log is a rendering of it.
 */
export function persistRoutingDecision(
  deps: RoutingDeps,
  record: RoutingDecisionRecord,
): RoutingDecisionRecord {
  deps.store.db.transaction(() => {
    deps.store.set('routing_decisions', record.id, record);
    deps.events.appendEvent({
      type: ROUTING_DECISION_RECORDED,
      aggregateType: 'routing_decision',
      aggregateId: record.id,
      payload: { record },
    });
  })();
  return record;
}
