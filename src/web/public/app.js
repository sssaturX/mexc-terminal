const form = document.querySelector("#configForm");
const logsEl = document.querySelector("#logs");
const strategySelect = form.elements.strategyName;
const strategyParamsEl = document.querySelector("#strategyParams");
const accountsListEl = document.querySelector("#accountsList");
const accountsStatusEl = document.querySelector("#accountsStatus");
const scannerTopEl = document.querySelector("#scannerTop");
const scannerAlertsEl = document.querySelector("#scannerAlerts");
const scannerStateEl = document.querySelector("#scannerState");
let strategies = [];
let eventsBound = false;
let eventsConnected = false;
let accountCounter = 0;

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

const scannerDefaults = {
  symbols: "BTC_USDT, ETH_USDT, SOL_USDT, DOGE_USDT, PEPE_USDT",
  executionMode: "scanner",
  equityUsdt: 75,
  riskPct: 1.2,
  leverage: 15,
  maxFocusedSymbols: 12,
  minGrade: "A",
  tickIntervalMs: 2000,
  strictZeroFee: false
};

boot();

async function boot() {
  const data = await api("/api/bootstrap");
  strategies = data.strategies;
  fillStrategies();
  fillSymbols(data.symbols, data.saved?.symbol);
  fillSaved(data.saved);
  renderParams();
  if (!eventsBound) {
    bindEvents();
    eventsBound = true;
  }
  connectEvents();
  updateStatus(data.status);
  updateScanner(data.scanner);
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
  const accounts = normalizeAccounts(saved);
  renderAccounts(accounts);
  form.elements.authToken.value = accounts.find((account) => account.role === "master")?.authToken || saved.authToken || "";
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
  const scanner = saved.scanner || {};
  form.elements.scannerSymbols.value = (scanner.symbols || scannerDefaults.symbols).toString();
  form.elements.scannerExecutionMode.value = scanner.executionMode || scannerDefaults.executionMode;
  form.elements.scannerEquityUsdt.value = scanner.equityUsdt || scannerDefaults.equityUsdt;
  form.elements.scannerRiskPct.value = scanner.riskPct || scannerDefaults.riskPct;
  form.elements.scannerLeverage.value = scanner.leverage || scannerDefaults.leverage;
  form.elements.scannerMaxFocusedSymbols.value = scanner.maxFocusedSymbols || scannerDefaults.maxFocusedSymbols;
  form.elements.scannerMinGrade.value = scanner.minGrade || scannerDefaults.minGrade;
  form.elements.scannerTickIntervalMs.value = scanner.tickIntervalMs || scannerDefaults.tickIntervalMs;
  form.elements.scannerStrictZeroFee.checked = Boolean(scanner.strictZeroFee ?? scannerDefaults.strictZeroFee);
}

function bindEvents() {
  strategySelect.addEventListener("change", renderParams);
  document.querySelector("#addAccount").addEventListener("click", () => {
    const accounts = readAccounts();
    accounts.push({
      id: nextAccountId(),
      name: `Account ${accounts.length + 1}`,
      authToken: "",
      role: accounts.length === 0 ? "master" : "slave"
    });
    renderAccounts(accounts);
  });
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
  document.querySelector("#startScannerBtn").addEventListener("click", async () => {
    setScannerBusy(true);
    try {
      const data = await api("/api/scanner/start", "POST", collectScannerConfig());
      updateScanner(data.scanner);
    } catch (error) {
      addLog({ level: "ERROR", message: error.message, timestamp: new Date().toISOString() });
    } finally {
      setScannerBusy(false);
    }
  });
  document.querySelector("#stopScannerBtn").addEventListener("click", async () => {
    const data = await api("/api/scanner/stop", "POST", {});
    updateScanner(data.scanner);
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

function normalizeAccounts(saved = {}) {
  const savedAccounts = Array.isArray(saved.accounts) ? saved.accounts : [];
  const accounts = savedAccounts
    .map((account, index) => ({
      id: String(account.id || `account-${index + 1}`),
      name: String(account.name || `Account ${index + 1}`),
      authToken: String(account.authToken || ""),
      role: account.id === saved.masterAccountId || account.role === "master" ? "master" : "slave"
    }))
    .filter((account) => account.authToken || account.name);

  if (accounts.length === 0) {
    accounts.push({
      id: "master",
      name: "Master",
      authToken: saved.authToken || "",
      role: "master"
    });
  }

  const master = accounts.find((account) => account.role === "master") || accounts[0];
  return accounts.map((account) => ({
    ...account,
    role: account.id === master.id ? "master" : "slave"
  }));
}

function renderAccounts(accounts) {
  accountsListEl.innerHTML = "";
  for (const account of accounts) {
    accountsListEl.appendChild(createAccountRow(account, accounts.length));
  }
}

function createAccountRow(account, totalAccounts) {
  const row = document.createElement("div");
  row.className = "account-row";
  row.dataset.accountId = account.id;

  const masterLabel = document.createElement("label");
  masterLabel.className = "account-master";
  const masterInput = document.createElement("input");
  masterInput.type = "radio";
  masterInput.name = "masterAccount";
  masterInput.checked = account.role === "master";
  masterInput.addEventListener("change", () => {
    const accounts = readAccounts().map((item) => ({
      ...item,
      role: item.id === account.id ? "master" : "slave"
    }));
    renderAccounts(accounts);
  });
  masterLabel.append(masterInput, "Master");

  const nameLabel = document.createElement("label");
  const nameSpan = document.createElement("span");
  nameSpan.textContent = "Account name";
  const nameInput = document.createElement("input");
  nameInput.name = "accountName";
  nameInput.value = account.name;
  nameInput.placeholder = "Account name";
  nameLabel.append(nameSpan, nameInput);

  const tokenLabel = document.createElement("label");
  const tokenSpan = document.createElement("span");
  tokenSpan.textContent = "WEB token";
  const tokenInput = document.createElement("input");
  tokenInput.name = "accountToken";
  tokenInput.type = "password";
  tokenInput.autocomplete = "off";
  tokenInput.value = account.authToken;
  tokenInput.placeholder = "Browser WEB token";
  tokenLabel.append(tokenSpan, tokenInput);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "ghost";
  removeButton.textContent = "Remove";
  removeButton.disabled = totalAccounts <= 1;
  removeButton.addEventListener("click", () => {
    const remaining = readAccounts().filter((item) => item.id !== account.id);
    if (!remaining.some((item) => item.role === "master") && remaining[0]) {
      remaining[0].role = "master";
    }
    renderAccounts(remaining);
  });

  row.append(masterLabel, nameLabel, tokenLabel, removeButton);
  return row;
}

function readAccounts() {
  const rows = [...accountsListEl.querySelectorAll(".account-row")];
  const checkedId = accountsListEl.querySelector('input[name="masterAccount"]:checked')?.closest(".account-row")?.dataset.accountId;
  return rows.map((row, index) => {
    const id = row.dataset.accountId || `account-${index + 1}`;
    return {
      id,
      name: row.querySelector('[name="accountName"]').value.trim() || `Account ${index + 1}`,
      authToken: row.querySelector('[name="accountToken"]').value.trim(),
      role: id === checkedId ? "master" : "slave"
    };
  });
}

function nextAccountId() {
  accountCounter += 1;
  return `account-${Date.now()}-${accountCounter}`;
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
  const accounts = readAccounts();
  const master = accounts.find((account) => account.role === "master") || accounts[0];
  const strategyParams = {};
  new FormData(form).forEach((value, key) => {
    if (key.startsWith("strategy.")) {
      const param = key.replace("strategy.", "");
      strategyParams[param] = Number.isNaN(Number(value)) ? String(value) : Number(value);
    }
  });
  const dryRun = form.elements.dryRun.checked;
  return {
    authToken: master?.authToken || form.elements.authToken.value,
    accounts,
    masterAccountId: master?.id,
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

function collectScannerConfig() {
  const accounts = readAccounts();
  const master = accounts.find((account) => account.role === "master") || accounts[0];
  return {
    authToken: master?.authToken || form.elements.authToken.value,
    accounts,
    masterAccountId: master?.id,
    scanner: {
      symbols: form.elements.scannerSymbols.value,
      executionMode: form.elements.scannerExecutionMode.value,
      equityUsdt: Number(form.elements.scannerEquityUsdt.value),
      riskPct: Number(form.elements.scannerRiskPct.value),
      leverage: Number(form.elements.scannerLeverage.value),
      maxFocusedSymbols: Number(form.elements.scannerMaxFocusedSymbols.value),
      minGrade: form.elements.scannerMinGrade.value,
      tickIntervalMs: Number(form.elements.scannerTickIntervalMs.value),
      strictZeroFee: form.elements.scannerStrictZeroFee.checked,
      dryRun: form.elements.dryRun.checked,
      debug: form.elements.debug.checked
    }
  };
}

function targetKey(prefix, mode) {
  if (mode === "profitUsdt") return `${prefix}Usdt`;
  if (mode === "roePercent") return `${prefix}RoePercent`;
  return `${prefix}PricePercent`;
}

function connectEvents() {
  if (eventsConnected) {
    return;
  }
  eventsConnected = true;
  const events = new EventSource("/events");
  events.addEventListener("log", (event) => addLog(JSON.parse(event.data)));
  events.addEventListener("status", (event) => updateStatus(JSON.parse(event.data)));
  events.addEventListener("scanner", (event) => updateScanner(JSON.parse(event.data)));
}

function updateStatus(status) {
  const running = Boolean(status?.running);
  const runState = document.querySelector("#runState");
  runState.textContent = running ? (status.dryRun ? "DRY-RUN" : "LIVE") : "Stopped";
  runState.classList.toggle("running", running);
  document.querySelector("#price").textContent = status?.price ?? "-";
  const aggregate = status?.aggregate || {};
  const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
  document.querySelector("#position").textContent = `${aggregate.activePositions || 0}/${aggregate.accounts || accounts.length || 0} active`;
  const pnl = Number(aggregate.totalPnl ?? status?.unrealizedPnl ?? 0);
  const pnlEl = document.querySelector("#pnl");
  pnlEl.textContent = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT`;
  pnlEl.className = pnl >= 0 ? "positive" : "negative";
  const risk = status?.risk || {};
  document.querySelector("#trades").textContent = `${formatPercent(aggregate.roiPercent || 0)} / T${risk.tradesOpened || 0} ${risk.wins || 0}-${risk.losses || 0}`;
  renderAccountStatus(accounts);
}

function renderAccountStatus(accounts) {
  if (!accountsStatusEl) {
    return;
  }
  accountsStatusEl.innerHTML = "";
  if (accounts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No account group running";
    accountsStatusEl.appendChild(empty);
    return;
  }

  for (const account of accounts) {
    const card = document.createElement("div");
    card.className = "account-card";

    const head = document.createElement("div");
    head.className = "account-card-head";
    const name = document.createElement("strong");
    name.textContent = `${account.name} ${account.role === "master" ? "(master)" : "(slave)"}`;
    const state = document.createElement("span");
    state.textContent = account.running ? "running" : "stopped";
    head.append(name, state);

    const pnl = Number(account.totalPnl || 0);
    const stats = document.createElement("div");
    stats.className = "account-card-stats";
    const pnlLabel = document.createElement("strong");
    pnlLabel.className = pnl >= 0 ? "positive" : "negative";
    pnlLabel.textContent = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT`;
    const roiLabel = document.createElement("span");
    roiLabel.textContent = `${formatPercent(account.roiPercent || 0)} ROI`;
    stats.append(pnlLabel, roiLabel);

    const position = document.createElement("div");
    position.className = "hint";
    position.textContent = account.position
      ? `${account.position.side} ${account.position.symbol} @ ${account.position.entryPrice}`
      : `No active position | T${account.risk?.tradesOpened || 0} W-L ${account.risk?.wins || 0}-${account.risk?.losses || 0}`;

    card.append(head, stats, position);
    accountsStatusEl.appendChild(card);
  }
}

function updateScanner(scanner) {
  if (!scanner || !scannerTopEl || !scannerAlertsEl) {
    return;
  }
  scannerStateEl.textContent = scanner.running
    ? `${scanner.mode === "semi_auto" ? "Semi-auto" : "Scanner"} ${scanner.wsConnected ? "WS" : "REST"}`
    : "Stopped";
  renderScannerTop(scanner.topSymbols || []);
  renderScannerAlerts(scanner.alerts || []);
}

function renderScannerTop(items) {
  scannerTopEl.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No ranked symbols yet";
    scannerTopEl.appendChild(empty);
    return;
  }
  for (const item of items.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "scanner-item";
    row.innerHTML = `
      <div class="scanner-item-head">
        <strong>${escapeHtml(item.symbol)}</strong>
        <span class="grade">${item.profile === "liquid_major" ? "LIQ" : "EVENT"}</span>
      </div>
      <div class="scanner-item-stats">
        <span>Score ${Number(item.score || 0).toFixed(2)}</span>
        <span>Spread ${(Number(item.spreadPct || 0) * 100).toFixed(3)}%</span>
      </div>
      <div class="scanner-item-stats">
        <span>Price ${formatNumber(item.price)}</span>
        <span>24h ${formatCompact(item.amount24)} USDT</span>
      </div>
    `;
    scannerTopEl.appendChild(row);
  }
}

function renderScannerAlerts(alerts) {
  scannerAlertsEl.innerHTML = "";
  const visible = alerts.filter((alert) => alert.status === "new" || alert.status === "executed").slice(0, 12);
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No active alerts";
    scannerAlertsEl.appendChild(empty);
    return;
  }
  for (const alert of visible) {
    const row = document.createElement("div");
    row.className = "scanner-item";
    const pnlClass = alert.side === "LONG" ? "positive" : "negative";
    row.innerHTML = `
      <div class="scanner-item-head">
        <strong>${escapeHtml(alert.symbol)} <span class="${pnlClass}">${alert.side}</span></strong>
        <span class="grade">${alert.grade}</span>
      </div>
      <div class="scanner-item-stats">
        <span>${alert.setup}</span>
        <span>Score ${Number(alert.score || 0).toFixed(2)}</span>
      </div>
      <div class="scanner-item-stats">
        <span>Entry ${formatNumber(alert.entry)}</span>
        <span>Stop ${formatNumber(alert.stop)}</span>
      </div>
      <div class="scanner-item-stats">
        <span>TP1 ${formatNumber(alert.tp1)}</span>
        <span>TP2 ${formatNumber(alert.tp2)}</span>
      </div>
      <div class="scanner-item-reason">Risk ${Number(alert.riskUsdt || 0).toFixed(2)} USDT | Margin ${Number(alert.requiredMargin || 0).toFixed(2)} @${alert.leverage}x</div>
    `;
    const actions = document.createElement("div");
    actions.className = "scanner-item-actions";
    const status = document.createElement("span");
    status.className = "hint";
    status.textContent = alert.status;
    const execute = document.createElement("button");
    execute.type = "button";
    execute.className = "ghost";
    execute.textContent = "Execute";
    execute.disabled = alert.status !== "new";
    execute.addEventListener("click", async () => {
      execute.disabled = true;
      try {
        const result = await api("/api/scanner/execute", "POST", { alertId: alert.id });
        addLog({ level: "INFO", message: `Scanner executed ${result.alert.symbol} ${result.alert.side}`, timestamp: new Date().toISOString() });
      } catch (error) {
        addLog({ level: "ERROR", message: error.message, timestamp: new Date().toISOString() });
      }
    });
    actions.append(status, execute);
    row.appendChild(actions);
    scannerAlertsEl.appendChild(row);
  }
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

function setScannerBusy(value) {
  document.querySelector("#startScannerBtn").disabled = value;
}

function pricePercentToUsdt(pricePercent, margin, leverage) {
  return Number(((margin * leverage * pricePercent) / 100).toFixed(4));
}

function formatPercent(value) {
  const numberValue = Number(value || 0);
  return `${numberValue >= 0 ? "+" : ""}${numberValue.toFixed(2)}%`;
}

function formatNumber(value) {
  const numberValue = Number(value || 0);
  if (Math.abs(numberValue) >= 1) {
    return numberValue.toFixed(4);
  }
  return numberValue.toFixed(8);
}

function formatCompact(value) {
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
