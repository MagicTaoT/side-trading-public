export type PaperAction = "BUY" | "SELL" | "WAIT";
export type PaperProvider = "zeroex" | "jupiter";
export type PaperEntryVerdict = "BUY_BIAS" | "SELL_BIAS" | "NO_EDGE" | "INSUFFICIENT_DATA";

export interface PaperReferenceSnapshot {
  status: "READY" | "UNAVAILABLE";
  evaluatedAtMs: number;
  priceQuotePerSol: string | null;
  sampleCount: number;
  rejectedSampleCount: number;
  reason: string | null;
}

export interface PaperApiOrder {
  orderId: string;
  action: PaperAction;
  pair: "SOL-USDC";
  targetNotionalQuote: "10000";
  provider: PaperProvider | null;
  executionMode: "paper";
  persistence: "postgres-side-011" | "memory-side-011-test";
  recordedAtMs: number;
  evidence: {
    signal: {
      verdict: {
        verdict: PaperEntryVerdict;
      };
    };
  };
  markout: {
    decisionId: string;
    horizonMs: 300_000;
    referencePolicyVersion: string;
    dueAtMs: number;
    status: "PENDING" | "SCORED" | "UNSCORED";
    directionalMarkoutBps: string | null;
    directionalPnlQuote: string | null;
    reason: string | null;
    computedAtMs: number | null;
    entryReference: PaperReferenceSnapshot;
    futureReference: PaperReferenceSnapshot | null;
  };
}

export interface PaperPerformanceSummary {
  scoredCount: number;
  unscoredCount: number;
  pendingCount: number;
  buyCount: number;
  sellCount: number;
  waitCount: number;
  winCount: number;
  meanDirectionalMarkoutBps: string | null;
  unscoredReasonCounts: Record<string, number>;
}

export function winRatePercent(summary: PaperPerformanceSummary): number | null {
  return summary.scoredCount === 0 ? null : summary.winCount / summary.scoredCount * 100;
}

export function signedBps(value: string | null): string {
  if (value === null) return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return `${parsed >= 0 ? "+" : ""}${parsed.toFixed(2)} BPS`;
}

export function signedQuote(value: string | null): string {
  if (value === null) return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return `${parsed >= 0 ? "+" : "−"}$${Math.abs(parsed).toFixed(2)}`;
}

export function decisionTone(order: PaperApiOrder): "pending" | "unscored" | "win" | "loss" | "flat" {
  if (order.markout.status === "PENDING") return "pending";
  if (order.markout.status === "UNSCORED") return "unscored";
  const bps = Number(order.markout.directionalMarkoutBps ?? 0);
  if (bps > 0) return "win";
  if (bps < 0) return "loss";
  return "flat";
}

export function entryEdge(order: PaperApiOrder): { label: string; tone: "buy" | "sell" | "neutral" | "warning" } {
  const verdict = order.evidence.signal.verdict.verdict;
  if (verdict === "BUY_BIAS") return { label: "BUY EDGE", tone: "buy" };
  if (verdict === "SELL_BIAS") return { label: "SELL EDGE", tone: "sell" };
  if (verdict === "NO_EDGE") return { label: "NO EDGE", tone: "neutral" };
  return { label: "INSUFFICIENT DATA", tone: "warning" };
}

export function unscoredReasons(summary: PaperPerformanceSummary): Array<{ reason: string; count: number }> {
  return Object.entries(summary.unscoredReasonCounts)
    .filter(([, count]) => Number.isSafeInteger(count) && count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason, count]) => ({ reason, count }));
}
