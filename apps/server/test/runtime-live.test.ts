import { describe, expect, it } from "vitest";
import { S0Runtime } from "../src/runtime.js";

function base(eventId: string, kind: "trade" | "source-health", payload: Record<string, unknown>) {
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
    expect(() => runtime.startReplay()).toThrow("disabled in LIVE mode");
  });
});
