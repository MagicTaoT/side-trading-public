import type WebSocket from "ws";
import { decimal, eventBase, healthDraft, record, records, signedDecimal, text, type LiveEventSink, type LiveSourceSpec } from "./common.js";
import { PersistentSocket } from "./socket.js";

const SPEC: LiveSourceSpec = {
  provider: "hyperliquid",
  venue: "hyperliquid",
  segment: "perp",
  instrumentId: "SOL-PERP",
  quote: "USD"
};

export class HyperliquidLiveAdapter {
  #connectedAtMs = 0;
  #socket: PersistentSocket;

  constructor(private readonly sink: LiveEventSink) {
    this.#socket = new PersistentSocket({
      url: "wss://api.hyperliquid.xyz/ws",
      onState: (state, generation, reason) => this.sink.emit(healthDraft(SPEC, state, generation, reason)),
      onOpen: (socket) => this.#subscribe(socket),
      onMessage: (data, _socket, generation) => this.#message(data.toString(), generation)
    });
  }

  start(): void { this.#socket.start(); }
  stop(): void { this.#socket.stop(); }

  #subscribe(socket: WebSocket): void {
    this.#connectedAtMs = Date.now();
    for (const type of ["trades", "bbo", "activeAssetCtx"]) {
      socket.send(JSON.stringify({ method: "subscribe", subscription: { type, coin: "SOL" } }));
    }
  }

  #message(raw: string, generation: number): void {
    const message = record(JSON.parse(raw));
    if (!message) return;
    const channel = text(message.channel);
    if (channel === "trades") this.#trades(message.data, generation);
    if (channel === "bbo") this.#bbo(message.data, generation);
    if (channel === "activeAssetCtx") this.#context(message.data, generation);
  }

  #trades(value: unknown, generation: number): void {
    for (const trade of records(value)) {
      const occurredAtMs = Number(trade.time);
      const px = decimal(trade.px);
      const size = decimal(trade.sz);
      const tradeId = text(trade.tid) ?? text(trade.hash);
      if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < this.#connectedAtMs - 5_000 || !px || !size || !tradeId) continue;
      this.sink.emit({
        ...eventBase(SPEC, "trades", generation, `hyperliquid:trade:${tradeId}`, occurredAtMs),
        kind: "trade",
        payload: { px, sizeNative: size, sizeSOL: size, aggressor: trade.side === "B" ? "buy" : trade.side === "A" ? "sell" : "unknown", tradeId }
      });
    }
  }

  #bbo(value: unknown, generation: number): void {
    const data = record(value);
    const levels = Array.isArray(data?.bbo) ? data.bbo : [];
    const bid = record(levels[0]);
    const ask = record(levels[1]);
    const occurredAtMs = Number(data?.time);
    const bidPx = decimal(bid?.px);
    const bidSize = decimal(bid?.sz);
    const askPx = decimal(ask?.px);
    const askSize = decimal(ask?.sz);
    if (!Number.isSafeInteger(occurredAtMs) || !bidPx || !bidSize || !askPx || !askSize) return;
    this.sink.emit({
      ...eventBase(SPEC, "bbo", generation, `hyperliquid:bbo:${occurredAtMs}:${bidPx}:${askPx}`, occurredAtMs),
      kind: "bbo",
      payload: { bidPx, bidSizeNative: bidSize, bidSizeSOL: bidSize, askPx, askSizeNative: askSize, askSizeSOL: askSize }
    });
  }

  #context(value: unknown, generation: number): void {
    const data = record(value);
    const context = record(data?.ctx);
    const markPx = decimal(context?.markPx);
    if (!context || !markPx) return;
    const now = Date.now();
    this.sink.emit({
      ...eventBase(SPEC, "activeAssetCtx", generation, `hyperliquid:mark:${now}:${markPx}`, now),
      kind: "mark",
      payload: { markPx, ...(decimal(context.oraclePx) ? { oraclePx: decimal(context.oraclePx) } : {}) }
    });
    const fundingRate = signedDecimal(context.funding);
    if (fundingRate !== null) {
      this.sink.emit({
        ...eventBase(SPEC, "activeAssetCtx", generation, `hyperliquid:funding:${now}:${fundingRate}`, now),
        kind: "funding",
        payload: { fundingRate, fundingIntervalMs: 3_600_000, semantics: "predicted" }
      });
    }
    const oi = decimal(context.openInterest);
    if (oi) {
      this.sink.emit({
        ...eventBase(SPEC, "activeAssetCtx", generation, `hyperliquid:oi:${now}:${oi}`, now),
        kind: "open-interest",
        payload: { oiNative: oi, oiSOL: oi }
      });
    }
  }
}
