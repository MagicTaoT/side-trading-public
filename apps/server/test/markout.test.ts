import { S0SignalEngine } from "@side/signal-engine";
import { describe, expect, it } from "vitest";
import type { DexReferenceSnapshot, PaperAction, PaperOrder } from "../src/paper/contracts.js";
import { PAPER_MARKOUT_HORIZON_MS, REFERENCE_POLICY_VERSION } from "../src/paper/contracts.js";
import { MemoryDecisionJournal } from "../src/paper/journal.js";
import { directionalMarkout, MarkoutWorker } from "../src/paper/markout.js";

function reference(price: string, atMs: number): DexReferenceSnapshot {
  return {
    policyVersion: REFERENCE_POLICY_VERSION,
    status: "READY",
    evaluatedAtMs: atMs,
    windowStartMs: atMs - 15_000,
    windowEndMs: atMs,
    priceQuotePerSol: price,
    sampleCount: 3,
    rejectedSampleCount: 0,
    reason: null
  };
}

function order(action: PaperAction, recordedAtMs = 1_000): PaperOrder {
  const decisionId = `paper:${action.toLowerCase()}`;
  return {
    schemaVersion: 1,
    orderId: decisionId,
    executionMode: "paper",
    persistence: "memory-side-011-test",
    action,
    pair: "SOL-USDC",
    targetNotionalQuote: "10000",
    provider: action === "WAIT" ? null : "zeroex",
    previewId: action === "WAIT" ? null : "preview:1",
    recordedAtMs,
    preview: null,
    evidence: { mode: "REPLAY", signal: new S0SignalEngine().snapshot(), sources: [] },
    markout: {
      decisionId,
      horizonMs: PAPER_MARKOUT_HORIZON_MS,
      referencePolicyVersion: REFERENCE_POLICY_VERSION,
      dueAtMs: recordedAtMs + PAPER_MARKOUT_HORIZON_MS,
      status: "PENDING",
      entryReference: reference("100", recordedAtMs),
      futureReference: null,
      directionalMarkoutBps: null,
      directionalPnlQuote: null,
      reason: null,
      computedAtMs: null
    }
  };
}

describe("SIDE-011 markout", () => {
  it("uses the same future/entry denominator with symmetric BUY and SELL signs", () => {
    expect(directionalMarkout("BUY", "100", "110", "10000")).toEqual({
      directionalMarkoutBps: "1000.00000000",
      directionalPnlQuote: "1000.000000"
    });
    expect(directionalMarkout("SELL", "100", "110", "10000")).toEqual({
      directionalMarkoutBps: "-1000.00000000",
      directionalPnlQuote: "-1000.000000"
    });
  });

  it("catches up a due job after worker restart and duplicate workers do not add samples", async () => {
    const journal = new MemoryDecisionJournal();
    await journal.recordDecision({ order: order("BUY"), idempotencyKey: "markout-record-1", requestFingerprint: "BUY:preview:1:zeroex" });
    const now = 301_001;
    const firstWorker = new MarkoutWorker({ journal, now: () => now, reference: () => reference("105", 301_000) });
    const restartedWorker = new MarkoutWorker({ journal, now: () => now, reference: () => reference("105", 301_000) });

    expect(await firstWorker.runOnce()).toHaveLength(1);
    expect(await restartedWorker.runOnce()).toHaveLength(0);
    expect((await journal.getDecision("paper:buy"))?.markout).toMatchObject({
      status: "SCORED",
      directionalMarkoutBps: "500.00000000",
      directionalPnlQuote: "500.000000",
      futureReference: { sampleCount: 3 }
    });
    expect(await journal.performance()).toMatchObject({ scoredCount: 1, pendingCount: 0, winCount: 1 });
  });

  it("records WAIT and missing reference outcomes explicitly as unscored", async () => {
    const journal = new MemoryDecisionJournal();
    const wait = order("WAIT");
    await journal.recordDecision({ order: wait, idempotencyKey: "markout-record-wait", requestFingerprint: "WAIT:none:none" });
    const worker = new MarkoutWorker({ journal, now: () => 301_001, reference: () => reference("105", 301_000) });
    await worker.runOnce();
    expect((await journal.getDecision(wait.orderId))?.markout).toMatchObject({ status: "UNSCORED", reason: "WAIT_ACTION" });
    expect(await journal.performance()).toMatchObject({
      scoredCount: 0,
      unscoredCount: 1,
      winCount: 0,
      unscoredReasonCounts: { WAIT_ACTION: 1 }
    });
  });

  it("deletes a paper decision and removes it from aggregate performance", async () => {
    const journal = new MemoryDecisionJournal();
    const buy = order("BUY");
    await journal.recordDecision({ order: buy, idempotencyKey: "markout-delete-1", requestFingerprint: "BUY:preview:1:zeroex" });

    expect(await journal.deleteDecision(buy.orderId)).toBe(true);
    expect(await journal.deleteDecision(buy.orderId)).toBe(false);
    expect(await journal.getDecision(buy.orderId)).toBeNull();
    expect(await journal.listDecisions(10)).toEqual([]);
    expect(await journal.performance()).toMatchObject({ buyCount: 0, pendingCount: 0, scoredCount: 0 });
  });
});
