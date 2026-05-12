export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type DirectionMode = "long" | "short" | "both" | "auto";

export type SignalAction = "BUY" | "SELL" | "CLOSE" | "HOLD";

export type PositionSide = "LONG" | "SHORT";

export type ExitReason =
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "TRAILING_TAKE_PROFIT"
  | "CHASING_TAKE_PROFIT"
  | "EXCHANGE_SYNC_CLOSE"
  | "STRATEGY_CLOSE"
  | "MANUAL_CLOSE"
  | "EMERGENCY_CLOSE"
  | "SHUTDOWN";

export interface Signal {
  action: SignalAction;
  reason: string;
}

export const HOLD_SIGNAL: Signal = {
  action: "HOLD",
  reason: "No actionable setup"
};

export interface Tick {
  symbol: string;
  price: number;
  timestamp: number;
  volume?: number;
}

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openedAt: number;
  closedAt: number;
}

export interface DepthLevel {
  price: number;
  volume: number;
}

export interface OrderBook {
  bids: DepthLevel[];
  asks: DepthLevel[];
  timestamp: number;
}

export interface StrategyContext {
  config: BotConfig;
  ticks: Tick[];
  candles: Candle[];
  currentTick: Tick;
  position?: Position;
  orderBook?: OrderBook;
}

export interface TrailingTakeProfitConfig {
  enabled: boolean;
  activationProfitPercent: number;
  distancePercent: number;
}

export interface ChasingTakeProfitConfig {
  enabled: boolean;
  activationProfitPercent: number;
  chaseDistancePercent: number;
}

export interface BotConfig {
  accountId?: string;
  accountName?: string;
  accountRole?: "master" | "slave";
  authToken: string;
  symbol: string;
  margin: number;
  leverage: number;
  directionMode: DirectionMode;
  strategyName: string;
  takeProfitPercent: number;
  stopLossPercent: number;
  manualStopLossRoePercent: number;
  trailingTakeProfit: TrailingTakeProfitConfig;
  chasingTakeProfit: ChasingTakeProfitConfig;
  maxTradesPerSession: number;
  maxConsecutiveLosses: number;
  maxDailyLoss: number;
  cooldownMs: number;
  dryRun: boolean;
  tickIntervalMs: number;
  debug: boolean;
  strategyParams: Record<string, number | string | boolean>;
}

export interface Position {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  volume: number;
  contractSize?: number;
  margin: number;
  leverage: number;
  positionId?: string;
  stopLossPrice: number;
  takeProfitPrice: number;
  openedAt: number;
  maxFavorablePrice: number;
  minFavorablePrice: number;
  trailingActive: boolean;
  chasingActive: boolean;
}

export interface TradeResult {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  exitPrice: number;
  volume: number;
  contractSize?: number;
  margin: number;
  leverage: number;
  pnl: number;
  pnlPercentOnMargin: number;
  reason: ExitReason;
  openedAt: number;
  closedAt: number;
}

export interface RiskSnapshot {
  tradesOpened: number;
  wins: number;
  losses: number;
  consecutiveLosses: number;
  dailyPnl: number;
  emergencyCloseRequested: boolean;
  lastClosedAt?: number;
}

export interface RiskDecision {
  allowed: boolean;
  reason: string;
}

export interface SubmitOrderRequest {
  symbol: string;
  price: number;
  vol: number;
  side: 1 | 2 | 3 | 4;
  type: 1 | 5;
  openType: 1 | 2;
  leverage: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
}

export interface SubmitOrderResult {
  orderId?: string;
  positionId?: string;
  raw: unknown;
}

export interface ContractDetail {
  minVol?: number;
  maxVol?: number;
  volUnit?: number;
  volumeScale?: number;
  priceScale?: number;
  contractSize?: number;
  raw: unknown;
}
