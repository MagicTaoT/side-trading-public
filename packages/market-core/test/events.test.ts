import { describe, expect, it } from "vitest";
import { parseMarketEvent, parseUiEvent } from "../src/index.js";

const base = {
  schemaVersion: 1,
  eventId: "coinbase:trade:42",
  ingestSeq: "42",
  source: {
    provider: "coinbase",
    channel: "market_trades",
    connectionGeneration: 1
  },
  venue: "coinbase",
  segment: "spot",
  instrumentId: "SOL-USD",
  base: "SOL",
  quote: "USD",
  occurredAtMs: 1_750_000_000_000,
  timeOrigin: "venue",
  sourceEventTimeRaw: "1750000000000000000",
  sourceEventTimeUnit: "ns",
  receivedAtUnixMs: 1_750_000_000_015,
  receivedMonoNs: "9000000015",
  quality: {
    state: "fresh",
    latencyMs: 15,
    outOfOrder: false,
    replay: false
  }
} as const;

describe("MarketEvent runtime contract", () => {
  it("accepts a valid discriminated trade event", () => {
    const event = parseMarketEvent({
      ...base,
      kind: "trade",
      payload: {
        px: "176.25",
        sizeNative: "2.5",
        sizeSOL: "2.5",
        aggressor: "buy",
        tradeId: "42"
      }
    });

    expect(event.kind).toBe("trade");
    if (event.kind === "trade") {
      expect(event.payload.aggressor).toBe("buy");
    }
  });

  it("rejects number amounts so precision cannot be silently lost", () => {
    expect(() =>
      parseMarketEvent({
        ...base,
        kind: "trade",
        payload: {
          px: 176.25,
          sizeNative: "2.5",
          sizeSOL: "2.5",
          aggressor: "buy"
        }
      })
    ).toThrow();
  });

  it("keeps Bitquery finality provider-indexed", () => {
    const event = parseMarketEvent({
      ...base,
      eventId: "bitquery:sig:0",
      source: { provider: "bitquery", channel: "solana-dextrades", connectionGeneration: 2 },
      venue: "solana-dex",
      segment: "dex-spot",
      instrumentId: "WSOL-USDC",
      quote: "USDC",
      timeOrigin: "block",
      kind: "onchain-swap",
      payload: {
        cluster: "mainnet-beta",
        signature: "sig",
        slot: "321",
        economicSwapIndex: 0,
        commitment: "provider-indexed",
        finalitySource: "provider",
        protocol: "Raydium",
        poolAddresses: ["pool"],
        inputMint: "USDC",
        outputMint: "WSOL",
        amountInAtomic: "10000000000",
        amountOutAtomic: "56710000000",
        side: "buy-sol",
        effectivePxQuotePerSol: "176.33574325",
        parserVersion: "bitquery-v1",
        parseQuality: {
          protocolDecoded: true,
          tokenBalancesReconciled: true,
          providerParsed: true,
          nativeSolAccounting: "not-applicable"
        },
        coverageGroup: "bitquery-decoded-wsol-usdc"
      }
    });

    expect(event.kind).toBe("onchain-swap");
    if (event.kind === "onchain-swap") {
      expect(event.payload.commitment).toBe("provider-indexed");
    }
  });
});

describe("UiEvent runtime contract", () => {
  it("accepts a valid visual batch", () => {
    const event = parseUiEvent({
      eventId: "ui:1",
      streamSeq: "1",
      stateVersion: "state-v1",
      sourceProvider: "coinbase",
      instrumentId: "SOL-USD",
      quoteAsset: "USD",
      zone: "cex-spot",
      venueLabel: "Coinbase",
      kind: "trade",
      changeDirection: "up",
      tradeSide: "buy",
      intensity: 2,
      count: 3,
      batchStartMs: 10,
      batchEndMs: 20,
      buyCount: 3,
      sellCount: 0,
      buyNotional: "528.75",
      label: "BUY ×3",
      quality: "fresh"
    });

    expect(event.count).toBe(3);
  });

  it("rejects zero-count visual events", () => {
    expect(() =>
      parseUiEvent({
        eventId: "ui:1",
        streamSeq: "1",
        stateVersion: "state-v1",
        sourceProvider: "coinbase",
        instrumentId: "SOL-USD",
        quoteAsset: "USD",
        zone: "cex-spot",
        venueLabel: "Coinbase",
        kind: "trade",
        changeDirection: "up",
        intensity: 1,
        count: 0,
        batchStartMs: 10,
        batchEndMs: 20,
        label: "trade",
        quality: "fresh"
      })
    ).toThrow();
  });
});
