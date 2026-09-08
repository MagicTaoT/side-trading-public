import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { UiEvent } from "@side/market-core";
import type { JurySnapshot, S0Segment, SignalSnapshot, Verdict } from "@side/signal-engine";
import {
  bubbleAgeOpacity,
  bubbleVisualKey,
  clampedVolumeShare,
  mergeUiEvent,
  microBatchBubbleEvents,
  microBatchUiEvents,
  pruneUiEvents,
  seededVisual,
  VISUAL_BATCH_MS
} from "./state.js";
import {
  entryEdge,
  type PaperAction,
  type PaperApiOrder,
  type PaperProvider
} from "./performance.js";
import { StrategyPage } from "./strategy/StrategyPage.js";
import { BacktestPage } from "./backtest/BacktestPage.js";

interface SourceState {
  provider: string;
  connection: "connecting" | "live" | "reconnecting" | "closed";
  quality: "fresh" | "degraded" | "stale" | "gap";
  replay: boolean;
  eventCount: number;
  lastEventId: string;
  lastIngestSeq: string;
  lastSeenAtMs: number;
}

interface LegacyPaperPreview {
  schemaVersion: 1;
  previewId: string;
  mode: "LIVE" | "REPLAY";
  status: "READY" | "UNAVAILABLE";
  provider: "zeroex" | null;
  side: "buy-sol";
  pair: "SOL-USDC";
  targetNotionalQuote: "10000";
  estimatedOutputSOL: string | null;
  minimumOutputSOL: null;
  priceImpactBps: null;
  feeBreakdown: null;
  quoteAgeMs: number | null;
  routeSummary: string[];
  recordable: false;
  disabledReason: "PAPER_RECORD_ENTERS_SIDE_010" | "LIVE_QUOTE_NOT_REQUESTED";
}

interface PaperQuoteFailure {
  failureId: string;
  provider: PaperProvider;
  code: string;
  occurredAtMs: number;
  retriable: boolean;
  httpStatus: number | null;
}

interface PaperQuoteLeg {
  provider: PaperProvider;
  requestId: string;
  receivedAtMs: number;
  latencyMs: number;
  rawResponseHash: string;
  routeSummary: string[];
}

interface PaperApiPreview {
  schemaVersion: 1;
  previewId: string;
  mode: "LIVE" | "REPLAY";
  status: "READY" | "UNAVAILABLE";
  provider: PaperProvider;
  side: "BUY" | "SELL";
  pair: "SOL-USDC";
  targetNotionalQuote: "10000";
  createdAtMs: number;
  expiresAtMs: number | null;
  quoteAgeMs: number | null;
  recordable: boolean;
  primaryFailureId: string | null;
  failure: PaperQuoteFailure | null;
  anchor: PaperQuoteLeg | null;
  directional: PaperQuoteLeg | null;
  inputAmountSOL: string | null;
  estimatedOutputSOL: string | null;
  estimatedOutputUSDC: string | null;
  minimumOutputAmount: string | null;
  referencePxQuotePerSol: string | null;
  effectivePxQuotePerSol: string | null;
  routeSummary: string[];
  feeBreakdown: null;
}

interface PaperDisplayPrice {
  side: "BUY" | "SELL";
  status: "LIVE" | "STALE" | "DRY" | "UNAVAILABLE";
  priceQuotePerSol: string | null;
  provider: PaperProvider | null;
  source: "zeroex-estimate" | "replay-estimate" | "bitquery-dry" | "coinbase-dry" | null;
  observedAtMs: number | null;
  ageMs: number | null;
  upstreamFailure: string | null;
  reason: string | null;
  dryAssumptionBps: number | null;
  recordable: false;
}

interface PaperPriceBoardSnapshot {
  schemaVersion: 1;
  mode: "LIVE" | "REPLAY";
  pair: "SOL-USDC";
  targetNotionalQuote: "10000";
  refreshIntervalMs: 5000;
  refreshedAtMs: number | null;
  nextRefreshAtMs: number | null;
  buy: PaperDisplayPrice;
  sell: PaperDisplayPrice;
}

interface SegmentFlowSnapshot {
  segment: S0Segment;
  buyCount: number;
  sellCount: number;
  buyNotionalQuote: string;
  sellNotionalQuote: string;
}

interface FlowWindowSnapshot {
  windowMs: 300_000;
  evaluatedAtMs: number;
  segments: SegmentFlowSnapshot[];
}

interface RuntimeSnapshot {
  schemaVersion: 1;
  mode: "LIVE" | "REPLAY";
  cexProfile: "coinbase" | "binance" | "unavailable";
  replayStatus: "disabled" | "idle" | "running" | "completed" | "stopped";
  eventsIngested: number;
  lastIngestSeq: string | null;
  sources: SourceState[];
  recentUiEvents: UiEvent[];
  flow5m: FlowWindowSnapshot;
  signal: SignalSnapshot;
  paperPreview: LegacyPaperPreview;
}

type GatewayMessage =
  | { type: "state_snapshot"; snapshot: RuntimeSnapshot }
  | { type: "ui_event"; event: UiEvent }
  | { type: "source_health"; source: SourceState }
  | { type: "signal_state"; signal: SignalSnapshot }
  | { type: "flow_state"; flow: FlowWindowSnapshot }
  | { type: "resync_required"; snapshot: RuntimeSnapshot; suppressedCountByKind: Record<string, number> };

const emptyPaperPreview: LegacyPaperPreview = {
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
};

const initialSnapshot: RuntimeSnapshot = {
  schemaVersion: 1,
  mode: "REPLAY",
  cexProfile: "coinbase",
  replayStatus: "idle",
  eventsIngested: 0,
  lastIngestSeq: null,
  sources: [],
  recentUiEvents: [],
  flow5m: {
    windowMs: 300_000,
    evaluatedAtMs: 0,
    segments: (["cex-spot", "cex-perp", "dex-spot", "defi-perp"] as S0Segment[]).map((segment) => ({
      segment,
      buyCount: 0,
      sellCount: 0,
      buyNotionalQuote: "0.00",
      sellNotionalQuote: "0.00"
    }))
  },
  paperPreview: emptyPaperPreview,
  signal: {
    modelVersion: "s0-v1",
    evaluatedAtMs: 0,
    asOfIngestSeq: "0",
    juries: (["cex-spot", "cex-perp", "dex-spot", "defi-perp"] as S0Segment[]).map(
      (segment): JurySnapshot => ({
        modelVersion: "s0-v1",
        segment,
        dataState: "UNAVAILABLE",
        vote: "NEUTRAL",
        evaluatedAtMs: 0,
        asOfIngestSeq: "0",
        sourceProviders: [],
        limitedSourceCoverage: true,
        features: {
          priceImpulse30s: {
            status: "warming",
            valueBps: null,
            direction: "NEUTRAL",
            anchorAtMs: null,
            latestAtMs: null
          },
          aggressorImbalance30s: {
            status: "missing",
            value: null,
            direction: "NEUTRAL",
            totalNotionalQuote: "0.00",
            minimumNotionalQuote: "1000"
          }
        },
        reasons: ["SOURCE_NOT_OBSERVED", "LIMITED_SOURCE_COVERAGE"]
      })
    ),
    verdict: {
      modelVersion: "s0-v1",
      verdict: "INSUFFICIENT_DATA",
      dataState: "INSUFFICIENT_DATA",
      evaluatedAtMs: 0,
      asOfIngestSeq: "0",
      freshJuryCount: 0,
      buyJuryCount: 0,
      sellJuryCount: 0,
      neutralJuryCount: 0,
      lastValidVerdict: null,
      reasons: ["FRESH_JURY_COUNT_0_OF_4", "PAPER_PREVIEW_DISABLED"]
    }
  }
};

const segmentMeta: Record<S0Segment, { label: string; eyebrow: string; zone: UiEvent["zone"]; sourceHint: string }> = {
  "cex-spot": { label: "CEX SPOT", eyebrow: "CENTRALIZED · SPOT", zone: "cex-spot", sourceHint: "Coinbase atomic profile" },
  "cex-perp": { label: "CEX PERP", eyebrow: "CENTRALIZED · PERPETUAL", zone: "cex-perps", sourceHint: "Coinbase Derivatives SLP" },
  "dex-spot": { label: "DEX SPOT", eyebrow: "SOLANA · REALIZED FLOW", zone: "dex-spot", sourceHint: "Bitquery decoded WSOL/USDC" },
  "defi-perp": { label: "DEFI PERP", eyebrow: "ONCHAIN · PERPETUAL", zone: "defi-perps", sourceHint: "Hyperliquid SOL perp" }
};

function upsertSource(sources: SourceState[], next: SourceState): SourceState[] {
  return [...sources.filter(({ provider }) => provider !== next.provider), next].sort((left, right) =>
    left.provider.localeCompare(right.provider)
  );
}

function maxSequence(left: string | null, right: string): string {
  return left === null || BigInt(right) > BigInt(left) ? right : left;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1_000 ? 0 : 2,
    notation: value >= 1_000_000 ? "compact" : "standard"
  }).format(value);
}

function verdictClass(verdict: Verdict): string {
  if (verdict === "BUY_BIAS") return "buy";
  if (verdict === "SELL_BIAS") return "sell";
  if (verdict === "NO_EDGE") return "neutral";
  return "warning";
}

function agreementLabel(snapshot: SignalSnapshot): string {
  const { verdict } = snapshot;
  if (verdict.verdict === "INSUFFICIENT_DATA") return "COVERAGE NOT READY";
  if (verdict.verdict === "NO_EDGE" && verdict.buyJuryCount > 0 && verdict.sellJuryCount > 0) return "MARKET DISAGREEMENT";
  if (verdict.verdict === "NO_EDGE") return "NO CROSS-MARKET EDGE";
  return `${Math.max(verdict.buyJuryCount, verdict.sellJuryCount)}/4 JURIES ALIGNED`;
}

function sourceAge(source: SourceState | undefined, evaluatedAtMs: number): string {
  if (!source) return "NOT SEEN";
  const age = Math.max(0, evaluatedAtMs - source.lastSeenAtMs);
  return age < 1_000 ? `${age}MS` : `${(age / 1_000).toFixed(1)}S`;
}

function dataAge(sources: SourceState[], evaluatedAtMs: number): string {
  const lastSeenAtMs = Math.max(0, ...sources.map(({ lastSeenAtMs: seenAtMs }) => seenAtMs));
  if (lastSeenAtMs === 0 || evaluatedAtMs === 0) return "—";
  return sourceAge({ lastSeenAtMs } as SourceState, evaluatedAtMs);
}

function notionalFor(events: UiEvent[]): number {
  return events.reduce((total, event) => total + Number(event.buyNotional ?? 0) + Number(event.sellNotional ?? 0), 0);
}

function eventAgeLabel(event: UiEvent, evaluatedAtMs: number): string {
  const ageMs = Math.max(0, evaluatedAtMs - event.batchEndMs);
  return ageMs < 1_000 ? `${ageMs}MS AGO` : `${(ageMs / 1_000).toFixed(1)}S AGO`;
}

function bubbleAuditLabel(event: UiEvent, evaluatedAtMs: number): string {
  const notional = notionalFor([event]);
  const px = event.minPx
    ? `$${event.minPx}${event.maxPx && event.maxPx !== event.minPx ? `–$${event.maxPx}` : ""}`
    : "PRICE UNAVAILABLE";
  return `${event.sourceProvider} · ${event.instrumentId} · ${event.tradeSide ?? "unknown"} · ×${event.count} · ${notional > 0 ? money(notional) : "NOTIONAL UNAVAILABLE"} · ${px} · ${eventAgeLabel(event, evaluatedAtMs)}`;
}

function leadingLabel(events: UiEvent[], juries: JurySnapshot[]): string {
  const freshZones = new Set(juries.filter(({ dataState }) => dataState === "FRESH").map(({ segment }) => segmentMeta[segment].zone));
  const firstEconomic = events
    .filter(({ zone, kind, tradeSide }) => freshZones.has(zone) && (kind === "trade" || kind === "onchain-swap") && tradeSide !== "unknown")
    .sort((left, right) => left.batchStartMs - right.batchStartMs)[0];
  if (!firstEconomic) return "NO LEADER YET";
  const segment = (Object.keys(segmentMeta) as S0Segment[]).find((candidate) => segmentMeta[candidate].zone === firstEconomic.zone);
  return segment ? segmentMeta[segment].label : firstEconomic.venueLabel.toUpperCase();
}

function narrative(signal: SignalSnapshot): string {
  const fresh = signal.juries.filter(({ dataState }) => dataState === "FRESH");
  const buyFlow = fresh.filter(({ features }) => features.aggressorImbalance30s.direction === "BUY").length;
  const sellFlow = fresh.filter(({ features }) => features.aggressorImbalance30s.direction === "SELL").length;
  if (signal.verdict.verdict === "INSUFFICIENT_DATA") {
    return `${signal.verdict.freshJuryCount}/4 juries fresh. ${buyFlow} show buy flow, ${sellFlow} show sell flow; unavailable markets block a directional verdict.`;
  }
  if (signal.verdict.verdict === "NO_EDGE") return "Fresh juries do not reach 3/4 directional agreement. Waiting is a valid decision.";
  return signal.verdict.verdict === "BUY_BIAS"
    ? "Price and aggressor flow align across at least three fresh market juries."
    : "Selling pressure aligns across at least three fresh market juries.";
}

type PowerSide = "buy" | "sell";
type PowerMarket = "spot" | "perp";
type VisualWindowMs = 30_000 | 60_000 | 180_000 | 300_000;

const visualWindowOptions: readonly { label: string; value: VisualWindowMs }[] = [
  { label: "30S", value: 30_000 },
  { label: "60S", value: 60_000 },
  { label: "3M", value: 180_000 },
  { label: "5M", value: 300_000 }
];

function visualWindowLabel(windowMs: VisualWindowMs): string {
  return visualWindowOptions.find(({ value }) => value === windowMs)?.label ?? "60S";
}

const powerSegments: Record<PowerMarket, readonly S0Segment[]> = {
  spot: ["cex-spot", "dex-spot"],
  perp: ["cex-perp", "defi-perp"]
};

function panelLabel(segment: S0Segment): string {
  if (segment === "dex-spot") return "DEX";
  if (segment === "defi-perp") return "DEFI";
  return "CEX";
}

function sideFlow(flow: SegmentFlowSnapshot | undefined, side: PowerSide): { count: number; notional: number } {
  if (!flow) return { count: 0, notional: 0 };
  return side === "buy"
    ? { count: flow.buyCount, notional: Number(flow.buyNotionalQuote) }
    : { count: flow.sellCount, notional: Number(flow.sellNotionalQuote) };
}

interface PowerCellProps {
  segment: S0Segment;
  side: PowerSide;
  jury: JurySnapshot;
  flow: SegmentFlowSnapshot | undefined;
  groupNotional: number;
  events: UiEvent[];
  sources: SourceState[];
  evaluatedAtMs: number;
  windowMs: number;
}

function PowerCell({ segment, side, jury, flow, groupNotional, events, sources, evaluatedAtMs, windowMs }: PowerCellProps) {
  const [inspectedBubble, setInspectedBubble] = useState<string | null>(null);
  const meta = segmentMeta[segment];
  const laneEvents = events.filter(({ zone, kind, tradeSide }) =>
    zone === meta.zone && (kind === "trade" || kind === "onchain-swap") && tradeSide === side
  );
  const stats = sideFlow(flow, side);
  const share = groupNotional > 0 ? stats.notional / groupNotional * 100 : 0;
  const providers = jury.sourceProviders.length > 0 ? jury.sourceProviders : laneEvents.map(({ sourceProvider }) => sourceProvider);
  const providerSet = [...new Set(providers)];
  const source = sources.find(({ provider }) => providerSet.includes(provider));
  const inspectedEvent = laneEvents.find((event) => bubbleVisualKey(event) === inspectedBubble) ?? null;

  return (
    <section className={`power-cell ${side} ${jury.dataState.toLowerCase()}`} aria-label={`${panelLabel(segment)} ${side} power`}>
      <div className="power-cell-heading">
        <h3>{panelLabel(segment)} <i className={jury.dataState === "FRESH" ? "fresh" : ""} /></h3>
        <span className={`mini-vote ${jury.vote.toLowerCase()}`}>{jury.vote}</span>
      </div>
      <div className="power-cell-stats">
        <span><strong>{stats.count.toLocaleString()}</strong> events</span>
        <span><strong>{stats.notional > 0 ? money(stats.notional) : "—"}</strong></span>
        <span className="share"><strong>{share.toFixed(1)}%</strong></span>
      </div>
      <div className={`bubble-field power-bubbles ${side}`}>
        {laneEvents.length === 0 ? <div className="lane-empty"><span>{jury.dataState === "FRESH" ? "LIVE · NO RECENT TRADES" : "AWAITING SOURCE"}</span><small>{meta.sourceHint}</small></div> : null}
        {laneEvents.map((event) => {
          const visual = seededVisual(event);
          const style = {
            "--bubble-x": `${visual.xPercent}%`,
            "--bubble-y": `${visual.yPercent}%`,
            "--bubble-size": `${visual.diameterPx}px`,
            "--bubble-delay": `${visual.delayMs}ms`,
            "--bubble-opacity": bubbleAgeOpacity(event, evaluatedAtMs, windowMs).toFixed(3)
          } as CSSProperties;
          return (
            <div
              className={`trade-bubble ${side}`}
              key={bubbleVisualKey(event)}
              style={style}
              tabIndex={0}
              aria-label={bubbleAuditLabel(event, evaluatedAtMs)}
              title={bubbleAuditLabel(event, evaluatedAtMs)}
              onPointerEnter={() => setInspectedBubble(bubbleVisualKey(event))}
              onPointerLeave={() => setInspectedBubble(null)}
              onFocus={() => setInspectedBubble(bubbleVisualKey(event))}
              onBlur={() => setInspectedBubble(null)}
            >
              <strong>×{event.count}</strong><span>{event.venueLabel}</span>
            </div>
          );
        })}
        {inspectedEvent ? <div className="bubble-inspector" role="status"><strong>{inspectedEvent.sourceProvider.toUpperCase()} · {inspectedEvent.instrumentId}</strong><span>{(inspectedEvent.tradeSide ?? side).toUpperCase()} ×{inspectedEvent.count} · {notionalFor([inspectedEvent]) > 0 ? money(notionalFor([inspectedEvent])) : "NOTIONAL —"}</span><span>{inspectedEvent.minPx ? `$${inspectedEvent.minPx}${inspectedEvent.maxPx && inspectedEvent.maxPx !== inspectedEvent.minPx ? `–$${inspectedEvent.maxPx}` : ""}` : "PRICE —"} · {eventAgeLabel(inspectedEvent, evaluatedAtMs)}</span></div> : null}
      </div>
      <div className="power-cell-footer">
        <span>{providerSet.length > 0 ? providerSet.join(" + ").toUpperCase() : meta.sourceHint.toUpperCase()}</span>
        <strong>{sourceAge(source, evaluatedAtMs)}</strong>
      </div>
    </section>
  );
}

interface PowerQuadrantProps {
  market: PowerMarket;
  side: PowerSide;
  flow5m: FlowWindowSnapshot;
  juries: JurySnapshot[];
  events: UiEvent[];
  sources: SourceState[];
  visualWindowMs: VisualWindowMs;
}

function PowerQuadrant({ market, side, flow5m, juries, events, sources, visualWindowMs }: PowerQuadrantProps) {
  const segments = powerSegments[market];
  const flows = segments.map((segment) => flow5m.segments.find((candidate) => candidate.segment === segment));
  const totalNotional = flows.reduce((sum, flow) => sum + sideFlow(flow, side).notional, 0);
  const firstCellNotional = sideFlow(flows[0], side).notional;
  const firstCellShare = clampedVolumeShare(firstCellNotional, totalNotional - firstCellNotional, 30, 70);
  const cellGridStyle = {
    "--first-cell-share": `${firstCellShare}%`,
    "--second-cell-share": `${100 - firstCellShare}%`
  } as CSSProperties;

  return (
    <article className={`power-quadrant ${market}-${side} ${side}`} aria-label={`${market} ${side} power`}>
      <div className="power-quadrant-heading">
        <h2>{market.toUpperCase()} · {side.toUpperCase()} POWER</h2>
        <span>5M {side.toUpperCase()} VOLUME <strong>{totalNotional > 0 ? money(totalNotional) : "—"}</strong></span>
      </div>
      <div className="power-cell-grid" style={cellGridStyle}>
        {segments.map((segment) => (
          <PowerCell
            key={`${segment}:${side}`}
            segment={segment}
            side={side}
            jury={juries.find((candidate) => candidate.segment === segment) as JurySnapshot}
            flow={flow5m.segments.find((candidate) => candidate.segment === segment)}
            groupNotional={totalNotional}
            events={events}
            sources={sources}
            evaluatedAtMs={flow5m.evaluatedAtMs}
            windowMs={visualWindowMs}
          />
        ))}
      </div>
    </article>
  );
}

interface PowerRowProps {
  market: PowerMarket;
  flow5m: FlowWindowSnapshot;
  juries: JurySnapshot[];
  events: UiEvent[];
  sources: SourceState[];
  visualWindowMs: VisualWindowMs;
}

function PowerRow({ market, flow5m, juries, events, sources, visualWindowMs }: PowerRowProps) {
  const marketSegments = new Set(powerSegments[market]);
  const marketFlows = flow5m.segments.filter(({ segment }) => marketSegments.has(segment));
  const buyNotional = marketFlows.reduce((total, flow) => total + Number(flow.buyNotionalQuote), 0);
  const sellNotional = marketFlows.reduce((total, flow) => total + Number(flow.sellNotionalQuote), 0);
  const buyShare = clampedVolumeShare(buyNotional, sellNotional, 35, 65);
  const rowStyle = {
    "--buy-quadrant-share": `${buyShare}%`,
    "--sell-quadrant-share": `${100 - buyShare}%`
  } as CSSProperties;

  return (
    <div className={`power-row ${market}`} style={rowStyle}>
      <PowerQuadrant market={market} side="buy" flow5m={flow5m} juries={juries} events={events} sources={sources} visualWindowMs={visualWindowMs} />
      <PowerQuadrant market={market} side="sell" flow5m={flow5m} juries={juries} events={events} sources={sources} visualWindowMs={visualWindowMs} />
    </div>
  );
}

async function responseBody<T>(response: Response, field: string): Promise<T> {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = typeof body.error === "object" && body.error !== null ? body.error as Record<string, unknown> : null;
    throw new Error(typeof error?.code === "string" ? error.code : `HTTP_${response.status}`);
  }
  return body[field] as T;
}

function requestKey(): string {
  return crypto.randomUUID();
}

interface PaperPriceTileProps {
  side: "BUY" | "SELL";
  price: PaperDisplayPrice | null;
  loading: boolean;
  nowMs: number;
}

function PaperPriceTile({ side, price, loading, nowMs }: PaperPriceTileProps) {
  const ageMs = price?.observedAtMs === null || price?.observedAtMs === undefined
    ? null
    : Math.max(0, nowMs - price.observedAtMs);
  const age = ageMs === null ? null : ageMs < 1_000 ? `${ageMs}MS` : `${(ageMs / 1_000).toFixed(1)}S`;
  const source = !price
    ? "AWAITING 5S SNAPSHOT"
    : price.status === "DRY"
      ? `DRY · ${price.source === "coinbase-dry" ? "COINBASE USD" : "BITQUERY"} ${side === "BUY" ? "+" : "−"}${price.dryAssumptionBps ?? 0}BP`
      : price.source === "replay-estimate"
        ? `REPLAY EST. · ${age ?? "—"}`
        : price.status === "UNAVAILABLE"
          ? (price.reason ?? "QUOTE UNAVAILABLE").replaceAll("_", " ")
          : `0x ${price.status} · ${age ?? "—"}`;
  const title = price?.status === "DRY"
    ? `${price.source === "coinbase-dry" ? "Coinbase SOL-USD reference (USD/USDC basis not modeled)" : "Bitquery WSOL/USDC reference"} with a fixed 50 bps dry assumption. Display only; not executable or recordable.`
    : "Five-second display estimate. Display only.";

  return (
    <div className={`${side === "BUY" ? "buy-action" : "sell-action"} paper-price-action`} title={title} aria-label={`${side} paper reference price`}>
      <span>PAPER {side}</span>
      <strong>{price?.priceQuotePerSol ? `${money(Number(price.priceQuotePerSol))}` : "—"}</strong>
      <small>{loading ? "UPDATING · " : ""}{source}</small>
    </div>
  );
}

interface PaperDrawerProps { action: PaperAction; mode: "LIVE" | "REPLAY"; freshJuryCount: number; onClose: () => void; onRecorded: (order: PaperApiOrder) => void; }

function PaperDrawer({ action, mode, freshJuryCount, onClose, onRecorded }: PaperDrawerProps) {
  const [preview, setPreview] = useState<PaperApiPreview | null>(null);
  const [pending, setPending] = useState(action !== "WAIT");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [order, setOrder] = useState<PaperApiOrder | null>(null);
  const [recordPending, setRecordPending] = useState(false);
  const [clockMs, setClockMs] = useState(Date.now());
  const [initialPreviewKey] = useState(requestKey);
  const [recordKey, setRecordKey] = useState(requestKey);

  const loadPreview = useCallback(async (
    provider: PaperProvider,
    primaryFailureId: string | null,
    idempotencyKey = requestKey()
  ) => {
    setPending(true);
    setRequestError(null);
    setOrder(null);
    setRecordKey(requestKey());
    try {
      const response = await fetch("/api/paper-orders/preview", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ side: action, provider, primaryFailureId })
      });
      setPreview(await responseBody<PaperApiPreview>(response, "preview"));
      setClockMs(Date.now());
    } catch (reason) {
      setRequestError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }, [action]);

  useEffect(() => {
    if (action === "WAIT") return;
    void loadPreview("zeroex", null, initialPreviewKey);
  }, [action, initialPreviewKey, loadPreview]);

  useEffect(() => {
    if (action === "WAIT" || pending || order || preview?.provider === "jupiter") return;
    const timer = window.setTimeout(() => void loadPreview("zeroex", null), 5_000);
    return () => window.clearTimeout(timer);
  }, [action, loadPreview, order, pending, preview?.previewId, preview?.provider]);

  useEffect(() => {
    if (preview?.status !== "READY" && order?.markout.status !== "PENDING") return;
    const timer = window.setInterval(() => setClockMs(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [order?.markout.status, preview?.status]);

  useEffect(() => {
    if (!order || order.markout.status !== "PENDING") return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/paper-orders/${encodeURIComponent(order.orderId)}`);
        const current = await responseBody<PaperApiOrder>(response, "order");
        if (active) {
          setOrder(current);
          if (current.markout.status !== order.markout.status) onRecorded(current);
        }
      } catch {
        // The durable order remains visible; transient polling failures retry on the next interval.
      }
    };
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [onRecorded, order?.markout.status, order?.orderId]);

  const quoteAgeMs = preview?.directional
    ? Math.max(0, clockMs - Math.min(preview.directional.receivedAtMs, preview.anchor?.receivedAtMs ?? preview.directional.receivedAtMs))
    : null;
  const quoteFresh = preview?.status === "READY" && preview.expiresAtMs !== null && clockMs <= preview.expiresAtMs;
  const canFallback = preview?.status === "UNAVAILABLE" && preview.provider === "zeroex" &&
    preview.failure !== null && preview.failure.code !== "MARKET_DATA_NOT_READY";
  const marketReady = mode === "REPLAY" || freshJuryCount >= 3;
  const canRecord = marketReady && (action === "WAIT" || Boolean(preview?.recordable && quoteFresh));

  const record = async () => {
    setRecordPending(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/paper-orders", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": recordKey },
        body: JSON.stringify({
          action,
          previewId: action === "WAIT" ? null : preview?.previewId ?? null,
          provider: action === "WAIT" ? null : preview?.provider ?? null
        })
      });
      const recorded = await responseBody<PaperApiOrder>(response, "order");
      setOrder(recorded);
      onRecorded(recorded);
    } catch (reason) {
      setRequestError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRecordPending(false);
    }
  };

  const providerLabel = preview?.provider === "jupiter" ? "JUPITER FALLBACK" : "0x PRIMARY";
  const output = action === "BUY"
    ? preview?.estimatedOutputSOL ? `${Number(preview.estimatedOutputSOL).toFixed(4)} SOL` : "UNAVAILABLE"
    : preview?.estimatedOutputUSDC ? `${money(Number(preview.estimatedOutputUSDC))} USDC` : "UNAVAILABLE";
  const minimumOutput = preview?.minimumOutputAmount
    ? action === "BUY" ? `${Number(preview.minimumOutputAmount).toFixed(4)} SOL` : `${money(Number(preview.minimumOutputAmount))} USDC`
    : "NOT PROVIDED";
  const markoutLabel = order?.markout.status === "PENDING"
    ? `DUE IN ${Math.max(0, Math.ceil((order.markout.dueAtMs - clockMs) / 1_000))}S`
    : order?.markout.status === "SCORED" && order.markout.directionalMarkoutBps
      ? `${Number(order.markout.directionalMarkoutBps) >= 0 ? "+" : ""}${Number(order.markout.directionalMarkoutBps).toFixed(2)} BPS`
      : order?.markout.reason ?? "UNSCORED";

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="paper-drawer" role="dialog" aria-modal="true" aria-labelledby="paper-title">
        <div className="drawer-heading">
          <div><span className="kicker">{mode === "LIVE" ? "ACTION-TIME LIVE ESTIMATE" : "REPLAYED PREVIEW CONTRACT"}</span><h2 id="paper-title">{action === "WAIT" ? "RECORD WAIT" : `PAPER ${action}`}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close paper drawer">×</button>
        </div>
        <div className={`drawer-warning ${preview?.status === "READY" && quoteFresh ? "ready" : ""}`}>
          <strong>{!marketReady ? "MARKET DATA NOT READY" : pending ? "REQUESTING FRESH ESTIMATE" : action === "WAIT" ? "NO QUOTE REQUIRED" : preview?.status === "READY" ? quoteFresh ? "FRESH PAPER ESTIMATE" : "ESTIMATE EXPIRED" : preview?.failure?.code ?? "ESTIMATE UNAVAILABLE"}</strong>
          <span>{mode === "REPLAY" ? "Frozen replay response; " : ""}Zero signing, zero funds, nothing broadcast.</span>
        </div>
        {action === "WAIT" ? (
          <div className="wait-copy"><strong>No execution estimate required.</strong><p>The current verdict, four jury snapshots and source-health evidence will be captured as a deliberate WAIT decision.</p></div>
        ) : (
          <div className="preview-table">
            <div><span>DIRECTION</span><strong>{action} SOL</strong></div>
            <div><span>PAIR</span><strong>SOL-USDC</strong></div>
            <div><span>NOTIONAL</span><strong>$10,000 USDC</strong></div>
            <div><span>PROVIDER</span><strong>{preview ? providerLabel : "REQUESTING"}</strong></div>
            <div><span>QUOTE AGE / TTL</span><strong>{quoteAgeMs === null ? "—" : `${(quoteAgeMs / 1_000).toFixed(1)}S / 10.0S`}</strong></div>
            {action === "SELL" ? <div><span>ANCHOR-DERIVED INPUT</span><strong>{preview?.inputAmountSOL ? `${Number(preview.inputAmountSOL).toFixed(4)} SOL` : "—"}</strong></div> : null}
            <div className="emphasis-row"><span>ESTIMATED OUTPUT</span><strong>{pending ? "REQUESTING" : output}</strong></div>
            <div><span>MINIMUM OUTPUT</span><strong>{minimumOutput}</strong></div>
            <div><span>ESTIMATED EXECUTION PX</span><strong>{preview?.effectivePxQuotePerSol ? `${money(Number(preview.effectivePxQuotePerSol))} / SOL` : "—"}</strong></div>
            <div><span>ANCHOR / REFERENCE PX</span><strong>{preview?.referencePxQuotePerSol ? `${money(Number(preview.referencePxQuotePerSol))} / SOL` : "—"}</strong></div>
            <div><span>PRICE IMPACT</span><strong>{preview?.directional?.provider === "jupiter" ? "PROVIDER ESTIMATE" : "NOT PROVIDED BY 0x"}</strong></div>
            <div><span>FEE BREAKDOWN</span><strong>UNKNOWN · NOT FABRICATED</strong></div>
          </div>
        )}
        {preview?.status === "READY" ? <details open><summary>ESTIMATE AUDIT</summary><ul>{preview.routeSummary.map((line) => <li key={line}>{line}</li>)}{preview.anchor ? <li>Anchor request: {preview.anchor.requestId}</li> : null}{preview.directional ? <li>Directional request: {preview.directional.requestId}</li> : null}<li>Raw responses discarded after SHA-256 hashing</li></ul></details> : null}
        {canFallback ? <button className="fallback-button" type="button" disabled={pending} onClick={() => void loadPreview("jupiter", preview.failure?.failureId ?? null)}>TRY JUPITER ESTIMATE</button> : null}
        {action !== "WAIT" && (!preview || preview.status === "UNAVAILABLE" || !quoteFresh) ? <button className="refresh-button" type="button" disabled={pending} onClick={() => void loadPreview("zeroex", null)}>REFRESH 0x NOW · AUTO 5S</button> : null}
        {requestError ? <p className="inline-warning" role="alert">{requestError}</p> : null}
        {order ? <p className={`record-success ${order.markout.status.toLowerCase()}`}><strong>PERSISTED · {order.action} · ENTRY {entryEdge(order).label} · +5M {order.markout.status} · {markoutLabel}</strong><span>{order.orderId} · {order.persistence}{order.markout.entryReference.priceQuotePerSol ? ` · entry $${Number(order.markout.entryReference.priceQuotePerSol).toFixed(2)} from ${order.markout.entryReference.sampleCount} Bitquery swaps` : ` · entry reference ${order.markout.entryReference.reason ?? "unavailable"}`}</span></p> : null}
        <button className="record-button" type="button" disabled={!canRecord || pending || recordPending || order !== null} onClick={() => void record()}>{recordPending ? "RECORDING" : order ? "RECORDED" : action === "WAIT" ? "RECORD WAIT" : `RECORD PAPER ${action}`}</button>
        <p className="disabled-note">Paper evidence only. No wallet, signer, assembly, simulation or send path exists.</p>
      </aside>
    </div>
  );
}

function DashboardPage() {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [connection, setConnection] = useState<"CONNECTING" | "CONNECTED" | "RECONNECTING" | "DISCONNECTED">("CONNECTING");
  const [error, setError] = useState<string | null>(null);
  const [motionPaused, setMotionPaused] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);
  const [paperPrices, setPaperPrices] = useState<PaperPriceBoardSnapshot | null>(null);
  const [paperPricesLoading, setPaperPricesLoading] = useState(true);
  const [paperPriceClockMs, setPaperPriceClockMs] = useState(Date.now());
  const [visualWindowMs, setVisualWindowMs] = useState<VisualWindowMs>(60_000);
  const [windowSwitching, setWindowSwitching] = useState(true);
  const [websocketsEnabled, setWebsocketsEnabled] = useState(true);
  const [websocketGeneration, setWebsocketGeneration] = useState(0);
  const [websocketAction, setWebsocketAction] = useState<"disconnect" | "reconnect" | null>(null);
  const websocketRetryAttempt = useRef(0);

  const loadSnapshot = useCallback(async () => {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(`State fetch failed with HTTP ${response.status}`);
    setSnapshot((await response.json()) as RuntimeSnapshot);
  }, []);

  const loadPaperPrices = useCallback(async () => {
    setPaperPricesLoading(true);
    try {
      const response = await fetch("/api/paper-prices");
      setPaperPrices(await responseBody<PaperPriceBoardSnapshot>(response, "prices"));
      setPaperPriceClockMs(Date.now());
    } catch {
      // Keep the last display snapshot visible; the next five-second cycle retries.
    } finally {
      setPaperPricesLoading(false);
    }
  }, []);

  useEffect(() => {
    setWindowSwitching(true);
    const timer = window.setTimeout(() => setWindowSwitching(false), 850);
    return () => window.clearTimeout(timer);
  }, [visualWindowMs]);

  useEffect(() => {
    void loadPaperPrices();
    const quoteTimer = window.setInterval(() => void loadPaperPrices(), 5_000);
    const clockTimer = window.setInterval(() => setPaperPriceClockMs(Date.now()), 1_000);
    return () => { window.clearInterval(quoteTimer); window.clearInterval(clockTimer); };
  }, [loadPaperPrices]);

  useEffect(() => {
    if (!websocketsEnabled) {
      websocketRetryAttempt.current = 0;
      setConnection("DISCONNECTED");
      return;
    }
    let active = true;
    const pendingEvents: UiEvent[] = [];
    let flushTimer: number | undefined;
    let reconnectTimer: number | undefined;
    const flushPendingEvents = () => {
      flushTimer = undefined;
      const pending = pendingEvents.splice(0);
      if (!active || pending.length === 0) return;
      setSnapshot((current) => {
        let next = current;
        for (const event of pending) {
          const merged = mergeUiEvent(next.recentUiEvents, event);
          next = { ...next, eventsIngested: next.eventsIngested + (merged.added ? 1 : 0), lastIngestSeq: maxSequence(next.lastIngestSeq, event.streamSeq), recentUiEvents: merged.events };
        }
        return next;
      });
    };

    void loadSnapshot().catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    setConnection("CONNECTING");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    socket.addEventListener("open", () => {
      if (!active) return;
      websocketRetryAttempt.current = 0;
      setConnection("CONNECTED");
      setError(null);
    });
    socket.addEventListener("close", (event) => {
      if (!active) return;
      if (event.code === 4001) {
        websocketRetryAttempt.current = 0;
        setWebsocketsEnabled(false);
        setConnection("DISCONNECTED");
        return;
      }
      const attempt = websocketRetryAttempt.current++;
      const delayMs = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
      setConnection("RECONNECTING");
      reconnectTimer = window.setTimeout(() => {
        if (!active) return;
        setWebsocketGeneration((current) => current + 1);
      }, delayMs);
    });
    socket.addEventListener("error", () => { if (active) setConnection("RECONNECTING"); });
    socket.addEventListener("message", ({ data }) => {
      if (!active) return;
      try {
        const message = JSON.parse(String(data)) as GatewayMessage;
        if (message.type === "state_snapshot" || message.type === "resync_required") setSnapshot(message.snapshot);
        else if (message.type === "ui_event") { pendingEvents.push(message.event); flushTimer ??= window.setTimeout(flushPendingEvents, VISUAL_BATCH_MS); }
        else if (message.type === "source_health") setSnapshot((current) => ({ ...current, sources: upsertSource(current.sources, message.source) }));
        else if (message.type === "signal_state") setSnapshot((current) => ({ ...current, signal: message.signal }));
        else if (message.type === "flow_state") setSnapshot((current) => ({ ...current, flow5m: message.flow }));
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    });
    return () => {
      active = false;
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket.close();
    };
  }, [loadSnapshot, websocketGeneration, websocketsEnabled]);

  useEffect(() => {
    const handleVisibility = () => {
      const hidden = document.hidden;
      setPageHidden(hidden);
      if (!hidden) {
        void loadSnapshot().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
        void loadPaperPrices();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [loadPaperPrices, loadSnapshot]);

  const setReplay = useCallback(async (action: "start" | "stop") => {
    setError(null);
    const response = await fetch(`/api/replay/${action}`, { method: "POST" });
    if (!response.ok) throw new Error(`Replay ${action} failed with HTTP ${response.status}`);
    const body = (await response.json()) as { snapshot: RuntimeSnapshot };
    setSnapshot(body.snapshot);
  }, []);

  const controlWebsockets = useCallback(async (action: "disconnect" | "reconnect") => {
    setWebsocketAction(action);
    setError(null);
    websocketRetryAttempt.current = 0;
    if (action === "disconnect") setWebsocketsEnabled(false);
    try {
      const response = await fetch(`/api/websockets/${action}`, { method: "POST" });
      if (!response.ok) throw new Error(`WebSocket ${action} failed with HTTP ${response.status}`);
      if (action === "disconnect") {
        setConnection("DISCONNECTED");
      } else {
        setConnection("CONNECTING");
        setWebsocketsEnabled(true);
        setWebsocketGeneration((current) => current + 1);
      }
    } catch (reason) {
      if (action === "disconnect") {
        setWebsocketsEnabled(true);
        setWebsocketGeneration((current) => current + 1);
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWebsocketAction(null);
    }
  }, []);

  const windowedEvents = useMemo(
    () => pruneUiEvents(snapshot.recentUiEvents, snapshot.flow5m.evaluatedAtMs, snapshot.flow5m.windowMs),
    [snapshot.recentUiEvents, snapshot.flow5m.evaluatedAtMs, snapshot.flow5m.windowMs]
  );
  const batches = useMemo(() => microBatchUiEvents(windowedEvents), [windowedEvents]);
  const bubbleWindowEvents = useMemo(
    () => pruneUiEvents(windowedEvents, snapshot.flow5m.evaluatedAtMs, visualWindowMs),
    [snapshot.flow5m.evaluatedAtMs, visualWindowMs, windowedEvents]
  );
  const bubbleBatches = useMemo(() => microBatchBubbleEvents(bubbleWindowEvents), [bubbleWindowEvents]);
  const leading = useMemo(() => leadingLabel(batches, snapshot.signal.juries), [batches, snapshot.signal.juries]);
  const sourceQuality = snapshot.sources.some(({ quality }) => quality !== "fresh") ? "DEGRADED" : snapshot.sources.length > 0 ? "FRESH" : "WAITING";
  const verdict = snapshot.signal.verdict;
  const suspended = motionPaused || pageHidden;
  const buyPower = snapshot.flow5m.segments.reduce((total, flow) => total + Number(flow.buyNotionalQuote), 0);
  const sellPower = snapshot.flow5m.segments.reduce((total, flow) => total + Number(flow.sellNotionalQuote), 0);
  const totalPower = buyPower + sellPower;
  const buyPowerPercent = totalPower > 0 ? buyPower / totalPower * 100 : 50;
  const sellPowerPercent = 100 - buyPowerPercent;

  return (
    <main className={[suspended ? "motion-suspended" : "", windowSwitching ? "window-switching" : ""].filter(Boolean).join(" ")}>
      <header className="topbar">
        <div className="brand-block"><strong className="brand">SIDE</strong><span className="instrument">SOL / USD</span><span className="window-label">30S EDGE · {visualWindowLabel(visualWindowMs)} BUBBLES</span></div>
        <div className="status-strip" aria-label="Runtime status">
          <a className="page-nav-link" href="/strategy">AUTO STRATEGY</a>
          <a className="page-nav-link" href="/backtest">BACKTEST</a>
          <div className="visual-window-control" role="group" aria-label="Bubble display window">
            <span>BUBBLES</span>
            {visualWindowOptions.map(({ label, value }) => <button type="button" key={value} aria-pressed={visualWindowMs === value} onClick={() => { if (value !== visualWindowMs) { setWindowSwitching(true); setVisualWindowMs(value); } }}>{label}</button>)}
          </div>
          <span className="data-age">DATA AGE <strong>{dataAge(snapshot.sources, snapshot.flow5m.evaluatedAtMs)}</strong></span><strong className="mode-pill">{snapshot.mode}</strong><span className="paper-pill">PAPER MODE</span><span className={`connection-state ${connection.toLowerCase()}`}><i />{connection}</span><span className={`quality-state ${sourceQuality.toLowerCase()}`}>{sourceQuality}</span>
        </div>
      </header>

      <section className="runtime-bar" aria-label={`${snapshot.mode} runtime controls`}>
        <div><span>PROFILE</span><strong>{snapshot.cexProfile.toUpperCase()} PRIMARY</strong></div>
        <div><span>COVERAGE</span><strong>{verdict.freshJuryCount}/4 JURIES</strong></div>
        <div><span>MODEL</span><strong>{snapshot.signal.modelVersion.toUpperCase()}</strong></div>
        <div><span>LAST VALID</span><strong>{verdict.lastValidVerdict?.replaceAll("_", " ") ?? "—"}</strong></div>
        <div><span>{snapshot.mode}</span><strong>{snapshot.mode === "LIVE" ? `STREAMING · SEQ ${snapshot.lastIngestSeq ?? "—"}` : `${snapshot.replayStatus.toUpperCase()} · SEQ ${snapshot.lastIngestSeq ?? "—"}`}</strong></div>
        <div className="runtime-actions"><button className="quiet-button" type="button" onClick={() => setMotionPaused((current) => !current)}>{motionPaused ? "RESUME MOTION" : "PAUSE MOTION"}</button>{snapshot.mode === "REPLAY" ? <><button className="quiet-button" type="button" onClick={() => void setReplay("start").catch((reason: unknown) => setError(String(reason)))}>RUN GOLDEN REPLAY</button><button className="quiet-button" type="button" onClick={() => void setReplay("stop").catch((reason: unknown) => setError(String(reason)))}>STOP</button></> : <span className="paper-pill">LIVE SOURCES ACTIVE</span>}</div>
      </section>

      {error ? <p className="error" role="alert">{error}</p> : null}

      <section className="cockpit" aria-label="SOL cross-market cockpit">
        <div className="power-board">
          <PowerRow market="spot" flow5m={snapshot.flow5m} juries={snapshot.signal.juries} events={bubbleBatches} sources={snapshot.sources} visualWindowMs={visualWindowMs} />
          <article className={`verdict-card ${verdictClass(verdict.verdict)}`} aria-label="Market verdict">
            <div className="verdict-side-action buy">
              <PaperPriceTile side="BUY" price={paperPrices?.buy ?? null} loading={paperPricesLoading} nowMs={paperPriceClockMs} />
            </div>
            <div className="verdict-main">
              <div className="verdict-summary">
                <span className="kicker">MARKET VERDICT · {snapshot.signal.modelVersion.toUpperCase()}</span>
                <h1>{verdict.verdict.replaceAll("_", " ")}</h1>
                <strong className="agreement">{agreementLabel(snapshot.signal)}</strong>
              </div>
              <div className="verdict-context">
                <p>{narrative(snapshot.signal)}</p>
                <div className="verdict-context-bottom">
                  <div className="leader-row"><span>FIRST OBSERVED BY SIDE</span><strong>{leading}</strong></div>
                </div>
              </div>
            </div>
            <div className="verdict-side-action sell">
              <PaperPriceTile side="SELL" price={paperPrices?.sell ?? null} loading={paperPricesLoading} nowMs={paperPriceClockMs} />
            </div>
          </article>
          <PowerRow market="perp" flow5m={snapshot.flow5m} juries={snapshot.signal.juries} events={bubbleBatches} sources={snapshot.sources} visualWindowMs={visualWindowMs} />
        </div>
      </section>

      <section className="power-balance" aria-label="Five minute buy sell power balance">
        <div className="balance-track">
          <div className="balance-buy" style={{ width: `${buyPowerPercent}%` }} />
          <div className="balance-sell" style={{ width: `${sellPowerPercent}%` }} />
          <i style={{ left: `${buyPowerPercent}%` }} />
        </div>
        <div className="balance-labels">
          <strong className="buy">BUY {buyPowerPercent.toFixed(0)}% <span>{money(buyPower)}</span></strong>
          <span>5M REALIZED FLOW</span>
          <strong className="sell">SELL {sellPowerPercent.toFixed(0)}% <span>{money(sellPower)}</span></strong>
        </div>
      </section>

      <section className="activity-rail" aria-label="Visual micro batches">
        <div className="activity-heading"><div><span className="kicker">EVENT PULSE</span><h2>75MS VISUAL MICRO-BATCHES</h2></div><span>{snapshot.eventsIngested} canonical · {bubbleBatches.length} trade bubbles · rolling {visualWindowLabel(visualWindowMs).toLowerCase()}</span></div>
        <div className="batch-list">
          {batches.length === 0 ? <p>{snapshot.mode === "LIVE" ? "Waiting for the first real market update." : "Run the golden replay to populate venue-local effects."}</p> : null}
          {[...batches].reverse().slice(0, 8).map((event) => <div className={`batch-row ${event.changeDirection}`} key={`${event.eventId}:${event.streamSeq}`}><span>{event.streamSeq}</span><strong>{event.venueLabel}</strong><span>{event.instrumentId}</span><span>{event.kind}</span><b>×{event.count}</b><span>B {event.buyCount ?? 0} / S {event.sellCount ?? 0}</span><span>{notionalFor([event]) > 0 ? money(notionalFor([event])) : "STATE UPDATE"}</span><span>{event.minPx ? `${event.minPx}${event.maxPx !== event.minPx ? `–${event.maxPx}` : ""}` : "—"}</span></div>)}
        </div>
      </section>

      <section className="source-coverage" aria-label="Source coverage">
        <div><span className="kicker">SOURCE / PROFILE</span><h2>LIMITED S0 COVERAGE</h2></div>
        <div className="source-pills">{snapshot.sources.length === 0 ? <span className="source-pill waiting"><i />NO SOURCES OBSERVED</span> : null}{snapshot.sources.map((source) => <span className={`source-pill ${source.quality}`} key={source.provider}><i />{source.provider.toUpperCase()} · {source.quality.toUpperCase()} · {source.eventCount}</span>)}</div>
        <p>{snapshot.mode === "LIVE" ? "All displayed events arrived from persistent source WebSockets. Bitquery flow is provider-indexed realized activity; source-health messages do not create trade bubbles." : "REPLAY is never presented as LIVE. Bitquery decoded flow is realized activity; the paper preview fixture remains a separate 0x-shaped contract."}</p>
      </section>

      <footer>
        <div className="footer-runtime"><span>{snapshot.mode === "LIVE" ? "S0 · LIVE INGEST" : "R0 · REPLAY RUNNABLE"}</span><span>Motion {suspended ? "paused" : "active"} · seeded by event ID · hidden-page snapshot recovery</span></div>
        <div className="websocket-controls" role="group" aria-label="WebSocket resource controls">
          <span aria-live="polite">WS RESOURCE · {websocketsEnabled && connection !== "DISCONNECTED" ? connection : "PAUSED"}</span>
          <button
            type="button"
            className="websocket-button disconnect"
            disabled={websocketAction !== null || (!websocketsEnabled && connection === "DISCONNECTED")}
            onClick={() => void controlWebsockets("disconnect")}
          >{websocketAction === "disconnect" ? "DISCONNECTING…" : "DISCONNECT ALL WS"}</button>
          <button
            type="button"
            className="websocket-button reconnect"
            disabled={websocketAction !== null || (websocketsEnabled && connection !== "DISCONNECTED")}
            onClick={() => void controlWebsockets("reconnect")}
          >{websocketAction === "reconnect" ? "RECONNECTING…" : "RECONNECT ALL WS"}</button>
        </div>
      </footer>
    </main>
  );
}

export function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/strategy") return <StrategyPage />;
  if (path === "/backtest") return <BacktestPage />;
  return <DashboardPage />;
}
