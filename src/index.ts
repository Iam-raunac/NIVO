/**
 * App bootstrap: wires the pure domain, the effectful stores/clients, and
 * the thin HTTP layer together. This is the only file that constructs
 * concrete dependencies — everything else receives them as arguments,
 * which is what makes `domain/*` testable with zero mocking and `effects/*`
 * testable by swapping in fake stores/clients.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefaultPspClients } from "./effects/pspClients.js";
import { createBreakerStore } from "./effects/breakerStore.js";
import { createTransactionStore } from "./effects/store.js";
import { createTransactionRouter } from "./http/routes.js";
import type { ExecutorDeps } from "./effects/executor.js";
import type { PspConfig } from "./domain/types.js";

/**
 * Mock PSP catalogue. Success rates and limits are deliberately varied so a
 * demo run visibly exercises ranking, failover, and (with enough traffic)
 * the circuit breaker: PSP_ALPHA is the flakiest, PSP_DELTA the most
 * reliable but narrowly scoped.
 */
export const pspCatalogue: ReadonlyArray<PspConfig> = [
  {
    id: "PSP_ALPHA",
    name: "Alpha Pay",
    supportedMethods: ["card", "upi"],
    minAmount: 1,
    maxAmount: 50_000,
    baseSuccessRate: 0.55,
    priority: 1,
  },
  {
    id: "PSP_BETA",
    name: "Beta Payments",
    supportedMethods: ["card", "upi", "netbanking"],
    minAmount: 1,
    maxAmount: 100_000,
    baseSuccessRate: 0.75,
    priority: 2,
  },
  {
    id: "PSP_GAMMA",
    name: "Gamma Gateway",
    supportedMethods: ["card", "upi", "netbanking", "wallet"],
    minAmount: 1,
    maxAmount: 200_000,
    baseSuccessRate: 0.9,
    priority: 3,
  },
  {
    id: "PSP_DELTA",
    name: "Delta Checkout",
    supportedMethods: ["card", "wallet"],
    minAmount: 1,
    maxAmount: 20_000,
    baseSuccessRate: 0.97,
    priority: 4,
  },
];

const deps: ExecutorDeps = {
  psps: pspCatalogue,
  pspCalls: buildDefaultPspClients(pspCatalogue),
  breaker: createBreakerStore(pspCatalogue.map((p) => p.id)),
  store: createTransactionStore(),
  generateId: randomUUID,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(createTransactionRouter(deps));
// Basic static UI (public/index.html) for exercising the API from a browser.
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = Number(process.env["PORT"] ?? 3000);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`PayRoute listening on http://localhost:${PORT}`);
});
