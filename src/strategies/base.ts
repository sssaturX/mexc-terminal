import { Signal, StrategyContext } from "../types";

export interface Strategy<TParams extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly requiredTimeframe: string;
  readonly params: TParams;
  onTick(context: StrategyContext): Signal | Promise<Signal>;
  onCandle(context: StrategyContext): Signal | Promise<Signal>;
}
