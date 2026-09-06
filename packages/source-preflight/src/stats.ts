import type { LatencyStats } from "./contracts.js";

export function percentile(samples: number[], percentileValue: number): number | null {
  if (samples.length === 0) return null;
  if (percentileValue < 0 || percentileValue > 1) throw new RangeError("Percentile must be between 0 and 1");
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? null;
}

export function latencyStats(samples: number[]): LatencyStats {
  const rounded = samples.map((sample) => Math.round(sample * 100) / 100);
  return {
    samples: rounded,
    p50: percentile(rounded, 0.5),
    p95: percentile(rounded, 0.95)
  };
}
