import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG, validateConfigDraft } from "./contracts.js";

describe("strategy config draft", () => {
  it("accepts the safe default", () => {
    expect(validateConfigDraft(DEFAULT_STRATEGY_CONFIG)).toEqual([]);
  });

  it("requires hard size and timing limits", () => {
    const invalid = {
      ...DEFAULT_STRATEGY_CONFIG,
      entry: { ...DEFAULT_STRATEGY_CONFIG.entry, minEdgeBps: "-1", initialSizeQuote: "2000" },
      scaling: { ...DEFAULT_STRATEGY_CONFIG.scaling, maxEntries: 0, maxTotalSizeQuote: "1000" },
      exit: { ...DEFAULT_STRATEGY_CONFIG.exit, forceExitSec: 0 }
    };
    expect(validateConfigDraft(invalid)).toEqual(expect.arrayContaining([
      "Minimum edge must be at least 0 bps",
      "Maximum entries must be an integer from 1 to 100",
      "Maximum total exposure cannot be smaller than the initial size",
      "Forced exit must be greater than 0 seconds"
    ]));
  });

  it("accepts zero-delay/zero-threshold controls and disabled zero scaling interval", () => {
    expect(validateConfigDraft({
      ...DEFAULT_STRATEGY_CONFIG,
      entry: { ...DEFAULT_STRATEGY_CONFIG.entry, minEdgeBps: "0", holdSec: 0 },
      scaling: { ...DEFAULT_STRATEGY_CONFIG.scaling, enabled: false, intervalSec: 0 },
      exit: { ...DEFAULT_STRATEGY_CONFIG.exit, takeProfitBps: "0" }
    })).toEqual([]);
  });
});
