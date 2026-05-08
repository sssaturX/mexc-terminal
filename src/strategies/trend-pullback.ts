import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { ema, isDirectionAllowed, percentChange } from "./indicators";
import { Strategy } from "./base";

export class TrendPullback implements Strategy<{ trendEmaPeriod: number; pullbackPercent: number }> {
  readonly name = "TrendPullback";
  readonly description = "Trades in EMA trend direction after a pullback to the trend line.";
  readonly requiredTimeframe = "1m candles";
  readonly params: { trendEmaPeriod: number; pullbackPercent: number };

  constructor(params?: Partial<{ trendEmaPeriod: number; pullbackPercent: number }>) {
    this.params = {
      trendEmaPeriod: Math.trunc(params?.trendEmaPeriod ?? 50),
      pullbackPercent: params?.pullbackPercent ?? 0.15
    };
  }

  onTick(context: StrategyContext): Signal {
    const closes = context.candles.map((candle) => candle.close).concat(context.currentTick.price);
    if (context.position || closes.length < this.params.trendEmaPeriod + 3) {
      return HOLD_SIGNAL;
    }
    const trend = ema(closes, this.params.trendEmaPeriod);
    const emaNow = trend.at(-1);
    const emaPrev = trend.at(-3);
    if (emaNow === undefined || emaPrev === undefined) {
      return HOLD_SIGNAL;
    }

    const price = context.currentTick.price;
    const distance = percentChange(emaNow, price);
    if (emaNow > emaPrev && distance <= this.params.pullbackPercent && price >= emaNow && isDirectionAllowed("long", context.config.directionMode)) {
      return { action: "BUY", reason: `Uptrend pullback to EMA ${this.params.trendEmaPeriod}` };
    }
    if (emaNow < emaPrev && distance >= -this.params.pullbackPercent && price <= emaNow && isDirectionAllowed("short", context.config.directionMode)) {
      return { action: "SELL", reason: `Downtrend pullback to EMA ${this.params.trendEmaPeriod}` };
    }
    return HOLD_SIGNAL;
  }

  onCandle(context: StrategyContext): Signal {
    return this.onTick(context);
  }
}
