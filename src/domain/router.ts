/**
 * The pure decision pipeline: Validation -> PSP Selection.
 *
 * This is deliberately *not* one big function. `planRoute` is the
 * composition, via `pipe`, of small single-purpose steps from `rules.ts`.
 * Everything up to and including this module is pure and synchronous —
 * no network calls happen here. Execution (which actually talks to PSPs,
 * retries, and mutates the circuit breaker/store) lives in `effects/`.
 */
import { pipe } from "fp-ts/function";
import * as E from "fp-ts/Either";
import type { PaymentError, PspConfig, TransactionRequest } from "./types.js";
import { type HealthCheck, selectRoute, validateRequest } from "./rules.js";

/**
 * Validate the request, then produce the ranked, best-first list of PSPs
 * that are eligible to attempt it. `Left` short-circuits the whole pipeline
 * — no PSP is ever called for an invalid or unroutable request.
 */
export const planRoute = (
  psps: ReadonlyArray<PspConfig>,
  request: TransactionRequest,
  isHealthy: HealthCheck,
): E.Either<PaymentError, ReadonlyArray<PspConfig>> =>
  pipe(
    validateRequest(request),
    E.chain((validated) => selectRoute(psps, validated, isHealthy)),
  );
