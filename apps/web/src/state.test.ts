import { describe, expect, it } from "vitest";
import type { UiEvent } from "@side/market-core";
import {
  BITQUERY_MATERIAL_NOTIONAL,
  BITQUERY_VISUAL_BUCKET_MS,
  bubbleAgeOpacity,
  bubbleVisualKey,
  clampedVolumeShare,
  mergeUiEvent,
  microBatchBubbleEvents,
  microBatchUiEvents,
  pruneUiEvents,
  seededVisual
} from "./state.js";

const event: UiEvent = {
  eventId: "coinbase:trade:100",
  streamSeq: "100",
  stateVersion: "ingest-100",
  sourceProvider: "coinbase",
  instrumentId: "SOL-USD",
  quoteAsset: "USD",
  zone: "cex-spot",
  venueLabel: "coinbase",
  kind: "trade",
  changeDirection: "up",
  tradeSide: "buy",
  signalPolarity: "not-applicable",
  intensity: 1,
  count: 1,
  batchStartMs: 1_000,
  batchEndMs: 1_000,
  buyCount: 1,
  sellCount: 0,
  label: "coinbase trade",
  quality: "fresh"
};

describe("clampedVolumeShare", () => {
  it("maps volume to a readable half-point layout share", () => {
    expect(clampedVolumeShare(60, 40, 35, 65)).toBe(60);
    expect(clampedVolumeShare(1, 99, 35, 65)).toBe(35);
    expect(clampedVolumeShare(99, 1, 35, 65)).toBe(65);
    expect(clampedVolumeShare(0, 0, 35, 65)).toBe(50);
    expect(clampedVolumeShare(10, 23, 30, 70)).toBe(30.5);
  });
});

describe("mergeUiEvent", () => {
  it("is idempotent when a REST snapshot races the same WebSocket event", () => {
    const duplicate = mergeUiEvent([event], event);

    expect(duplicate).toEqual({ events: [event], added: false });
  });

  it("keeps trade bubbles even when the bounded state-event history is full", () => {
    const next = { ...event, eventId: "coinbase:trade:101", streamSeq: "101" };
    const merged = mergeUiEvent([event], next, 1);

    expect(merged).toEqual({ events: [event, next], added: true });
  });

  it("retains an independent bounded state-event history for each market zone", () => {
    const bbo = { ...event, eventId: "coinbase:bbo:1", kind: "bbo" as const, tradeSide: "unknown" as const };
    const dex = { ...bbo, eventId: "bitquery:quote:1", streamSeq: "101", sourceProvider: "bitquery" as const, zone: "dex-spot" as const };
    const nextSpot = { ...bbo, eventId: "coinbase:bbo:2", streamSeq: "102" };

    expect(mergeUiEvent([bbo, dex], nextSpot, 1).events).toEqual([dex, nextSpot]);
  });

  it("expires an event only after its five-minute window has passed", () => {
    expect(pruneUiEvents([event], 300_999)).toEqual([event]);
    expect(pruneUiEvents([event], 301_000)).toEqual([]);
  });

  it("supports shorter visual windows without changing the stored event", () => {
    expect(pruneUiEvents([event], 30_999, 30_000)).toEqual([event]);
    expect(pruneUiEvents([event], 31_000, 30_000)).toEqual([]);
    expect(pruneUiEvents([event], 61_000, 60_000)).toEqual([]);
    expect(event.batchEndMs).toBe(1_000);
  });
});

describe("microBatchUiEvents", () => {
  it("combines same-bucket events inside 75ms without netting away side detail", () => {
    const sell: UiEvent = {
      ...event,
      eventId: "coinbase:trade:101",
      streamSeq: "101",
      batchStartMs: 1_050,
      batchEndMs: 1_050,
      changeDirection: "down",
      tradeSide: "sell",
      buyCount: 0,
      sellCount: 2,
      sellNotional: "600.00",
      maxNotional: "400.00",
      minPx: "175.90",
      maxPx: "176.00",
      count: 2
    };
    const buy: UiEvent = {
      ...event,
      buyNotional: "528.75",
      maxNotional: "528.75",
      minPx: "176.25",
      maxPx: "176.25"
    };
    const [batch] = microBatchUiEvents([buy, sell]);

    expect(batch).toMatchObject({
      count: 3,
      buyCount: 1,
      sellCount: 2,
      buyNotional: "528.75",
      sellNotional: "600.00",
      maxNotional: "528.75",
      minPx: "175.9",
      maxPx: "176.25",
      changeDirection: "flat",
      tradeSide: "unknown"
    });
  });

  it("does not merge different venues or events outside the window", () => {
    const otherVenue = { ...event, eventId: "bitquery:1", sourceProvider: "bitquery" as const, venueLabel: "Raydium" };
    const later = { ...event, eventId: "coinbase:2", batchStartMs: 1_076, batchEndMs: 1_076 };

    expect(microBatchUiEvents([event, otherVenue, later])).toHaveLength(3);
  });
});

describe("seededVisual", () => {
  it("returns deterministic bounded motion geometry", () => {
    expect(seededVisual(event)).toEqual(seededVisual(event));
    expect(seededVisual(event).xPercent).toBeGreaterThanOrEqual(6);
    expect(seededVisual(event).xPercent).toBeLessThanOrEqual(94);
    expect(seededVisual(event).yPercent).toBeGreaterThanOrEqual(12);
    expect(seededVisual(event).yPercent).toBeLessThanOrEqual(88);
    expect(seededVisual(event).diameterPx).toBeGreaterThanOrEqual(22);
    expect(seededVisual(event).diameterPx).toBeLessThanOrEqual(72);
  });

  it("decorrelates similar event ids and fills the bubble field", () => {
    const points = Array.from({ length: 240 }, (_, index) => seededVisual({
      ...event,
      eventId: `visual:bitquery:dex-spot:bitquery:SOL-USD:USD:onchain-swap:buy:${1_800_000 + index}`
    }));
    const xs = points.map(({ xPercent }) => xPercent);
    const ys = points.map(({ yPercent }) => yPercent);
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    const covariance = points.reduce((sum, point) => sum + (point.xPercent - meanX) * (point.yPercent - meanY), 0);
    const spreadX = Math.sqrt(xs.reduce((sum, value) => sum + (value - meanX) ** 2, 0));
    const spreadY = Math.sqrt(ys.reduce((sum, value) => sum + (value - meanY) ** 2, 0));
    const correlation = covariance / (spreadX * spreadY);

    expect(Math.abs(correlation)).toBeLessThan(0.2);
    expect(Math.min(...xs)).toBeLessThan(10);
    expect(Math.max(...xs)).toBeGreaterThan(90);
    expect(Math.min(...ys)).toBeLessThan(16);
    expect(Math.max(...ys)).toBeGreaterThan(84);
  });

  it("keeps a bubble identity stable while its micro-batch is updated", () => {
    const updated = { ...event, streamSeq: "101", count: 2, batchEndMs: 1_050 };
    expect(bubbleVisualKey(updated)).toBe(bubbleVisualKey(event));
  });

  it("fades a bubble gradually across the five-minute window", () => {
    expect(bubbleAgeOpacity(event, event.batchEndMs)).toBeCloseTo(0.85);
    expect(bubbleAgeOpacity(event, event.batchEndMs + 75_000)).toBeCloseTo(0.575);
    expect(bubbleAgeOpacity(event, event.batchEndMs + 150_000)).toBeCloseTo(0.3);
    expect(bubbleAgeOpacity(event, event.batchEndMs + 225_000)).toBeCloseTo(0.2);
    expect(bubbleAgeOpacity(event, event.batchEndMs + 300_000)).toBeCloseTo(0.1);
  });

  it("scales the same fade curve proportionally to the selected window", () => {
    expect(bubbleAgeOpacity(event, event.batchEndMs, 30_000)).toBeCloseTo(0.85);
    expect(bubbleAgeOpacity(event, event.batchEndMs + 7_500, 30_000)).toBeCloseTo(0.575);
    expect(bubbleAgeOpacity(event, event.batchEndMs + 15_000, 30_000)).toBeCloseTo(0.3);
    expect(bubbleAgeOpacity(event, event.batchEndMs + 22_500, 30_000)).toBeCloseTo(0.2);
    expect(bubbleAgeOpacity(event, event.batchEndMs + 30_000, 30_000)).toBeCloseTo(0.1);
  });
});

describe("microBatchBubbleEvents", () => {
  it("updates an existing side-specific bubble across interleaved state events", () => {
    const bbo = { ...event, eventId: "coinbase:bbo:1", streamSeq: "101", kind: "bbo" as const, tradeSide: "unknown" as const, batchStartMs: 1_020, batchEndMs: 1_020 };
    const secondBuy = { ...event, eventId: "coinbase:trade:102", streamSeq: "102", batchStartMs: 1_050, batchEndMs: 1_050 };
    const sell = { ...event, eventId: "coinbase:trade:103", streamSeq: "103", tradeSide: "sell" as const, buyCount: 0, sellCount: 1, batchStartMs: 1_060, batchEndMs: 1_060 };

    const bubbles = microBatchBubbleEvents([event, bbo, secondBuy, sell]);

    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toMatchObject({ eventId: event.eventId, streamSeq: "102", count: 2, tradeSide: "buy" });
    expect(bubbles[1]).toMatchObject({ eventId: sell.eventId, tradeSide: "sell" });
  });

  it("compresses sub-$1k Bitquery swaps into fixed one-second side buckets across DEX protocols", () => {
    const first: UiEvent = {
      ...event,
      eventId: "bitquery:swap:first",
      sourceProvider: "bitquery",
      zone: "dex-spot",
      venueLabel: "raydium_amm",
      kind: "onchain-swap",
      buyNotional: "40.00",
      maxNotional: "40.00"
    };
    const second: UiEvent = {
      ...first,
      eventId: "bitquery:swap:second",
      streamSeq: "101",
      venueLabel: "jupiter",
      batchStartMs: 1_900,
      batchEndMs: 1_900,
      buyNotional: "50.00",
      maxNotional: "50.00"
    };
    const material: UiEvent = {
      ...second,
      eventId: "bitquery:swap:material",
      streamSeq: "102",
      batchStartMs: 1_950,
      batchEndMs: 1_950,
      buyNotional: BITQUERY_MATERIAL_NOTIONAL.toFixed(2),
      maxNotional: BITQUERY_MATERIAL_NOTIONAL.toFixed(2)
    };
    const nextBucket: UiEvent = {
      ...first,
      eventId: "bitquery:swap:next",
      streamSeq: "103",
      batchStartMs: BITQUERY_VISUAL_BUCKET_MS * 2,
      batchEndMs: BITQUERY_VISUAL_BUCKET_MS * 2
    };
    const sell: UiEvent = {
      ...second,
      eventId: "bitquery:swap:sell",
      streamSeq: "104",
      tradeSide: "sell",
      changeDirection: "down",
      buyCount: 0,
      sellCount: 1,
      buyNotional: undefined,
      sellNotional: "25.00",
      maxNotional: "25.00"
    };

    const bubbles = microBatchBubbleEvents([first, second, material, nextBucket, sell]);
    const aggregated = bubbles[0] as UiEvent;
    const nextAggregate = bubbles[2] as UiEvent;

    expect(bubbles).toHaveLength(4);
    expect(aggregated).toMatchObject({
      eventId: expect.stringContaining("visual:bitquery:"),
      venueLabel: "DEX FLOW",
      count: 2,
      buyCount: 2,
      buyNotional: "90.00",
      maxNotional: "50.00",
      batchEndMs: 1_900
    });
    expect(bubbles[1]).toMatchObject({ eventId: material.eventId, count: 1, maxNotional: "1000.00" });
    expect(nextAggregate.eventId).not.toBe(aggregated.eventId);
    expect(bubbles[3]).toMatchObject({ tradeSide: "sell", count: 1, sellNotional: "25.00" });
  });
});
