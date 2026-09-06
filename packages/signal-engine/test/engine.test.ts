import { describe, expect, it } from "vitest";
import { S0SignalEngine } from "../src/index.js";
import { goldenScenarios, sourceHealthEvent, staleScenario } from "./fixtures/golden-scenarios.js";

function run(events: readonly Parameters<S0SignalEngine["ingest"]>[0][]) {
  const engine = new S0SignalEngine();
  const transitions = events.flatMap((event) => engine.ingest(event));
  return { snapshot: engine.snapshot(), transitions };
}

describe("s0-v1 golden scenarios", () => {
  it("produces BUY_BIAS for the spot-led scenario", () => {
    const { snapshot } = run(goldenScenarios["spot-led"]);
    expect(snapshot.verdict).toMatchObject({
      modelVersion: "s0-v1",
      verdict: "BUY_BIAS",
      dataState: "READY",
      freshJuryCount: 4,
      buyJuryCount: 3
    });
    expect(snapshot.juries.map(({ vote }) => vote)).toEqual(["BUY", "BUY", "BUY", "NEUTRAL"]);
  });

  it("produces SELL_BIAS for the perp-led leverage-heavy fixture", () => {
    const { snapshot } = run(goldenScenarios["leverage-heavy"]);
    expect(snapshot.verdict.verdict).toBe("SELL_BIAS");
    expect(snapshot.juries.map(({ vote }) => vote)).toEqual(["SELL", "SELL", "NEUTRAL", "SELL"]);
  });

  it("keeps opposing spot and perp evidence at NO_EDGE", () => {
    const { snapshot } = run(goldenScenarios.disagreement);
    expect(snapshot.verdict).toMatchObject({
      verdict: "NO_EDGE",
      dataState: "READY",
      buyJuryCount: 2,
      sellJuryCount: 2
    });
  });

  it("fails closed after two source failures and preserves last valid verdict", () => {
    const { snapshot } = run(staleScenario);
    expect(snapshot.verdict).toMatchObject({
      verdict: "INSUFFICIENT_DATA",
      dataState: "INSUFFICIENT_DATA",
      freshJuryCount: 2,
      lastValidVerdict: "BUY_BIAS"
    });
    expect(snapshot.juries.find(({ segment }) => segment === "cex-spot")?.reasons).toContain("SOURCE_DISCONNECTED");
    expect(snapshot.juries.find(({ segment }) => segment === "dex-spot")?.reasons).toContain("SOURCE_GAP");
  });

  it("is byte-for-byte deterministic for the same event log", () => {
    const first = run(goldenScenarios["spot-led"]);
    const second = run(goldenScenarios["spot-led"]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("missing feature and health behavior", () => {
  it("does not zero-fill missing flow", () => {
    const withoutTrades = goldenScenarios["spot-led"].filter(
      (event) => !(event.segment === "spot" && event.kind === "trade")
    );
    const { snapshot } = run(withoutTrades);
    const spot = snapshot.juries.find(({ segment }) => segment === "cex-spot");
    expect(spot?.dataState).toBe("FRESH");
    expect(spot?.vote).toBe("NEUTRAL");
    expect(spot?.features.aggressorImbalance30s).toMatchObject({ status: "missing", value: null });
  });

  it("distinguishes a quiet live transport from a stale transport", () => {
    const live = sourceHealthEvent("dex-spot", 1_750_000_000_000, "1", "live", "fresh");
    const stale = sourceHealthEvent("dex-spot", 1_750_000_001_000, "2", "closed", "stale");
    const engine = new S0SignalEngine();
    engine.ingest(live);
    const quietJury = engine.snapshot().juries.find(({ segment }) => segment === "dex-spot");
    expect(quietJury).toMatchObject({ dataState: "FRESH", vote: "NEUTRAL" });
    expect(quietJury?.reasons).toContain("QUIET_OR_NO_AGGRESSOR_FLOW");

    engine.ingest(stale);
    const staleJury = engine.snapshot().juries.find(({ segment }) => segment === "dex-spot");
    expect(staleJury).toMatchObject({ dataState: "UNAVAILABLE", vote: "NEUTRAL" });
    expect(staleJury?.reasons).toContain("SOURCE_DISCONNECTED");
  });

  it("expires a silent transport when the deterministic clock advances", () => {
    const atMs = 1_750_000_000_000;
    const engine = new S0SignalEngine();
    engine.ingest(sourceHealthEvent("cex-spot", atMs, "1", "live", "fresh"));
    expect(engine.snapshot().juries.find(({ segment }) => segment === "cex-spot")?.dataState).toBe("FRESH");

    const transitions = engine.tick(atMs + 5_001);
    const jury = engine.snapshot().juries.find(({ segment }) => segment === "cex-spot");
    expect(jury?.dataState).toBe("UNAVAILABLE");
    expect(jury?.reasons).toContain("SOURCE_STALE");
    expect(transitions.some(({ kind }) => kind === "jury-changed")).toBe(true);
    expect(() => engine.tick(atMs)).toThrow(/monotonically/u);
  });
});
