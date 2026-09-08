import { describe, expect, it } from "vitest";
import { parseMarketEvent } from "@side/market-core";
import { S0Runtime } from "../src/runtime.js";
import { strategyObservation } from "../src/strategy/coordinator.js";

function base(eventId: string, kind: "trade" | "bbo" | "source-health", payload: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    eventId,
    source: { provider: "coinbase", channel: kind, connectionGeneration: 1 },
    venue: "coinbase",
    segment: "spot",
    instrumentId: "SOL-USD",
    base: "SOL",
    quote: "USD",
    occurredAtMs: 1_000,
    timeOrigin: "venue",
    receivedAtUnixMs: 1_001,
    receivedMonoNs: "1",
    quality: { state: kind === "source-health" ? "degraded" : "fresh", latencyMs: 1, outOfOrder: false, replay: false },
    kind,
    payload
  };
}

describe("S0Runtime LIVE mode", () => {
  it("allocates sequence numbers, rejects duplicate event ids and tracks transport state", () => {
    const runtime = new S0Runtime("", 64, "LIVE", "coinbase");
    const trade = base("coinbase:trade:live-1", "trade", {
      px: "106.25",
      sizeNative: "2",
      sizeSOL: "2",
      aggressor: "buy",
      tradeId: "live-1"
    });

    expect(runtime.ingestLive(trade)?.ingestSeq).toBe("1");
    expect(runtime.ingestLive(trade)).toBeNull();
    expect(runtime.paperDryReference(1_002)).toMatchObject({
      status: "READY",
      source: "coinbase-sol-usd",
      priceQuotePerSol: "106.250000",
      observedAtMs: 1_001
    });
    runtime.ingestLive(base("coinbase:health:reconnecting", "source-health", {
      connection: "reconnecting",
      transportLastSeenAtMs: 1_001,
      stateLastChangedAtMs: 1_001,
      gapReason: "test_disconnect"
    }));

    expect(runtime.snapshot()).toMatchObject({
      mode: "LIVE",
      cexProfile: "coinbase",
      replayStatus: "disabled",
      eventsIngested: 2,
      lastIngestSeq: "2",
      sources: [{ provider: "coinbase", connection: "reconnecting", quality: "degraded", replay: false }]
    });
    expect(runtime.snapshot().recentUiEvents).toHaveLength(1);
    expect(runtime.paperDryReference(1_002)).toMatchObject({ status: "UNAVAILABLE", reason: "CEX_REFERENCE_NOT_FRESH" });
    expect(runtime.snapshot().flow5m.segments).toContainEqual({
      segment: "cex-spot",
      buyCount: 1,
      sellCount: 0,
      buyNotionalQuote: "212.50",
      sellNotionalQuote: "0.00"
    });

    runtime.tick(301_002);
    expect(runtime.paperDryReference(301_002)).toMatchObject({ status: "UNAVAILABLE", reason: "CEX_REFERENCE_NOT_FRESH" });
    expect(runtime.snapshot().flow5m.segments.find(({ segment }) => segment === "cex-spot")).toMatchObject({
      buyCount: 0,
      buyNotionalQuote: "0.00"
    });
    expect(runtime.snapshot().recentUiEvents).toHaveLength(0);
    expect(() => runtime.startReplay()).toThrow("disabled in LIVE mode");
  });

  it("retains every economic bubble until the rolling five-minute window expires", () => {
    const runtime = new S0Runtime("", 64, "LIVE", "coinbase");
    for (let index = 0; index < 51; index += 1) {
      runtime.ingestLive({
        ...base(`coinbase:trade:${index}`, "trade", {
          px: "100",
          sizeNative: "1",
          sizeSOL: "1",
          aggressor: "buy",
          tradeId: String(index)
        }),
        receivedAtUnixMs: 1_000 + index
      });
    }

    expect(runtime.snapshot().recentUiEvents).toHaveLength(51);
    runtime.tick(301_051);
    expect(runtime.snapshot().recentUiEvents).toHaveLength(0);
  });

  it("produces the same one-second strategy observations in LIVE and fixed-tick replay", () => {
    const drafts = [
      { ...base("coinbase:trade:parity-1", "trade", { px: "100", sizeNative: "5", sizeSOL: "5", aggressor: "buy", tradeId: "parity-1" }), receivedAtUnixMs: 1_001 },
      { ...base("coinbase:bbo:parity-2", "bbo", { bidPx: "100", bidSizeNative: "2", bidSizeSOL: "2", askPx: "102", askSizeNative: "2", askSizeSOL: "2" }), receivedAtUnixMs: 1_026 },
      { ...base("coinbase:trade:parity-3", "trade", { px: "103", sizeNative: "5", sizeSOL: "5", aggressor: "buy", tradeId: "parity-3" }), receivedAtUnixMs: 2_191 }
    ];
    const observe = (runtime: S0Runtime, atMs: number) => {
      const signal = runtime.snapshot().signal;
      return strategyObservation(signal, runtime.paperDryReference(atMs), atMs);
    };

    const live = new S0Runtime("", 64, "LIVE", "coinbase");
    const liveObservations = [];
    live.ingestLive(drafts[0] as Record<string, unknown>);
    live.tick(1_001);
    liveObservations.push(observe(live, 1_001));
    live.ingestLive(drafts[1] as Record<string, unknown>);
    live.tick(2_001);
    liveObservations.push(observe(live, 2_001));
    live.ingestLive(drafts[2] as Record<string, unknown>);
    live.tick(3_001);
    liveObservations.push(observe(live, 3_001));

    const replayEvents = drafts.map((draft, index) => parseMarketEvent({ ...draft, ingestSeq: String(index + 1) }));
    const replay = new S0Runtime("", 64, "REPLAY", "coinbase");
    const replayObservations: ReturnType<typeof observe>[] = [];
    replay.startReplayEvents(replayEvents, ({ referenceAtMs }) => {
      replayObservations.push(observe(replay, referenceAtMs));
    });

    expect(replayObservations).toEqual(liveObservations);
  });
});
