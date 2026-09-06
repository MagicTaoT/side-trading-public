import { describe, expect, it } from "vitest";
import type { GatewayMessage, RuntimeSnapshot } from "../src/contracts.js";
import { BoundedGatewayQueue } from "../src/gateway-queue.js";
import { IngestSequenceAllocator } from "../src/sequence.js";
import { S0SignalEngine } from "@side/signal-engine";

const snapshot: RuntimeSnapshot = {
  schemaVersion: 1,
  mode: "REPLAY",
  cexProfile: "coinbase",
  replayStatus: "running",
  eventsIngested: 0,
  lastIngestSeq: null,
  sources: [],
  recentUiEvents: [],
  flow5m: {
    windowMs: 300_000,
    evaluatedAtMs: 0,
    segments: (["cex-spot", "cex-perp", "dex-spot", "defi-perp"] as const).map((segment) => ({
      segment,
      buyCount: 0,
      sellCount: 0,
      buyNotionalQuote: "0.00",
      sellNotionalQuote: "0.00"
    }))
  },
  signal: new S0SignalEngine().snapshot(),
  paperPreview: {
    schemaVersion: 1,
    previewId: "replay:zeroex:buy-sol:side-005",
    mode: "REPLAY",
    status: "READY",
    provider: "zeroex",
    side: "buy-sol",
    pair: "SOL-USDC",
    targetNotionalQuote: "10000",
    estimatedOutputSOL: "56.710000000",
    minimumOutputSOL: null,
    priceImpactBps: null,
    feeBreakdown: null,
    quoteAgeMs: 800,
    routeSummary: ["fixture"],
    recordable: false,
    disabledReason: "PAPER_RECORD_ENTERS_SIDE_010"
  }
};

function healthMessage(provider: string): GatewayMessage {
  return {
    type: "source_health",
    source: {
      provider,
      connection: "live",
      quality: "fresh",
      replay: true,
      eventCount: 1,
      lastEventId: `${provider}:1`,
      lastIngestSeq: "1",
      lastSeenAtMs: 1
    }
  };
}

describe("BoundedGatewayQueue", () => {
  it("collapses overflow into one authoritative resync message", () => {
    const sent: string[] = [];
    const queue = new BoundedGatewayQueue(
      (serialized) => sent.push(serialized),
      () => snapshot,
      2,
      () => undefined
    );

    queue.enqueue(healthMessage("coinbase"));
    queue.enqueue(healthMessage("bitquery"));
    queue.enqueue(healthMessage("hyperliquid"));
    queue.enqueue(healthMessage("coinbase-derivatives"));
    expect(queue.size).toBe(1);

    queue.drain();
    const [message] = sent.map((item) => JSON.parse(item) as GatewayMessage);
    expect(message?.type).toBe("resync_required");
    if (message?.type === "resync_required") {
      expect(message.suppressedCountByKind).toEqual({ source_health: 4 });
      expect(message.snapshot).toEqual(snapshot);
    }
  });
});

describe("IngestSequenceAllocator", () => {
  it("observes replay sequence then allocates the next global value", () => {
    const allocator = new IngestSequenceAllocator();
    allocator.observe("100");
    allocator.observe("102");
    expect(allocator.next()).toBe("103");
  });

  it("rejects duplicate and backwards sequence", () => {
    const allocator = new IngestSequenceAllocator();
    allocator.observe("10");
    expect(() => allocator.observe("10")).toThrow(/increase globally/u);
    expect(() => allocator.observe("9")).toThrow(/increase globally/u);
  });
});
