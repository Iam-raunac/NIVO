/**
 * Tests for the composed pipeline (`planRoute` = validate -> select).
 * Confirms validation short-circuits before any PSP selection runs.
 */
import { describe, expect, it } from "vitest";
import * as E from "fp-ts/Either";
import { planRoute } from "../src/domain/router.js";
import type { PspConfig, TransactionRequest } from "../src/domain/types.js";

const psp: PspConfig = {
  id: "PSP_ALPHA",
  name: "Alpha",
  supportedMethods: ["card"],
  minAmount: 10,
  maxAmount: 1000,
  baseSuccessRate: 0.8,
  priority: 1,
};

const validRequest: TransactionRequest = {
  idempotencyKey: "key-1",
  amount: 100,
  currency: "USD",
  method: "card",
};

describe("planRoute", () => {
  it("short-circuits on validation errors before touching PSP selection", () => {
    const result = planRoute([psp], { ...validRequest, amount: -5 }, () => true);
    expect(E.isLeft(result)).toBe(true);
    if (E.isLeft(result)) {
      expect(result.left._tag).toBe("ValidationError");
    }
  });

  it("returns NoEligiblePsp when validation passes but no PSP qualifies", () => {
    const result = planRoute([psp], { ...validRequest, method: "wallet" }, () => true);
    expect(E.isLeft(result)).toBe(true);
    if (E.isLeft(result)) {
      expect(result.left._tag).toBe("NoEligiblePsp");
    }
  });

  it("returns the ranked candidate list for a valid, routable request", () => {
    const result = planRoute([psp], validRequest, () => true);
    expect(result).toEqual(E.right([psp]));
  });
});
