import { BotConfig, Candle, ExitReason, OrderBook, Position, PositionSide, RiskSnapshot, Signal, Tick } from "../types";
import { MexcClient } from "../mexc/client";
import { Strategy } from "../strategies/base";
import { Logger } from "./logger";
import { calculateProtectionPrices, PositionManager, PositionExit } from "./position-manager";
import { RiskManager } from "./risk-manager";
import { formatCloseCard, formatOpenCard, formatPrice, formatSignal, formatStatusLine } from "./format";
import { ManualControls } from "./manual-controls";

const MAX_TICKS = 2000;
const MAX_CANDLES = 500;
const CANDLE_MS = 60_000;

interface TradingEngineOptions {
  enableKeyboardControls?: boolean;
  onTradeAction?: (action: "BUY" | "SELL" | "CLOSE", reason: string) => void;
}

export class TradingEngine {
  private readonly ticks: Tick[] = [];
  private readonly candles: Candle[] = [];
  private currentCandle?: Candle;
  private running = false;
  private previousPrice?: number;
  private readonly manualControls: ManualControls;

  constructor(
    private readonly config: BotConfig,
    private readonly mexc: MexcClient,
    private readonly strategy: Strategy,
    private readonly positions: PositionManager,
    private readonly risk: RiskManager,
    private readonly logger: Logger,
    private readonly options: TradingEngineOptions = {}
  ) {
    this.manualControls = new ManualControls(this.logger, () => {
      void this.stop("SHUTDOWN").finally(() => process.exit(0));
    });
  }

  async start(): Promise<void> {
    this.running = true;
    if (this.options.enableKeyboardControls ?? true) {
      this.manualControls.start();
    }
    this.logger.info(
      `Bot started symbol=${this.config.symbol} strategy=${this.strategy.name} mode=${this.config.dryRun ? "DRY-RUN" : "LIVE"}`
    );

    while (this.running) {
      const started = Date.now();
      try {
        await this.iteration();
      } catch (error) {
        this.logger.error("Trading loop error; will retry after cooldown", error);
      }

      const elapsed = Date.now() - started;
      await sleep(Math.max(0, this.config.tickIntervalMs - elapsed));
    }
  }

  async stop(reason: ExitReason = "SHUTDOWN"): Promise<void> {
    if (!this.running && !this.positions.activePosition) {
      return;
    }
    this.running = false;
    this.risk.requestEmergencyClose();
    this.logger.warn(`Graceful shutdown requested: ${reason}`);

    const position = this.positions.activePosition;
    if (position) {
      const price = this.ticks.at(-1)?.price ?? position.entryPrice;
      await this.closePosition(position, price, reason);
    }

    const disposable = this.strategy as Strategy & { dispose?: () => void };
    disposable.dispose?.();
    this.manualControls.dispose();
  }

  queueManual(action: "BUY" | "SELL" | "CLOSE", reason = "Manual web control"): void {
    this.manualControls.queue(action, reason);
  }

  getSnapshot(price?: number): {
    running: boolean;
    symbol: string;
    strategy: string;
    dryRun: boolean;
    price?: number;
    position?: Position;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
    risk: RiskSnapshot;
  } {
    const currentPrice = price ?? this.previousPrice;
    const position = this.positions.activePosition;
    const unrealizedPnl = currentPrice === undefined ? 0 : this.positions.unrealizedPnl(currentPrice);
    return {
      running: this.running,
      symbol: this.config.symbol,
      strategy: this.strategy.name,
      dryRun: this.config.dryRun,
      price: currentPrice,
      position,
      unrealizedPnl,
      unrealizedPnlPercent: position ? (unrealizedPnl / position.margin) * 100 : 0,
      risk: this.risk.snapshot
    };
  }

  private async iteration(): Promise<void> {
    const price = await this.mexc.getTickerPrice(this.config.symbol);
    const tick: Tick = {
      symbol: this.config.symbol,
      price,
      timestamp: Date.now()
    };

    this.ticks.push(tick);
    if (this.ticks.length > MAX_TICKS) {
      this.ticks.shift();
    }
    this.updateCandles(tick);

    this.logger.info(formatPrice(this.config.symbol, price, this.previousPrice));
    this.previousPrice = price;

    await this.syncLivePosition(price);

    const position = this.positions.activePosition;
    const exit = this.positions.evaluate(price, this.config);
    if (exit && position) {
      await this.closePosition(position, price, exit.reason);
      this.renderStatus(price);
      return;
    }

    const manualSignal = this.manualControls.consume(this.config.directionMode);
    if (manualSignal) {
      const source = manualSignal.reason.startsWith("Master ") ? "MirrorControls" : "ManualControls";
      await this.handleSignal(manualSignal, price, source);
      this.renderStatus(price);
      return;
    }

    const orderBook = await this.maybeLoadOrderBook();
    const signal = await this.strategy.onTick({
      config: this.config,
      ticks: this.ticks,
      candles: this.currentCandle ? [...this.candles, this.currentCandle] : this.candles,
      currentTick: tick,
      position: this.positions.activePosition,
      orderBook
    });

    await this.handleSignal(signal, price, this.strategy.name);
    this.renderStatus(price);
  }

  private async handleSignal(signal: Signal, price: number, source: string): Promise<void> {
    if (signal.action === "HOLD") {
      this.logger.debug(`Signal HOLD from ${source}: ${signal.reason}`);
      return;
    }

    this.logger.info(formatSignal(signal.action, source, signal.reason));

    if (signal.action === "CLOSE") {
      const position = this.positions.activePosition;
      if (!position) {
        this.logger.warn("CLOSE signal ignored: no active position");
        return;
      }
      await this.closePosition(position, price, source === "ManualControls" ? "MANUAL_CLOSE" : "STRATEGY_CLOSE");
      return;
    }

    const side: PositionSide = signal.action === "BUY" ? "LONG" : "SHORT";
    const isManual = source === "ManualControls";
    const openConfig = isManual ? this.manualOpenConfig() : this.config;
    const decision = this.risk.canOpen(this.positions.activePosition, side, price, openConfig.stopLossPercent, {
      manualOverride: isManual
    });
    if (!decision.allowed) {
      this.logger.warn(`Open blocked by risk manager: ${decision.reason}`);
      return;
    }
    if (isManual) {
      this.logger.warn("Manual risk override: session loss/trade/cooldown limits bypassed");
    }

    const volume = await this.mexc.calculateVolume(this.config.symbol, this.config.margin, this.config.leverage, price);
    const protection = calculateProtectionPrices({
      side,
      entryPrice: price,
      takeProfitPercent: openConfig.takeProfitPercent,
      stopLossPercent: openConfig.stopLossPercent
    });
    this.logger.info(
      `Opening ${side} ${this.config.symbol} margin=${this.config.margin} leverage=${this.config.leverage} volume=${volume}`
    );
    this.logger.info(`Entry reason: ${signal.reason}`);
    this.logger.info(
      `Exchange protection order params SL=${protection.stopLossPrice} TP=${protection.takeProfitPrice}`
    );

    const order = await this.mexc.openMarketPosition({
      symbol: this.config.symbol,
      side,
      price,
      volume,
      leverage: this.config.leverage,
      stopLossPrice: protection.stopLossPrice,
      takeProfitPrice: protection.takeProfitPrice
    });

    if (!order.positionId && !this.config.dryRun) {
      this.logger.warn("Order opened but SDK response did not include positionId; close will use side+volume fallback");
    }

    const position = this.positions.open({
      config: openConfig,
      side,
      entryPrice: price,
      volume,
      positionId: order.positionId
    });
    this.risk.registerOpen();
    this.logger.info(
      formatOpenCard({
        side,
        symbol: this.config.symbol,
        margin: this.config.margin,
        leverage: this.config.leverage,
        volume,
        entryPrice: price,
        stopLossPrice: position.stopLossPrice,
        takeProfitPrice: position.takeProfitPrice,
        reason: signal.reason,
        dryRun: this.config.dryRun
      })
    );
    this.options.onTradeAction?.(signal.action, signal.reason);
  }

  private manualOpenConfig(): BotConfig {
    const manualStopLossPercent = this.config.manualStopLossRoePercent / this.config.leverage;
    this.logger.info(
      `Manual SL override: ${this.config.manualStopLossRoePercent}% ROE = ${manualStopLossPercent.toFixed(
        6
      )}% price move at ${this.config.leverage}x`
    );
    return {
      ...this.config,
      stopLossPercent: manualStopLossPercent
    };
  }

  private async syncLivePosition(price: number): Promise<void> {
    const position = this.positions.activePosition;
    if (!position || this.config.dryRun) {
      return;
    }

    const hasOpenPosition = await this.mexc.hasOpenPosition(position.symbol);
    if (hasOpenPosition === false) {
      this.logger.warn("Exchange position is no longer open; syncing local state as exchange-side SL/TP close");
      const exitPrice = this.estimateExchangeExitPrice(position, price);
      const exit = this.positions.close(exitPrice, "EXCHANGE_SYNC_CLOSE");
      if (exit) {
        this.risk.registerClose(exit.trade);
        this.logger.info(formatCloseCard(exit.trade));
      }
    }
  }

  private estimateExchangeExitPrice(position: Position, price: number): number {
    if (position.side === "LONG") {
      if (price <= position.stopLossPrice) {
        return position.stopLossPrice;
      }
      if (price >= position.takeProfitPrice) {
        return position.takeProfitPrice;
      }
    } else {
      if (price >= position.stopLossPrice) {
        return position.stopLossPrice;
      }
      if (price <= position.takeProfitPrice) {
        return position.takeProfitPrice;
      }
    }

    return price;
  }

  private async closePosition(position: Position, price: number, reason: ExitReason): Promise<PositionExit | undefined> {
    const projected = this.positions.createExit(price, reason);
    this.logger.info(`Closing ${position.side} reason=${reason} price=${price}`);
    this.logger.info(`Exit reason: ${reason}`);

    await this.mexc.closeMarketPosition({
      symbol: position.symbol,
      side: position.side,
      price,
      volume: position.volume,
      leverage: position.leverage,
      positionId: position.positionId
    });

    const exit = this.positions.close(price, reason) ?? projected;
    if (exit) {
      this.risk.registerClose(exit.trade);
      const pnl = exit.trade.pnl >= 0 ? `+${exit.trade.pnl.toFixed(4)}` : exit.trade.pnl.toFixed(4);
      this.logger.info(`Closing ${position.side} reason=${reason} price=${price} pnl=${pnl} USDT`);
      this.logger.info(formatCloseCard(exit.trade));
      this.options.onTradeAction?.("CLOSE", reason);
    }
    return exit;
  }

  private async maybeLoadOrderBook(): Promise<OrderBook | undefined> {
    if (this.strategy.name !== "OrderBookImbalanceScalper") {
      return undefined;
    }
    return this.mexc.getOrderBook(this.config.symbol, Number(this.config.strategyParams.depthLimit ?? 20));
  }

  private updateCandles(tick: Tick): void {
    const bucket = Math.floor(tick.timestamp / CANDLE_MS) * CANDLE_MS;
    if (!this.currentCandle || this.currentCandle.openedAt !== bucket) {
      if (this.currentCandle) {
        this.candles.push(this.currentCandle);
        if (this.candles.length > MAX_CANDLES) {
          this.candles.shift();
        }
      }
      this.currentCandle = {
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.volume ?? 0,
        openedAt: bucket,
        closedAt: bucket + CANDLE_MS
      };
      return;
    }

    this.currentCandle.high = Math.max(this.currentCandle.high, tick.price);
    this.currentCandle.low = Math.min(this.currentCandle.low, tick.price);
    this.currentCandle.close = tick.price;
    this.currentCandle.volume += tick.volume ?? 1;
  }

  private renderStatus(price: number): void {
    const position = this.positions.activePosition;
    const risk = this.risk.snapshot;
    const pnl = this.positions.unrealizedPnl(price);
    this.logger.info(
      formatStatusLine({
        symbol: this.config.symbol,
        price,
        strategy: this.strategy.name,
        dryRun: this.config.dryRun,
        position,
        unrealizedPnl: pnl,
        unrealizedPnlPercent: position ? (pnl / position.margin) * 100 : 0,
        risk
      })
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
