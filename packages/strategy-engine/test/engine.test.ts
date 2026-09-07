import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  currentTargetProfitBps,
  DryRunStrategyEngine,
  StrategyConfigError,
  StrategyObservationError,
  StrategySnapshotError,
  StrategyStateError,
  validateStrategyConfigV1,
  type StrategyConfigV1,
  type StrategyDirection,
  type StrategyObservation
} from "../src/index.js";

function config(overrides: Partial<StrategyConfigV1> = {}): StrategyConfigV1 {
  const base: StrategyConfigV1 = {
    schemaVersion: 1,
    name: "deterministic dry run",
    pair: "SOL-USDC",
    entry: { minEdgeBps: "5", holdSec: 10, initialSizeQuote: "1000" },
    scaling: {
      enabled: true,
      intervalSec: 2,
      intervalMultiplier: "1.5",
      sizeQuote: "200",
      sizeMultiplier: "2",
      maxEntries: 4,
      maxTotalSizeQuote: "10000"
    },
    exit: { takeProfitBps: "5000", linearDecayToZero: false, stopLossBps: "5000", forceExitSec: 1000 },
    cooldownSec: 5
  };
  return {
    ...base,
    ...overrides,
    entry: { ...base.entry, ...overrides.entry },
    scaling: { ...base.scaling, ...overrides.scaling },
    exit: { ...base.exit, ...overrides.exit }
  };
}

function observation(
  atMs: number,
  direction: StrategyDirection | null = "BUY",
  edgeBps: string | null = "5",
  price: string | null = "100"
): StrategyObservation {
  return { atMs, direction, edgeBps, price, referenceSource: price === null ? null : "test-mark" };
}

function startAndOpen(strategyConfig = config({ entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" } }), direction: StrategyDirection = "BUY") {
  const engine = new DryRunStrategyEngine(strategyConfig);
  engine.start(0);
  engine.evaluate(observation(0, direction, direction === "BUY" ? "5" : "-5", "100"));
  expect(engine.snapshot().state).toBe("OPEN");
  return engine;
}

function configErrorCode(value: unknown): string | null {
  try {
    validateStrategyConfigV1(value);
    return null;
  } catch (reason) {
    expect(reason).toBeInstanceOf(StrategyConfigError);
    return (reason as StrategyConfigError).code;
  }
}

describe("configuration and deterministic clock", () => {
  it("normalizes numeric strings and rejects unsafe configurations", () => {
    expect(validateStrategyConfigV1(config({ entry: { minEdgeBps: "05.00", holdSec: 1, initialSizeQuote: "1000.0" } })))
      .toMatchObject({ entry: { minEdgeBps: "5", initialSizeQuote: "1000" } });

    const invalid = [
      config({ entry: { minEdgeBps: "x", holdSec: 1, initialSizeQuote: "1000" } }),
      config({ entry: { minEdgeBps: "5", holdSec: 1, initialSizeQuote: "0" } }),
      config({ scaling: { ...config().scaling, intervalMultiplier: "0" } }),
      config({ scaling: { ...config().scaling, maxEntries: 0 } }),
      config({ scaling: { ...config().scaling, maxTotalSizeQuote: "999" } }),
      config({ exit: { ...config().exit, forceExitSec: 0 } })
    ];
    for (const value of invalid) expect(() => validateStrategyConfigV1(value)).toThrow(StrategyConfigError);
    expect(validateStrategyConfigV1(config({ scaling: { ...config().scaling, enabled: true, maxEntries: 1 } })).scaling.maxEntries).toBe(1);
  });

  it("caps maxEntries at 100 and validates every configured scale interval", () => {
    expect(validateStrategyConfigV1(config({
      scaling: { ...config().scaling, intervalMultiplier: "1", maxEntries: 100 }
    })).scaling.maxEntries).toBe(100);
    expect(configErrorCode(config({
      scaling: { ...config().scaling, intervalMultiplier: "1", maxEntries: 101 }
    }))).toBe("INVALID_MAX_ENTRIES");

    expect(configErrorCode(config({
      scaling: { ...config().scaling, intervalSec: 0.001, intervalMultiplier: "9007199254740991", maxEntries: 3 }
    }))).toBe(null);
    expect(configErrorCode(config({
      scaling: { ...config().scaling, intervalSec: 0.001, intervalMultiplier: "9007199254740992", maxEntries: 3 }
    }))).toBe("INVALID_SCALING_SCHEDULE");
    expect(configErrorCode(config({
      scaling: { ...config().scaling, intervalSec: 0.001, intervalMultiplier: "1e100", maxEntries: 100 }
    }))).toBe("INVALID_SCALING_SCHEDULE");
    expect(configErrorCode(config({
      scaling: { ...config().scaling, intervalSec: 0.001, intervalMultiplier: "1e100", maxEntries: 2 }
    }))).toBe(null);
    expect(configErrorCode(config({
      scaling: { ...config().scaling, intervalSec: 0.001, intervalMultiplier: "1e-100", maxEntries: 100 }
    }))).toBe(null);
  });

  it.each([
    null,
    {},
    { schemaVersion: 1, name: "missing nested values", pair: "SOL-USDC" },
    { ...config(), entry: null },
    { ...config(), scaling: [] },
    { ...config(), exit: { ...config().exit, linearDecayToZero: "yes" } },
    { ...config(), scaling: { ...config().scaling, enabled: 1 } }
  ])("returns a stable StrategyConfigError for malformed HTTP input %#", (input) => {
    expect(() => validateStrategyConfigV1(input)).toThrow(StrategyConfigError);
  });

  it("rejects evaluate-before-start, invalid marks, and backwards time", () => {
    const engine = new DryRunStrategyEngine(config());
    expect(() => engine.evaluate(observation(0))).toThrow(StrategyStateError);
    engine.start(100);
    expect(() => engine.evaluate(observation(99))).toThrow(StrategyObservationError);
    expect(() => engine.evaluate({ ...observation(100), price: "0" })).toThrow(StrategyObservationError);
    expect(() => engine.evaluate({ ...observation(100), referenceSource: null })).toThrow(StrategyObservationError);
  });
});

describe("initial entry qualification", () => {
  it("fills only after a continuous hold and includes exact time and edge boundaries", () => {
    const engine = new DryRunStrategyEngine(config());
    expect(engine.start(0).map(({ kind }) => kind)).toEqual(["RUN_STARTED"]);
    expect(engine.evaluate(observation(0, "BUY", "5")).map(({ kind }) => kind)).toEqual(["ARMING_STARTED"]);
    expect(engine.evaluate(observation(9_999, "BUY", "-5"))).toEqual([]);
    expect(engine.snapshot()).toMatchObject({ state: "ARMING", arming: { readyAtMs: 10_000 } });
    const events = engine.evaluate(observation(10_000, "BUY", "5"));
    expect(events.map(({ kind }) => kind)).toEqual(["ENTRY_FILLED"]);
    expect(events[0]?.fill).toMatchObject({ kind: "ENTRY", quoteNotional: "1000", atMs: 10_000 });
    expect(engine.snapshot()).toMatchObject({ state: "OPEN", basketCount: 1 });
  });

  it("restarts the full hold after weak, missing, or opposite edge", () => {
    const engine = new DryRunStrategyEngine(config({ entry: { minEdgeBps: "5", holdSec: 10, initialSizeQuote: "1000" } }));
    engine.start(0);
    engine.evaluate(observation(0, "BUY", "5"));
    expect(engine.evaluate(observation(5_000, "BUY", "4.999"))[0]).toMatchObject({ kind: "ARMING_RESET", reason: "EDGE_NOT_QUALIFIED" });
    engine.evaluate(observation(6_000, "BUY", "5"));
    expect(engine.evaluate(observation(10_000, "SELL", "-5"))[0]).toMatchObject({ kind: "ARMING_RESET", reason: "EDGE_DIRECTION_CHANGED" });
    expect(engine.snapshot().arming).toMatchObject({ direction: "SELL", startedAtMs: 10_000, readyAtMs: 20_000 });
    expect(engine.evaluate(observation(19_999, "SELL", "5"))).toEqual([]);
    expect(engine.evaluate(observation(20_000, "SELL", "-5"))[0]?.kind).toBe("ENTRY_FILLED");
  });

  it("keeps a mature arming timer while price is missing, but resets it if edge disappears", () => {
    const engine = new DryRunStrategyEngine(config());
    engine.start(0);
    engine.evaluate(observation(0));
    expect(engine.evaluate(observation(10_000, "BUY", "5", null))).toEqual([]);
    expect(engine.snapshot()).toMatchObject({ state: "ARMING", arming: { waitingForPrice: true } });
    expect(engine.evaluate(observation(10_001, null, null, null))[0]?.kind).toBe("ARMING_RESET");
    engine.evaluate(observation(11_000, "BUY", "5", null));
    expect(engine.evaluate(observation(21_000, "BUY", "5", "101"))[0]?.fill).toMatchObject({ kind: "ENTRY", price: "101" });
  });

  it("supports an immediate entry when holdSec is zero", () => {
    const engine = new DryRunStrategyEngine(config({ entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "321" } }));
    engine.start(0);
    expect(engine.evaluate(observation(0)).map(({ kind }) => kind)).toEqual(["ARMING_STARTED", "ENTRY_FILLED"]);
    expect(engine.snapshot().currentBasket?.totalQuoteNotional).toBe("321");
  });

  it("uses exact decimal ceiling when converting fractional seconds", () => {
    const short = new DryRunStrategyEngine(config({
      entry: { minEdgeBps: "5", holdSec: 0.0011, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, enabled: false, intervalSec: 0 }
    }));
    short.start(0);
    short.evaluate(observation(0));
    expect(short.snapshot().arming?.readyAtMs).toBe(2);
    expect(short.evaluate(observation(1))).toEqual([]);
    expect(short.evaluate(observation(2))[0]?.kind).toBe("ENTRY_FILLED");

    const large = new DryRunStrategyEngine(config({
      entry: { minEdgeBps: "5", holdSec: 1_063_293.269, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, enabled: false, intervalSec: 0 }
    }));
    large.start(0);
    large.evaluate(observation(0));
    expect(large.snapshot().arming?.readyAtMs).toBe(1_063_293_269);
  });

  it("accepts an entry deadline at MAX_SAFE_INTEGER and rejects the next millisecond without half-state", () => {
    const strategyConfig = config({
      entry: { minEdgeBps: "5", holdSec: 1, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, enabled: false, intervalSec: 0 }
    });
    const boundary = new DryRunStrategyEngine(strategyConfig);
    boundary.start(Number.MAX_SAFE_INTEGER - 1_000);
    boundary.evaluate(observation(Number.MAX_SAFE_INTEGER - 1_000));
    expect(boundary.snapshot().arming?.readyAtMs).toBe(Number.MAX_SAFE_INTEGER);

    const overflow = new DryRunStrategyEngine(strategyConfig);
    overflow.start(Number.MAX_SAFE_INTEGER - 999);
    const before = overflow.snapshot();
    expect(() => overflow.evaluate(observation(Number.MAX_SAFE_INTEGER - 999))).toThrowError("ENTRY_READY_TIME_OVERFLOW");
    const after = overflow.snapshot();
    expect(after.state).toBe("IDLE");
    expect(after.arming).toBe(null);
    expect(after.eventSequence).toBe(before.eventSequence);
    expect(after.fillSequence).toBe(before.fillSequence);
  });

  it("keeps the original arming streak when an opposite-direction deadline would overflow", () => {
    const engine = new DryRunStrategyEngine(config({
      entry: { minEdgeBps: "5", holdSec: 1, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, enabled: false, intervalSec: 0 }
    }));
    engine.start(0);
    engine.evaluate(observation(0, "BUY", "5"));
    const before = engine.snapshot();

    expect(() => engine.evaluate(observation(Number.MAX_SAFE_INTEGER - 999, "SELL", "-5")))
      .toThrowError("ENTRY_READY_TIME_OVERFLOW");
    const after = engine.snapshot();
    expect(after.arming).toEqual(before.arming);
    expect(after.eventSequence).toBe(before.eventSequence);
  });
});

describe("scale-ins and basket accounting", () => {
  it("uses no exponent beyond the final configured entry", () => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: {
        enabled: true,
        intervalSec: 0.001,
        intervalMultiplier: "1e100",
        sizeQuote: "1",
        sizeMultiplier: "1",
        maxEntries: 2,
        maxTotalSizeQuote: "2000"
      }
    }));

    expect(engine.evaluate(observation(1))[0]?.kind).toBe("ADD_FILLED");
    expect(engine.snapshot().currentBasket).toMatchObject({
      entries: expect.any(Array),
      nextEntryQualificationSinceMs: null,
      nextEntryDueAtMs: null
    });
    expect(engine.snapshot().currentBasket?.entries).toHaveLength(2);
  });

  it("allows exactly 100 total entries and then clears the scale timer", () => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: {
        enabled: true,
        intervalSec: 0.001,
        intervalMultiplier: "1",
        sizeQuote: "1",
        sizeMultiplier: "1",
        maxEntries: 100,
        maxTotalSizeQuote: "2000"
      }
    }));

    for (let atMs = 1; atMs <= 99; atMs += 1) {
      expect(engine.evaluate(observation(atMs))[0]?.kind).toBe("ADD_FILLED");
    }
    expect(engine.snapshot().currentBasket).toMatchObject({
      totalQuoteNotional: "1099",
      nextEntryQualificationSinceMs: null,
      nextEntryDueAtMs: null
    });
    expect(engine.snapshot().currentBasket?.entries).toHaveLength(100);
    expect(engine.evaluate(observation(100))).toEqual([]);
  });

  it("does not partially commit an add when its next absolute due time is unsafe", () => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: {
        enabled: true,
        intervalSec: 0.001,
        intervalMultiplier: "9007199254740991",
        sizeQuote: "200",
        sizeMultiplier: "1",
        maxEntries: 3,
        maxTotalSizeQuote: "10000"
      }
    }));
    const before = engine.snapshot();

    let error: unknown;
    try {
      engine.evaluate(observation(1));
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(StrategyStateError);
    expect((error as StrategyStateError).code).toBe("SCALING_DUE_TIME_OVERFLOW");

    const after = engine.snapshot();
    expect(after.eventSequence).toBe(before.eventSequence);
    expect(after.fillSequence).toBe(before.fillSequence);
    expect(after.currentBasket?.entries).toEqual(before.currentBasket?.entries);
    expect(after.currentBasket?.totalQuoteNotional).toBe(before.currentBasket?.totalQuoteNotional);
    expect(after.currentBasket?.nextEntryQualificationSinceMs).toBe(before.currentBasket?.nextEntryQualificationSinceMs);
    expect(after.currentBasket?.nextEntryDueAtMs).toBe(before.currentBasket?.nextEntryDueAtMs);
  });

  it("applies interval and size multipliers only from the second trigger onward", () => {
    const engine = startAndOpen();
    expect(engine.evaluate(observation(1_999))).toEqual([]);
    expect(engine.evaluate(observation(2_000))[0]?.fill).toMatchObject({ kind: "ADD", quoteNotional: "200" });
    expect(engine.snapshot().currentBasket?.nextEntryDueAtMs).toBe(5_000);
    expect(engine.evaluate(observation(4_999))).toEqual([]);
    expect(engine.evaluate(observation(5_000))[0]?.fill).toMatchObject({ quoteNotional: "400" });
    expect(engine.snapshot().currentBasket?.nextEntryDueAtMs).toBe(9_500);
    expect(engine.evaluate(observation(9_500))[0]?.fill).toMatchObject({ quoteNotional: "800" });
    expect(engine.snapshot().currentBasket).toMatchObject({ totalQuoteNotional: "2400", nextEntryDueAtMs: null });
  });

  it("supports decreasing interval and size multipliers", () => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: {
        enabled: true,
        intervalSec: 2,
        intervalMultiplier: "0.5",
        sizeQuote: "400",
        sizeMultiplier: "0.5",
        maxEntries: 4,
        maxTotalSizeQuote: "10000"
      }
    }));
    expect(engine.evaluate(observation(2_000))[0]?.fill?.quoteNotional).toBe("400");
    expect(engine.snapshot().currentBasket?.nextEntryDueAtMs).toBe(3_000);
    expect(engine.evaluate(observation(3_000))[0]?.fill?.quoteNotional).toBe("200");
    expect(engine.snapshot().currentBasket?.nextEntryDueAtMs).toBe(3_500);
    expect(engine.evaluate(observation(3_500))[0]?.fill?.quoteNotional).toBe("100");
  });

  it("keeps a mature scale-in timer while price is missing", () => {
    const engine = startAndOpen();
    expect(engine.evaluate(observation(2_000, "BUY", "5", null))).toEqual([]);
    expect(engine.snapshot().currentBasket).toMatchObject({ nextEntryQualificationSinceMs: 0, nextEntryDueAtMs: 2_000 });
    expect(engine.evaluate(observation(2_001, "BUY", "5", "101"))[0]?.fill).toMatchObject({ kind: "ADD", atMs: 2_001 });
  });

  it("resets only the scale-in streak on reverse edge and never catches up multiple fills", () => {
    const engine = startAndOpen();
    expect(engine.evaluate(observation(1_500, "SELL", "-10"))).toEqual([]);
    expect(engine.snapshot()).toMatchObject({ state: "OPEN", currentBasket: { nextEntryDueAtMs: null } });
    engine.evaluate(observation(2_000, "BUY", "5"));
    expect(engine.snapshot().currentBasket?.nextEntryDueAtMs).toBe(4_000);
    expect(engine.evaluate(observation(3_999))).toEqual([]);
    expect(engine.evaluate(observation(20_000))).toHaveLength(1);
    expect(engine.snapshot().currentBasket).toMatchObject({ entries: expect.any(Array), nextEntryDueAtMs: 23_000 });
    expect(engine.snapshot().currentBasket?.entries).toHaveLength(2);
  });

  it("clips the final add to maxTotalSizeQuote and permanently respects both caps", () => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: {
        enabled: true,
        intervalSec: 1,
        intervalMultiplier: "1",
        sizeQuote: "200",
        sizeMultiplier: "2",
        maxEntries: 10,
        maxTotalSizeQuote: "1250"
      }
    }));
    expect(engine.evaluate(observation(1_000))[0]?.fill).toMatchObject({ quoteNotional: "200", scheduledQuoteNotional: "200", cappedByMaxTotal: false });
    expect(engine.evaluate(observation(2_000))[0]?.fill).toMatchObject({ quoteNotional: "50", scheduledQuoteNotional: "400", cappedByMaxTotal: true });
    expect(engine.snapshot().currentBasket).toMatchObject({ totalQuoteNotional: "1250", nextEntryDueAtMs: null });
    expect(engine.evaluate(observation(100_000))).toEqual([]);
    expect(engine.snapshot().currentBasket?.entries).toHaveLength(3);
  });

  it("uses quote-notional-weighted base quantity for average price and PnL", () => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, intervalSec: 1, intervalMultiplier: "1", sizeQuote: "1000", sizeMultiplier: "1" },
      exit: { takeProfitBps: "50000", linearDecayToZero: false, stopLossBps: "50000", forceExitSec: 100 }
    }));
    engine.evaluate(observation(1_000, "BUY", "5", "200"));
    const basket = engine.snapshot().currentBasket;
    expect(basket).not.toBeNull();
    expect(new Decimal(basket?.totalBaseQuantity as string).toFixed(6)).toBe("15.000000");
    expect(new Decimal(basket?.averageEntryPrice as string).toFixed(6)).toBe("133.333333");
    engine.evaluate(observation(1_001, null, null, "150"));
    expect(engine.snapshot().currentBasket).toMatchObject({ grossPnlQuote: "250.000000", grossPnlBps: "1250.00000000" });
  });
});

describe("PnL and exit policy", () => {
  it.each([
    ["BUY", "110", "100.000000", "1000.00000000"],
    ["BUY", "90", "-100.000000", "-1000.00000000"],
    ["SELL", "110", "-100.000000", "-1000.00000000"],
    ["SELL", "90", "100.000000", "1000.00000000"]
  ] as const)("computes symmetric %s basket PnL at %s", (direction, price, expectedQuote, expectedBps) => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, enabled: false, maxEntries: 1 },
      exit: { takeProfitBps: "9000", linearDecayToZero: false, stopLossBps: "9000", forceExitSec: 100 }
    }), direction);
    engine.evaluate(observation(1, null, null, price));
    expect(engine.snapshot().currentBasket).toMatchObject({ grossPnlQuote: expectedQuote, grossPnlBps: expectedBps });
  });

  it("calculates a linear take-profit target from the first fill only", () => {
    const strategyConfig = config({ exit: { takeProfitBps: "100", linearDecayToZero: true, stopLossBps: "5000", forceExitSec: 10 } });
    expect(currentTargetProfitBps(strategyConfig, 1_000, 1_000)).toBe("100.00000000");
    expect(currentTargetProfitBps(strategyConfig, 1_000, 6_000)).toBe("50.00000000");
    expect(currentTargetProfitBps(strategyConfig, 1_000, 11_000)).toBe("0.00000000");

    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, intervalSec: 2, intervalMultiplier: "1" },
      exit: { takeProfitBps: "10000", linearDecayToZero: true, stopLossBps: "5000", forceExitSec: 10 }
    }));
    engine.evaluate(observation(2_000));
    expect(engine.snapshot().currentBasket).toMatchObject({ openedAtMs: 0, currentTargetProfitBps: "8000.00000000" });
    expect(engine.evaluate(observation(10_000))[0]).toMatchObject({ kind: "EXIT_FILLED", reason: "FORCE_EXIT" });
  });

  it("applies STOP_LOSS before FORCE_EXIT before TAKE_PROFIT, and exits before adding", () => {
    const stopFirst = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      exit: { takeProfitBps: "1", linearDecayToZero: true, stopLossBps: "500", forceExitSec: 1 }
    }));
    expect(stopFirst.evaluate(observation(1_000, "BUY", "5", "90"))[0]).toMatchObject({ kind: "EXIT_FILLED", reason: "STOP_LOSS" });

    const forceSecond = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      exit: { takeProfitBps: "1", linearDecayToZero: true, stopLossBps: "5000", forceExitSec: 1 }
    }));
    expect(forceSecond.evaluate(observation(1_000, "BUY", "5", "110"))[0]).toMatchObject({ reason: "FORCE_EXIT" });

    const profitBeforeAdd = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, intervalSec: 1, intervalMultiplier: "1" },
      exit: { takeProfitBps: "100", linearDecayToZero: false, stopLossBps: "5000", forceExitSec: 100 }
    }));
    const events = profitBeforeAdd.evaluate(observation(1_000, "BUY", "5", "102"));
    expect(events.map(({ kind }) => kind)).toEqual(["EXIT_FILLED"]);
    expect(profitBeforeAdd.snapshot().lastClosedBasket?.entries).toHaveLength(1);
  });

  it("uses full Decimal precision for exit comparisons rather than rounded display PnL", () => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, enabled: false, maxEntries: 1 },
      exit: { takeProfitBps: "1", linearDecayToZero: false, stopLossBps: "5000", forceExitSec: 100 }
    }));
    expect(engine.evaluate(observation(1, null, null, "100.00999999995"))).toEqual([]);
    expect(engine.snapshot().currentBasket?.grossPnlBps).toBe("1.00000000");
    expect(engine.evaluate(observation(2, null, null, "100.01"))[0]).toMatchObject({ reason: "TAKE_PROFIT" });
  });

  it("does not let reverse edge close a basket or reset its force-exit clock", () => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      exit: { takeProfitBps: "5000", linearDecayToZero: false, stopLossBps: "5000", forceExitSec: 10 }
    }));
    expect(engine.evaluate(observation(9_999, "SELL", "-20", "100"))).toEqual([]);
    expect(engine.snapshot()).toMatchObject({ state: "OPEN", currentBasket: { openedAtMs: 0 } });
    expect(engine.evaluate(observation(10_000, "SELL", "-20", "100"))[0]).toMatchObject({ reason: "FORCE_EXIT" });
  });
});

describe("pending exits, cooldown, stop, and restoration", () => {
  it("waits for a real theoretical price after force time and starts cooldown at the fill", () => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      exit: { takeProfitBps: "5000", linearDecayToZero: false, stopLossBps: "5000", forceExitSec: 10 },
      cooldownSec: 5
    }));
    expect(engine.evaluate(observation(10_000, "BUY", "5", null))[0]).toMatchObject({ kind: "EXIT_PENDING_PRICE", reason: "FORCE_EXIT" });
    expect(engine.snapshot()).toMatchObject({ state: "EXIT_PENDING_PRICE", pendingExitReason: "FORCE_EXIT" });
    expect(engine.evaluate(observation(11_000, "SELL", "-50", null))).toEqual([]);
    const events = engine.evaluate(observation(12_000, "SELL", "-50", "110"));
    expect(events[0]).toMatchObject({ kind: "EXIT_FILLED", reason: "FORCE_EXIT", atMs: 12_000 });
    expect(engine.snapshot()).toMatchObject({ state: "COOLDOWN", cooldownUntilMs: 17_000 });
  });

  it("requires a fresh hold after cooldown and creates a new basket", () => {
    const strategyConfig = config({
      entry: { minEdgeBps: "5", holdSec: 2, initialSizeQuote: "1000" },
      exit: { takeProfitBps: "100", linearDecayToZero: false, stopLossBps: "5000", forceExitSec: 100 },
      cooldownSec: 5
    });
    const engine = new DryRunStrategyEngine(strategyConfig);
    engine.start(0);
    engine.evaluate(observation(0));
    engine.evaluate(observation(2_000));
    engine.evaluate(observation(3_000, null, null, "102"));
    expect(engine.snapshot()).toMatchObject({ state: "COOLDOWN", cooldownUntilMs: 8_000 });
    expect(engine.evaluate(observation(7_999))).toEqual([]);
    expect(engine.evaluate(observation(8_000)).map(({ kind }) => kind)).toEqual(["COOLDOWN_COMPLETED", "ARMING_STARTED"]);
    expect(engine.evaluate(observation(9_999))).toEqual([]);
    expect(engine.evaluate(observation(10_000))[0]?.kind).toBe("ENTRY_FILLED");
    expect(engine.snapshot().basketCount).toBe(2);
  });

  it("precomputes a safe cooldown deadline before mutating a closing basket", () => {
    const strategyConfig = config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, enabled: false, intervalSec: 0 },
      cooldownSec: 1
    });
    const boundary = startAndOpen(strategyConfig);
    expect(boundary.evaluate(observation(Number.MAX_SAFE_INTEGER - 1_000, null, null, "100"))[0])
      .toMatchObject({ kind: "EXIT_FILLED", reason: "FORCE_EXIT" });
    expect(boundary.snapshot().cooldownUntilMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => DryRunStrategyEngine.restore(strategyConfig, boundary.snapshot())).not.toThrow();

    const overflow = startAndOpen(strategyConfig);
    const before = overflow.snapshot();
    expect(() => overflow.evaluate(observation(Number.MAX_SAFE_INTEGER - 999, null, null, "100")))
      .toThrowError("COOLDOWN_TIME_OVERFLOW");
    const after = overflow.snapshot();
    expect(after.state).toBe("OPEN");
    expect(after.currentBasket).toEqual(before.currentBasket);
    expect(after.lastClosedBasket).toBe(null);
    expect(after.eventSequence).toBe(before.eventSequence);
    expect(after.fillSequence).toBe(before.fillSequence);
  });

  it("ceil-rounds a fractional cooldown once", () => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, enabled: false, intervalSec: 0 },
      exit: { ...config().exit, takeProfitBps: "1" },
      cooldownSec: 0.0011
    }));
    expect(engine.evaluate(observation(0, null, null, "101"))[0]?.kind).toBe("EXIT_FILLED");
    expect(engine.snapshot().cooldownUntilMs).toBe(2);
  });

  it("uses EXIT_PENDING_PRICE for a manual stop without a mark and then stops", () => {
    const engine = startAndOpen();
    expect(engine.stop(observation(1_000, null, null, null))[0]).toMatchObject({ reason: "MANUAL_STOP" });
    expect(engine.snapshot()).toMatchObject({ state: "EXIT_PENDING_PRICE", stopRequested: true });
    expect(engine.evaluate(observation(2_000, null, null, "99")).map(({ kind }) => kind)).toEqual(["EXIT_FILLED", "RUN_STOPPED"]);
    expect(engine.snapshot()).toMatchObject({ state: "STOPPED", stoppedAtMs: 2_000 });
  });

  it("closes immediately when stop supplies a price while an exit is pending", () => {
    const engine = startAndOpen(config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      exit: { ...config().exit, forceExitSec: 1 }
    }));
    expect(engine.evaluate(observation(1_000, null, null, null))[0]).toMatchObject({
      kind: "EXIT_PENDING_PRICE",
      reason: "FORCE_EXIT"
    });

    const events = engine.stop(observation(1_001, null, null, "99"));
    expect(events.map(({ kind }) => kind)).toEqual(["EXIT_FILLED", "RUN_STOPPED"]);
    expect(events[0]).toMatchObject({ reason: "MANUAL_STOP", fill: { price: "99" } });
    expect(engine.snapshot()).toMatchObject({ state: "STOPPED", stoppedAtMs: 1_001 });
  });

  it("restores an arming timer and continues event sequencing deterministically", () => {
    const strategyConfig = config();
    const uninterrupted = new DryRunStrategyEngine(strategyConfig);
    uninterrupted.start(0);
    uninterrupted.evaluate(observation(0));
    uninterrupted.evaluate(observation(5_000));
    const restored = DryRunStrategyEngine.restore(strategyConfig, uninterrupted.snapshot());

    const expected = uninterrupted.evaluate(observation(10_000));
    const actual = restored.evaluate(observation(10_000));
    expect(actual).toEqual(expected);
    expect(restored.snapshot()).toEqual(uninterrupted.snapshot());
  });

  it("restores scale-in qualification and pending exit state", () => {
    const strategyConfig = config({
      entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
      scaling: { ...config().scaling, intervalSec: 2, intervalMultiplier: "1" },
      exit: { takeProfitBps: "5000", linearDecayToZero: false, stopLossBps: "5000", forceExitSec: 10 }
    });
    const engine = startAndOpen(strategyConfig);
    engine.evaluate(observation(1_000, "SELL", "-5"));
    engine.evaluate(observation(2_000));
    const restoredOpen = DryRunStrategyEngine.restore(strategyConfig, engine.snapshot());
    expect(restoredOpen.evaluate(observation(3_999))).toEqual([]);
    expect(restoredOpen.evaluate(observation(4_000))[0]?.kind).toBe("ADD_FILLED");

    restoredOpen.evaluate(observation(10_000, "BUY", "5", null));
    const restoredPending = DryRunStrategyEngine.restore(strategyConfig, restoredOpen.snapshot());
    expect(restoredPending.evaluate(observation(11_000, null, null, "101"))[0]).toMatchObject({ kind: "EXIT_FILLED", reason: "FORCE_EXIT" });
  });

  it("restores cooldown and resumes from its exact absolute deadline", () => {
    const strategyConfig = config({
      entry: { minEdgeBps: "5", holdSec: 1, initialSizeQuote: "1000" },
      exit: { takeProfitBps: "100", linearDecayToZero: false, stopLossBps: "5000", forceExitSec: 100 },
      cooldownSec: 5
    });
    const engine = new DryRunStrategyEngine(strategyConfig);
    engine.start(0);
    engine.evaluate(observation(0));
    engine.evaluate(observation(1_000));
    engine.evaluate(observation(2_000, null, null, "102"));
    const restored = DryRunStrategyEngine.restore(strategyConfig, engine.snapshot());
    expect(restored.evaluate(observation(6_999))).toEqual([]);
    expect(restored.evaluate(observation(7_000)).map(({ kind }) => kind)).toEqual(["COOLDOWN_COMPLETED", "ARMING_STARTED"]);
  });

  it("rejects restoration with a different config or inconsistent snapshot", () => {
    const strategyConfig = config();
    const engine = new DryRunStrategyEngine(strategyConfig);
    engine.start(0);
    const snapshot = engine.snapshot();
    expect(() => DryRunStrategyEngine.restore(config({ cooldownSec: 99 }), snapshot)).toThrow(StrategySnapshotError);
    expect(() => DryRunStrategyEngine.restore(strategyConfig, { ...snapshot, state: "OPEN" })).toThrow(StrategySnapshotError);
    expect(() => DryRunStrategyEngine.restore(strategyConfig, null)).toThrow(StrategySnapshotError);
    expect(() => DryRunStrategyEngine.restore(strategyConfig, { ...snapshot, lastObservation: 7 })).toThrow(StrategySnapshotError);
  });

  it("returns defensive snapshots that cannot mutate engine state", () => {
    const engine = startAndOpen();
    const leaked = engine.snapshot();
    if (leaked.currentBasket) leaked.currentBasket.entries[0]!.quoteNotional = "999999";
    expect(engine.snapshot().currentBasket?.entries[0]?.quoteNotional).toBe("1000");
  });

  it("is byte-for-byte deterministic for the same normalized observation sequence", () => {
    const run = () => {
      const engine = new DryRunStrategyEngine(config({ entry: { minEdgeBps: "5", holdSec: 1, initialSizeQuote: "1000" } }));
      const events = [
        ...engine.start(0),
        ...engine.evaluate(observation(0)),
        ...engine.evaluate(observation(1_000)),
        ...engine.evaluate(observation(3_000)),
        ...engine.evaluate(observation(4_000, "SELL", "-9")),
        ...engine.evaluate(observation(5_000, "BUY", "5")),
        ...engine.evaluate(observation(7_000, "BUY", "5"))
      ];
      return { events, snapshot: engine.snapshot() };
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
