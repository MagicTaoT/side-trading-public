import type { JurySnapshot, SignalSnapshot, Verdict } from "@side/signal-engine";
import type { StrategyConfigV1, StrategyObservation } from "@side/strategy-engine";
import { describe, expect, it } from "vitest";
import type { PaperDryReferenceSnapshot } from "../src/paper/contracts.js";
import { StrategyCoordinator, strategyObservation } from "../src/strategy/coordinator.js";
import { MemoryStrategyJournal } from "../src/strategy/journal.js";

class FailOnceStrategyJournal extends MemoryStrategyJournal {
  failure: "BEFORE_COMMIT" | "AFTER_COMMIT" | null = null;

  override async recordBatch(input: Parameters<MemoryStrategyJournal["recordBatch"]>[0]) {
    const failure = this.failure;
    this.failure = null;
    if (failure === "BEFORE_COMMIT") throw new Error("SIMULATED_JOURNAL_FAILURE");
    const result = await super.recordBatch(input);
    if (failure === "AFTER_COMMIT") throw new Error("SIMULATED_UNCERTAIN_COMMIT");
    return result;
  }
}

function jury(index: number, vote: "BUY" | "SELL" | "NEUTRAL", impulse: string | null): JurySnapshot {
  return {
    modelVersion: "s0-v1",
    segment: (["cex-spot", "cex-perp", "dex-spot", "defi-perp"] as const)[index] as JurySnapshot["segment"],
    dataState: "FRESH",
    vote,
    evaluatedAtMs: 1_000,
    asOfIngestSeq: "1",
    sourceProviders: [`source-${index}`],
    limitedSourceCoverage: true,
    features: {
      priceImpulse30s: { status: "available", valueBps: impulse, direction: vote, anchorAtMs: 0, latestAtMs: 1_000 },
      aggressorImbalance30s: { status: "available", value: "0.5", direction: vote, totalNotionalQuote: "1000", minimumNotionalQuote: "100" }
    },
    reasons: []
  };
}

function signal(verdict: Verdict, votes: Array<["BUY" | "SELL" | "NEUTRAL", string | null]>): SignalSnapshot {
  const juries = votes.map(([vote, impulse], index) => jury(index, vote, impulse));
  return {
    modelVersion: "s0-v1",
    evaluatedAtMs: 1_000,
    asOfIngestSeq: "1",
    juries,
    verdict: {
      modelVersion: "s0-v1",
      verdict,
      dataState: verdict === "INSUFFICIENT_DATA" ? "INSUFFICIENT_DATA" : "READY",
      evaluatedAtMs: 1_000,
      asOfIngestSeq: "1",
      freshJuryCount: 4,
      buyJuryCount: juries.filter(({ vote }) => vote === "BUY").length,
      sellJuryCount: juries.filter(({ vote }) => vote === "SELL").length,
      neutralJuryCount: juries.filter(({ vote }) => vote === "NEUTRAL").length,
      lastValidVerdict: null,
      reasons: []
    }
  };
}

const reference: PaperDryReferenceSnapshot = {
  status: "READY",
  source: "coinbase-sol-usd",
  priceQuotePerSol: "100",
  observedAtMs: 1_000,
  reason: null
};

const config: StrategyConfigV1 = {
  schemaVersion: 1,
  name: "coordinator-test",
  pair: "SOL-USDC",
  entry: { minEdgeBps: "3", holdSec: 1, initialSizeQuote: "100" },
  scaling: { enabled: false, intervalSec: 0, intervalMultiplier: "1", sizeQuote: "10", sizeMultiplier: "1", maxEntries: 1, maxTotalSizeQuote: "100" },
  exit: { takeProfitBps: "10", linearDecayToZero: false, stopLossBps: "20", forceExitSec: 60 },
  cooldownSec: 0
};

function observation(atMs: number, price: string): StrategyObservation {
  return { atMs, direction: "BUY", edgeBps: "4", price, referenceSource: "test-reference" };
}

describe("strategy coordinator", () => {
  it("uses the third-strongest agreeing jury impulse as the scalar edge", () => {
    expect(strategyObservation(signal("BUY_BIAS", [["BUY", "4"], ["BUY", "9"], ["BUY", "6"], ["BUY", "3"]]), reference, 1_500))
      .toMatchObject({ direction: "BUY", edgeBps: "4", price: "100" });
    expect(strategyObservation(signal("NO_EDGE", [["BUY", "9"], ["BUY", "8"], ["NEUTRAL", "0"], ["SELL", "-7"]]), reference, 1_500))
      .toMatchObject({ direction: null, edgeBps: null, price: "100" });
  });

  it("versions config and persists a complete dry-run lifecycle", async () => {
    const journal = new MemoryStrategyJournal();
    const coordinator = new StrategyCoordinator(journal, () => 1_000);
    await coordinator.initialize();
    const revision = await coordinator.saveConfig(config);
    const started = await coordinator.start(revision.strategyId, revision.revision);
    expect(started.status).toBe("IDLE");

    expect((await coordinator.evaluate(observation(1_000, "100")))?.status).toBe("ARMING");
    await coordinator.evaluate(observation(1_500, "100"));
    expect(await journal.getRun(started.runId)).toMatchObject({
      updatedAtMs: 1_500,
      snapshot: { state: "ARMING", evaluatedAtMs: 1_500, eventSequence: 2 }
    });
    expect((await coordinator.evaluate(observation(2_000, "100")))?.status).toBe("OPEN");
    await coordinator.evaluate(observation(2_500, "100.005"));
    expect((await journal.listBaskets(started.runId))[0]).toMatchObject({
      updatedAtMs: 2_500,
      snapshot: { status: "OPEN", currentPrice: "100.005", grossPnlBps: "0.50000000" }
    });
    const exited = await coordinator.evaluate(observation(3_000, "100.2"));
    expect(exited?.snapshot.lastClosedBasket).toMatchObject({ exitReason: "TAKE_PROFIT", grossPnlBps: "20.00000000" });

    const stopped = await coordinator.stop(started.runId, observation(4_000, "100.2"));
    expect(stopped.status).toBe("STOPPED");
    expect(coordinator.activeRun()).toBeNull();
    expect((await coordinator.runDetail(started.runId))?.events.map(({ event }) => event.kind)).toEqual([
      "RUN_STARTED", "ARMING_STARTED", "ENTRY_FILLED", "EXIT_FILLED", "RUN_STOPPED"
    ]);
    await coordinator.close();
  });

  it("atomically records multi-event entry and stop evaluations", async () => {
    const journal = new MemoryStrategyJournal();
    const coordinator = new StrategyCoordinator(journal, () => 1_000);
    await coordinator.initialize();
    const revision = await coordinator.saveConfig({
      ...config,
      entry: { ...config.entry, holdSec: 0 }
    });
    const started = await coordinator.start(revision.strategyId, revision.revision);

    expect((await coordinator.evaluate(observation(1_000, "100")))?.status).toBe("OPEN");
    expect((await coordinator.runDetail(started.runId))?.events.map(({ event }) => event.kind)).toEqual([
      "RUN_STARTED", "ARMING_STARTED", "ENTRY_FILLED"
    ]);

    expect((await coordinator.stop(started.runId, observation(2_000, "100"))).status).toBe("STOPPED");
    expect((await coordinator.runDetail(started.runId))?.events.map(({ event }) => event.kind)).toEqual([
      "RUN_STARTED", "ARMING_STARTED", "ENTRY_FILLED", "EXIT_FILLED", "RUN_STOPPED"
    ]);
    await coordinator.close();
  });

  it.each(["BEFORE_COMMIT", "AFTER_COMMIT"] as const)(
    "reconciles the engine after a %s journal failure before accepting another observation",
    async (failure) => {
      const journal = new FailOnceStrategyJournal();
      const coordinator = new StrategyCoordinator(journal, () => 1_000);
      await coordinator.initialize();
      const revision = await coordinator.saveConfig({
        ...config,
        entry: { ...config.entry, holdSec: 0 }
      });
      const started = await coordinator.start(revision.strategyId, revision.revision);
      journal.failure = failure;

      await expect(coordinator.evaluate(observation(1_000, "100"))).rejects.toThrow();
      const stateAfterFailure = coordinator.activeRun()?.status;
      expect(stateAfterFailure).toBe(failure === "BEFORE_COMMIT" ? "IDLE" : "OPEN");

      if (failure === "BEFORE_COMMIT") {
        expect((await coordinator.evaluate(observation(1_000, "100")))?.status).toBe("OPEN");
      }
      expect((await coordinator.stop(started.runId, observation(2_000, "100"))).status).toBe("STOPPED");
      expect((await coordinator.runDetail(started.runId))?.events.map(({ event }) => event.kind)).toEqual([
        "RUN_STARTED", "ARMING_STARTED", "ENTRY_FILLED", "EXIT_FILLED", "RUN_STOPPED"
      ]);
      await coordinator.close();
    }
  );

  it("restores an active checkpoint and continues its original timing after restart", async () => {
    const journal = new MemoryStrategyJournal();
    const first = new StrategyCoordinator(journal, () => 1_000);
    await first.initialize();
    const revision = await first.saveConfig(config);
    const started = await first.start(revision.strategyId, revision.revision);
    await first.evaluate(observation(1_000, "100"));
    await first.evaluate(observation(1_500, "100"));

    const restored = new StrategyCoordinator(journal, () => 1_500);
    await restored.initialize();
    expect(restored.activeRun()).toMatchObject({
      runId: started.runId,
      status: "ARMING",
      snapshot: { evaluatedAtMs: 1_500, arming: { startedAtMs: 1_000, readyAtMs: 2_000 } }
    });
    expect((await restored.evaluate(observation(2_000, "100")))?.status).toBe("OPEN");
    expect((await restored.runDetail(started.runId))?.events.map(({ event }) => event.kind)).toEqual([
      "RUN_STARTED", "ARMING_STARTED", "ENTRY_FILLED"
    ]);
  });
});
