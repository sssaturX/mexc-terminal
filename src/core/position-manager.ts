import {
  BotConfig,
  ExitReason,
  Position,
  PositionSide,
  TradeResult
} from "../types";
import { Logger } from "./logger";

export interface PositionExit {
  reason: ExitReason;
  price: number;
  trade: TradeResult;
}

export class PositionManager {
  private position?: Position;

  constructor(private readonly logger?: Logger) {}

  get activePosition(): Position | undefined {
    return this.position;
  }

  open(input: {
    config: BotConfig;
    side: PositionSide;
    entryPrice: number;
    volume: number;
    positionId?: string;
  }): Position {
    const { config, side, entryPrice } = input;
    const { stopLossPrice, takeProfitPrice } = calculateProtectionPrices({
      side,
      entryPrice,
      takeProfitPercent: config.takeProfitPercent,
      stopLossPercent: config.stopLossPercent
    });

    this.position = {
      symbol: config.symbol,
      side,
      entryPrice,
      volume: input.volume,
      margin: config.margin,
      leverage: config.leverage,
      positionId: input.positionId,
      stopLossPrice,
      takeProfitPrice,
      openedAt: Date.now(),
      maxFavorablePrice: entryPrice,
      minFavorablePrice: entryPrice,
      trailingActive: false,
      chasingActive: false
    };

    return this.position;
  }

  evaluate(price: number, config: BotConfig): PositionExit | undefined {
    if (!this.position) {
      return undefined;
    }

    const position = this.position;
    this.updateFavorablePrice(position, price);

    if (config.dryRun) {
      const stopLossHit =
        position.side === "LONG" ? price <= position.stopLossPrice : price >= position.stopLossPrice;
      if (stopLossHit) {
        return this.createExit(price, "STOP_LOSS");
      }
    }

    const trailingExit = this.evaluateTrailing(price, config, position);
    if (trailingExit) {
      return trailingExit;
    }

    const chasingExit = this.evaluateChasing(price, config, position);
    if (chasingExit) {
      return chasingExit;
    }

    if (config.dryRun && !config.trailingTakeProfit.enabled && !config.chasingTakeProfit.enabled) {
      const takeProfitHit =
        position.side === "LONG" ? price >= position.takeProfitPrice : price <= position.takeProfitPrice;
      if (takeProfitHit) {
        return this.createExit(price, "TAKE_PROFIT");
      }
    }

    return undefined;
  }

  close(price: number, reason: ExitReason): PositionExit | undefined {
    if (!this.position) {
      return undefined;
    }

    const position = this.position;
    const trade = buildTradeResult(position, price, reason);
    this.position = undefined;
    return { reason, price, trade };
  }

  createExit(price: number, reason: ExitReason): PositionExit | undefined {
    if (!this.position) {
      return undefined;
    }
    const trade = buildTradeResult(this.position, price, reason);
    return { reason, price, trade };
  }

  unrealizedPnl(price: number): number {
    if (!this.position) {
      return 0;
    }
    return calculatePnl(this.position, price);
  }

  private updateFavorablePrice(position: Position, price: number): void {
    if (position.side === "LONG") {
      position.maxFavorablePrice = Math.max(position.maxFavorablePrice, price);
    } else {
      position.minFavorablePrice = Math.min(position.minFavorablePrice, price);
    }
  }

  private evaluateTrailing(price: number, config: BotConfig, position: Position): PositionExit | undefined {
    if (!config.trailingTakeProfit.enabled) {
      return undefined;
    }

    const profitPercent = favorableProfitPercent(position, price);
    if (!position.trailingActive && profitPercent >= config.trailingTakeProfit.activationProfitPercent) {
      position.trailingActive = true;
      this.logger?.info("Trailing TP activated");
    }

    if (!position.trailingActive) {
      return undefined;
    }

    const stop =
      position.side === "LONG"
        ? position.maxFavorablePrice * (1 - config.trailingTakeProfit.distancePercent / 100)
        : position.minFavorablePrice * (1 + config.trailingTakeProfit.distancePercent / 100);
    const hit = position.side === "LONG" ? price <= stop : price >= stop;
    return hit ? this.createExit(price, "TRAILING_TAKE_PROFIT") : undefined;
  }

  private evaluateChasing(price: number, config: BotConfig, position: Position): PositionExit | undefined {
    if (!config.chasingTakeProfit.enabled) {
      return undefined;
    }

    const profitPercent = favorableProfitPercent(position, price);
    if (!position.chasingActive && profitPercent >= config.chasingTakeProfit.activationProfitPercent) {
      position.chasingActive = true;
      this.logger?.info("Chasing TP activated");
    }

    if (!position.chasingActive) {
      return undefined;
    }

    const stop =
      position.side === "LONG"
        ? position.maxFavorablePrice * (1 - config.chasingTakeProfit.chaseDistancePercent / 100)
        : position.minFavorablePrice * (1 + config.chasingTakeProfit.chaseDistancePercent / 100);
    const hit = position.side === "LONG" ? price <= stop : price >= stop;
    return hit ? this.createExit(price, "CHASING_TAKE_PROFIT") : undefined;
  }
}

export function calculateProtectionPrices(input: {
  side: PositionSide;
  entryPrice: number;
  takeProfitPercent: number;
  stopLossPercent: number;
}): { stopLossPrice: number; takeProfitPrice: number } {
  const stopLossPrice =
    input.side === "LONG"
      ? input.entryPrice * (1 - input.stopLossPercent / 100)
      : input.entryPrice * (1 + input.stopLossPercent / 100);
  const takeProfitPrice =
    input.side === "LONG"
      ? input.entryPrice * (1 + input.takeProfitPercent / 100)
      : input.entryPrice * (1 - input.takeProfitPercent / 100);

  return { stopLossPrice, takeProfitPrice };
}

export function calculatePnl(position: Position, price: number): number {
  return position.side === "LONG"
    ? (price - position.entryPrice) * position.volume
    : (position.entryPrice - price) * position.volume;
}

function favorableProfitPercent(position: Position, price: number): number {
  const pnl = calculatePnl(position, price);
  const notional = position.entryPrice * position.volume;
  return notional === 0 ? 0 : (pnl / notional) * 100;
}

function buildTradeResult(position: Position, exitPrice: number, reason: ExitReason): TradeResult {
  const pnl = calculatePnl(position, exitPrice);
  return {
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    volume: position.volume,
    margin: position.margin,
    leverage: position.leverage,
    pnl,
    pnlPercentOnMargin: position.margin === 0 ? 0 : (pnl / position.margin) * 100,
    reason,
    openedAt: position.openedAt,
    closedAt: Date.now()
  };
}
