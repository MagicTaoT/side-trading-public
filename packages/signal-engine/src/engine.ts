import Decimal from "decimal.js";
import type { MarketEvent } from "@side/market-core";
import { S0_V1_CONFIG } from "./config.js";
import {
  S0_SEGMENTS,
  type FeatureDirection,
  type FlowImbalanceFeature,
  type JurySnapshot,
  type JuryVote,
  type PriceImpulseFeature,
  type S0Segment,
  type S0SignalConfig,
  type SignalSnapshot,
  type SignalTransition,
  type Verdict,
  type VerdictSnapshot
} from "./contracts.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

interface PriceSample {
  atMs: number;
  value: Decimal;
}

interface FlowSample {
  atMs: number;
  side: "buy" | "sell";
  notionalQuote: Decimal;
}

interface TransportState {
  connection: "connecting" | "live" | "reconnecting" | "closed";
  quality: "fresh" | "degraded" | "stale" | "gap";
  lastSeenAtMs: number;
}

interface SegmentState {
  prices: PriceSample[];
  flows: FlowSample[];
  transport: TransportState | null;
  sourceProviders: Set<string>;
}

function emptySegmentState(): SegmentState {
  return { prices: [], flows: [], transport: null, sourceProviders: new Set<string>() };
}

function segmentFor(event: MarketEvent): S0Segment {
  if (event.source.provider === "hyperliquid") return "defi-perp";
  if (event.segment === "dex-spot") return "dex-spot";
  return event.segment === "perp" ? "cex-perp" : "cex-spot";
}

function fixed(value: Decimal, places: number): string {
  return value.toDecimalPlaces(places).toFixed(places);
}

function direction(value: Decimal, threshold: Decimal): FeatureDirection {
  if (value.gt(threshold)) return "BUY";
  if (value.lt(threshold.negated())) return "SELL";
  return "NEUTRAL";
}

function unavailablePriceFeature(): PriceImpulseFeature {
  return {
    status: "warming",
    valueBps: null,
    direction: "NEUTRAL",
    anchorAtMs: null,
    latestAtMs: null
  };
}

function unavailableFlowFeature(minimumNotionalQuote: string): FlowImbalanceFeature {
  return {
    status: "missing",
    value: null,
    direction: "NEUTRAL",
    totalNotionalQuote: "0.00",
    minimumNotionalQuote
  };
}

function semanticJuryKey(jury: JurySnapshot): string {
  return JSON.stringify({
    dataState: jury.dataState,
    vote: jury.vote,
    sourceProviders: jury.sourceProviders,
    features: jury.features,
    reasons: jury.reasons
  });
}

export class S0SignalEngine {
  readonly config: S0SignalConfig;
  #states = new Map<S0Segment, SegmentState>();
  #juries = new Map<S0Segment, JurySnapshot>();
  #verdict: VerdictSnapshot;
  #lastValidVerdict: Exclude<Verdict, "INSUFFICIENT_DATA"> | null = null;
  #nowMs = 0;
  #asOfIngestSeq = "0";

  constructor(config: S0SignalConfig = S0_V1_CONFIG) {
    this.config = config;
    for (const segment of S0_SEGMENTS) this.#states.set(segment, emptySegmentState());
    for (const segment of S0_SEGMENTS) this.#juries.set(segment, this.#computeJury(segment));
    this.#verdict = this.#computeVerdict();
  }

  reset(): void {
    this.#states.clear();
    this.#juries.clear();
    this.#lastValidVerdict = null;
    this.#nowMs = 0;
    this.#asOfIngestSeq = "0";
    for (const segment of S0_SEGMENTS) this.#states.set(segment, emptySegmentState());
    for (const segment of S0_SEGMENTS) this.#juries.set(segment, this.#computeJury(segment));
    this.#verdict = this.#computeVerdict();
  }

  ingest(event: MarketEvent): SignalTransition[] {
    this.#nowMs = Math.max(this.#nowMs, event.receivedAtUnixMs);
    this.#asOfIngestSeq = event.ingestSeq;
    this.#record(event);
    this.#prune();

    return this.#recompute(event.ingestSeq);
  }

  tick(evaluatedAtMs: number): SignalTransition[] {
    if (!Number.isSafeInteger(evaluatedAtMs) || evaluatedAtMs < this.#nowMs) {
      throw new RangeError("Signal clock must advance monotonically in integer milliseconds");
    }
    this.#nowMs = evaluatedAtMs;
    this.#prune();
    return this.#recompute(this.#asOfIngestSeq);
  }

  snapshot(): SignalSnapshot {
    return {
      modelVersion: this.config.modelVersion,
      evaluatedAtMs: this.#nowMs,
      asOfIngestSeq: this.#asOfIngestSeq,
      juries: S0_SEGMENTS.map((segment) => this.#juries.get(segment) as JurySnapshot),
      verdict: this.#verdict
    };
  }

  #recompute(asOfIngestSeq: string): SignalTransition[] {
    const transitions: SignalTransition[] = [];
    for (const segment of S0_SEGMENTS) {
      const previous = this.#juries.get(segment);
      const current = this.#computeJury(segment);
      this.#juries.set(segment, current);
      if (!previous || semanticJuryKey(previous) !== semanticJuryKey(current)) {
        transitions.push({ kind: "jury-changed", segment, asOfIngestSeq, current });
      }
    }

    const previousVerdict = this.#verdict.verdict;
    const currentVerdict = this.#computeVerdict();
    if (currentVerdict.dataState === "READY") {
      this.#lastValidVerdict = currentVerdict.verdict as Exclude<Verdict, "INSUFFICIENT_DATA">;
      currentVerdict.lastValidVerdict = null;
    } else {
      currentVerdict.lastValidVerdict = this.#lastValidVerdict;
    }
    this.#verdict = currentVerdict;
    if (previousVerdict !== currentVerdict.verdict) {
      transitions.push({
        kind: "verdict-changed",
        asOfIngestSeq,
        previous: previousVerdict,
        current: currentVerdict
      });
    }

    return transitions;
  }

  #record(event: MarketEvent): void {
    const segment = segmentFor(event);
    const state = this.#states.get(segment) as SegmentState;
    state.sourceProviders.add(event.source.provider);

    if (event.kind === "source-health") {
      state.transport = {
        connection: event.payload.connection,
        quality: event.quality.state,
        lastSeenAtMs: this.#nowMs
      };
      return;
    }

    state.transport = {
      connection: "live",
      quality: event.quality.state,
      lastSeenAtMs: this.#nowMs
    };

    if (event.kind === "bbo") {
      const mid = new Decimal(event.payload.bidPx).plus(event.payload.askPx).div(2);
      state.prices.push({ atMs: this.#nowMs, value: mid });
    } else if (event.kind === "trade" && event.payload.aggressor !== "unknown") {
      const notionalQuote = new Decimal(event.payload.px).mul(event.payload.sizeSOL);
      state.flows.push({ atMs: this.#nowMs, side: event.payload.aggressor, notionalQuote });
    } else if (event.kind === "onchain-swap") {
      state.prices.push({ atMs: this.#nowMs, value: new Decimal(event.payload.effectivePxQuotePerSol) });
      const stableAtomic = event.payload.side === "buy-sol" ? event.payload.amountInAtomic : event.payload.amountOutAtomic;
      state.flows.push({
        atMs: this.#nowMs,
        side: event.payload.side === "buy-sol" ? "buy" : "sell",
        notionalQuote: new Decimal(stableAtomic).div(1_000_000)
      });
    }
  }

  #prune(): void {
    const priceCutoff = this.#nowMs - this.config.retentionMs;
    const flowCutoff = this.#nowMs - this.config.windowMs;
    for (const state of this.#states.values()) {
      state.prices = state.prices.filter(({ atMs }) => atMs >= priceCutoff);
      state.flows = state.flows.filter(({ atMs }) => atMs > flowCutoff);
    }
  }

  #computeJury(segment: S0Segment): JurySnapshot {
    const state = this.#states.get(segment) as SegmentState;
    const minimumNotionalQuote = this.config.minimumNotionalQuote[segment];
    const sourceProviders = [...state.sourceProviders].sort();
    const transport = state.transport;
    const transportFresh =
      transport !== null &&
      transport.connection === "live" &&
      transport.quality === "fresh" &&
      this.#nowMs - transport.lastSeenAtMs <= this.config.freshnessMs;

    const features = {
      priceImpulse30s: this.#priceFeature(state),
      aggressorImbalance30s: this.#flowFeature(state, minimumNotionalQuote)
    };

    if (!transportFresh) {
      const reason =
        transport === null
          ? "SOURCE_NOT_OBSERVED"
          : transport.quality === "gap"
            ? "SOURCE_GAP"
            : transport.connection !== "live"
              ? "SOURCE_DISCONNECTED"
              : "SOURCE_STALE";
      return {
        modelVersion: this.config.modelVersion,
        segment,
        dataState: "UNAVAILABLE",
        vote: "NEUTRAL",
        evaluatedAtMs: this.#nowMs,
        asOfIngestSeq: this.#asOfIngestSeq,
        sourceProviders,
        limitedSourceCoverage: true,
        features,
        reasons: [reason, "LIMITED_SOURCE_COVERAGE"]
      };
    }

    const priceDirection = features.priceImpulse30s.direction;
    const flowDirection = features.aggressorImbalance30s.direction;
    const vote: JuryVote =
      features.priceImpulse30s.status === "available" &&
      features.aggressorImbalance30s.status === "available" &&
      priceDirection === flowDirection &&
      priceDirection !== "NEUTRAL"
        ? priceDirection
        : "NEUTRAL";
    const reasons: string[] = [];

    if (features.priceImpulse30s.status === "warming") reasons.push("PRICE_WINDOW_WARMING");
    else reasons.push(`PRICE_IMPULSE_${priceDirection}`);

    if (features.aggressorImbalance30s.status === "missing") reasons.push("QUIET_OR_NO_AGGRESSOR_FLOW");
    else if (features.aggressorImbalance30s.status === "below-minimum-volume") reasons.push("MINIMUM_VOLUME_NOT_MET");
    else reasons.push(`AGGRESSOR_FLOW_${flowDirection}`);

    if (
      features.priceImpulse30s.status === "available" &&
      features.aggressorImbalance30s.status === "available" &&
      priceDirection !== flowDirection
    ) {
      reasons.push("FEATURE_DISAGREEMENT");
    }
    reasons.push("LIMITED_SOURCE_COVERAGE");

    return {
      modelVersion: this.config.modelVersion,
      segment,
      dataState: "FRESH",
      vote,
      evaluatedAtMs: this.#nowMs,
      asOfIngestSeq: this.#asOfIngestSeq,
      sourceProviders,
      limitedSourceCoverage: true,
      features,
      reasons
    };
  }

  #priceFeature(state: SegmentState): PriceImpulseFeature {
    const latest = state.prices.at(-1);
    if (!latest) return unavailablePriceFeature();
    const cutoff = this.#nowMs - this.config.windowMs;
    const anchor = state.prices.filter(({ atMs }) => atMs <= cutoff).at(-1);
    if (!anchor || latest.atMs <= anchor.atMs || anchor.value.lte(0)) {
      return { ...unavailablePriceFeature(), latestAtMs: latest.atMs };
    }

    const valueBps = latest.value.div(anchor.value).minus(1).mul(10_000);
    return {
      status: "available",
      valueBps: fixed(valueBps, 8),
      direction: direction(valueBps, new Decimal(this.config.priceThresholdBps)),
      anchorAtMs: anchor.atMs,
      latestAtMs: latest.atMs
    };
  }

  #flowFeature(state: SegmentState, minimumNotionalQuote: string): FlowImbalanceFeature {
    let buys = new Decimal(0);
    let sells = new Decimal(0);
    for (const flow of state.flows) {
      if (flow.side === "buy") buys = buys.plus(flow.notionalQuote);
      else sells = sells.plus(flow.notionalQuote);
    }
    const total = buys.plus(sells);
    if (total.eq(0)) return unavailableFlowFeature(minimumNotionalQuote);

    const value = buys.minus(sells).div(total);
    const minimum = new Decimal(minimumNotionalQuote);
    if (total.lt(minimum)) {
      return {
        status: "below-minimum-volume",
        value: fixed(value, 8),
        direction: "NEUTRAL",
        totalNotionalQuote: fixed(total, 2),
        minimumNotionalQuote
      };
    }

    return {
      status: "available",
      value: fixed(value, 8),
      direction: direction(value, new Decimal(this.config.flowThreshold)),
      totalNotionalQuote: fixed(total, 2),
      minimumNotionalQuote
    };
  }

  #computeVerdict(): VerdictSnapshot {
    const juries = S0_SEGMENTS.map((segment) => this.#juries.get(segment) as JurySnapshot);
    const fresh = juries.filter(({ dataState }) => dataState === "FRESH");
    const buyJuryCount = fresh.filter(({ vote }) => vote === "BUY").length;
    const sellJuryCount = fresh.filter(({ vote }) => vote === "SELL").length;
    const neutralJuryCount = fresh.filter(({ vote }) => vote === "NEUTRAL").length;
    const dataState = fresh.length >= 3 ? "READY" : "INSUFFICIENT_DATA";
    const verdict: Verdict =
      dataState === "INSUFFICIENT_DATA"
        ? "INSUFFICIENT_DATA"
        : buyJuryCount >= 3
          ? "BUY_BIAS"
          : sellJuryCount >= 3
            ? "SELL_BIAS"
            : "NO_EDGE";

    return {
      modelVersion: this.config.modelVersion,
      verdict,
      dataState,
      evaluatedAtMs: this.#nowMs,
      asOfIngestSeq: this.#asOfIngestSeq,
      freshJuryCount: fresh.length,
      buyJuryCount,
      sellJuryCount,
      neutralJuryCount,
      lastValidVerdict: dataState === "INSUFFICIENT_DATA" ? this.#lastValidVerdict : null,
      reasons:
        dataState === "INSUFFICIENT_DATA"
          ? [`FRESH_JURY_COUNT_${fresh.length}_OF_4`, "PAPER_PREVIEW_DISABLED"]
          : verdict === "NO_EDGE"
            ? ["THREE_OF_FOUR_ALIGNMENT_NOT_MET"]
            : [verdict === "BUY_BIAS" ? "THREE_OF_FOUR_BUY" : "THREE_OF_FOUR_SELL"]
    };
  }
}
