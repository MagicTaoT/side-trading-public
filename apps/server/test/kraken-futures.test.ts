import { parseMarketEvent } from "@side/market-core";
import { describe, expect, it } from "vitest";
import { KrakenFuturesDecoder } from "../src/live/kraken-futures.js";

function parseDrafts(drafts: Record<string, unknown>[]) {
  return drafts.map((draft, index) => parseMarketEvent({ ...draft, ingestSeq: String(index + 1) }));
}

describe("Kraken Futures decoder", () => {
  it("maps Kraken trade side as the taker aggressor and ignores the historical snapshot", () => {
    const decoder = new KrakenFuturesDecoder();
    expect(decoder.decode({ feed: "trade_snapshot", product_id: "PF_SOLUSD", trades: [] }, 1)).toEqual([]);

    const [event] = parseDrafts(decoder.decode({
      feed: "trade",
      product_id: "PF_SOLUSD",
      uid: "f9fd2e",
      side: "buy",
      type: "fill",
      seq: 22,
      time: 1_750_000_000_000,
      qty: 3.25,
      price: 176.5
    }, 4, 1_750_000_000_012));

    expect(event).toMatchObject({
      eventId: "kraken-futures:trade:f9fd2e",
      source: { provider: "kraken-futures", channel: "trade", connectionGeneration: 4 },
      venue: "kraken-futures",
      segment: "perp",
      instrumentId: "PF_SOLUSD",
      kind: "trade",
      cursor: { last: "22" },
      payload: { px: "176.5", sizeNative: "3.25", sizeSOL: "3.25", aggressor: "buy" }
    });
  });

  it("builds BBO from snapshot and enforces continuous book sequence", () => {
    const decoder = new KrakenFuturesDecoder();
    const [snapshot] = parseDrafts(decoder.decode({
      feed: "book_snapshot",
      product_id: "PF_SOLUSD",
      timestamp: 1_750_000_000_000,
      seq: 100,
      bids: [{ price: 176, qty: 10 }, { price: 175.9, qty: 20 }],
      asks: [{ price: 176.1, qty: 12 }, { price: 176.2, qty: 30 }]
    }, 1, 1_750_000_000_005));
    expect(snapshot).toMatchObject({
      kind: "bbo",
      cursor: { last: "100", snapshot: true },
      payload: { bidPx: "176", bidSizeSOL: "10", askPx: "176.1", askSizeSOL: "12" }
    });

    expect(decoder.decode({
      feed: "book", product_id: "PF_SOLUSD", timestamp: 1_750_000_000_001,
      seq: 101, side: "buy", price: 175.9, qty: 21
    }, 1)).toEqual([]);
    const [next] = parseDrafts(decoder.decode({
      feed: "book", product_id: "PF_SOLUSD", timestamp: 1_750_000_000_002,
      seq: 102, side: "sell", price: 176.05, qty: 4
    }, 1, 1_750_000_000_007));
    expect(next).toMatchObject({
      kind: "bbo",
      cursor: { last: "102", snapshot: false },
      payload: { bidPx: "176", askPx: "176.05", askSizeSOL: "4" }
    });

    expect(() => decoder.decode({
      feed: "book", product_id: "PF_SOLUSD", timestamp: 1_750_000_000_003,
      seq: 104, side: "buy", price: 176, qty: 9
    }, 1)).toThrow(/book_gap:102->104/u);
  });

  it("emits mark, predicted funding, and open interest from ticker updates", () => {
    const decoder = new KrakenFuturesDecoder();
    const message = {
      feed: "ticker",
      product_id: "PF_SOLUSD",
      time: 1_750_000_000_000,
      markPrice: 176.25,
      index: 176.2,
      relative_funding_rate_prediction: -0.0000125,
      next_funding_rate_time: 1_750_003_600_000,
      openInterest: 281234
    };
    const events = parseDrafts(decoder.decode(message, 2, 1_750_000_000_010));
    expect(events.map(({ kind }) => kind)).toEqual(["mark", "funding", "open-interest"]);
    expect(events[0]).toMatchObject({ payload: { markPx: "176.25", indexPx: "176.2" } });
    expect(events[1]).toMatchObject({
      payload: {
        fundingRate: "-0.0000125",
        fundingIntervalMs: 3_600_000,
        nextFundingTs: 1_750_003_600_000,
        semantics: "predicted"
      }
    });
    expect(events[2]).toMatchObject({ payload: { oiNative: "281234", oiSOL: "281234", contractValueSOL: "1" } });
    expect(decoder.decode(message, 2, 1_750_000_000_020)).toEqual([]);
  });
});
