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
 * failures; after `resetTimeoutMs` the circuit half-opens and admits a single
 * probe (further calls are shed while that probe is in flight); a failing probe
 * re-opens, and an explicit success closes it.
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
  /**
   * True while a HALF_OPEN probe has been admitted but has not yet settled
   * (via {@link recordDependencySuccess} / {@link recordDependencyFailure}).
   * The half-open window admits a single probe; further calls are shed.
   */
  probeInFlight: boolean;
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
    probeInFlight: false,
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
      probeInFlight: payload.probeInFlight ?? false,
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
 * `OPEN` sheds until `resetTimeoutMs` has elapsed; at the window (or while
 * already `HALF_OPEN`) exactly one probe is admitted — further calls are shed
 * until the probe settles (a failed probe re-opens via
 * {@link recordDependencyFailure}, a success closes via
 * {@link recordDependencySuccess}).
 */
export function beforeDependencyRequest(
  deps: CircuitDeps,
  dependency: string,
  config?: Partial<CircuitConfig>,
): CircuitDecision {
  const cfg = configOf(config);
  const now = deps.now ?? (() => new Date().toISOString());
  const snapshot = circuitSnapshot(deps, dependency);
  const at = now();

  if (snapshot.state === 'CLOSED') return { allowed: true, state: 'CLOSED' };

  if (snapshot.state === 'HALF_OPEN') {
    // A half-open window admits a single probe. While one is in flight, shed.
    if (snapshot.probeInFlight) return { allowed: false, state: 'HALF_OPEN' };
    appendState(deps, { ...snapshot, probeInFlight: true, updatedAt: at });
    return { allowed: true, state: 'HALF_OPEN' };
  }

  // OPEN: shed until the reset window elapses, then half-open and admit the probe.
  const openedMs = snapshot.openedAt ? Date.parse(snapshot.openedAt) : Date.parse(at);
  const elapsed = Date.parse(at) - openedMs;
  if (elapsed < cfg.resetTimeoutMs) {
    return { allowed: false, state: 'OPEN', retryAfterMs: cfg.resetTimeoutMs - elapsed };
  }
  appendState(deps, { ...snapshot, state: 'HALF_OPEN', probeInFlight: true, updatedAt: at });
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
      probeInFlight: false,
      updatedAt: at,
    });
  }
  return appendState(deps, {
    dependency,
    state: 'CLOSED',
    consecutiveFailures,
    openedAt: null,
    probeInFlight: false,
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
    probeInFlight: false,
    updatedAt: now(),
  });
}
