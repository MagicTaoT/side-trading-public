import type {
  StrategyBasketSnapshot,
  StrategyConfigV1,
  StrategyEvent,
  StrategySnapshot,
  StrategyState
} from "@side/strategy-engine";

export type StrategyPersistence = "memory-strategy-v1" | "postgres-strategy-v1";
export type StrategyEventClass = "STATE_CHANGE" | "FILL";

export interface CreateStrategyConfigRevisionInput {
  strategyId: string;
  /** Omit to allocate the next revision atomically. */
  revision?: number;
  config: StrategyConfigV1;
  createdAtMs: number;
}

export interface StrategyConfigRevision {
  strategyId: string;
  revision: number;
  name: string;
  config: StrategyConfigV1;
  createdAtMs: number;
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
  direction: "BUY" | "SELL";
  status: StrategyBasketSnapshot["status"];
  openedAtMs: number;
  updatedAtMs: number;
  closedAtMs: number | null;
  snapshot: StrategyBasketSnapshot;
}

export interface StrategyJournalEvent {
  runId: string;
  basketId: string | null;
  eventClass: StrategyEventClass;
  event: StrategyEvent;
}

export interface CreateStrategyRunInput {
  run: StrategyRunRecord;
  event: StrategyEvent;
}

export interface RecordStrategyEventInput {
  run: StrategyRunRecord;
  basket?: StrategyBasketRecord | null;
  event: StrategyEvent;
}

export interface StrategyBatchEventInput {
  basket?: StrategyBasketRecord | null;
  event: StrategyEvent;
}

/**
 * Persists every event emitted by one engine evaluation together with its final
 * recovery snapshot. The final run snapshot must not become visible unless the
 * complete event batch is committed.
 */
export interface RecordStrategyBatchInput {
  run: StrategyRunRecord;
  records: StrategyBatchEventInput[];
}

/** Persists recovery-critical state without adding a market-tick history row. */
export interface CheckpointStrategyRunInput {
  run: StrategyRunRecord;
  basket?: StrategyBasketRecord | null;
}

export interface StrategyRunRecovery {
  configRevision: StrategyConfigRevision;
  run: StrategyRunRecord;
}

export interface StrategyRecovery extends StrategyRunRecovery {
  baskets: StrategyBasketRecord[];
  events: StrategyJournalEvent[];
}
