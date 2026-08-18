/**
 * In-memory holder for circuit breaker state, one `BreakerState` per PSP.
 *
 * Same pattern as `store.ts`: a single `Map` is the only mutable variable,
 * closed over by a factory. All the actual decision-making (when to trip,
 * when to allow a half-open probe) is delegated to the pure reducers in
 * `domain/circuitBreaker.ts` — this module's job is purely "read current
 * state" / "replace current state", never "decide".
 */
import {
  type BreakerConfig,
  type BreakerState,
  defaultBreakerConfig,
  initialBreakerState,
  isCallAllowed,
  observe,
  recordFailure,
  recordSuccess,
} from "../domain/circuitBreaker.js";
import type { PspId } from "../domain/types.js";

export interface BreakerStore {
  readonly isHealthy: (pspId: PspId, now?: number) => boolean;
  readonly onSuccess: (pspId: PspId, now?: number) => void;
  readonly onFailure: (pspId: PspId, now?: number) => void;
  /** Snapshot of every PSP's breaker state, for the `/psp/health` endpoint. */
  readonly snapshot: (now?: number) => ReadonlyMap<PspId, BreakerState>;
}

export const createBreakerStore = (
  pspIds: ReadonlyArray<PspId>,
  config: BreakerConfig = defaultBreakerConfig,
): BreakerStore => {
  const states = new Map<PspId, BreakerState>(pspIds.map((id) => [id, initialBreakerState]));

  const read = (pspId: PspId): BreakerState => states.get(pspId) ?? initialBreakerState;

  return {
    isHealthy: (pspId, now = Date.now()) => isCallAllowed(read(pspId), now, config),

    onSuccess: (pspId, now = Date.now()) => {
      states.set(pspId, recordSuccess(read(pspId), now, config));
    },

    onFailure: (pspId, now = Date.now()) => {
      states.set(pspId, recordFailure(read(pspId), now, config));
    },

    snapshot: (now = Date.now()) =>
      new Map(Array.from(states.entries()).map(([id, state]) => [id, observe(state, now, config)])),
  };
};
