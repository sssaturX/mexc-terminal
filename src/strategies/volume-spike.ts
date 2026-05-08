import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { isDirectionAllowed, sma } from "./indicators";
import { Strategy } from "./base";

export class VolumeSpikeStrategy implements Strategy<{ volumeMultiplier: number; lookback: number }> {
  readonly name = "VolumeSpikeStrategy";
  readonly description = "Enters with the candle direction on abnormal volume.";
  readonly requiredTimeframe = "1m candles";
  readonly params: { volumeMultiplier: number; lookback: number };

  constructor(params?: Partial<{ volumeMultiplier: number; lookback: number }>) {
    this.params = {
      volumeMultiplier: params?.volumeMultiplier ?? 2,
      lookback: Math.trunc(params?.lookback ?? 20)
    };
  }

  onTick(context: StrategyContext): Signal {
    const current = context.candles.at(-1);
    if (context.position || !current || context.candles.length < this.params.lookback + 1) {
      return HOLD_SIGNAL;
    }

    const avgVolume = sma(context.candles.slice(-this.params.lookback - 1, -1).map((candle) => candle.volume));
    if (avgVolume === undefined || current.volume < avgVolume * this.params.volumeMultiplier) {
      return HOLD_SIGNAL;
    }

    if (current.close >= current.open && isDirectionAllowed("long", context.config.directionMode)) {
      return { action: "BUY", reason: `Bullish volume spike ${current.volume.toFixed(2)} vs avg ${avgVolume.toFixed(2)}` };
    }
    if (current.close < current.open && isDirectionAllowed("short", context.config.directionMode)) {
      return { action: "SELL", reason: `Bearish volume spike ${current.volume.toFixed(2)} vs avg ${avgVolume.toFixed(2)}` };
    }
    return HOLD_SIGNAL;
  }

  onCandle(context: StrategyContext): Signal {
    return this.onTick(context);
  }
}
