import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const strategyPage = readFileSync(new URL("./strategy/StrategyPage.tsx", import.meta.url), "utf8");
const strategyPageCss = readFileSync(new URL("./strategy/strategy-page.css", import.meta.url), "utf8");
const strategyPanel = readFileSync(new URL("./strategy/StrategyPanel.tsx", import.meta.url), "utf8");
const strategyHistoryCss = readFileSync(new URL("./strategy/strategy-history.css", import.meta.url), "utf8");
const backtestPage = readFileSync(new URL("./backtest/BacktestPage.tsx", import.meta.url), "utf8");
const backtestPageCss = readFileSync(new URL("./backtest/backtest-page.css", import.meta.url), "utf8");
const verdictCardBlock = css.match(/\.verdict-card\s*\{([^}]*)\}/)?.[1] ?? "";

describe("cockpit responsive contract", () => {
  it("keeps the verdict in flow between the spot and perp rows", () => {
    expect(app).toMatch(/<PowerRow market="spot"[\s\S]*?<article className=\{`verdict-card[\s\S]*?<PowerRow market="perp"/);
    expect(css).toMatch(/\.verdict-card\s*\{[\s\S]*?position:\s*relative[\s\S]*?width:\s*100%/);
    expect(css).toMatch(/\.power-board\s*\{[\s\S]*?grid-template-rows:\s*minmax\(300px, 1fr\) auto minmax\(300px, 1fr\)/);
  });

  it("uses a single-column power map at 736px and 360px", () => {
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.power-board\s*\{[\s\S]*?flex-direction:\s*column/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.power-row\s*\{[\s\S]*?flex-direction:\s*column/);
    expect(css).toContain("@media (max-width: 390px)");
  });

  it("uses constrained volume-weighted columns on larger screens", () => {
    expect(css).toMatch(/\.power-row\s*\{[\s\S]*?--buy-quadrant-share/);
    expect(css).toMatch(/\.power-cell-grid\s*\{[\s\S]*?--first-cell-share/);
    expect(css).toMatch(/\.power-row\s*\{[\s\S]*?transition:\s*grid-template-columns/);
    expect(app).toMatch(/const marketSegments = new Set\(powerSegments\[market\]\)[\s\S]*?marketFlows[\s\S]*?clampedVolumeShare\(buyNotional, sellNotional, 35, 65\)/);
  });

  it("uses a three-column verdict strip on desktop", () => {
    expect(css).toMatch(/\.verdict-card\s*\{[\s\S]*?min-height:\s*82px[\s\S]*?grid-template-columns:\s*minmax\(116px/);
    expect(app).toMatch(/verdict-side-action buy[\s\S]*?verdict-main[\s\S]*?verdict-side-action sell/);
    expect(verdictCardBlock).not.toContain("position: absolute");
  });

  it("honors reduced motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("highlights only newly mounted trade bubbles with a short ring", () => {
    expect(css).toMatch(/\.trade-bubble::after\s*\{[\s\S]*?animation:\s*bubble-highlight \.8s/);
    expect(css).toMatch(/@keyframes bubble-highlight\s*\{[\s\S]*?transform:\s*scale\(1\.48\)[\s\S]*?opacity:\s*0/);
  });

  it("offers an independent bubble window without changing the 30s edge or 5m flow layout", () => {
    expect(app).toContain('{ label: "30S", value: 30_000 }');
    expect(app).toContain('{ label: "60S", value: 60_000 }');
    expect(app).toContain('{ label: "3M", value: 180_000 }');
    expect(app).toContain('{ label: "5M", value: 300_000 }');
    expect(app).toContain('useState<VisualWindowMs>(60_000)');
    expect(app).toMatch(/pruneUiEvents\(windowedEvents, snapshot\.flow5m\.evaluatedAtMs, visualWindowMs\)/);
    expect(app).toMatch(/30S EDGE · \{visualWindowLabel\(visualWindowMs\)\} BUBBLES/);
    expect(app).toMatch(/marketFlows = flow5m\.segments[\s\S]*?clampedVolumeShare\(buyNotional, sellNotional, 35, 65\)/);
    expect(css).toMatch(/\.visual-window-control button\[aria-pressed="true"\]/);
    expect(css).toMatch(/\.window-switching \.trade-bubble[\s\S]*?animation:\s*none/);
  });

  it("archives the shadow journal and paper action drawer from the dashboard", () => {
    expect(app).not.toContain("<ShadowPerformance");
    expect(app).not.toContain('fetch("/api/shadow-performance")');
    expect(app).not.toContain('fetch("/api/paper-orders?limit=12")');
    expect(app).not.toContain("<PaperDrawer action=");
    expect(app).not.toContain("setPaperAction(");
  });

  it("keeps auto strategy on a dedicated page instead of the market dashboard", () => {
    expect(app).not.toContain("<StrategyPanel");
    expect(app).toContain('href="/strategy">AUTO STRATEGY</a>');
    expect(app).toContain('if (path === "/strategy") return <StrategyPage />');
    expect(strategyPage).toContain("<StrategyPanel mode={runtime.mode} />");
    expect(strategyPage).toContain('href="/">MARKET DASHBOARD</a>');
    expect(strategyPageCss).toContain(".strategy-page-shell");
    expect(strategyPanel).toContain("TOTAL THEORETICAL PNL");
    expect(strategyPanel).toContain('aria-label="Basket result table"');
    expect(strategyPanel).toContain('aria-label="Run event table"');
    expect(strategyHistoryCss).toContain(".strategy-pnl-summary");
    expect(strategyHistoryCss).toContain(".strategy-event-scroll");
  });

  it("provides a dedicated backtest lab with durable history and drill-down", () => {
    expect(app).toContain('if (path === "/backtest") return <BacktestPage />');
    expect(app).toContain('href="/backtest">BACKTEST</a>');
    expect(strategyPage).toContain('href="/backtest">BACKTEST</a>');
    expect(backtestPage).toContain("PARAMETER GRID");
    expect(backtestPage).toContain("SAVED CONFIGS");
    expect(backtestPage).toContain('aria-label="Backtest variant leaderboard"');
    expect(backtestPage).toContain('aria-label="Equity curve"');
    expect(backtestPage).toContain('aria-label="Basket fill sequence"');
    expect(backtestPageCss).toMatch(/\.backtest-workspace\s*\{[\s\S]*?grid-template-columns/);
    expect(backtestPageCss).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.basket-browser/);
  });

  it("exposes detailed bubble evidence on pointer or keyboard focus", () => {
    expect(app).toContain("bubbleAuditLabel(event, evaluatedAtMs)");
    expect(app).toContain("onPointerEnter");
    expect(app).toContain("onFocus");
    expect(app).toContain('className="bubble-inspector"');
  });

  it("keeps display-only buy and sell prices around the central edge", () => {
    expect(app).toContain('fetch("/api/paper-prices")');
    expect(app).toMatch(/<PaperPriceTile side="BUY"[\s\S]*?verdict-main[\s\S]*?<PaperPriceTile side="SELL"/);
    expect(app).toContain("Five-second display estimate. Display only.");
    expect(app).not.toMatch(/<PaperPriceTile[^>]*onClick=/);
    expect(app).toContain('price.source === "coinbase-dry" ? "COINBASE USD" : "BITQUERY"');
  });

  it("keeps reversible WebSocket resource controls at the bottom of the dashboard", () => {
    expect(app).toContain('fetch(`/api/websockets/${action}`, { method: "POST" })');
    expect(app).toContain("DISCONNECT ALL WS");
    expect(app).toContain("RECONNECT ALL WS");
    expect(app).toMatch(/<footer>[\s\S]*?className="websocket-controls"[\s\S]*?<\/footer>/);
    expect(css).toContain(".websocket-button.disconnect");
    expect(css).toContain(".websocket-button.reconnect");
    expect(app).toMatch(/setConnection\("RECONNECTING"\)[\s\S]*?setWebsocketGeneration/);
    expect(app).toContain("event.code === 4001");
    expect(css).toContain(".connection-state.reconnecting i");
  });
});
