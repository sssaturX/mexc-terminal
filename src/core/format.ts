import { BotConfig, Position, RiskSnapshot, TradeResult } from "../types";

const RESET = "\x1b[0m";
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export const color = {
  bold: (text: string): string => wrap("1", text),
  dim: (text: string): string => wrap("2", text),
  red: (text: string): string => wrap("31", text),
  green: (text: string): string => wrap("32", text),
  yellow: (text: string): string => wrap("33", text),
  blue: (text: string): string => wrap("34", text),
  magenta: (text: string): string => wrap("35", text),
  cyan: (text: string): string => wrap("36", text),
  gray: (text: string): string => wrap("90", text)
};

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function money(value: number, digits = 4): string {
  const sign = value > 0 ? "+" : "";
  const text = `${sign}${value.toFixed(digits)} USDT`;
  if (value > 0) {
    return color.green(text);
  }
  if (value < 0) {
    return color.red(text);
  }
  return color.gray(text);
}

export function percent(value: number, digits = 2): string {
  const sign = value > 0 ? "+" : "";
  const text = `${sign}${value.toFixed(digits)}%`;
  if (value > 0) {
    return color.green(text);
  }
  if (value < 0) {
    return color.red(text);
  }
  return color.gray(text);
}

export function sideLabel(side: "LONG" | "SHORT"): string {
  return side === "LONG" ? color.green("LONG") : color.red("SHORT");
}

export function formatOpenCard(input: {
  side: "LONG" | "SHORT";
  symbol: string;
  margin: number;
  leverage: number;
  volume: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  reason: string;
  dryRun: boolean;
}): string {
  return card("POSITION OPENED", [
    ["Mode", input.dryRun ? color.yellow("DRY-RUN") : color.red(color.bold("LIVE"))],
    ["Side", sideLabel(input.side)],
    ["Symbol", color.cyan(input.symbol)],
    ["Entry", input.entryPrice.toString()],
    ["Volume", input.volume.toString()],
    ["Margin", `${input.margin} USDT`],
    ["Leverage", `${input.leverage}x`],
    ["Stop loss", color.red(input.stopLossPrice.toString())],
    ["Take profit", color.green(input.takeProfitPrice.toString())],
    ["Reason", input.reason]
  ]);
}

export function formatConfigCard(config: BotConfig): string {
  const notional = config.margin * config.leverage;
  const tpUsdt = (notional * config.takeProfitPercent) / 100;
  const slUsdt = (notional * config.stopLossPercent) / 100;
  const tpRoe = config.takeProfitPercent * config.leverage;
  const slRoe = config.stopLossPercent * config.leverage;
  const manualSlPricePercent = config.manualStopLossRoePercent / config.leverage;
  const manualSlUsdt = (notional * manualSlPricePercent) / 100;

  return card("BOT SETTINGS", [
    ["Mode", config.dryRun ? color.yellow("DRY-RUN") : color.red(color.bold("LIVE"))],
    ["Symbol", color.cyan(config.symbol)],
    ["Strategy", config.strategyName],
    ["Margin", `${config.margin} USDT`],
    ["Leverage", `${config.leverage}x`],
    ["Notional", `${notional.toFixed(4)} USDT`],
    ["Take profit", `${money(tpUsdt)} | ${percent(tpRoe)} ROE | ${config.takeProfitPercent.toFixed(4)}% price`],
    ["Stop loss", `${money(-slUsdt)} | ${percent(-slRoe)} ROE | ${config.stopLossPercent.toFixed(4)}% price`],
    [
      "Manual SL",
      `${money(-manualSlUsdt)} | ${percent(-config.manualStopLossRoePercent)} ROE | ${manualSlPricePercent.toFixed(
        6
      )}% price`
    ],
    ["Max trades", String(config.maxTradesPerSession)],
    ["Daily loss", `${config.maxDailyLoss} USDT`]
  ]);
}

export function formatCloseCard(trade: TradeResult): string {
  return card("POSITION CLOSED", [
    ["Side", sideLabel(trade.side)],
    ["Symbol", color.cyan(trade.symbol)],
    ["Entry", trade.entryPrice.toString()],
    ["Exit", trade.exitPrice.toString()],
    ["Volume", trade.volume.toString()],
    ["Reason", trade.reason],
    ["PnL", money(trade.pnl)],
    ["PnL on margin", percent(trade.pnlPercentOnMargin)]
  ]);
}

export function formatStatusLine(input: {
  symbol: string;
  price: number;
  strategy: string;
  dryRun: boolean;
  position?: Position;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  risk: RiskSnapshot;
}): string {
  const mode = input.dryRun ? color.yellow("DRY") : color.red(color.bold("LIVE"));
  const position = input.position
    ? `${sideLabel(input.position.side)} entry=${input.position.entryPrice} vol=${input.position.volume} SL=${color.red(
        input.position.stopLossPrice.toFixed(6)
      )} TP=${color.green(input.position.takeProfitPrice.toFixed(6))} uPnL=${money(
        input.unrealizedPnl
      )} (${percent(input.unrealizedPnlPercent)})`
    : color.gray("none");
  const wins = color.green(String(input.risk.wins));
  const losses = input.risk.losses > 0 ? color.red(String(input.risk.losses)) : color.gray("0");
  return [
    color.bold(`STATUS ${input.symbol}`),
    `price=${color.cyan(input.price.toString())}`,
    `strategy=${input.strategy}`,
    `position=${position}`,
    `trades=${input.risk.tradesOpened}`,
    `W/L=${wins}/${losses}`,
    `daily=${money(input.risk.dailyPnl)}`,
    mode
  ].join(" | ");
}

export function formatSignal(action: string, strategy: string, reason: string): string {
  const label =
    action === "BUY"
      ? color.green(action)
      : action === "SELL"
        ? color.red(action)
        : action === "CLOSE"
          ? color.yellow(action)
          : color.gray(action);
  return `Signal ${label} from ${color.cyan(strategy)}: ${reason}`;
}

export function formatPrice(symbol: string, price: number, previousPrice?: number): string {
  const direction =
    previousPrice === undefined
      ? color.gray("=")
      : price > previousPrice
        ? color.green("UP")
        : price < previousPrice
          ? color.red("DOWN")
          : color.gray("=");
  const priceText =
    previousPrice === undefined
      ? color.cyan(price.toString())
      : price > previousPrice
        ? color.green(price.toString())
        : price < previousPrice
          ? color.red(price.toString())
          : color.cyan(price.toString());
  return `Price ${color.cyan(symbol)}: ${priceText} ${direction}`;
}

function card(title: string, rows: Array<[string, string]>): string {
  const plainRows = rows.map(([label, value]) => [label, stripAnsi(value)] as const);
  const labelWidth = Math.max(...plainRows.map(([label]) => label.length), 1);
  const valueWidth = Math.max(...plainRows.map(([, value]) => value.length), title.length, 1);
  const width = labelWidth + valueWidth + 5;
  const border = `+${"-".repeat(width)}+`;
  const titleLine = `| ${color.bold(title)}${" ".repeat(Math.max(0, width - title.length - 1))}|`;
  const lines = rows.map(([label, value], index) => {
    const plainValueLength = plainRows[index][1].length;
    return `| ${label.padEnd(labelWidth)} : ${value}${" ".repeat(valueWidth - plainValueLength)} |`;
  });
  return [border, titleLine, border, ...lines, border].join("\n");
}

function wrap(code: string, text: string): string {
  return `${"\x1b["}${code}m${text}${RESET}`;
}
