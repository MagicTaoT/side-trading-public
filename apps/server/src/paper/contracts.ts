import type { SignalSnapshot } from "@side/signal-engine";
import type { RuntimeMode, SourceRuntimeState } from "../contracts.js";

export const PAPER_PAIR = "SOL-USDC" as const;
export const PAPER_NOTIONAL_QUOTE = "10000" as const;
export const PAPER_PREVIEW_TTL_MS = 2_000 as const;
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export type PaperProvider = "zeroex" | "jupiter";
export type PaperSide = "BUY" | "SELL";
export type PaperAction = PaperSide | "WAIT";

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
  routeSummary: string[];
  feeBreakdown: null;
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
  persistence: "memory-side-010";
  action: PaperAction;
  pair: typeof PAPER_PAIR;
  targetNotionalQuote: typeof PAPER_NOTIONAL_QUOTE;
  provider: PaperProvider | null;
  previewId: string | null;
  recordedAtMs: number;
  preview: PaperPreview | null;
  evidence: PaperEvidence;
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
