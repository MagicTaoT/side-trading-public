import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { UiEvent } from "@side/market-core";
import type { JurySnapshot, S0Segment, SignalSnapshot, Verdict } from "@side/signal-engine";
import {
  bubbleAgeOpacity,
  bubbleVisualKey,
  mergeUiEvent,
  microBatchBubbleEvents,
  microBatchUiEvents,
  pruneUiEvents,
  seededVisual,
  VISUAL_BATCH_MS
} from "./state.js";

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

interface PaperPreview {
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
  paperPreview: PaperPreview;
}

type GatewayMessage =
  | { type: "state_snapshot"; snapshot: RuntimeSnapshot }
  | { type: "ui_event"; event: UiEvent }
  | { type: "source_health"; source: SourceState }
  | { type: "signal_state"; signal: SignalSnapshot }
  | { type: "flow_state"; flow: FlowWindowSnapshot }
  | { type: "resync_required"; snapshot: RuntimeSnapshot; suppressedCountByKind: Record<string, number> };

type PaperAction = "BUY" | "SELL" | "WAIT";

const emptyPaperPreview: PaperPreview = {
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
  const meta = segmentMeta[segment];
  const laneEvents = events.filter(({ zone, kind, tradeSide }) =>
    zone === meta.zone && (kind === "trade" || kind === "onchain-swap") && tradeSide === side
  );
  const stats = sideFlow(flow, side);
  const share = groupNotional > 0 ? stats.notional / groupNotional * 100 : 0;
  const providers = jury.sourceProviders.length > 0 ? jury.sourceProviders : laneEvents.map(({ sourceProvider }) => sourceProvider);
  const providerSet = [...new Set(providers)];
  const source = sources.find(({ provider }) => providerSet.includes(provider));

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
            <div className={`trade-bubble ${side}`} key={bubbleVisualKey(event)} style={style} tabIndex={0} aria-label={`${event.venueLabel} ${side}, batch ${event.count}, ${money(Number(event.maxNotional ?? 0))}`} title={`${event.venueLabel} · ${side} · ×${event.count}`}>
              <strong>×{event.count}</strong><span>{event.venueLabel}</span>
            </div>
          );
        })}
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
}

function PowerQuadrant({ market, side, flow5m, juries, events, sources }: PowerQuadrantProps) {
  const segments = powerSegments[market];
  const flows = segments.map((segment) => flow5m.segments.find((candidate) => candidate.segment === segment));
  const totalNotional = flows.reduce((sum, flow) => sum + sideFlow(flow, side).notional, 0);

  return (
    <article className={`power-quadrant ${market}-${side} ${side}`} aria-label={`${market} ${side} power`}>
      <div className="power-quadrant-heading">
        <h2>{market.toUpperCase()} · {side.toUpperCase()} POWER</h2>
        <span>5M {side.toUpperCase()} VOLUME <strong>{totalNotional > 0 ? money(totalNotional) : "—"}</strong></span>
      </div>
      <div className="power-cell-grid">
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
            windowMs={flow5m.windowMs}
          />
        ))}
      </div>
    </article>
  );
}

interface PaperDrawerProps { action: PaperAction; preview: PaperPreview; onClose: () => void; }

function PaperDrawer({ action, preview, onClose }: PaperDrawerProps) {
  const hasPreview = action === "BUY";
  return (
    <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="paper-drawer" role="dialog" aria-modal="true" aria-labelledby="paper-title">
        <div className="drawer-heading">
          <div><span className="kicker">{preview.mode === "LIVE" ? "LIVE PREVIEW CONTRACT" : "REPLAYED PREVIEW CONTRACT"}</span><h2 id="paper-title">{action === "WAIT" ? "RECORD WAIT" : `PAPER ${action}`}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close paper drawer">×</button>
        </div>
        <div className="drawer-warning"><strong>{preview.mode === "LIVE" ? "LIVE QUOTE NOT REQUESTED" : "REPLAY FIXTURE · NOT A LIVE QUOTE"}</strong><span>Zero signing, zero funds, nothing broadcast.</span></div>
        {action === "WAIT" ? (
          <div className="wait-copy"><strong>No execution estimate required.</strong><p>The current verdict and all four jury snapshots would be captured as a deliberate wait decision in SIDE-010.</p></div>
        ) : (
          <div className="preview-table">
            <div><span>DIRECTION</span><strong>{action} SOL</strong></div>
            <div><span>PAIR</span><strong>{preview.pair}</strong></div>
            <div><span>NOTIONAL</span><strong>$10,000 USDC</strong></div>
            <div><span>PROVIDER</span><strong>{preview.provider ? "0x PRIMARY" : "NOT REQUESTED"}</strong></div>
            <div><span>QUOTE AGE</span><strong>{hasPreview && preview.quoteAgeMs !== null ? `${(preview.quoteAgeMs / 1_000).toFixed(1)}S` : "—"}</strong></div>
            <div className="emphasis-row"><span>ESTIMATED OUTPUT</span><strong>{hasPreview && preview.estimatedOutputSOL !== null ? `${Number(preview.estimatedOutputSOL).toFixed(2)} SOL` : "UNAVAILABLE"}</strong></div>
            <div><span>MINIMUM OUTPUT</span><strong>NOT SUPPLIED</strong></div>
            <div><span>PRICE IMPACT</span><strong>NOT SUPPLIED BY 0x</strong></div>
            <div><span>FEE BREAKDOWN</span><strong>NOT SUPPLIED BY 0x</strong></div>
          </div>
        )}
        {action === "SELL" ? <p className="inline-warning">The replay fixture has no fresh USDC→SOL anchor, so the $10k SELL exact-in amount cannot be derived safely.</p> : null}
        {hasPreview ? <details open><summary>WHY THIS PRICE?</summary><ul>{preview.routeSummary.map((line) => <li key={line}>{line}</li>)}{preview.mode === "REPLAY" ? <li>Measured at replay decision time</li> : null}</ul></details> : null}
        <button className="record-button" type="button" disabled>{action === "WAIT" ? "RECORD WAIT" : `RECORD PAPER ${action}`}</button>
        <p className="disabled-note">Recording remains server-disabled until SIDE-010. No wallet or send code exists.</p>
      </aside>
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [connection, setConnection] = useState<"CONNECTING" | "CONNECTED" | "DISCONNECTED">("CONNECTING");
  const [error, setError] = useState<string | null>(null);
  const [motionPaused, setMotionPaused] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);
  const [paperAction, setPaperAction] = useState<PaperAction | null>(null);

  const loadSnapshot = useCallback(async () => {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(`State fetch failed with HTTP ${response.status}`);
    setSnapshot((await response.json()) as RuntimeSnapshot);
  }, []);

  useEffect(() => {
    let active = true;
    const pendingEvents: UiEvent[] = [];
    let flushTimer: number | undefined;
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
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    socket.addEventListener("open", () => { if (active) { setConnection("CONNECTED"); setError(null); } });
    socket.addEventListener("close", () => { if (active) setConnection("DISCONNECTED"); });
    socket.addEventListener("error", () => { if (active) setError("WebSocket connection failed"); });
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
    return () => { active = false; if (flushTimer !== undefined) window.clearTimeout(flushTimer); socket.close(); };
  }, [loadSnapshot]);

  useEffect(() => {
    const handleVisibility = () => {
      const hidden = document.hidden;
      setPageHidden(hidden);
      if (!hidden) void loadSnapshot().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [loadSnapshot]);

  useEffect(() => {
    if (paperAction === null) return;
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPaperAction(null); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [paperAction]);

  const setReplay = useCallback(async (action: "start" | "stop") => {
    setError(null);
    const response = await fetch(`/api/replay/${action}`, { method: "POST" });
    if (!response.ok) throw new Error(`Replay ${action} failed with HTTP ${response.status}`);
    const body = (await response.json()) as { snapshot: RuntimeSnapshot };
    setSnapshot(body.snapshot);
  }, []);

  const windowedEvents = useMemo(
    () => pruneUiEvents(snapshot.recentUiEvents, snapshot.flow5m.evaluatedAtMs, snapshot.flow5m.windowMs),
    [snapshot.recentUiEvents, snapshot.flow5m.evaluatedAtMs, snapshot.flow5m.windowMs]
  );
  const batches = useMemo(() => microBatchUiEvents(windowedEvents), [windowedEvents]);
  const bubbleBatches = useMemo(() => microBatchBubbleEvents(windowedEvents), [windowedEvents]);
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
    <main className={suspended ? "motion-suspended" : ""}>
      <header className="topbar">
        <div className="brand-block"><strong className="brand">SIDE</strong><span className="instrument">SOL / USD</span><span className="window-label">5 MIN DECISION WINDOW</span></div>
        <div className="status-strip" aria-label="Runtime status"><span className="data-age">DATA AGE <strong>{dataAge(snapshot.sources, snapshot.flow5m.evaluatedAtMs)}</strong></span><strong className="mode-pill">{snapshot.mode}</strong><span className="paper-pill">PAPER MODE</span><span className={`connection-state ${connection.toLowerCase()}`}><i />{connection}</span><span className={`quality-state ${sourceQuality.toLowerCase()}`}>{sourceQuality}</span></div>
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
          <PowerQuadrant market="spot" side="buy" flow5m={snapshot.flow5m} juries={snapshot.signal.juries} events={bubbleBatches} sources={snapshot.sources} />
          <PowerQuadrant market="spot" side="sell" flow5m={snapshot.flow5m} juries={snapshot.signal.juries} events={bubbleBatches} sources={snapshot.sources} />
          <PowerQuadrant market="perp" side="buy" flow5m={snapshot.flow5m} juries={snapshot.signal.juries} events={bubbleBatches} sources={snapshot.sources} />
          <PowerQuadrant market="perp" side="sell" flow5m={snapshot.flow5m} juries={snapshot.signal.juries} events={bubbleBatches} sources={snapshot.sources} />
        </div>
        <article className={`verdict-card ${verdictClass(verdict.verdict)}`} aria-label="Market verdict">
          <span className="kicker">MARKET VERDICT · {snapshot.signal.modelVersion.toUpperCase()}</span>
          <h1>{verdict.verdict.replaceAll("_", " ")}</h1>
          <strong className="agreement">{agreementLabel(snapshot.signal)}</strong>
          <p>{narrative(snapshot.signal)}</p>
          <div className="leader-row"><span>FIRST OBSERVED BY SIDE</span><strong>{leading}</strong></div>
          <div className="verdict-actions"><button type="button" className="buy-action" onClick={() => setPaperAction("BUY")}>PAPER BUY</button><button type="button" className="wait-action" onClick={() => setPaperAction("WAIT")}>RECORD WAIT</button><button type="button" className="sell-action" onClick={() => setPaperAction("SELL")}>PAPER SELL</button></div>
        </article>
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
        <div className="activity-heading"><div><span className="kicker">EVENT PULSE</span><h2>75MS VISUAL MICRO-BATCHES</h2></div><span>{snapshot.eventsIngested} canonical · {bubbleBatches.length} trade bubbles · rolling 5m</span></div>
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

      <footer><span>{snapshot.mode === "LIVE" ? "S0 · LIVE INGEST" : "R0 · REPLAY RUNNABLE"}</span><span>Motion {suspended ? "paused" : "active"} · seeded by event ID · hidden-page snapshot recovery</span></footer>
      {paperAction ? <PaperDrawer action={paperAction} preview={snapshot.paperPreview} onClose={() => setPaperAction(null)} /> : null}
    </main>
  );
}
