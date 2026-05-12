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
import { MexcAccountAsset, MexcClient, MexcOpenPosition } from "../mexc/client";
import { ScannerEngine } from "../scanner/scanner-engine";
import { ScannerConfig } from "../scanner/types";
import { createStrategy, STRATEGY_FACTORIES } from "../strategies";
import { BotConfig, DirectionMode } from "../types";

type SavedWebConfig = Omit<BotConfig, "strategyName" | "strategyParams"> & {
  accounts?: SavedWebAccount[];
  masterAccountId?: string;
  scanner?: SavedScannerConfig;
  spreadChecker?: SavedSpreadCheckerConfig;
  terminal?: SavedTerminalConfig;
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

interface SavedSpreadCheckerConfig {
  marketScope?: "all" | "custom";
  symbols?: string[];
  displayMinSpreadPercent?: number;
  mexcThresholdPercent?: number;
  crossExchangeThresholdPercent?: number;
  checkIntervalSec?: number;
  alertCooldownSec?: number;
  alertLanguage?: "ru" | "en";
  notificationMethod?: "sms" | "push" | "call" | "email_to_sms";
  pushProvider?: "pushover" | "ntfy";
  dryRun?: boolean;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  twilioToNumber?: string;
  pushoverAppToken?: string;
  pushoverUserKey?: string;
  ntfyServer?: string;
  ntfyTopic?: string;
  ntfyToken?: string;
  emailToSmsAddress?: string;
}

interface SavedTerminalConfig {
  symbol?: string;
  accountMode?: "single" | "group";
  accountId?: string;
  margin?: number;
  leverage?: number;
  dryRun?: boolean;
  accountMargins?: Record<string, number>;
}

interface SpreadCheckerConfig {
  marketScope: "all" | "custom";
  symbols: string[];
  displayMinSpreadPercent: number;
  mexcThresholdPercent: number;
  crossExchangeThresholdPercent: number;
  checkIntervalSec: number;
  alertCooldownSec: number;
  alertLanguage: "ru" | "en";
  notificationMethod: "sms" | "push" | "call" | "email_to_sms";
  pushProvider: "pushover" | "ntfy";
  dryRun: boolean;
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioFromNumber: string;
  twilioToNumber: string;
  pushoverAppToken: string;
  pushoverUserKey: string;
  ntfyServer: string;
  ntfyTopic: string;
  ntfyToken: string;
  emailToSmsAddress: string;
}

interface SpreadRow {
  symbol: string;
  fairPrice?: number;
  mexcLast?: number;
  gateLast?: number;
  mexcFundingRate?: number;
  gateFundingRate?: number;
  maxLeverage?: number;
  maxPositionUsdt?: number;
  mexcSpreadPercent?: number;
  crossSpreadPercent?: number;
  mexcDirection?: "MEXC_LAST_ABOVE_FAIR" | "MEXC_LAST_BELOW_FAIR";
  crossDirection?: "GATE_ABOVE_MEXC" | "GATE_BELOW_MEXC";
  mexcTriggered: boolean;
  crossTriggered: boolean;
  error?: string;
  updatedAt: string;
}

interface SpreadAlert {
  id: string;
  symbol: string;
  type: "MEXC_INTERNAL" | "CROSS_EXCHANGE";
  message: string;
  timestamp: string;
  delivered: boolean;
  error?: string;
}

type SpreadCallType = "MEXC_INTERNAL" | "CROSS_EXCHANGE";

interface ActiveSpreadCall {
  id: string;
  symbol: string;
  type: SpreadCallType;
  openedAt: number;
  initialSpreadPercent: number;
  lastSpreadPercent: number;
  bestSpreadPercent: number;
  thresholdPercent: number;
  targetSpreadPercent: number;
  tradePlan: string;
}

interface CompletedSpreadCall extends ActiveSpreadCall {
  closedAt: number;
  convergenceMs: number;
}

interface SpreadCallStats {
  totalStarted: number;
  active: number;
  converged: number;
  avgConvergenceMs?: number;
  medianConvergenceMs?: number;
  estimatedConvergenceMs?: number;
}

interface SpreadRuntimeStatus {
  running: boolean;
  rows: SpreadRow[];
  totalRows: number;
  alerts: SpreadAlert[];
  callStats: SpreadCallStats;
  activeCalls: ActiveSpreadCall[];
  lastUpdated?: string;
  dryRun: boolean;
  settings: SpreadCheckerConfig;
}

interface TerminalAccountStatus {
  id: string;
  name: string;
  role: "master" | "slave";
  balance?: MexcAccountAsset;
  positions: TerminalPositionStatus[];
  pnl: number;
  roiPercent: number;
  error?: string;
}

interface TerminalOrderTarget {
  account: SavedWebAccount;
  margin: number;
}

interface TerminalPositionStatus extends MexcOpenPosition {
  currentPrice?: number;
  entryPrice?: number;
  notional?: number;
  pnl?: number;
  roiPercent?: number;
}

interface SpreadAlertState {
  aboveThreshold: boolean;
  lastAlertAt: number;
}

interface MexcTickerPrices {
  fairPrices: Map<string, number>;
  lastPrices: Map<string, number>;
  indexPrices: Map<string, number>;
  fundingRates: Map<string, number>;
}

interface GateTickerPrices {
  lastPrices: Map<string, number>;
  indexPrices: Map<string, number>;
  fundingRates: Map<string, number>;
}

interface MexcContractDetails {
  maxLeverage: Map<string, number>;
  maxPositionBase: Map<string, number>;
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
const MEXC_CONTRACT_BASE_URL = "https://contract.mexc.com";
const GATE_API_BASE_URL = "https://api.gateio.ws/api/v4";
const CROSS_INDEX_COMPATIBILITY_MAX_PERCENT = 5;
const CROSS_LAST_PRICE_SANITY_MAX_PERCENT = 20;
const SPREAD_DISPLAY_LINGER_MS = 3 * 60 * 1000;
const MAX_COMPLETED_SPREAD_CALLS = 500;
const PUBLIC_WEB_BASE_URL = (process.env.WEB_PUBLIC_BASE_URL ?? "https://mexc.moontap.space").replace(/\/$/, "");
const DEFAULT_SPREAD_CONFIG: SpreadCheckerConfig = {
  marketScope: "all",
  symbols: ["BTC_USDT", "ETH_USDT", "SOL_USDT"],
  displayMinSpreadPercent: 0.1,
  mexcThresholdPercent: 0.3,
  crossExchangeThresholdPercent: 0.5,
  checkIntervalSec: 3,
  alertCooldownSec: 300,
  alertLanguage: "ru",
  notificationMethod: "push",
  pushProvider: "pushover",
  dryRun: true,
  twilioAccountSid: "",
  twilioAuthToken: "",
  twilioFromNumber: "",
  twilioToNumber: "",
  pushoverAppToken: "",
  pushoverUserKey: "",
  ntfyServer: "https://ntfy.sh",
  ntfyTopic: "",
  ntfyToken: "",
  emailToSmsAddress: ""
};
let cachedSymbols: { symbols: string[]; expiresAt: number } | undefined;

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
let spreadCheckerTimer: NodeJS.Timeout | undefined;
let spreadCheckerRunning = false;
let activeSpreadConfig: SpreadCheckerConfig | undefined;
let spreadRows: SpreadRow[] = [];
let spreadAlerts: SpreadAlert[] = [];
const spreadAlertStates = new Map<string, SpreadAlertState>();
const spreadVisibleRows = new Map<string, number>();
const spreadDisplayOrder = new Map<string, number>();
const activeSpreadCalls = new Map<string, ActiveSpreadCall>();
const completedSpreadCalls: CompletedSpreadCall[] = [];
let spreadDisplayFilterKey = "";
let spreadDisplayOrderCounter = 0;
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
  broadcast("spread", currentSpreadStatus());
}, 1000).unref();

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (url.pathname === "/events") {
    return handleEvents(res);
  }
  if (url.pathname === "/api/bootstrap") {
    return sendJson(res, 200, {
      saved: readSaved(),
      symbols: await buildSymbols(readSaved()),
      strategies: strategySchemas,
      running: runtimes.length > 0,
      scanner: currentScannerStatus(),
      spread: currentSpreadStatus(),
      terminal: await currentTerminalStatus(),
      status: currentStatus()
    });
  }
  if (url.pathname === "/api/start" && req.method === "POST") {
    const body = await readJson(req);
    await startBot(body as Record<string, unknown>);
    return sendJson(res, 200, { ok: true, status: currentStatus() });
  }
  if (url.pathname === "/api/config/save" && req.method === "POST") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const config = buildConfig(body);
    const accounts = buildAccounts(body, config.authToken);
    validateConfig(config, accounts, true);
    saveConfig(config, accounts);
    return sendJson(res, 200, { ok: true, saved: readSaved(), terminal: await currentTerminalStatus(String(body.symbol ?? "")) });
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
  if (url.pathname === "/api/spread-checker/save" && req.method === "POST") {
    const body = await readJson(req);
    const config = buildSpreadCheckerConfig(body as Record<string, unknown>);
    saveSpreadCheckerConfig(config);
    if (spreadCheckerRunning) {
      activeSpreadConfig = config;
      restartSpreadCheckerTimer(config);
    }
    broadcast("spread", currentSpreadStatus());
    return sendJson(res, 200, { ok: true, spread: currentSpreadStatus() });
  }
  if (url.pathname === "/api/spread-checker/start" && req.method === "POST") {
    const body = await readJson(req);
    const config = buildSpreadCheckerConfig(body as Record<string, unknown>);
    await startSpreadChecker(config);
    return sendJson(res, 200, { ok: true, spread: currentSpreadStatus(config) });
  }
  if (url.pathname === "/api/spread-checker/stop" && req.method === "POST") {
    stopSpreadChecker();
    return sendJson(res, 200, { ok: true, spread: currentSpreadStatus() });
  }
  if (url.pathname === "/api/spread-checker/status") {
    return sendJson(res, 200, currentSpreadStatus());
  }
  if (url.pathname === "/api/terminal/status") {
    return sendJson(res, 200, await currentTerminalStatus(url.searchParams.get("symbol") ?? undefined));
  }
  if (url.pathname === "/api/terminal/order" && req.method === "POST") {
    const body = await readJson(req);
    const result = await executeTerminalOrder(body as Record<string, unknown>);
    const requestedSymbol =
      body && typeof body === "object" && typeof (body as Record<string, unknown>).symbol === "string"
        ? String((body as Record<string, unknown>).symbol)
        : undefined;
    return sendJson(res, 200, { ok: true, result, terminal: await currentTerminalStatus(requestedSymbol) });
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

async function startSpreadChecker(config: SpreadCheckerConfig): Promise<void> {
  stopSpreadChecker();
  saveSpreadCheckerConfig(config);
  activeSpreadConfig = config;
  spreadCheckerRunning = true;
  spreadRows = [];
  spreadAlerts = [];
  spreadAlertStates.clear();
  activeSpreadCalls.clear();
  spreadVisibleRows.clear();
  spreadDisplayOrder.clear();
  spreadDisplayFilterKey = "";
  spreadDisplayOrderCounter = 0;
  await runSpreadCheckerCycle(config);
  restartSpreadCheckerTimer(config);
  broadcast("spread", currentSpreadStatus());
}

function stopSpreadChecker(): void {
  if (spreadCheckerTimer) {
    clearInterval(spreadCheckerTimer);
    spreadCheckerTimer = undefined;
  }
  spreadCheckerRunning = false;
  activeSpreadConfig = undefined;
  broadcast("spread", currentSpreadStatus());
}

function restartSpreadCheckerTimer(config: SpreadCheckerConfig): void {
  if (spreadCheckerTimer) {
    clearInterval(spreadCheckerTimer);
  }
  spreadCheckerTimer = setInterval(() => {
    void runSpreadCheckerCycle(activeSpreadConfig ?? config);
  }, config.checkIntervalSec * 1000);
  spreadCheckerTimer.unref();
}

async function runSpreadCheckerCycle(config: SpreadCheckerConfig): Promise<void> {
  const updatedAt = new Date().toISOString();
  try {
    if (config.marketScope === "custom") {
      spreadRows = await fetchCustomSpreadRows(config, updatedAt);
      broadcast("spread", currentSpreadStatus(config));
      return;
    }

    const [mexcPrices, gatePrices, mexcDetails] = await Promise.all([
      fetchMexcTickerPrices(),
      fetchGateTickerPrices(),
      fetchMexcContractDetails()
    ]);
    const { fairPrices, lastPrices: mexcLastPrices, indexPrices: mexcIndexPrices } = mexcPrices;
    const symbols = Array.from(new Set([...fairPrices.keys(), ...mexcLastPrices.keys()])).filter(isUsdtPerpetualSymbol).sort();
    const rows: SpreadRow[] = [];
    for (const symbol of symbols) {
      const fairPrice = fairPrices.get(symbol);
      const mexcLast = mexcLastPrices.get(symbol);
      const rawGateLast = gatePrices.lastPrices.get(symbol);
      if (fairPrice === undefined || mexcLast === undefined) {
        rows.push({
          symbol,
          mexcTriggered: false,
          crossTriggered: false,
          error: "MEXC fair price or last price is missing",
          updatedAt
        });
        continue;
      }

      const mexcSpreadPercent = fairPrice === 0 ? 0 : (Math.abs(mexcLast - fairPrice) / fairPrice) * 100;
      const hasGate =
        rawGateLast !== undefined &&
        isCrossCompatible({
          mexcLast,
          gateLast: rawGateLast,
          mexcIndex: mexcIndexPrices.get(symbol),
          gateIndex: gatePrices.indexPrices.get(symbol)
        });
      const gateLast = hasGate ? rawGateLast : undefined;
      const crossSpreadPercent = gateLast !== undefined && mexcLast !== 0 ? (Math.abs(gateLast - mexcLast) / mexcLast) * 100 : undefined;
      const row: SpreadRow = {
        symbol,
        fairPrice,
        mexcLast,
        gateLast,
        mexcFundingRate: mexcPrices.fundingRates.get(symbol),
        gateFundingRate: gatePrices.fundingRates.get(symbol),
        maxLeverage: mexcDetails.maxLeverage.get(symbol),
        maxPositionUsdt: maxPositionUsdt(mexcDetails.maxPositionBase.get(symbol), fairPrice),
        mexcSpreadPercent,
        crossSpreadPercent,
        mexcDirection: mexcLast >= fairPrice ? "MEXC_LAST_ABOVE_FAIR" : "MEXC_LAST_BELOW_FAIR",
        crossDirection: gateLast !== undefined ? (gateLast >= mexcLast ? "GATE_ABOVE_MEXC" : "GATE_BELOW_MEXC") : undefined,
        mexcTriggered: mexcSpreadPercent >= config.mexcThresholdPercent,
        crossTriggered: crossSpreadPercent !== undefined && crossSpreadPercent >= config.crossExchangeThresholdPercent,
        updatedAt
      };
      rows.push(row);
      updateSpreadCallTracking(row, "MEXC_INTERNAL");
      await processSpreadThreshold(config, row, "MEXC_INTERNAL");
      if (hasGate) {
        updateSpreadCallTracking(row, "CROSS_EXCHANGE");
        await processSpreadThreshold(config, row, "CROSS_EXCHANGE");
      }
    }
    spreadRows = rows;
  } catch (error) {
    pushWebLog("WARN", `Spread Checker market fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  broadcast("spread", currentSpreadStatus(config));
}

async function fetchCustomSpreadRows(config: SpreadCheckerConfig, updatedAt: string): Promise<SpreadRow[]> {
  const [gatePrices, mexcDetails] = await Promise.all([fetchGateTickerPrices(), fetchMexcContractDetails()]);
  const rows: SpreadRow[] = [];
  for (const symbol of config.symbols) {
    try {
      const [fairPrice, mexcTicker] = await Promise.all([fetchMexcFairPrice(symbol), fetchMexcTickerData(symbol)]);
      const mexcLast = numberField(mexcTicker, "lastPrice", `MEXC last price ${symbol}`);
      const mexcIndex = optionalNumberField(mexcTicker, "indexPrice");
      if (fairPrice <= 0 || mexcLast <= 0) {
        throw new Error(`MEXC ${symbol} has inactive zero fair/last price`);
      }
      const rawGateLast = gatePrices.lastPrices.get(symbol);
      const mexcSpreadPercent = fairPrice === 0 ? 0 : (Math.abs(mexcLast - fairPrice) / fairPrice) * 100;
      const hasGate =
        rawGateLast !== undefined &&
        isCrossCompatible({
          mexcLast,
          gateLast: rawGateLast,
          mexcIndex,
          gateIndex: gatePrices.indexPrices.get(symbol)
        });
      const gateLast = hasGate ? rawGateLast : undefined;
      const crossSpreadPercent = gateLast !== undefined && mexcLast !== 0 ? (Math.abs(gateLast - mexcLast) / mexcLast) * 100 : undefined;
      const row: SpreadRow = {
        symbol,
        fairPrice,
        mexcLast,
        gateLast,
        mexcFundingRate: optionalNumberField(mexcTicker, "fundingRate"),
        gateFundingRate: gatePrices.fundingRates.get(symbol),
        maxLeverage: mexcDetails.maxLeverage.get(symbol),
        maxPositionUsdt: maxPositionUsdt(mexcDetails.maxPositionBase.get(symbol), fairPrice),
        mexcSpreadPercent,
        crossSpreadPercent,
        mexcDirection: mexcLast >= fairPrice ? "MEXC_LAST_ABOVE_FAIR" : "MEXC_LAST_BELOW_FAIR",
        crossDirection: gateLast !== undefined ? (gateLast >= mexcLast ? "GATE_ABOVE_MEXC" : "GATE_BELOW_MEXC") : undefined,
        mexcTriggered: mexcSpreadPercent >= config.mexcThresholdPercent,
        crossTriggered: crossSpreadPercent !== undefined && crossSpreadPercent >= config.crossExchangeThresholdPercent,
        updatedAt
      };
      rows.push(row);
      updateSpreadCallTracking(row, "MEXC_INTERNAL");
      await processSpreadThreshold(config, row, "MEXC_INTERNAL");
      if (hasGate) {
        updateSpreadCallTracking(row, "CROSS_EXCHANGE");
        await processSpreadThreshold(config, row, "CROSS_EXCHANGE");
      }
    } catch (error) {
      rows.push({
        symbol,
        mexcTriggered: false,
        crossTriggered: false,
        error: error instanceof Error ? error.message : String(error),
        updatedAt
      });
    }
  }
  return rows;
}

async function processSpreadThreshold(
  config: SpreadCheckerConfig,
  row: SpreadRow,
  type: "MEXC_INTERNAL" | "CROSS_EXCHANGE"
): Promise<void> {
  const spreadPercent = type === "MEXC_INTERNAL" ? row.mexcSpreadPercent : row.crossSpreadPercent;
  const threshold = type === "MEXC_INTERNAL" ? config.mexcThresholdPercent : config.crossExchangeThresholdPercent;
  if (spreadPercent === undefined) {
    return;
  }

  const stateKey = `${row.symbol}:${type}`;
  const state = spreadAlertStates.get(stateKey) ?? { aboveThreshold: false, lastAlertAt: 0 };
  if (spreadPercent < threshold) {
    state.aboveThreshold = false;
    spreadAlertStates.set(stateKey, state);
    return;
  }

  const now = Date.now();
  const cooldownElapsed = state.lastAlertAt === 0 || now - state.lastAlertAt >= config.alertCooldownSec * 1000;
  if (state.aboveThreshold && !cooldownElapsed) {
    spreadAlertStates.set(stateKey, state);
    return;
  }

  state.aboveThreshold = true;
  state.lastAlertAt = now;
  spreadAlertStates.set(stateKey, state);

  const call = ensureSpreadCall(row, type, threshold, spreadPercent);
  const messageContext = { call, stats: spreadCallStats(row.symbol, type) };
  const message =
    type === "MEXC_INTERNAL" ? formatMexcSpreadAlert(config, row, messageContext) : formatCrossSpreadAlert(config, row, messageContext);
  const alert: SpreadAlert = {
    id: `${now}-${row.symbol}-${type}`,
    symbol: row.symbol,
    type,
    message,
    timestamp: new Date(now).toISOString(),
    delivered: false
  };
  try {
    await sendSpreadNotification(config, message);
    alert.delivered = true;
  } catch (error) {
    alert.error = error instanceof Error ? error.message : String(error);
  }
  spreadAlerts = [alert, ...spreadAlerts].slice(0, 50);
  pushWebLog(alert.error ? "ERROR" : "WARN", alert.error ? `Spread alert failed: ${alert.error}` : message.replace(/\n/g, " | "));
}

function updateSpreadCallTracking(row: SpreadRow, type: SpreadCallType): void {
  const spreadPercent = type === "MEXC_INTERNAL" ? row.mexcSpreadPercent : row.crossSpreadPercent;
  if (spreadPercent === undefined) {
    return;
  }
  const key = spreadCallKey(row.symbol, type);
  const call = activeSpreadCalls.get(key);
  if (!call) {
    return;
  }
  call.lastSpreadPercent = spreadPercent;
  call.bestSpreadPercent = Math.min(call.bestSpreadPercent, spreadPercent);
  if (spreadPercent <= call.targetSpreadPercent) {
    const closedAt = Date.now();
    completedSpreadCalls.unshift({
      ...call,
      closedAt,
      convergenceMs: closedAt - call.openedAt
    });
    if (completedSpreadCalls.length > MAX_COMPLETED_SPREAD_CALLS) {
      completedSpreadCalls.pop();
    }
    activeSpreadCalls.delete(key);
    pushWebLog(
      "INFO",
      `Spread call converged: ${row.symbol} ${type} ${call.initialSpreadPercent.toFixed(4)}% -> ${spreadPercent.toFixed(
        4
      )}% in ${formatDuration(closedAt - call.openedAt)}`
    );
  }
}

function ensureSpreadCall(row: SpreadRow, type: SpreadCallType, thresholdPercent: number, spreadPercent: number): ActiveSpreadCall {
  const key = spreadCallKey(row.symbol, type);
  const existing = activeSpreadCalls.get(key);
  if (existing) {
    return existing;
  }
  const now = Date.now();
  const call: ActiveSpreadCall = {
    id: `${now}-${row.symbol}-${type}`,
    symbol: row.symbol,
    type,
    openedAt: now,
    initialSpreadPercent: spreadPercent,
    lastSpreadPercent: spreadPercent,
    bestSpreadPercent: spreadPercent,
    thresholdPercent,
    targetSpreadPercent: convergenceTargetPercent(thresholdPercent, spreadPercent),
    tradePlan: spreadTradePlan(row, type)
  };
  activeSpreadCalls.set(key, call);
  return call;
}

function spreadCallKey(symbol: string, type: SpreadCallType): string {
  return `${symbol}:${type}`;
}

function convergenceTargetPercent(thresholdPercent: number, initialSpreadPercent: number): number {
  return Math.max(thresholdPercent * 0.5, initialSpreadPercent * 0.25, 0.001);
}

function spreadCallStats(symbol?: string, type?: SpreadCallType): SpreadCallStats {
  const matchingCompleted = completedSpreadCalls.filter(
    (call) => (symbol === undefined || call.symbol === symbol) && (type === undefined || call.type === type)
  );
  const matchingActive = Array.from(activeSpreadCalls.values()).filter(
    (call) => (symbol === undefined || call.symbol === symbol) && (type === undefined || call.type === type)
  );
  const durations = matchingCompleted.map((call) => call.convergenceMs).sort((left, right) => left - right);
  const avgConvergenceMs =
    durations.length === 0 ? undefined : durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  const medianConvergenceMs =
    durations.length === 0 ? undefined : durations[Math.floor((durations.length - 1) / 2)];
  return {
    totalStarted: matchingCompleted.length + matchingActive.length,
    active: matchingActive.length,
    converged: matchingCompleted.length,
    avgConvergenceMs,
    medianConvergenceMs,
    estimatedConvergenceMs: estimatedConvergenceMs(symbol, type)
  };
}

function estimatedConvergenceMs(symbol?: string, type?: SpreadCallType): number | undefined {
  const scopes = [
    completedSpreadCalls.filter((call) => call.symbol === symbol && call.type === type),
    completedSpreadCalls.filter((call) => call.type === type),
    completedSpreadCalls
  ];
  const sample = scopes.find((items) => items.length >= 3);
  if (!sample) {
    return undefined;
  }
  return sample.reduce((sum, call) => sum + call.convergenceMs, 0) / sample.length;
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

async function currentTerminalStatus(symbolInput?: string): Promise<{
  accounts: TerminalAccountStatus[];
  settings: Required<SavedTerminalConfig>;
  totalEquity: number;
  totalAvailable: number;
  refreshedAt: string;
}> {
  const settings = buildTerminalSettings({ symbol: symbolInput });
  const accounts = terminalAccounts();
  const statuses = await Promise.all(
    accounts.map(async (account): Promise<TerminalAccountStatus> => {
      const logger = new Logger({ minLevel: "ERROR", prefix: `Terminal ${account.name}` });
      const client = new MexcClient(account.authToken, true, logger);
      try {
        const [balance, positions] = await Promise.all([
          client.getAccountAsset("USDT"),
          client.getOpenPositionDetails(settings.symbol)
        ]);
        const enrichedPositions = await enrichTerminalPositions(client, positions);
        const pnl = enrichedPositions.reduce((sum, position) => sum + (position.pnl ?? 0), 0);
        const margin = enrichedPositions.reduce((sum, position) => sum + (position.margin ?? 0), 0);
        return {
          id: account.id,
          name: account.name,
          role: account.role,
          balance,
          positions: enrichedPositions,
          pnl,
          roiPercent: margin > 0 ? (pnl / margin) * 100 : 0
        };
      } catch (error) {
        return {
          id: account.id,
          name: account.name,
          role: account.role,
          positions: [],
          pnl: 0,
          roiPercent: 0,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
  return {
    accounts: statuses,
    settings,
    totalEquity: statuses.reduce((sum, account) => sum + (account.balance?.equity ?? 0), 0),
    totalAvailable: statuses.reduce((sum, account) => sum + (account.balance?.availableBalance ?? 0), 0),
    refreshedAt: new Date().toISOString()
  };
}

async function executeTerminalOrder(input: Record<string, unknown>): Promise<{
  action: "BUY" | "SELL" | "CLOSE";
  symbol: string;
  dryRun: boolean;
  results: Array<{
    accountId: string;
    accountName: string;
    margin: number;
    leverage: number;
    volume?: number;
    orderId?: string;
    positionId?: string;
    closedPositions?: number;
    error?: string;
  }>;
}> {
  const settings = buildTerminalSettings(input);
  const action = stringOption(input.action, "BUY", ["BUY", "SELL", "CLOSE"]);
  const dryRun = booleanValue(input.dryRun, settings.dryRun);
  const liveConfirmed = Boolean(input.liveConfirmed);
  if (!dryRun && !liveConfirmed) {
    throw new Error("Live terminal orders require live mode confirmation from the UI");
  }
  const targets = terminalOrderTargets(input, settings);
  if (targets.length === 0) {
    throw new Error("No terminal account targets selected");
  }
  saveTerminalSettings(settings);

  const results = [];
  for (const target of targets) {
    const logger = new Logger({ minLevel: "INFO", prefix: `Terminal ${target.account.name}` });
    const unsubscribe = logger.onLog((entry) => {
      recentLogs.push(entry);
      if (recentLogs.length > 300) {
        recentLogs.shift();
      }
      broadcast("log", entry);
    });
    const client = new MexcClient(target.account.authToken, dryRun, logger);
    try {
      if (!dryRun) {
        const balance = await client.getAccountAsset("USDT");
        if (balance.availableBalance < target.margin && action !== "CLOSE") {
          throw new Error(
            `Insufficient available USDT on ${target.account.name}: ${balance.availableBalance.toFixed(2)} < ${target.margin.toFixed(2)}`
          );
        }
      }
      const price = await client.getTickerPrice(settings.symbol);
      if (action === "CLOSE") {
        const closeSide = stringOption(input.closeSide, "ALL", ["ALL", "LONG", "SHORT"]);
        const positions = (await client.getOpenPositionDetails(settings.symbol)).filter(
          (position) => closeSide === "ALL" || position.side === closeSide
        );
        if (positions.length === 0) {
          throw new Error(`No open ${closeSide === "ALL" ? "" : `${closeSide} `}position on ${settings.symbol}`);
        }
        const closes = [];
        for (const position of positions) {
          const order = await client.closeMarketPosition({
            symbol: position.symbol,
            side: position.side,
            price,
            volume: position.holdVol,
            leverage: position.leverage,
            positionId: position.positionId
          });
          closes.push(order);
        }
        results.push({
          accountId: target.account.id,
          accountName: target.account.name,
          margin: target.margin,
          leverage: settings.leverage,
          closedPositions: closes.length,
          orderId: closes.at(-1)?.orderId,
          positionId: closes.at(-1)?.positionId
        });
      } else {
        const side = action === "BUY" ? "LONG" : "SHORT";
        const volume = await client.calculateVolume(settings.symbol, target.margin, settings.leverage, price);
        const order = await client.openMarketPosition({
          symbol: settings.symbol,
          side,
          price,
          volume,
          leverage: settings.leverage
        });
        results.push({
          accountId: target.account.id,
          accountName: target.account.name,
          margin: target.margin,
          leverage: settings.leverage,
          volume,
          orderId: order.orderId,
          positionId: order.positionId
        });
      }
    } catch (error) {
      results.push({
        accountId: target.account.id,
        accountName: target.account.name,
        margin: target.margin,
        leverage: settings.leverage,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      unsubscribe();
    }
  }

  pushWebLog(
    results.some((result) => result.error) ? "ERROR" : "WARN",
    `Terminal ${dryRun ? "DRY-RUN " : ""}${action} ${settings.symbol}: ${results
      .map((result) => `${result.accountName}${result.error ? ` failed=${result.error}` : " ok"}`)
      .join(" | ")}`
  );

  return {
    action,
    symbol: settings.symbol,
    dryRun,
    results
  };
}

async function enrichTerminalPositions(client: MexcClient, positions: MexcOpenPosition[]): Promise<TerminalPositionStatus[]> {
  const priceCache = new Map<string, number>();
  return Promise.all(
    positions.map(async (position): Promise<TerminalPositionStatus> => {
      let currentPrice = priceCache.get(position.symbol);
      if (currentPrice === undefined) {
        currentPrice = await client.getTickerPrice(position.symbol);
        priceCache.set(position.symbol, currentPrice);
      }
      const entryPrice = position.holdAvgPrice ?? position.openAvgPrice;
      const contractSize = position.contractSize ?? 1;
      const notional = entryPrice === undefined ? undefined : position.holdVol * contractSize * entryPrice;
      const calculatedPnl =
        entryPrice === undefined
          ? undefined
          : position.side === "LONG"
            ? (currentPrice - entryPrice) * position.holdVol * contractSize
            : (entryPrice - currentPrice) * position.holdVol * contractSize;
      const pnl = position.unrealized ?? calculatedPnl;
      const margin = position.margin ?? (notional !== undefined ? notional / Math.max(position.leverage, 1) : undefined);
      return {
        ...position,
        currentPrice,
        entryPrice,
        notional,
        margin,
        pnl,
        roiPercent: margin && pnl !== undefined ? (pnl / margin) * 100 : undefined
      };
    })
  );
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

function buildSpreadCheckerConfig(input: Record<string, unknown>): SpreadCheckerConfig {
  const saved = readSaved()?.spreadChecker;
  const record = typeof input.spreadChecker === "object" && input.spreadChecker !== null ? (input.spreadChecker as Record<string, unknown>) : input;
  const marketScope = stringOption(record.marketScope, saved?.marketScope ?? DEFAULT_SPREAD_CONFIG.marketScope, ["all", "custom"]);
  const notificationMethod = stringOption(
    record.notificationMethod,
    saved?.notificationMethod ?? DEFAULT_SPREAD_CONFIG.notificationMethod,
    ["sms", "push", "call", "email_to_sms"]
  );
  const pushProvider = stringOption(record.pushProvider, saved?.pushProvider ?? DEFAULT_SPREAD_CONFIG.pushProvider, ["pushover", "ntfy"]);
  const symbols = parseSymbolList(record.symbols ?? saved?.symbols ?? DEFAULT_SPREAD_CONFIG.symbols).filter(isUsdtPerpetualSymbol);
  return {
    marketScope,
    symbols: (symbols.length > 0 ? symbols : DEFAULT_SPREAD_CONFIG.symbols).slice(0, 50),
    displayMinSpreadPercent: nonNegativeNumber(
      record.displayMinSpreadPercent ?? saved?.displayMinSpreadPercent,
      DEFAULT_SPREAD_CONFIG.displayMinSpreadPercent
    ),
    mexcThresholdPercent: nonNegativeNumber(record.mexcThresholdPercent ?? saved?.mexcThresholdPercent, DEFAULT_SPREAD_CONFIG.mexcThresholdPercent),
    crossExchangeThresholdPercent: nonNegativeNumber(
      record.crossExchangeThresholdPercent ?? saved?.crossExchangeThresholdPercent,
      DEFAULT_SPREAD_CONFIG.crossExchangeThresholdPercent
    ),
    checkIntervalSec: Math.max(1, positiveNumber(record.checkIntervalSec ?? saved?.checkIntervalSec, DEFAULT_SPREAD_CONFIG.checkIntervalSec)),
    alertCooldownSec: Math.max(1, positiveNumber(record.alertCooldownSec ?? saved?.alertCooldownSec, DEFAULT_SPREAD_CONFIG.alertCooldownSec)),
    alertLanguage: stringOption(record.alertLanguage, saved?.alertLanguage ?? DEFAULT_SPREAD_CONFIG.alertLanguage, ["ru", "en"]),
    notificationMethod,
    pushProvider,
    dryRun: booleanValue(record.dryRun, saved?.dryRun ?? DEFAULT_SPREAD_CONFIG.dryRun),
    twilioAccountSid: stringValue(record.twilioAccountSid, saved?.twilioAccountSid ?? process.env.TWILIO_ACCOUNT_SID ?? ""),
    twilioAuthToken: stringValue(record.twilioAuthToken, saved?.twilioAuthToken ?? process.env.TWILIO_AUTH_TOKEN ?? ""),
    twilioFromNumber: stringValue(record.twilioFromNumber, saved?.twilioFromNumber ?? process.env.TWILIO_FROM_NUMBER ?? ""),
    twilioToNumber: stringValue(record.twilioToNumber, saved?.twilioToNumber ?? process.env.TWILIO_TO_NUMBER ?? ""),
    pushoverAppToken: stringValue(record.pushoverAppToken, saved?.pushoverAppToken ?? process.env.PUSHOVER_APP_TOKEN ?? ""),
    pushoverUserKey: stringValue(record.pushoverUserKey, saved?.pushoverUserKey ?? process.env.PUSHOVER_USER_KEY ?? ""),
    ntfyServer: stringValue(record.ntfyServer, saved?.ntfyServer ?? process.env.NTFY_SERVER ?? DEFAULT_SPREAD_CONFIG.ntfyServer),
    ntfyTopic: stringValue(record.ntfyTopic, saved?.ntfyTopic ?? process.env.NTFY_TOPIC ?? ""),
    ntfyToken: stringValue(record.ntfyToken, saved?.ntfyToken ?? process.env.NTFY_TOKEN ?? ""),
    emailToSmsAddress: stringValue(record.emailToSmsAddress, saved?.emailToSmsAddress ?? process.env.EMAIL_TO_SMS_ADDRESS ?? "")
  };
}

function buildTerminalSettings(input: Record<string, unknown>): Required<SavedTerminalConfig> {
  const saved = readSaved();
  const terminal = saved?.terminal;
  const inputSymbol = typeof input.symbol === "string" && input.symbol.trim() ? input.symbol : undefined;
  const symbolValue = String(inputSymbol ?? terminal?.symbol ?? saved?.symbol ?? "BTC_USDT");
  const accounts = terminalAccounts();
  const defaultAccount = accounts.find((account) => account.role === "master") ?? accounts[0];
  const symbol = normalizeSymbol(symbolValue || "BTC_USDT");
  if (!/^[A-Z0-9]+_[A-Z0-9]+$/.test(symbol)) {
    throw new Error("Terminal symbol must look like BTC_USDT");
  }
  return {
    symbol,
    accountMode: stringOption(input.accountMode, terminal?.accountMode ?? "single", ["single", "group"]),
    accountId: String(input.accountId ?? terminal?.accountId ?? defaultAccount?.id ?? ""),
    margin: positiveNumber(input.margin ?? terminal?.margin, 10),
    leverage: Math.max(1, Math.min(200, positiveNumber(input.leverage ?? terminal?.leverage, 10))),
    dryRun: booleanValue(input.dryRun, terminal?.dryRun ?? saved?.dryRun ?? true),
    accountMargins: parseTerminalAccountMargins(input.accountMargins, terminal?.accountMargins)
  };
}

function terminalAccounts(): SavedWebAccount[] {
  const saved = readSaved();
  const fallbackToken = String(saved?.authToken ?? process.env.MEXC_WEB_AUTH_TOKEN ?? "").trim();
  try {
    return buildAccounts(
      {
        accounts: saved?.accounts,
        masterAccountId: saved?.masterAccountId
      },
      fallbackToken
    );
  } catch {
    return [];
  }
}

function terminalOrderTargets(input: Record<string, unknown>, settings: Required<SavedTerminalConfig>): TerminalOrderTarget[] {
  const accounts = terminalAccounts();
  const selected =
    settings.accountMode === "group"
      ? accounts
      : accounts.filter((account) => account.id === settings.accountId || (!settings.accountId && account.role === "master"));
  return selected.map((account) => ({
    account,
    margin: Math.max(0.1, settings.accountMargins[account.id] ?? settings.margin)
  }));
}

function parseTerminalAccountMargins(input: unknown, saved: Record<string, number> | undefined): Record<string, number> {
  const margins: Record<string, number> = { ...(saved ?? {}) };
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const id = String(record.accountId ?? record.id ?? "").trim();
      const margin = Number(record.margin);
      if (id && Number.isFinite(margin) && margin > 0) {
        margins[id] = margin;
      }
    }
  } else if (typeof input === "object" && input !== null) {
    for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
      const margin = Number(value);
      if (id && Number.isFinite(margin) && margin > 0) {
        margins[id] = margin;
      }
    }
  }
  return margins;
}

function saveTerminalSettings(settings: Required<SavedTerminalConfig>): void {
  const previous = readSaved();
  const next: SavedWebConfig = {
    ...((previous ?? {}) as SavedWebConfig),
    terminal: settings,
    symbolHistory: Array.from(
      new Set([settings.symbol, ...(previous?.symbolHistory ?? []), previous?.symbol].filter((symbol): symbol is string => Boolean(symbol)))
    ).slice(0, 10)
  };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
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
    throw new Error("Live mode requires confirmation from the UI");
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

function currentSpreadStatus(config = activeSpreadConfig ?? buildSpreadCheckerConfig({})): SpreadRuntimeStatus {
  const filterKey = `${config.marketScope}:${config.displayMinSpreadPercent}:${config.symbols.join(",")}`;
  if (filterKey !== spreadDisplayFilterKey) {
    spreadVisibleRows.clear();
    spreadDisplayOrder.clear();
    spreadDisplayFilterKey = filterKey;
    spreadDisplayOrderCounter = 0;
  }
  const now = Date.now();
  const visibleRows = spreadRows
    .filter((row) => shouldShowSpreadRow(config, row, now))
    .sort((left, right) => spreadRowDisplayOrder(left) - spreadRowDisplayOrder(right));
  return {
    running: spreadCheckerRunning,
    rows: visibleRows,
    totalRows: spreadRows.length,
    alerts: spreadAlerts,
    callStats: spreadCallStats(),
    activeCalls: Array.from(activeSpreadCalls.values()),
    lastUpdated: spreadRows[0]?.updatedAt,
    dryRun: config.dryRun,
    settings: config
  };
}

function shouldShowSpreadRow(config: SpreadCheckerConfig, row: SpreadRow, now: number): boolean {
  if (row.error) {
    return config.marketScope === "custom";
  }
  const spreadPercent = Math.max(row.mexcSpreadPercent ?? 0, row.crossSpreadPercent ?? 0);
  if (config.displayMinSpreadPercent <= 0) {
    ensureSpreadDisplayOrder(row.symbol);
    return true;
  }
  const releasePercent = Math.max(0, config.displayMinSpreadPercent * 0.8);
  if (spreadPercent >= config.displayMinSpreadPercent) {
    spreadVisibleRows.set(row.symbol, now);
    ensureSpreadDisplayOrder(row.symbol);
    return true;
  }
  const lastAboveThreshold = spreadVisibleRows.get(row.symbol);
  if (
    lastAboveThreshold !== undefined &&
    (spreadPercent >= releasePercent || now - lastAboveThreshold <= SPREAD_DISPLAY_LINGER_MS)
  ) {
    ensureSpreadDisplayOrder(row.symbol);
    return true;
  }
  spreadVisibleRows.delete(row.symbol);
  spreadDisplayOrder.delete(row.symbol);
  return false;
}

function ensureSpreadDisplayOrder(symbol: string): void {
  if (!spreadDisplayOrder.has(symbol)) {
    spreadDisplayOrderCounter += 1;
    spreadDisplayOrder.set(symbol, spreadDisplayOrderCounter);
  }
}

function spreadRowDisplayOrder(row: SpreadRow): number {
  return spreadDisplayOrder.get(row.symbol) ?? Number.MAX_SAFE_INTEGER;
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

function saveSpreadCheckerConfig(config: SpreadCheckerConfig): void {
  const previous = readSaved();
  const next: SavedWebConfig = {
    ...((previous ?? {}) as SavedWebConfig),
    spreadChecker: config
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
  sendEvent(res, "spread", currentSpreadStatus());
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

async function fetchMexcTickerPrices(): Promise<MexcTickerPrices> {
  const payload = await fetchJson(`${MEXC_CONTRACT_BASE_URL}/api/v1/contract/ticker`);
  const data = dataValue(payload);
  const rows = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>);
  return rowsToMexcTickerPrices(rows);
}

async function fetchMexcContractDetails(): Promise<MexcContractDetails> {
  const payload = await fetchJson(`${MEXC_CONTRACT_BASE_URL}/api/v1/contract/detail`);
  const data = dataValue(payload);
  const rows = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>);
  const maxLeverage = new Map<string, number>();
  const maxPositionBase = new Map<string, number>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const symbol = normalizeSymbol(String(record.symbol ?? ""));
    if (!isUsdtPerpetualSymbol(symbol)) {
      continue;
    }
    const leverage = optionalNumberField(record, "countryConfigContractMaxLeverage") ?? optionalNumberField(record, "maxLeverage");
    if (leverage !== undefined) {
      maxLeverage.set(symbol, leverage);
    }
    const maxVol = optionalNumberField(record, "maxVol");
    const contractSize = optionalNumberField(record, "contractSize");
    if (maxVol !== undefined && contractSize !== undefined) {
      maxPositionBase.set(symbol, maxVol * contractSize);
    }
  }
  return { maxLeverage, maxPositionBase };
}

async function fetchMexcFairPrice(symbol: string): Promise<number> {
  const payload = await fetchJson(`${MEXC_CONTRACT_BASE_URL}/api/v1/contract/fair_price/${encodeURIComponent(symbol)}`);
  const data = dataValue(payload);
  if (Array.isArray(data)) {
    throw new Error(`Unexpected MEXC fair price response for ${symbol}`);
  }
  return numberField(data, "fairPrice", `MEXC fair price ${symbol}`);
}

async function fetchMexcTickerData(symbol: string): Promise<Record<string, unknown>> {
  const payload = await fetchJson(`${MEXC_CONTRACT_BASE_URL}/api/v1/contract/ticker?symbol=${encodeURIComponent(symbol)}`);
  const data = dataValue(payload);
  if (Array.isArray(data)) {
    const row = data.find((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).symbol === symbol);
    if (!row || typeof row !== "object") {
      throw new Error(`MEXC ticker did not contain ${symbol}`);
    }
    return row as Record<string, unknown>;
  }
  return data;
}

async function fetchGateTickerPrices(): Promise<GateTickerPrices> {
  const payload = await fetchJson(`${GATE_API_BASE_URL}/futures/usdt/tickers`);
  if (!Array.isArray(payload)) {
    throw new Error("Unexpected Gate.io ticker response");
  }
  return rowsToGateTickerPrices(payload);
}

async function fetchJson(url: string, attempts = 3): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }
      await delay(Math.min(500 * 2 ** (attempt - 1), 4_000));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : String(lastError));
}

async function sendSpreadNotification(config: SpreadCheckerConfig, message: string): Promise<void> {
  if (config.dryRun) {
    pushWebLog("INFO", `DRY-RUN Spread notification: ${message.replace(/\n/g, " | ")}`);
    return;
  }
  if (config.notificationMethod === "sms") {
    await sendTwilioMessage(config, message);
    return;
  }
  if (config.notificationMethod === "call") {
    await sendTwilioCall(config, message);
    return;
  }
  if (config.notificationMethod === "push" && config.pushProvider === "ntfy") {
    await sendNtfy(config, message);
    return;
  }
  if (config.notificationMethod === "push") {
    await sendPushover(config, message);
    return;
  }
  throw new Error("Email-to-SMS delivery is saved for the Python Spread Checker; the web runtime does not include SMTP delivery.");
}

async function sendTwilioMessage(config: SpreadCheckerConfig, message: string): Promise<void> {
  requireSpreadFields(config, ["twilioAccountSid", "twilioAuthToken", "twilioFromNumber", "twilioToNumber"]);
  const body = new URLSearchParams({
    Body: message,
    From: config.twilioFromNumber,
    To: config.twilioToNumber
  });
  await postForm(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`,
    body,
    twilioHeaders(config)
  );
}

async function sendTwilioCall(config: SpreadCheckerConfig, message: string): Promise<void> {
  requireSpreadFields(config, ["twilioAccountSid", "twilioAuthToken", "twilioFromNumber", "twilioToNumber"]);
  const body = new URLSearchParams({
    Twiml: `<Response><Say voice="alice">${escapeXml(message)}</Say></Response>`,
    From: config.twilioFromNumber,
    To: config.twilioToNumber
  });
  await postForm(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Calls.json`,
    body,
    twilioHeaders(config)
  );
}

async function sendPushover(config: SpreadCheckerConfig, message: string): Promise<void> {
  requireSpreadFields(config, ["pushoverAppToken", "pushoverUserKey"]);
  await postForm(
    "https://api.pushover.net/1/messages.json",
    new URLSearchParams({
      token: config.pushoverAppToken,
      user: config.pushoverUserKey,
      title: "Spread Checker",
      message
    })
  );
}

async function sendNtfy(config: SpreadCheckerConfig, message: string): Promise<void> {
  requireSpreadFields(config, ["ntfyServer", "ntfyTopic"]);
  const headers: Record<string, string> = {
    Title: "Spread Checker",
    Priority: "urgent"
  };
  if (config.ntfyToken) {
    headers.Authorization = `Bearer ${config.ntfyToken}`;
  }
  const response = await fetch(`${config.ntfyServer.replace(/\/$/, "")}/${encodeURIComponent(config.ntfyTopic)}`, {
    method: "POST",
    headers,
    body: message
  });
  if (!response.ok) {
    throw new Error(`ntfy failed: HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

async function postForm(url: string, body: URLSearchParams, headers: Record<string, string> = {}): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers
    },
    body
  });
  if (!response.ok) {
    throw new Error(`Notification request failed: HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

function formatMexcSpreadAlert(
  config: SpreadCheckerConfig,
  row: SpreadRow,
  context?: { call: ActiveSpreadCall; stats: SpreadCallStats }
): string {
  const url = `https://www.mexc.com/futures/${encodeURIComponent(row.symbol)}`;
  const tradeSide = mexcInternalTradeSide(row);
  const terminalUrl = terminalTradeUrl(row.symbol, tradeSide);
  const statLines = formatSpreadCallStatLines(config, context);
  if (config.alertLanguage === "en") {
    return [
      `🔴 MEXC Fair/Last spread on ${row.symbol} ${formatFixed(row.mexcSpreadPercent, 2)}%`,
      url,
      `Terminal: ${terminalUrl}`,
      "",
      `✅ Open on MEXC: ${tradeSide}`,
      tradeSide === "SHORT" ? "Last is above Fair, trade expects move down to Fair." : "Last is below Fair, trade expects move up to Fair.",
      ...statLines,
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "💰 Prices:",
      `  • Last Price (futures): $${formatAlertPrice(row.mexcLast)}`,
      `  • Fair Price: $${formatAlertPrice(row.fairPrice)}`,
      "━━━━━━━━━━━━━━━━━━━━",
      `Max leverage: ${row.maxLeverage ? `${row.maxLeverage}x` : "-"}`,
      `Max position: ${row.maxPositionUsdt ? `🟢 $${formatMoney(row.maxPositionUsdt)} USDT` : "-"}`,
      `Direction: ${row.mexcDirection ?? "-"}`,
      "",
      `⏰ ${formatUtc(row.updatedAt)} UTC`,
      "",
      "MEXC"
    ].join("\n");
  }
  return [
    `🔴 Разница цен на ${row.symbol} ${formatFixed(row.mexcSpreadPercent, 2)}%`,
    url,
    `Терминал: ${terminalUrl}`,
    "",
    `✅ Открывать на MEXC: ${tradeSide}`,
    tradeSide === "SHORT" ? "Last выше Fair, идея: шорт к возврату на Fair." : "Last ниже Fair, идея: лонг к возврату на Fair.",
    ...statLines,
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "💰 Цены:",
    `  • Last Price (фьючерс): $${formatAlertPrice(row.mexcLast)}`,
    `  • Fair Price: $${formatAlertPrice(row.fairPrice)}`,
    "━━━━━━━━━━━━━━━━━━━━",
    `Макс. плечо: ${row.maxLeverage ? `${row.maxLeverage}x` : "-"}`,
    `Макс. позиция: ${row.maxPositionUsdt ? `🟢 $${formatMoney(row.maxPositionUsdt)} USDT` : "-"}`,
    `Направление: ${row.mexcDirection ?? "-"}`,
    "",
    `⏰ ${formatUtc(row.updatedAt)} UTC`,
    "",
    "MEXC"
  ].join("\n");
}

function formatCrossSpreadAlert(
  config: SpreadCheckerConfig,
  row: SpreadRow,
  context?: { call: ActiveSpreadCall; stats: SpreadCallStats }
): string {
  const base = row.symbol.replace(/_USDT$/, "");
  const mexcLast = row.mexcLast ?? 0;
  const gateLast = row.gateLast ?? 0;
  const longExchange = gateLast < mexcLast ? "GATE" : "MEXC";
  const shortExchange = gateLast < mexcLast ? "MEXC" : "GATE";
  const longPrice = gateLast < mexcLast ? gateLast : mexcLast;
  const shortPrice = gateLast < mexcLast ? mexcLast : gateLast;
  const fundingMexc = formatFunding(row.mexcFundingRate);
  const fundingGate = formatFunding(row.gateFundingRate);
  const mexcSide = longExchange === "MEXC" ? "LONG" : "SHORT";
  const terminalUrl = terminalTradeUrl(row.symbol, mexcSide);
  const statLines = formatSpreadCallStatLines(config, context);

  if (config.alertLanguage === "en") {
    return [
      `📈📈 #${base} | Spread: ${formatFixed(row.crossSpreadPercent, 2)}%`,
      `📌 ${row.symbol} (COPY: ${base})`,
      `Terminal MEXC ${mexcSide}: ${terminalUrl}`,
      "",
      `✅ Open: LONG ${longExchange} / SHORT ${shortExchange}`,
      ...statLines,
      "",
      `🟢 Long  ${longExchange.padEnd(5)}: $${formatAlertPrice(longPrice)}`,
      `🔴 Short ${shortExchange.padEnd(5)}: $${formatAlertPrice(shortPrice)}`,
      "",
      `🌗 Funding MEXC : ${fundingMexc}`,
      `🌓 Funding GATE : ${fundingGate}`,
      "",
      `⏰ ${formatUtc(row.updatedAt)} UTC`
    ].join("\n");
  }
  return [
    `📈📈 #${base} | Спред: ${formatFixed(row.crossSpreadPercent, 2)}%`,
    `📌 ${row.symbol} (COPY: ${base})`,
    `Терминал MEXC ${mexcSide}: ${terminalUrl}`,
    "",
    `✅ Открывать: LONG ${longExchange} / SHORT ${shortExchange}`,
    ...statLines,
    "",
    `🟢 Лонг  ${longExchange.padEnd(5)}: $${formatAlertPrice(longPrice)}`,
    `🔴 Шорт ${shortExchange.padEnd(5)}: $${formatAlertPrice(shortPrice)}`,
    "",
    `🌗 Funding MEXC : ${fundingMexc}`,
    `🌓 Funding GATE : ${fundingGate}`,
    "",
    `⏰ ${formatUtc(row.updatedAt)} UTC`
  ].join("\n");
}

function mexcInternalTradeSide(row: SpreadRow): "LONG" | "SHORT" {
  return row.mexcDirection === "MEXC_LAST_ABOVE_FAIR" ? "SHORT" : "LONG";
}

function spreadTradePlan(row: SpreadRow, type: SpreadCallType): string {
  if (type === "MEXC_INTERNAL") {
    return `MEXC ${mexcInternalTradeSide(row)}`;
  }
  const mexcLast = row.mexcLast ?? 0;
  const gateLast = row.gateLast ?? 0;
  const longExchange = gateLast < mexcLast ? "GATE" : "MEXC";
  const shortExchange = gateLast < mexcLast ? "MEXC" : "GATE";
  return `LONG ${longExchange} / SHORT ${shortExchange}`;
}

function terminalTradeUrl(symbol: string, side: "LONG" | "SHORT"): string {
  const action = side === "LONG" ? "BUY" : "SELL";
  return `${PUBLIC_WEB_BASE_URL}/?tab=terminal&symbol=${encodeURIComponent(symbol)}&side=${side}&action=${action}`;
}

function formatSpreadCallStatLines(config: SpreadCheckerConfig, context?: { call: ActiveSpreadCall; stats: SpreadCallStats }): string[] {
  if (!context) {
    return [];
  }
  const estimated = context.stats.estimatedConvergenceMs;
  if (config.alertLanguage === "en") {
    return [
      "",
      `📊 Calls: ${context.stats.converged}/${context.stats.totalStarted} converged, active ${context.stats.active}`,
      `🎯 Converged at <= ${formatFixed(context.call.targetSpreadPercent, 4)}% | ETA: ${
        estimated === undefined ? "collecting history" : `~${formatDuration(estimated)}`
      }`
    ];
  }
  return [
    "",
    `📊 Стата calls: ${context.stats.converged}/${context.stats.totalStarted} сходилось, активных ${context.stats.active}`,
    `🎯 Схождение <= ${formatFixed(context.call.targetSpreadPercent, 4)}% | ETA: ${
      estimated === undefined ? "собираем историю" : `~${formatDuration(estimated)}`
    }`
  ];
}

function pushWebLog(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const entry = { level, message, timestamp: new Date().toISOString() };
  recentLogs.push(entry);
  if (recentLogs.length > 300) {
    recentLogs.shift();
  }
  broadcast("log", entry);
}

function dataValue(payload: unknown): unknown[] | Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`Unexpected response shape: ${String(payload)}`);
  }
  const value = (payload as Record<string, unknown>).data;
  if ((typeof value !== "object" || value === null) && !Array.isArray(value)) {
    throw new Error("Response missing data field");
  }
  return value as unknown[] | Record<string, unknown>;
}

function numberField(record: Record<string, unknown>, key: string, label: string): number {
  const value = Number(record[key]);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${label}: ${String(record[key])}`);
  }
  return value;
}

function optionalNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = Number(record[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalFiniteNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = Number(record[key]);
  return Number.isFinite(value) ? value : undefined;
}

function rowsToMexcTickerPrices(rows: unknown[]): MexcTickerPrices {
  const fairPrices = new Map<string, number>();
  const lastPrices = new Map<string, number>();
  const indexPrices = new Map<string, number>();
  const fundingRates = new Map<string, number>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const symbol = normalizeSymbol(String(record.symbol ?? ""));
    if (!isUsdtPerpetualSymbol(symbol)) {
      continue;
    }
    const fairPrice = optionalNumberField(record, "fairPrice");
    const lastPrice = optionalNumberField(record, "lastPrice");
    if (fairPrice === undefined || lastPrice === undefined) {
      continue;
    }
    fairPrices.set(symbol, fairPrice);
    lastPrices.set(symbol, lastPrice);
    const indexPrice = optionalNumberField(record, "indexPrice");
    if (indexPrice !== undefined) {
      indexPrices.set(symbol, indexPrice);
    }
    const fundingRate = optionalFiniteNumberField(record, "fundingRate");
    if (fundingRate !== undefined) {
      fundingRates.set(symbol, fundingRate);
    }
  }
  if (fairPrices.size === 0 || lastPrices.size === 0) {
    throw new Error("MEXC ticker response did not contain active USDT prices");
  }
  return { fairPrices, lastPrices, indexPrices, fundingRates };
}

function rowsToGateTickerPrices(rows: unknown[]): GateTickerPrices {
  const lastPrices = new Map<string, number>();
  const indexPrices = new Map<string, number>();
  const fundingRates = new Map<string, number>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const symbol = normalizeSymbol(String(record.contract ?? ""));
    if (!isUsdtPerpetualSymbol(symbol)) {
      continue;
    }
    const lastPrice = optionalNumberField(record, "last");
    if (lastPrice === undefined) {
      continue;
    }
    lastPrices.set(symbol, lastPrice);
    const indexPrice = optionalNumberField(record, "index_price");
    if (indexPrice !== undefined) {
      indexPrices.set(symbol, indexPrice);
    }
    const fundingRate = optionalFiniteNumberField(record, "funding_rate");
    if (fundingRate !== undefined) {
      fundingRates.set(symbol, fundingRate);
    }
  }
  if (lastPrices.size === 0) {
    throw new Error("Gate.io ticker response did not contain active USDT prices");
  }
  return { lastPrices, indexPrices, fundingRates };
}

function isCrossCompatible(input: { mexcLast: number; gateLast: number; mexcIndex?: number; gateIndex?: number }): boolean {
  if (input.mexcIndex !== undefined && input.gateIndex !== undefined) {
    return (Math.abs(input.gateIndex - input.mexcIndex) / input.mexcIndex) * 100 <= CROSS_INDEX_COMPATIBILITY_MAX_PERCENT;
  }
  return (Math.abs(input.gateLast - input.mexcLast) / input.mexcLast) * 100 <= CROSS_LAST_PRICE_SANITY_MAX_PERCENT;
}

function maxPositionUsdt(maxPositionBase: number | undefined, price: number): number | undefined {
  if (maxPositionBase === undefined || !Number.isFinite(price) || price <= 0) {
    return undefined;
  }
  return maxPositionBase * price;
}

function requireSpreadFields(config: SpreadCheckerConfig, fields: Array<keyof SpreadCheckerConfig>): void {
  const missing = fields.filter((field) => !String(config[field] ?? "").trim());
  if (missing.length > 0) {
    throw new Error(`Missing notification settings: ${missing.join(", ")}`);
  }
}

function twilioHeaders(config: SpreadCheckerConfig): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64")}`
  };
}

function stringOption<T extends string>(value: unknown, fallback: T, options: readonly T[]): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  const selected = value === undefined || value === null ? fallback : value;
  return String(selected).trim();
}

function formatPrice(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(2);
}

function formatAlertPrice(value: number | undefined): string {
  if (value === undefined) {
    return "-";
  }
  if (Math.abs(value) >= 1000) {
    return value.toFixed(2);
  }
  if (Math.abs(value) >= 1) {
    return value.toFixed(4);
  }
  return value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

function formatMoney(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatFunding(value: number | undefined): string {
  return value === undefined ? "-" : `${(value * 100).toFixed(2)}%`;
}

function formatFixed(value: number | undefined, digits: number): string {
  return value === undefined ? "-" : value.toFixed(digits);
}

function formatUtc(value: string): string {
  return new Date(value).toISOString().replace("T", " ").slice(0, 19);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char] ?? char);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function nonNegativeNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
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

function isUsdtPerpetualSymbol(symbol: string): boolean {
  return /^[A-Z0-9]+_USDT$/.test(symbol);
}

async function buildSymbols(saved?: SavedWebConfig): Promise<string[]> {
  const savedSymbols = [saved?.symbol, ...(saved?.symbolHistory ?? [])].filter((item): item is string => Boolean(item));
  const contractSymbols = await getCachedContractSymbols();
  return Array.from(new Set([...savedSymbols, ...contractSymbols, ...POPULAR_SYMBOLS].filter(isUsdtPerpetualSymbol))).sort();
}

async function getCachedContractSymbols(): Promise<string[]> {
  const now = Date.now();
  if (cachedSymbols && cachedSymbols.expiresAt > now) {
    return cachedSymbols.symbols;
  }
  try {
    const payload = await fetchJson(`${MEXC_CONTRACT_BASE_URL}/api/v1/contract/detail`);
    const data = dataValue(payload);
    const rows = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>);
    const symbols = rows
      .map((row) => (typeof row === "object" && row !== null ? normalizeSymbol(String((row as Record<string, unknown>).symbol ?? "")) : ""))
      .filter(isUsdtPerpetualSymbol)
      .sort();
    if (symbols.length > 0) {
      cachedSymbols = { symbols, expiresAt: now + 10 * 60 * 1000 };
      return symbols;
    }
  } catch (error) {
    pushWebLog("WARN", `Symbol list refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return POPULAR_SYMBOLS;
}
