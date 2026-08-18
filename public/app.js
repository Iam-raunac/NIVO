// Plain vanilla JS — no build step, no framework. Talks to the PayRoute
// API (POST /transactions, GET /transactions, GET /transactions/:id,
// GET /psp/health) with fetch() and renders the responses directly.

const $ = (selector) => document.querySelector(selector);

const form = $("#payment-form");
const amountInput = $("#amount");
const currencyInput = $("#currency");
const methodInput = $("#method");
const keyInput = $("#idempotencyKey");
const submitBtn = $("#submit-btn");
const resultBox = $("#result");
const healthCards = $("#health-cards");
const historyTable = $("#history-table");

const genKey = () => (crypto.randomUUID ? crypto.randomUUID() : `key-${Date.now()}-${Math.random().toString(16).slice(2)}`);

keyInput.value = genKey();
$("#regen-key").addEventListener("click", () => {
  keyInput.value = genKey();
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    amountInput.value = chip.dataset.amount;
    methodInput.value = chip.dataset.method;
  });
});

const stateBadgeClass = (tag) => `badge badge-${tag.toLowerCase()}`;
const outcomeBadgeClass = (outcome) => `badge badge-${outcome}`;
const breakerBadgeClass = (status) => `badge badge-${status.toLowerCase()}`;

const fmtTime = (ms) => new Date(ms).toLocaleTimeString();

const describeState = (state) => {
  switch (state._tag) {
    case "Succeeded":
      return `succeeded on ${state.pspId} (attempt ${state.attempt})`;
    case "DeadLettered":
      return `dead-lettered after ${state.attempts} attempts — ${state.lastError._tag}`;
    case "Failed":
      return `failed — ${state.error._tag}: ${state.error.message ?? ""}`;
    default:
      return state._tag;
  }
};

function renderAttempts(attempts) {
  if (attempts.length === 0) {
    return '<p class="empty">No PSP was called (rejected before routing).</p>';
  }
  return `<ul class="attempt-list">${attempts
    .map(
      (a) => `<li>
        <span class="${outcomeBadgeClass(a.outcome)}">${a.outcome}</span>
        <span>${a.pspId}</span>
        <span style="color:var(--text-muted)">${a.latencyMs}ms · ${fmtTime(a.at)}</span>
        ${a.error ? `<span style="color:var(--red)">(${a.error._tag})</span>` : ""}
      </li>`,
    )
    .join("")}</ul>`;
}

function renderResult(record) {
  resultBox.hidden = false;
  resultBox.innerHTML = `
    <div class="result-header">
      <span class="${stateBadgeClass(record.state._tag)}">${record.state._tag}</span>
      <span class="result-id">${record.id}</span>
    </div>
    <div>${describeState(record.state)}</div>
    ${renderAttempts(record.attempts)}
  `;
}

function renderError(message) {
  resultBox.hidden = false;
  resultBox.innerHTML = `<div class="error-box">${message}</div>`;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitBtn.disabled = true;
  submitBtn.textContent = "Routing…";

  const body = {
    idempotencyKey: keyInput.value.trim(),
    amount: Number(amountInput.value),
    currency: currencyInput.value,
    method: methodInput.value,
  };

  try {
    const res = await fetch("/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok && data.error) {
      renderError(`${data.error._tag}: ${data.error.message ?? "request rejected"}`);
    } else {
      renderResult(data);
      keyInput.value = genKey(); // fresh key so the next submit isn't an accidental replay
    }

    await Promise.all([loadHealth(), loadHistory()]);
  } catch (err) {
    renderError(`Network error: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit transaction";
  }
});

async function loadHealth() {
  const res = await fetch("/psp/health");
  const pspList = await res.json();

  healthCards.innerHTML = pspList
    .map(
      (p) => `
      <div class="health-card">
        <div class="psp-id">${p.pspId}</div>
        <span class="${breakerBadgeClass(p.status)}">${p.status}</span>
        <div class="failures">${p.recentFailures} recent failure${p.recentFailures === 1 ? "" : "s"}</div>
      </div>`,
    )
    .join("");
}

async function loadHistory() {
  const res = await fetch("/transactions");
  const records = await res.json();

  if (records.length === 0) {
    historyTable.innerHTML = '<p class="empty">No transactions yet — submit one above.</p>';
    return;
  }

  const rows = records
    .map(
      (r, i) => `
      <tr class="history-row" data-index="${i}">
        <td class="mono">${r.id.slice(0, 8)}…</td>
        <td>${r.request.amount} ${r.request.currency}</td>
        <td>${r.request.method}</td>
        <td><span class="${stateBadgeClass(r.state._tag)}">${r.state._tag}</span></td>
        <td>${r.attempts.length}</td>
        <td>${fmtTime(r.createdAt)}</td>
      </tr>
      <tr class="detail-row" data-detail-for="${i}" hidden>
        <td colspan="6">${renderAttempts(r.attempts)}</td>
      </tr>`,
    )
    .join("");

  historyTable.innerHTML = `
    <table>
      <thead>
        <tr><th>ID</th><th>Amount</th><th>Method</th><th>State</th><th>Attempts</th><th>Created</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  historyTable.querySelectorAll(".history-row").forEach((row) => {
    row.addEventListener("click", () => {
      const detail = historyTable.querySelector(`[data-detail-for="${row.dataset.index}"]`);
      detail.hidden = !detail.hidden;
    });
  });
}

$("#refresh-health").addEventListener("click", loadHealth);
$("#refresh-history").addEventListener("click", loadHistory);

loadHealth();
loadHistory();
setInterval(loadHealth, 3000);
