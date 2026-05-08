import { askConfig } from "./config";
import { Logger } from "./core/logger";
import { formatConfigCard } from "./core/format";
import { PositionManager } from "./core/position-manager";
import { RiskManager } from "./core/risk-manager";
import { TradingEngine } from "./core/trading-engine";
import { MexcClient } from "./mexc/client";
import { createStrategy } from "./strategies";

async function main(): Promise<void> {
  const config = await askConfig();
  const logger = new Logger({ minLevel: config.debug ? "DEBUG" : "INFO" });
  logger.info(formatConfigCard(config));
  const mexc = new MexcClient(config.authToken, config.dryRun, logger);
  const strategy = createStrategy(config.strategyName, config.strategyParams);
  const positions = new PositionManager(logger);
  const risk = new RiskManager(config, logger);
  const engine = new TradingEngine(config, mexc, strategy, positions, risk, logger);

  process.on("SIGINT", () => {
    void engine.stop("SHUTDOWN").finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void engine.stop("SHUTDOWN").finally(() => process.exit(0));
  });

  await engine.start();
}

main().catch((error) => {
  const logger = new Logger();
  logger.error(error instanceof Error ? error.message : String(error), error);
  process.exitCode = 1;
});
