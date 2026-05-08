import { Candle } from "../types";

export function ema(values: number[], period: number): number[] {
  if (period <= 0 || values.length === 0) {
    return [];
  }
  const multiplier = 2 / (period + 1);
  const result: number[] = [];
  let previous = values[0];
  result.push(previous);
  for (let i = 1; i < values.length; i += 1) {
    const current = values[i] * multiplier + previous * (1 - multiplier);
    result.push(current);
    previous = current;
  }
  return result;
}

export function rsi(values: number[], period: number): number | undefined {
  if (values.length <= period) {
    return undefined;
  }

  let gains = 0;
  let losses = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function sma(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function standardDeviation(values: number[]): number | undefined {
  const mean = sma(values);
  if (mean === undefined) {
    return undefined;
  }
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function highestHigh(candles: Candle[]): number | undefined {
  if (candles.length === 0) {
    return undefined;
  }
  return Math.max(...candles.map((candle) => candle.high));
}

export function lowestLow(candles: Candle[]): number | undefined {
  if (candles.length === 0) {
    return undefined;
  }
  return Math.min(...candles.map((candle) => candle.low));
}

export function percentChange(from: number, to: number): number {
  if (from === 0) {
    return 0;
  }
  return ((to - from) / from) * 100;
}

export function isDirectionAllowed(direction: "long" | "short", mode: string): boolean {
  if (mode === "auto" || mode === "both") {
    return true;
  }
  return mode === direction;
}
