import { describe, expect, it } from "vitest";
import {
  decisionTone,
  entryEdge,
  signedBps,
  signedQuote,
  unscoredReasons,
  winRatePercent,
  type PaperApiOrder,
  type PaperPerformanceSummary
} from "./performance.js";

const summary: PaperPerformanceSummary = {
  scoredCount: 4,
  unscoredCount: 7,
  pendingCount: 2,
  buyCount: 5,
  sellCount: 4,
  waitCount: 4,
  winCount: 3,
  meanDirectionalMarkoutBps: "12.345",
  unscoredReasonCounts: { WAIT_ACTION: 4, SOURCE_GAP: 1, INSUFFICIENT_SAMPLES: 2 }
};

const order = {
  orderId: "paper:test",
  action: "BUY",
  pair: "SOL-USDC",
  targetNotionalQuote: "10000",
  provider: "zeroex",
  executionMode: "paper",
  persistence: "postgres-side-011",
  recordedAtMs: 1,
  evidence: { signal: { verdict: { verdict: "BUY_BIAS" } } },
  markout: {
    decisionId: "paper:test",
    horizonMs: 300_000,
    referencePolicyVersion: "bitquery-wsol-usdc-robust-v1",
    dueAtMs: 2,
    status: "SCORED",
    directionalMarkoutBps: "10",
    directionalPnlQuote: "10",
    reason: null,
    computedAtMs: 3,
    entryReference: { status: "READY", evaluatedAtMs: 1, priceQuotePerSol: "100", sampleCount: 3, rejectedSampleCount: 0, reason: null },
    futureReference: { status: "READY", evaluatedAtMs: 2, priceQuotePerSol: "101", sampleCount: 4, rejectedSampleCount: 0, reason: null }
  }
} satisfies PaperApiOrder;

describe("shadow performance presentation", () => {
  it("uses scored directional decisions as the win-rate denominator", () => {
    expect(winRatePercent(summary)).toBe(75);
    expect(winRatePercent({ ...summary, scoredCount: 0, winCount: 0 })).toBeNull();
  });

  it("formats signed markout values and classifies outcomes", () => {
    expect(signedBps("10")).toBe("+10.00 BPS");
    expect(signedBps("-2.5")).toBe("-2.50 BPS");
    expect(signedQuote("10")).toBe("+$10.00");
    expect(signedQuote("-10")).toBe("−$10.00");
    expect(decisionTone(order)).toBe("win");
    expect(decisionTone({ ...order, markout: { ...order.markout, directionalMarkoutBps: "-1" } })).toBe("loss");
    expect(decisionTone({ ...order, markout: { ...order.markout, status: "UNSCORED", directionalMarkoutBps: null } })).toBe("unscored");
  });

  it("sorts explicit unscored reasons without mixing them into sample size", () => {
    expect(unscoredReasons(summary)).toEqual([
      { reason: "WAIT_ACTION", count: 4 },
      { reason: "INSUFFICIENT_SAMPLES", count: 2 },
      { reason: "SOURCE_GAP", count: 1 }
    ]);
    expect(summary.scoredCount).toBe(4);
  });

  it("uses the persisted entry verdict instead of the current market verdict", () => {
    expect(entryEdge(order)).toEqual({ label: "BUY EDGE", tone: "buy" });
    expect(entryEdge({ ...order, evidence: { signal: { verdict: { verdict: "SELL_BIAS" } } } }))
      .toEqual({ label: "SELL EDGE", tone: "sell" });
    expect(entryEdge({ ...order, evidence: { signal: { verdict: { verdict: "NO_EDGE" } } } }))
      .toEqual({ label: "NO EDGE", tone: "neutral" });
  });
});
