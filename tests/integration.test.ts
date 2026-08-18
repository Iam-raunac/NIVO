/**
 * Integration test: drives the real executor (retry + failover + circuit
 * breaker + idempotency) end to end, with mock PSP clients whose outcomes
 * are forced deterministically (`failureRate` of exactly 1 or 0 — see
 * `effects/pspClients.ts`) instead of relying on randomness.
 *
 * Scenario: PSP1 fails, PSP2 fails, PSP3 succeeds — the transaction should
 * still end up `Succeeded`, with three logged attempts and the first two
 * PSPs' circuit breakers recording a failure.
 */
import { describe, expect, it } from "vitest";
import * as O from "fp-ts/Option";
import { processTransaction, type ExecutorDeps } from "../src/effects/executor.js";
import { createBreakerStore } from "../src/effects/breakerStore.js";
import { createTransactionStore } from "../src/effects/store.js";
import { makeMockPspCall } from "../src/effects/pspClients.js";
import type { PspConfig, PspId, TransactionRequest } from "../src/domain/types.js";

const psps: ReadonlyArray<PspConfig> = [
  { id: "PSP_ALPHA", name: "PSP1", supportedMethods: ["card"], minAmount: 1, maxAmount: 10_000, baseSuccessRate: 0.9, priority: 1 },
  { id: "PSP_BETA", name: "PSP2", supportedMethods: ["card"], minAmount: 1, maxAmount: 10_000, baseSuccessRate: 0.9, priority: 2 },
  { id: "PSP_GAMMA", name: "PSP3", supportedMethods: ["card"], minAmount: 1, maxAmount: 10_000, baseSuccessRate: 0.9, priority: 3 },
];
// equal baseSuccessRate + distinct priority => deterministic ranked order
// PSP_ALPHA, PSP_BETA, PSP_GAMMA regardless of the (irrelevant) success rate.

let idCounter = 0;

/** failureRates lets each test force deterministic PSP outcomes instead of
 *  relying on randomness (see `effects/pspClients.ts`: a failureRate of
 *  exactly 1 or 0 is fully deterministic). Defaults to ALPHA & BETA always
 *  failing, GAMMA always succeeding, matching the PSP1->PSP2->PSP3 scenario. */
const buildDeps = (
  failureRates: Readonly<Partial<Record<PspId, number>>> = { PSP_ALPHA: 1, PSP_BETA: 1, PSP_GAMMA: 0 },
): ExecutorDeps => {
  const pspCalls = new Map(
    psps.map((psp) => [
      psp.id,
      makeMockPspCall(psp, { failureRate: failureRates[psp.id] ?? 0, minLatencyMs: 0, maxLatencyMs: 0 }),
    ] as const),
  );

  return {
    psps,
    pspCalls,
    breaker: createBreakerStore(psps.map((p) => p.id)),
    store: createTransactionStore(),
    generateId: () => `tx-${++idCounter}`,
  };
};

const request: TransactionRequest = {
  idempotencyKey: "order-42",
  amount: 500,
  currency: "USD",
  method: "card",
};

describe("failover integration", () => {
  it("fails over PSP1 -> PSP2 -> PSP3 and succeeds on the third", async () => {
    const deps = buildDeps();

    const record = await processTransaction(deps)(request)();

    expect(record.state._tag).toBe("Succeeded");
    if (record.state._tag === "Succeeded") {
      expect(record.state.pspId).toBe("PSP_GAMMA");
      expect(record.state.attempt).toBe(3);
    }

    expect(record.attempts.map((a) => [a.pspId, a.outcome])).toEqual([
      ["PSP_ALPHA", "failure"],
      ["PSP_BETA", "failure"],
      ["PSP_GAMMA", "success"],
    ]);

    // Breaker recorded the two failures and one success independently.
    const health = deps.breaker.snapshot();
    expect(health.get("PSP_ALPHA" as PspId)?.failureTimestamps.length).toBe(1);
    expect(health.get("PSP_BETA" as PspId)?.failureTimestamps.length).toBe(1);
    expect(health.get("PSP_GAMMA" as PspId)?.status).toBe("Closed");
  });

  it("marks the transaction DeadLettered when every candidate fails", async () => {
    const deps = buildDeps({ PSP_ALPHA: 1, PSP_BETA: 1, PSP_GAMMA: 1 });

    const record = await processTransaction(deps)(request)();

    expect(record.state._tag).toBe("DeadLettered");
    expect(record.attempts).toHaveLength(3); // capped at MAX_RETRIES
  });

  it("replays the original result for a duplicate idempotency key without re-calling any PSP", async () => {
    const deps = buildDeps();

    const first = await processTransaction(deps)(request)();
    const secondCallCounts = deps.store.all().length;

    const second = await processTransaction(deps)(request)();

    expect(second).toEqual(first);
    expect(deps.store.all().length).toBe(secondCallCounts); // no new record created
  });

  it("looks up a saved transaction by id", async () => {
    const deps = buildDeps();
    const saved = await processTransaction(deps)(request)();

    const found = deps.store.get(saved.id);
    expect(O.isSome(found)).toBe(true);
  });
});
