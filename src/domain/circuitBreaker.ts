/**
 * Circuit breaker — pure state machine.
 *
 * Classic three-state breaker: Closed (normal) -> Open (tripped, calls
 * skipped) -> HalfOpen (cooldown elapsed, one probe call allowed) -> back to
 * Closed on success or Open on failure. "Self-healing" comes from the
 * Open -> HalfOpen transition being purely a function of elapsed time, so a
 * PSP automatically gets a chance to redeem itself without any operator
 * action.
 *
 * `BreakerState` is immutable — every transition below returns a *new*
 * object. The only mutation in the whole app is the single Map lookup that
 * holds "current state per PSP", and that live in `effects/breakerStore.ts`,
 * clearly separated from this decision logic.
 */
import type { PspId } from "./types.js";

export type BreakerStatus = "Closed" | "Open" | "HalfOpen";

export interface BreakerState {
  readonly status: BreakerStatus;
  /** Timestamps (ms) of failures inside the current rolling window. */
  readonly failureTimestamps: ReadonlyArray<number>;
  /** When the breaker tripped to Open, if it's currently open. */
  readonly openedAt: number | null;
}

export interface BreakerConfig {
  /** Trip to Open after this many failures inside `windowMs`. */
  readonly failureThreshold: number;
  /** Rolling window over which failures are counted. */
  readonly windowMs: number;
  /** How long to stay Open before allowing a HalfOpen probe. */
  readonly cooldownMs: number;
}

export const defaultBreakerConfig: BreakerConfig = {
  failureThreshold: 3,
  windowMs: 60_000,
  cooldownMs: 15_000,
};

export const initialBreakerState: BreakerState = {
  status: "Closed",
  failureTimestamps: [],
  openedAt: null,
};

const withinWindow = (timestamps: ReadonlyArray<number>, now: number, windowMs: number) =>
  timestamps.filter((t) => now - t <= windowMs);

/**
 * Derive the *effective* state at time `now`: resolves the time-dependent
 * Open -> HalfOpen transition, and lets Closed-state failures that have
 * aged out of the rolling window quietly disappear. Called before every
 * read/write so no caller has to reason about elapsed time itself.
 */
export const observe = (state: BreakerState, now: number, config: BreakerConfig): BreakerState => {
  if (state.status === "Open" && state.openedAt !== null && now - state.openedAt >= config.cooldownMs) {
    return { ...state, status: "HalfOpen" };
  }
  if (state.status === "Closed") {
    const trimmed = withinWindow(state.failureTimestamps, now, config.windowMs);
    return trimmed.length === state.failureTimestamps.length ? state : { ...state, failureTimestamps: trimmed };
  }
  return state;
};

/** Is a call to this PSP allowed right now? Open = no, Closed/HalfOpen = yes
 *  (HalfOpen lets exactly the probe traffic through; see `recordFailure`
 *  which immediately re-opens on any failure during the probe). */
export const isCallAllowed = (state: BreakerState, now: number, config: BreakerConfig): boolean =>
  observe(state, now, config).status !== "Open";

export const recordSuccess = (state: BreakerState, now: number, config: BreakerConfig): BreakerState => {
  const observed = observe(state, now, config);

  // A successful HalfOpen probe fully heals the breaker.
  if (observed.status === "HalfOpen") {
    return { status: "Closed", failureTimestamps: [], openedAt: null };
  }

  // While Closed, a success does NOT wipe out prior failures — the breaker
  // trips on "more than N failures in a rolling window", not "N
  // *consecutive* failures". Stale failures still age out of the window on
  // their own (see `withinWindow`/`observe`); a success just doesn't count
  // against that budget. Returning `observed` (not `state`) still applies
  // the Open -> HalfOpen time-based transition consistently.
  return observed;
};

export const recordFailure = (state: BreakerState, now: number, config: BreakerConfig): BreakerState => {
  const observed = observe(state, now, config);

  // A failed probe while HalfOpen trips it straight back to Open.
  if (observed.status === "HalfOpen") {
    return { status: "Open", failureTimestamps: [now], openedAt: now };
  }

  const recentFailures = [...withinWindow(observed.failureTimestamps, now, config.windowMs), now];

  if (recentFailures.length >= config.failureThreshold) {
    return { status: "Open", failureTimestamps: recentFailures, openedAt: now };
  }

  return { status: "Closed", failureTimestamps: recentFailures, openedAt: null };
};
