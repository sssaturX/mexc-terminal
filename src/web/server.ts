import "dotenv/config";
import fs from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { Logger } from "../core/logger";
import { formatConfigCard } from "../core/format";
import { PositionManager } from "../core/position-manager";
import { RiskManager } from "../core/risk-manager";
import { TradingEngine } from "../core/trading-engine";
import { MexcClient } from "../mexc/client";
import { ScannerEngine } from "../scanner/scanner-engine";
import { ScannerConfig } from "../scanner/types";
import { createStrategy, STRATEGY_FACTORIES } from "../strategies";
import { BotConfig, DirectionMode } from "../types";

type SavedWebConfig = Omit<BotConfig, "strategyName" | "strategyParams"> & {
  accounts?: SavedWebAccount[];
  masterAccountId?: string;
  scanner?: SavedScannerConfig;
  symbolHistory?: string[];
};

interface SavedWebAccount {
  id: string;
  name: string;
  authToken: string;
  role: "master" | "slave";
}

interface AccountRuntime {
  account: SavedWebAccount;
  config: BotConfig;
  engine: TradingEngine;
  unsubscribeLogs: () => void;
}

interface SavedScannerConfig {
  symbols?: string[];
  strictZeroFee?: boolean;
  executionMode?: "scanner" | "semi_auto";
  equityUsdt?: number;
  riskPct?: number;
  leverage?: number;
  maxFocusedSymbols?: number;
  minGrade?: "B" | "A" | "A+";
  tickIntervalMs?: number;
}

interface StrategySchema {
  name: string;
  description: string;
  params: Array<{ name: string; label: string; type: "number" | "select"; initial: number | string; options?: string[] }>;
}

const PORT = Number(process.env.WEB_PORT ?? 8787);
const SETTINGS_PATH = path.join(process.cwd(), "config", "settings.json");
const PUBLIC_DIR = path.join(process.cwd(), "src", "web", "public");
const POPULAR_SYMBOLS = [
  "BTC_USDT",
  "ETH_USDT",
  "SOL_USDT",
  "TONCOIN_USDT",
  "XRP_USDT",
  "DOGE_USDT",
  "BNB_USDT",
  "LINK_USDT",
  "ADA_USDT",
  "AVAX_USDT",
  "SUI_USDT",
  "PEPE_USDT"
];

const strategySchemas: StrategySchema[] = [
  schema("RandomCoinflipScalper", [{ name: "probability", label: "Trade probability per tick", type: "number", initial: 0.03 }]),
  schema("MicroImpulseScalper", [
    { name: "impulsePercent", label: "Impulse %", type: "number", initial: 0.08 },
    { name: "windowMs", label: "Window ms", type: "number", initial: 10000 },
    { name: "direction", label: "Direction", type: "select", initial: "both", options: ["both", "long", "short"] }
  ]),
  schema("BreakoutStrategy", [
    { name: "lookbackCandles", label: "Lookback candles", type: "number", initial: 20 },
    { name: "breakoutPercent", label: "Breakout %", type: "number", initial: 0.03 }
  ]),
  schema("FakeBreakoutFade", [
    { name: "lookbackCandles", label: "Lookback candles", type: "number", initial: 20 },
    { name: "returnInsideRangePercent", label: "Return inside range %", type: "number", initial: 0.02 }
  ]),
  schema("RangePingPong", [
    { name: "rangeLookback", label: "Range lookback", type: "number", initial: 30 },
    { name: "entryZonePercent", label: "Entry zone %", type: "number", initial: 15 }
  ]),
  schema("MovingAverageCrossover", [
    { name: "fastPeriod", label: "Fast EMA", type: "number", initial: 9 },
    { name: "slowPeriod", label: "Slow EMA", type: "number", initial: 21 }
  ]),
  schema("RsiReversal", [
    { name: "rsiPeriod", label: "RSI period", type: "number", initial: 14 },
    { name: "oversold", label: "Oversold", type: "number", initial: 30 },
    { name: "overbought", label: "Overbought", type: "number", initial: 70 }
  ]),
  schema("BollingerBandsReversal", [
    { name: "period", label: "Period", type: "number", initial: 20 },
    { name: "deviation", label: "Deviation", type: "number", initial: 2 }
  ]),
  schema("VolumeSpikeStrategy", [
    { name: "volumeMultiplier", label: "Volume multiplier", type: "number", initial: 2 },
    { name: "lookback", label: "Lookback", type: "number", initial: 20 }
  ]),
  schema("LiquiditySweepStrategy", [
    { name: "lookback", label: "Lookback", type: "number", initial: 20 },
    { name: "sweepPercent", label: "Sweep %", type: "number", initial: 0.02 },
    { name: "confirmationTicks", label: "Confirmation ticks", type: "number", initial: 2 }
  ]),
  schema("OrderBookImbalanceScalper", [
    { name: "depthLimit", label: "Depth levels", type: "number", initial: 10 },
    { name: "imbalanceRatio", label: "Imbalance ratio", type: "number", initial: 1.8 }
  ]),
  schema("TrendPullback", [
    { name: "trendEmaPeriod", label: "Trend EMA", type: "number", initial: 50 },
    { name: "pullbackPercent", label: "Pullback %", type: "number", initial: 0.15 }
  ]),
  schema("TrailingBreakout", [
    { name: "lookbackCandles", label: "Lookback candles", type: "number", initial: 20 },
    { name: "breakoutPercent", label: "Breakout %", type: "number", initial: 0.03 },
    { name: "trailStartPercent", label: "Trail activation %", type: "number", initial: 0.1 },
    { name: "trailDistancePercent", label: "Trail distance %", type: "number", initial: 0.05 }
  ]),
  schema("ChasingTakeProfitScalper", [
    { name: "activationProfitPercent", label: "Activation profit %", type: "number", initial: 0.1 },
    { name: "chaseDistancePercent", label: "Chase distance %", type: "number", initial: 0.05 },
    { name: "impulsePercent", label: "Entry impulse %", type: "number", initial: 0.04 }
  ]),
  schema("ManualConsoleStrategy", [])
];

let runtimes: AccountRuntime[] = [];
let scanner: ScannerEngine | undefined;
let unsubscribeScannerLogs: (() => void) | undefined;
const clients = new Set<ServerResponse>();
const recentLogs: Array<{ level: string; message: string; timestamp: string }> = [];

const server = http.createServer((req, res) => {
  void route(req, res).catch((error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MEXC bot web UI: http://127.0.0.1:${PORT}`);
});

setInterval(() => {
  broadcast("status", currentStatus());
  broadcast("scanner", currentScannerStatus());
}, 1000).unref();

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (url.pathname === "/events") {
    return handleEvents(res);
  }
  if (url.pathname === "/api/bootstrap") {
    return sendJson(res, 200, {
      saved: readSaved(),
      symbols: buildSymbols(readSaved()),
      strategies: strategySchemas,
      running: runtimes.length > 0,
      scanner: currentScannerStatus(),
      status: currentStatus()
    });
  }
  if (url.pathname === "/api/start" && req.method === "POST") {
    const body = await readJson(req);
    await startBot(body as Record<string, unknown>);
    return sendJson(res, 200, { ok: true, status: currentStatus() });
  }
  if (url.pathname === "/api/stop" && req.method === "POST") {
    await stopBot();
    return sendJson(res, 200, { ok: true, status: currentStatus() });
  }
  if (url.pathname === "/api/scanner/start" && req.method === "POST") {
    const body = await readJson(req);
    await startScanner(body as Record<string, unknown>);
    return sendJson(res, 200, { ok: true, scanner: currentScannerStatus() });
  }
  if (url.pathname === "/api/scanner/stop" && req.method === "POST") {
    await stopScanner();
    return sendJson(res, 200, { ok: true, scanner: currentScannerStatus() });
  }
  if (url.pathname === "/api/scanner/status") {
    return sendJson(res, 200, currentScannerStatus());
  }
  if (url.pathname === "/api/scanner/execute" && req.method === "POST") {
    const body = (await readJson(req)) as { alertId?: string };
    if (!scanner) {
      return sendJson(res, 409, { error: "Scanner is not running" });
    }
    if (!body.alertId) {
      return sendJson(res, 400, { error: "alertId is required" });
    }
    const alert = await scanner.executeAlert(body.alertId);
    broadcast("scanner", currentScannerStatus());
    return sendJson(res, 200, { ok: true, alert });
  }
  if (url.pathname === "/api/manual" && req.method === "POST") {
    const body = (await readJson(req)) as { action?: "BUY" | "SELL" | "CLOSE" };
    if (runtimes.length === 0) {
      return sendJson(res, 409, { error: "Bot is not running" });
    }
    if (body.action !== "BUY" && body.action !== "SELL" && body.action !== "CLOSE") {
      return sendJson(res, 400, { error: "Invalid manual action" });
    }
    const targets = runtimes.length > 1 ? runtimes.filter((runtime) => runtime.account.role === "master") : runtimes;
    for (const runtime of targets) {
      runtime.engine.queueManual(body.action, "Manual web control");
    }
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "Not found" });
  }

  return serveStatic(url.pathname, res);
}

async function startScanner(input: Record<string, unknown>): Promise<void> {
  if (scanner) {
    throw new Error("Scanner is already running");
  }
  const config = buildScannerConfig(input);
  const logger = new Logger({ minLevel: config.debug ? "DEBUG" : "INFO", prefix: "Scanner" });
  unsubscribeScannerLogs = logger.onLog((entry) => {
    recentLogs.push(entry);
    if (recentLogs.length > 300) {
      recentLogs.shift();
    }
    broadcast("log", entry);
  });
  scanner = new ScannerEngine(config, logger, () => broadcast("scanner", currentScannerStatus()));
  await scanner.start();
  broadcast("scanner", currentScannerStatus());
}

async function stopScanner(): Promise<void> {
  const current = scanner;
  scanner = undefined;
  if (current) {
    await current.stop();
  }
  unsubscribeScannerLogs?.();
  unsubscribeScannerLogs = undefined;
  broadcast("scanner", currentScannerStatus());
}

async function startBot(input: Record<string, unknown>): Promise<void> {
  if (runtimes.length > 0) {
    throw new Error("Bot is already running");
  }

  const baseConfig = buildConfig(input);
  const accounts = buildAccounts(input, baseConfig.authToken);
  validateConfig(baseConfig, accounts, Boolean(input.liveConfirmed));
  saveConfig(baseConfig, accounts);

  runtimes = accounts.map((account) => {
    const config: BotConfig = {
      ...baseConfig,
      accountId: account.id,
      accountName: account.name,
      accountRole: account.role,
      authToken: account.authToken
    };
    const logger = new Logger({ minLevel: config.debug ? "DEBUG" : "INFO", prefix: account.name });
    const unsubscribeLogs = logger.onLog((entry) => {
      recentLogs.push(entry);
      if (recentLogs.length > 300) {
        recentLogs.shift();
      }
      broadcast("log", entry);
    });
    logger.info(formatConfigCard(config));

    const mexc = new MexcClient(config.authToken, config.dryRun, logger);
    const strategy =
      account.role === "master"
        ? createStrategy(config.strategyName, config.strategyParams)
        : createStrategy("ManualConsoleStrategy", {});
    const positions = new PositionManager(logger);
    const risk = new RiskManager(config, logger);
    const engine = new TradingEngine(config, mexc, strategy, positions, risk, logger, {
      enableKeyboardControls: false,
      onTradeAction:
        account.role === "master"
          ? (action, reason) => {
              for (const runtime of runtimes) {
                if (runtime.account.role === "slave") {
                  runtime.engine.queueManual(action, `Master ${account.name}: ${reason}`);
                }
              }
            }
          : undefined
    });
    return { account, config, engine, unsubscribeLogs };
  });

  for (const runtime of runtimes) {
    void runtime.engine.start().catch((error) => {
      const fallbackLogger = new Logger({ minLevel: runtime.config.debug ? "DEBUG" : "INFO", prefix: runtime.account.name });
      fallbackLogger.error("Web bot stopped after fatal error", error);
      runtimes = runtimes.filter((item) => item !== runtime);
      runtime.unsubscribeLogs();
      broadcast("status", currentStatus());
    });
  }
  if (accounts.length > 1) {
    broadcast("log", {
      level: "INFO",
      message: `[INFO] Account group started with ${accounts.length} accounts; ${accounts.find((account) => account.role === "master")?.name ?? accounts[0]?.name} is master`,
      timestamp: new Date().toISOString()
    });
    broadcast("status", currentStatus());
  }
}

async function stopBot(): Promise<void> {
  if (runtimes.length > 0) {
    const current = runtimes;
    runtimes = [];
    await Promise.all(current.map((runtime) => runtime.engine.stop("SHUTDOWN")));
    for (const runtime of current) {
      runtime.unsubscribeLogs();
    }
  }
  broadcast("status", currentStatus());
}

function buildConfig(input: Record<string, unknown>): BotConfig {
  const symbol = normalizeSymbol(String(input.symbol ?? "BTC_USDT"));
  const strategyName = String(input.strategyName ?? "ManualConsoleStrategy");
  const strategyParams = parseStrategyParams(strategyName, input.strategyParams);
  const margin = positiveNumber(input.margin, 10);
  const leverage = positiveNumber(input.leverage, 10);
  const config: BotConfig = {
    authToken: String(input.authToken ?? process.env.MEXC_WEB_AUTH_TOKEN ?? "").trim(),
    symbol,
    margin,
    leverage,
    directionMode: String(input.directionMode ?? "both") as DirectionMode,
    strategyName,
    takeProfitPercent: targetToPricePercent(input, "takeProfit", margin, leverage, 0.2),
    stopLossPercent: targetToPricePercent(input, "stopLoss", margin, leverage, 0.15),
    manualStopLossRoePercent: positiveNumber(input.manualStopLossRoePercent, 1),
    trailingTakeProfit: {
      enabled: Boolean(input.trailingEnabled) || strategyName === "TrailingBreakout",
      activationProfitPercent: positiveNumber(input.trailStartPercent, positiveNumber(strategyParams.trailStartPercent, 0.1)),
      distancePercent: positiveNumber(input.trailDistancePercent, positiveNumber(strategyParams.trailDistancePercent, 0.05))
    },
    chasingTakeProfit: {
      enabled: Boolean(input.chasingEnabled) || strategyName === "ChasingTakeProfitScalper",
      activationProfitPercent: positiveNumber(input.chaseActivationPercent, positiveNumber(strategyParams.activationProfitPercent, 0.1)),
      chaseDistancePercent: positiveNumber(input.chaseDistancePercent, positiveNumber(strategyParams.chaseDistancePercent, 0.05))
    },
    maxTradesPerSession: positiveNumber(input.maxTradesPerSession, 5),
    maxConsecutiveLosses: positiveNumber(input.maxConsecutiveLosses, 1),
    maxDailyLoss: positiveNumber(input.maxDailyLoss, 5),
    cooldownMs: positiveNumber(input.cooldownSeconds, 0) * 1000,
    dryRun: Boolean(input.dryRun),
    tickIntervalMs: positiveNumber(input.tickIntervalMs, 2000),
    debug: Boolean(input.debug),
    strategyParams
  };
  return config;
}

function buildScannerConfig(input: Record<string, unknown>): ScannerConfig {
  const saved = readSaved();
  const fallbackToken = String(input.authToken ?? saved?.authToken ?? process.env.MEXC_WEB_AUTH_TOKEN ?? "").trim();
  const accounts = buildAccounts(input.accounts ? input : { ...input, accounts: saved?.accounts, masterAccountId: saved?.masterAccountId }, fallbackToken);
  const scannerInput = typeof input.scanner === "object" && input.scanner !== null ? (input.scanner as Record<string, unknown>) : input;
  const symbols = parseSymbolList(scannerInput.symbols ?? saved?.scanner?.symbols ?? saved?.symbolHistory ?? saved?.symbol ?? "BTC_USDT,ETH_USDT,SOL_USDT,DOGE_USDT,PEPE_USDT");
  const config: ScannerConfig = {
    accounts,
    masterAccountId: String(input.masterAccountId ?? saved?.masterAccountId ?? accounts.find((account) => account.role === "master")?.id ?? accounts[0]?.id ?? ""),
    symbols,
    strictZeroFee: booleanValue(scannerInput.strictZeroFee, saved?.scanner?.strictZeroFee ?? false),
    executionMode: String(scannerInput.executionMode ?? saved?.scanner?.executionMode ?? "scanner") === "semi_auto" ? "semi_auto" : "scanner",
    dryRun: booleanValue(scannerInput.dryRun, saved?.dryRun ?? true),
    equityUsdt: positiveNumber(scannerInput.equityUsdt ?? saved?.scanner?.equityUsdt, 75),
    riskPct: positiveNumber(scannerInput.riskPct ?? saved?.scanner?.riskPct, 1.2) / 100,
    leverage: positiveNumber(scannerInput.leverage ?? saved?.scanner?.leverage, 15),
    maxFocusedSymbols: Math.max(1, Math.min(20, positiveNumber(scannerInput.maxFocusedSymbols ?? saved?.scanner?.maxFocusedSymbols, 12))),
    minGrade: String(scannerInput.minGrade ?? saved?.scanner?.minGrade ?? "A") === "A+" ? "A+" : String(scannerInput.minGrade ?? saved?.scanner?.minGrade ?? "A") === "B" ? "B" : "A",
    tickIntervalMs: positiveNumber(scannerInput.tickIntervalMs ?? saved?.scanner?.tickIntervalMs, 2000),
    debug: booleanValue(scannerInput.debug, saved?.debug ?? false)
  };
  saveScannerConfig(config);
  return config;
}

function buildAccounts(input: Record<string, unknown>, fallbackToken: string): SavedWebAccount[] {
  const masterAccountId = String(input.masterAccountId ?? "").trim();
  const rawAccounts = Array.isArray(input.accounts) ? input.accounts : [];
  const accounts = rawAccounts
    .map((item, index): SavedWebAccount | undefined => {
      if (typeof item !== "object" || item === null) {
        return undefined;
      }
      const record = item as Record<string, unknown>;
      const id = String(record.id ?? `account-${index + 1}`).trim() || `account-${index + 1}`;
      const name = String(record.name ?? `Account ${index + 1}`).trim() || `Account ${index + 1}`;
      const authToken = String(record.authToken ?? "").trim();
      if (!authToken) {
        return undefined;
      }
      return {
        id,
        name,
        authToken,
        role: id === masterAccountId || record.role === "master" ? "master" : "slave"
      };
    })
    .filter((account): account is SavedWebAccount => account !== undefined);

  if (accounts.length === 0 && fallbackToken) {
    accounts.push({
      id: "master",
      name: "Master",
      authToken: fallbackToken,
      role: "master"
    });
  }

  if (accounts.length === 0) {
    throw new Error("At least one account with a WEB token is required");
  }

  const explicitMaster = accounts.find((account) => account.id === masterAccountId) ?? accounts.find((account) => account.role === "master");
  const master = explicitMaster ?? accounts[0];
  return accounts.map((account) => ({
    ...account,
    role: account.id === master.id ? "master" : "slave"
  }));
}

function validateConfig(config: BotConfig, accounts: SavedWebAccount[], liveConfirmed: boolean): void {
  if (!accounts.some((account) => account.authToken)) {
    throw new Error("At least one WEB token is required");
  }
  if (!/^[A-Z0-9]+_[A-Z0-9]+$/.test(config.symbol)) {
    throw new Error("Symbol must look like BTC_USDT");
  }
  if (!STRATEGY_FACTORIES.some((factory) => factory.name === config.strategyName)) {
    throw new Error(`Unknown strategy: ${config.strategyName}`);
  }
  if (!config.dryRun && !liveConfirmed) {
    throw new Error("Live mode requires YES LIVE confirmation");
  }
}

function currentStatus(): unknown {
  if (runtimes.length === 0) {
    return {
      running: false,
      accounts: [],
      aggregate: {
        accounts: 0,
        activePositions: 0,
        unrealizedPnl: 0,
        realizedPnl: 0,
        totalPnl: 0,
        roiPercent: 0,
        margin: 0,
        tradesOpened: 0,
        wins: 0,
        losses: 0
      }
    };
  }

  const accounts = runtimes.map((runtime) => {
    const snapshot = runtime.engine.getSnapshot();
    const realizedPnl = snapshot.risk.dailyPnl;
    const totalPnl = realizedPnl + snapshot.unrealizedPnl;
    return {
      id: runtime.account.id,
      name: runtime.account.name,
      role: runtime.account.role,
      margin: runtime.config.margin,
      roiPercent: runtime.config.margin === 0 ? 0 : (totalPnl / runtime.config.margin) * 100,
      realizedPnl,
      totalPnl,
      ...snapshot
    };
  });

  const aggregateMargin = accounts.reduce((sum, account) => sum + account.margin, 0);
  const aggregate = {
    accounts: accounts.length,
    activePositions: accounts.filter((account) => account.position).length,
    unrealizedPnl: accounts.reduce((sum, account) => sum + account.unrealizedPnl, 0),
    realizedPnl: accounts.reduce((sum, account) => sum + account.realizedPnl, 0),
    totalPnl: accounts.reduce((sum, account) => sum + account.totalPnl, 0),
    roiPercent: 0,
    margin: aggregateMargin,
    tradesOpened: accounts.reduce((sum, account) => sum + account.risk.tradesOpened, 0),
    wins: accounts.reduce((sum, account) => sum + account.risk.wins, 0),
    losses: accounts.reduce((sum, account) => sum + account.risk.losses, 0)
  };
  aggregate.roiPercent = aggregateMargin === 0 ? 0 : (aggregate.totalPnl / aggregateMargin) * 100;

  const master = accounts.find((account) => account.role === "master") ?? accounts[0];
  return {
    running: accounts.some((account) => account.running),
    dryRun: master?.dryRun ?? true,
    symbol: master?.symbol,
    strategy: master?.strategy,
    price: master?.price,
    position: master?.position,
    unrealizedPnl: aggregate.unrealizedPnl,
    unrealizedPnlPercent: aggregate.roiPercent,
    risk: {
      tradesOpened: aggregate.tradesOpened,
      wins: aggregate.wins,
      losses: aggregate.losses,
      consecutiveLosses: accounts.reduce((sum, account) => sum + account.risk.consecutiveLosses, 0),
      dailyPnl: aggregate.realizedPnl,
      emergencyCloseRequested: accounts.some((account) => account.risk.emergencyCloseRequested)
    },
    aggregate,
    accounts
  };
}

function currentScannerStatus(): unknown {
  return scanner?.getStatus() ?? {
    running: false,
    wsConnected: false,
    mode: "scanner",
    dryRun: true,
    focusedSymbols: [],
    topSymbols: [],
    alerts: []
  };
}

function readSaved(): SavedWebConfig | undefined {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as SavedWebConfig;
}

function saveConfig(config: BotConfig, accounts: SavedWebAccount[]): void {
  const previous = readSaved();
  const {
    strategyName: _strategyName,
    strategyParams: _strategyParams,
    accountId: _accountId,
    accountName: _accountName,
    accountRole: _accountRole,
    ...saved
  } = config;
  const master = accounts.find((account) => account.role === "master") ?? accounts[0];
  const next = {
    ...saved,
    authToken: master?.authToken ?? saved.authToken,
    accounts,
    masterAccountId: master?.id,
    symbolHistory: Array.from(new Set([config.symbol, ...(previous?.symbolHistory ?? []), previous?.symbol].filter(Boolean))).slice(0, 10)
  };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function saveScannerConfig(config: ScannerConfig): void {
  const previous = readSaved();
  const next: SavedWebConfig = {
    ...(previous ?? {} as SavedWebConfig),
    accounts: config.accounts,
    masterAccountId: config.masterAccountId,
    scanner: {
      symbols: config.symbols,
      strictZeroFee: config.strictZeroFee,
      executionMode: config.executionMode,
      equityUsdt: config.equityUsdt,
      riskPct: config.riskPct * 100,
      leverage: config.leverage,
      maxFocusedSymbols: config.maxFocusedSymbols,
      minGrade: config.minGrade,
      tickIntervalMs: config.tickIntervalMs
    }
  };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function handleEvents(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  clients.add(res);
  for (const entry of recentLogs.slice(-80)) {
    sendEvent(res, "log", entry);
  }
  sendEvent(res, "status", currentStatus());
  sendEvent(res, "scanner", currentScannerStatus());
  res.on("close", () => clients.delete(res));
}

function broadcast(event: string, data: unknown): void {
  for (const client of clients) {
    sendEvent(client, event, data);
  }
}

function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function serveStatic(requestPath: string, res: ServerResponse): void {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, cleanPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const ext = path.extname(filePath);
  const contentType = ext === ".css" ? "text/css" : ext === ".js" ? "application/javascript" : "text/html";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}

function schema(name: string, params: StrategySchema["params"]): StrategySchema {
  const strategy = STRATEGY_FACTORIES.find((factory) => factory.name === name);
  return { name, description: strategy?.description ?? name, params };
}

function parseStrategyParams(strategyName: string, raw: unknown): Record<string, number | string | boolean> {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const selected = strategySchemas.find((item) => item.name === strategyName);
  const params: Record<string, number | string | boolean> = {};
  for (const param of selected?.params ?? []) {
    const value = record[param.name] ?? param.initial;
    params[param.name] = param.type === "number" ? Number(value) : String(value);
  }
  return params;
}

function targetToPricePercent(
  input: Record<string, unknown>,
  prefix: "takeProfit" | "stopLoss",
  margin: number,
  leverage: number,
  fallback: number
): number {
  const mode = String(input[`${prefix}Mode`] ?? "pricePercent");
  if (mode === "profitUsdt") {
    return (positiveNumber(input[`${prefix}Usdt`], fallback) / (margin * leverage)) * 100;
  }
  if (mode === "roePercent") {
    return positiveNumber(input[`${prefix}RoePercent`], fallback) / leverage;
  }
  return positiveNumber(input[`${prefix}PricePercent`], fallback);
}

function positiveNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value === "true" || value === "on" || value === "1";
  }
  return fallback;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function parseSymbolList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return Array.from(
    new Set(
      raw
        .split(/[,\s]+/)
        .map((symbol) => normalizeSymbol(symbol))
        .filter((symbol) => /^[A-Z0-9]+_[A-Z0-9]+$/.test(symbol))
    )
  );
}

function buildSymbols(saved?: SavedWebConfig): string[] {
  return Array.from(
    new Set([saved?.symbol, ...(saved?.symbolHistory ?? []), ...POPULAR_SYMBOLS].filter((item): item is string => Boolean(item)))
  );
}
