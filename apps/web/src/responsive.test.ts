import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
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
});
