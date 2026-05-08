import { MexcFuturesClient } from "mexc-futures-sdk";
import {
  ContractDetail,
  DepthLevel,
  OrderBook,
  PositionSide,
  SubmitOrderRequest,
  SubmitOrderResult
} from "../types";
import { Logger } from "../core/logger";

type UnknownRecord = Record<string, unknown>;

export class MexcClient {
  private readonly client: MexcFuturesClient;

  constructor(
    authToken: string,
    private readonly dryRun: boolean,
    private readonly logger: Logger
  ) {
    this.client = new MexcFuturesClient({ authToken });
  }

  async getTickerPrice(symbol: string): Promise<number> {
    try {
      const response = await this.client.getTicker(symbol);
      const data = unwrapData(response);
      const price = pickNumber(data, ["lastPrice", "last", "price", "fairPrice", "indexPrice"]);
      if (price === undefined) {
        throw new Error(`Ticker response does not contain a recognizable price for ${symbol}`);
      }
      return price;
    } catch (error) {
      this.logSdkError(error);
      throw error;
    }
  }

  async getOrderBook(symbol: string, limit = 20): Promise<OrderBook | undefined> {
    try {
      const response = await this.client.getContractDepth(symbol, limit);
      const data = unwrapData(response);
      const bids = parseDepthSide(readArray(data, "bids") ?? readArray(data, "bid"));
      const asks = parseDepthSide(readArray(data, "asks") ?? readArray(data, "ask"));
      if (bids.length === 0 || asks.length === 0) {
        return undefined;
      }
      return { bids, asks, timestamp: Date.now() };
    } catch (error) {
      this.logSdkError(error);
      return undefined;
    }
  }

  async getContractDetail(symbol: string): Promise<ContractDetail | undefined> {
    try {
      const response = await this.client.getContractDetail(symbol);
      const data = unwrapData(response);
      const detail = Array.isArray(data) ? data.find((item) => isRecord(item) && item.symbol === symbol) : data;
      if (!isRecord(detail)) {
        return undefined;
      }

      return {
        minVol: pickNumber(detail, ["minVol", "minVolume", "minOrderVol"]),
        maxVol: pickNumber(detail, ["maxVol", "maxVolume", "maxOrderVol"]),
        volUnit: pickNumber(detail, ["volUnit", "volumeStep", "stepSize"]),
        volumeScale: pickNumber(detail, ["volScale", "volumeScale", "quantityScale"]),
        priceScale: pickNumber(detail, ["priceScale"]),
        contractSize: pickNumber(detail, ["contractSize", "contractUnit"]),
        raw: detail
      };
    } catch (error) {
      this.logSdkError(error);
      return undefined;
    }
  }

  async calculateVolume(symbol: string, margin: number, leverage: number, price: number): Promise<number> {
    const rawVolume = (margin * leverage) / price;
    const detail = await this.getContractDetail(symbol);
    return roundVolume(rawVolume, detail);
  }

  async openMarketPosition(input: {
    symbol: string;
    side: PositionSide;
    price: number;
    volume: number;
    leverage: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
  }): Promise<SubmitOrderResult> {
    const stopLossPrice =
      input.stopLossPrice === undefined ? undefined : await this.normalizePrice(input.symbol, input.stopLossPrice);
    const takeProfitPrice =
      input.takeProfitPrice === undefined ? undefined : await this.normalizePrice(input.symbol, input.takeProfitPrice);
    const order: SubmitOrderRequest = {
      symbol: input.symbol,
      price: input.price,
      vol: input.volume,
      side: input.side === "LONG" ? 1 : 3,
      type: 5,
      openType: 1,
      leverage: input.leverage,
      ...(stopLossPrice === undefined ? {} : { stopLossPrice }),
      ...(takeProfitPrice === undefined ? {} : { takeProfitPrice })
    };
    return this.submitOrder(order, `DRY-OPEN-${Date.now()}`);
  }

  async hasOpenPosition(symbol: string): Promise<boolean | undefined> {
    if (this.dryRun) {
      return undefined;
    }

    try {
      const response = await this.client.getOpenPositions(symbol);
      const data = unwrapData(response);
      if (!Array.isArray(data)) {
        return undefined;
      }
      return data.some((position) => {
        if (!isRecord(position)) {
          return false;
        }
        const holdVol = pickNumber(position, ["holdVol", "vol", "volume"]);
        const state = pickNumber(position, ["state"]);
        return (holdVol ?? 0) > 0 && state !== 3;
      });
    } catch (error) {
      this.logSdkError(error);
      return undefined;
    }
  }

  async closeMarketPosition(input: {
    symbol: string;
    side: PositionSide;
    price: number;
    volume: number;
    leverage: number;
    positionId?: string;
  }): Promise<SubmitOrderResult> {
    const order: SubmitOrderRequest = {
      symbol: input.symbol,
      price: input.price,
      vol: input.volume,
      side: input.side === "LONG" ? 4 : 2,
      type: 5,
      openType: 1,
      leverage: input.leverage
    };

    const numericPositionId = input.positionId === undefined ? undefined : Number(input.positionId);
    const sdkOrder =
      numericPositionId !== undefined && Number.isFinite(numericPositionId)
        ? { ...order, positionId: numericPositionId }
        : order;
    return this.submitOrder(sdkOrder as SubmitOrderRequest, `DRY-CLOSE-${Date.now()}`);
  }

  private async submitOrder(order: SubmitOrderRequest, dryId: string): Promise<SubmitOrderResult> {
    if (this.dryRun) {
      this.logger.info(`DRY-RUN order skipped`, order);
      return { orderId: dryId, positionId: dryId, raw: { dryRun: true, order } };
    }

    try {
      const response = await this.client.submitOrder(order);
      const data = unwrapData(response);
      const numericOrderId = typeof data === "number" ? String(data) : undefined;
      return {
        orderId: numericOrderId ?? pickString(data, ["orderId", "id"]) ?? pickString(response, ["orderId", "id"]),
        positionId:
          pickString(data, ["positionId", "position_id"]) ?? pickString(response, ["positionId", "position_id"]),
        raw: response
      };
    } catch (error) {
      this.logSdkError(error);
      throw error;
    }
  }

  private logSdkError(error: unknown): void {
    this.logger.error(`SDK error: ${classifySdkError(error)}`, error);
  }

  private async normalizePrice(symbol: string, price: number): Promise<number> {
    const detail = await this.getContractDetail(symbol);
    if (detail?.priceScale !== undefined && detail.priceScale >= 0) {
      return Number(price.toFixed(detail.priceScale));
    }
    return Number(price.toFixed(8));
  }
}

export function classifySdkError(error: unknown): string {
  const name = isRecord(error) && typeof error.name === "string" ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  const normalized = `${name} ${message}`.toLowerCase();

  if (normalized.includes("auth") || normalized.includes("token") || normalized.includes("signature")) {
    return "expired or invalid WEB token";
  }
  if (normalized.includes("rate") || normalized.includes("429")) {
    return "rate limit";
  }
  if (normalized.includes("network") || normalized.includes("timeout") || normalized.includes("econn")) {
    return "network error";
  }
  if (normalized.includes("validation") || normalized.includes("invalid")) {
    return "validation error";
  }
  if (normalized.includes("reject")) {
    return "rejected order";
  }

  return `${name}: ${message}`;
}

function roundVolume(volume: number, detail?: ContractDetail): number {
  if (!Number.isFinite(volume) || volume <= 0) {
    throw new Error(`Calculated volume is invalid: ${volume}`);
  }

  let result = volume;
  if (detail?.volUnit && detail.volUnit > 0) {
    result = Math.floor(result / detail.volUnit) * detail.volUnit;
  }

  if (detail?.volumeScale !== undefined && detail.volumeScale >= 0) {
    const factor = 10 ** detail.volumeScale;
    result = Math.floor(result * factor) / factor;
  } else {
    result = Number(result.toFixed(6));
  }

  if (detail?.minVol !== undefined && result < detail.minVol) {
    result = detail.minVol;
  }
  if (detail?.maxVol !== undefined && result > detail.maxVol) {
    result = detail.maxVol;
  }

  return result;
}

function parseDepthSide(side: unknown[] | undefined): DepthLevel[] {
  if (!side) {
    return [];
  }

  return side
    .map((level): DepthLevel | undefined => {
      if (Array.isArray(level)) {
        const price = Number(level[0]);
        const volume = Number(level[1]);
        return Number.isFinite(price) && Number.isFinite(volume) ? { price, volume } : undefined;
      }
      if (isRecord(level)) {
        const price = pickNumber(level, ["price", "p"]);
        const volume = pickNumber(level, ["volume", "vol", "v", "quantity", "q"]);
        return price !== undefined && volume !== undefined ? { price, volume } : undefined;
      }
      return undefined;
    })
    .filter((level): level is DepthLevel => level !== undefined);
}

function unwrapData(value: unknown): unknown {
  if (isRecord(value) && "data" in value) {
    return value.data;
  }
  return value;
}

function readArray(record: unknown, key: string): unknown[] | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function pickNumber(record: unknown, keys: string[]): number | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(numberValue)) {
      return numberValue;
    }
  }
  return undefined;
}

function pickString(record: unknown, keys: string[]): string | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}
