import { MexcFuturesWebSocket } from "mexc-futures-sdk";
import { Logger } from "../core/logger";
import { calculateProtectionPrices } from "../core/position-manager";
import { MexcClient } from "../mexc/client";
import { PositionSide } from "../types";
import {
  ScannerAccount,
  ScannerAlert,
  ScannerCandle,
  ScannerConfig,
  ScannerContractMeta,
  ScannerDepth,
  ScannerFeatures,
  ScannerGrade,
  ScannerProfileName,
  ScannerSetupName,
  ScannerStatus,
  ScannerTicker
} from "./types";

const DEFAULT_CONTEXT_SYMBOLS = [
  "BTC_USDT",
  "ETH_USDT",
  "SOL_USDT",
  "XRP_USDT",
  "DOGE_USDT",
  "SUI_USDT",
  "ADA_USDT",
  "LTC_USDT",
  "PEPE_USDT"
];
const MAX_TICKS = 900;
const MAX_CANDLES = 80;
const MAX_ALERTS = 80;
const CANDLE_MS = 60_000;

interface SymbolState {
  ticker?: ScannerTicker;
  depth?: ScannerDepth;
  ticks: ScannerTicker[];
  volumeDeltas: Array<{ timestamp: number; value: number }>;
  candles: ScannerCandle[];
  currentCandle?: ScannerCandle;
  lastAlertAt?: number;
}

interface Candidate {
  symbol: string;
  features: ScannerFeatures;
}

export class ScannerEngine {
  private readonly states = new Map<string, SymbolState>();
  private readonly contracts = new Map<string, ScannerContractMeta>();
  private readonly tickerMap = new Map<string, ScannerTicker>();
  private readonly alerts: ScannerAlert[] = [];
  private readonly masterAccount: ScannerAccount;
  private readonly dataClient: MexcClient;
  private running = false;
  private wsConnected = false;
  private ws?: MexcFuturesWebSocket;
  private loop?: NodeJS.Timeout;
  private metadataLoop?: NodeJS.Timeout;
  private focusedSymbols: string[] = [];
  private topSymbols: ScannerStatus["topSymbols"] = [];
  private lastError?: string;
  private lastScanAt?: number;

  constructor(
    private readonly config: ScannerConfig,
    private readonly logger: Logger,
    private readonly onAlert?: (alert: ScannerAlert) => void
  ) {
    this.masterAccount =
      config.accounts.find((account) => account.id === config.masterAccountId) ??
      config.accounts.find((account) => account.role === "master") ??
      config.accounts[0];
    this.dataClient = new MexcClient(this.masterAccount.authToken, true, logger);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.refreshMetadata();
    void this.connectWebSocket();
    await this.scan();
    this.loop = setInterval(() => void this.scan(), this.config.tickIntervalMs);
    this.metadataLoop = setInterval(() => void this.refreshMetadata(), 5 * 60_000);
    this.logger.info(`Scanner started mode=${this.config.executionMode} symbols=${this.config.symbols.length || "dynamic"}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loop) {
      clearInterval(this.loop);
    }
    if (this.metadataLoop) {
      clearInterval(this.metadataLoop);
    }
    this.ws?.disconnect();
    this.ws = undefined;
    this.wsConnected = false;
    this.logger.warn("Scanner stopped");
  }

  getStatus(): ScannerStatus {
    this.expireAlerts();
    return {
      running: this.running,
      wsConnected: this.wsConnected,
      mode: this.config.executionMode,
      dryRun: this.config.dryRun,
      focusedSymbols: [...this.focusedSymbols],
      topSymbols: [...this.topSymbols],
      alerts: [...this.alerts],
      lastError: this.lastError,
      lastScanAt: this.lastScanAt
    };
  }

  async executeAlert(alertId: string): Promise<ScannerAlert> {
    const alert = this.alerts.find((item) => item.id === alertId);
    if (!alert) {
      throw new Error("Scanner alert not found");
    }
    if (alert.status !== "new") {
      return alert;
    }

    const accounts = this.config.executionMode === "semi_auto" ? this.config.accounts : [this.masterAccount];
    const protection = calculateProtectionPrices({
      side: alert.side,
      entryPrice: alert.entry,
      takeProfitPercent: Math.abs((alert.tp2 - alert.entry) / alert.entry) * 100,
      stopLossPercent: alert.stopPct
    });

    try {
      for (const account of accounts) {
        const client = new MexcClient(account.authToken, this.config.dryRun, new Logger({
          minLevel: this.config.debug ? "DEBUG" : "INFO",
          prefix: `Scanner ${account.name}`
        }));
        const volume = await client.calculateVolume(alert.symbol, alert.requiredMargin, alert.leverage, alert.entry);
        await client.openMarketPosition({
          symbol: alert.symbol,
          side: alert.side,
          price: alert.entry,
          volume,
          leverage: alert.leverage,
          stopLossPrice: protection.stopLossPrice,
          takeProfitPrice: protection.takeProfitPrice
        });
      }
      alert.status = "executed";
      alert.executedAt = Date.now();
      this.logger.info(`Scanner executed ${alert.grade} ${alert.symbol} ${alert.side} ${alert.setup}`);
      return alert;
    } catch (error) {
      alert.status = "rejected";
      alert.executionError = error instanceof Error ? error.message : String(error);
      this.logger.error(`Scanner execution failed for ${alert.symbol}`, error);
      return alert;
    }
  }

  private async connectWebSocket(): Promise<void> {
    try {
      const ws = new MexcFuturesWebSocket({
        apiKey: "",
        secretKey: "",
        autoReconnect: true,
        logLevel: this.config.debug ? "DEBUG" : "ERROR"
      });
      this.ws = ws;
      ws.on("connected", () => {
        this.wsConnected = true;
        ws.subscribeToAllTickers();
        for (const symbol of this.focusedSymbols) {
          this.subscribeFocused(symbol);
        }
      });
      ws.on("disconnected", () => {
        this.wsConnected = false;
      });
      ws.on("tickers", (data) => this.ingestTickers(data));
      ws.on("ticker", (data) => this.ingestTicker(parseTicker(data)));
      ws.on("depth", (data) => this.ingestDepth(data));
      ws.on("kline", (data) => this.ingestKline(data));
      ws.on("fundingRate", (data) => this.ingestFundingRate(data));
      ws.on("error", (error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
      await ws.connect();
    } catch (error) {
      this.wsConnected = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Scanner WS unavailable; REST fallback active: ${this.lastError}`);
    }
  }

  private async refreshMetadata(): Promise<void> {
    const details = await this.dataClient.getAllContractDetails();
    for (const detail of details) {
      this.contracts.set(detail.symbol, {
        symbol: detail.symbol,
        contractSize: detail.contractSize ?? 1,
        priceUnit: detail.priceUnit ?? minPriceUnit(detail.priceScale),
        maxLeverage: detail.maxLeverage ?? 20,
        state: detail.state,
        isNew: detail.isNew,
        isHot: detail.isHot,
        isHidden: detail.isHidden,
        apiAllowed: detail.apiAllowed,
        makerFeeRate: detail.makerFeeRate,
        takerFeeRate: detail.takerFeeRate,
        isZeroFeeSymbol: inferZeroFee(detail.raw)
      });
    }
  }

  private async scan(): Promise<void> {
    if (!this.running) {
      return;
    }
    try {
      await this.ensureSeedTickers();
      const candidates = await this.rankCandidates();
      this.topSymbols = candidates.slice(0, 20).map((candidate) => ({
        symbol: candidate.symbol,
        score: candidate.features.score,
        profile: candidate.features.profile,
        price: candidate.features.price,
        spreadPct: candidate.features.spreadPct,
        amount24: candidate.features.amount24
      }));
      this.updateFocused(candidates.slice(0, this.config.maxFocusedSymbols).map((candidate) => candidate.symbol));
      for (const candidate of candidates.slice(0, this.config.maxFocusedSymbols)) {
        const alert = this.detect(candidate);
        if (alert) {
          this.pushAlert(alert);
        }
      }
      this.lastScanAt = Date.now();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error("Scanner loop error", error);
    }
  }

  private async ensureSeedTickers(): Promise<void> {
    const symbols = this.seedSymbols();
    const missing = symbols.filter((symbol) => !this.tickerMap.has(symbol)).slice(0, 24);
    for (const symbol of missing) {
      try {
        const ticker = await this.dataClient.getTickerSnapshot(symbol);
        this.ingestTicker(ticker);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Ticker response does not contain a recognizable price")) {
          this.logger.debug(`Seed ticker skipped ${symbol}: ${message}`);
        }
      }
      await sleep(80);
    }
  }

  private seedSymbols(): string[] {
    const configured = this.config.symbols.map(normalizeSymbol).filter(Boolean);
    const hot = [...this.contracts.values()]
      .filter((contract) => contract.isHot || contract.isNew || contract.isZeroFeeSymbol)
      .slice(0, 40)
      .map((contract) => contract.symbol);
    return Array.from(new Set([...configured, ...DEFAULT_CONTEXT_SYMBOLS, ...hot]));
  }

  private async rankCandidates(): Promise<Candidate[]> {
    const source = this.tickerMap.size > 0 ? [...this.tickerMap.values()] : [];
    const symbols = source.length > 0 ? source.map((ticker) => ticker.symbol) : this.seedSymbols();
    const candidates: Candidate[] = [];
    for (const symbol of symbols) {
      const ticker = this.tickerMap.get(symbol);
      if (!ticker) {
        continue;
      }
      const contract = this.contracts.get(symbol);
      if (!this.contractAllowed(contract)) {
        continue;
      }
      const state = this.state(symbol);
      if (!state.depth && this.focusedSymbols.includes(symbol)) {
        state.depth = await this.loadDepth(symbol);
      }
      const features = this.buildFeatures(symbol);
      if (!features || !this.liquidityAllowed(features, contract)) {
        continue;
      }
      candidates.push({ symbol, features });
    }
    return candidates.sort((a, b) => b.features.score - a.features.score);
  }

  private detect(candidate: Candidate): ScannerAlert | undefined {
    const state = this.state(candidate.symbol);
    if (state.lastAlertAt && Date.now() - state.lastAlertAt < 90_000) {
      return undefined;
    }
    const detectors = [
      this.detectSweepReclaim(candidate),
      this.detectAbsorptionFailure(candidate),
      this.detectCompressionExpansion(candidate)
    ].filter((alert): alert is ScannerAlert => alert !== undefined);
    const alert = detectors.sort((a, b) => b.score - a.score)[0];
    if (!alert || !gradeAllowed(alert.grade, this.config.minGrade)) {
      return undefined;
    }
    state.lastAlertAt = Date.now();
    return alert;
  }

  private detectSweepReclaim(candidate: Candidate): ScannerAlert | undefined {
    const state = this.state(candidate.symbol);
    const candles = closedCandles(state);
    if (candles.length < 16) {
      return undefined;
    }
    const current = state.currentCandle ?? candles.at(-1);
    if (!current) {
      return undefined;
    }
    const range = candles.slice(-16, -1);
    const high = Math.max(...range.map((bar) => bar.high));
    const low = Math.min(...range.map((bar) => bar.low));
    const fullRange = Math.max(current.high - current.low, Number.EPSILON);
    const profile = profileParams(candidate.features.profile);
    const upperExcursion = current.high > high ? (current.high - high) / high : 0;
    const lowerExcursion = current.low < low ? (low - current.low) / low : 0;
    const upperWick = (current.high - Math.max(current.open, current.close)) / fullRange;
    const lowerWick = (Math.min(current.open, current.close) - current.low) / fullRange;

    if (
      upperExcursion >= profile.sweepExcMin &&
      upperExcursion <= profile.sweepExcMax &&
      upperWick >= profile.wickRatio &&
      current.close < high &&
      candidate.features.volMult20 >= profile.sweepVolMult &&
      candidate.features.imbalanceTop5 <= profile.bearishImbalance
    ) {
      return this.makeAlert(candidate, "SWEEP_RECLAIM", "SHORT", high, current.high + stopBuffer(current.close, profile));
    }

    if (
      lowerExcursion >= profile.sweepExcMin &&
      lowerExcursion <= profile.sweepExcMax &&
      lowerWick >= profile.wickRatio &&
      current.close > low &&
      candidate.features.volMult20 >= profile.sweepVolMult &&
      candidate.features.imbalanceTop5 >= profile.bullishImbalance
    ) {
      return this.makeAlert(candidate, "SWEEP_RECLAIM", "LONG", low, current.low - stopBuffer(current.close, profile));
    }
    return undefined;
  }

  private detectAbsorptionFailure(candidate: Candidate): ScannerAlert | undefined {
    const state = this.state(candidate.symbol);
    const ticks = state.ticks.slice(-12);
    if (ticks.length < 6 || !state.depth) {
      return undefined;
    }
    const profile = profileParams(candidate.features.profile);
    const first = ticks[0].lastPrice;
    const last = ticks.at(-1)?.lastPrice ?? first;
    const progressPct = Math.abs(last - first) / first;
    const recentHigh = Math.max(...ticks.map((tick) => tick.lastPrice));
    const recentLow = Math.min(...ticks.map((tick) => tick.lastPrice));
    const askReplenishment = sumLevels(state.depth.asks, 5);
    const bidReplenishment = sumLevels(state.depth.bids, 5);

    if (
      progressPct <= profile.absorptionProgress &&
      candidate.features.volMult20 >= profile.absorptionVolMult &&
      candidate.features.imbalanceTop5 <= profile.bearishImbalance &&
      askReplenishment > bidReplenishment * 1.35 &&
      last < recentLow + (recentHigh - recentLow) * 0.35
    ) {
      return this.makeAlert(candidate, "ABSORPTION_FAILURE", "SHORT", last, recentHigh + stopBuffer(last, profile));
    }

    if (
      progressPct <= profile.absorptionProgress &&
      candidate.features.volMult20 >= profile.absorptionVolMult &&
      candidate.features.imbalanceTop5 >= profile.bullishImbalance &&
      bidReplenishment > askReplenishment * 1.35 &&
      last > recentLow + (recentHigh - recentLow) * 0.65
    ) {
      return this.makeAlert(candidate, "ABSORPTION_FAILURE", "LONG", last, recentLow - stopBuffer(last, profile));
    }
    return undefined;
  }

  private detectCompressionExpansion(candidate: Candidate): ScannerAlert | undefined {
    const candles = closedCandles(this.state(candidate.symbol));
    if (candles.length < 8) {
      return undefined;
    }
    const profile = profileParams(candidate.features.profile);
    const boxBars = candles.slice(-7, -1);
    const breakout = candles.at(-1);
    if (!breakout) {
      return undefined;
    }
    const high = Math.max(...boxBars.map((bar) => bar.high));
    const low = Math.min(...boxBars.map((bar) => bar.low));
    const mid = (high + low) / 2;
    const boxPct = (high - low) / mid;
    const bodyRatio = Math.abs(breakout.close - breakout.open) / Math.max(breakout.high - breakout.low, Number.EPSILON);
    if (boxPct > profile.compressionWidth || bodyRatio < profile.breakBodyRatio || candidate.features.volMult20 < profile.breakoutVolMult) {
      return undefined;
    }
    if (breakout.close > high && candidate.features.imbalanceTop5 >= profile.bullishImbalance) {
      return this.makeAlert(candidate, "COMPRESSION_EXPANSION", "LONG", high, high - (high - low) * 0.35);
    }
    if (breakout.close < low && candidate.features.imbalanceTop5 <= profile.bearishImbalance) {
      return this.makeAlert(candidate, "COMPRESSION_EXPANSION", "SHORT", low, low + (high - low) * 0.35);
    }
    return undefined;
  }

  private makeAlert(
    candidate: Candidate,
    setup: ScannerSetupName,
    side: PositionSide,
    entry: number,
    stop: number
  ): ScannerAlert {
    const priceUnit = this.contracts.get(candidate.symbol)?.priceUnit ?? minPriceUnit(undefined);
    const normalizedEntry = roundToUnit(entry, priceUnit);
    const normalizedStop = roundToUnit(stop, priceUnit);
    const stopPct = Math.max(Math.abs((normalizedEntry - normalizedStop) / normalizedEntry) * 100, 0.01);
    const riskUsdt = this.config.equityUsdt * this.config.riskPct;
    const notional = riskUsdt / (stopPct / 100);
    const leverage = Math.min(this.config.leverage, this.contracts.get(candidate.symbol)?.maxLeverage ?? this.config.leverage);
    const requiredMargin = notional / leverage;
    const reward = Math.abs(normalizedEntry - normalizedStop);
    const tp1 = side === "LONG" ? normalizedEntry + reward : normalizedEntry - reward;
    const tp2 = side === "LONG" ? normalizedEntry + reward * 2 : normalizedEntry - reward * 2;
    const grade = gradeFromScore(candidate.features.score + setupBonus(setup));
    return {
      id: `${Date.now()}-${candidate.symbol}-${setup}`,
      createdAt: Date.now(),
      expiresAt: Date.now() + 90_000,
      symbol: candidate.symbol,
      setup,
      side,
      grade,
      score: candidate.features.score + setupBonus(setup),
      profile: candidate.features.profile,
      entry: normalizedEntry,
      stop: normalizedStop,
      tp1: roundToUnit(tp1, priceUnit),
      tp2: roundToUnit(tp2, priceUnit),
      riskUsdt,
      requiredMargin,
      notional,
      leverage,
      stopPct,
      features: candidate.features,
      reason: `${setup} ${side} score=${candidate.features.score.toFixed(2)} vol=${candidate.features.volMult20.toFixed(2)} spread=${(candidate.features.spreadPct * 100).toFixed(3)}%`,
      status: "new"
    };
  }

  private pushAlert(alert: ScannerAlert): void {
    if (this.alerts.some((item) => item.symbol === alert.symbol && item.setup === alert.setup && item.status === "new")) {
      return;
    }
    this.alerts.unshift(alert);
    if (this.alerts.length > MAX_ALERTS) {
      this.alerts.pop();
    }
    this.logger.info(
      `[${alert.grade}] ${alert.symbol} ${alert.side} | ${alert.setup} | entry ${alert.entry} | stop ${alert.stop} | tp1 ${alert.tp1} | tp2 ${alert.tp2} | margin ${alert.requiredMargin.toFixed(2)} USDT @${alert.leverage}x`
    );
    this.onAlert?.(alert);
  }

  private buildFeatures(symbol: string): ScannerFeatures | undefined {
    const state = this.state(symbol);
    const ticker = state.ticker;
    if (!ticker) {
      return undefined;
    }
    const contract = this.contracts.get(symbol);
    const bid = ticker.bid1 ?? ticker.lastPrice;
    const ask = ticker.ask1 ?? ticker.lastPrice;
    const mid = (bid + ask) / 2 || ticker.lastPrice;
    const spreadPct = ask > bid ? (ask - bid) / mid : 0;
    const depthTop10Usdt = state.depth ? depthNotional(state.depth, 10, contract?.contractSize ?? 1) : 0;
    const bidTop5 = state.depth ? sumLevels(state.depth.bids, 5) : 1;
    const askTop5 = state.depth ? sumLevels(state.depth.asks, 5) : 1;
    const imbalanceTop5 = bidTop5 / Math.max(askTop5, Number.EPSILON);
    const amount24 = ticker.amount24 ?? 0;
    const volumeDelta1m = rollingSum(state.volumeDeltas, 60_000);
    const medianVolumeDelta20 = median(state.volumeDeltas.slice(-20).map((item) => item.value)) || 1;
    const volMult20 = volumeDelta1m > 0 ? volumeDelta1m / medianVolumeDelta20 : 1;
    const oldTick = [...state.ticks].reverse().find((tick) => Date.now() - tick.timestamp >= 5 * 60_000) ?? state.ticks[0];
    const move5mPct = oldTick ? Math.abs((ticker.lastPrice - oldTick.lastPrice) / oldTick.lastPrice) : Math.abs(ticker.riseFallRate ?? 0);
    const oldOiTick = [...state.ticks].reverse().find((tick) => Date.now() - tick.timestamp >= 60_000);
    const contractSize = contract?.contractSize ?? 1;
    const oiNotional = (ticker.holdVol ?? 0) * contractSize * ticker.lastPrice;
    const oldOi = oldOiTick?.holdVol === undefined ? undefined : oldOiTick.holdVol * contractSize * oldOiTick.lastPrice;
    const oiChange1mPct = oldOi && oldOi > 0 ? (oiNotional - oldOi) / oldOi : 0;
    const fairBasisPct = ticker.fairPrice ? (ticker.lastPrice - ticker.fairPrice) / ticker.fairPrice : 0;
    const fundingRate = ticker.fundingRate ?? 0;
    const profile = classifyProfile(symbol, amount24);
    const score =
      pctLike(Math.log10(Math.max(amount24, 1)), 8) * 0.3 +
      pctLike(depthTop10Usdt / Math.max(spreadPct, 0.00001), 20_000_000) * 0.2 +
      pctLike(move5mPct, 0.02) * 0.2 +
      pctLike(volMult20, 4) * 0.15 +
      (contract?.isNew || contract?.isHot ? 0.08 : 0) +
      pctLike(Math.abs(oiChange1mPct) + Math.abs(fundingRate) * 10, 0.03) * 0.07;
    return {
      symbol,
      profile,
      price: ticker.lastPrice,
      spreadPct,
      depthTop10Usdt,
      imbalanceTop5,
      amount24,
      volumeDelta1m,
      medianVolumeDelta20,
      volMult20,
      move5mPct,
      oiNotional,
      oiChange1mPct,
      fairBasisPct,
      fundingRate,
      score
    };
  }

  private liquidityAllowed(features: ScannerFeatures, contract?: ScannerContractMeta): boolean {
    const profile = profileParams(features.profile);
    if (features.spreadPct > profile.maxSpread) {
      return false;
    }
    if (features.amount24 < profile.minAmount24) {
      return false;
    }
    if (features.depthTop10Usdt > 0 && features.depthTop10Usdt < profile.minDepthTop10) {
      return false;
    }
    if (this.config.strictZeroFee && !contract?.isZeroFeeSymbol && contract?.makerFeeRate !== 0 && contract?.takerFeeRate !== 0) {
      return false;
    }
    return true;
  }

  private contractAllowed(contract?: ScannerContractMeta): boolean {
    if (!contract) {
      return true;
    }
    if (contract.isHidden) {
      return false;
    }
    if (contract.state !== undefined && contract.state !== 0) {
      return false;
    }
    return true;
  }

  private updateFocused(symbols: string[]): void {
    const next = Array.from(new Set(symbols));
    const removed = this.focusedSymbols.filter((symbol) => !next.includes(symbol));
    const added = next.filter((symbol) => !this.focusedSymbols.includes(symbol));
    this.focusedSymbols = next;
    if (!this.wsConnected || !this.ws) {
      return;
    }
    for (const symbol of removed) {
      this.ws.unsubscribeFromTicker(symbol);
      this.ws.unsubscribeFromDeals(symbol);
      this.ws.unsubscribeFromDepth(symbol);
      this.ws.unsubscribeFromKline(symbol);
      this.ws.unsubscribeFromFundingRate(symbol);
    }
    for (const symbol of added) {
      this.subscribeFocused(symbol);
    }
  }

  private subscribeFocused(symbol: string): void {
    if (!this.ws) {
      return;
    }
    this.ws.subscribeToTicker(symbol);
    this.ws.subscribeToDeals(symbol);
    this.ws.subscribeToDepth(symbol, false);
    this.ws.subscribeToKline(symbol, "Min1");
    this.ws.subscribeToFundingRate(symbol);
  }

  private ingestTickers(data: unknown): void {
    const items = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.data) ? data.data : isRecord(data) ? Object.values(data) : [];
    for (const item of items) {
      this.ingestTicker(parseTicker(item));
    }
  }

  private ingestTicker(ticker?: ScannerTicker): void {
    if (!ticker || !ticker.symbol || !Number.isFinite(ticker.lastPrice)) {
      return;
    }
    const previous = this.tickerMap.get(ticker.symbol);
    this.tickerMap.set(ticker.symbol, ticker);
    const state = this.state(ticker.symbol);
    state.ticker = ticker;
    state.ticks.push(ticker);
    if (state.ticks.length > MAX_TICKS) {
      state.ticks.shift();
    }
    if (previous?.volume24 !== undefined && ticker.volume24 !== undefined) {
      const delta = ticker.volume24 - previous.volume24;
      if (delta > 0) {
        state.volumeDeltas.push({ timestamp: ticker.timestamp, value: delta });
        state.volumeDeltas.splice(0, Math.max(0, state.volumeDeltas.length - 200));
      }
    }
    this.updateCandle(state, ticker);
  }

  private ingestDepth(data: unknown): void {
    if (!isRecord(data)) {
      return;
    }
    const symbol = String(data.symbol ?? data.s ?? "");
    if (!symbol) {
      return;
    }
    const bids = parseDepthSide(data.bids ?? data.bid);
    const asks = parseDepthSide(data.asks ?? data.ask);
    if (bids.length === 0 || asks.length === 0) {
      return;
    }
    this.state(symbol).depth = { bids, asks, timestamp: Date.now() };
  }

  private ingestKline(data: unknown): void {
    if (!isRecord(data)) {
      return;
    }
    const symbol = String(data.symbol ?? data.s ?? "");
    const close = numberValue(data.close ?? data.c);
    if (!symbol || close === undefined) {
      return;
    }
    const openedAt = numberValue(data.t ?? data.openedAt) ?? Math.floor(Date.now() / CANDLE_MS) * CANDLE_MS;
    const candle: ScannerCandle = {
      open: numberValue(data.open ?? data.o) ?? close,
      high: numberValue(data.high ?? data.h) ?? close,
      low: numberValue(data.low ?? data.l) ?? close,
      close,
      volume: numberValue(data.volume ?? data.v) ?? 0,
      openedAt,
      closedAt: openedAt + CANDLE_MS
    };
    const state = this.state(symbol);
    state.currentCandle = candle;
    if (Date.now() >= candle.closedAt) {
      state.candles.push(candle);
      state.currentCandle = undefined;
      if (state.candles.length > MAX_CANDLES) {
        state.candles.shift();
      }
    }
  }

  private ingestFundingRate(data: unknown): void {
    if (!isRecord(data)) {
      return;
    }
    const symbol = String(data.symbol ?? data.s ?? "");
    const fundingRate = numberValue(data.fundingRate ?? data.r);
    const ticker = symbol ? this.tickerMap.get(symbol) : undefined;
    if (ticker && fundingRate !== undefined) {
      this.ingestTicker({ ...ticker, fundingRate, timestamp: Date.now() });
    }
  }

  private async loadDepth(symbol: string): Promise<ScannerDepth | undefined> {
    const depth = await this.dataClient.getOrderBook(symbol, 20);
    return depth ? { bids: depth.bids, asks: depth.asks, timestamp: depth.timestamp } : undefined;
  }

  private updateCandle(state: SymbolState, ticker: ScannerTicker): void {
    const bucket = Math.floor(ticker.timestamp / CANDLE_MS) * CANDLE_MS;
    if (!state.currentCandle || state.currentCandle.openedAt !== bucket) {
      if (state.currentCandle) {
        state.candles.push(state.currentCandle);
        if (state.candles.length > MAX_CANDLES) {
          state.candles.shift();
        }
      }
      state.currentCandle = {
        open: ticker.lastPrice,
        high: ticker.lastPrice,
        low: ticker.lastPrice,
        close: ticker.lastPrice,
        volume: 0,
        openedAt: bucket,
        closedAt: bucket + CANDLE_MS
      };
      return;
    }
    state.currentCandle.high = Math.max(state.currentCandle.high, ticker.lastPrice);
    state.currentCandle.low = Math.min(state.currentCandle.low, ticker.lastPrice);
    state.currentCandle.close = ticker.lastPrice;
  }

  private state(symbol: string): SymbolState {
    const existing = this.states.get(symbol);
    if (existing) {
      return existing;
    }
    const state: SymbolState = { ticks: [], volumeDeltas: [], candles: [] };
    this.states.set(symbol, state);
    return state;
  }

  private expireAlerts(): void {
    const now = Date.now();
    for (const alert of this.alerts) {
      if (alert.status === "new" && alert.expiresAt <= now) {
        alert.status = "expired";
      }
    }
  }
}

function parseTicker(data: unknown): ScannerTicker | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const symbol = String(data.symbol ?? data.s ?? "");
  const lastPrice = numberValue(data.lastPrice ?? data.last ?? data.price ?? data.p ?? data.fairPrice);
  if (!symbol || lastPrice === undefined) {
    return undefined;
  }
  return {
    symbol,
    lastPrice,
    bid1: numberValue(data.bid1 ?? data.bid),
    ask1: numberValue(data.ask1 ?? data.ask),
    volume24: numberValue(data.volume24 ?? data.volume ?? data.v),
    amount24: numberValue(data.amount24 ?? data.amount ?? data.a),
    holdVol: numberValue(data.holdVol ?? data.openInterest),
    fairPrice: numberValue(data.fairPrice),
    indexPrice: numberValue(data.indexPrice),
    fundingRate: numberValue(data.fundingRate),
    riseFallRate: numberValue(data.riseFallRate),
    timestamp: numberValue(data.timestamp ?? data.ts) ?? Date.now()
  };
}

function parseDepthSide(raw: unknown): Array<{ price: number; volume: number }> {
  const levels = Array.isArray(raw) ? raw : [];
  return levels
    .map((level) => {
      if (Array.isArray(level)) {
        const price = numberValue(level[0]);
        const volume = numberValue(level[2] ?? level[1]);
        return price !== undefined && volume !== undefined ? { price, volume } : undefined;
      }
      if (isRecord(level)) {
        const price = numberValue(level.price ?? level.p);
        const volume = numberValue(level.volume ?? level.vol ?? level.v ?? level.quantity ?? level.q);
        return price !== undefined && volume !== undefined ? { price, volume } : undefined;
      }
      return undefined;
    })
    .filter((level): level is { price: number; volume: number } => level !== undefined);
}

function inferZeroFee(raw: unknown): boolean | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const explicit = raw.isZeroFeeSymbol ?? raw.isZeroFeeRate ?? raw.zeroFee;
  if (typeof explicit === "boolean") {
    return explicit;
  }
  const maker = numberValue(raw.makerFeeRate);
  const taker = numberValue(raw.takerFeeRate);
  return maker === 0 && taker === 0 ? true : undefined;
}

function profileParams(profile: ScannerProfileName): {
  maxSpread: number;
  minAmount24: number;
  minDepthTop10: number;
  sweepExcMin: number;
  sweepExcMax: number;
  wickRatio: number;
  sweepVolMult: number;
  absorptionVolMult: number;
  absorptionProgress: number;
  compressionWidth: number;
  breakBodyRatio: number;
  breakoutVolMult: number;
  bullishImbalance: number;
  bearishImbalance: number;
  stopBufferPct: number;
} {
  if (profile === "lowcap_event") {
    return {
      maxSpread: 0.0008,
      minAmount24: 3_000_000,
      minDepthTop10: 2_500,
      sweepExcMin: 0.002,
      sweepExcMax: 0.006,
      wickRatio: 0.5,
      sweepVolMult: 2.8,
      absorptionVolMult: 3.2,
      absorptionProgress: 0.0015,
      compressionWidth: 0.0035,
      breakBodyRatio: 0.65,
      breakoutVolMult: 2.4,
      bullishImbalance: 2.2,
      bearishImbalance: 0.45,
      stopBufferPct: 0.0008
    };
  }
  return {
    maxSpread: 0.0003,
    minAmount24: 25_000_000,
    minDepthTop10: 10_000,
    sweepExcMin: 0.0008,
    sweepExcMax: 0.0025,
    wickRatio: 0.45,
    sweepVolMult: 2.2,
    absorptionVolMult: 2.5,
    absorptionProgress: 0.0008,
    compressionWidth: 0.0018,
    breakBodyRatio: 0.6,
    breakoutVolMult: 1.8,
    bullishImbalance: 1.8,
    bearishImbalance: 0.56,
    stopBufferPct: 0.0004
  };
}

function classifyProfile(symbol: string, amount24: number): ScannerProfileName {
  if (DEFAULT_CONTEXT_SYMBOLS.includes(symbol) && amount24 >= 25_000_000) {
    return "liquid_major";
  }
  return "lowcap_event";
}

function depthNotional(depth: ScannerDepth, levels: number, contractSize: number): number {
  return [...depth.bids.slice(0, levels), ...depth.asks.slice(0, levels)].reduce(
    (sum, level) => sum + level.price * level.volume * contractSize,
    0
  );
}

function sumLevels(levels: Array<{ volume: number }>, count: number): number {
  return levels.slice(0, count).reduce((sum, level) => sum + level.volume, 0);
}

function rollingSum(values: Array<{ timestamp: number; value: number }>, windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  return values.filter((item) => item.timestamp >= cutoff).reduce((sum, item) => sum + item.value, 0);
}

function median(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (filtered.length === 0) {
    return 0;
  }
  return filtered[Math.floor(filtered.length / 2)];
}

function pctLike(value: number, target: number): number {
  return Math.max(0, Math.min(1, value / target));
}

function gradeFromScore(score: number): ScannerGrade {
  if (score >= 0.82) {
    return "A+";
  }
  if (score >= 0.62) {
    return "A";
  }
  return "B";
}

function gradeAllowed(actual: ScannerGrade, minimum: ScannerGrade): boolean {
  const rank: Record<ScannerGrade, number> = { B: 1, A: 2, "A+": 3 };
  return rank[actual] >= rank[minimum];
}

function setupBonus(setup: ScannerSetupName): number {
  if (setup === "SWEEP_RECLAIM") {
    return 0.12;
  }
  if (setup === "ABSORPTION_FAILURE") {
    return 0.08;
  }
  return 0.1;
}

function stopBuffer(price: number, profile: ReturnType<typeof profileParams>): number {
  return price * profile.stopBufferPct;
}

function closedCandles(state: SymbolState): ScannerCandle[] {
  return state.candles.filter((bar) => bar.closedAt <= Date.now());
}

function minPriceUnit(priceScale: number | undefined): number {
  return priceScale === undefined ? 0.00000001 : 1 / 10 ** priceScale;
}

function roundToUnit(value: number, unit: number): number {
  return Number((Math.round(value / unit) * unit).toFixed(12));
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function numberValue(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
