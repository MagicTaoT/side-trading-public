import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_STRATEGY_CONFIG, type StrategyBasketSnapshot, type StrategyConfigRevision } from "../strategy/contracts.js";
import type {
  BacktestDataset,
  BacktestExperiment,
  BacktestParameterGrid,
  BacktestResult,
  BacktestVariant,
  SavedConfigOption
} from "./contracts.js";
import {
  equityPolyline,
  experimentProgress,
  GRID_CONTROLS,
  parseGridValues,
  rankCompletedVariants
} from "./presentation.js";
import "../strategy/strategy-page.css";
import "./backtest-page.css";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : null;
    throw new Error(typeof error?.code === "string" ? error.code : `HTTP_${response.status}`);
  }
  return body as T;
}

function compactTime(value: number | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).format(value);
}

function duration(start: number, end: number | null): string {
  if (end === null) return "RECORDING";
  const seconds = Math.max(0, Math.round((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds < 3_600 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function quote(value: string | null): string {
  if (value === null) return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return `${parsed > 0 ? "+" : parsed < 0 ? "−" : ""}$${Math.abs(parsed).toFixed(2)}`;
}

function money(value: string | null): string {
  if (value === null) return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${Math.abs(parsed).toFixed(2)}` : "—";
}

function bps(value: string | null): string {
  if (value === null) return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed > 0 ? "+" : ""}${parsed.toFixed(2)} bps` : "—";
}

function tone(value: string | null): "positive" | "negative" | "neutral" {
  const parsed = Number(value ?? 0);
  return parsed > 0 ? "positive" : parsed < 0 ? "negative" : "neutral";
}

function allBaskets(result: BacktestResult): StrategyBasketSnapshot[] {
  return result.finalSnapshot.currentBasket
    ? [...result.baskets, result.finalSnapshot.currentBasket]
    : result.baskets;
}

export function BacktestPage() {
  const [datasets, setDatasets] = useState<BacktestDataset[]>([]);
  const [configRevisions, setConfigRevisions] = useState<StrategyConfigRevision[]>([]);
  const [experiments, setExperiments] = useState<BacktestExperiment[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const [selectedExperiment, setSelectedExperiment] = useState<BacktestExperiment | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<BacktestVariant | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [selectedBasketSequence, setSelectedBasketSequence] = useState<number | null>(null);
  const [mode, setMode] = useState<"SAVED" | "GRID">("GRID");
  const [experimentName, setExperimentName] = useState("SOL strategy comparison");
  const [selectedConfigKeys, setSelectedConfigKeys] = useState<string[]>(["baseline"]);
  const [baseConfigKey, setBaseConfigKey] = useState("baseline");
  const [gridDraft, setGridDraft] = useState<Record<string, string>>({
    "entry.minEdgeBps": "2, 3, 5",
    "entry.holdSec": "3, 5",
    "exit.takeProfitBps": "8, 12"
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const configOptions = useMemo<SavedConfigOption[]>(() => [
    { key: "baseline", label: "Built-in baseline", revision: null, config: DEFAULT_STRATEGY_CONFIG },
    ...configRevisions.map((revision) => ({
      key: `${revision.strategyId}:${revision.revision}`,
      label: `${revision.name} · R${revision.revision}`,
      revision,
      config: revision.config
    }))
  ], [configRevisions]);

  const loadCatalog = useCallback(async () => {
    const [datasetBody, configBody] = await Promise.all([
      api<{ datasets: BacktestDataset[] }>("/api/backtest-datasets"),
      api<{ configs: StrategyConfigRevision[] }>("/api/paper-strategy-configs?limit=100")
    ]);
    const sorted = datasetBody.datasets.sort((left, right) => right.createdAtMs - left.createdAtMs);
    setDatasets(sorted);
    setConfigRevisions(configBody.configs);
    setSelectedDatasetId((current) => current || sorted.find(({ status }) => status === "COMPLETE")?.datasetId || "");
  }, []);

  const loadExperiments = useCallback(async () => {
    const body = await api<{ experiments: BacktestExperiment[] }>("/api/backtest-experiments?limit=50");
    setExperiments(body.experiments);
    setSelectedExperimentId((current) => current ?? body.experiments[0]?.experimentId ?? null);
  }, []);

  const loadSelectedExperiment = useCallback(async (experimentId: string) => {
    const body = await api<{ experiment: BacktestExperiment }>(`/api/backtest-experiments/${experimentId}`);
    setSelectedExperiment(body.experiment);
  }, []);

  useEffect(() => {
    document.title = "SIDE · Backtest Lab";
    setBusy("loading");
    Promise.all([loadCatalog(), loadExperiments()])
      .then(() => setError(null))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(null));
  }, [loadCatalog, loadExperiments]);

  useEffect(() => {
    if (!selectedExperimentId) {
      setSelectedExperiment(null);
      return;
    }
    void loadSelectedExperiment(selectedExperimentId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [loadSelectedExperiment, selectedExperimentId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadExperiments();
      if (selectedExperimentId) void loadSelectedExperiment(selectedExperimentId);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [loadExperiments, loadSelectedExperiment, selectedExperimentId]);

  useEffect(() => {
    setSelectedVariant(null);
    setResult(null);
    setSelectedBasketSequence(null);
  }, [selectedExperimentId]);

  const selectedDataset = datasets.find(({ datasetId }) => datasetId === selectedDatasetId) ?? null;
  const rankedVariants = useMemo(
    () => rankCompletedVariants(selectedExperiment?.variants ?? []),
    [selectedExperiment]
  );
  const selectedBasket = result && selectedBasketSequence !== null
    ? allBaskets(result).find(({ basketSequence }) => basketSequence === selectedBasketSequence) ?? null
    : null;
  const chartPoints = result ? equityPolyline(result.equityCurve, 920, 220, 18) : "";

  const submit = async () => {
    try {
      if (!selectedDatasetId) throw new Error("SELECT_A_COMPLETE_DATASET");
      setBusy("submit");
      let payload: Record<string, unknown>;
      if (mode === "SAVED") {
        const configs = configOptions.filter(({ key }) => selectedConfigKeys.includes(key)).map(({ config }) => config);
        if (configs.length === 0) throw new Error("SELECT_AT_LEAST_ONE_CONFIG");
        payload = { name: experimentName, datasetId: selectedDatasetId, configs };
      } else {
        const base = configOptions.find(({ key }) => key === baseConfigKey)?.config ?? DEFAULT_STRATEGY_CONFIG;
        const parameterGrid: BacktestParameterGrid = {};
        for (const { field } of GRID_CONTROLS) {
          const values = parseGridValues(field, gridDraft[field] ?? "");
          if (values.length > 0) parameterGrid[field] = values;
        }
        if (Object.keys(parameterGrid).length === 0) throw new Error("ADD_AT_LEAST_ONE_GRID_PARAMETER");
        payload = { name: experimentName, datasetId: selectedDatasetId, baseConfig: base, parameterGrid };
      }
      const body = await api<{ experiment: BacktestExperiment }>("/api/backtest-experiments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      setExperiments((current) => [body.experiment, ...current]);
      setSelectedExperimentId(body.experiment.experimentId);
      setSelectedExperiment(body.experiment);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const openVariant = async (variant: BacktestVariant) => {
    if (!selectedExperiment || variant.status !== "COMPLETED") return;
    try {
      setBusy(`variant:${variant.variantId}`);
      const body = await api<{ result: BacktestResult }>(
        `/api/backtest-experiments/${selectedExperiment.experimentId}/variants/${variant.variantId}`
      );
      setSelectedVariant(variant);
      setResult(body.result);
      setSelectedBasketSequence(allBaskets(body.result)[0]?.basketSequence ?? null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const cancelExperiment = async () => {
    if (!selectedExperiment) return;
    try {
      setBusy("cancel");
      const body = await api<{ experiment: BacktestExperiment }>(
        `/api/backtest-experiments/${selectedExperiment.experimentId}/cancel`,
        { method: "POST" }
      );
      setSelectedExperiment(body.experiment);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="strategy-page-shell backtest-page-shell">
      <header className="topbar strategy-page-topbar">
        <div className="brand-block">
          <a className="brand brand-link" href="/">SIDE</a>
          <span className="instrument">BACKTEST LAB</span>
          <span className="window-label">DATASET · GRID · REVIEW</span>
        </div>
        <nav className="status-strip page-navigation" aria-label="Page navigation">
          <a className="page-nav-link" href="/">MARKET DASHBOARD</a>
          <a className="page-nav-link" href="/strategy">AUTO STRATEGY</a>
          <a className="page-nav-link active" href="/backtest" aria-current="page">BACKTEST</a>
          <span className="paper-pill">DRY RUN MODEL</span>
        </nav>
      </header>

      <section className="strategy-page-intro backtest-intro" aria-label="Backtest page context">
        <div><span className="kicker">HISTORICAL RESEARCH</span><h1>STRATEGY BACKTESTS</h1></div>
        <p>Compare saved configurations or sweep a parameter grid against an immutable recorded dataset. Results use the current gross theoretical execution model.</p>
      </section>

      {error ? <div className="backtest-alert" role="alert"><strong>BACKTEST ERROR</strong><span>{error.replaceAll("_", " ")}</span><button type="button" onClick={() => setError(null)}>DISMISS</button></div> : null}

      <section className="backtest-builder" aria-label="Create backtest experiment">
        <div className="backtest-section-heading">
          <div><span className="kicker">NEW EXPERIMENT</span><h2>TEST CONFIGURATIONS</h2></div>
          <span>MAX 128 UNIQUE VARIANTS</span>
        </div>
        <div className="backtest-builder-grid">
          <div className="backtest-dataset-column">
            <label className="backtest-field">
              <span>EXPERIMENT NAME</span>
              <input value={experimentName} maxLength={120} onChange={(event) => setExperimentName(event.target.value)} />
            </label>
            <label className="backtest-field">
              <span>COMPLETED DATASET</span>
              <select value={selectedDatasetId} onChange={(event) => setSelectedDatasetId(event.target.value)}>
                <option value="">Select a completed recording</option>
                {datasets.map((dataset) => <option key={dataset.datasetId} value={dataset.datasetId} disabled={dataset.status !== "COMPLETE"}>{dataset.datasetId} · {dataset.status}</option>)}
              </select>
            </label>
            {selectedDataset ? <div className="dataset-facts">
              <div><span>STATUS</span><strong className={selectedDataset.status.toLowerCase()}>{selectedDataset.status}</strong></div>
              <div><span>DURATION</span><strong>{duration(selectedDataset.createdAtMs, selectedDataset.closedAtMs)}</strong></div>
              <div><span>EVENTS</span><strong>{selectedDataset.eventCount.toLocaleString()}</strong></div>
              <div><span>OBSERVATIONS</span><strong>{selectedDataset.observationCount.toLocaleString()}</strong></div>
              <div className="wide"><span>PROVIDERS</span><strong>{selectedDataset.providers.join(" · ") || "NONE"}</strong></div>
            </div> : <p className="empty-copy">No completed dataset selected.</p>}
          </div>

          <div className="backtest-config-column">
            <div className="backtest-mode-tabs" role="group" aria-label="Experiment input mode">
              <button type="button" className={mode === "GRID" ? "active" : ""} onClick={() => setMode("GRID")}>PARAMETER GRID</button>
              <button type="button" className={mode === "SAVED" ? "active" : ""} onClick={() => setMode("SAVED")}>SAVED CONFIGS</button>
            </div>
            {mode === "SAVED" ? <div className="saved-config-list">
              {configOptions.map((option) => <label key={option.key} className="saved-config-option">
                <input type="checkbox" checked={selectedConfigKeys.includes(option.key)} onChange={(event) => setSelectedConfigKeys((current) => event.target.checked ? [...current, option.key] : current.filter((key) => key !== option.key))} />
                <span><strong>{option.label}</strong><small>{option.config.entry.minEdgeBps} bps edge · {option.config.entry.holdSec}s hold · {option.config.exit.takeProfitBps}/{option.config.exit.stopLossBps} bps TP/SL</small></span>
              </label>)}
            </div> : <>
              <label className="backtest-field compact">
                <span>BASE CONFIG</span>
                <select value={baseConfigKey} onChange={(event) => setBaseConfigKey(event.target.value)}>{configOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select>
              </label>
              <div className="parameter-grid">
                {GRID_CONTROLS.map(({ field, label, hint }) => <label className="backtest-field compact" key={field}>
                  <span>{label}</span>
                  <input value={gridDraft[field] ?? ""} placeholder={hint} onChange={(event) => setGridDraft((current) => ({ ...current, [field]: event.target.value }))} />
                </label>)}
              </div>
            </>}
          </div>
        </div>
        <div className="backtest-submit-row">
          <p>Grid values are comma-separated. Every combination is validated and deduplicated before execution.</p>
          <button type="button" className="primary-backtest-action" disabled={busy !== null || selectedDataset?.status !== "COMPLETE"} onClick={() => void submit()}>{busy === "submit" ? "QUEUING…" : "RUN EXPERIMENT"}</button>
        </div>
      </section>

      <section className="backtest-workspace" aria-label="Backtest experiment history">
        <aside className="experiment-history">
          <div className="backtest-section-heading"><div><span className="kicker">DURABLE HISTORY</span><h2>EXPERIMENTS</h2></div><button type="button" onClick={() => void loadExperiments()}>REFRESH</button></div>
          <div className="experiment-list">
            {experiments.length === 0 ? <p className="empty-copy">No experiments recorded yet.</p> : experiments.map((experiment) => {
              const progress = experimentProgress(experiment.completedVariantCount, experiment.failedVariantCount, experiment.variantCount);
              return <button type="button" key={experiment.experimentId} className={`experiment-card ${selectedExperimentId === experiment.experimentId ? "selected" : ""}`} onClick={() => setSelectedExperimentId(experiment.experimentId)}>
                <span className="experiment-card-top"><strong>{experiment.name}</strong><i className={experiment.status.toLowerCase()}>{experiment.status}</i></span>
                <span>{compactTime(experiment.createdAtMs)} · {experiment.variantCount} variants</span>
                <span className="experiment-progress"><i style={{ width: `${progress}%` }} /></span>
                <small>{experiment.completedVariantCount} complete · {experiment.failedVariantCount} failed</small>
              </button>;
            })}
          </div>
        </aside>

        <div className="experiment-detail">
          {!selectedExperiment ? <div className="backtest-empty-state"><strong>SELECT AN EXPERIMENT</strong><span>Leaderboard and results appear here.</span></div> : <>
            <div className="experiment-detail-header">
              <div><span className="kicker">{selectedExperiment.status} · {selectedExperiment.datasetId}</span><h2>{selectedExperiment.name}</h2><p>{selectedExperiment.completedVariantCount}/{selectedExperiment.variantCount} complete · created {compactTime(selectedExperiment.createdAtMs)}</p></div>
              {(selectedExperiment.status === "QUEUED" || selectedExperiment.status === "RUNNING") ? <button type="button" className="cancel-action" disabled={busy === "cancel" || selectedExperiment.cancelRequested} onClick={() => void cancelExperiment()}>{selectedExperiment.cancelRequested ? "CANCEL REQUESTED" : "CANCEL"}</button> : null}
            </div>
            <div className="leaderboard-wrap">
              <table aria-label="Backtest variant leaderboard">
                <thead><tr><th>RANK</th><th>CONFIG</th><th>PNL</th><th>RETURN</th><th>MAX DRAWDOWN</th><th>BASKETS</th><th>W / L</th><th>COVERAGE</th><th /></tr></thead>
                <tbody>
                  {rankedVariants.length === 0 ? <tr><td colSpan={9}>Completed variants will appear as the experiment runs.</td></tr> : rankedVariants.map((variant, index) => <tr key={variant.variantId} className={selectedVariant?.variantId === variant.variantId ? "selected" : ""}>
                    <td>#{index + 1}</td><td><strong>{variant.config.name}</strong><small>{variant.config.entry.minEdgeBps} bps · {variant.config.entry.holdSec}s · TP {variant.config.exit.takeProfitBps}</small></td>
                    <td className={tone(variant.summary?.totalTheoreticalPnlQuote ?? null)}>{quote(variant.summary?.totalTheoreticalPnlQuote ?? null)}</td>
                    <td>{bps(variant.summary?.returnOnMaxCapitalBps ?? null)}</td><td>{money(variant.summary?.maxDrawdownQuote ?? null)}</td>
                    <td>{variant.summary?.closedBasketCount ?? 0}{variant.summary?.openBasketCount ? " + open" : ""}</td><td>{variant.summary?.winCount ?? 0} / {variant.summary?.lossCount ?? 0}</td>
                    <td>{((Number(variant.summary?.coverageRatio ?? 0)) * 100).toFixed(1)}%</td><td><button type="button" disabled={busy === `variant:${variant.variantId}`} onClick={() => void openVariant(variant)}>VIEW</button></td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            {selectedExperiment.variants.some(({ status }) => status === "FAILED") ? <div className="variant-failures">{selectedExperiment.variants.filter(({ status }) => status === "FAILED").map((variant) => <span key={variant.variantId}>{variant.variantId}: {variant.error}</span>)}</div> : null}
          </>}
        </div>
      </section>

      {result ? <section className="backtest-result" aria-label="Selected backtest result">
        <div className="backtest-section-heading"><div><span className="kicker">RESULT DRILL-DOWN · {selectedVariant?.variantId}</span><h2>{result.config.name}</h2></div><span>{result.executionModel.replaceAll("_", " ")}</span></div>
        <div className="result-metrics">
          <div><span>TOTAL PNL</span><strong className={tone(result.summary.totalTheoreticalPnlQuote)}>{quote(result.summary.totalTheoreticalPnlQuote)}</strong></div>
          <div><span>RETURN / MAX CAPITAL</span><strong>{bps(result.summary.returnOnMaxCapitalBps)}</strong></div>
          <div><span>MAX DRAWDOWN</span><strong>{money(result.summary.maxDrawdownQuote)}</strong></div>
          <div><span>WIN / LOSS / FLAT</span><strong>{result.summary.winCount} / {result.summary.lossCount} / {result.summary.flatCount}</strong></div>
          <div><span>MAX CAPITAL</span><strong>{money(result.summary.maxCapitalQuote)}</strong></div>
          <div><span>COVERAGE</span><strong>{(Number(result.summary.coverageRatio) * 100).toFixed(1)}%</strong></div>
        </div>
        <div className="result-analysis-grid">
          <figure className="equity-chart" aria-label="Equity curve">
            <figcaption><strong>EQUITY CURVE</strong><span>{result.equityCurve.length} sampled points · {duration(result.startedAtMs, result.completedAtMs)}</span></figcaption>
            <svg viewBox="0 0 920 220" role="img" aria-label="Theoretical equity over time" preserveAspectRatio="none">
              <line x1="18" x2="902" y1="110" y2="110" className="chart-zero" />
              {chartPoints ? <polyline points={chartPoints} className={`chart-line ${tone(result.summary.totalTheoreticalPnlQuote)}`} /> : null}
            </svg>
          </figure>
          <div className="exit-reasons"><strong>EXIT REASONS</strong>{Object.entries(result.summary.exitReasonCounts).map(([reason, count]) => <div key={reason}><span>{reason.replaceAll("_", " ")}</span><b>{count}</b></div>)}</div>
        </div>
        <div className="basket-browser">
          <div className="basket-list">
            <h3>BASKETS</h3>
            {allBaskets(result).length === 0 ? <p className="empty-copy">No basket triggered for this configuration.</p> : allBaskets(result).map((basket) => <button type="button" key={basket.basketSequence} className={selectedBasketSequence === basket.basketSequence ? "selected" : ""} onClick={() => setSelectedBasketSequence(basket.basketSequence)}>
              <span><b>#{basket.basketSequence} · {basket.direction}</b><i>{basket.status}</i></span><strong className={tone(basket.grossPnlQuote)}>{quote(basket.grossPnlQuote)}</strong><small>{basket.entries.length} entries · {basket.exitReason?.replaceAll("_", " ") ?? "OPEN"}</small>
            </button>)}
          </div>
          <div className="basket-detail">
            {!selectedBasket ? <div className="backtest-empty-state"><strong>SELECT A BASKET</strong><span>Fill sequence and realized result appear here.</span></div> : <>
              <div className="basket-detail-header"><div><span className="kicker">BASKET #{selectedBasket.basketSequence}</span><h3>{selectedBasket.direction} · {selectedBasket.status}</h3></div><strong className={tone(selectedBasket.grossPnlQuote)}>{quote(selectedBasket.grossPnlQuote)}<small>{bps(selectedBasket.grossPnlBps)}</small></strong></div>
              <div className="basket-facts"><span>AVG ENTRY <b>${Number(selectedBasket.averageEntryPrice).toFixed(4)}</b></span><span>NOTIONAL <b>${Number(selectedBasket.totalQuoteNotional).toFixed(2)}</b></span><span>EXIT <b>{selectedBasket.exitReason?.replaceAll("_", " ") ?? "OPEN"}</b></span></div>
              <table aria-label="Basket fill sequence"><thead><tr><th>SEQ</th><th>TYPE</th><th>TIME</th><th>PRICE</th><th>NOTIONAL</th><th>EDGE</th><th>SOURCE</th></tr></thead><tbody>
                {[...selectedBasket.entries, ...(selectedBasket.exitFill ? [selectedBasket.exitFill] : [])].map((fill) => <tr key={fill.sequence}><td>{fill.sequence}</td><td>{fill.kind}</td><td>{compactTime(fill.atMs)}</td><td>${Number(fill.price).toFixed(4)}</td><td>${Number(fill.quoteNotional).toFixed(2)}</td><td>{bps(fill.edgeBps)}</td><td>{fill.referenceSource}</td></tr>)}
              </tbody></table>
            </>}
          </div>
        </div>
      </section> : null}

      <footer className="strategy-page-footer"><span>BACKTEST LAB · THEORETICAL RESEARCH ONLY</span><span>{busy === "loading" ? "LOADING DATA…" : `${datasets.filter(({ status }) => status === "COMPLETE").length} DATASETS · ${experiments.length} EXPERIMENTS`}</span></footer>
    </main>
  );
}
