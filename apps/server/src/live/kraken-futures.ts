import Decimal from "decimal.js";
import type WebSocket from "ws";
import {
  decimal,
  eventBase,
  healthDraft,
  record,
  records,
  signedDecimal,
  text,
  type LiveEventSink,
  type LiveSourceSpec
} from "./common.js";
import { PersistentSocket } from "./socket.js";

const KRAKEN_FUTURES_WS_URL = "wss://futures.kraken.com/ws/v1";
export const DEFAULT_KRAKEN_FUTURES_PRODUCT_ID = "PF_SOLUSD";

const SPEC: LiveSourceSpec = {
  provider: "kraken-futures",
  venue: "kraken-futures",
  segment: "perp",
  instrumentId: DEFAULT_KRAKEN_FUTURES_PRODUCT_ID,
  quote: "USD"
};

interface Book {
  bids: Map<string, string>;
  asks: Map<string, string>;
  lastBbo: string | null;
  lastSequence: number | null;
}

function integer(value: unknown): number | null {
  const serialized = text(value);
  if (serialized === null) return null;
  const raw = Number(serialized);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

function timestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function instrument(productId: string): LiveSourceSpec {
  return { ...SPEC, instrumentId: productId };
}

function levelMap(value: unknown): Map<string, string> {
  const levels = new Map<string, string>();
  for (const level of records(value)) {
    const px = decimal(level.price);
    const size = decimal(level.qty);
    if (px && size && !new Decimal(size).isZero()) levels.set(px, size);
  }
  return levels;
}

export class KrakenFuturesDecoder {
  #book: Book = { bids: new Map(), asks: new Map(), lastBbo: null, lastSequence: null };
  #lastMark: string | null = null;
  #lastFunding: string | null = null;
  #lastOpenInterest: string | null = null;

  constructor(private readonly productId = DEFAULT_KRAKEN_FUTURES_PRODUCT_ID) {}

  reset(): void {
    this.#book = { bids: new Map(), asks: new Map(), lastBbo: null, lastSequence: null };
    this.#lastMark = null;
    this.#lastFunding = null;
    this.#lastOpenInterest = null;
  }

  decode(value: unknown, generation: number, receivedAtUnixMs = Date.now()): Record<string, unknown>[] {
    const message = record(value);
    if (!message) return [];
    if (message.event === "error") throw new Error(`kraken_futures_subscription_error:${text(message.message) ?? "unknown"}`);
    if (text(message.product_id) !== this.productId) return [];

    switch (text(message.feed)) {
      case "trade_snapshot":
        return [];
      case "trade":
        return this.#trade(message, generation, receivedAtUnixMs);
      case "book_snapshot":
        return this.#bookSnapshot(message, generation, receivedAtUnixMs);
      case "book":
        return this.#bookDelta(message, generation, receivedAtUnixMs);
      case "ticker":
        return this.#ticker(message, generation, receivedAtUnixMs);
      default:
        return [];
    }
  }

  #trade(message: Record<string, unknown>, generation: number, receivedAtUnixMs: number): Record<string, unknown>[] {
    const px = decimal(message.price);
    const size = decimal(message.qty);
    const side = text(message.side);
    const tradeId = text(message.uid);
    const sequence = integer(message.seq);
    const occurredAtMs = timestamp(message.time);
    if (!px || !size || !tradeId || sequence === null || occurredAtMs === null) return [];
    return [{
      ...eventBase(instrument(this.productId), "trade", generation, `kraken-futures:trade:${tradeId}`, occurredAtMs, receivedAtUnixMs),
      kind: "trade",
      cursor: { last: String(sequence), connectionGeneration: generation },
      payload: {
        px,
        sizeNative: size,
        sizeSOL: size,
        aggressor: side === "buy" ? "buy" : side === "sell" ? "sell" : "unknown",
        tradeId
      }
    }];
  }

  #bookSnapshot(message: Record<string, unknown>, generation: number, receivedAtUnixMs: number): Record<string, unknown>[] {
    const sequence = integer(message.seq);
    const occurredAtMs = timestamp(message.timestamp);
    if (sequence === null || occurredAtMs === null) return [];
    this.#book.bids = levelMap(message.bids);
    this.#book.asks = levelMap(message.asks);
    this.#book.lastBbo = null;
    this.#book.lastSequence = sequence;
    return this.#bbo(sequence, occurredAtMs, generation, receivedAtUnixMs, true);
  }

  #bookDelta(message: Record<string, unknown>, generation: number, receivedAtUnixMs: number): Record<string, unknown>[] {
    const sequence = integer(message.seq);
    const occurredAtMs = timestamp(message.timestamp);
    const side = text(message.side);
    const px = decimal(message.price);
    const size = decimal(message.qty);
    if (sequence === null || occurredAtMs === null || !px || !size || (side !== "buy" && side !== "sell")) return [];
    if (this.#book.lastSequence === null) throw new Error("kraken_futures_book_delta_before_snapshot");
    if (sequence <= this.#book.lastSequence) return [];
    if (sequence !== this.#book.lastSequence + 1) {
      throw new Error(`kraken_futures_book_gap:${this.#book.lastSequence}->${sequence}`);
    }
    this.#book.lastSequence = sequence;
    const levels = side === "buy" ? this.#book.bids : this.#book.asks;
    if (new Decimal(size).isZero()) levels.delete(px);
    else levels.set(px, size);
    return this.#bbo(sequence, occurredAtMs, generation, receivedAtUnixMs, false);
  }

  #bbo(
    sequence: number,
    occurredAtMs: number,
    generation: number,
    receivedAtUnixMs: number,
    snapshot: boolean
  ): Record<string, unknown>[] {
    const bestBid = [...this.#book.bids.keys()].sort((left, right) => new Decimal(right).cmp(left))[0];
    const bestAsk = [...this.#book.asks.keys()].sort((left, right) => new Decimal(left).cmp(right))[0];
    if (!bestBid || !bestAsk) return [];
    const bidSize = this.#book.bids.get(bestBid);
    const askSize = this.#book.asks.get(bestAsk);
    if (!bidSize || !askSize) return [];
    const signature = `${bestBid}:${bidSize}:${bestAsk}:${askSize}`;
    if (signature === this.#book.lastBbo) return [];
    this.#book.lastBbo = signature;
    return [{
      ...eventBase(
        instrument(this.productId),
        "book",
        generation,
        `kraken-futures:bbo:${this.productId}:${sequence}`,
        occurredAtMs,
        receivedAtUnixMs
      ),
      kind: "bbo",
      cursor: { last: String(sequence), snapshot, connectionGeneration: generation },
      payload: {
        bidPx: bestBid,
        bidSizeNative: bidSize,
        bidSizeSOL: bidSize,
        askPx: bestAsk,
        askSizeNative: askSize,
        askSizeSOL: askSize
      }
    }];
  }

  #ticker(message: Record<string, unknown>, generation: number, receivedAtUnixMs: number): Record<string, unknown>[] {
    const occurredAtMs = timestamp(message.time);
    if (occurredAtMs === null) return [];
    const drafts: Record<string, unknown>[] = [];
    const spec = instrument(this.productId);
    const markPx = decimal(message.markPrice);
    const indexPx = decimal(message.index);
    if (markPx) {
      const signature = `${markPx}:${indexPx ?? ""}`;
      if (signature !== this.#lastMark) {
        this.#lastMark = signature;
        drafts.push({
          ...eventBase(spec, "ticker", generation, `kraken-futures:mark:${this.productId}:${occurredAtMs}`, occurredAtMs, receivedAtUnixMs),
          kind: "mark",
          payload: { markPx, ...(indexPx ? { indexPx } : {}) }
        });
      }
    }

    const fundingRate = signedDecimal(message.relative_funding_rate_prediction);
    const nextFundingTs = timestamp(message.next_funding_rate_time);
    if (fundingRate) {
      const signature = `${fundingRate}:${nextFundingTs ?? ""}`;
      if (signature !== this.#lastFunding) {
        this.#lastFunding = signature;
        drafts.push({
          ...eventBase(spec, "ticker", generation, `kraken-futures:funding:${this.productId}:${occurredAtMs}`, occurredAtMs, receivedAtUnixMs),
          kind: "funding",
          payload: {
            fundingRate,
            fundingIntervalMs: 3_600_000,
            ...(nextFundingTs === null ? {} : { nextFundingTs }),
            semantics: "predicted"
          }
        });
      }
    }

    const oi = decimal(message.openInterest);
    if (oi && oi !== this.#lastOpenInterest) {
      this.#lastOpenInterest = oi;
      drafts.push({
        ...eventBase(spec, "ticker", generation, `kraken-futures:open-interest:${this.productId}:${occurredAtMs}`, occurredAtMs, receivedAtUnixMs),
        kind: "open-interest",
        payload: { oiNative: oi, oiSOL: oi, contractValueSOL: "1" }
      });
    }
    return drafts;
  }
}

export class KrakenFuturesLiveAdapter {
  #decoder: KrakenFuturesDecoder;
  #socket: PersistentSocket;
  #spec: LiveSourceSpec;

  constructor(private readonly sink: LiveEventSink, private readonly productId = DEFAULT_KRAKEN_FUTURES_PRODUCT_ID) {
    this.#spec = instrument(productId);
    this.#decoder = new KrakenFuturesDecoder(productId);
    this.#socket = new PersistentSocket({
      url: KRAKEN_FUTURES_WS_URL,
      onState: (state, generation, reason) => this.sink.emit(healthDraft(this.#spec, state, generation, reason)),
      onOpen: (socket) => this.#subscribe(socket),
      onMessage: (data, _socket, generation) => {
        const value: unknown = JSON.parse(data.toString());
        for (const draft of this.#decoder.decode(value, generation)) this.sink.emit(draft);
      }
    });
  }

  start(): void { this.#socket.start(); }
  stop(): void { this.#socket.stop(); }

  #subscribe(socket: WebSocket): void {
    this.#decoder.reset();
    for (const feed of ["trade", "book", "ticker"]) {
      socket.send(JSON.stringify({ event: "subscribe", feed, product_ids: [this.productId] }));
    }
  }
}
