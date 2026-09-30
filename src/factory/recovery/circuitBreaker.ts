import type { EventLog } from '../events/log';

/**
 * E9.6 dependency circuit breaker (design `policy-and-risk-model.md` §9.2;
 * spec §18.9).
 *
 * §18.9 tracks a dependency's health (`AVAILABLE → DEGRADED → UNAVAILABLE →
 * RECOVERING → AVAILABLE`) and says persistent failures open a circuit so only
 * operations that actually require the dependency block. This is the v0.1
 * mechanics: a per-dependency `CLOSED → OPEN → HALF_OPEN` machine that sheds
 * dependent load *before* the generic per-class/per-Task recovery budgets are
 * spent — an open circuit parks on capacity (a `WAITING_RESOURCE` disposition,
 * which consumes no autonomy) instead of walking the retry ladder.
 *
 * State is durable, derived from append-only events (mirroring
 * `factoryControlState`), so a circuit survives a Factory restart without a new
 * state collection. `CLOSED` trips `OPEN` on `failureThreshold` consecutive
 * failures; after `resetTimeoutMs` the circuit half-opens and admits a probe;
 * a failing probe re-opens, and an explicit success closes it.
 */

export const CIRCUIT_STATE_CHANGED = 'dependency.circuit_state_changed';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitSnapshot {
  dependency: string;
  state: CircuitState;
  /** Consecutive failures since the last success (reset on CLOSED). */
  consecutiveFailures: number;
  /** When the circuit most recently tripped OPEN (null while never opened). */
  openedAt: string | null;
  updatedAt: string;
}

export interface CircuitConfig {
  /** Consecutive failures that trip the circuit OPEN. */
  failureThreshold: number;
  /** How long an OPEN circuit sheds before it half-opens for a probe. */
  resetTimeoutMs: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
};

export interface CircuitDeps {
  events: EventLog;
  now?: () => string;
}

/** The decision a caller gets before performing a dependency-bound operation. */
export interface CircuitDecision {
  /** Whether the dependent operation may proceed (CLOSED, or a HALF_OPEN probe). */
  allowed: boolean;
  state: CircuitState;
  /** For a shed (OPEN): ms until the half-open probe window. */
  retryAfterMs?: number;
}

function configOf(config?: Partial<CircuitConfig>): CircuitConfig {
  return { ...DEFAULT_CIRCUIT_CONFIG, ...(config ?? {}) };
}

/** Fold the durable circuit events for one dependency into its latest state. */
export function circuitSnapshot(deps: CircuitDeps, dependency: string): CircuitSnapshot {
  let snapshot: CircuitSnapshot = {
    dependency,
    state: 'CLOSED',
    consecutiveFailures: 0,
    openedAt: null,
    updatedAt: '',
  };
  for (const event of deps.events.readEvents({
    aggregateType: 'dependency',
    aggregateId: dependency,
  })) {
    if (event.type !== CIRCUIT_STATE_CHANGED) continue;
    const payload = event.payload as Partial<CircuitSnapshot>;
    snapshot = {
      dependency,
      state: (payload.state as CircuitState) ?? snapshot.state,
      consecutiveFailures: payload.consecutiveFailures ?? snapshot.consecutiveFailures,
      openedAt: payload.openedAt ?? null,
      updatedAt: payload.updatedAt ?? snapshot.updatedAt,
    };
  }
  return snapshot;
}

function appendState(deps: CircuitDeps, snapshot: CircuitSnapshot): CircuitSnapshot {
  deps.events.appendEvent({
    type: CIRCUIT_STATE_CHANGED,
    aggregateType: 'dependency',
    aggregateId: snapshot.dependency,
    payload: { ...snapshot },
  });
  return snapshot;
}

/**
 * The gate consulted before a dependency-bound operation. `CLOSED` admits;
 * `OPEN` sheds until `resetTimeoutMs` has elapsed, then transitions `HALF_OPEN`
 * and admits the probe; `HALF_OPEN` admits (a failed probe re-opens via
 * {@link recordDependencyFailure}).
 */
export function beforeDependencyRequest(
  deps: CircuitDeps,
  dependency: string,
  config?: Partial<CircuitConfig>,
): CircuitDecision {
  const cfg = configOf(config);
  const now = deps.now ?? (() => new Date().toISOString());
  const snapshot = circuitSnapshot(deps, dependency);
  if (snapshot.state !== 'OPEN') return { allowed: true, state: snapshot.state };

  const at = now();
  const openedMs = snapshot.openedAt ? Date.parse(snapshot.openedAt) : Date.parse(at);
  const elapsed = Date.parse(at) - openedMs;
  if (elapsed < cfg.resetTimeoutMs) {
    return { allowed: false, state: 'OPEN', retryAfterMs: cfg.resetTimeoutMs - elapsed };
  }
  appendState(deps, { ...snapshot, state: 'HALF_OPEN', updatedAt: at });
  return { allowed: true, state: 'HALF_OPEN' };
}

/**
 * Record a dependency failure. Consecutive failures at the threshold trip the
 * circuit OPEN. A failure while HALF_OPEN (a failed probe) re-opens it with a
 * fresh window; a failure while already OPEN keeps the existing window, so
 * concurrent shed reports cannot extend it indefinitely.
 */
export function recordDependencyFailure(
  deps: CircuitDeps,
  dependency: string,
  config?: Partial<CircuitConfig>,
): CircuitSnapshot {
  const cfg = configOf(config);
  const now = deps.now ?? (() => new Date().toISOString());
  const at = now();
  const current = circuitSnapshot(deps, dependency);
  const consecutiveFailures = current.consecutiveFailures + 1;

  const shouldOpen =
    current.state === 'CLOSED' && consecutiveFailures >= cfg.failureThreshold;
  if (current.state === 'OPEN') return current;
  if (current.state === 'HALF_OPEN' || shouldOpen) {
    return appendState(deps, {
      dependency,
      state: 'OPEN',
      consecutiveFailures,
      openedAt: at,
      updatedAt: at,
    });
  }
  return appendState(deps, {
    dependency,
    state: 'CLOSED',
    consecutiveFailures,
    openedAt: null,
    updatedAt: at,
  });
}

/** Record a dependency success: the circuit closes and the failure count resets. */
export function recordDependencySuccess(deps: CircuitDeps, dependency: string): CircuitSnapshot {
  const now = deps.now ?? (() => new Date().toISOString());
  return appendState(deps, {
    dependency,
    state: 'CLOSED',
    consecutiveFailures: 0,
    openedAt: null,
    updatedAt: now(),
  });
}
