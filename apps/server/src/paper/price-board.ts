import Decimal from "decimal.js";
import type { RuntimeMode } from "../contracts.js";
import type {
  DexReferenceSnapshot,
  PaperDisplayPrice,
  PaperDryReferenceSnapshot,
  PaperFailureCode,
  PaperPreview,
  PaperPriceBoardSnapshot,
  PaperSide
} from "./contracts.js";
import {
  PAPER_DRY_HALF_SPREAD_BPS,
  PAPER_NOTIONAL_QUOTE,
  PAPER_PAIR,
  PAPER_PREVIEW_TTL_MS,
  PAPER_PRICE_REFRESH_MS,
  PAPER_PRICE_STALE_MS
} from "./contracts.js";
import type { PaperEstimateBroker } from "./broker.js";

type Clock = () => number;

interface SideState {
  latest: PaperPreview | null;
  lastSuccess: PaperPreview | null;
}

interface PriceBoardBroker {
  preview(request: {
    side: PaperSide;
    provider: "zeroex";
    idempotencyKey: string;
    primaryFailureId: null;
  }): Promise<PaperPreview>;
  reference(evaluatedAtMs: number): DexReferenceSnapshot;
}

interface PaperPriceBoardOptions {
  mode: RuntimeMode;
  broker: PaperEstimateBroker | PriceBoardBroker;
  dryReference?: (evaluatedAtMs: number) => PaperDryReferenceSnapshot;
  now?: Clock;
}

function quoteObservedAt(preview: PaperPreview): number | null {
  if (!preview.directional) return null;
  return Math.min(preview.directional.receivedAtMs, preview.anchor?.receivedAtMs ?? preview.directional.receivedAtMs);
}

function displayBuyFromSellPreview(preview: PaperPreview): PaperPreview | null {
  const anchor = preview.anchor;
  if (preview.status !== "READY" || !anchor) return null;
  const estimatedOutputSOL = new Decimal(anchor.amountOutAtomic).div(1_000_000_000).toFixed(9);
  const minimumOutputAmount = anchor.minimumAmountOutAtomic === null
    ? null
    : new Decimal(anchor.minimumAmountOutAtomic).div(1_000_000_000).toFixed(9);
  const price = new Decimal(PAPER_NOTIONAL_QUOTE).div(estimatedOutputSOL).toFixed(6);
  return {
    ...preview,
    previewId: `${preview.previewId}:display-buy`,
    side: "BUY",
    expiresAtMs: anchor.receivedAtMs + PAPER_PREVIEW_TTL_MS,
    quoteAgeMs: 0,
    recordable: false,
    anchor: null,
    directional: anchor,
    inputAmountSOL: null,
    estimatedOutputSOL,
    estimatedOutputUSDC: null,
    minimumOutputAmount,
    referencePxQuotePerSol: price,
    effectivePxQuotePerSol: price,
    routeSummary: ["0x · ExactIn", ...anchor.routeSummary].slice(0, 9)
  };
}

function unavailable(side: PaperSide, failure: PaperFailureCode | null, reason: PaperDisplayPrice["reason"]): PaperDisplayPrice {
  return {
    side,
    status: "UNAVAILABLE",
    priceQuotePerSol: null,
    provider: null,
    source: null,
    observedAtMs: null,
    ageMs: null,
    upstreamFailure: failure,
    reason,
    dryAssumptionBps: null,
    recordable: false
  };
}

export class PaperPriceBoard {
  readonly #mode: RuntimeMode;
  readonly #broker: PriceBoardBroker;
  readonly #dryReference: (evaluatedAtMs: number) => PaperDryReferenceSnapshot;
  readonly #now: Clock;
  readonly #sides: Record<PaperSide, SideState> = {
    BUY: { latest: null, lastSuccess: null },
    SELL: { latest: null, lastSuccess: null }
  };
  #lastAttemptAtMs: number | null = null;
  #nextAttemptAtMs: number | null = null;
  #refresh: Promise<void> | null = null;
  #sequence = 0;

  constructor(options: PaperPriceBoardOptions) {
    this.#mode = options.mode;
    this.#broker = options.broker;
    this.#now = options.now ?? Date.now;
    this.#dryReference = options.dryReference ?? ((evaluatedAtMs) => {
      const reference = this.#broker.reference(evaluatedAtMs);
      return reference.status === "READY" && reference.priceQuotePerSol
        ? { status: "READY", source: "bitquery-wsol-usdc", priceQuotePerSol: reference.priceQuotePerSol, observedAtMs: reference.evaluatedAtMs, reason: null }
        : { status: "UNAVAILABLE", source: null, priceQuotePerSol: null, observedAtMs: null, reason: reference.reason };
    });
  }

  async current(): Promise<PaperPriceBoardSnapshot> {
    const now = this.#now();
    if (this.#nextAttemptAtMs === null || now >= this.#nextAttemptAtMs) {
      await this.refresh();
    } else if (this.#refresh) {
      await this.#refresh;
    }
    return this.snapshot();
  }

  async refresh(): Promise<void> {
    if (this.#refresh) return this.#refresh;
    this.#lastAttemptAtMs = this.#now();
    const sequence = ++this.#sequence;
    this.#refresh = this.#broker.preview({
        side: "SELL",
        provider: "zeroex",
        idempotencyKey: `price-board:sell:${this.#lastAttemptAtMs}:${sequence}`,
        primaryFailureId: null
      }).then((latest) => {
        const buy = displayBuyFromSellPreview(latest);
        this.#sides.SELL.latest = latest;
        this.#sides.BUY.latest = buy ?? latest;
        if (latest.status === "READY") this.#sides.SELL.lastSuccess = latest;
        if (buy) this.#sides.BUY.lastSuccess = buy;
        const code = latest.failure?.code;
        const retryMs = code === "PROVIDER_HTTP_429"
          ? 30_000
          : code === "PROVIDER_TIMEOUT" || code === "PROVIDER_NETWORK_ERROR"
            ? 10_000
            : PAPER_PRICE_REFRESH_MS;
        this.#nextAttemptAtMs = (this.#lastAttemptAtMs as number) + retryMs;
      }).finally(() => { this.#refresh = null; });
    return this.#refresh;
  }

  snapshot(): PaperPriceBoardSnapshot {
    const now = this.#now();
    const reference = this.#dryReference(now);
    return {
      schemaVersion: 1,
      mode: this.#mode,
      pair: PAPER_PAIR,
      targetNotionalQuote: PAPER_NOTIONAL_QUOTE,
      refreshIntervalMs: PAPER_PRICE_REFRESH_MS,
      refreshedAtMs: this.#lastAttemptAtMs,
      nextRefreshAtMs: this.#nextAttemptAtMs,
      buy: this.#display("BUY", reference, now),
      sell: this.#display("SELL", reference, now)
    };
  }

  #display(side: PaperSide, reference: PaperDryReferenceSnapshot, now: number): PaperDisplayPrice {
    const state = this.#sides[side];
    const latestFailure = state.latest?.failure?.code ?? null;
    if (state.latest?.status === "READY" && state.latest.effectivePxQuotePerSol) {
      const observedAtMs = quoteObservedAt(state.latest);
      const ageMs = observedAtMs === null ? null : Math.max(0, now - observedAtMs);
      if (ageMs !== null && ageMs <= PAPER_PRICE_STALE_MS) {
        return {
          side,
          status: ageMs <= PAPER_PRICE_REFRESH_MS * 2 ? "LIVE" : "STALE",
          priceQuotePerSol: state.latest.effectivePxQuotePerSol,
          provider: state.latest.provider,
          source: this.#mode === "REPLAY" ? "replay-estimate" : "zeroex-estimate",
          observedAtMs,
          ageMs,
          upstreamFailure: null,
          reason: null,
          dryAssumptionBps: null,
          recordable: false
        };
      }
    }

    if (reference.status === "READY" && reference.priceQuotePerSol) {
      const multiplier = new Decimal(1).plus(new Decimal(side === "BUY" ? PAPER_DRY_HALF_SPREAD_BPS : -PAPER_DRY_HALF_SPREAD_BPS).div(10_000));
      return {
        side,
        status: "DRY",
        priceQuotePerSol: new Decimal(reference.priceQuotePerSol).mul(multiplier).toFixed(6),
        provider: null,
        source: reference.source === "coinbase-sol-usd" ? "coinbase-dry" : "bitquery-dry",
        observedAtMs: reference.observedAtMs,
        ageMs: reference.observedAtMs === null ? null : Math.max(0, now - reference.observedAtMs),
        upstreamFailure: latestFailure,
        reason: latestFailure,
        dryAssumptionBps: PAPER_DRY_HALF_SPREAD_BPS,
        recordable: false
      };
    }

    const lastSuccess = state.lastSuccess;
    if (lastSuccess?.effectivePxQuotePerSol) {
      const observedAtMs = quoteObservedAt(lastSuccess);
      const ageMs = observedAtMs === null ? null : Math.max(0, now - observedAtMs);
      if (ageMs !== null && ageMs <= PAPER_PRICE_STALE_MS) {
        return {
          side,
          status: "STALE",
          priceQuotePerSol: lastSuccess.effectivePxQuotePerSol,
          provider: lastSuccess.provider,
          source: this.#mode === "REPLAY" ? "replay-estimate" : "zeroex-estimate",
          observedAtMs,
          ageMs,
          upstreamFailure: latestFailure,
          reason: latestFailure,
          dryAssumptionBps: null,
          recordable: false
        };
      }
    }

    return unavailable(side, latestFailure, latestFailure ?? reference.reason);
  }
}
