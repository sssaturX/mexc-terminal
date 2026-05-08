import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { highestHigh, isDirectionAllowed, lowestLow } from "./indicators";
import { Strategy } from "./base";

export class BreakoutStrategy implements Strategy<{ lookbackCandles: number; breakoutPercent: number }> {
  readonly name: string = "BreakoutStrategy";
  readonly description: string = "Enters when price breaks the recent candle high or low.";
  readonly requiredTimeframe: string = "1m candles";
  readonly params: { lookbackCandles: number; breakoutPercent: number };

  constructor(params?: Partial<{ lookbackCandles: number; breakoutPercent: number }>) {
    this.params = {
      lookbackCandles: Math.trunc(params?.lookbackCandles ?? 20),
      breakoutPercent: params?.breakoutPercent ?? 0.03
    };
  }

  onTick(context: StrategyContext): Signal {
    if (context.position || context.candles.length < this.params.lookbackCandles) {
      return HOLD_SIGNAL;
    }

    const range = context.candles.slice(-this.params.lookbackCandles);
    const high = highestHigh(range);
    const low = lowestLow(range);
    const price = context.currentTick.price;
    if (high === undefined || low === undefined) {
      return HOLD_SIGNAL;
    }

    if (price > high * (1 + this.params.breakoutPercent / 100) && isDirectionAllowed("long", context.config.directionMode)) {
      return { action: "BUY", reason: `Breakout above ${high}` };
    }
    if (price < low * (1 - this.params.breakoutPercent / 100) && isDirectionAllowed("short", context.config.directionMode)) {
      return { action: "SELL", reason: `Breakout below ${low}` };
    }
    return HOLD_SIGNAL;
  }

  onCandle(context: StrategyContext): Signal {
    return this.onTick(context);
  }
}
