import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("cockpit responsive contract", () => {
  it("keeps the central verdict out of the jury overlay at 1024px and below", () => {
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.verdict-card\s*\{[\s\S]*?position:\s*relative/);
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.verdict-card\s*\{[\s\S]*?transform:\s*none/);
  });

  it("uses a single-column power map at 736px and 360px", () => {
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.power-board\s*\{[\s\S]*?flex-direction:\s*column/);
    expect(css).toContain("@media (max-width: 390px)");
  });

  it("retains the centered exclusion-zone verdict on 1440px desktop", () => {
    expect(css).toMatch(/\.verdict-card\s*\{[\s\S]*?position:\s*absolute[\s\S]*?top:\s*50%[\s\S]*?left:\s*50%/);
    expect(css).toContain("@media (min-width: 1101px)");
  });

  it("honors reduced motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
