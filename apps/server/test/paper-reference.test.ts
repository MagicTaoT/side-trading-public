import { describe, expect, it } from "vitest";
import type { SourceRuntimeState } from "../src/contracts.js";
import { robustDexReference, type DexPriceSample } from "../src/paper/reference.js";

function source(now: number, overrides: Partial<SourceRuntimeState> = {}): SourceRuntimeState {
  return {
    provider: "bitquery",
    connection: "live",
    quality: "fresh",
    replay: false,
    eventCount: 4,
    lastEventId: "bitquery:4",
    lastIngestSeq: "4",
    lastSeenAtMs: now - 100,
    ...overrides
  };
}

function sample(eventId: string, observedAtMs: number, priceQuotePerSol: string): DexPriceSample {
  return { eventId, observedAtMs, priceQuotePerSol };
}

describe("Bitquery robust realized-price reference", () => {
  it("uses a deduped in-window median and excludes a bounded outlier", () => {
    const now = 20_000;
    const result = robustDexReference(now, [
      sample("a", now - 4_000, "99.99"),
      sample("b", now - 3_000, "100.00"),
      sample("c", now - 2_000, "100.01"),
      sample("d", now - 1_000, "101.20"),
      sample("d", now - 500, "101.00"),
      sample("old", now - 16_000, "90")
    ], source(now));

    expect(result).toMatchObject({
      status: "READY",
      priceQuotePerSol: "100.00000000",
      sampleCount: 3,
      rejectedSampleCount: 1,
      reason: null
    });
  });

  it("fails closed for a gap, insufficient samples, stale source or excessive outliers", () => {
    const now = 20_000;
    const good = [sample("a", 18_000, "100"), sample("b", 18_500, "100.01"), sample("c", 19_000, "100.02")];
    expect(robustDexReference(now, good, source(now, { quality: "gap" })).reason).toBe("SOURCE_GAP");
    expect(robustDexReference(now, good.slice(0, 2), source(now)).reason).toBe("INSUFFICIENT_SAMPLES");
    expect(robustDexReference(now, good, source(now, { lastSeenAtMs: 10_000 })).reason).toBe("SOURCE_NOT_FRESH");
    expect(robustDexReference(now, [
      sample("a", 18_000, "100"),
      sample("b", 18_100, "100.01"),
      sample("c", 18_200, "100.02"),
      sample("d", 18_300, "120"),
      sample("e", 18_400, "121")
    ], source(now))).toMatchObject({ status: "UNAVAILABLE", reason: "REFERENCE_OUTLIER" });
  });
});
