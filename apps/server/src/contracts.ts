import type { UiEvent } from "@side/market-core";
import type { SignalSnapshot } from "@side/signal-engine";

export type RuntimeMode = "LIVE" | "REPLAY";
export type ReplayStatus = "disabled" | "idle" | "running" | "completed" | "stopped";

export interface SourceRuntimeState {
  provider: string;
  connection: "connecting" | "live" | "reconnecting" | "closed";
  quality: "fresh" | "degraded" | "stale" | "gap";
  replay: boolean;
  eventCount: number;
  lastEventId: string;
  lastIngestSeq: string;
  lastSeenAtMs: number;
}

export interface ReplayPaperPreview {
  schemaVersion: 1;
  previewId: string;
  mode: "REPLAY";
  status: "READY";
  provider: "zeroex";
  side: "buy-sol";
  pair: "SOL-USDC";
  targetNotionalQuote: "10000";
  estimatedOutputSOL: string;
  minimumOutputSOL: null;
  priceImpactBps: null;
  feeBreakdown: null;
  quoteAgeMs: number;
  routeSummary: string[];
  recordable: false;
  disabledReason: "PAPER_RECORD_ENTERS_SIDE_010";
}

export interface LivePaperPreview {
  schemaVersion: 1;
  previewId: "live:unavailable:side-006";
  mode: "LIVE";
  status: "UNAVAILABLE";
  provider: null;
  side: "buy-sol";
  pair: "SOL-USDC";
  targetNotionalQuote: "10000";
  estimatedOutputSOL: null;
  minimumOutputSOL: null;
  priceImpactBps: null;
  feeBreakdown: null;
  quoteAgeMs: null;
  routeSummary: string[];
  recordable: false;
  disabledReason: "LIVE_QUOTE_NOT_REQUESTED";
}

export interface RuntimeSnapshot {
  schemaVersion: 1;
  mode: RuntimeMode;
  cexProfile: "coinbase" | "binance" | "unavailable";
  replayStatus: ReplayStatus;
  eventsIngested: number;
  lastIngestSeq: string | null;
  sources: SourceRuntimeState[];
  recentUiEvents: UiEvent[];
  signal: SignalSnapshot;
  paperPreview: ReplayPaperPreview | LivePaperPreview;
}

export type GatewayMessage =
  | { type: "state_snapshot"; snapshot: RuntimeSnapshot }
  | { type: "ui_event"; event: UiEvent }
  | { type: "source_health"; source: SourceRuntimeState }
  | { type: "signal_state"; signal: SignalSnapshot }
  | {
      type: "resync_required";
      suppressedCountByKind: Record<string, number>;
      snapshot: RuntimeSnapshot;
    };
