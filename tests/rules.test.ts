/**
 * Pure function tests — no mocks, no fakes, no setup/teardown. Each case is
 * a plain `input -> expected output` assertion, which is exactly the payoff
 * the README calls out for keeping routing rules free of side effects.
 */
import { describe, expect, it } from "vitest";
import * as E from "fp-ts/Either";
import {
  isEligible,
  rankBySuccessRate,
  selectRoute,
  supportsMethod,
  validateRequest,
  withinAmountLimits,
} from "../src/domain/rules.js";
import type { PspConfig, TransactionRequest } from "../src/domain/types.js";

const alpha: PspConfig = {
  id: "PSP_ALPHA",
  name: "Alpha",
  supportedMethods: ["card"],
  minAmount: 10,
  maxAmount: 1000,
  baseSuccessRate: 0.5,
  priority: 1,
};

const beta: PspConfig = {
  id: "PSP_BETA",
  name: "Beta",
  supportedMethods: ["card", "upi"],
  minAmount: 10,
  maxAmount: 5000,
  baseSuccessRate: 0.9,
  priority: 2,
};

const gamma: PspConfig = {
  id: "PSP_GAMMA",
  name: "Gamma",
  supportedMethods: ["upi"],
  minAmount: 10,
  maxAmount: 5000,
  baseSuccessRate: 0.9,
  priority: 1,
};

const cardRequest: TransactionRequest = {
  idempotencyKey: "key-1",
  amount: 500,
  currency: "USD",
  method: "card",
};

describe("supportsMethod", () => {
  it("is true when the PSP lists the method", () => {
    expect(supportsMethod(alpha, cardRequest)).toBe(true);
  });

  it("is false when the PSP doesn't list the method", () => {
    expect(supportsMethod(gamma, cardRequest)).toBe(false);
  });
});

describe("withinAmountLimits", () => {
  it("is true within [min, max]", () => {
    expect(withinAmountLimits(alpha, cardRequest)).toBe(true);
  });

  it("is false below min or above max", () => {
    expect(withinAmountLimits(alpha, { ...cardRequest, amount: 1 })).toBe(false);
    expect(withinAmountLimits(alpha, { ...cardRequest, amount: 999_999 })).toBe(false);
  });
});

describe("isEligible", () => {
  it("combines method support, amount limits, and health", () => {
    const healthy = () => true;
    const unhealthy = () => false;

    expect(isEligible(cardRequest, healthy)(alpha)).toBe(true);
    expect(isEligible(cardRequest, unhealthy)(alpha)).toBe(false);
    expect(isEligible(cardRequest, healthy)(gamma)).toBe(false); // no card support
  });
});

describe("rankBySuccessRate", () => {
  it("orders by success rate descending, ties broken by priority", () => {
    const ranked = rankBySuccessRate([alpha, beta, gamma]);
    expect(ranked.map((p) => p.id)).toEqual(["PSP_GAMMA", "PSP_BETA", "PSP_ALPHA"]);
  });

  it("does not mutate the input array", () => {
    const input = [alpha, beta, gamma];
    const copy = [...input];
    rankBySuccessRate(input);
    expect(input).toEqual(copy);
  });
});

describe("selectRoute", () => {
  it("returns ranked eligible PSPs for a routable request", () => {
    const result = selectRoute([alpha, beta, gamma], cardRequest, () => true);
    expect(E.isRight(result)).toBe(true);
    if (E.isRight(result)) {
      expect(result.right.map((p) => p.id)).toEqual(["PSP_BETA", "PSP_ALPHA"]);
    }
  });

  it("returns Left NoEligiblePsp when nothing qualifies", () => {
    const result = selectRoute([gamma], cardRequest, () => true); // gamma has no card support
    expect(result).toEqual(E.left({ _tag: "NoEligiblePsp", message: expect.any(String) }));
  });

  it("excludes unhealthy (circuit-broken) PSPs", () => {
    const result = selectRoute([alpha, beta], cardRequest, (id) => id !== "PSP_BETA");
    expect(E.isRight(result)).toBe(true);
    if (E.isRight(result)) {
      expect(result.right.map((p) => p.id)).toEqual(["PSP_ALPHA"]);
    }
  });
});

describe("validateRequest", () => {
  it("accepts a well-formed request", () => {
    expect(validateRequest(cardRequest)).toEqual(E.right(cardRequest));
  });

  it("rejects a missing idempotency key", () => {
    const result = validateRequest({ ...cardRequest, idempotencyKey: "  " });
    expect(E.isLeft(result)).toBe(true);
  });

  it("rejects a non-positive amount", () => {
    const result = validateRequest({ ...cardRequest, amount: 0 });
    expect(E.isLeft(result)).toBe(true);
  });
});
