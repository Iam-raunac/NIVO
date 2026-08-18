# PayRoute

A functional-style **payment routing & failover engine** in TypeScript — a small simulation of how a payment orchestrator (e.g. Juspay, Razorpay's routing layer, Stripe's Smart Retries) picks a PSP for a transaction, fails over across providers on decline, and self-heals unhealthy providers via a circuit breaker.

This is a backend logic showcase, not a product: no database, no auth. The point is the architecture — pure decision logic, effects pushed to the edges, and failure modeled as data instead of exceptions. A minimal static UI ([`public/`](public/), plain HTML/CSS/JS, no build step) is included on top of the API purely to make that architecture demoable in a browser.

## Why FP (`Either`/`TaskEither`) instead of `try/catch`?

Payment routing is exactly the kind of domain where exceptions are the wrong tool:

- **Auditability.** A declined payment, a timed-out PSP, and a circuit-open PSP are all *expected*, *routine* outcomes — not exceptional ones. Modeling them as `Left<PaymentError>` values means every failure is a typed, inspectable piece of data that gets logged and returned to the caller, instead of a stack unwind that's easy to swallow or forget to log.
- **No silent failures.** With `try/catch`, it's trivial to catch too broadly, forget a case, or let an error escape a `.then()` unnoticed. `Either`/`TaskEither` make the failure channel part of the function's *type* — TypeScript won't let you ignore it, and `fp-ts`'s combinators (`chain`, `fold`, `match`) force you to handle both branches explicitly.
- **Composability.** The whole routing pipeline is `pipe(validate, selectRoute, ...)` — small pure functions glued together. Exceptions don't compose this way; a `throw` three functions deep silently breaks the chain. An `Either` short-circuits predictably and explicitly, the same way `null`-propagation or `?` operators do in other languages.
- **Zero-mock testing.** Because the routing/ranking/circuit-breaker logic never touches the network, the clock (except as an explicit argument), or a database, every domain test in [`tests/rules.test.ts`](tests/rules.test.ts), [`tests/circuitBreaker.test.ts`](tests/circuitBreaker.test.ts), and [`tests/router.test.ts`](tests/router.test.ts) is a plain `expect(fn(input)).toEqual(output)` — no test doubles, no `vi.mock`, nothing to keep in sync with the implementation.

In short: for a system where "we silently lost track of a declined payment" is a much worse bug than "the code is a bit more verbose," representing failure as data is worth the ceremony.

## Architecture

```
                          POST /transactions
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │   Idempotency check      │  effects/store.ts
                    │  (same key => replay)     │
                    └──────────────┬───────────┘
                                   │ new request
                                   ▼
                    ┌─────────────────────────┐
                    │      Validation           │  domain/rules.ts
                    │  (shape + business rules) │  Either<PaymentError, Request>
                    └──────────────┬───────────┘
                                   │ Right
                                   ▼
                    ┌─────────────────────────┐
                    │     PSP Selection         │  domain/rules.ts + router.ts
                    │  filter eligible + healthy │  Either<PaymentError,
                    │  rank by success rate      │         PspConfig[]>
                    └──────────────┬───────────┘
                                   │ Right(ranked candidates)
                                   ▼
                    ┌─────────────────────────┐
              ┌────▶│   Execution (attempt N)   │  effects/executor.ts
              │     │  call PSP -> TaskEither    │  effects/pspClients.ts
              │     └──────────────┬───────────┘
              │                    │
              │           success  │  failure
              │                    │
              │      ┌─────────────┴─────────────┐
              │      ▼                            ▼
              │  Succeeded                update circuit breaker
              │                                    │
              │                          attempts < MAX_RETRIES (3)
              │                          and PSPs remain?
              │                                    │
              └────────────── yes ─────────────────┘
                                    │ no
                                    ▼
                              DeadLettered
                                    │
                                    ▼
                    ┌─────────────────────────┐
                    │   Persist + Respond        │  effects/store.ts
                    │   TransactionRecord (JSON) │
                    └─────────────────────────┘
```

Every box left of "Execution" is pure — no I/O, fully unit-tested with plain inputs/outputs. "Execution" and everything after it is the *impure shell*: it's where `TaskEither` wraps the simulated network calls, and where the (single, clearly-commented) mutable `Map`s live.

### Module map

| File | Role |
|---|---|
| [`src/domain/types.ts`](src/domain/types.ts) | ADTs: `TransactionState`, `PaymentError`, `PspConfig`, etc. |
| [`src/domain/rules.ts`](src/domain/rules.ts) | Pure PSP eligibility/ranking rules |
| [`src/domain/circuitBreaker.ts`](src/domain/circuitBreaker.ts) | Pure circuit breaker state machine |
| [`src/domain/router.ts`](src/domain/router.ts) | Composes validation + selection into one pipeline |
| [`src/effects/pspClients.ts`](src/effects/pspClients.ts) | Mock PSPs — the only file that simulates network I/O |
| [`src/effects/store.ts`](src/effects/store.ts) | In-memory transaction log + idempotency index |
| [`src/effects/breakerStore.ts`](src/effects/breakerStore.ts) | In-memory holder for per-PSP breaker state |
| [`src/effects/executor.ts`](src/effects/executor.ts) | Orchestrates retry/failover, the "impure shell" |
| [`src/http/routes.ts`](src/http/routes.ts) | Thin Express routes — no business logic |
| [`src/index.ts`](src/index.ts) | Wiring + PSP catalogue + `app.listen` + static UI |
| [`public/index.html`](public/index.html), [`public/app.js`](public/app.js), [`public/styles.css`](public/styles.css) | Static browser UI — plain HTML/CSS/JS, served by Express, calls the API with `fetch()` |

## How the circuit breaker works

Each PSP has its own independent breaker, modeled as a pure state machine in [`domain/circuitBreaker.ts`](src/domain/circuitBreaker.ts):

```
Closed ──(≥3 failures within a 60s rolling window)──▶ Open
Open ──(15s cooldown elapses)──▶ HalfOpen
HalfOpen ──(probe call succeeds)──▶ Closed   (fully healed, failure count reset)
HalfOpen ──(probe call fails)────▶ Open      (re-trip immediately, new cooldown)
```

- **Closed**: normal operation. Failures accumulate as timestamps; a *success does not reset the counter* — only failures aging out of the rolling window do. This matches "fails more than N times in a window," not "N consecutive failures," so a PSP that's flaky but not fully down still trips.
- **Open**: the PSP is skipped entirely during routing (`isCallAllowed` returns `false`, so `domain/rules.ts` filters it out of the candidate list).
- **HalfOpen**: purely a function of elapsed time (`now - openedAt >= cooldownMs`) — there's no background timer or cron job. The very next routing decision after the cooldown automatically lets one probe call through. This is the "self-healing" part: a recovered PSP starts receiving traffic again with no operator intervention.

Watch it live via `GET /psp/health` (see below).

## How idempotency is handled

Payment APIs sit behind unreliable networks, so clients retry. A naive retry would risk calling a PSP — and potentially charging a customer — twice for one logical payment. PayRoute requires an `idempotencyKey` on every request:

```ts
// effects/store.ts / effects/executor.ts
const existing = store.getByIdempotencyKey(request.idempotencyKey);
if (O.isSome(existing)) {
  return existing.value; // original result, verbatim — no PSP is called again
}
```

The very first thing `processTransaction` does is check the store for that key. If it's already been processed, the **original** `TransactionRecord` — same id, same final state, same attempt history — is returned immediately, with zero PSP calls made. This is checked before validation even runs, so a duplicate is caught as cheaply as possible.

## Retry & failover

- `domain/rules.ts` ranks eligible, healthy PSPs best-first by historical success rate (ties broken by configured priority).
- `effects/executor.ts` calls the top-ranked PSP. On failure, it records the failure against that PSP's circuit breaker and immediately fails over to the next-ranked candidate.
- Capped at `MAX_RETRIES = 3` attempts total (see `domain/types.ts`). If every attempt fails (or fewer than 3 candidates exist and they're all exhausted), the transaction is marked `DeadLettered` with the last error attached — never thrown, never lost.

## Running it

```bash
npm install
npm run dev      # tsx watch — auto-restarts on save
# or
npm run build && npm start
```

Server listens on `http://localhost:3000` (override with `PORT`). Open that URL in a browser for the UI: a form to submit a payment (with quick presets to trigger failover/circuit-breaker scenarios), a live PSP health panel, and a transaction history table with expandable attempt timelines — all driven by the same 4 endpoints below.

### Run the tests

```bash
npm test
```

29 tests: pure unit tests for routing rules, circuit breaker transitions, and the composed pipeline (no mocking needed — see [Why FP](#why-fp-eithertaskeither-instead-of-trycatch)), plus an integration test that drives a real transaction through PSP1 → fails → PSP2 → fails → PSP3 → succeeds.

## API walkthrough

### 1. Submit a payment

```bash
curl -s -X POST localhost:3000/transactions \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"order-42","amount":250,"currency":"USD","method":"card"}' | python3 -m json.tool
```

Returns the full `TransactionRecord`, including which PSP(s) were tried:

```json
{
  "id": "30ab2861-...",
  "request": { "idempotencyKey": "order-42", "amount": 250, "currency": "USD", "method": "card" },
  "attempts": [
    { "pspId": "PSP_DELTA", "outcome": "success", "latencyMs": 139, "at": 1787042787228 }
  ],
  "state": { "_tag": "Succeeded", "pspId": "PSP_DELTA", "attempt": 1 }
}
```

### 2. See failover happen live

`PSP_ALPHA` (55% success) and friends are configured with deliberately different reliabilities (see `pspCatalogue` in [`src/index.ts`](src/index.ts)). Send a request whose amount excludes the most reliable PSP (`PSP_DELTA`'s limit is 20,000) to force a livelier ranking, and fire a batch:

```bash
for i in $(seq 1 10); do
  curl -s -X POST localhost:3000/transactions \
    -H 'Content-Type: application/json' \
    -d "{\"idempotencyKey\":\"batch-$i\",\"amount\":30000,\"currency\":\"USD\",\"method\":\"card\"}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['state']['_tag'], [(a['pspId'], a['outcome']) for a in d['attempts']])"
done
```

Occasionally you'll see a multi-attempt line like:

```
Succeeded [('PSP_GAMMA', 'failure'), ('PSP_BETA', 'success')]
```

— `PSP_GAMMA` declined, and the engine automatically failed over to `PSP_BETA` in the same request.

### 3. Watch a PSP trip and self-heal

Fire enough load to accumulate 3+ failures on a PSP within the 60s window, then check its breaker:

```bash
for i in $(seq 1 60); do
  curl -s -X POST localhost:3000/transactions -H 'Content-Type: application/json' \
    -d "{\"idempotencyKey\":\"load-$i\",\"amount\":30000,\"currency\":\"USD\",\"method\":\"card\"}" > /dev/null
done

curl -s localhost:3000/psp/health | python3 -m json.tool
```

```json
[
  { "pspId": "PSP_GAMMA", "status": "Open", "recentFailures": 3, "openedAt": 1787042961958 },
  { "pspId": "PSP_DELTA", "status": "Closed", "recentFailures": 0, "openedAt": null }
]
```

Wait 15+ seconds (the cooldown) and submit one more request in range — the next routing decision automatically treats the PSP as `HalfOpen`, lets a probe call through, and closes the breaker again on success, with no restart or manual reset:

```bash
curl -s localhost:3000/psp/health | python3 -m json.tool
# => "status": "Closed" again
```

### 4. Idempotent replay

```bash
curl -s -X POST localhost:3000/transactions \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"order-42","amount":250,"currency":"USD","method":"card"}'
```

Same `idempotencyKey` as step 1 → returns the **exact same** `TransactionRecord` (same `id`), with no new PSP call made.

### 5. Look up a transaction

```bash
curl -s localhost:3000/transactions/30ab2861-3179-47c1-8b68-1eeca3ac5760 | python3 -m json.tool
```

Returns the full history: every attempt, which PSP, outcome, and latency, plus the final state.

### 6. List all transactions

```bash
curl -s localhost:3000/transactions | python3 -m json.tool
```

Not one of the original 3 core endpoints, but a trivial read of the existing store, newest first — added to back the UI's history table.

## What's deliberately left out

No database (an in-memory `Map` is enough to demonstrate the logic), no auth, no frontend, no real PSP integrations — this is a focused demonstration of routing/failover/circuit-breaker/idempotency architecture, not a production payment system.
