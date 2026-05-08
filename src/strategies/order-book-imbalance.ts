import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { isDirectionAllowed } from "./indicators";
import { Strategy } from "./base";

export class OrderBookImbalanceScalper implements Strategy<{ depthLimit: number; imbalanceRatio: number }> {
  readonly name = "OrderBookImbalanceScalper";
  readonly description = "Uses contract depth and enters when one side is materially heavier.";
  readonly requiredTimeframe = "depth";
  readonly params: { depthLimit: number; imbalanceRatio: number };

  constructor(params?: Partial<{ depthLimit: number; imbalanceRatio: number }>) {
    this.params = {
      depthLimit: Math.trunc(params?.depthLimit ?? 10),
      imbalanceRatio: params?.imbalanceRatio ?? 1.8
    };
  }

  onTick(context: StrategyContext): Signal {
    if (context.position || !context.orderBook) {
      return HOLD_SIGNAL;
    }

    const bidVolume = context.orderBook.bids
      .slice(0, this.params.depthLimit)
      .reduce((sum, level) => sum + level.volume, 0);
    const askVolume = context.orderBook.asks
      .slice(0, this.params.depthLimit)
      .reduce((sum, level) => sum + level.volume, 0);
    if (bidVolume <= 0 || askVolume <= 0) {
      return HOLD_SIGNAL;
    }

    if (bidVolume / askVolume >= this.params.imbalanceRatio && isDirectionAllowed("long", context.config.directionMode)) {
      return { action: "BUY", reason: `Bid imbalance ${bidVolume.toFixed(2)} / ${askVolume.toFixed(2)}` };
    }
    if (askVolume / bidVolume >= this.params.imbalanceRatio && isDirectionAllowed("short", context.config.directionMode)) {
      return { action: "SELL", reason: `Ask imbalance ${askVolume.toFixed(2)} / ${bidVolume.toFixed(2)}` };
    }
    return HOLD_SIGNAL;
  }

  onCandle(): Signal {
    return HOLD_SIGNAL;
  }
}
