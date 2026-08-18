/**
 * Circuit breaker state machine tests. All time is passed in explicitly
 * (`now`), so these are pure input -> output assertions with no fake
 * timers or clock mocking needed.
 */
import { describe, expect, it } from "vitest";
import {
  type BreakerConfig,
  initialBreakerState,
  isCallAllowed,
  observe,
  recordFailure,
  recordSuccess,
} from "../src/domain/circuitBreaker.js";

const config: BreakerConfig = { failureThreshold: 3, windowMs: 10_000, cooldownMs: 5_000 };

describe("circuit breaker", () => {
  it("stays Closed under the failure threshold", () => {
    let state = initialBreakerState;
    state = recordFailure(state, 1_000, config);
    state = recordFailure(state, 2_000, config);
    expect(state.status).toBe("Closed");
    expect(isCallAllowed(state, 3_000, config)).toBe(true);
  });

  it("trips to Open once the threshold is reached within the window", () => {
    let state = initialBreakerState;
    state = recordFailure(state, 1_000, config);
    state = recordFailure(state, 2_000, config);
    state = recordFailure(state, 3_000, config);
    expect(state.status).toBe("Open");
    expect(isCallAllowed(state, 3_500, config)).toBe(false);
  });

  it("ignores failures that have aged out of the rolling window", () => {
    let state = initialBreakerState;
    state = recordFailure(state, 0, config);
    state = recordFailure(state, 1_000, config);
    // third failure arrives after the first has aged out of the 10s window
    state = recordFailure(state, 11_500, config);
    expect(state.status).toBe("Closed");
  });

  it("moves from Open to HalfOpen once the cooldown elapses", () => {
    let state = initialBreakerState;
    state = recordFailure(state, 0, config);
    state = recordFailure(state, 100, config);
    state = recordFailure(state, 200, config); // opens at t=200
    expect(observe(state, 5_199, config).status).toBe("Open");
    expect(observe(state, 5_200, config).status).toBe("HalfOpen");
    expect(isCallAllowed(state, 5_200, config)).toBe(true);
  });

  it("closes fully on a successful HalfOpen probe", () => {
    let state = initialBreakerState;
    state = recordFailure(state, 0, config);
    state = recordFailure(state, 100, config);
    state = recordFailure(state, 200, config);
    state = recordSuccess(state, 5_300, config); // probe succeeds
    expect(state.status).toBe("Closed");
    expect(state.failureTimestamps).toEqual([]);
  });

  it("re-opens immediately on a failed HalfOpen probe", () => {
    let state = initialBreakerState;
    state = recordFailure(state, 0, config);
    state = recordFailure(state, 100, config);
    state = recordFailure(state, 200, config);
    state = recordFailure(state, 5_300, config); // probe fails
    expect(state.status).toBe("Open");
    expect(isCallAllowed(state, 5_301, config)).toBe(false);
  });

  it("trips on N failures within the window even with successes interspersed", () => {
    // Regression check: the breaker counts failures "in a rolling window",
    // not "N *consecutive* failures" — an interleaved success must not
    // reset the budget.
    let state = initialBreakerState;
    state = recordFailure(state, 0, config);
    state = recordSuccess(state, 500, config);
    state = recordFailure(state, 1_000, config);
    state = recordSuccess(state, 1_500, config);
    state = recordFailure(state, 2_000, config);
    expect(state.status).toBe("Open");
  });

  it("lets a Closed-state success pass through without erasing prior failures", () => {
    let state = initialBreakerState;
    state = recordFailure(state, 0, config);
    state = recordSuccess(state, 500, config);
    expect(state.status).toBe("Closed");
    expect(state.failureTimestamps).toEqual([0]);
  });

  it("never mutates the state object passed in", () => {
    const state = initialBreakerState;
    const frozen = Object.freeze({ ...state });
    expect(() => recordFailure(frozen, 0, config)).not.toThrow();
    expect(frozen).toEqual(initialBreakerState);
  });
});
