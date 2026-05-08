import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { isDirectionAllowed } from "./indicators";
import { Strategy } from "./base";

export class RandomCoinflipScalper implements Strategy<{ probability: number }> {
  readonly name = "RandomCoinflipScalper";
  readonly description = "Random long/short entries for dry-run and high-leverage micro scalp tests.";
  readonly requiredTimeframe = "tick";
  readonly params: { probability: number };

  constructor(params?: Partial<{ probability: number }>) {
    this.params = { probability: params?.probability ?? 0.03 };
  }

  onTick(context: StrategyContext): Signal {
    if (context.position || Math.random() > this.params.probability) {
      return HOLD_SIGNAL;
    }

    const wantsLong = Math.random() >= 0.5;
    if (wantsLong && isDirectionAllowed("long", context.config.directionMode)) {
      return { action: "BUY", reason: "Coinflip selected long" };
    }
    if (!wantsLong && isDirectionAllowed("short", context.config.directionMode)) {
      return { action: "SELL", reason: "Coinflip selected short" };
    }
    return HOLD_SIGNAL;
  }

  onCandle(): Signal {
    return HOLD_SIGNAL;
  }
}
