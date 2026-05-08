import { BotConfig, Position, PositionSide, RiskDecision, RiskSnapshot, TradeResult } from "../types";
import { Logger } from "./logger";

export class RiskManager {
  private readonly snapshotState: RiskSnapshot = {
    tradesOpened: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    dailyPnl: 0,
    emergencyCloseRequested: false
  };
  private warnedHighLeverage = false;

  constructor(
    private readonly config: BotConfig,
    private readonly logger?: Logger
  ) {}

  get snapshot(): RiskSnapshot {
    return { ...this.snapshotState };
  }

  requestEmergencyClose(): void {
    this.snapshotState.emergencyCloseRequested = true;
  }

  canOpen(
    position: Position | undefined,
    side: PositionSide,
    entryPrice: number,
    stopLossPercent = this.config.stopLossPercent,
    options?: { manualOverride?: boolean }
  ): RiskDecision {
    if (position) {
      return { allowed: false, reason: "Active position already exists" };
    }
    if (this.snapshotState.emergencyCloseRequested) {
      return { allowed: false, reason: "Emergency close requested" };
    }

    if (this.config.leverage >= 50 && !this.warnedHighLeverage) {
      this.warnedHighLeverage = true;
      this.logger?.warn(`High leverage warning: ${this.config.leverage}x can liquidate very quickly`);
    }

    this.logger?.warn("Risk manager is disabled: trade/session/loss/cooldown/liquidation checks bypassed");
    return { allowed: true, reason: "Risk manager disabled" };
  }

  registerOpen(): void {
    this.snapshotState.tradesOpened += 1;
  }

  registerClose(trade: TradeResult): void {
    this.snapshotState.dailyPnl += trade.pnl;
    this.snapshotState.lastClosedAt = trade.closedAt;

    if (trade.pnl >= 0) {
      this.snapshotState.wins += 1;
      this.snapshotState.consecutiveLosses = 0;
    } else {
      this.snapshotState.losses += 1;
      this.snapshotState.consecutiveLosses += 1;
    }
  }

  private checkStopLossVsLiquidation(
    side: PositionSide,
    entryPrice: number,
    stopLossPercent: number
  ): RiskDecision {
    const leverageDistancePercent = 100 / this.config.leverage;
    const stopDistancePercent = stopLossPercent;
    const bufferPercent = 0.1;

    if (stopDistancePercent >= leverageDistancePercent - bufferPercent) {
      const roughLiquidation =
        side === "LONG"
          ? entryPrice * (1 - 1 / this.config.leverage)
          : entryPrice * (1 + 1 / this.config.leverage);
      return {
        allowed: false,
        reason: `Stop loss is too close to rough liquidation price ${roughLiquidation.toFixed(8)}`
      };
    }

    return { allowed: true, reason: "Stop loss distance accepted" };
  }
}
