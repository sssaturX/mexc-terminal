import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { highestHigh, isDirectionAllowed, lowestLow } from "./indicators";
import { Strategy } from "./base";

export class FakeBreakoutFade implements Strategy<{ lookbackCandles: number; returnInsideRangePercent: number }> {
  readonly name = "FakeBreakoutFade";
  readonly description = "Fades a failed breakout after price returns inside the range.";
  readonly requiredTimeframe = "1m candles";
  readonly params: { lookbackCandles: number; returnInsideRangePercent: number };
  private pending: "above" | "below" | undefined;

  constructor(params?: Partial<{ lookbackCandles: number; returnInsideRangePercent: number }>) {
    this.params = {
      lookbackCandles: Math.trunc(params?.lookbackCandles ?? 20),
      returnInsideRangePercent: params?.returnInsideRangePercent ?? 0.02
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

    if (price > high) {
      this.pending = "above";
      return HOLD_SIGNAL;
    }
    if (price < low) {
      this.pending = "below";
      return HOLD_SIGNAL;
    }

    if (
      this.pending === "above" &&
      price < high * (1 - this.params.returnInsideRangePercent / 100) &&
      isDirectionAllowed("short", context.config.directionMode)
    ) {
      this.pending = undefined;
      return { action: "SELL", reason: `Failed breakout returned below ${high}` };
    }
    if (
      this.pending === "below" &&
      price > low * (1 + this.params.returnInsideRangePercent / 100) &&
      isDirectionAllowed("long", context.config.directionMode)
    ) {
      this.pending = undefined;
      return { action: "BUY", reason: `Failed breakdown returned above ${low}` };
    }
    return HOLD_SIGNAL;
  }

  onCandle(context: StrategyContext): Signal {
    return this.onTick(context);
  }
}
