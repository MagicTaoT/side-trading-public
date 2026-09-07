import type { StrategyBasketRecord } from "./contracts.js";

export interface StrategyBasketSummary {
  totalPnlQuote: number;
  closedPnlQuote: number;
  openMtmQuote: number;
  totalNotionalQuote: number;
  closedBaskets: number;
  openBaskets: number;
  unpricedBasketCount: number;
  wins: number;
  losses: number;
  flats: number;
  entryFills: number;
}

function finite(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function summarizeStrategyBaskets(baskets: StrategyBasketRecord[]): StrategyBasketSummary {
  const summary: StrategyBasketSummary = {
    totalPnlQuote: 0,
    closedPnlQuote: 0,
    openMtmQuote: 0,
    totalNotionalQuote: 0,
    closedBaskets: 0,
    openBaskets: 0,
    unpricedBasketCount: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    entryFills: 0
  };

  for (const basket of baskets) {
    const pnl = finite(basket.snapshot.grossPnlQuote);
    const notional = finite(basket.snapshot.totalQuoteNotional);
    summary.totalNotionalQuote += notional ?? 0;
    summary.entryFills += basket.snapshot.entries.length;

    if (pnl === null) summary.unpricedBasketCount += 1;
    else summary.totalPnlQuote += pnl;

    if (basket.status === "CLOSED") {
      summary.closedBaskets += 1;
      summary.closedPnlQuote += pnl ?? 0;
      if (pnl !== null && pnl > 0) summary.wins += 1;
      else if (pnl !== null && pnl < 0) summary.losses += 1;
      else if (pnl !== null) summary.flats += 1;
    } else {
      summary.openBaskets += 1;
      summary.openMtmQuote += pnl ?? 0;
    }
  }

  return summary;
}

export function signedQuote(value: string | number | null): string {
  const parsed = finite(value);
  if (parsed === null) return "—";
  return `${parsed >= 0 ? "+" : "−"}$${Math.abs(parsed).toFixed(2)}`;
}

export function pnlTone(value: string | number | null): "positive" | "negative" | "flat" {
  const parsed = finite(value);
  if (parsed === null || parsed === 0) return "flat";
  return parsed > 0 ? "positive" : "negative";
}
