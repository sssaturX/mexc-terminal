import { HOLD_SIGNAL, Signal, StrategyContext } from "../types";
import { isDirectionAllowed, percentChange } from "./indicators";
import { Strategy } from "./base";

export class MicroImpulseScalper
  implements Strategy<{ impulsePercent: number; windowMs: number; direction: "long" | "short" | "both" }>
{
  readonly name = "MicroImpulseScalper";
  readonly description = "Enters after a sharp price move inside a short rolling window.";
  readonly requiredTimeframe = "tick";
  readonly params: { impulsePercent: number; windowMs: number; direction: "long" | "short" | "both" };

  constructor(params?: Partial<{ impulsePercent: number; windowMs: number; direction: "long" | "short" | "both" }>) {
    this.params = {
      impulsePercent: params?.impulsePercent ?? 0.08,
      windowMs: params?.windowMs ?? 10000,
      direction: params?.direction ?? "both"
    };
  }

  onTick(context: StrategyContext): Signal {
    if (context.position) {
      return HOLD_SIGNAL;
    }

    const fromTime = context.currentTick.timestamp - this.params.windowMs;
    const baseTick = context.ticks.find((tick) => tick.timestamp >= fromTime);
    if (!baseTick) {
      return HOLD_SIGNAL;
    }

    const change = percentChange(baseTick.price, context.currentTick.price);
    if (
      change >= this.params.impulsePercent &&
      this.params.direction !== "short" &&
      isDirectionAllowed("long", context.config.directionMode)
    ) {
      return { action: "BUY", reason: `Impulse up ${change.toFixed(3)}% in ${this.params.windowMs}ms` };
    }

    if (
      change <= -this.params.impulsePercent &&
      this.params.direction !== "long" &&
      isDirectionAllowed("short", context.config.directionMode)
    ) {
      return { action: "SELL", reason: `Impulse down ${change.toFixed(3)}% in ${this.params.windowMs}ms` };
    }

    return HOLD_SIGNAL;
  }

  onCandle(): Signal {
    return HOLD_SIGNAL;
  }
}
