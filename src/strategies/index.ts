import { Strategy } from "./base";
import { RandomCoinflipScalper } from "./random-coinflip";
import { MicroImpulseScalper } from "./micro-impulse";
import { BreakoutStrategy } from "./breakout";
import { FakeBreakoutFade } from "./fake-breakout-fade";
import { RangePingPong } from "./range-ping-pong";
import { MovingAverageCrossover } from "./moving-average-crossover";
import { RsiReversal } from "./rsi-reversal";
import { BollingerBandsReversal } from "./bollinger-bands-reversal";
import { VolumeSpikeStrategy } from "./volume-spike";
import { LiquiditySweepStrategy } from "./liquidity-sweep";
import { OrderBookImbalanceScalper } from "./order-book-imbalance";
import { TrendPullback } from "./trend-pullback";
import { TrailingBreakout } from "./trailing-breakout";
import { ChasingTakeProfitScalper } from "./chasing-take-profit";
import { ManualConsoleStrategy } from "./manual-console";

export interface StrategyFactory {
  name: string;
  description: string;
  create(params?: Record<string, number | string | boolean>): Strategy;
}

export const STRATEGY_FACTORIES: StrategyFactory[] = [
  factory(RandomCoinflipScalper),
  factory(MicroImpulseScalper),
  factory(BreakoutStrategy),
  factory(FakeBreakoutFade),
  factory(RangePingPong),
  factory(MovingAverageCrossover),
  factory(RsiReversal),
  factory(BollingerBandsReversal),
  factory(VolumeSpikeStrategy),
  factory(LiquiditySweepStrategy),
  factory(OrderBookImbalanceScalper),
  factory(TrendPullback),
  factory(TrailingBreakout),
  factory(ChasingTakeProfitScalper),
  factory(ManualConsoleStrategy)
];

export function createStrategy(name: string, params?: Record<string, number | string | boolean>): Strategy {
  const selected = STRATEGY_FACTORIES.find((item) => item.name === name);
  if (!selected) {
    throw new Error(`Unknown strategy: ${name}`);
  }
  return selected.create(params);
}

function factory<T extends Strategy>(
  StrategyClass: new (params?: Record<string, number | string | boolean>) => T
): StrategyFactory {
  const instance = new StrategyClass();
  return {
    name: instance.name,
    description: instance.description,
    create: (params) => new StrategyClass(params)
  };
}
