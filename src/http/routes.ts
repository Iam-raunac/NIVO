/**
 * Thin Express layer. Every handler does the same three things: pull data
 * out of the request, call into `domain`/`effects`, and shape a JSON
 * response. No business logic — routing rules, retries, circuit-breaking —
 * lives here; this file only translates between HTTP and the pure/impure
 * core.
 */
import { Router, type Request, type Response } from "express";
import * as O from "fp-ts/Option";
import { processTransaction, type ExecutorDeps } from "../effects/executor.js";
import type { Currency, PaymentMethod, TransactionRequest } from "../domain/types.js";

const VALID_METHODS: ReadonlySet<string> = new Set(["card", "upi", "netbanking", "wallet"]);
const VALID_CURRENCIES: ReadonlySet<string> = new Set(["USD", "EUR", "GBP", "INR"]);

/** Narrow an arbitrary JSON body into a `TransactionRequest`, or `null` if
 *  the shape is unusable. Deliberately separate from `domain/rules`'s
 *  `validateRequest`, which checks *business* validity (amount > 0, etc.)
 *  on an already well-shaped request — this only checks HTTP payload shape. */
const parseTransactionRequest = (body: unknown): TransactionRequest | null => {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  if (typeof b["idempotencyKey"] !== "string") return null;
  if (typeof b["amount"] !== "number") return null;
  if (typeof b["currency"] !== "string" || !VALID_CURRENCIES.has(b["currency"])) return null;
  if (typeof b["method"] !== "string" || !VALID_METHODS.has(b["method"])) return null;

  return {
    idempotencyKey: b["idempotencyKey"],
    amount: b["amount"],
    currency: b["currency"] as Currency,
    method: b["method"] as PaymentMethod,
  };
};

/** Maps a terminal transaction state to an HTTP status code. */
const statusCodeFor = (record: { readonly state: { readonly _tag: string } }): number => {
  switch (record.state._tag) {
    case "Succeeded":
      return 200;
    case "Failed":
      return 422;
    case "DeadLettered":
      return 402;
    default:
      return 200;
  }
};

export const createTransactionRouter = (deps: ExecutorDeps): Router => {
  const router = Router();

  router.post("/transactions", (req: Request, res: Response) => {
    const parsed = parseTransactionRequest(req.body);
    if (parsed === null) {
      res.status(400).json({
        error: {
          _tag: "ValidationError",
          message: "body must include idempotencyKey (string), amount (number), currency, method",
        },
      });
      return;
    }

    processTransaction(deps)(parsed)().then((record) => {
      res.status(statusCodeFor(record)).json(record);
    });
  });

  // Not part of the original 3-endpoint spec, but a trivial read of the
  // existing store — needed by the UI's history view. Newest first.
  router.get("/transactions", (_req: Request, res: Response) => {
    const records = [...deps.store.all()].sort((a, b) => b.createdAt - a.createdAt);
    res.status(200).json(records);
  });

  router.get("/transactions/:id", (req: Request, res: Response) => {
    const record = deps.store.get(req.params.id ?? "");
    if (O.isNone(record)) {
      res.status(404).json({ error: { _tag: "NotFound", message: `No transaction with id ${req.params.id}` } });
      return;
    }
    res.status(200).json(record.value);
  });

  router.get("/psp/health", (_req: Request, res: Response) => {
    const snapshot = deps.breaker.snapshot();
    const body = Array.from(snapshot.entries()).map(([pspId, state]) => ({
      pspId,
      status: state.status,
      recentFailures: state.failureTimestamps.length,
      openedAt: state.openedAt,
    }));
    res.status(200).json(body);
  });

  return router;
};
