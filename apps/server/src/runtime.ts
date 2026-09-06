import { parseMarketEvent, parseUiEvent, type MarketEvent, type UiEvent } from "@side/market-core";
import { decodeEventLog, ManualReplayClock, replayEvents } from "@side/recorder-replay";
import { S0SignalEngine } from "@side/signal-engine";
import Decimal from "decimal.js";
import type {
  GatewayMessage,
  LivePaperPreview,
  ReplayPaperPreview,
  ReplayStatus,
  RuntimeSnapshot,
  SourceRuntimeState
} from "./contracts.js";
import { BoundedGatewayQueue } from "./gateway-queue.js";
import { IngestSequenceAllocator } from "./sequence.js";

const RECENT_UI_EVENT_LIMIT_PER_ZONE = 50;

function retainUiEventPerZone(events: UiEvent[], next: UiEvent): UiEvent[] {
  const sameZone = events.filter(({ zone }) => zone === next.zone);
  const removeEventId = sameZone.length >= RECENT_UI_EVENT_LIMIT_PER_ZONE ? sameZone[0]?.eventId : null;
  return [...events.filter((event) => !(event.zone === next.zone && event.eventId === removeEventId)), next];
}

const REPLAY_PAPER_PREVIEW: ReplayPaperPreview = Object.freeze({
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
  routeSummary: ["Frozen 0x response-shaped fixture", "USDC exact-in → SOL"],
  recordable: false,
  disabledReason: "PAPER_RECORD_ENTERS_SIDE_010"
});

const LIVE_PAPER_PREVIEW: LivePaperPreview = Object.freeze({
  schemaVersion: 1,
  previewId: "live:unavailable:side-006",
  mode: "LIVE",
  status: "UNAVAILABLE",
  provider: null,
  side: "buy-sol",
  pair: "SOL-USDC",
  targetNotionalQuote: "10000",
  estimatedOutputSOL: null,
  minimumOutputSOL: null,
  priceImpactBps: null,
  feeBreakdown: null,
  quoteAgeMs: null,
  routeSummary: ["Live execution quote is requested only when an operator opens a preview."],
  recordable: false,
  disabledReason: "LIVE_QUOTE_NOT_REQUESTED"
});

function zoneFor(event: MarketEvent): UiEvent["zone"] {
  if (event.source.provider === "hyperliquid") return "defi-perps";
  if (event.segment === "dex-spot") return "dex-spot";
  return event.segment === "perp" ? "cex-perps" : "cex-spot";
}

function uiEventFor(event: MarketEvent): UiEvent {
  const isBuy =
    (event.kind === "trade" && event.payload.aggressor === "buy") ||
    (event.kind === "onchain-swap" && event.payload.side === "buy-sol");
  const isSell =
    (event.kind === "trade" && event.payload.aggressor === "sell") ||
    (event.kind === "onchain-swap" && event.payload.side === "sell-sol");
  const notionalQuote =
    event.kind === "trade"
      ? new Decimal(event.payload.px).mul(event.payload.sizeSOL)
      : event.kind === "onchain-swap"
        ? new Decimal(
            event.payload.side === "buy-sol" ? event.payload.amountInAtomic : event.payload.amountOutAtomic
          ).div(1_000_000)
        : null;
  const priceRange =
    event.kind === "trade"
      ? { minPx: event.payload.px, maxPx: event.payload.px }
      : event.kind === "onchain-swap"
        ? { minPx: event.payload.effectivePxQuotePerSol, maxPx: event.payload.effectivePxQuotePerSol }
        : event.kind === "bbo"
          ? { minPx: event.payload.bidPx, maxPx: event.payload.askPx }
          : {};
  return parseUiEvent({
    eventId: event.eventId,
    streamSeq: event.ingestSeq,
    stateVersion: `ingest-${event.ingestSeq}`,
    sourceProvider: event.source.provider,
    instrumentId: event.instrumentId,
    quoteAsset: event.quote,
    zone: zoneFor(event),
    venueLabel: event.protocol ?? event.venue,
    kind: event.kind,
    changeDirection: isBuy ? "up" : isSell ? "down" : "flat",
    ...(event.kind === "trade"
      ? { tradeSide: event.payload.aggressor }
      : event.kind === "onchain-swap"
        ? { tradeSide: isBuy ? "buy" : "sell" }
        : {}),
    signalPolarity: "not-applicable",
    intensity: 1,
    count: 1,
    batchStartMs: event.receivedAtUnixMs,
    batchEndMs: event.receivedAtUnixMs,
    ...(isBuy ? { buyCount: 1, sellCount: 0 } : {}),
    ...(isSell ? { buyCount: 0, sellCount: 1 } : {}),
    ...(isBuy && notionalQuote ? { buyNotional: notionalQuote.toFixed(2) } : {}),
    ...(isSell && notionalQuote ? { sellNotional: notionalQuote.toFixed(2) } : {}),
    ...(notionalQuote ? { maxNotional: notionalQuote.toFixed(2) } : {}),
    ...priceRange,
    label: `${event.source.provider} ${event.kind}`,
    quality: event.quality.state
  });
}

export class S0Runtime {
  #replayStatus: ReplayStatus;
  #eventsIngested = 0;
  #lastIngestSeq: string | null = null;
  #sources = new Map<string, SourceRuntimeState>();
  #recentUiEvents: UiEvent[] = [];
  #clients = new Map<number, BoundedGatewayQueue>();
  #nextClientId = 1;
  #sequence = new IngestSequenceAllocator();
  #signal = new S0SignalEngine();
  #seenLiveEventIds = new Set<string>();

  constructor(
    private readonly replayJsonl: string,
    private readonly queueCapacity = 64,
    private readonly mode: "LIVE" | "REPLAY" = "REPLAY",
    private readonly cexProfile: "coinbase" | "binance" | "unavailable" = "coinbase"
  ) {
    this.#replayStatus = mode === "LIVE" ? "disabled" : "idle";
  }

  snapshot(): RuntimeSnapshot {
    return {
      schemaVersion: 1,
      mode: this.mode,
      cexProfile: this.cexProfile,
      replayStatus: this.#replayStatus,
      eventsIngested: this.#eventsIngested,
      lastIngestSeq: this.#lastIngestSeq,
      sources: [...this.#sources.values()].sort((left, right) => left.provider.localeCompare(right.provider)),
      recentUiEvents: [...this.#recentUiEvents],
      signal: this.#signal.snapshot(),
      paperPreview: this.mode === "LIVE" ? LIVE_PAPER_PREVIEW : REPLAY_PAPER_PREVIEW
    };
  }

  connect(send: (serialized: string) => void): () => void {
    const clientId = this.#nextClientId++;
    const queue = new BoundedGatewayQueue(send, () => this.snapshot(), this.queueCapacity);
    this.#clients.set(clientId, queue);
    queue.enqueue({ type: "state_snapshot", snapshot: this.snapshot() });
    return () => this.#clients.delete(clientId);
  }

  startReplay(): RuntimeSnapshot {
    if (this.mode === "LIVE") throw new Error("Replay controls are disabled in LIVE mode");
    this.#reset();
    this.#replayStatus = "running";
    const events = decodeEventLog(this.replayJsonl);
    replayEvents(events, new ManualReplayClock(0), ({ event }) => this.#ingest(event));
    this.#replayStatus = "completed";
    this.#broadcast({ type: "state_snapshot", snapshot: this.snapshot() });
    return this.snapshot();
  }

  stopReplay(): RuntimeSnapshot {
    if (this.mode === "LIVE") throw new Error("Replay controls are disabled in LIVE mode");
    this.#replayStatus = "stopped";
    for (const [provider, current] of this.#sources) {
      const source: SourceRuntimeState = { ...current, connection: "closed", quality: "stale" };
      this.#sources.set(provider, source);
      this.#broadcast({ type: "source_health", source });
    }
    this.#broadcast({ type: "state_snapshot", snapshot: this.snapshot() });
    return this.snapshot();
  }

  #reset(): void {
    this.#replayStatus = "idle";
    this.#eventsIngested = 0;
    this.#lastIngestSeq = null;
    this.#sources.clear();
    this.#recentUiEvents = [];
    this.#sequence.reset();
    this.#signal.reset();
  }

  ingestLive(draft: Record<string, unknown>): MarketEvent | null {
    if (this.mode !== "LIVE") throw new Error("Live ingest is disabled in REPLAY mode");
    const eventId = draft.eventId;
    if (typeof eventId !== "string" || eventId.length === 0) throw new Error("Live event requires eventId");
    if (this.#seenLiveEventIds.has(eventId)) return null;
    const event = parseMarketEvent({ ...draft, ingestSeq: this.#sequence.next() });
    this.#seenLiveEventIds.add(eventId);
    if (this.#seenLiveEventIds.size > 100_000) {
      this.#seenLiveEventIds.delete(this.#seenLiveEventIds.values().next().value as string);
    }
    this.#ingest(event, true);
    return event;
  }

  tick(nowMs: number): void {
    const transitions = this.#signal.tick(nowMs);
    if (transitions.length > 0) {
      this.#broadcast({ type: "signal_state", signal: this.#signal.snapshot() });
    }
  }

  #ingest(event: MarketEvent, sequenceAllocated = false): void {
    if (!sequenceAllocated) this.#sequence.observe(event.ingestSeq);
    this.#eventsIngested += 1;
    this.#lastIngestSeq = event.ingestSeq;

    const source: SourceRuntimeState = {
      provider: event.source.provider,
      connection: event.kind === "source-health" ? event.payload.connection : "live",
      quality: event.quality.state,
      replay: event.quality.replay,
      eventCount: (this.#sources.get(event.source.provider)?.eventCount ?? 0) + 1,
      lastEventId: event.eventId,
      lastIngestSeq: event.ingestSeq,
      lastSeenAtMs: event.receivedAtUnixMs
    };
    this.#sources.set(source.provider, source);

    const signalTransitions = this.#signal.ingest(event);
    this.#broadcast({ type: "source_health", source });
    if (event.kind !== "source-health") {
      const uiEvent = uiEventFor(event);
      this.#recentUiEvents = retainUiEventPerZone(this.#recentUiEvents, uiEvent);
      this.#broadcast({ type: "ui_event", event: uiEvent });
    }
    if (signalTransitions.length > 0) {
      this.#broadcast({ type: "signal_state", signal: this.#signal.snapshot() });
    }
  }

  #broadcast(message: GatewayMessage): void {
    for (const queue of this.#clients.values()) {
      queue.enqueue(message);
    }
  }
}
