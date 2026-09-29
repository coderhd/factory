import type { Complexity, ModelId } from './decisionModel';

/**
 * Ticket-time routing provenance fields (E4.2; s1s2 routing design §4
 * "Admission: ticket-time classification"; the ticket body field template in
 * `docs/agents/issue-tracker.md`).
 *
 * The planner proposes these on every ticket; the rules engine cross-checks
 * them and flags disagreements with `disputed` for the human at ticket
 * review. This module defines the field set and validates it, so a ticket
 * that claims routing provenance actually carries a complete, well-formed
 * one. The validator is pure — parsing a ticket body into this shape is the
 * tracker integration's job, not the routing core's.
 */

/** The complete, valid ticket routing block. */
export interface TicketRoutingFields {
  /** Capability vocabulary from the routing seam (decisionModel.ts). */
  complexity: Complexity;
  /** Opaque, deployment-defined model identifier (ADR 13). */
  model: ModelId;
  /** Admission confidence, normalized fraction 0..1 (inclusive). */
  confidence: number;
  /** Set when rules and the admission classifier disagreed; human decides. */
  disputed: boolean;
  /** Version stamp of the router that produced the decision, e.g. `s1s2-2026-09-29`. */
  'router-version': string;
}

/** Validation outcome: `errors` names each offending field; empty means valid. */
export interface TicketFieldsResult {
  ok: boolean;
  errors: string[];
}

/** Field names as written in the tracker template, for tooling and docs. */
export const TICKET_ROUTING_FIELD_NAMES = [
  'complexity',
  'model',
  'confidence',
  'disputed',
  'router-version',
] as const satisfies readonly (keyof TicketRoutingFields)[];

const COMPLEXITY_VALUES: readonly Complexity[] = ['trivial', 'simple', 'normal', 'complex'];

/**
 * Validate a candidate ticket routing block. Accepts unknown input (ticket
 * bodies parse to `unknown`): reports every offending field with a
 * field-prefixed message instead of throwing on the first one.
 */
export function validateTicketRoutingFields(raw: unknown): TicketFieldsResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['ticket: expected an object of ticket routing fields'] };
  }
  const value = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (!COMPLEXITY_VALUES.includes(value.complexity as Complexity)) {
    errors.push(
      `complexity: expected one of ${COMPLEXITY_VALUES.join(', ')}; got ${JSON.stringify(value.complexity)}`,
    );
  }
  if (typeof value.model !== 'string' || value.model.trim() === '') {
    errors.push(`model: expected a non-empty model id string; got ${JSON.stringify(value.model)}`);
  }
  const confidence = value.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push(`confidence: expected a finite number in [0, 1]; got ${JSON.stringify(confidence)}`);
  }
  if (typeof value.disputed !== 'boolean') {
    errors.push(`disputed: expected a boolean; got ${JSON.stringify(value.disputed)}`);
  }
  const routerVersion = value['router-version'];
  if (typeof routerVersion !== 'string' || routerVersion.trim() === '') {
    errors.push(`router-version: expected a non-empty router version string; got ${JSON.stringify(routerVersion)}`);
  }

  return { ok: errors.length === 0, errors };
}
