import Decimal from "decimal.js";
import type { StrategyConfigV1 } from "./contracts.js";

const MAX_STRATEGY_ENTRIES = 100;
const ScheduleDecimal = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_EVEN });
const MAX_SAFE_MILLISECONDS = new ScheduleDecimal(Number.MAX_SAFE_INTEGER);

export class StrategyConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StrategyConfigError(code);
  return value as Record<string, unknown>;
}

function decimal(value: unknown, field: string, options: { positive?: boolean; nonNegative?: boolean } = {}): string {
  if (typeof value !== "string") throw new StrategyConfigError(`INVALID_${field}`);
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new StrategyConfigError(`INVALID_${field}`);
  }
  if (!parsed.isFinite()) throw new StrategyConfigError(`INVALID_${field}`);
  if (options.positive && !parsed.gt(0)) throw new StrategyConfigError(`INVALID_${field}`);
  if (options.nonNegative && parsed.lt(0)) throw new StrategyConfigError(`INVALID_${field}`);
  return parsed.toString();
}

function seconds(value: unknown, field: string, positive = false): number {
  if (typeof value !== "number") throw new StrategyConfigError(`INVALID_${field}`);
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new StrategyConfigError(`INVALID_${field}`);
  }
  try {
    secondsToMilliseconds(value);
  } catch {
    throw new StrategyConfigError(`INVALID_${field}`);
  }
  return value;
}

/** Converts an API seconds number to the exact, ceiling-rounded millisecond duration. */
export function secondsToMilliseconds(value: number): number {
  try {
    if (!Number.isFinite(value) || value < 0) throw new RangeError("INVALID_MILLISECOND_DURATION");
    const milliseconds = new ScheduleDecimal(value.toString()).mul(1_000).ceil();
    if (!milliseconds.isFinite() || milliseconds.lt(0) || milliseconds.gt(MAX_SAFE_MILLISECONDS)) {
      throw new RangeError("INVALID_MILLISECOND_DURATION");
    }
    const result = milliseconds.toNumber();
    if (!Number.isSafeInteger(result)) throw new RangeError("INVALID_MILLISECOND_DURATION");
    return result;
  } catch (reason) {
    if (reason instanceof RangeError && reason.message === "INVALID_MILLISECOND_DURATION") throw reason;
    throw new RangeError("INVALID_MILLISECOND_DURATION");
  }
}

/**
 * Calculates one configured scale-in interval without allowing Decimal to be
 * narrowed into an unsafe JavaScript timestamp duration.
 */
export function scalingIntervalMilliseconds(baseSeconds: number, multiplier: string, exponent: number): number {
  try {
    if (!Number.isFinite(baseSeconds) || baseSeconds <= 0 || !Number.isSafeInteger(exponent) || exponent < 0) {
      throw new RangeError("INVALID_SCALING_SCHEDULE");
    }
    const ratio = new ScheduleDecimal(multiplier);
    if (!ratio.isFinite() || !ratio.gt(0)) throw new RangeError("INVALID_SCALING_SCHEDULE");
    const milliseconds = new ScheduleDecimal(baseSeconds.toString())
      .mul(1_000)
      .mul(ratio.pow(exponent))
      .ceil();
    if (!milliseconds.isFinite() || milliseconds.lt(1) || milliseconds.gt(MAX_SAFE_MILLISECONDS)) {
      throw new RangeError("INVALID_SCALING_SCHEDULE");
    }
    const result = milliseconds.toNumber();
    if (!Number.isSafeInteger(result)) throw new RangeError("INVALID_SCALING_SCHEDULE");
    return result;
  } catch (reason) {
    if (reason instanceof RangeError && reason.message === "INVALID_SCALING_SCHEDULE") throw reason;
    throw new RangeError("INVALID_SCALING_SCHEDULE");
  }
}

function validateScalingSchedule(intervalSec: number, intervalMultiplier: string, maxEntries: number): void {
  try {
    // Entry 1 is the initial fill. Add j uses exponent j - 2, so the last
    // configured add (entry maxEntries) uses exponent maxEntries - 2.
    for (let exponent = 0; exponent <= maxEntries - 2; exponent += 1) {
      scalingIntervalMilliseconds(intervalSec, intervalMultiplier, exponent);
    }
  } catch {
    throw new StrategyConfigError("INVALID_SCALING_SCHEDULE");
  }
}

export function validateStrategyConfigV1(value: unknown): StrategyConfigV1 {
  const root = object(value, "INVALID_CONFIG");
  const entry = object(root.entry, "INVALID_ENTRY_CONFIG");
  const scaling = object(root.scaling, "INVALID_SCALING_CONFIG");
  const exit = object(root.exit, "INVALID_EXIT_CONFIG");
  if (root.schemaVersion !== 1) throw new StrategyConfigError("INVALID_SCHEMA_VERSION");
  if (typeof root.name !== "string") throw new StrategyConfigError("INVALID_NAME");
  const name = root.name.trim();
  if (name.length === 0 || name.length > 120) throw new StrategyConfigError("INVALID_NAME");
  if (root.pair !== "SOL-USDC") throw new StrategyConfigError("INVALID_PAIR");
  if (typeof scaling.enabled !== "boolean") throw new StrategyConfigError("INVALID_SCALING_ENABLED");
  if (typeof exit.linearDecayToZero !== "boolean") throw new StrategyConfigError("INVALID_LINEAR_DECAY");
  if (typeof scaling.maxEntries !== "number" || !Number.isInteger(scaling.maxEntries) || scaling.maxEntries < 1 || scaling.maxEntries > MAX_STRATEGY_ENTRIES) {
    throw new StrategyConfigError("INVALID_MAX_ENTRIES");
  }

  const initialSizeQuote = decimal(entry.initialSizeQuote, "INITIAL_SIZE_QUOTE", { positive: true });
  const maxTotalSizeQuote = decimal(scaling.maxTotalSizeQuote, "MAX_TOTAL_SIZE_QUOTE", { positive: true });
  if (new Decimal(maxTotalSizeQuote).lt(initialSizeQuote)) {
    throw new StrategyConfigError("MAX_TOTAL_BELOW_INITIAL_SIZE");
  }
  const intervalSec = seconds(scaling.intervalSec, "SCALING_INTERVAL_SEC", scaling.enabled);
  const intervalMultiplier = decimal(scaling.intervalMultiplier, "INTERVAL_MULTIPLIER", { positive: true });
  if (scaling.enabled && scaling.maxEntries > 1) {
    validateScalingSchedule(intervalSec, intervalMultiplier, scaling.maxEntries);
  }

  return {
    schemaVersion: 1,
    name,
    pair: "SOL-USDC",
    entry: {
      minEdgeBps: decimal(entry.minEdgeBps, "MIN_EDGE_BPS", { nonNegative: true }),
      holdSec: seconds(entry.holdSec, "ENTRY_HOLD_SEC"),
      initialSizeQuote
    },
    scaling: {
      enabled: scaling.enabled,
      intervalSec,
      intervalMultiplier,
      sizeQuote: decimal(scaling.sizeQuote, "SCALING_SIZE_QUOTE", { positive: true }),
      sizeMultiplier: decimal(scaling.sizeMultiplier, "SIZE_MULTIPLIER", { positive: true }),
      maxEntries: scaling.maxEntries,
      maxTotalSizeQuote
    },
    exit: {
      takeProfitBps: decimal(exit.takeProfitBps, "TAKE_PROFIT_BPS", { nonNegative: true }),
      linearDecayToZero: exit.linearDecayToZero,
      stopLossBps: decimal(exit.stopLossBps, "STOP_LOSS_BPS", { positive: true }),
      forceExitSec: seconds(exit.forceExitSec, "FORCE_EXIT_SEC", true)
    },
    cooldownSec: seconds(root.cooldownSec, "COOLDOWN_SEC")
  };
}

export function strategyConfigFingerprint(config: StrategyConfigV1): string {
  return JSON.stringify(validateStrategyConfigV1(config));
}
