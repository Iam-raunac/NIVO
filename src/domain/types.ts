/**
 * Core domain types for PayRoute.
 *
 * Everything here is a plain, immutable (readonly) data shape. There are no
 * classes, no methods, no hidden state — just algebraic data types (ADTs)
 * that the rest of the system pattern-matches over. This is what lets the
 * routing/failover/circuit-breaker logic in `domain/*` stay pure: a
 * `TransactionState` can only ever be one of the tags below, so every
 * function that consumes it is a total function over a closed set of cases.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Currency = "USD" | "EUR" | "GBP" | "INR";

export type PaymentMethod = "card" | "upi" | "netbanking" | "wallet";

export interface Money {
  readonly amount: number; // minor units are overkill for a demo; plain decimal is fine
  readonly currency: Currency;
}

export type PspId = "PSP_ALPHA" | "PSP_BETA" | "PSP_GAMMA" | "PSP_DELTA";

/**
 * Static configuration for a payment service provider. This is the *pure*
 * description of a PSP that the routing rules reason about — it says
 * nothing about network behaviour, which lives in `effects/pspClients.ts`.
 */
export interface PspConfig {
  readonly id: PspId;
  readonly name: string;
  readonly supportedMethods: ReadonlyArray<PaymentMethod>;
  readonly minAmount: number;
  readonly maxAmount: number;
  /** Historical success rate in [0, 1], used purely as a ranking weight. */
  readonly baseSuccessRate: number;
  /** Lower priority number = tried first when success rates tie. */
  readonly priority: number;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface TransactionRequest {
  readonly idempotencyKey: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly method: PaymentMethod;
}

// ---------------------------------------------------------------------------
// Errors — every failure mode is a value, never a thrown exception.
// ---------------------------------------------------------------------------

export type PaymentError =
  | { readonly _tag: "ValidationError"; readonly message: string }
  | { readonly _tag: "NoEligiblePsp"; readonly message: string }
  | { readonly _tag: "PspDeclined"; readonly pspId: PspId; readonly reason: string }
  | { readonly _tag: "PspTimeout"; readonly pspId: PspId }
  | { readonly _tag: "CircuitOpen"; readonly pspId: PspId }
  | { readonly _tag: "RetriesExhausted"; readonly attempts: number };

// ---------------------------------------------------------------------------
// Attempts — an immutable log entry per PSP call, success or failure.
// ---------------------------------------------------------------------------

export interface Attempt {
  readonly pspId: PspId;
  readonly outcome: "success" | "failure";
  readonly error?: PaymentError;
  readonly latencyMs: number;
  readonly at: number; // epoch ms
}

// ---------------------------------------------------------------------------
// Transaction state — the discriminated union the whole engine revolves
// around. A transaction moves strictly forward through these states; no
// function ever mutates a state in place, each step produces a new one.
// ---------------------------------------------------------------------------

export type TransactionState =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Routed"; readonly candidates: ReadonlyArray<PspId> }
  | { readonly _tag: "Retrying"; readonly attempt: number; readonly nextPsp: PspId }
  | { readonly _tag: "Failed"; readonly error: PaymentError }
  | { readonly _tag: "Succeeded"; readonly pspId: PspId; readonly attempt: number }
  | { readonly _tag: "DeadLettered"; readonly attempts: number; readonly lastError: PaymentError };

export interface TransactionRecord {
  readonly id: string;
  readonly request: TransactionRequest;
  readonly state: TransactionState;
  readonly attempts: ReadonlyArray<Attempt>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const MAX_RETRIES = 3;
