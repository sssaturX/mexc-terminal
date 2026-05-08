import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { ema, isDirectionAllowed } from "./indicators";
import { Strategy } from "./base";

export class MovingAverageCrossover implements Strategy<{ fastPeriod: number; slowPeriod: number }> {
  readonly name = "MovingAverageCrossover";
  readonly description = "Trades EMA fast/slow crossovers.";
  readonly requiredTimeframe = "1m candles";
  readonly params: { fastPeriod: number; slowPeriod: number };
  private lastRelation: "above" | "below" | undefined;

  constructor(params?: Partial<{ fastPeriod: number; slowPeriod: number }>) {
    this.params = {
      fastPeriod: Math.trunc(params?.fastPeriod ?? 9),
      slowPeriod: Math.trunc(params?.slowPeriod ?? 21)
    };
  }

  onTick(context: StrategyContext): Signal {
    const closes = context.candles.map((candle) => candle.close).concat(context.currentTick.price);
    if (context.position || closes.length < this.params.slowPeriod + 2) {
      return HOLD_SIGNAL;
    }

    const fast = ema(closes, this.params.fastPeriod);
    const slow = ema(closes, this.params.slowPeriod);
    const fastNow = fast.at(-1);
    const slowNow = slow.at(-1);
    if (fastNow === undefined || slowNow === undefined) {
      return HOLD_SIGNAL;
    }

    const relation = fastNow >= slowNow ? "above" : "below";
    const previous = this.lastRelation;
    this.lastRelation = relation;

    if (previous === "below" && relation === "above" && isDirectionAllowed("long", context.config.directionMode)) {
      return { action: "BUY", reason: `EMA ${this.params.fastPeriod} crossed above EMA ${this.params.slowPeriod}` };
    }
    if (previous === "above" && relation === "below" && isDirectionAllowed("short", context.config.directionMode)) {
      return { action: "SELL", reason: `EMA ${this.params.fastPeriod} crossed below EMA ${this.params.slowPeriod}` };
    }
    return HOLD_SIGNAL;
  }

  onCandle(context: StrategyContext): Signal {
    return this.onTick(context);
  }
}
