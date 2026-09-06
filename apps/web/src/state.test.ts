import { describe, expect, it } from "vitest";
import type { UiEvent } from "@side/market-core";
import { mergeUiEvent, microBatchUiEvents, seededVisual } from "./state.js";

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

describe("mergeUiEvent", () => {
  it("is idempotent when a REST snapshot races the same WebSocket event", () => {
    const duplicate = mergeUiEvent([event], event);

    expect(duplicate).toEqual({ events: [event], added: false });
  });

  it("appends a new event and enforces the bounded history", () => {
    const next = { ...event, eventId: "coinbase:trade:101", streamSeq: "101" };
    const merged = mergeUiEvent([event], next, 1);

    expect(merged).toEqual({ events: [next], added: true });
  });

  it("retains an independent bounded history for each market zone", () => {
    const dex = { ...event, eventId: "bitquery:swap:1", streamSeq: "101", sourceProvider: "bitquery" as const, zone: "dex-spot" as const };
    const nextSpot = { ...event, eventId: "coinbase:trade:102", streamSeq: "102" };

    expect(mergeUiEvent([event, dex], nextSpot, 1).events).toEqual([dex, nextSpot]);
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
    expect(seededVisual(event).xPercent).toBeGreaterThanOrEqual(14);
    expect(seededVisual(event).xPercent).toBeLessThanOrEqual(85);
    expect(seededVisual(event).diameterPx).toBeGreaterThanOrEqual(22);
    expect(seededVisual(event).diameterPx).toBeLessThanOrEqual(72);
  });
});
