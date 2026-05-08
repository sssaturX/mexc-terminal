import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import prompts from "prompts";
import { BotConfig, DirectionMode } from "./types";
import { createStrategy, STRATEGY_FACTORIES } from "./strategies";

type SavedConfig = Omit<BotConfig, "strategyName" | "strategyParams"> & {
  strategyName?: string;
  strategyParams?: Record<string, number | string | boolean>;
  symbolHistory?: string[];
};
type TargetMode = "profitUsdt" | "roePercent" | "pricePercent";

const SETTINGS_PATH = path.join(process.cwd(), "config", "settings.json");
const MARGIN_PRESETS = [5, 10, 25, 50, 100];
const POPULAR_SYMBOLS = [
  "BTC_USDT",
  "ETH_USDT",
  "SOL_USDT",
  "TONCOIN_USDT",
  "XRP_USDT",
  "DOGE_USDT",
  "BNB_USDT",
  "LINK_USDT",
  "ADA_USDT",
  "AVAX_USDT",
  "SUI_USDT",
  "PEPE_USDT"
];

const DEFAULTS = {
  symbol: process.env.MEXC_SYMBOL ?? "BTC_USDT",
  margin: 10,
  leverage: 10,
  tickIntervalMs: 2000,
  maxTradesPerSession: 5,
  maxConsecutiveLosses: 3,
  maxDailyLoss: 20,
  cooldownSeconds: 30,
  takeProfitPercent: 0.2,
  stopLossPercent: 0.15,
  manualStopLossRoePercent: 1
};

export async function askConfig(): Promise<BotConfig> {
  const saved = readSavedConfig();
  const useSaved = saved
    ? await prompts({
        type: "confirm",
        name: "value",
        message: `Use saved settings from ${path.relative(process.cwd(), SETTINGS_PATH)}?`,
        initial: true
      })
    : { value: false };

  const tokenAnswer = await prompts(
    {
      type: "password",
      name: "authToken",
      message: "MEXC WEB auth token",
      initial: saved?.authToken ?? process.env.MEXC_WEB_AUTH_TOKEN ?? "",
      validate: (value: string) => value.trim().length > 0 || "WEB token is required"
    },
    {
      onCancel: () => {
        throw new Error("Configuration cancelled");
      }
    }
  );

  if (saved && useSaved.value) {
    const symbol = await askSymbol(saved);
    const selectedStrategy = await askStrategyConfig();
    const config: BotConfig = {
      ...saved,
      symbol,
      authToken: String(tokenAnswer.authToken).trim(),
      strategyName: selectedStrategy.strategyName,
      strategyParams: selectedStrategy.strategyParams
    };
    applyStrategyManagedExits(config);
    validateConfig(config);
    await confirmLiveMode(config);
    await maybeSaveConfig(config);
    return config;
  }

  const base = await prompts(
    [
      {
        type: "select",
        name: "symbolChoice",
        message: "Trading symbol",
        choices: buildSymbolChoices(saved),
        initial: 0
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.symbolChoice === "custom" ? "text" : null,
        name: "customSymbol",
        message: "Custom symbol",
        initial: saved?.symbol ?? DEFAULTS.symbol,
        validate: (value: string) => validateSymbol(value)
      },
      {
        type: "select",
        name: "marginPreset",
        message: "Margin per trade",
        choices: [
          ...MARGIN_PRESETS.map((value) => ({ title: `${value} USDT`, value })),
          { title: "Custom", value: "custom" }
        ],
        initial: marginPresetIndex(saved?.margin ?? DEFAULTS.margin)
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.marginPreset === "custom" ? "number" : null,
        name: "customMargin",
        message: "Custom margin in USDT",
        initial: saved?.margin ?? DEFAULTS.margin,
        min: 0.1
      },
      {
        type: "number",
        name: "leverage",
        message: "Leverage",
        initial: saved?.leverage ?? DEFAULTS.leverage,
        min: 1,
        max: 200
      },
      {
        type: "select",
        name: "directionMode",
        message: "Direction mode",
        choices: [
          { title: "long", value: "long" },
          { title: "short", value: "short" },
          { title: "both", value: "both" },
          { title: "auto", value: "auto" }
        ],
        initial: directionIndex(saved?.directionMode)
      },
      {
        type: "select",
        name: "strategyName",
        message: "Strategy",
        choices: STRATEGY_FACTORIES.map((factory) => ({
          title: `${factory.name} - ${factory.description}`,
          value: factory.name
        })),
        initial: 0
      },
      {
        type: "select",
        name: "takeProfitMode",
        message: "Take profit input mode",
        choices: [
          { title: "Profit in USDT", value: "profitUsdt" },
          { title: "ROE on margin %", value: "roePercent" },
          { title: "Price move %", value: "pricePercent" }
        ],
        initial: 0
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.takeProfitMode === "profitUsdt" ? "number" : null,
        name: "takeProfitUsdt",
        message: "Take profit target in USDT",
        initial: targetUsdt(saved?.takeProfitPercent ?? DEFAULTS.takeProfitPercent, saved?.margin ?? DEFAULTS.margin, saved?.leverage ?? DEFAULTS.leverage),
        min: 0.01
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.takeProfitMode === "roePercent" ? "number" : null,
        name: "takeProfitRoePercent",
        message: "Take profit ROE on margin %",
        initial: targetRoe(saved?.takeProfitPercent ?? DEFAULTS.takeProfitPercent, saved?.leverage ?? DEFAULTS.leverage),
        min: 0.01
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.takeProfitMode === "pricePercent" ? "number" : null,
        name: "takeProfitPricePercent",
        message: "Take profit price move %",
        initial: saved?.takeProfitPercent ?? DEFAULTS.takeProfitPercent,
        min: 0.01
      },
      {
        type: "select",
        name: "stopLossMode",
        message: "Stop loss input mode",
        choices: [
          { title: "Max loss in USDT", value: "profitUsdt" },
          { title: "Loss on margin %", value: "roePercent" },
          { title: "Price move %", value: "pricePercent" }
        ],
        initial: 0
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.stopLossMode === "profitUsdt" ? "number" : null,
        name: "stopLossUsdt",
        message: "Stop loss max loss in USDT",
        initial: targetUsdt(saved?.stopLossPercent ?? DEFAULTS.stopLossPercent, saved?.margin ?? DEFAULTS.margin, saved?.leverage ?? DEFAULTS.leverage),
        min: 0.01
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.stopLossMode === "roePercent" ? "number" : null,
        name: "stopLossRoePercent",
        message: "Stop loss on margin %",
        initial: targetRoe(saved?.stopLossPercent ?? DEFAULTS.stopLossPercent, saved?.leverage ?? DEFAULTS.leverage),
        min: 0.01
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.stopLossMode === "pricePercent" ? "number" : null,
        name: "stopLossPricePercent",
        message: "Stop loss price move %",
        initial: saved?.stopLossPercent ?? DEFAULTS.stopLossPercent,
        min: 0.01
      },
      {
        type: "number",
        name: "manualStopLossRoePercent",
        message: "Manual hotkey stop loss ROE % (L/S)",
        initial: saved?.manualStopLossRoePercent ?? DEFAULTS.manualStopLossRoePercent,
        min: 0.01
      },
      {
        type: "confirm",
        name: "trailingEnabled",
        message: "Enable trailing take profit?",
        initial: saved?.trailingTakeProfit.enabled ?? false
      },
      {
        type: (prev: boolean) => (prev ? "number" : null),
        name: "trailStartPercent",
        message: "Trailing activation profit %",
        initial: saved?.trailingTakeProfit.activationProfitPercent ?? 0.1,
        min: 0.01
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) => (values.trailingEnabled ? "number" : null),
        name: "trailDistancePercent",
        message: "Trailing distance %",
        initial: saved?.trailingTakeProfit.distancePercent ?? 0.05,
        min: 0.01
      },
      {
        type: "confirm",
        name: "chasingEnabled",
        message: "Enable chasing take profit?",
        initial: saved?.chasingTakeProfit.enabled ?? false
      },
      {
        type: (prev: boolean) => (prev ? "number" : null),
        name: "chaseActivationPercent",
        message: "Chasing activation profit %",
        initial: saved?.chasingTakeProfit.activationProfitPercent ?? 0.1,
        min: 0.01
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) => (values.chasingEnabled ? "number" : null),
        name: "chaseDistancePercent",
        message: "Chasing rollback distance %",
        initial: saved?.chasingTakeProfit.chaseDistancePercent ?? 0.05,
        min: 0.01
      },
      {
        type: "number",
        name: "maxTradesPerSession",
        message: "Max trades per session",
        initial: saved?.maxTradesPerSession ?? DEFAULTS.maxTradesPerSession,
        min: 1
      },
      {
        type: "number",
        name: "maxConsecutiveLosses",
        message: "Max consecutive losses",
        initial: saved?.maxConsecutiveLosses ?? DEFAULTS.maxConsecutiveLosses,
        min: 1
      },
      {
        type: "number",
        name: "maxDailyLoss",
        message: "Max daily loss in USDT",
        initial: saved?.maxDailyLoss ?? DEFAULTS.maxDailyLoss,
        min: 0.1
      },
      {
        type: "number",
        name: "cooldownSeconds",
        message: "Cooldown between trades, seconds",
        initial: saved ? saved.cooldownMs / 1000 : DEFAULTS.cooldownSeconds,
        min: 0
      },
      {
        type: "number",
        name: "tickIntervalMs",
        message: "REST ticker polling interval, ms",
        initial: saved?.tickIntervalMs ?? DEFAULTS.tickIntervalMs,
        min: 500
      },
      {
        type: "confirm",
        name: "dryRun",
        message: "Dry-run mode?",
        initial: saved?.dryRun ?? process.env.MEXC_DRY_RUN !== "false"
      },
      {
        type: "confirm",
        name: "debug",
        message: "Debug logs?",
        initial: saved?.debug ?? false
      }
    ],
    {
      onCancel: () => {
        throw new Error("Configuration cancelled");
      }
    }
  );

  const strategyParams = await askStrategyParams(String(base.strategyName));
  const isTrailingStrategy = String(base.strategyName) === "TrailingBreakout";
  const isChasingStrategy = String(base.strategyName) === "ChasingTakeProfitScalper";
  const margin = resolveMargin(base);
  const leverage = Number(base.leverage);
  const takeProfitPercent = resolveTargetPercent(base, "takeProfit", margin, leverage);
  const stopLossPercent = resolveTargetPercent(base, "stopLoss", margin, leverage);

  const config: BotConfig = {
    authToken: String(tokenAnswer.authToken).trim(),
    symbol: resolveSymbol(base),
    margin,
    leverage,
    directionMode: base.directionMode as DirectionMode,
    strategyName: String(base.strategyName),
    takeProfitPercent,
    stopLossPercent,
    manualStopLossRoePercent: Number(base.manualStopLossRoePercent),
    trailingTakeProfit: {
      enabled: Boolean(base.trailingEnabled) || isTrailingStrategy,
      activationProfitPercent: Number(
        base.trailStartPercent ?? strategyParams.trailStartPercent ?? strategyParams.activationProfitPercent ?? 0.1
      ),
      distancePercent: Number(base.trailDistancePercent ?? strategyParams.trailDistancePercent ?? 0.05)
    },
    chasingTakeProfit: {
      enabled: Boolean(base.chasingEnabled) || isChasingStrategy,
      activationProfitPercent: Number(base.chaseActivationPercent ?? strategyParams.activationProfitPercent ?? 0.1),
      chaseDistancePercent: Number(base.chaseDistancePercent ?? strategyParams.chaseDistancePercent ?? 0.05)
    },
    maxTradesPerSession: Number(base.maxTradesPerSession),
    maxConsecutiveLosses: Number(base.maxConsecutiveLosses),
    maxDailyLoss: Number(base.maxDailyLoss),
    cooldownMs: Number(base.cooldownSeconds) * 1000,
    dryRun: Boolean(base.dryRun),
    tickIntervalMs: Number(base.tickIntervalMs),
    debug: Boolean(base.debug),
    strategyParams
  };

  validateConfig(config);
  await confirmLiveMode(config);
  await maybeSaveConfig(config);
  return config;
}

function readSavedConfig(): SavedConfig | undefined {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return undefined;
  }

  const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Partial<SavedConfig>;
  return {
    authToken: parsed.authToken ?? process.env.MEXC_WEB_AUTH_TOKEN ?? "",
    symbol: parsed.symbol ?? DEFAULTS.symbol,
    margin: parsed.margin ?? DEFAULTS.margin,
    leverage: parsed.leverage ?? DEFAULTS.leverage,
    directionMode: parsed.directionMode ?? "both",
    strategyName: parsed.strategyName ?? STRATEGY_FACTORIES[0].name,
    takeProfitPercent: parsed.takeProfitPercent ?? DEFAULTS.takeProfitPercent,
    stopLossPercent: parsed.stopLossPercent ?? DEFAULTS.stopLossPercent,
    manualStopLossRoePercent: parsed.manualStopLossRoePercent ?? DEFAULTS.manualStopLossRoePercent,
    trailingTakeProfit: parsed.trailingTakeProfit ?? {
      enabled: false,
      activationProfitPercent: 0.1,
      distancePercent: 0.05
    },
    chasingTakeProfit: parsed.chasingTakeProfit ?? {
      enabled: false,
      activationProfitPercent: 0.1,
      chaseDistancePercent: 0.05
    },
    maxTradesPerSession: parsed.maxTradesPerSession ?? DEFAULTS.maxTradesPerSession,
    maxConsecutiveLosses: parsed.maxConsecutiveLosses ?? DEFAULTS.maxConsecutiveLosses,
    maxDailyLoss: parsed.maxDailyLoss ?? DEFAULTS.maxDailyLoss,
    cooldownMs: parsed.cooldownMs ?? DEFAULTS.cooldownSeconds * 1000,
    dryRun: parsed.dryRun ?? true,
    tickIntervalMs: parsed.tickIntervalMs ?? DEFAULTS.tickIntervalMs,
    debug: parsed.debug ?? false,
    symbolHistory: normalizeSymbolHistory(parsed.symbolHistory, parsed.symbol)
  };
}

async function maybeSaveConfig(config: BotConfig): Promise<void> {
  const answer = await prompts({
    type: "confirm",
    name: "save",
    message: `Save settings and WEB token to ${path.relative(process.cwd(), SETTINGS_PATH)}? Strategy will not be saved.`,
    initial: true
  });

  if (!answer.save) {
    return;
  }

  const { strategyName: _strategyName, strategyParams: _strategyParams, ...savedConfig } = config;
  const previous = readSavedConfig();
  const nextConfig = {
    ...savedConfig,
    symbolHistory: updateSymbolHistory(config.symbol, previous?.symbolHistory)
  };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

async function confirmLiveMode(config: BotConfig): Promise<void> {
  if (config.dryRun) {
    return;
  }

  const live = await prompts({
    type: "text",
    name: "confirmation",
    message: "Type YES LIVE to enable real orders"
  });
  if (live.confirmation !== "YES LIVE") {
    throw new Error("Live mode was not confirmed. Restart with dry-run or type YES LIVE exactly.");
  }
}

async function askStrategyConfig(): Promise<{
  strategyName: string;
  strategyParams: Record<string, number | string | boolean>;
}> {
  const answer = await prompts(
    {
      type: "select",
      name: "strategyName",
      message: "Strategy",
      choices: STRATEGY_FACTORIES.map((factory) => ({
        title: `${factory.name} - ${factory.description}`,
        value: factory.name
      })),
      initial: 0
    },
    {
      onCancel: () => {
        throw new Error("Configuration cancelled");
      }
    }
  );

  const strategyName = String(answer.strategyName);
  return {
    strategyName,
    strategyParams: await askStrategyParams(strategyName)
  };
}

async function askSymbol(saved?: SavedConfig): Promise<string> {
  const answer = await prompts(
    [
      {
        type: "select",
        name: "symbolChoice",
        message: "Trading symbol",
        choices: buildSymbolChoices(saved),
        initial: 0
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.symbolChoice === "custom" ? "text" : null,
        name: "customSymbol",
        message: "Custom symbol",
        initial: saved?.symbol ?? DEFAULTS.symbol,
        validate: (value: string) => validateSymbol(value)
      }
    ],
    {
      onCancel: () => {
        throw new Error("Configuration cancelled");
      }
    }
  );

  return resolveSymbol(answer);
}

function applyStrategyManagedExits(config: BotConfig): void {
  if (config.strategyName === "TrailingBreakout") {
    config.trailingTakeProfit.enabled = true;
  }
  if (config.strategyName === "ChasingTakeProfitScalper") {
    config.chasingTakeProfit.enabled = true;
  }
}

function validateConfig(config: BotConfig): void {
  if (!Number.isFinite(config.margin) || config.margin <= 0) {
    throw new Error("Margin must be positive");
  }
  if (!Number.isFinite(config.leverage) || config.leverage < 1) {
    throw new Error("Leverage must be >= 1");
  }
  if (config.takeProfitPercent <= 0 || config.stopLossPercent <= 0) {
    throw new Error("TP and SL must be positive percentages");
  }
  if (config.manualStopLossRoePercent <= 0) {
    throw new Error("Manual SL ROE must be positive");
  }
  createStrategy(config.strategyName, config.strategyParams);
}

function resolveMargin(values: Record<string, unknown>): number {
  if (values.marginPreset === "custom") {
    return Number(values.customMargin);
  }
  return Number(values.marginPreset);
}

function resolveSymbol(values: Record<string, unknown>): string {
  const raw = values.symbolChoice === "custom" ? values.customSymbol : values.symbolChoice;
  return String(raw).trim().toUpperCase();
}

function buildSymbolChoices(saved?: SavedConfig): Array<{ title: string; value: string }> {
  const history = normalizeSymbolHistory(saved?.symbolHistory, saved?.symbol);
  const recentChoices = history.map((symbol) => ({ title: `Recent: ${symbol}`, value: symbol }));
  const popularChoices = POPULAR_SYMBOLS.filter((symbol) => !history.includes(symbol)).map((symbol) => ({
    title: `Popular: ${symbol}`,
    value: symbol
  }));

  return [...recentChoices, ...popularChoices, { title: "Custom...", value: "custom" }];
}

function validateSymbol(value: string): true | string {
  return /^[A-Z0-9]+_[A-Z0-9]+$/.test(value.trim().toUpperCase()) || "Use format BTC_USDT";
}

function normalizeSymbolHistory(history?: string[], current?: string): string[] {
  const symbols = [current, ...(history ?? []), DEFAULTS.symbol, ...POPULAR_SYMBOLS]
    .filter((value): value is string => typeof value === "string")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9]+_[A-Z0-9]+$/.test(symbol));

  return Array.from(new Set(symbols)).slice(0, 8);
}

function updateSymbolHistory(symbol: string, history?: string[]): string[] {
  return Array.from(new Set([symbol.trim().toUpperCase(), ...(history ?? [])])).slice(0, 8);
}

function resolveTargetPercent(
  values: Record<string, unknown>,
  prefix: "takeProfit" | "stopLoss",
  margin: number,
  leverage: number
): number {
  const mode = values[`${prefix}Mode`] as TargetMode;
  if (mode === "profitUsdt") {
    const usdt = Number(values[`${prefix}Usdt`]);
    return (usdt / (margin * leverage)) * 100;
  }
  if (mode === "roePercent") {
    return Number(values[`${prefix}RoePercent`]) / leverage;
  }
  return Number(values[`${prefix}PricePercent`]);
}

function targetUsdt(pricePercent: number, margin: number, leverage: number): number {
  return Number(((margin * leverage * pricePercent) / 100).toFixed(4));
}

function targetRoe(pricePercent: number, leverage: number): number {
  return Number((pricePercent * leverage).toFixed(4));
}

function marginPresetIndex(margin: number): number {
  const index = MARGIN_PRESETS.indexOf(margin);
  return index >= 0 ? index : MARGIN_PRESETS.length;
}

async function askStrategyParams(
  strategyName: string,
  saved?: Record<string, number | string | boolean>
): Promise<Record<string, number | string | boolean>> {
  switch (strategyName) {
    case "RandomCoinflipScalper":
      return prompts([
        { type: "number", name: "probability", message: "Trade probability per tick", initial: numberParam(saved, "probability", 0.03), min: 0, max: 1 }
      ]);
    case "MicroImpulseScalper":
      return prompts([
        { type: "number", name: "impulsePercent", message: "Impulse percent", initial: numberParam(saved, "impulsePercent", 0.08), min: 0.001 },
        { type: "number", name: "windowMs", message: "Impulse window ms", initial: numberParam(saved, "windowMs", 10000), min: 500 },
        {
          type: "select",
          name: "direction",
          message: "Impulse direction",
          choices: [
            { title: "both", value: "both" },
            { title: "long", value: "long" },
            { title: "short", value: "short" }
          ],
          initial: directionParamIndex(saved, "direction")
        }
      ]);
    case "BreakoutStrategy":
      return prompts([
        { type: "number", name: "lookbackCandles", message: "Lookback candles", initial: numberParam(saved, "lookbackCandles", 20), min: 2 },
        { type: "number", name: "breakoutPercent", message: "Breakout percent", initial: numberParam(saved, "breakoutPercent", 0.03), min: 0 }
      ]);
    case "TrailingBreakout":
      return prompts([
        { type: "number", name: "lookbackCandles", message: "Lookback candles", initial: numberParam(saved, "lookbackCandles", 20), min: 2 },
        { type: "number", name: "breakoutPercent", message: "Breakout percent", initial: numberParam(saved, "breakoutPercent", 0.03), min: 0 },
        { type: "number", name: "trailStartPercent", message: "Trail activation profit %", initial: numberParam(saved, "trailStartPercent", 0.1), min: 0.01 },
        { type: "number", name: "trailDistancePercent", message: "Trail distance %", initial: numberParam(saved, "trailDistancePercent", 0.05), min: 0.01 }
      ]);
    case "FakeBreakoutFade":
      return prompts([
        { type: "number", name: "lookbackCandles", message: "Lookback candles", initial: numberParam(saved, "lookbackCandles", 20), min: 2 },
        {
          type: "number",
          name: "returnInsideRangePercent",
          message: "Return inside range %",
          initial: numberParam(saved, "returnInsideRangePercent", 0.02),
          min: 0
        }
      ]);
    case "RangePingPong":
      return prompts([
        { type: "number", name: "rangeLookback", message: "Range lookback candles", initial: numberParam(saved, "rangeLookback", 30), min: 2 },
        { type: "number", name: "entryZonePercent", message: "Entry zone % of range", initial: numberParam(saved, "entryZonePercent", 15), min: 1, max: 49 }
      ]);
    case "MovingAverageCrossover":
      return prompts([
        { type: "number", name: "fastPeriod", message: "Fast EMA period", initial: numberParam(saved, "fastPeriod", 9), min: 2 },
        { type: "number", name: "slowPeriod", message: "Slow EMA period", initial: numberParam(saved, "slowPeriod", 21), min: 3 }
      ]);
    case "RsiReversal":
      return prompts([
        { type: "number", name: "rsiPeriod", message: "RSI period", initial: numberParam(saved, "rsiPeriod", 14), min: 2 },
        { type: "number", name: "oversold", message: "Oversold", initial: numberParam(saved, "oversold", 30), min: 1, max: 99 },
        { type: "number", name: "overbought", message: "Overbought", initial: numberParam(saved, "overbought", 70), min: 1, max: 99 }
      ]);
    case "BollingerBandsReversal":
      return prompts([
        { type: "number", name: "period", message: "BB period", initial: numberParam(saved, "period", 20), min: 2 },
        { type: "number", name: "deviation", message: "BB deviation", initial: numberParam(saved, "deviation", 2), min: 0.1 }
      ]);
    case "VolumeSpikeStrategy":
      return prompts([
        { type: "number", name: "volumeMultiplier", message: "Volume multiplier", initial: numberParam(saved, "volumeMultiplier", 2), min: 1 },
        { type: "number", name: "lookback", message: "Volume lookback candles", initial: numberParam(saved, "lookback", 20), min: 2 }
      ]);
    case "LiquiditySweepStrategy":
      return prompts([
        { type: "number", name: "lookback", message: "Sweep lookback candles", initial: numberParam(saved, "lookback", 20), min: 2 },
        { type: "number", name: "sweepPercent", message: "Sweep percent", initial: numberParam(saved, "sweepPercent", 0.02), min: 0 },
        { type: "number", name: "confirmationTicks", message: "Confirmation ticks", initial: numberParam(saved, "confirmationTicks", 2), min: 1 }
      ]);
    case "OrderBookImbalanceScalper":
      return prompts([
        { type: "number", name: "depthLimit", message: "Depth levels", initial: numberParam(saved, "depthLimit", 10), min: 1 },
        { type: "number", name: "imbalanceRatio", message: "Imbalance ratio", initial: numberParam(saved, "imbalanceRatio", 1.8), min: 1.01 }
      ]);
    case "TrendPullback":
      return prompts([
        { type: "number", name: "trendEmaPeriod", message: "Trend EMA period", initial: numberParam(saved, "trendEmaPeriod", 50), min: 2 },
        { type: "number", name: "pullbackPercent", message: "Pullback percent", initial: numberParam(saved, "pullbackPercent", 0.15), min: 0.01 }
      ]);
    case "ChasingTakeProfitScalper":
      return prompts([
        { type: "number", name: "activationProfitPercent", message: "Chasing activation profit %", initial: numberParam(saved, "activationProfitPercent", 0.1), min: 0.01 },
        { type: "number", name: "chaseDistancePercent", message: "Chasing rollback distance %", initial: numberParam(saved, "chaseDistancePercent", 0.05), min: 0.01 },
        { type: "number", name: "impulsePercent", message: "Entry impulse percent", initial: numberParam(saved, "impulsePercent", 0.04), min: 0.001 }
      ]);
    default:
      return {};
  }
}

function directionIndex(value?: DirectionMode): number {
  return ["long", "short", "both", "auto"].indexOf(value ?? "both");
}

function strategyIndex(value?: string): number {
  return Math.max(
    0,
    STRATEGY_FACTORIES.findIndex((factory) => factory.name === value)
  );
}

function numberParam(
  params: Record<string, number | string | boolean> | undefined,
  key: string,
  fallback: number
): number {
  const value = params?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function directionParamIndex(
  params: Record<string, number | string | boolean> | undefined,
  key: string
): number {
  const value = params?.[key];
  return ["both", "long", "short"].indexOf(typeof value === "string" ? value : "both");
}
