/**
 * Mock PSP clients — the *only* place in the codebase that simulates
 * network I/O (random latency + random failure). Each client is a function
 * `TransactionRequest -> TaskEither<PaymentError, PspSuccess>`, so from the
 * executor's point of view a call to a real PSP and a call to this mock
 * look identical: an async computation that either resolves with a
 * success value or fails with a typed `PaymentError`. Nothing here throws.
 */
import { pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import type { PaymentError, PspConfig, PspId, TransactionRequest } from "../domain/types.js";

export interface PspSuccess {
  readonly pspId: PspId;
  readonly authCode: string;
  readonly latencyMs: number;
}

export type PspCall = (request: TransactionRequest) => TE.TaskEither<PaymentError, PspSuccess>;

export interface MockPspOptions {
  /** Probability in [0, 1] that a call to this PSP fails. */
  readonly failureRate: number;
  readonly minLatencyMs: number;
  readonly maxLatencyMs: number;
  /** Injectable RNG so behaviour can be made deterministic in tests. */
  readonly rng?: () => number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a mock PSP call. This is the one function in the project that
 * touches `Math.random`/`setTimeout`, and it's isolated behind a
 * `TaskEither` boundary so nothing downstream needs to know it's fake.
 */
export const makeMockPspCall = (psp: PspConfig, options: MockPspOptions): PspCall => {
  const rng = options.rng ?? Math.random;

  return (_request: TransactionRequest) =>
    pipe(
      // The only awaited effect is the simulated network delay; it always
      // resolves (never rejects), so there is no exception path to catch —
      // outcome and latency are folded into an Either right after.
      TE.fromTask<number, never>(async () => {
        const latencyMs = Math.round(
          options.minLatencyMs + rng() * (options.maxLatencyMs - options.minLatencyMs),
        );
        await delay(latencyMs);
        return latencyMs;
      }),
      TE.chain((latencyMs) =>
        rng() < options.failureRate
          ? TE.left<PaymentError, PspSuccess>({ _tag: "PspDeclined", pspId: psp.id, reason: "simulated decline" })
          : TE.right<PaymentError, PspSuccess>({ pspId: psp.id, authCode: `AUTH-${psp.id}-${Date.now()}`, latencyMs }),
      ),
    );
};

/** Default catalogue of mock PSPs used by the running app (not tests). */
export const buildDefaultPspClients = (psps: ReadonlyArray<PspConfig>): ReadonlyMap<PspId, PspCall> =>
  new Map(
    psps.map((psp) => [
      psp.id,
      makeMockPspCall(psp, {
        failureRate: 1 - psp.baseSuccessRate,
        minLatencyMs: 40,
        maxLatencyMs: 220,
      }),
    ]),
  );
