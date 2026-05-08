import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { isDirectionAllowed, rsi } from "./indicators";
import { Strategy } from "./base";

export class RsiReversal implements Strategy<{ rsiPeriod: number; oversold: number; overbought: number }> {
  readonly name = "RsiReversal";
  readonly description = "Fades oversold and overbought RSI readings.";
  readonly requiredTimeframe = "1m candles";
  readonly params: { rsiPeriod: number; oversold: number; overbought: number };

  constructor(params?: Partial<{ rsiPeriod: number; oversold: number; overbought: number }>) {
    this.params = {
      rsiPeriod: Math.trunc(params?.rsiPeriod ?? 14),
      oversold: params?.oversold ?? 30,
      overbought: params?.overbought ?? 70
    };
  }

  onTick(context: StrategyContext): Signal {
    if (context.position) {
      return HOLD_SIGNAL;
    }

    const closes = context.candles.map((candle) => candle.close).concat(context.currentTick.price);
    const value = rsi(closes, this.params.rsiPeriod);
    if (value === undefined) {
      return HOLD_SIGNAL;
    }

    if (value <= this.params.oversold && isDirectionAllowed("long", context.config.directionMode)) {
      return { action: "BUY", reason: `RSI ${value.toFixed(2)} <= oversold ${this.params.oversold}` };
    }
    if (value >= this.params.overbought && isDirectionAllowed("short", context.config.directionMode)) {
      return { action: "SELL", reason: `RSI ${value.toFixed(2)} >= overbought ${this.params.overbought}` };
    }
    return HOLD_SIGNAL;
  }

  onCandle(context: StrategyContext): Signal {
    return this.onTick(context);
  }
}
