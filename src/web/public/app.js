const form = document.querySelector("#configForm");
const logsEl = document.querySelector("#logs");
const strategySelect = form.elements.strategyName;
const strategyParamsEl = document.querySelector("#strategyParams");
let strategies = [];

const defaults = {
  margin: 10,
  leverage: 10,
  directionMode: "both",
  takeProfitMode: "profitUsdt",
  takeProfitValue: 0.2,
  stopLossMode: "profitUsdt",
  stopLossValue: 0.1,
  manualStopLossRoePercent: 1,
  trailStartPercent: 0.1,
  trailDistancePercent: 0.05,
  chaseActivationPercent: 0.1,
  chaseDistancePercent: 0.05,
  maxTradesPerSession: 5,
  maxConsecutiveLosses: 1,
  maxDailyLoss: 5,
  cooldownSeconds: 0,
  tickIntervalMs: 2000,
  dryRun: true
};

boot();

async function boot() {
  const data = await api("/api/bootstrap");
  strategies = data.strategies;
  fillStrategies();
  fillSymbols(data.symbols, data.saved?.symbol);
  fillSaved(data.saved);
  renderParams();
  bindEvents();
  connectEvents();
  updateStatus(data.status);
}

function fillStrategies() {
  strategySelect.innerHTML = strategies
    .map((strategy) => `<option value="${strategy.name}">${strategy.name}</option>`)
    .join("");
}

function fillSymbols(symbols, current) {
  const select = form.elements.symbolSelect;
  select.innerHTML = [...new Set([current, ...(symbols || [])].filter(Boolean))]
    .map((symbol) => `<option value="${symbol}">${symbol}</option>`)
    .join("");
  select.insertAdjacentHTML("beforeend", `<option value="custom">Custom...</option>`);
}

function fillSaved(saved = {}) {
  form.elements.authToken.value = saved.authToken || "";
  form.elements.symbol.value = saved.symbol || "BTC_USDT";
  form.elements.margin.value = saved.margin || defaults.margin;
  form.elements.leverage.value = saved.leverage || defaults.leverage;
  form.elements.directionMode.value = saved.directionMode || defaults.directionMode;
  form.elements.takeProfitMode.value = defaults.takeProfitMode;
  form.elements.takeProfitValue.value = pricePercentToUsdt(saved.takeProfitPercent || 0.2, saved.margin || 10, saved.leverage || 10);
  form.elements.stopLossMode.value = defaults.stopLossMode;
  form.elements.stopLossValue.value = pricePercentToUsdt(saved.stopLossPercent || 0.15, saved.margin || 10, saved.leverage || 10);
  form.elements.manualStopLossRoePercent.value = saved.manualStopLossRoePercent || defaults.manualStopLossRoePercent;
  form.elements.trailingEnabled.checked = Boolean(saved.trailingTakeProfit?.enabled);
  form.elements.trailStartPercent.value = saved.trailingTakeProfit?.activationProfitPercent || defaults.trailStartPercent;
  form.elements.trailDistancePercent.value = saved.trailingTakeProfit?.distancePercent || defaults.trailDistancePercent;
  form.elements.chasingEnabled.checked = Boolean(saved.chasingTakeProfit?.enabled);
  form.elements.chaseActivationPercent.value = saved.chasingTakeProfit?.activationProfitPercent || defaults.chaseActivationPercent;
  form.elements.chaseDistancePercent.value = saved.chasingTakeProfit?.chaseDistancePercent || defaults.chaseDistancePercent;
  form.elements.maxTradesPerSession.value = saved.maxTradesPerSession || defaults.maxTradesPerSession;
  form.elements.maxConsecutiveLosses.value = saved.maxConsecutiveLosses || defaults.maxConsecutiveLosses;
  form.elements.maxDailyLoss.value = saved.maxDailyLoss || defaults.maxDailyLoss;
  form.elements.cooldownSeconds.value = saved.cooldownMs ? saved.cooldownMs / 1000 : defaults.cooldownSeconds;
  form.elements.tickIntervalMs.value = saved.tickIntervalMs || defaults.tickIntervalMs;
  form.elements.dryRun.checked = saved.dryRun ?? true;
  form.elements.debug.checked = Boolean(saved.debug);
}

function bindEvents() {
  strategySelect.addEventListener("change", renderParams);
  form.elements.symbolSelect.addEventListener("change", () => {
    if (form.elements.symbolSelect.value !== "custom") {
      form.elements.symbol.value = form.elements.symbolSelect.value;
    } else {
      form.elements.symbol.focus();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/start", "POST", collectConfig());
    } catch (error) {
      addLog({ level: "ERROR", message: error.message, timestamp: new Date().toISOString() });
    } finally {
      setBusy(false);
    }
  });
  document.querySelector("#stopBtn").addEventListener("click", async () => {
    await api("/api/stop", "POST", {});
  });
  document.querySelector("#reloadSaved").addEventListener("click", boot);
  document.querySelector("#clearLogs").addEventListener("click", () => {
    logsEl.innerHTML = "";
  });
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api("/api/manual", "POST", { action: button.dataset.action });
    });
  });
}

function renderParams() {
  const selected = strategies.find((strategy) => strategy.name === strategySelect.value);
  strategyParamsEl.innerHTML = "";
  for (const param of selected?.params || []) {
    const label = document.createElement("label");
    label.innerHTML = `<span>${param.label}</span>`;
    let input;
    if (param.type === "select") {
      input = document.createElement("select");
      for (const option of param.options || []) {
        input.insertAdjacentHTML("beforeend", `<option value="${option}">${option}</option>`);
      }
      input.value = param.initial;
    } else {
      input = document.createElement("input");
      input.type = "number";
      input.step = "0.001";
      input.value = param.initial;
    }
    input.name = `strategy.${param.name}`;
    label.appendChild(input);
    strategyParamsEl.appendChild(label);
  }
}

function collectConfig() {
  const strategyParams = {};
  new FormData(form).forEach((value, key) => {
    if (key.startsWith("strategy.")) {
      const param = key.replace("strategy.", "");
      strategyParams[param] = Number.isNaN(Number(value)) ? String(value) : Number(value);
    }
  });
  const dryRun = form.elements.dryRun.checked;
  return {
    authToken: form.elements.authToken.value,
    symbol: form.elements.symbol.value,
    margin: Number(form.elements.margin.value),
    leverage: Number(form.elements.leverage.value),
    directionMode: form.elements.directionMode.value,
    strategyName: form.elements.strategyName.value,
    strategyParams,
    takeProfitMode: form.elements.takeProfitMode.value,
    [targetKey("takeProfit", form.elements.takeProfitMode.value)]: Number(form.elements.takeProfitValue.value),
    stopLossMode: form.elements.stopLossMode.value,
    [targetKey("stopLoss", form.elements.stopLossMode.value)]: Number(form.elements.stopLossValue.value),
    manualStopLossRoePercent: Number(form.elements.manualStopLossRoePercent.value),
    trailingEnabled: form.elements.trailingEnabled.checked,
    trailStartPercent: Number(form.elements.trailStartPercent.value),
    trailDistancePercent: Number(form.elements.trailDistancePercent.value),
    chasingEnabled: form.elements.chasingEnabled.checked,
    chaseActivationPercent: Number(form.elements.chaseActivationPercent.value),
    chaseDistancePercent: Number(form.elements.chaseDistancePercent.value),
    maxTradesPerSession: Number(form.elements.maxTradesPerSession.value),
    maxConsecutiveLosses: Number(form.elements.maxConsecutiveLosses.value),
    maxDailyLoss: Number(form.elements.maxDailyLoss.value),
    cooldownSeconds: Number(form.elements.cooldownSeconds.value),
    tickIntervalMs: Number(form.elements.tickIntervalMs.value),
    dryRun,
    debug: form.elements.debug.checked,
    liveConfirmed: dryRun || form.elements.liveConfirmation.value === "YES LIVE"
  };
}

function targetKey(prefix, mode) {
  if (mode === "profitUsdt") return `${prefix}Usdt`;
  if (mode === "roePercent") return `${prefix}RoePercent`;
  return `${prefix}PricePercent`;
}

function connectEvents() {
  const events = new EventSource("/events");
  events.addEventListener("log", (event) => addLog(JSON.parse(event.data)));
  events.addEventListener("status", (event) => updateStatus(JSON.parse(event.data)));
}

function updateStatus(status) {
  const running = Boolean(status?.running);
  const runState = document.querySelector("#runState");
  runState.textContent = running ? (status.dryRun ? "DRY-RUN" : "LIVE") : "Stopped";
  runState.classList.toggle("running", running);
  document.querySelector("#price").textContent = status?.price ?? "-";
  document.querySelector("#position").textContent = status?.position
    ? `${status.position.side} ${status.position.symbol} @ ${status.position.entryPrice}`
    : "none";
  const pnl = Number(status?.unrealizedPnl || 0);
  const pnlEl = document.querySelector("#pnl");
  pnlEl.textContent = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT`;
  pnlEl.className = pnl >= 0 ? "positive" : "negative";
  const risk = status?.risk || {};
  document.querySelector("#trades").textContent = `${risk.tradesOpened || 0} / ${risk.wins || 0}-${risk.losses || 0}`;
}

function addLog(entry) {
  const line = document.createElement("div");
  line.className = `log ${entry.level || "INFO"}`;
  line.textContent = `${new Date(entry.timestamp || Date.now()).toLocaleTimeString()} ${entry.message || ""}`;
  logsEl.appendChild(line);
  logsEl.scrollTop = logsEl.scrollHeight;
}

async function api(url, method = "GET", body) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function setBusy(value) {
  document.querySelector("#startBtn").disabled = value;
}

function pricePercentToUsdt(pricePercent, margin, leverage) {
  return Number(((margin * leverage * pricePercent) / 100).toFixed(4));
}
