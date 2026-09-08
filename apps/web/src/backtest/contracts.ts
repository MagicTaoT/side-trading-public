import type {
  StrategyBasketSnapshot,
  StrategyConfigRevision,
  StrategyConfigV1
} from "../strategy/contracts.js";

export interface BacktestDataset {
  datasetId: string;
  status: "OPEN" | "COMPLETE" | "FAILED";
  createdAtMs: number;
  closedAtMs: number | null;
  eventCount: number;
  observationCount: number;
  providers: string[];
  signalModelVersions: string[];
  datasetSha256: string | null;
  failure: string | null;
}

export interface BacktestDatasetReference {
  datasetId: string;
  datasetSha256: string;
  eventCount: number;
  observationCount: number;
  firstAtMs: number;
  lastAtMs: number;
  signalModelVersion: string;
  observationSource: "RECORDED_TAPE" | "RECONSTRUCTED_EVENTS";
}

export interface BacktestSummary {
  observationCount: number;
  readyObservationCount: number;
  coverageRatio: string;
  basketCount: number;
  closedBasketCount: number;
  openBasketCount: number;
  winCount: number;
  lossCount: number;
  flatCount: number;
  entryFillCount: number;
  totalEntryNotionalQuote: string;
  maxCapitalQuote: string;
  closedPnlQuote: string;
  openPnlQuote: string | null;
  totalTheoreticalPnlQuote: string | null;
  averageClosedPnlQuote: string | null;
  returnOnMaxCapitalBps: string | null;
  maxDrawdownQuote: string;
  exitReasonCounts: Record<"TAKE_PROFIT" | "STOP_LOSS" | "FORCE_EXIT" | "MANUAL_STOP", number>;
}

export type BacktestExperimentStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED";
export type BacktestVariantStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface BacktestVariant {
  variantId: string;
  ordinal: number;
  status: BacktestVariantStatus;
  config: StrategyConfigV1;
  configSha256: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
  resultId: string | null;
  resultSha256: string | null;
  summary: BacktestSummary | null;
  error: string | null;
}

export interface BacktestExperiment {
  schemaVersion: 1;
  experimentId: string;
  name: string;
  datasetId: string;
  dataset: BacktestDatasetReference | null;
  status: BacktestExperimentStatus;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  variantCount: number;
  completedVariantCount: number;
  failedVariantCount: number;
  cancelRequested: boolean;
  variants: BacktestVariant[];
  error: string | null;
}

export interface BacktestEquityPoint {
  atMs: number;
  equityQuote: string | null;
  closedPnlQuote: string;
  openPnlQuote: string | null;
}

export interface BacktestResult {
  resultId: string;
  resultSha256: string;
  executionModel: "GROSS_THEORETICAL_V1";
  dataset: BacktestDatasetReference;
  config: StrategyConfigV1;
  startedAtMs: number;
  completedAtMs: number;
  summary: BacktestSummary;
  equityCurve: BacktestEquityPoint[];
  baskets: StrategyBasketSnapshot[];
  finalSnapshot: { currentBasket: StrategyBasketSnapshot | null };
}

export type BacktestGridField =
  | "entry.minEdgeBps"
  | "entry.holdSec"
  | "entry.initialSizeQuote"
  | "scaling.enabled"
  | "scaling.intervalSec"
  | "scaling.intervalMultiplier"
  | "scaling.sizeQuote"
  | "scaling.sizeMultiplier"
  | "scaling.maxEntries"
  | "scaling.maxTotalSizeQuote"
  | "exit.takeProfitBps"
  | "exit.linearDecayToZero"
  | "exit.stopLossBps"
  | "exit.forceExitSec"
  | "cooldownSec";

export type BacktestParameterGrid = Partial<Record<BacktestGridField, unknown[]>>;

export interface SavedConfigOption {
  key: string;
  label: string;
  revision: StrategyConfigRevision | null;
  config: StrategyConfigV1;
}
