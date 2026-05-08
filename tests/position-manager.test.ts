import { describe, expect, it } from "vitest";
import { PositionManager } from "../src/core/position-manager";
import { testConfig } from "./helpers";

describe("PositionManager", () => {
  it("creates long SL/TP and emits take-profit exit", () => {
    const manager = new PositionManager();
    const config = testConfig({ takeProfitPercent: 1, stopLossPercent: 0.5 });
    const position = manager.open({
      config,
      side: "LONG",
      entryPrice: 100,
      volume: 1
    });

    expect(position.stopLossPrice).toBe(99.5);
    expect(position.takeProfitPrice).toBe(101);

    const exit = manager.evaluate(101, config);
    expect(exit?.reason).toBe("TAKE_PROFIT");
    expect(exit?.trade.pnl).toBe(1);
  });

  it("handles short stop-loss", () => {
    const manager = new PositionManager();
    const config = testConfig({ stopLossPercent: 1 });
    manager.open({
      config,
      side: "SHORT",
      entryPrice: 100,
      volume: 2
    });

    const exit = manager.evaluate(101, config);
    expect(exit?.reason).toBe("STOP_LOSS");
    expect(exit?.trade.pnl).toBe(-2);
  });

  it("activates trailing take-profit and exits on rollback", () => {
    const manager = new PositionManager();
    const config = testConfig({
      takeProfitPercent: 5,
      trailingTakeProfit: {
        enabled: true,
        activationProfitPercent: 1,
        distancePercent: 0.5
      }
    });
    manager.open({
      config,
      side: "LONG",
      entryPrice: 100,
      volume: 1
    });

    expect(manager.evaluate(101.2, config)).toBeUndefined();
    const exit = manager.evaluate(100.6, config);
    expect(exit?.reason).toBe("TRAILING_TAKE_PROFIT");
  });
});
