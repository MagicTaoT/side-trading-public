export const S0_SEGMENTS = ["cex-spot", "cex-perp", "dex-spot", "defi-perp"] as const;

export type S0Segment = (typeof S0_SEGMENTS)[number];
export type JuryVote = "BUY" | "SELL" | "NEUTRAL";
export type FeatureDirection = JuryVote;
export type Verdict = "BUY_BIAS" | "SELL_BIAS" | "NO_EDGE" | "INSUFFICIENT_DATA";
export type SignalDataState = "READY" | "INSUFFICIENT_DATA";

export interface S0SignalConfig {
  modelVersion: "s0-v1";
  windowMs: 30_000;
  retentionMs: 120_000;
  freshnessMs: 5_000;
  priceThresholdBps: "2";
  flowThreshold: "0.15";
  minimumNotionalQuote: Record<S0Segment, string>;
}

export interface PriceImpulseFeature {
  status: "available" | "warming";
  valueBps: string | null;
  direction: FeatureDirection;
  anchorAtMs: number | null;
  latestAtMs: number | null;
}

export interface FlowImbalanceFeature {
  status: "available" | "missing" | "below-minimum-volume";
  value: string | null;
  direction: FeatureDirection;
  totalNotionalQuote: string;
  minimumNotionalQuote: string;
}

export interface JurySnapshot {
  modelVersion: "s0-v1";
  segment: S0Segment;
  dataState: "FRESH" | "UNAVAILABLE";
  vote: JuryVote;
  evaluatedAtMs: number;
  asOfIngestSeq: string;
  sourceProviders: string[];
  limitedSourceCoverage: true;
  features: {
    priceImpulse30s: PriceImpulseFeature;
    aggressorImbalance30s: FlowImbalanceFeature;
  };
  reasons: string[];
}

export interface VerdictSnapshot {
  modelVersion: "s0-v1";
  verdict: Verdict;
  dataState: SignalDataState;
  evaluatedAtMs: number;
  asOfIngestSeq: string;
  freshJuryCount: number;
  buyJuryCount: number;
  sellJuryCount: number;
  neutralJuryCount: number;
  lastValidVerdict: Exclude<Verdict, "INSUFFICIENT_DATA"> | null;
  reasons: string[];
}

export interface SignalSnapshot {
  modelVersion: "s0-v1";
  evaluatedAtMs: number;
  asOfIngestSeq: string;
  juries: JurySnapshot[];
  verdict: VerdictSnapshot;
}

export type SignalTransition =
  | {
      kind: "jury-changed";
      segment: S0Segment;
      asOfIngestSeq: string;
      current: JurySnapshot;
    }
  | {
      kind: "verdict-changed";
      asOfIngestSeq: string;
      previous: Verdict;
      current: VerdictSnapshot;
    };
