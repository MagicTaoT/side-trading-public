import type { SignalSnapshot } from "@side/signal-engine";
import type { RuntimeMode, SourceRuntimeState } from "../contracts.js";

export const PAPER_PAIR = "SOL-USDC" as const;
export const PAPER_NOTIONAL_QUOTE = "10000" as const;
export const PAPER_PREVIEW_TTL_MS = 2_000 as const;
export const PAPER_PRICE_REFRESH_MS = 5_000 as const;
export const PAPER_PRICE_STALE_MS = 12_000 as const;
export const PAPER_DRY_HALF_SPREAD_BPS = 50 as const;
export const PAPER_DRY_REFERENCE_MAX_AGE_MS = 5_000 as const;
export const PAPER_MARKOUT_HORIZON_MS = 300_000 as const;
export const REFERENCE_POLICY_VERSION = "bitquery-wsol-usdc-robust-v1" as const;
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export type PaperProvider = "zeroex" | "jupiter";
export type PaperSide = "BUY" | "SELL";
export type PaperAction = PaperSide | "WAIT";
export type PaperPersistence = "postgres-side-011" | "memory-side-011-test";

export type DexReferenceReason =
  | "SOURCE_NOT_OBSERVED"
  | "SOURCE_NOT_FRESH"
  | "SOURCE_GAP"
  | "INSUFFICIENT_SAMPLES"
  | "REFERENCE_OUTLIER"
  | "WAIT_ACTION";

export interface DexReferenceSnapshot {
  policyVersion: typeof REFERENCE_POLICY_VERSION;
  status: "READY" | "UNAVAILABLE";
  evaluatedAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  priceQuotePerSol: string | null;
  sampleCount: number;
  rejectedSampleCount: number;
  reason: DexReferenceReason | null;
}

export interface PaperMarkout {
  decisionId: string;
  horizonMs: typeof PAPER_MARKOUT_HORIZON_MS;
  referencePolicyVersion: typeof REFERENCE_POLICY_VERSION;
  dueAtMs: number;
  status: "PENDING" | "SCORED" | "UNSCORED";
  entryReference: DexReferenceSnapshot;
  futureReference: DexReferenceSnapshot | null;
  directionalMarkoutBps: string | null;
  directionalPnlQuote: string | null;
  reason: DexReferenceReason | null;
  computedAtMs: number | null;
}

export type PaperFailureCode =
  | "MARKET_DATA_NOT_READY"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_HTTP_429"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_SCHEMA_DRIFT"
  | "MIXED_PROVIDER_RESPONSE";

export interface PaperQuoteFailure {
  failureId: string;
  provider: PaperProvider;
  code: PaperFailureCode;
  occurredAtMs: number;
  retriable: boolean;
  httpStatus: number | null;
}

export interface PaperQuoteLeg {
  provider: PaperProvider;
  requestId: string;
  requestedAtMs: number;
  receivedAtMs: number;
  latencyMs: number;
  inputMint: string;
  outputMint: string;
  amountInAtomic: string;
  amountOutAtomic: string;
  minimumAmountOutAtomic: string | null;
  routeSummary: string[];
  rawResponseHash: string;
  priceImpactPct: string | null;
  zid: string | null;
}

export interface PaperPreview {
  schemaVersion: 1;
  previewId: string;
  mode: RuntimeMode;
  status: "READY" | "UNAVAILABLE";
  provider: PaperProvider;
  side: PaperSide;
  pair: typeof PAPER_PAIR;
  targetNotionalQuote: typeof PAPER_NOTIONAL_QUOTE;
  createdAtMs: number;
  expiresAtMs: number | null;
  quoteAgeMs: number | null;
  recordable: boolean;
  primaryFailureId: string | null;
  failure: PaperQuoteFailure | null;
  anchor: PaperQuoteLeg | null;
  directional: PaperQuoteLeg | null;
  inputAmountSOL: string | null;
  estimatedOutputSOL: string | null;
  estimatedOutputUSDC: string | null;
  minimumOutputAmount: string | null;
  referencePxQuotePerSol: string | null;
  effectivePxQuotePerSol: string | null;
  routeSummary: string[];
  feeBreakdown: null;
}

export type PaperDisplayPriceStatus = "LIVE" | "STALE" | "DRY" | "UNAVAILABLE";
export type PaperDisplayPriceSource = "zeroex-estimate" | "replay-estimate" | "bitquery-dry" | "coinbase-dry";
export type PaperDryReferenceReason = DexReferenceReason | "CEX_REFERENCE_NOT_FRESH" | "CEX_REFERENCE_NOT_OBSERVED";

export interface PaperDryReferenceSnapshot {
  status: "READY" | "UNAVAILABLE";
  source: "bitquery-wsol-usdc" | "coinbase-sol-usd" | null;
  priceQuotePerSol: string | null;
  observedAtMs: number | null;
  reason: PaperDryReferenceReason | null;
}

export interface PaperDisplayPrice {
  side: PaperSide;
  status: PaperDisplayPriceStatus;
  priceQuotePerSol: string | null;
  provider: PaperProvider | null;
  source: PaperDisplayPriceSource | null;
  observedAtMs: number | null;
  ageMs: number | null;
  upstreamFailure: PaperFailureCode | null;
  reason: PaperFailureCode | PaperDryReferenceReason | null;
  dryAssumptionBps: number | null;
  recordable: false;
}

export interface PaperPriceBoardSnapshot {
  schemaVersion: 1;
  mode: RuntimeMode;
  pair: typeof PAPER_PAIR;
  targetNotionalQuote: typeof PAPER_NOTIONAL_QUOTE;
  refreshIntervalMs: typeof PAPER_PRICE_REFRESH_MS;
  refreshedAtMs: number | null;
  nextRefreshAtMs: number | null;
  buy: PaperDisplayPrice;
  sell: PaperDisplayPrice;
}

export interface PaperEvidence {
  mode: RuntimeMode;
  signal: SignalSnapshot;
  sources: SourceRuntimeState[];
}

export interface PaperOrder {
  schemaVersion: 1;
  orderId: string;
  executionMode: "paper";
  persistence: PaperPersistence;
  action: PaperAction;
  pair: typeof PAPER_PAIR;
  targetNotionalQuote: typeof PAPER_NOTIONAL_QUOTE;
  provider: PaperProvider | null;
  previewId: string | null;
  recordedAtMs: number;
  preview: PaperPreview | null;
  evidence: PaperEvidence;
  markout: PaperMarkout;
}

export interface PaperPerformanceSummary {
  scoredCount: number;
  unscoredCount: number;
  pendingCount: number;
  buyCount: number;
  sellCount: number;
  waitCount: number;
  winCount: number;
  meanDirectionalMarkoutBps: string | null;
  unscoredReasonCounts: Record<string, number>;
}

export interface PreviewRequest {
  side: PaperSide;
  provider: PaperProvider;
  idempotencyKey: string;
  primaryFailureId: string | null;
}

export interface RecordPaperOrderRequest {
  action: PaperAction;
  idempotencyKey: string;
  previewId: string | null;
  provider: PaperProvider | null;
}
