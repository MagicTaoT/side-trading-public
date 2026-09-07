import Decimal from "decimal.js";
import type { SourceRuntimeState } from "../contracts.js";
import type { DexReferenceSnapshot } from "./contracts.js";
import { REFERENCE_POLICY_VERSION } from "./contracts.js";

export const REFERENCE_WINDOW_MS = 15_000;
export const REFERENCE_SOURCE_FRESHNESS_MS = 5_000;
export const REFERENCE_MIN_SAMPLES = 3;
const MAX_DEVIATION_BPS = new Decimal(100);
const MAX_REJECTED_SHARE = new Decimal("0.25");

export interface DexPriceSample {
  eventId: string;
  observedAtMs: number;
  priceQuotePerSol: string;
}

function unavailable(
  evaluatedAtMs: number,
  reason: DexReferenceSnapshot["reason"],
  sampleCount = 0,
  rejectedSampleCount = 0
): DexReferenceSnapshot {
  return {
    policyVersion: REFERENCE_POLICY_VERSION,
    status: "UNAVAILABLE",
    evaluatedAtMs,
    windowStartMs: evaluatedAtMs - REFERENCE_WINDOW_MS,
    windowEndMs: evaluatedAtMs,
    priceQuotePerSol: null,
    sampleCount,
    rejectedSampleCount,
    reason
  };
}

function median(values: Decimal[]): Decimal {
  const sorted = [...values].sort((left, right) => left.comparedTo(right));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as Decimal;
  return (sorted[middle - 1] as Decimal).plus(sorted[middle] as Decimal).div(2);
}

export function robustDexReference(
  evaluatedAtMs: number,
  samples: DexPriceSample[],
  source: SourceRuntimeState | null
): DexReferenceSnapshot {
  if (!source) return unavailable(evaluatedAtMs, "SOURCE_NOT_OBSERVED");
  if (source.quality === "gap") return unavailable(evaluatedAtMs, "SOURCE_GAP");
  if (
    source.connection !== "live" ||
    source.quality !== "fresh" ||
    evaluatedAtMs - source.lastSeenAtMs > REFERENCE_SOURCE_FRESHNESS_MS
  ) {
    return unavailable(evaluatedAtMs, "SOURCE_NOT_FRESH");
  }

  const lowerBound = evaluatedAtMs - REFERENCE_WINDOW_MS;
  const unique = new Map<string, Decimal>();
  for (const sample of samples) {
    if (sample.observedAtMs <= lowerBound || sample.observedAtMs > evaluatedAtMs || unique.has(sample.eventId)) continue;
    try {
      const value = new Decimal(sample.priceQuotePerSol);
      if (value.isFinite() && value.gt(0)) unique.set(sample.eventId, value);
    } catch {
      // Invalid provider values are excluded and still count toward an unavailable result below.
    }
  }
  const values = [...unique.values()];
  if (values.length < REFERENCE_MIN_SAMPLES) return unavailable(evaluatedAtMs, "INSUFFICIENT_SAMPLES", values.length);

  const center = median(values);
  const accepted = values.filter((value) => value.div(center).minus(1).abs().mul(10_000).lte(MAX_DEVIATION_BPS));
  const rejectedSampleCount = values.length - accepted.length;
  const rejectedShare = new Decimal(rejectedSampleCount).div(values.length);
  if (accepted.length < REFERENCE_MIN_SAMPLES || rejectedShare.gt(MAX_REJECTED_SHARE)) {
    return unavailable(evaluatedAtMs, "REFERENCE_OUTLIER", accepted.length, rejectedSampleCount);
  }

  return {
    policyVersion: REFERENCE_POLICY_VERSION,
    status: "READY",
    evaluatedAtMs,
    windowStartMs: lowerBound,
    windowEndMs: evaluatedAtMs,
    priceQuotePerSol: median(accepted).toFixed(8),
    sampleCount: accepted.length,
    rejectedSampleCount,
    reason: null
  };
}
