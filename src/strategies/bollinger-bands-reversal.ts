import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { isDirectionAllowed, sma, standardDeviation } from "./indicators";
import { Strategy } from "./base";

export class BollingerBandsReversal implements Strategy<{ period: number; deviation: number }> {
  readonly name = "BollingerBandsReversal";
  readonly description = "Fades touches of the outer Bollinger Bands.";
  readonly requiredTimeframe = "1m candles";
  readonly params: { period: number; deviation: number };

  constructor(params?: Partial<{ period: number; deviation: number }>) {
    this.params = {
      period: Math.trunc(params?.period ?? 20),
      deviation: params?.deviation ?? 2
    };
  }

  onTick(context: StrategyContext): Signal {
    if (context.position || context.candles.length < this.params.period) {
      return HOLD_SIGNAL;
    }
    const closes = context.candles.slice(-this.params.period).map((candle) => candle.close);
    const mean = sma(closes);
    const sd = standardDeviation(closes);
    if (mean === undefined || sd === undefined) {
      return HOLD_SIGNAL;
    }
    const lower = mean - sd * this.params.deviation;
    const upper = mean + sd * this.params.deviation;
    const price = context.currentTick.price;
    if (price <= lower && isDirectionAllowed("long", context.config.directionMode)) {
      return { action: "BUY", reason: `Price touched lower Bollinger Band ${lower.toFixed(4)}` };
    }
    if (price >= upper && isDirectionAllowed("short", context.config.directionMode)) {
      return { action: "SELL", reason: `Price touched upper Bollinger Band ${upper.toFixed(4)}` };
    }
    return HOLD_SIGNAL;
  }

  onCandle(context: StrategyContext): Signal {
    return this.onTick(context);
  }
}
