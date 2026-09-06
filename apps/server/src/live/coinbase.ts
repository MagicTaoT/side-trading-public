import Decimal from "decimal.js";
import type WebSocket from "ws";
import { decimal, eventBase, healthDraft, record, records, text, type LiveEventSink, type LiveSourceSpec } from "./common.js";
import { PersistentSocket } from "./socket.js";

interface CoinbaseInstrument extends LiveSourceSpec {
  productId: string;
  contractValueSOL: string;
}

interface Book {
  bids: Map<string, string>;
  asks: Map<string, string>;
  lastBbo: string | null;
}

export class CoinbaseLiveAdapter {
  #books = new Map<string, Book>();
  #socket: PersistentSocket;

  constructor(private readonly sink: LiveEventSink, private readonly instruments: CoinbaseInstrument[]) {
    for (const instrument of instruments) this.#books.set(instrument.productId, { bids: new Map(), asks: new Map(), lastBbo: null });
    this.#socket = new PersistentSocket({
      url: "wss://advanced-trade-ws.coinbase.com",
      onState: (state, generation, reason) => {
        for (const instrument of this.instruments) this.sink.emit(healthDraft(instrument, state, generation, reason));
      },
      onOpen: (socket) => this.#subscribe(socket),
      onMessage: (data, _socket, generation) => this.#message(data.toString(), generation)
    });
  }

  start(): void { this.#socket.start(); }
  stop(): void { this.#socket.stop(); }

  #subscribe(socket: WebSocket): void {
    const productIds = this.instruments.map(({ productId }) => productId);
    for (const channel of ["heartbeats", "market_trades", "level2"]) {
      socket.send(JSON.stringify({ type: "subscribe", product_ids: productIds, channel }));
    }
  }

  #message(raw: string, generation: number): void {
    const message = record(JSON.parse(raw));
    if (!message) return;
    if (message.type === "error") throw new Error(`coinbase_subscription_error:${text(message.message) ?? "unknown"}`);
    const channel = text(message.channel);
    if (channel === "heartbeats") {
      for (const instrument of this.instruments) this.sink.emit(healthDraft(instrument, "live", generation));
      return;
    }
    if (channel === "market_trades") this.#trades(message, generation);
    if (channel === "l2_data") this.#level2(message, generation);
  }

  #trades(message: Record<string, unknown>, generation: number): void {
    const sequence = text(message.sequence_num) ?? String(Date.now());
    for (const event of records(message.events)) {
      if (event.type !== "update") continue;
      for (const trade of records(event.trades)) {
        const productId = text(trade.product_id);
        const instrument = this.instruments.find((candidate) => candidate.productId === productId);
        const px = decimal(trade.price);
        const sizeNative = decimal(trade.size);
        const tradeId = text(trade.trade_id);
        const makerSide = text(trade.side);
        const rawTime = text(trade.time);
        const occurredAtMs = rawTime ? Date.parse(rawTime) : Number.NaN;
        if (!instrument || !px || !sizeNative || !tradeId || !Number.isFinite(occurredAtMs)) continue;
        const sizeSOL = new Decimal(sizeNative).mul(instrument.contractValueSOL).toFixed();
        this.sink.emit({
          ...eventBase(instrument, "market_trades", generation, `${instrument.provider}:trade:${tradeId}`, occurredAtMs),
          kind: "trade",
          cursor: { last: sequence, connectionGeneration: generation },
          payload: {
            px,
            sizeNative,
            sizeSOL,
            aggressor: makerSide === "SELL" ? "buy" : makerSide === "BUY" ? "sell" : "unknown",
            tradeId
          }
        });
      }
    }
  }

  #level2(message: Record<string, unknown>, generation: number): void {
    const sequence = text(message.sequence_num) ?? String(Date.now());
    for (const event of records(message.events)) {
      const productId = text(event.product_id);
      const instrument = this.instruments.find((candidate) => candidate.productId === productId);
      const book = productId ? this.#books.get(productId) : undefined;
      if (!instrument || !book) continue;
      for (const update of records(event.updates)) {
        const side = text(update.side);
        const px = decimal(update.price_level);
        const size = decimal(update.new_quantity);
        if (!px || !size || (side !== "bid" && side !== "offer")) continue;
        const levels = side === "bid" ? book.bids : book.asks;
        if (new Decimal(size).isZero()) levels.delete(px);
        else levels.set(px, size);
      }
      const bestBid = [...book.bids.keys()].sort((a, b) => new Decimal(b).cmp(a))[0];
      const bestAsk = [...book.asks.keys()].sort((a, b) => new Decimal(a).cmp(b))[0];
      if (!bestBid || !bestAsk) continue;
      const bidSizeNative = book.bids.get(bestBid);
      const askSizeNative = book.asks.get(bestAsk);
      if (!bidSizeNative || !askSizeNative) continue;
      const signature = `${bestBid}:${bidSizeNative}:${bestAsk}:${askSizeNative}`;
      if (signature === book.lastBbo) continue;
      book.lastBbo = signature;
      const rawTime = text(records(event.updates)[0]?.event_time);
      const parsedTime = rawTime ? Date.parse(rawTime) : Number.NaN;
      const occurredAtMs = Number.isFinite(parsedTime) ? parsedTime : Date.now();
      this.sink.emit({
        ...eventBase(instrument, "level2", generation, `${instrument.provider}:bbo:${productId}:${sequence}:${occurredAtMs}`, occurredAtMs),
        kind: "bbo",
        cursor: { last: sequence, snapshot: event.type === "snapshot", connectionGeneration: generation },
        payload: {
          bidPx: bestBid,
          bidSizeNative,
          bidSizeSOL: new Decimal(bidSizeNative).mul(instrument.contractValueSOL).toFixed(),
          askPx: bestAsk,
          askSizeNative,
          askSizeSOL: new Decimal(askSizeNative).mul(instrument.contractValueSOL).toFixed()
        }
      });
    }
  }
}

export function coinbaseInstruments(perpProductId: string): CoinbaseInstrument[] {
  return [
    { provider: "coinbase", venue: "coinbase", segment: "spot", instrumentId: "SOL-USD", quote: "USD", productId: "SOL-USD", contractValueSOL: "1" },
    { provider: "coinbase-derivatives", venue: "coinbase-derivatives", segment: "perp", instrumentId: perpProductId, quote: "USD", productId: perpProductId, contractValueSOL: "5" }
  ];
}
