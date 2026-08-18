/**
 * In-memory transaction store.
 *
 * This module is the deliberately-contained "impure shell" for persistence:
 * a single `Map` closed over inside a factory function. Nothing outside
 * this file ever touches a mutable variable directly — callers get back
 * `Option`s and plain read functions, and writes go through `save`, which
 * always stores a *new* immutable `TransactionRecord` (we never mutate a
 * record in place, we replace it).
 *
 * --- Idempotency ---------------------------------------------------------
 * Payment APIs are called over unreliable networks, so clients retry. If a
 * retry re-submits the same `idempotencyKey`, it must NOT be routed to a
 * PSP again — that could double-charge a customer. `getByIdempotencyKey`
 * lets the executor short-circuit: "have I seen this key before? If so,
 * hand back the original result verbatim instead of reprocessing."
 */
import { pipe } from "fp-ts/function";
import * as O from "fp-ts/Option";
import type { TransactionRecord } from "../domain/types.js";

export interface TransactionStore {
  readonly get: (id: string) => O.Option<TransactionRecord>;
  readonly getByIdempotencyKey: (key: string) => O.Option<TransactionRecord>;
  readonly save: (record: TransactionRecord) => void;
  readonly all: () => ReadonlyArray<TransactionRecord>;
}

export const createTransactionStore = (): TransactionStore => {
  const byId = new Map<string, TransactionRecord>();
  const idByIdempotencyKey = new Map<string, string>();

  return {
    get: (id) => O.fromNullable(byId.get(id)),

    getByIdempotencyKey: (key) =>
      pipe(
        O.fromNullable(idByIdempotencyKey.get(key)),
        O.chain((id) => O.fromNullable(byId.get(id))),
      ),

    save: (record) => {
      byId.set(record.id, record);
      idByIdempotencyKey.set(record.request.idempotencyKey, record.id);
    },

    all: () => Array.from(byId.values()),
  };
};
