import type { S0SignalConfig } from "./contracts.js";

export const S0_V1_CONFIG: S0SignalConfig = Object.freeze({
  modelVersion: "s0-v1",
  windowMs: 30_000,
  retentionMs: 120_000,
  freshnessMs: 5_000,
  priceThresholdBps: "2",
  flowThreshold: "0.15",
  minimumNotionalQuote: Object.freeze({
    "cex-spot": "1000",
    "cex-perp": "1000",
    "dex-spot": "1000",
    "defi-perp": "1000"
  })
});
