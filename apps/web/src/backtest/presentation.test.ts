import { describe, expect, it } from "vitest";
import type { BacktestVariant } from "./contracts.js";
import { equityPolyline, experimentProgress, parseGridValues, rankCompletedVariants } from "./presentation.js";

function variant(id: string, pnl: string, drawdown: string): BacktestVariant {
  return {
    variantId: id,
    ordinal: 1,
    status: "COMPLETED",
    config: {
      schemaVersion: 1,
      name: id,
      pair: "SOL-USDC",
      entry: { minEdgeBps: "3", holdSec: 5, initialSizeQuote: "1000" },
      scaling: { enabled: false, intervalSec: 0, intervalMultiplier: "1", sizeQuote: "500", sizeMultiplier: "1", maxEntries: 1, maxTotalSizeQuote: "1000" },
      exit: { takeProfitBps: "12", linearDecayToZero: false, stopLossBps: "15", forceExitSec: 180 },
      cooldownSec: 15
    },
    configSha256: id.padEnd(64, "0"),
    startedAtMs: 1,
    completedAtMs: 2,
    resultId: `result:${id}`,
    resultSha256: id.padEnd(64, "1"),
    summary: {
      observationCount: 10, readyObservationCount: 10, coverageRatio: "1", basketCount: 1, closedBasketCount: 1,
      openBasketCount: 0, winCount: Number(Number(pnl) > 0), lossCount: Number(Number(pnl) < 0), flatCount: Number(Number(pnl) === 0),
      entryFillCount: 1, totalEntryNotionalQuote: "1000", maxCapitalQuote: "1000", closedPnlQuote: pnl,
      openPnlQuote: "0", totalTheoreticalPnlQuote: pnl, averageClosedPnlQuote: pnl, returnOnMaxCapitalBps: pnl,
      maxDrawdownQuote: drawdown, exitReasonCounts: { TAKE_PROFIT: 1, STOP_LOSS: 0, FORCE_EXIT: 0, MANUAL_STOP: 0 }
    },
    error: null
  };
}

describe("backtest presentation", () => {
  it("parses decimal, integer, and boolean grid values", () => {
    expect(parseGridValues("entry.minEdgeBps", "2, 3.5")).toEqual(["2", "3.5"]);
    expect(parseGridValues("entry.holdSec", "3, 5")).toEqual([3, 5]);
    expect(parseGridValues("scaling.enabled", "true, false")).toEqual([true, false]);
    expect(() => parseGridValues("exit.forceExitSec", "1.5")).toThrow("whole numbers");
  });

  it("ranks completed variants by PnL and then lower drawdown", () => {
    expect(rankCompletedVariants([variant("a", "10", "5"), variant("b", "12", "9"), variant("c", "12", "4")]).map(({ variantId }) => variantId)).toEqual(["c", "b", "a"]);
  });

  it("maps equity to a stable SVG polyline and reports progress", () => {
    const points = equityPolyline([
      { atMs: 0, equityQuote: "-10", closedPnlQuote: "-10", openPnlQuote: "0" },
      { atMs: 5, equityQuote: "0", closedPnlQuote: "0", openPnlQuote: "0" },
      { atMs: 10, equityQuote: "10", closedPnlQuote: "10", openPnlQuote: "0" }
    ], 100, 100, 10);
    expect(points).toBe("10.00,90.00 50.00,50.00 90.00,10.00");
    expect(experimentProgress(3, 1, 8)).toBe(50);
  });
});
