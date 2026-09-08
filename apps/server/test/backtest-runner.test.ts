import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { decodeEventLog, PartitionedEventRecorder, type EventDatasetManifest } from "@side/recorder-replay";
import type { StrategyConfigV1 } from "@side/strategy-engine";
import { BacktestRunner, runObservationBacktest } from "../src/backtest/runner.js";
import { createApp } from "../src/app.js";

const temporaryDirectories: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const fixturePath = fileURLToPath(
  new URL("../../../packages/recorder-replay/test/fixtures/golden/spot-led.jsonl", import.meta.url)
);

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const config: StrategyConfigV1 = {
  schemaVersion: 1,
  name: "Backtest deterministic entry",
  pair: "SOL-USDC",
  entry: { minEdgeBps: "5", holdSec: 0, initialSizeQuote: "1000" },
  scaling: {
    enabled: false,
    intervalSec: 0,
    intervalMultiplier: "1",
    sizeQuote: "100",
    sizeMultiplier: "1",
    maxEntries: 1,
    maxTotalSizeQuote: "1000"
  },
  exit: { takeProfitBps: "50", linearDecayToZero: false, stopLossBps: "100", forceExitSec: 60 },
  cooldownSec: 60
};

function manifest(): EventDatasetManifest {
  return {
    schemaVersion: 1,
    datasetId: "backtest-unit",
    format: "side-canonical-dataset-v1",
    status: "COMPLETE",
    createdAtMs: 900,
    closedAtMs: 2_100,
    marketEventSchemaVersion: 1,
    observationCadenceMs: 1_000,
    eventCount: 0,
    observationCount: 2,
    firstReceivedAtMs: null,
    lastReceivedAtMs: null,
    firstObservationAtMs: 1_000,
    lastObservationAtMs: 2_000,
    firstIngestSeq: null,
    lastIngestSeq: null,
    providers: [],
    signalModelVersions: ["s0-v1"],
    eventPartitions: [],
    observationPartitions: [],
    datasetSha256: "a".repeat(64),
    failure: null
  };
}

const observations = [
  { atMs: 1_000, direction: "BUY" as const, edgeBps: "10", price: "100", referenceSource: "test", coverageState: "READY" as const },
  { atMs: 2_000, direction: "BUY" as const, edgeBps: "10", price: "101", referenceSource: "test", coverageState: "READY" as const }
];

describe("single-dataset backtest runner", () => {
  it("produces deterministic basket results and capital-normalized metrics", () => {
    const first = runObservationBacktest({ manifest: manifest(), observations, observationSource: "RECORDED_TAPE", config });
    const second = runObservationBacktest({ manifest: manifest(), observations, observationSource: "RECORDED_TAPE", config });

    expect(first).toEqual(second);
    expect(first.resultSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.summary).toMatchObject({
      observationCount: 2,
      readyObservationCount: 2,
      basketCount: 1,
      closedBasketCount: 1,
      winCount: 1,
      entryFillCount: 1,
      totalEntryNotionalQuote: "1000.000000",
      closedPnlQuote: "10.000000",
      totalTheoreticalPnlQuote: "10.000000",
      returnOnMaxCapitalBps: "100.00000000",
      exitReasonCounts: { TAKE_PROFIT: 1, STOP_LOSS: 0, FORCE_EXIT: 0, MANUAL_STOP: 0 }
    });
    expect(first.baskets[0]).toMatchObject({ direction: "BUY", exitReason: "TAKE_PROFIT", grossPnlQuote: "10.000000" });
    expect(first.equityCurve).toEqual([
      { atMs: 1_000, equityQuote: "0.000000", closedPnlQuote: "0.000000", openPnlQuote: "0.000000" },
      { atMs: 2_000, equityQuote: "10.000000", closedPnlQuote: "10.000000", openPnlQuote: "0.000000" }
    ]);
  });

  it("loads a completed recorded observation tape by dataset id", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "side-backtest-"));
    temporaryDirectories.push(rootDir);
    let nowMs = 900;
    const recorder = new PartitionedEventRecorder({ rootDir, datasetId: "backtest-tape", now: () => nowMs });
    for (const observation of observations) {
      recorder.recordObservation({
        schemaVersion: 1,
        ...observation,
        signalModelVersion: "s0-v1",
        asOfIngestSeq: "0",
        freshJuryCount: 4
      });
    }
    nowMs = 2_100;
    await recorder.close();

    const result = await new BacktestRunner(rootDir).run("backtest-tape", config);
    expect(result.dataset).toMatchObject({
      datasetId: "backtest-tape",
      observationSource: "RECORDED_TAPE",
      observationCount: 2
    });
    expect(result.summary.totalTheoreticalPnlQuote).toBe("10.000000");

    const app = await createApp({ replayJsonl: "", recordingRootDir: rootDir });
    apps.push(app);
    const datasets = (await app.inject({ method: "GET", url: "/api/backtest-datasets" })).json().datasets;
    expect(datasets).toHaveLength(1);
    const response = await app.inject({
      method: "POST",
      url: "/api/backtests",
      payload: { datasetId: "backtest-tape", config }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toMatchObject({
      executionModel: "GROSS_THEORETICAL_V1",
      summary: { totalTheoreticalPnlQuote: "10.000000" }
    });
  });

  it("reconstructs fixed one-second observations when a canonical dataset has no tape", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "side-backtest-events-"));
    temporaryDirectories.push(rootDir);
    const events = decodeEventLog(readFileSync(fixturePath, "utf8"));
    let nowMs = events[0]?.receivedAtUnixMs ?? 0;
    const recorder = new PartitionedEventRecorder({ rootDir, datasetId: "backtest-events", now: () => nowMs });
    for (const event of events) recorder.record(event);
    nowMs = events[events.length - 1]?.receivedAtUnixMs ?? nowMs;
    await recorder.close();

    const result = await new BacktestRunner(rootDir).run("backtest-events", config);
    expect(result.dataset).toMatchObject({
      observationSource: "RECONSTRUCTED_EVENTS",
      eventCount: 3,
      observationCount: 3
    });
    expect(result.summary).toMatchObject({ observationCount: 3, basketCount: 0 });
  });
});
