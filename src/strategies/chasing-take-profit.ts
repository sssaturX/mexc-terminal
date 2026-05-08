import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { isDirectionAllowed, percentChange } from "./indicators";
import { Strategy } from "./base";

export class ChasingTakeProfitScalper
  implements Strategy<{ activationProfitPercent: number; chaseDistancePercent: number; impulsePercent: number }>
{
  readonly name = "ChasingTakeProfitScalper";
  readonly description = "Momentum scalp intended to be managed by virtual chasing take profit.";
  readonly requiredTimeframe = "tick";
  readonly params: { activationProfitPercent: number; chaseDistancePercent: number; impulsePercent: number };

  constructor(params?: Partial<{ activationProfitPercent: number; chaseDistancePercent: number; impulsePercent: number }>) {
    this.params = {
      activationProfitPercent: params?.activationProfitPercent ?? 0.1,
      chaseDistancePercent: params?.chaseDistancePercent ?? 0.05,
      impulsePercent: params?.impulsePercent ?? 0.04
    };
  }

  onTick(context: StrategyContext): Signal {
    if (context.position || context.ticks.length < 4) {
      return HOLD_SIGNAL;
    }

    const previous = context.ticks[Math.max(0, context.ticks.length - 4)];
    const change = percentChange(previous.price, context.currentTick.price);
    if (change >= this.params.impulsePercent && isDirectionAllowed("long", context.config.directionMode)) {
      return { action: "BUY", reason: `Chasing TP momentum up ${change.toFixed(3)}%` };
    }
    if (change <= -this.params.impulsePercent && isDirectionAllowed("short", context.config.directionMode)) {
      return { action: "SELL", reason: `Chasing TP momentum down ${change.toFixed(3)}%` };
    }
    return HOLD_SIGNAL;
  }

  onCandle(): Signal {
    return HOLD_SIGNAL;
  }
}
