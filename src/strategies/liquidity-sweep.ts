import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { highestHigh, isDirectionAllowed, lowestLow } from "./indicators";
import { Strategy } from "./base";

export class LiquiditySweepStrategy
  implements Strategy<{ lookback: number; sweepPercent: number; confirmationTicks: number }>
{
  readonly name = "LiquiditySweepStrategy";
  readonly description = "Detects local high/low sweeps followed by confirmation back inside the range.";
  readonly requiredTimeframe = "tick + 1m candles";
  readonly params: { lookback: number; sweepPercent: number; confirmationTicks: number };
  private pending: { side: "LONG" | "SHORT"; level: number; ticks: number } | undefined;

  constructor(params?: Partial<{ lookback: number; sweepPercent: number; confirmationTicks: number }>) {
    this.params = {
      lookback: Math.trunc(params?.lookback ?? 20),
      sweepPercent: params?.sweepPercent ?? 0.02,
      confirmationTicks: Math.trunc(params?.confirmationTicks ?? 2)
    };
  }

  onTick(context: StrategyContext): Signal {
    if (context.position || context.candles.length < this.params.lookback) {
      return HOLD_SIGNAL;
    }
    const range = context.candles.slice(-this.params.lookback);
    const high = highestHigh(range);
    const low = lowestLow(range);
    const price = context.currentTick.price;
    if (high === undefined || low === undefined) {
      return HOLD_SIGNAL;
    }

    if (price > high * (1 + this.params.sweepPercent / 100)) {
      this.pending = { side: "SHORT", level: high, ticks: 0 };
      return HOLD_SIGNAL;
    }
    if (price < low * (1 - this.params.sweepPercent / 100)) {
      this.pending = { side: "LONG", level: low, ticks: 0 };
      return HOLD_SIGNAL;
    }

    if (!this.pending) {
      return HOLD_SIGNAL;
    }

    const returnedInside =
      (this.pending.side === "SHORT" && price < this.pending.level) ||
      (this.pending.side === "LONG" && price > this.pending.level);
    if (!returnedInside) {
      return HOLD_SIGNAL;
    }

    this.pending.ticks += 1;
    if (this.pending.ticks < this.params.confirmationTicks) {
      return HOLD_SIGNAL;
    }

    const side = this.pending.side;
    this.pending = undefined;
    if (side === "LONG" && isDirectionAllowed("long", context.config.directionMode)) {
      return { action: "BUY", reason: "Liquidity sweep below range confirmed" };
    }
    if (side === "SHORT" && isDirectionAllowed("short", context.config.directionMode)) {
      return { action: "SELL", reason: "Liquidity sweep above range confirmed" };
    }
    return HOLD_SIGNAL;
  }

  onCandle(context: StrategyContext): Signal {
    return this.onTick(context);
  }
}
