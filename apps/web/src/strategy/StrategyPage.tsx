import { useCallback, useEffect, useState } from "react";
import { StrategyPanel } from "./StrategyPanel.js";
import { adminFetch } from "../admin.js";
import "./strategy-page.css";

interface WebSocketStatus {
  enabled: boolean;
  mode: "LIVE" | "REPLAY";
  dashboardClients: number;
  liveSourcesEnabled: boolean;
}

const initialStatus: WebSocketStatus = {
  enabled: false,
  mode: "REPLAY",
  dashboardClients: 0,
  liveSourcesEnabled: false
};

export function StrategyPage() {
  const [runtime, setRuntime] = useState(initialStatus);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const loadRuntime = useCallback(async () => {
    try {
      const response = await adminFetch("/api/websockets/status");
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      setRuntime(await response.json() as WebSocketStatus);
      setRuntimeError(null);
    } catch (reason) {
      setRuntimeError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    document.title = "SIDE · Auto Strategy";
    void loadRuntime();
    const timer = window.setInterval(() => void loadRuntime(), 2_000);
    return () => window.clearInterval(timer);
  }, [loadRuntime]);

  const inputsActive = runtime.mode === "REPLAY" || (runtime.enabled && runtime.liveSourcesEnabled);

  return (
    <main className="strategy-page-shell">
      <header className="topbar strategy-page-topbar">
        <div className="brand-block">
          <a className="brand brand-link" href="/">SIDE</a>
          <span className="instrument">AUTO STRATEGY</span>
          <span className="window-label">CONFIGURE · RUN · REVIEW</span>
        </div>
        <nav className="status-strip page-navigation" aria-label="Page navigation and runtime status">
          <a className="page-nav-link" href="/">MARKET DASHBOARD</a>
          <a className="page-nav-link active" href="/strategy" aria-current="page">AUTO STRATEGY</a>
          <a className="page-nav-link" href="/backtest">BACKTEST</a>
          <strong className="mode-pill">{runtime.mode}</strong>
          <span className="paper-pill">DRY RUN ONLY</span>
          <span className={`strategy-input-state ${runtimeError ? "error" : inputsActive ? "active" : "paused"}`}>
            <i />{runtimeError ? "SERVER UNAVAILABLE" : inputsActive ? "MARKET INPUTS ACTIVE" : "MARKET INPUTS PAUSED"}
          </span>
        </nav>
      </header>

      {runtimeError ? <p className="error" role="alert">Runtime status unavailable · {runtimeError}. Strategy history will keep retrying independently.</p> : null}

      <section className="strategy-page-intro" aria-label="Strategy page context">
        <div><span className="kicker">SEPARATE WORKSPACE</span><h1>DRY-RUN AUTOMATION</h1></div>
        <p>Strategy configuration and execution history live here. The market dashboard remains focused on cross-market signal monitoring and manual paper decisions.</p>
      </section>

      <StrategyPanel mode={runtime.mode} />

      <footer className="strategy-page-footer">
        <span>AUTO STRATEGY · THEORETICAL EXECUTION</span>
        <a className="page-nav-link" href="/">RETURN TO MARKET DASHBOARD</a>
      </footer>
    </main>
  );
}
