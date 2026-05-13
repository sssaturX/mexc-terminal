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

export interface MexcAccountAsset {
  currency: string;
  availableBalance: number;
  cashBalance: number;
  equity: number;
  frozenBalance: number;
  positionMargin: number;
  unrealized: number;
}

export interface MexcOpenPosition {
  positionId?: string;
  symbol: string;
  side: PositionSide;
  openType?: number;
  state?: number;
  holdVol: number;
  frozenVol?: number;
  holdAvgPrice?: number;
  openAvgPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  liquidatePrice?: number;
  margin?: number;
  contractSize?: number;
  leverage: number;
  unrealized?: number;
  raw: unknown;
}

export class MexcApiResponseError extends Error {
  constructor(
    message: string,
    readonly mexcCode?: number
  ) {
    super(message);
    this.name = "MexcApiResponseError";
  }
}

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

  async getTickerSnapshot(symbol: string): Promise<{
    symbol: string;
    lastPrice: number;
    bid1?: number;
    ask1?: number;
    volume24?: number;
    amount24?: number;
    holdVol?: number;
    fairPrice?: number;
    indexPrice?: number;
    fundingRate?: number;
    riseFallRate?: number;
    timestamp: number;
    raw: unknown;
  }> {
    try {
      const response = await this.client.getTicker(symbol);
      const data = unwrapData(response);
      const lastPrice = pickNumber(data, ["lastPrice", "last", "price", "fairPrice", "indexPrice"]);
      if (lastPrice === undefined) {
        throw new Error(`Ticker response does not contain a recognizable price for ${symbol}`);
      }
      return {
        symbol,
        lastPrice,
        bid1: pickNumber(data, ["bid1", "bid", "bestBid"]),
        ask1: pickNumber(data, ["ask1", "ask", "bestAsk"]),
        volume24: pickNumber(data, ["volume24", "volume"]),
        amount24: pickNumber(data, ["amount24", "amount"]),
        holdVol: pickNumber(data, ["holdVol", "openInterest"]),
        fairPrice: pickNumber(data, ["fairPrice"]),
        indexPrice: pickNumber(data, ["indexPrice"]),
        fundingRate: pickNumber(data, ["fundingRate"]),
        riseFallRate: pickNumber(data, ["riseFallRate"]),
        timestamp: pickNumber(data, ["timestamp", "ts"]) ?? Date.now(),
        raw: data
      };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Ticker response does not contain a recognizable price")) {
        this.logSdkError(error);
      }
      throw error;
    }
  }

  async getAllContractDetails(): Promise<Array<ContractDetail & {
    symbol: string;
    displayName?: string;
    priceUnit?: number;
    maxLeverage?: number;
    state?: number;
    isNew?: boolean;
    isHot?: boolean;
    isHidden?: boolean;
    apiAllowed?: boolean;
    makerFeeRate?: number;
    takerFeeRate?: number;
  }>> {
    try {
      const response = await this.client.getContractDetail();
      const data = unwrapData(response);
      const details = Array.isArray(data) ? data : [data];
      return details.filter(isRecord).map((detail) => ({
        symbol: String(detail.symbol ?? ""),
        minVol: pickNumber(detail, ["minVol", "minVolume", "minOrderVol"]),
        maxVol: pickNumber(detail, ["maxVol", "maxVolume", "maxOrderVol"]),
        volUnit: pickNumber(detail, ["volUnit", "volumeStep", "stepSize"]),
        volumeScale: pickNumber(detail, ["volScale", "volumeScale", "quantityScale"]),
        priceScale: pickNumber(detail, ["priceScale"]),
        contractSize: pickNumber(detail, ["contractSize", "contractUnit"]),
        displayName: pickString(detail, ["displayName", "displayNameEn"]),
        priceUnit: pickNumber(detail, ["priceUnit"]),
        maxLeverage: pickNumber(detail, ["maxLeverage"]),
        state: pickNumber(detail, ["state"]),
        isNew: pickBoolean(detail, ["isNew"]),
        isHot: pickBoolean(detail, ["isHot"]),
        isHidden: pickBoolean(detail, ["isHidden"]),
        apiAllowed: pickBoolean(detail, ["apiAllowed"]),
        makerFeeRate: pickNumber(detail, ["makerFeeRate"]),
        takerFeeRate: pickNumber(detail, ["takerFeeRate"]),
        raw: detail
      })).filter((detail) => detail.symbol.length > 0);
    } catch (error) {
      this.logSdkError(error);
      return [];
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
    const detail = await this.getContractDetail(symbol);
    const contractSize = detail?.contractSize ?? 1;
    const rawVolume = (margin * leverage) / (price * contractSize);
    return roundVolume(rawVolume, detail);
  }

  async getAccountAsset(currency = "USDT"): Promise<MexcAccountAsset> {
    try {
      const response = await this.client.getAccountAsset(currency);
      const data = unwrapData(response);
      if (!isRecord(data)) {
        throw new Error(`Account asset response does not contain ${currency} balance`);
      }
      return {
        currency: pickString(data, ["currency"]) ?? currency,
        availableBalance: pickNumber(data, ["availableBalance"]) ?? 0,
        cashBalance: pickNumber(data, ["cashBalance"]) ?? 0,
        equity: pickNumber(data, ["equity"]) ?? 0,
        frozenBalance: pickNumber(data, ["frozenBalance"]) ?? 0,
        positionMargin: pickNumber(data, ["positionMargin"]) ?? 0,
        unrealized: pickNumber(data, ["unrealized"]) ?? 0
      };
    } catch (error) {
      this.logSdkError(error);
      throw error;
    }
  }

  async getOpenPositionDetails(symbol?: string): Promise<MexcOpenPosition[]> {
    try {
      const response = await this.client.getOpenPositions(symbol);
      const data = unwrapData(response);
      if (!Array.isArray(data)) {
        return [];
      }
      return data
        .filter(isRecord)
        .map((position): MexcOpenPosition | undefined => {
          const positionSymbol = pickString(position, ["symbol"]);
          const positionType = pickNumber(position, ["positionType", "type"]);
          const side = pickPositionSide(position, positionType);
          const holdVol = pickNumber(position, ["holdVol", "vol", "volume"]) ?? 0;
          if (!positionSymbol || holdVol <= 0 || !side) {
            return undefined;
          }
          return {
            positionId: pickString(position, ["positionId", "id"]),
            symbol: positionSymbol,
            side,
            openType: pickNumber(position, ["openType"]),
            state: pickNumber(position, ["state"]),
            holdVol,
            frozenVol: pickNumber(position, ["frozenVol"]),
            holdAvgPrice: pickNumber(position, ["holdAvgPrice"]),
            openAvgPrice: pickNumber(position, ["openAvgPrice"]),
            stopLossPrice: pickNumber(position, ["stopLossPrice", "slPrice"]),
            takeProfitPrice: pickNumber(position, ["takeProfitPrice", "tpPrice"]),
            liquidatePrice: pickNumber(position, ["liquidatePrice"]),
            margin: pickNumber(position, ["im", "margin", "positionMargin"]),
            contractSize: pickNumber(position, ["contractSize", "contractUnit"]),
            leverage: pickNumber(position, ["leverage"]) ?? 1,
            unrealized: pickNumber(position, ["unrealized", "unrealizedPnl"]),
            raw: position
          };
        })
        .filter((position): position is MexcOpenPosition => position !== undefined);
    } catch (error) {
      this.logSdkError(error);
      throw error;
    }
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

  async hasOpenPosition(symbol: string, side?: PositionSide): Promise<boolean | undefined> {
    if (this.dryRun) {
      return undefined;
    }

    try {
      const positions = await this.getOpenPositionDetails(symbol);
      return positions.some((position) => {
        return position.symbol === symbol && (side === undefined || position.side === side) && position.state !== 3;
      });
    } catch {
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
    const exchangePosition =
      !this.dryRun && input.positionId === undefined
        ? (await this.getOpenPositionDetails(input.symbol)).find((position) => position.side === input.side)
        : undefined;
    const positionId = input.positionId ?? exchangePosition?.positionId;
    const volume = exchangePosition?.holdVol ?? input.volume;
    const leverage = exchangePosition?.leverage ?? input.leverage;
    const order: SubmitOrderRequest = {
      symbol: input.symbol,
      price: input.price,
      vol: volume,
      side: input.side === "LONG" ? 4 : 2,
      type: 5,
      openType: 1,
      leverage
    };

    const numericPositionId = positionId === undefined ? undefined : Number(positionId);
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
      assertMexcSuccess(response, "Submit order rejected by MEXC");
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

  if (isMexcOpenRestrictedError(error)) {
    return "symbol restricted for this account region; MEXC allows closing only";
  }
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

export function isMexcOpenRestrictedError(error: unknown): boolean {
  const code = isRecord(error) ? pickNumber(error, ["mexcCode", "code"]) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === 8950 || message.includes("MEXC code 8950") || message.toLowerCase().includes("opening positions");
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
        const volume = Number(level[2] ?? level[1]);
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

function pickBoolean(record: unknown, keys: string[]): boolean | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") {
        return true;
      }
      if (value.toLowerCase() === "false") {
        return false;
      }
    }
  }
  return undefined;
}

function unwrapData(value: unknown): unknown {
  if (isRecord(value) && "data" in value) {
    return value.data;
  }
  return value;
}

function assertMexcSuccess(response: unknown, fallbackMessage: string): void {
  if (!isRecord(response)) {
    return;
  }

  const success = response.success;
  const code = pickNumber(response, ["code"]);
  const failedBySuccess = success === false;
  const failedByCode = code !== undefined && code !== 0 && code !== 200;
  if (!failedBySuccess && !failedByCode) {
    return;
  }

  const message =
    pickString(response, ["message", "msg", "error", "errorMsg"]) ??
    pickString(unwrapData(response), ["message", "msg", "error", "errorMsg"]) ??
    fallbackMessage;
  throw new MexcApiResponseError(code === undefined ? message : `${message} (MEXC code ${code})`, code);
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

function pickPositionSide(record: unknown, positionType?: number): PositionSide | undefined {
  if (positionType === 1) {
    return "LONG";
  }
  if (positionType === 2) {
    return "SHORT";
  }

  const rawSide = pickString(record, ["positionSide", "holdSide", "side"]);
  if (!rawSide) {
    return undefined;
  }

  const normalized = rawSide.trim().toLowerCase();
  if (normalized === "long" || normalized === "buy" || normalized === "1") {
    return "LONG";
  }
  if (normalized === "short" || normalized === "sell" || normalized === "2") {
    return "SHORT";
  }

  return undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}
