export type StrategyDirection = "BUY" | "SELL";

export type StrategyState =
  | "STOPPED"
  | "IDLE"
  | "ARMING"
  | "OPEN"
  | "EXIT_PENDING_PRICE"
  | "COOLDOWN";

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
    /** Total number of entries, including the initial entry. */
    maxEntries: number;
    maxTotalSizeQuote: string;
  };
  exit: {
    takeProfitBps: string;
    linearDecayToZero: boolean;
    stopLossBps: string;
    /** Measured from the initial fill. Scale-ins never reset this clock. */
    forceExitSec: number;
  };
  cooldownSec: number;
}

export interface StrategyObservation {
  atMs: number;
  direction: StrategyDirection | null;
  /** Signed or unsigned input is accepted; qualification uses its absolute value. */
  edgeBps: string | null;
  /** Theoretical quote-per-SOL execution price. */
  price: string | null;
  referenceSource: string | null;
}

export type StrategyFillKind = "ENTRY" | "ADD" | "EXIT";

export interface StrategyFill {
  sequence: number;
  kind: StrategyFillKind;
  /** Position direction; an EXIT fill closes this direction. */
  direction: StrategyDirection;
  atMs: number;
  price: string;
  referenceSource: string;
  /** Actual quote notional after applying the basket cap. */
  quoteNotional: string;
  /** Requested amount before applying the basket cap. */
  scheduledQuoteNotional: string;
  cappedByMaxTotal: boolean;
  baseQuantity: string;
  edgeBps: string | null;
}

export type StrategyExitReason = "STOP_LOSS" | "FORCE_EXIT" | "TAKE_PROFIT" | "MANUAL_STOP";
export type StrategyBasketStatus = "OPEN" | "EXIT_PENDING_PRICE" | "CLOSED";

export interface StrategyBasketSnapshot {
  basketSequence: number;
  direction: StrategyDirection;
  status: StrategyBasketStatus;
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
  exitReason: StrategyExitReason | null;
  /** Continuous original-direction edge timer for the next scale-in. */
  nextEntryQualificationSinceMs: number | null;
  nextEntryDueAtMs: number | null;
}

export interface StrategyArmingSnapshot {
  direction: StrategyDirection;
  startedAtMs: number;
  readyAtMs: number;
  waitingForPrice: boolean;
}

export interface StrategySnapshot {
  schemaVersion: 1;
  configFingerprint: string;
  state: StrategyState;
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  evaluatedAtMs: number | null;
  lastObservation: StrategyObservation | null;
  arming: StrategyArmingSnapshot | null;
  currentBasket: StrategyBasketSnapshot | null;
  lastClosedBasket: StrategyBasketSnapshot | null;
  basketCount: number;
  /** Last emitted event sequence. */
  eventSequence: number;
  /** Last emitted fill sequence. */
  fillSequence: number;
  cooldownUntilMs: number | null;
  pendingExitReason: StrategyExitReason | null;
  /** A manual stop waiting for a usable exit price completes into STOPPED. */
  stopRequested: boolean;
}

export type StrategyEventKind =
  | "RUN_STARTED"
  | "RUN_STOPPED"
  | "ARMING_STARTED"
  | "ARMING_RESET"
  | "ENTRY_FILLED"
  | "ADD_FILLED"
  | "EXIT_PENDING_PRICE"
  | "EXIT_FILLED"
  | "COOLDOWN_COMPLETED";

export type StrategyEventReason =
  | StrategyExitReason
  | "EDGE_NOT_QUALIFIED"
  | "EDGE_DIRECTION_CHANGED"
  | "COOLDOWN_ELAPSED"
  | null;

export interface StrategyEvent {
  schemaVersion: 1;
  sequence: number;
  kind: StrategyEventKind;
  atMs: number;
  fromState: StrategyState;
  toState: StrategyState;
  reason: StrategyEventReason;
  basketSequence: number | null;
  observation: StrategyObservation | null;
  fill: StrategyFill | null;
  basket: StrategyBasketSnapshot | null;
}
