import Decimal from "decimal.js";
import type WebSocket from "ws";
import { decimal, eventBase, healthDraft, record, records, text, type LiveEventSink, type LiveSourceSpec } from "./common.js";
import { PersistentSocket } from "./socket.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPEC: LiveSourceSpec = { provider: "bitquery", venue: "solana-dex", segment: "dex-spot", instrumentId: "WSOL-USDC", quote: "USDC" };
const SUBSCRIPTION = `subscription SideLive {
  Solana {
    DEXTradeByTokens(where: {Transaction: {Result: {Success: true}}, Trade: {Currency: {MintAddress: {is: "${WSOL_MINT}"}}, Side: {Currency: {MintAddress: {is: "${USDC_MINT}"}}}}}) {
      Block { Time Slot }
      Transaction { Signature Index Result { Success } }
      Trade { Index Market { MarketAddress } Dex { ProtocolFamily ProtocolName ProgramAddress } Price Amount Side { Type Amount Currency { MintAddress Symbol } } }
    }
  }
}`;

export class BitqueryLiveAdapter {
  #seen = new Set<string>();
  #pending = new Map<string, { rows: Record<string, unknown>[]; generation: number; timer: NodeJS.Timeout }>();
  #socket: PersistentSocket;

  constructor(private readonly sink: LiveEventSink, token: string) {
    this.#socket = new PersistentSocket({
      url: "wss://streaming.bitquery.io/graphql",
      protocols: ["graphql-transport-ws"],
      headers: { authorization: `Bearer ${token}` },
      onState: (state, generation, reason) => this.sink.emit(healthDraft(SPEC, state, generation, reason)),
      onOpen: (socket) => socket.send(JSON.stringify({ type: "connection_init" })),
      onMessage: (data, socket, generation) => this.#message(data.toString(), socket, generation)
    });
  }

  start(): void { this.#socket.start(); }
  stop(): void {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
    this.#socket.stop();
  }

  #message(raw: string, socket: WebSocket, generation: number): void {
    const message = record(JSON.parse(raw));
    if (!message) return;
    if (message.type === "connection_ack") {
      socket.send(JSON.stringify({ id: "side-live-wsol-usdc", type: "subscribe", payload: { query: SUBSCRIPTION } }));
      this.sink.emit(healthDraft(SPEC, "live", generation));
      return;
    }
    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", ...(message.payload ? { payload: message.payload } : {}) }));
      this.sink.emit(healthDraft(SPEC, "live", generation));
      return;
    }
    if (message.type === "error") throw new Error("bitquery_subscription_error");
    if (message.type !== "next") return;
    const payload = record(message.payload);
    const data = record(payload?.data);
    const solana = record(data?.Solana);
    const rows = records(solana?.DEXTradeByTokens);
    this.sink.emit(healthDraft(SPEC, "live", generation));
    this.#queue(rows, generation);
  }

  #queue(rows: Record<string, unknown>[], generation: number): void {
    for (const row of rows) {
      const transaction = record(row.Transaction);
      const signature = text(transaction?.Signature);
      if (!signature || this.#seen.has(`${signature}:0`)) continue;
      const existing = this.#pending.get(signature);
      if (existing) {
        clearTimeout(existing.timer);
        existing.rows.push(row);
        existing.generation = generation;
        existing.timer = setTimeout(() => this.#flush(signature), 250);
        existing.timer.unref();
      } else {
        const timer = setTimeout(() => this.#flush(signature), 250);
        timer.unref();
        this.#pending.set(signature, { rows: [row], generation, timer });
      }
    }
  }

  #flush(signature: string): void {
    const pending = this.#pending.get(signature);
    if (!pending) return;
    this.#pending.delete(signature);
    const parsed = pending.rows.flatMap((row) => {
      const block = record(row.Block);
      const transaction = record(row.Transaction);
      const trade = record(row.Trade);
      const side = record(trade?.Side);
      const dex = record(trade?.Dex);
      const market = record(trade?.Market);
      const slot = text(block?.Slot);
      const solAmount = decimal(trade?.Amount);
      const usdcAmount = decimal(side?.Amount);
      const sideType = text(side?.Type)?.toLowerCase();
      const rawTime = text(block?.Time);
      const occurredAtMs = rawTime ? Date.parse(rawTime) : Number.NaN;
      if (!slot || !solAmount || !usdcAmount || !Number.isFinite(occurredAtMs) || (sideType !== "buy" && sideType !== "sell")) return [];
      return [{
        row,
        slot,
        solAmount,
        usdcAmount,
        sideType,
        occurredAtMs,
        transactionIndex: Number(transaction?.Index),
        tradeIndex: Number(trade?.Index),
        protocol: text(dex?.ProtocolName) ?? text(dex?.ProtocolFamily) ?? "unknown-solana-dex",
        pool: text(market?.MarketAddress)
      }];
    });
    if (parsed.length === 0) return;

    const preferred = new Map<string, (typeof parsed)[number]>();
    for (const leg of parsed) {
      const identity = `${leg.solAmount}:${leg.usdcAmount}:${leg.sideType}`;
      const existing = preferred.get(identity);
      if (!existing || (!existing.pool && leg.pool)) preferred.set(identity, leg);
    }
    const legs = [...preferred.values()].sort((left, right) =>
      (Number.isFinite(left.tradeIndex) ? left.tradeIndex : Number.MAX_SAFE_INTEGER) -
      (Number.isFinite(right.tradeIndex) ? right.tradeIndex : Number.MAX_SAFE_INTEGER)
    );
    let solDelta = new Decimal(0);
    let usdcDelta = new Decimal(0);
    for (const leg of legs) {
      const sol = new Decimal(leg.solAmount);
      const usdc = new Decimal(leg.usdcAmount);
      if (leg.sideType === "buy") {
        solDelta = solDelta.plus(sol);
        usdcDelta = usdcDelta.minus(usdc);
      } else {
        solDelta = solDelta.minus(sol);
        usdcDelta = usdcDelta.plus(usdc);
      }
    }
    if (solDelta.isZero() || usdcDelta.isZero() || solDelta.isPositive() === usdcDelta.isPositive()) {
      return;
    }

    const dedupeKey = `${signature}:0`;
    if (this.#seen.has(dedupeKey)) return;
    this.#seen.add(dedupeKey);
    if (this.#seen.size > 10_000) this.#seen.delete(this.#seen.values().next().value as string);
    const isBuy = solDelta.isPositive();
    const economicSol = solDelta.abs();
    const economicUsdc = usdcDelta.abs();
    const amountInAtomic = (isBuy ? economicUsdc.mul(1_000_000) : economicSol.mul(1_000_000_000)).toDecimalPlaces(0).toFixed(0);
    const amountOutAtomic = (isBuy ? economicSol.mul(1_000_000_000) : economicUsdc.mul(1_000_000)).toDecimalPlaces(0).toFixed(0);
    if (amountInAtomic === "0" || amountOutAtomic === "0") return;
    const effectivePx = economicUsdc.div(economicSol).toFixed();
    const protocols = [...new Set(legs.map(({ protocol }) => protocol))];
    const protocol = protocols.length === 1 ? protocols[0] as string : "multi-leg";
    const pools = [...new Set(legs.map(({ pool }) => pool).filter((pool): pool is string => typeof pool === "string" && pool.length > 0))];
    const occurredAtMs = Math.max(...legs.map((leg) => leg.occurredAtMs));
    const slot = legs.reduce((latest, leg) => BigInt(leg.slot) > BigInt(latest) ? leg.slot : latest, legs[0]?.slot as string);
    const transactionIndex = legs.find(({ transactionIndex }) => Number.isSafeInteger(transactionIndex))?.transactionIndex;
    this.sink.emit({
      ...eventBase(SPEC, "DEXTradeByTokens", pending.generation, `bitquery:swap:${dedupeKey}`, occurredAtMs),
      protocol,
      kind: "onchain-swap",
      timeOrigin: "block",
      payload: {
        cluster: "mainnet-beta",
        signature,
        slot,
        ...(transactionIndex === undefined ? {} : { transactionIndex }),
        economicSwapIndex: 0,
        commitment: "provider-indexed",
        finalitySource: "provider",
        protocol,
        poolAddresses: pools,
        ...(protocols.includes("jupiter") ? { aggregator: "jupiter" } : {}),
        inputMint: isBuy ? USDC_MINT : WSOL_MINT,
        outputMint: isBuy ? WSOL_MINT : USDC_MINT,
        amountInAtomic,
        amountOutAtomic,
        side: isBuy ? "buy-sol" : "sell-sol",
        effectivePxQuotePerSol: effectivePx,
        routeLegs: legs.map((leg) => {
          const legIsBuy = leg.sideType === "buy";
          return {
            protocol: leg.protocol,
            ...(leg.pool ? { poolAddress: leg.pool } : {}),
            inputMint: legIsBuy ? USDC_MINT : WSOL_MINT,
            outputMint: legIsBuy ? WSOL_MINT : USDC_MINT,
            amountInAtomic: new Decimal(legIsBuy ? leg.usdcAmount : leg.solAmount).mul(legIsBuy ? 1_000_000 : 1_000_000_000).toDecimalPlaces(0).toFixed(0),
            amountOutAtomic: new Decimal(legIsBuy ? leg.solAmount : leg.usdcAmount).mul(legIsBuy ? 1_000_000_000 : 1_000_000).toDecimalPlaces(0).toFixed(0)
          };
        }),
        blockTimeMs: occurredAtMs,
        parserVersion: "bitquery-dex-trade-economic-group-v1",
        parseQuality: { protocolDecoded: protocol !== "unknown-solana-dex", tokenBalancesReconciled: false, providerParsed: true, nativeSolAccounting: "not-applicable" },
        coverageGroup: "bitquery:wsol-usdc:all-dex"
      }
    });
  }
}
