import { BotConfig } from "../src/types";

export function testConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    authToken: "test-token",
    symbol: "BTC_USDT",
    margin: 10,
    leverage: 10,
    directionMode: "both",
    strategyName: "RandomCoinflipScalper",
    takeProfitPercent: 1,
    stopLossPercent: 0.5,
    manualStopLossRoePercent: 1,
    trailingTakeProfit: {
      enabled: false,
      activationProfitPercent: 0,
      distancePercent: 0
    },
    chasingTakeProfit: {
      enabled: false,
      activationProfitPercent: 0,
      chaseDistancePercent: 0
    },
    maxTradesPerSession: 2,
    maxConsecutiveLosses: 2,
    maxDailyLoss: 10,
    cooldownMs: 0,
    dryRun: true,
    tickIntervalMs: 1000,
    debug: false,
    strategyParams: {},
    ...overrides
  };
}
