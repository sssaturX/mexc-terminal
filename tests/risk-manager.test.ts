import { describe, expect, it } from "vitest";
import { RiskManager } from "../src/core/risk-manager";
import { Position } from "../src/types";
import { testConfig } from "./helpers";

describe("RiskManager", () => {
  it("blocks opening when an active position exists", () => {
    const config = testConfig();
    const risk = new RiskManager(config);
    const position: Position = {
      symbol: "BTC_USDT",
      side: "LONG",
      entryPrice: 100,
      volume: 1,
      margin: 10,
      leverage: 10,
      stopLossPrice: 99,
      takeProfitPrice: 101,
      openedAt: Date.now(),
      maxFavorablePrice: 100,
      minFavorablePrice: 100,
      trailingActive: false,
      chasingActive: false
    };

    expect(risk.canOpen(position, "LONG", 100).allowed).toBe(false);
  });

  it("allows opening after max trades per session while risk manager is disabled", () => {
    const risk = new RiskManager(testConfig({ maxTradesPerSession: 1 }));
    risk.registerOpen();

    const decision = risk.canOpen(undefined, "LONG", 100);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("disabled");
  });

  it("allows close-to-liquidation stops while risk manager is disabled", () => {
    const risk = new RiskManager(testConfig({ leverage: 100, stopLossPercent: 1 }));
    const decision = risk.canOpen(undefined, "LONG", 100);

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("disabled");
  });
});
