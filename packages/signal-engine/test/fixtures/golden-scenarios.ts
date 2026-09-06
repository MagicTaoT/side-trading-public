import Decimal from "decimal.js";
import { parseMarketEvent, type MarketEvent } from "@side/market-core";
import { S0_SEGMENTS, type S0Segment } from "../../src/index.js";

type Direction = "buy" | "sell" | "neutral";

interface DraftEvent {
  atMs: number;
  order: number;
  build: (ingestSeq: string) => MarketEvent;
}

interface SegmentIdentity {
  provider: "coinbase" | "coinbase-derivatives" | "bitquery" | "hyperliquid";
  venue: "coinbase" | "coinbase-derivatives" | "solana-dex" | "hyperliquid";
  segment: "spot" | "perp" | "dex-spot";
  instrumentId: string;
  quote: "USD" | "USDC";
}

const identity: Record<S0Segment, SegmentIdentity> = {
  "cex-spot": {
    provider: "coinbase",
    venue: "coinbase",
    segment: "spot",
    instrumentId: "SOL-USD",
    quote: "USD"
  },
  "cex-perp": {
    provider: "coinbase-derivatives",
    venue: "coinbase-derivatives",
    segment: "perp",
    instrumentId: "SLP",
    quote: "USD"
  },
  "dex-spot": {
    provider: "bitquery",
    venue: "solana-dex",
    segment: "dex-spot",
    instrumentId: "WSOL-USDC",
    quote: "USDC"
  },
  "defi-perp": {
    provider: "hyperliquid",
    venue: "hyperliquid",
    segment: "perp",
    instrumentId: "SOL",
    quote: "USD"
  }
};

const segmentOrder: Record<S0Segment, number> = {
  "cex-spot": 0,
  "cex-perp": 1,
  "dex-spot": 2,
  "defi-perp": 3
};

function common(segment: S0Segment, atMs: number, ingestSeq: string, eventId: string) {
  const source = identity[segment];
  return {
    schemaVersion: 1 as const,
    eventId,
    ingestSeq,
    source: {
      provider: source.provider,
      channel: source.segment === "dex-spot" ? "solana-dextrades" : "golden",
      connectionGeneration: 1
    },
    venue: source.venue,
    segment: source.segment,
    instrumentId: source.instrumentId,
    base: "SOL" as const,
    quote: source.quote,
    occurredAtMs: atMs,
    timeOrigin: source.segment === "dex-spot" ? ("block" as const) : ("venue" as const),
    sourceEventTimeRaw: String(atMs),
    sourceEventTimeUnit: "ms" as const,
    receivedAtUnixMs: atMs,
    receivedMonoNs: (BigInt(atMs) * 1_000_000n).toString(),
    quality: {
      state: "fresh" as const,
      latencyMs: 0,
      outOfOrder: false,
      replay: true
    }
  };
}

function bboDraft(segment: Exclude<S0Segment, "dex-spot">, atMs: number, mid: string, order: number): DraftEvent {
  return {
    atMs,
    order,
    build: (ingestSeq) => {
      const center = new Decimal(mid);
      return parseMarketEvent({
        ...common(segment, atMs, ingestSeq, `${segment}:bbo:${atMs}`),
        kind: "bbo",
        payload: {
          bidPx: center.minus("0.01").toFixed(2),
          bidSizeNative: "100",
          bidSizeSOL: "100",
          askPx: center.plus("0.01").toFixed(2),
          askSizeNative: "100",
          askSizeSOL: "100"
        }
      });
    }
  };
}

function tradeDraft(
  segment: Exclude<S0Segment, "dex-spot">,
  atMs: number,
  side: "buy" | "sell",
  order: number
): DraftEvent {
  return {
    atMs,
    order,
    build: (ingestSeq) =>
      parseMarketEvent({
        ...common(segment, atMs, ingestSeq, `${segment}:trade:${side}:${order}`),
        kind: "trade",
        payload: {
          px: "176.00",
          sizeNative: "10",
          sizeSOL: "10",
          aggressor: side,
          tradeId: `${segment}:${side}:${order}`
        }
      })
  };
}

function swapDraft(atMs: number, side: "buy" | "sell", price: string, notional: string, order: number): DraftEvent {
  return {
    atMs,
    order,
    build: (ingestSeq) => {
      const stableAtomic = new Decimal(notional).mul(1_000_000).toFixed(0);
      const solAtomic = new Decimal(notional).div(price).mul(1_000_000_000).floor().toFixed(0);
      return parseMarketEvent({
        ...common("dex-spot", atMs, ingestSeq, `dex-spot:swap:${side}:${order}`),
        protocol: "Raydium",
        kind: "onchain-swap",
        payload: {
          cluster: "mainnet-beta",
          signature: `signature-${atMs}-${side}-${order}`,
          slot: String(321_000_000 + order),
          economicSwapIndex: 0,
          commitment: "provider-indexed",
          finalitySource: "provider",
          protocol: "Raydium",
          poolAddresses: ["golden-pool"],
          inputMint: side === "buy" ? "USDC" : "WSOL",
          outputMint: side === "buy" ? "WSOL" : "USDC",
          amountInAtomic: side === "buy" ? stableAtomic : solAtomic,
          amountOutAtomic: side === "buy" ? solAtomic : stableAtomic,
          side: side === "buy" ? "buy-sol" : "sell-sol",
          effectivePxQuotePerSol: price,
          parserVersion: "golden-v1",
          parseQuality: {
            protocolDecoded: true,
            tokenBalancesReconciled: true,
            providerParsed: true,
            nativeSolAccounting: "not-applicable"
          },
          coverageGroup: "bitquery-decoded-wsol-usdc"
        }
      });
    }
  };
}

function directionalDrafts(segment: S0Segment, direction: Direction, baseAtMs: number): DraftEvent[] {
  const order = segmentOrder[segment] * 10;
  const currentPrice = direction === "buy" ? "176.10" : direction === "sell" ? "175.90" : "176.00";

  if (segment === "dex-spot") {
    const drafts = [swapDraft(baseAtMs, "buy", "176.00", "2000", order)];
    if (direction === "neutral") {
      drafts.push(
        swapDraft(baseAtMs + 30_000, "buy", currentPrice, "1000", order + 1),
        swapDraft(baseAtMs + 30_000, "sell", currentPrice, "1000", order + 2)
      );
    } else {
      drafts.push(swapDraft(baseAtMs + 30_000, direction, currentPrice, "2000", order + 1));
    }
    return drafts;
  }

  const drafts: DraftEvent[] = [bboDraft(segment, baseAtMs, "176.00", order)];
  if (direction === "neutral") {
    drafts.push(
      tradeDraft(segment, baseAtMs + 29_000, "buy", order + 1),
      tradeDraft(segment, baseAtMs + 29_000, "sell", order + 2)
    );
  } else {
    drafts.push(tradeDraft(segment, baseAtMs + 29_000, direction, order + 1));
  }
  drafts.push(bboDraft(segment, baseAtMs + 30_000, currentPrice, order + 3));
  return drafts;
}

export function sourceHealthEvent(
  segment: S0Segment,
  atMs: number,
  ingestSeq: string,
  connection: "connecting" | "live" | "reconnecting" | "closed",
  quality: "fresh" | "degraded" | "stale" | "gap"
): MarketEvent {
  return parseMarketEvent({
    ...common(segment, atMs, ingestSeq, `${segment}:health:${connection}:${ingestSeq}`),
    quality: { state: quality, latencyMs: 0, outOfOrder: false, replay: true },
    kind: "source-health",
    payload: {
      connection,
      transportLastSeenAtMs: atMs,
      stateLastChangedAtMs: atMs,
      ...(quality === "gap" ? { gapReason: "golden gap" } : {})
    }
  });
}

export function buildScenario(directions: Record<S0Segment, Direction>, baseAtMs = 1_750_000_000_000): MarketEvent[] {
  const drafts = S0_SEGMENTS.flatMap((segment) => directionalDrafts(segment, directions[segment], baseAtMs));
  return drafts
    .sort((left, right) => left.atMs - right.atMs || left.order - right.order)
    .map((draft, index) => draft.build(String(index + 1)));
}

export const goldenScenarios = {
  "spot-led": buildScenario({
    "cex-spot": "buy",
    "cex-perp": "buy",
    "dex-spot": "buy",
    "defi-perp": "neutral"
  }),
  "leverage-heavy": buildScenario({
    "cex-spot": "sell",
    "cex-perp": "sell",
    "dex-spot": "neutral",
    "defi-perp": "sell"
  }),
  disagreement: buildScenario({
    "cex-spot": "buy",
    "cex-perp": "sell",
    "dex-spot": "buy",
    "defi-perp": "sell"
  })
} as const;

const staleBase = buildScenario({
  "cex-spot": "buy",
  "cex-perp": "buy",
  "dex-spot": "buy",
  "defi-perp": "buy"
});
const staleAtMs = staleBase.at(-1)?.receivedAtUnixMs ?? 1_750_000_030_000;
export const staleScenario = [
  ...staleBase,
  sourceHealthEvent("cex-spot", staleAtMs + 1_000, String(staleBase.length + 1), "closed", "stale"),
  sourceHealthEvent("dex-spot", staleAtMs + 1_000, String(staleBase.length + 2), "live", "gap")
];
