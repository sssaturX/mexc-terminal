import { HOLD_SIGNAL, Signal } from "../types";
import { Strategy } from "./base";

export class ManualConsoleStrategy implements Strategy {
  readonly name = "ManualConsoleStrategy";
  readonly description = "Manual-only strategy; global hotkeys handle L/S/C/Q.";
  readonly requiredTimeframe = "keyboard";
  readonly params = {};

  onTick(): Signal {
    return HOLD_SIGNAL;
  }

  onCandle(): Signal {
    return HOLD_SIGNAL;
  }
}
