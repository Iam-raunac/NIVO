/**
 * The executor — the impure shell that turns a pure routing *plan* into a
 * real (simulated) outcome: it calls PSPs in order, records each attempt,
 * updates the circuit breaker, retries on failure up to `MAX_RETRIES`, and
 * persists the final `TransactionRecord`.
 *
 * Everything that *decides* (which PSPs are eligible, ranking, whether the
 * breaker allows a call) is delegated to `domain/*`, which stays pure. This
 * file only sequences effects and folds their results into data.
 */
import { pipe } from "fp-ts/function";
import * as E from "fp-ts/Either";
import * as O from "fp-ts/Option";
import * as RA from "fp-ts/ReadonlyArray";
import * as T from "fp-ts/Task";
import { planRoute } from "../domain/router.js";
import type { HealthCheck } from "../domain/rules.js";
import {
  MAX_RETRIES,
  type Attempt,
  type PaymentError,
  type PspConfig,
  type PspId,
  type TransactionRecord,
  type TransactionRequest,
  type TransactionState,
} from "../domain/types.js";
import type { PspCall, PspSuccess } from "./pspClients.js";
import type { BreakerStore } from "./breakerStore.js";
import type { TransactionStore } from "./store.js";

export interface ExecutorDeps {
  readonly psps: ReadonlyArray<PspConfig>;
  readonly pspCalls: ReadonlyMap<PspId, PspCall>;
  readonly breaker: BreakerStore;
  readonly store: TransactionStore;
  readonly generateId: () => string;
}

interface AttemptOutcome {
  readonly attempts: ReadonlyArray<Attempt>;
  readonly result: E.Either<PaymentError, PspSuccess>;
}

/**
 * Try candidates in ranked order, failing over to the next on any error.
 * Recursive rather than a loop so there's no mutable accumulator: each
 * step's `attemptsSoFar` is a brand-new readonly array built with spread.
 * Stops at the first success, at `MAX_RETRIES` attempts, or when the
 * candidate list is exhausted — whichever comes first.
 */
const attemptWithFailover = async (
  remaining: ReadonlyArray<PspConfig>,
  pspCalls: ReadonlyMap<PspId, PspCall>,
  breaker: BreakerStore,
  request: TransactionRequest,
  attemptsSoFar: ReadonlyArray<Attempt> = [],
): Promise<AttemptOutcome> => {
  if (remaining.length === 0 || attemptsSoFar.length >= MAX_RETRIES) {
    const lastError = pipe(
      RA.last(attemptsSoFar),
      O.chain((attempt) => O.fromNullable(attempt.error)),
      O.getOrElse((): PaymentError => ({ _tag: "RetriesExhausted", attempts: attemptsSoFar.length })),
    );
    return { attempts: attemptsSoFar, result: E.left(lastError) };
  }

  const [psp, ...rest] = remaining as readonly [PspConfig, ...PspConfig[]];
  const call = pspCalls.get(psp.id);
  if (!call) {
    // Misconfiguration guard: a candidate with no registered client is
    // simply skipped rather than crashing the request.
    return attemptWithFailover(rest, pspCalls, breaker, request, attemptsSoFar);
  }

  const startedAt = Date.now();
  const outcome = await call(request)(); // run the TaskEither, get Either<PaymentError, PspSuccess>
  const finishedAt = Date.now();

  if (E.isRight(outcome)) {
    breaker.onSuccess(psp.id, finishedAt);
    const attempt: Attempt = {
      pspId: psp.id,
      outcome: "success",
      latencyMs: outcome.right.latencyMs,
      at: finishedAt,
    };
    return { attempts: [...attemptsSoFar, attempt], result: E.right(outcome.right) };
  }

  breaker.onFailure(psp.id, finishedAt);
  const attempt: Attempt = {
    pspId: psp.id,
    outcome: "failure",
    error: outcome.left,
    latencyMs: finishedAt - startedAt,
    at: finishedAt,
  };
  return attemptWithFailover(rest, pspCalls, breaker, request, [...attemptsSoFar, attempt]);
};

const buildFinalState = (outcome: AttemptOutcome): TransactionState =>
  E.isRight(outcome.result)
    ? { _tag: "Succeeded", pspId: outcome.result.right.pspId, attempt: outcome.attempts.length }
    : { _tag: "DeadLettered", attempts: outcome.attempts.length, lastError: outcome.result.left };

/**
 * Process one transaction end to end. Returns a `Task` (fp-ts's
 * `() => Promise<A>`) rather than a bare `Promise` so it composes with the
 * rest of the fp-ts pipeline; there is no error channel at this level
 * because every path — validation failure, no eligible PSP, or exhausted
 * retries — terminates in a *successfully persisted* `TransactionRecord`.
 * The failure is represented as data (`Failed` / `DeadLettered` state),
 * never as a rejected Task or a thrown exception.
 */
export const processTransaction =
  (deps: ExecutorDeps) =>
  (request: TransactionRequest): T.Task<TransactionRecord> =>
  async () => {
    // --- Idempotency guard -------------------------------------------------
    // Re-submitting the same idempotencyKey (e.g. a client retrying after a
    // dropped response) must return the original outcome untouched, with no
    // new PSP calls — otherwise a network blip could double-charge someone.
    const existing = deps.store.getByIdempotencyKey(request.idempotencyKey);
    if (O.isSome(existing)) {
      return existing.value;
    }

    const id = deps.generateId();
    const createdAt = Date.now();
    const isHealthy: HealthCheck = (pspId) => deps.breaker.isHealthy(pspId, createdAt);

    const routingPlan = planRoute(deps.psps, request, isHealthy);

    if (E.isLeft(routingPlan)) {
      const record: TransactionRecord = {
        id,
        request,
        attempts: [],
        createdAt,
        updatedAt: createdAt,
        state: { _tag: "Failed", error: routingPlan.left },
      };
      deps.store.save(record);
      return record;
    }

    const outcome = await attemptWithFailover(routingPlan.right, deps.pspCalls, deps.breaker, request);

    const record: TransactionRecord = {
      id,
      request,
      attempts: outcome.attempts,
      createdAt,
      updatedAt: Date.now(),
      state: buildFinalState(outcome),
    };
    deps.store.save(record);
    return record;
  };
