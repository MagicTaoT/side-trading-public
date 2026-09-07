import { describe, expect, it } from "vitest";
import type { StrategyBasketRecord, StrategyBasketSnapshot } from "./contracts.js";
import { pnlTone, signedQuote, summarizeStrategyBaskets } from "./presentation.js";

function basket(sequence: number, status: StrategyBasketRecord["status"], pnl: string | null, notional: string, entries: number): StrategyBasketRecord {
  const snapshot = {
    basketSequence: sequence,
    direction: sequence % 2 === 0 ? "SELL" : "BUY",
    status,
    openedAtMs: 1,
    closedAtMs: status === "CLOSED" ? 2 : null,
    entries: Array.from({ length: entries }, (_, index) => ({ sequence: index + 1 })),
    exitFill: null,
    totalQuoteNotional: notional,
    totalBaseQuantity: "1",
    averageEntryPrice: "100",
    currentPrice: "101",
    currentReferenceSource: "test",
    grossPnlBps: pnl,
    grossPnlQuote: pnl,
    currentTargetProfitBps: "0",
    exitReason: status === "CLOSED" ? "TAKE_PROFIT" : null,
    nextEntryQualificationSinceMs: null,
    nextEntryDueAtMs: null
  } as StrategyBasketSnapshot;
  return { basketId: `basket-${sequence}`, runId: "run-1", basketSequence: sequence, direction: snapshot.direction, status, openedAtMs: 1, updatedAtMs: 2, closedAtMs: snapshot.closedAtMs, snapshot };
}

describe("strategy run presentation", () => {
  it("separates closed PnL from open mark-to-market and totals both", () => {
    expect(summarizeStrategyBaskets([
      basket(1, "CLOSED", "12.50", "1000", 2),
      basket(2, "CLOSED", "-4.25", "500", 1),
      basket(3, "OPEN", "1.75", "750", 3),
      basket(4, "EXIT_PENDING_PRICE", null, "250", 1)
    ])).toEqual({
      totalPnlQuote: 10,
      closedPnlQuote: 8.25,
      openMtmQuote: 1.75,
      totalNotionalQuote: 2500,
      closedBaskets: 2,
      openBaskets: 2,
      unpricedBasketCount: 1,
      wins: 1,
      losses: 1,
      flats: 0,
      entryFills: 7
    });
  });

  it("formats signed USDC values and tones", () => {
    expect(signedQuote(10)).toBe("+$10.00");
    expect(signedQuote("-2.5")).toBe("−$2.50");
    expect(signedQuote(null)).toBe("—");
    expect(pnlTone("0")).toBe("flat");
    expect(pnlTone("1")).toBe("positive");
    expect(pnlTone("-1")).toBe("negative");
  });
});
