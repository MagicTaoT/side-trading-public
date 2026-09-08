import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_STRATEGY_CONFIG,
  validateConfigDraft,
  type StrategyConfigRevision,
  type StrategyConfigV1,
  type StrategyRunDetail,
  type StrategyRunRecord
} from "./contracts.js";
import { pnlTone, signedQuote, summarizeStrategyBaskets } from "./presentation.js";
import "./strategy.css";
import "./strategy-history.css";
import { adminFetch } from "../admin.js";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await adminFetch(url, init);
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = typeof body.error === "object" && body.error !== null ? body.error as Record<string, unknown> : null;
    throw new Error(typeof error?.code === "string" ? error.code : `HTTP_${response.status}`);
  }
  return body as T;
}

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function time(value: number | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  const part = (next: number) => String(next).padStart(2, "0");
  return `${part(date.getMonth() + 1)}/${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function signed(value: string | null, suffix = " bps"): string {
  if (value === null) return "—";
  const parsed = Number(value);
  return `${parsed > 0 ? "+" : ""}${parsed.toFixed(2)}${suffix}`;
}

function usd(value: string | number | null): string {
  if (value === null) return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return `$${parsed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Field({ label, value, onChange, step = "any", min = "0", max }: { label: string; value: string | number; onChange: (value: string) => void; step?: string; min?: string; max?: string }) {
  return <label className="strategy-field"><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(event.target.value)} /></label>;
}

function activeBasket(run: StrategyRunRecord | null) {
  return run?.snapshot.currentBasket ?? null;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function shortRunId(runId: string): string {
  return runId.replace(/^strategy-run:/, "").slice(0, 8).toUpperCase();
}

export function StrategyPanel({ mode }: { mode: "LIVE" | "REPLAY" }) {
  const [draft, setDraft] = useState<StrategyConfigV1>(DEFAULT_STRATEGY_CONFIG);
  const [configs, setConfigs] = useState<StrategyConfigRevision[]>([]);
  const [runs, setRuns] = useState<StrategyRunRecord[]>([]);
  const [activeRun, setActiveRun] = useState<StrategyRunRecord | null>(null);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StrategyRunDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errors = useMemo(() => validateConfigDraft(draft), [draft]);
  const basket = activeBasket(activeRun);
  const detailSummary = useMemo(() => detail ? summarizeStrategyBaskets(detail.baskets) : null, [detail]);

  const refresh = useCallback(async (quiet = false) => {
    try {
      if (!quiet) setBusy("refresh");
      const [configBody, runBody, activeBody] = await Promise.all([
        api<{ configs: StrategyConfigRevision[] }>("/api/paper-strategy-configs?limit=100"),
        api<{ runs: StrategyRunRecord[] }>("/api/paper-strategy-runs?limit=20"),
        api<{ run: StrategyRunRecord | null }>("/api/paper-strategy-runs/active")
      ]);
      setConfigs(configBody.configs);
      setRuns(runBody.runs);
      setActiveRun(activeBody.run);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!quiet) setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 1_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const mutateDraft = (apply: (current: StrategyConfigV1) => StrategyConfigV1) => setDraft((current) => apply(current));
  const entry = (key: keyof StrategyConfigV1["entry"], value: string) => mutateDraft((current) => ({ ...current, entry: { ...current.entry, [key]: key === "holdSec" ? numberValue(value) : value } }));
  const scaling = (key: keyof StrategyConfigV1["scaling"], value: string | boolean) => mutateDraft((current) => ({
    ...current,
    scaling: {
      ...current.scaling,
      [key]: typeof value === "boolean" ? value : key === "intervalSec" || key === "maxEntries" ? numberValue(value) : value
    }
  }));
  const exit = (key: keyof StrategyConfigV1["exit"], value: string | boolean) => mutateDraft((current) => ({
    ...current,
    exit: {
      ...current.exit,
      [key]: typeof value === "boolean" ? value : key === "forceExitSec" ? numberValue(value) : value
    }
  }));

  const saveConfig = async () => {
    if (errors.length > 0) return;
    setBusy("save");
    try {
      const body = await api<{ config: StrategyConfigRevision }>("/api/paper-strategy-configs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategyId: selectedStrategyId, config: draft })
      });
      setSelectedStrategyId(body.config.strategyId);
      await refresh(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const loadConfig = (config: StrategyConfigRevision) => {
    setSelectedStrategyId(config.strategyId);
    setDraft(config.config);
  };

  const start = async (config: StrategyConfigRevision) => {
    setBusy("start");
    try {
      await api("/api/paper-strategy-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategyId: config.strategyId, revision: config.revision })
      });
      await refresh(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    if (!activeRun) return;
    setBusy("stop");
    try {
      await api(`/api/paper-strategy-runs/${encodeURIComponent(activeRun.runId)}/stop`, { method: "POST" });
      await refresh(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const inspectRun = async (runId: string) => {
    setBusy("detail");
    try {
      const body = await api<StrategyRunDetail>(`/api/paper-strategy-runs/${encodeURIComponent(runId)}`);
      setDetail(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const latestByStrategy = configs.filter((config, index) => configs.findIndex(({ strategyId }) => strategyId === config.strategyId) === index);

  return (
    <section className="strategy-panel" aria-label="Automated trading strategy dry run">
      <header className="strategy-heading">
        <div><span className="kicker">AUTOMATION LAB</span><h2>AUTO STRATEGY</h2></div>
        <div className="strategy-badges"><strong>DRY RUN ONLY</strong><span>{activeRun ? `RUNNING · ${activeRun.snapshot.state}` : "NO ACTIVE RUN"}</span></div>
      </header>
      <p className="strategy-disclaimer">Theoretical immediate fills only. Fees, slippage, and partial fills are not modeled, and no transaction is signed, broadcast, or submitted.{mode === "REPLAY" ? " In REPLAY mode, start the strategy before running GOLDEN REPLAY; the final frame is not sampled again after replay completes." : ""}</p>
      {error ? <p className="strategy-error" role="alert">{error}</p> : null}

      <div className="strategy-layout">
        <form className="strategy-config" onSubmit={(event) => { event.preventDefault(); void saveConfig(); }}>
          <div className="strategy-section-title"><strong>STRATEGY CONFIGURATION</strong><span>{selectedStrategyId ? "Saving creates a new immutable revision" : "Create a new strategy"}</span></div>
          <label className="strategy-field wide"><span>Strategy name</span><input value={draft.name} onChange={(event) => mutateDraft((current) => ({ ...current, name: event.target.value }))} /></label>

          <fieldset><legend>ENTRY</legend><div className="strategy-fields">
            <Field label="Minimum edge (bps)" value={draft.entry.minEdgeBps} onChange={(value) => entry("minEdgeBps", value)} />
            <Field label="Initial hold (sec)" value={draft.entry.holdSec} step="1" onChange={(value) => entry("holdSec", value)} />
            <Field label="Initial size (USDC)" value={draft.entry.initialSizeQuote} onChange={(value) => entry("initialSizeQuote", value)} />
          </div></fieldset>

          <fieldset><legend>SCALE-IN</legend>
            <label className="strategy-toggle"><input type="checkbox" checked={draft.scaling.enabled} onChange={(event) => scaling("enabled", event.target.checked)} /><span>Enable subsequent entries</span></label>
            <div className="strategy-fields" data-disabled={!draft.scaling.enabled}>
              <Field label="Subsequent interval (sec)" value={draft.scaling.intervalSec} step="1" onChange={(value) => scaling("intervalSec", value)} />
              <Field label="Interval multiplier" value={draft.scaling.intervalMultiplier} onChange={(value) => scaling("intervalMultiplier", value)} />
              <Field label="Subsequent size (USDC)" value={draft.scaling.sizeQuote} onChange={(value) => scaling("sizeQuote", value)} />
              <Field label="Size multiplier" value={draft.scaling.sizeMultiplier} onChange={(value) => scaling("sizeMultiplier", value)} />
              <Field label="Maximum entries (including initial)" value={draft.scaling.maxEntries} step="1" min="1" max="100" onChange={(value) => scaling("maxEntries", value)} />
              <Field label="Maximum total exposure (USDC)" value={draft.scaling.maxTotalSizeQuote} onChange={(value) => scaling("maxTotalSizeQuote", value)} />
            </div>
          </fieldset>

          <fieldset><legend>EXIT</legend><div className="strategy-fields">
            <Field label="Initial take-profit (bps)" value={draft.exit.takeProfitBps} onChange={(value) => exit("takeProfitBps", value)} />
            <Field label="Stop loss (bps)" value={draft.exit.stopLossBps} onChange={(value) => exit("stopLossBps", value)} />
            <Field label="Forced exit (sec)" value={draft.exit.forceExitSec} step="1" onChange={(value) => exit("forceExitSec", value)} />
            <Field label="Post-exit cooldown (sec)" value={draft.cooldownSec} step="1" min="0" onChange={(value) => mutateDraft((current) => ({ ...current, cooldownSec: numberValue(value) }))} />
          </div><label className="strategy-toggle"><input type="checkbox" checked={draft.exit.linearDecayToZero} onChange={(event) => exit("linearDecayToZero", event.target.checked)} /><span>Linearly decay the take-profit target from the first fill to 0 bps at forced exit</span></label></fieldset>

          {errors.length > 0 ? <ul className="strategy-validation">{errors.map((message) => <li key={message}>{message}</li>)}</ul> : null}
          <div className="strategy-form-actions"><button type="submit" disabled={busy !== null || errors.length > 0}>{busy === "save" ? "SAVING" : selectedStrategyId ? "SAVE NEW REVISION" : "SAVE STRATEGY"}</button><button type="button" className="quiet-button" onClick={() => { setDraft(DEFAULT_STRATEGY_CONFIG); setSelectedStrategyId(null); }}>NEW</button></div>
        </form>

        <aside className="strategy-live">
          <div className="strategy-section-title"><strong>CURRENT RUN</strong><span>One trend, one basket</span></div>
          {!activeRun ? <p className="strategy-empty">Save a configuration and start from any revision. The strategy waits for a same-direction edge to continuously meet the threshold.</p> : <>
            <div className="strategy-live-grid">
              <div><span>STATE</span><strong>{activeRun.snapshot.state}</strong></div><div><span>DIRECTION / EDGE</span><strong>{activeRun.snapshot.lastObservation?.direction ?? "—"} · {signed(activeRun.snapshot.lastObservation?.edgeBps ?? null)}</strong></div>
              <div><span>ENTRIES / EXPOSURE</span><strong>{basket?.entries.length ?? 0} · ${basket ? Number(basket.totalQuoteNotional).toFixed(2) : "0.00"}</strong></div><div><span>THEORETICAL PNL</span><strong className={Number(basket?.grossPnlQuote ?? 0) >= 0 ? "positive" : "negative"}>{basket ? signed(basket.grossPnlQuote, " USDC") : "—"}</strong></div>
              <div><span>AVERAGE ENTRY</span><strong>{basket ? `$${Number(basket.averageEntryPrice).toFixed(4)}` : "—"}</strong></div><div><span>CURRENT / TARGET</span><strong>{basket ? `${signed(basket.grossPnlBps)} / ${Number(basket.currentTargetProfitBps).toFixed(2)} bps` : "—"}</strong></div>
            </div>
            <button type="button" className="strategy-stop" disabled={busy !== null} onClick={() => void stop()}>{busy === "stop" ? "STOPPING" : "STOP RUN"}</button>
          </>}

          <div className="strategy-section-title history-title"><strong>CONFIGURATION HISTORY</strong><span>{configs.length} revisions</span></div>
          <div className="strategy-config-history">
            {configs.length === 0 ? <p className="strategy-empty">No saved configurations.</p> : configs.map((config) => (
              <article key={`${config.strategyId}:${config.revision}`} className={selectedStrategyId === config.strategyId ? "selected" : ""}>
                <button type="button" className="strategy-config-load" onClick={() => loadConfig(config)}><strong>{config.name}</strong><span>R{config.revision} · {time(config.createdAtMs)}</span></button>
                <button type="button" disabled={activeRun !== null || busy !== null} onClick={() => void start(config)}>RUN</button>
              </article>
            ))}
          </div>
          {latestByStrategy.length > 0 ? <small className="strategy-hint">Older revisions are never overwritten; any revision can be run again in dry-run mode.</small> : null}
        </aside>
      </div>

      <div className="strategy-run-history">
        <div className="strategy-section-title"><strong>RUN HISTORY</strong><span>RUN → BASKET → EVENT</span></div>
        <div className="strategy-run-list">
          {runs.length > 0 ? <div className="strategy-run-columns" aria-hidden="true"><span>STARTED</span><span>STATE</span><span>CONFIGURATION</span><span>BASKETS</span><span>LAST RESULT</span></div> : null}
          {runs.length === 0 ? <p className="strategy-empty">No strategy runs recorded.</p> : runs.map((run) => (
            <button type="button" key={run.runId} className={detail?.run.runId === run.runId ? "selected" : ""} aria-expanded={detail?.run.runId === run.runId} onClick={() => void inspectRun(run.runId)}>
              <time>{time(run.startedAtMs)}</time><strong>{run.status}</strong><span>{configs.find((config) => config.strategyId === run.strategyId && config.revision === run.configRevision)?.name ?? run.strategyId.slice(0, 20)} · R{run.configRevision}</span><span>{run.snapshot.basketCount}</span><span>{humanize(run.snapshot.lastClosedBasket?.exitReason ?? run.snapshot.state)}</span>
            </button>
          ))}
        </div>
        {detail && detailSummary ? <article className="strategy-detail">
          <header className="strategy-detail-header">
            <div><span className="kicker">RUN DETAIL · {shortRunId(detail.run.runId)}</span><h3>{detail.configRevision.name}</h3><p title={detail.run.runId}>R{detail.configRevision.revision} · started {time(detail.run.startedAtMs)} · {detail.run.executionMode}</p></div>
            <button type="button" className="quiet-button" onClick={() => setDetail(null)}>CLOSE</button>
          </header>

          <section className="strategy-pnl-summary" aria-label="Run PnL summary">
            <div className="strategy-total-pnl"><span>TOTAL THEORETICAL PNL</span><strong className={pnlTone(detailSummary.totalPnlQuote)}>{signedQuote(detailSummary.totalPnlQuote)}</strong><small>Closed PnL + current open mark-to-market{detailSummary.unpricedBasketCount > 0 ? ` · ${detailSummary.unpricedBasketCount} unpriced` : ""}</small></div>
            <div><span>CLOSED PNL</span><strong className={pnlTone(detailSummary.closedPnlQuote)}>{signedQuote(detailSummary.closedPnlQuote)}</strong><small>{detailSummary.closedBaskets} closed baskets</small></div>
            <div><span>OPEN MTM</span><strong className={pnlTone(detailSummary.openMtmQuote)}>{signedQuote(detailSummary.openMtmQuote)}</strong><small>{detailSummary.openBaskets} open baskets</small></div>
            <div><span>WIN / LOSS</span><strong>{detailSummary.wins} / {detailSummary.losses}</strong><small>{detailSummary.flats} flat</small></div>
            <div><span>ENTRY FILLS</span><strong>{detailSummary.entryFills}</strong><small>Across all baskets</small></div>
            <div><span>TRADED NOTIONAL</span><strong>{usd(detailSummary.totalNotionalQuote)}</strong><small>Cumulative entry size</small></div>
          </section>

          <section className="strategy-detail-section" aria-label="Basket results">
            <div className="strategy-detail-section-heading"><div><strong>BASKET RESULTS</strong><span>One row per trend lifecycle</span></div><span>{detail.baskets.length} TOTAL</span></div>
            {detail.baskets.length === 0 ? <p className="strategy-empty">No baskets recorded for this run.</p> : <div className="strategy-table-scroll"><div className="strategy-basket-table" role="table" aria-label="Basket result table">
              <div className="strategy-table-head" role="row"><span>BASKET</span><span>RESULT</span><span>ENTRIES</span><span>EXPOSURE</span><span>AVG ENTRY</span><span>EXIT / CURRENT</span><span>PNL BPS</span><span>PNL USDC</span></div>
              {detail.baskets.map((item) => <div className="strategy-basket-row" role="row" key={item.basketId}>
                <strong role="cell">#{item.basketSequence} · {item.direction}</strong>
                <span role="cell"><b className={`basket-status ${(item.snapshot.exitReason ?? item.status).toLowerCase()}`}>{humanize(item.snapshot.exitReason ?? item.status)}</b></span>
                <span role="cell">{item.snapshot.entries.length}</span>
                <span role="cell">{usd(item.snapshot.totalQuoteNotional)}</span>
                <span role="cell">${Number(item.snapshot.averageEntryPrice).toFixed(4)}</span>
                <span role="cell">{item.snapshot.exitFill?.price ?? item.snapshot.currentPrice ? `$${Number(item.snapshot.exitFill?.price ?? item.snapshot.currentPrice).toFixed(4)}` : "—"}</span>
                <strong role="cell" className={pnlTone(item.snapshot.grossPnlQuote)}>{signed(item.snapshot.grossPnlBps)}</strong>
                <strong role="cell" className={pnlTone(item.snapshot.grossPnlQuote)}>{signedQuote(item.snapshot.grossPnlQuote)}</strong>
              </div>)}
            </div></div>}
          </section>

          <section className="strategy-detail-section" aria-label="Run event timeline">
            <div className="strategy-detail-section-heading"><div><strong>EVENT TIMELINE</strong><span>Latest event first</span></div><span>{detail.events.length}{detail.eventsTruncated ? "+" : ""} EVENTS</span></div>
            <div className="strategy-table-scroll strategy-event-scroll"><div className="strategy-event-table" role="table" aria-label="Run event table">
              <div className="strategy-table-head" role="row"><span>SEQ</span><span>TIME</span><span>EVENT</span><span>STATE CHANGE</span><span>DETAIL</span></div>
              {[...detail.events].reverse().map((item) => <div className="strategy-event-row" role="row" key={`${item.runId}:${item.event.sequence}`}>
                <span role="cell">#{item.event.sequence}</span>
                <time role="cell">{time(item.event.atMs)}</time>
                <strong role="cell">{humanize(item.event.kind)}</strong>
                <span role="cell">{humanize(item.event.fromState)} → {humanize(item.event.toState)}</span>
                <span role="cell">{item.event.fill ? `${item.event.fill.kind} · $${Number(item.event.fill.quoteNotional).toFixed(2)} @ $${Number(item.event.fill.price).toFixed(4)}` : humanize(item.event.reason ?? "—")}</span>
              </div>)}
            </div></div>
          </section>
        </article> : null}
      </div>
    </section>
  );
}
