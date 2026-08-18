/**
 * PSP selection rules.
 *
 * Every function here is pure: `(psps, request) => result`, no I/O, no
 * randomness, no clock reads (the caller passes `now` in explicitly where
 * time matters). That's what makes them trivially unit-testable with plain
 * `expect(fn(input)).toEqual(output)` — no mocking required, which is one
 * of the concrete payoffs of the FP approach documented in the README.
 */
import { pipe } from "fp-ts/function";
import * as E from "fp-ts/Either";
import * as RA from "fp-ts/ReadonlyArray";
import type { PaymentError, PspConfig, PspId, TransactionRequest } from "./types.js";

/** A PSP is only usable if it isn't currently circuit-broken. Injected as a
 *  predicate so this module never has to know about breaker state directly. */
export type HealthCheck = (pspId: PspId) => boolean;

export const supportsMethod = (psp: PspConfig, request: TransactionRequest): boolean =>
  psp.supportedMethods.includes(request.method);

export const withinAmountLimits = (psp: PspConfig, request: TransactionRequest): boolean =>
  request.amount >= psp.minAmount && request.amount <= psp.maxAmount;

export const isEligible =
  (request: TransactionRequest, isHealthy: HealthCheck) =>
  (psp: PspConfig): boolean =>
    supportsMethod(psp, request) && withinAmountLimits(psp, request) && isHealthy(psp.id);

/**
 * Rank candidate PSPs best-first: higher historical success rate wins,
 * ties broken by configured priority (lower number = preferred).
 */
export const rankBySuccessRate = (psps: ReadonlyArray<PspConfig>): ReadonlyArray<PspConfig> =>
  [...psps].sort((a, b) => b.baseSuccessRate - a.baseSuccessRate || a.priority - b.priority);

/**
 * Build the ordered failover plan for a request: filter to eligible +
 * healthy PSPs, then rank them best-first. `Left` when nothing qualifies.
 */
export const selectRoute = (
  psps: ReadonlyArray<PspConfig>,
  request: TransactionRequest,
  isHealthy: HealthCheck,
): E.Either<PaymentError, ReadonlyArray<PspConfig>> =>
  pipe(
    psps,
    RA.filter(isEligible(request, isHealthy)),
    rankBySuccessRate,
    (ranked) =>
      ranked.length === 0
        ? E.left<PaymentError>({
            _tag: "NoEligiblePsp",
            message: `No PSP supports ${request.method} for ${request.amount} ${request.currency}`,
          })
        : E.right(ranked),
  );

/** Validation is the first pipeline stage — reject malformed requests before
 *  any PSP is even considered. */
export const validateRequest = (
  request: TransactionRequest,
): E.Either<PaymentError, TransactionRequest> => {
  if (!request.idempotencyKey || request.idempotencyKey.trim().length === 0) {
    return E.left({ _tag: "ValidationError", message: "idempotencyKey is required" });
  }
  if (!Number.isFinite(request.amount) || request.amount <= 0) {
    return E.left({ _tag: "ValidationError", message: "amount must be a positive number" });
  }
  return E.right(request);
};
