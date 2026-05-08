import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { highestHigh, isDirectionAllowed, lowestLow } from "./indicators";
import { Strategy } from "./base";

export class RangePingPong implements Strategy<{ rangeLookback: number; entryZonePercent: number }> {
  readonly name = "RangePingPong";
  readonly description = "Buys the bottom of a recent range and sells the top.";
  readonly requiredTimeframe = "1m candles";
  readonly params: { rangeLookback: number; entryZonePercent: number };

  constructor(params?: Partial<{ rangeLookback: number; entryZonePercent: number }>) {
    this.params = {
      rangeLookback: Math.trunc(params?.rangeLookback ?? 30),
      entryZonePercent: params?.entryZonePercent ?? 15
    };
  }

  onTick(context: StrategyContext): Signal {
    if (context.position || context.candles.length < this.params.rangeLookback) {
      return HOLD_SIGNAL;
    }
    const range = context.candles.slice(-this.params.rangeLookback);
    const high = highestHigh(range);
    const low = lowestLow(range);
    if (high === undefined || low === undefined || high <= low) {
      return HOLD_SIGNAL;
    }

    const price = context.currentTick.price;
    const width = high - low;
    const lowerZone = low + width * (this.params.entryZonePercent / 100);
    const upperZone = high - width * (this.params.entryZonePercent / 100);
    if (price <= lowerZone && isDirectionAllowed("long", context.config.directionMode)) {
      return { action: "BUY", reason: `Price ${price} in lower range zone` };
    }
    if (price >= upperZone && isDirectionAllowed("short", context.config.directionMode)) {
      return { action: "SELL", reason: `Price ${price} in upper range zone` };
    }
    return HOLD_SIGNAL;
  }

  onCandle(context: StrategyContext): Signal {
    return this.onTick(context);
  }
}
