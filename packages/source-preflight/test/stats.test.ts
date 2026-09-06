import { describe, expect, it } from "vitest";
import { latencyStats, percentile } from "../src/stats.js";

describe("latency statistics", () => {
  it("uses deterministic nearest-rank percentiles without mutating input", () => {
    const samples = [100, 10, 50, 20, 90];
    expect(percentile(samples, 0.5)).toBe(50);
    expect(percentile(samples, 0.95)).toBe(100);
    expect(samples).toEqual([100, 10, 50, 20, 90]);
  });

  it("reports empty samples and rounds measured values", () => {
    expect(latencyStats([])).toEqual({ samples: [], p50: null, p95: null });
    expect(latencyStats([1.234, 9.876])).toEqual({ samples: [1.23, 9.88], p50: 1.23, p95: 9.88 });
  });

  it("rejects invalid percentile bounds", () => {
    expect(() => percentile([1], 1.01)).toThrow(/between 0 and 1/u);
  });
});
