export type StrategyDirection = "BUY" | "SELL";
export type StrategyState = "STOPPED" | "IDLE" | "ARMING" | "OPEN" | "EXIT_PENDING_PRICE" | "COOLDOWN";

export interface StrategyConfigV1 {
  schemaVersion: 1;
  name: string;
  pair: "SOL-USDC";
  entry: {
    minEdgeBps: string;
    holdSec: number;
    initialSizeQuote: string;
  };
  scaling: {
    enabled: boolean;
    intervalSec: number;
    intervalMultiplier: string;
    sizeQuote: string;
    sizeMultiplier: string;
    maxEntries: number;
    maxTotalSizeQuote: string;
  };
  exit: {
    takeProfitBps: string;
    linearDecayToZero: boolean;
    stopLossBps: string;
    forceExitSec: number;
  };
  cooldownSec: number;
}

export interface StrategyConfigRevision {
  strategyId: string;
  revision: number;
  name: string;
  config: StrategyConfigV1;
  createdAtMs: number;
}

export interface StrategyObservation {
  atMs: number;
  direction: StrategyDirection | null;
  edgeBps: string | null;
  price: string | null;
  referenceSource: string | null;
}

export interface StrategyFill {
  sequence: number;
  kind: "ENTRY" | "ADD" | "EXIT";
  direction: StrategyDirection;
  atMs: number;
  price: string;
  referenceSource: string;
  quoteNotional: string;
  scheduledQuoteNotional: string;
  cappedByMaxTotal: boolean;
  baseQuantity: string;
  edgeBps: string | null;
}

export interface StrategyBasketSnapshot {
  basketSequence: number;
  direction: StrategyDirection;
  status: "OPEN" | "EXIT_PENDING_PRICE" | "CLOSED";
  openedAtMs: number;
  closedAtMs: number | null;
  entries: StrategyFill[];
  exitFill: StrategyFill | null;
  totalQuoteNotional: string;
  totalBaseQuantity: string;
  averageEntryPrice: string;
  currentPrice: string | null;
  currentReferenceSource: string | null;
  grossPnlBps: string | null;
  grossPnlQuote: string | null;
  currentTargetProfitBps: string;
  exitReason: "STOP_LOSS" | "FORCE_EXIT" | "TAKE_PROFIT" | "MANUAL_STOP" | null;
  nextEntryQualificationSinceMs: number | null;
  nextEntryDueAtMs: number | null;
}

export interface StrategySnapshot {
  schemaVersion: 1;
  configFingerprint: string;
  state: StrategyState;
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  evaluatedAtMs: number | null;
  lastObservation: StrategyObservation | null;
  arming: { direction: StrategyDirection; startedAtMs: number } | null;
  currentBasket: StrategyBasketSnapshot | null;
  lastClosedBasket: StrategyBasketSnapshot | null;
  basketCount: number;
  eventSequence: number;
  fillSequence: number;
  cooldownUntilMs: number | null;
  pendingExitReason: StrategyBasketSnapshot["exitReason"];
  stopRequested: boolean;
}

export interface StrategyRunRecord {
  runId: string;
  strategyId: string;
  configRevision: number;
  executionMode: "DRY_RUN";
  status: StrategyState;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
  snapshot: StrategySnapshot;
}

export interface StrategyBasketRecord {
  basketId: string;
  runId: string;
  basketSequence: number;
  direction: StrategyDirection;
  status: StrategyBasketSnapshot["status"];
  openedAtMs: number;
  updatedAtMs: number;
  closedAtMs: number | null;
  snapshot: StrategyBasketSnapshot;
}

export interface StrategyJournalEvent {
  runId: string;
  basketId: string | null;
  eventClass: "STATE_CHANGE" | "FILL";
  event: {
    sequence: number;
    kind: string;
    atMs: number;
    fromState: StrategyState;
    toState: StrategyState;
    reason: string | null;
    fill: StrategyFill | null;
  };
}

export interface StrategyRunDetail {
  run: StrategyRunRecord;
  configRevision: StrategyConfigRevision;
  baskets: StrategyBasketRecord[];
  events: StrategyJournalEvent[];
  eventsTruncated: boolean;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfigV1 = {
  schemaVersion: 1,
  name: "SOL edge persistence",
  pair: "SOL-USDC",
  entry: { minEdgeBps: "3", holdSec: 5, initialSizeQuote: "1000" },
  scaling: {
    enabled: true,
    intervalSec: 5,
    intervalMultiplier: "1",
    sizeQuote: "500",
    sizeMultiplier: "1",
    maxEntries: 3,
    maxTotalSizeQuote: "2000"
  },
  exit: { takeProfitBps: "12", linearDecayToZero: true, stopLossBps: "15", forceExitSec: 180 },
  cooldownSec: 15
};

function positive(value: string | number): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

export function validateConfigDraft(config: StrategyConfigV1): string[] {
  const errors: string[] = [];
  if (!config.name.trim()) errors.push("Strategy name is required");
  if (!Number.isFinite(Number(config.entry.minEdgeBps)) || Number(config.entry.minEdgeBps) < 0) errors.push("Minimum edge must be at least 0 bps");
  if (!Number.isFinite(config.entry.holdSec) || config.entry.holdSec < 0) errors.push("Initial hold must be at least 0 seconds");
  if (!positive(config.entry.initialSizeQuote)) errors.push("Initial size must be greater than 0");
  if (!Number.isFinite(config.scaling.intervalSec) || config.scaling.intervalSec < 0 || (config.scaling.enabled && config.scaling.intervalSec === 0)) {
    errors.push(config.scaling.enabled ? "Subsequent interval must be greater than 0 seconds when scale-in is enabled" : "Subsequent interval must be at least 0 seconds");
  }
  if (!positive(config.scaling.intervalMultiplier)) errors.push("Interval multiplier must be greater than 0");
  if (!positive(config.scaling.sizeQuote)) errors.push("Subsequent size must be greater than 0");
  if (!positive(config.scaling.sizeMultiplier)) errors.push("Size multiplier must be greater than 0");
  if (!Number.isSafeInteger(config.scaling.maxEntries) || config.scaling.maxEntries < 1 || config.scaling.maxEntries > 100) errors.push("Maximum entries must be an integer from 1 to 100");
  if (!positive(config.scaling.maxTotalSizeQuote) || Number(config.scaling.maxTotalSizeQuote) < Number(config.entry.initialSizeQuote)) {
    errors.push("Maximum total exposure cannot be smaller than the initial size");
  }
  if (!Number.isFinite(Number(config.exit.takeProfitBps)) || Number(config.exit.takeProfitBps) < 0) errors.push("Initial take-profit must be at least 0 bps");
  if (!positive(config.exit.stopLossBps)) errors.push("Stop loss must be greater than 0 bps");
  if (!positive(config.exit.forceExitSec)) errors.push("Forced exit must be greater than 0 seconds");
  if (!Number.isFinite(config.cooldownSec) || config.cooldownSec < 0) errors.push("Post-exit cooldown must be at least 0 seconds");
  return errors;
}
