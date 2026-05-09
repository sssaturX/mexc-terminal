import { PositionSide } from "../types";

export type ScannerProfileName = "liquid_major" | "lowcap_event";
export type ScannerSetupName = "SWEEP_RECLAIM" | "ABSORPTION_FAILURE" | "COMPRESSION_EXPANSION";
export type ScannerGrade = "B" | "A" | "A+";

export interface ScannerAccount {
  id: string;
  name: string;
  authToken: string;
  role: "master" | "slave";
}

export interface ScannerConfig {
  accounts: ScannerAccount[];
  masterAccountId?: string;
  symbols: string[];
  strictZeroFee: boolean;
  executionMode: "scanner" | "semi_auto";
  dryRun: boolean;
  equityUsdt: number;
  riskPct: number;
  leverage: number;
  maxFocusedSymbols: number;
  minGrade: ScannerGrade;
  tickIntervalMs: number;
  debug: boolean;
}

export interface ScannerContractMeta {
  symbol: string;
  contractSize: number;
  priceUnit: number;
  maxLeverage: number;
  state?: number;
  isNew?: boolean;
  isHot?: boolean;
  isHidden?: boolean;
  apiAllowed?: boolean;
  makerFeeRate?: number;
  takerFeeRate?: number;
  isZeroFeeSymbol?: boolean;
}

export interface ScannerTicker {
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
}

export interface ScannerDepth {
  bids: Array<{ price: number; volume: number }>;
  asks: Array<{ price: number; volume: number }>;
  timestamp: number;
}

export interface ScannerCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openedAt: number;
  closedAt: number;
}

export interface ScannerFeatures {
  symbol: string;
  profile: ScannerProfileName;
  price: number;
  spreadPct: number;
  depthTop10Usdt: number;
  imbalanceTop5: number;
  amount24: number;
  volumeDelta1m: number;
  medianVolumeDelta20: number;
  volMult20: number;
  move5mPct: number;
  oiNotional: number;
  oiChange1mPct: number;
  fairBasisPct: number;
  fundingRate: number;
  score: number;
}

export interface ScannerAlert {
  id: string;
  createdAt: number;
  expiresAt: number;
  symbol: string;
  setup: ScannerSetupName;
  side: PositionSide;
  grade: ScannerGrade;
  score: number;
  profile: ScannerProfileName;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  riskUsdt: number;
  requiredMargin: number;
  notional: number;
  leverage: number;
  stopPct: number;
  features: ScannerFeatures;
  reason: string;
  status: "new" | "executed" | "expired" | "rejected";
  executedAt?: number;
  executionError?: string;
}

export interface ScannerStatus {
  running: boolean;
  wsConnected: boolean;
  mode: "scanner" | "semi_auto";
  dryRun: boolean;
  focusedSymbols: string[];
  topSymbols: Array<{ symbol: string; score: number; profile: ScannerProfileName; price: number; spreadPct: number; amount24: number }>;
  alerts: ScannerAlert[];
  lastError?: string;
  lastScanAt?: number;
}
