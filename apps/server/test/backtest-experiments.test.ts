import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatasetArchive, PartitionedEventRecorder } from "@side/recorder-replay";
import type { StrategyConfigV1 } from "@side/strategy-engine";
import { createApp } from "../src/app.js";
import { BacktestExperimentService, expandExperimentConfigs } from "../src/backtest/experiments.js";
import { BacktestRunner } from "../src/backtest/runner.js";

const temporaryDirectories: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const baseConfig: StrategyConfigV1 = {
  schemaVersion: 1,
  name: "Experiment baseline",
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

async function completedTape(): Promise<{ recordingRoot: string; resultRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "side-experiment-"));
  temporaryDirectories.push(root);
  const recordingRoot = join(root, "recordings");
  const resultRoot = join(root, "results");
  let nowMs = 900;
  const recorder = new PartitionedEventRecorder({ rootDir: recordingRoot, datasetId: "experiment-tape", now: () => nowMs });
  for (const observation of [
    { atMs: 1_000, direction: "BUY" as const, edgeBps: "10", price: "100" },
    { atMs: 2_000, direction: "BUY" as const, edgeBps: "10", price: "101" }
  ]) {
    recorder.recordObservation({
      schemaVersion: 1,
      ...observation,
      referenceSource: "test",
      coverageState: "READY",
      signalModelVersion: "s0-v1",
      asOfIngestSeq: "0",
      freshJuryCount: 4
    });
  }
  nowMs = 2_100;
  await recorder.close();
  return { recordingRoot, resultRoot };
}

describe("backtest experiment batches", () => {
  it("expands and deduplicates a typed parameter grid", () => {
    const expanded = expandExperimentConfigs({
      datasetId: "experiment-tape",
      baseConfig,
      parameterGrid: {
        "entry.minEdgeBps": ["3", "5"],
        "exit.forceExitSec": [30, 60],
        "scaling.enabled": [false, false]
      }
    });
    expect(expanded.configs).toHaveLength(4);
    expect(expanded.configs.map((config) => [config.entry.minEdgeBps, config.exit.forceExitSec])).toEqual([
      ["3", 30], ["3", 60], ["5", 30], ["5", 60]
    ]);
  });

  it("prepares a dataset once, persists results, and reloads durable history", async () => {
    const { recordingRoot, resultRoot } = await completedTape();
    const runner = new BacktestRunner(recordingRoot);
    const prepare = vi.spyOn(runner, "prepare");
    const service = new BacktestExperimentService(runner, resultRoot);
    await service.initialize();
    const created = await service.create({
      name: "Two variants",
      datasetId: "experiment-tape",
      configs: [baseConfig, { ...baseConfig, name: "Higher threshold", entry: { ...baseConfig.entry, minEdgeBps: "8" } }]
    });
    await service.flush();

    const finished = service.get(created.experimentId);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(finished).toMatchObject({ status: "COMPLETED", variantCount: 2, completedVariantCount: 2, failedVariantCount: 0 });
    const result = await service.result(created.experimentId, "variant-001");
    expect(result.summary.totalTheoreticalPnlQuote).toBe("10.000000");
    expect(result.equityCurve).toHaveLength(2);
    const artifact = JSON.parse(await readFile(join(resultRoot, created.experimentId, "experiment.json"), "utf8")) as { status: string };
    expect(artifact.status).toBe("COMPLETED");

    const restored = new BacktestExperimentService(new BacktestRunner(recordingRoot), resultRoot);
    await restored.initialize();
    expect(restored.list()).toMatchObject([{ experimentId: created.experimentId, status: "COMPLETED" }]);
    await service.close();
    await restored.close();
  });

  it("exposes async experiment history and variant drill-down APIs", async () => {
    const { recordingRoot, resultRoot } = await completedTape();
    const app = await createApp({ replayJsonl: "", recordingRootDir: recordingRoot, backtestResultRootDir: resultRoot });
    apps.push(app);
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/backtest-experiments",
      payload: { name: "API grid", datasetId: "experiment-tape", baseConfig, parameterGrid: { "entry.minEdgeBps": ["5", "8"] } }
    });
    expect(createResponse.statusCode).toBe(202);
    const experimentId = createResponse.json().experiment.experimentId as string;

    let experiment: { status: string; completedVariantCount: number } | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await app.inject({ method: "GET", url: `/api/backtest-experiments/${experimentId}` });
      experiment = response.json().experiment;
      if (experiment?.status === "COMPLETED") break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    expect(experiment).toMatchObject({ status: "COMPLETED", completedVariantCount: 2 });
    const listResponse = await app.inject({ method: "GET", url: "/api/backtest-experiments" });
    expect(listResponse.json().experiments[0].experimentId).toBe(experimentId);
    const resultResponse = await app.inject({ method: "GET", url: `/api/backtest-experiments/${experimentId}/variants/variant-001` });
    expect(resultResponse.statusCode).toBe(200);
    expect(resultResponse.json().result).toMatchObject({ executionModel: "GROSS_THEORETICAL_V1", equityCurve: expect.any(Array) });
  });

  it("lists, downloads, and explicitly deletes a completed recording archive", async () => {
    const { recordingRoot, resultRoot } = await completedTape();
    const archiveRoot = join(resultRoot, "archives");
    const archived = await createDatasetArchive(recordingRoot, archiveRoot, "experiment-tape");
    const app = await createApp({
      replayJsonl: "",
      recordingRootDir: recordingRoot,
      recordingArchiveRootDir: archiveRoot,
      backtestResultRootDir: resultRoot
    });
    apps.push(app);

    const list = await app.inject({ method: "GET", url: "/api/recording/archives" });
    expect(list.json().archives).toEqual([archived]);
    const download = await app.inject({ method: "GET", url: "/api/recording/archives/experiment-tape/download" });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("experiment-tape.tar.gz");
    expect(download.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

    expect((await app.inject({ method: "DELETE", url: "/api/recording/archives/experiment-tape" })).statusCode).toBe(400);
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/recording/archives/experiment-tape",
      headers: { "x-side-confirm-delete": "experiment-tape" }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true, datasetId: "experiment-tape" });
  });

  it("fails closed when a requested 24-hour composite lacks a valid range", async () => {
    const { recordingRoot, resultRoot } = await completedTape();
    const app = await createApp({ replayJsonl: "", recordingRootDir: recordingRoot, backtestResultRootDir: resultRoot });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/backtest-datasets/composites", payload: { hours: 24 } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_COMPOSITE_RANGE" } });
  });

  it("accepts only the supported research durations", async () => {
    const { recordingRoot, resultRoot } = await completedTape();
    const app = await createApp({ replayJsonl: "", recordingRootDir: recordingRoot, backtestResultRootDir: resultRoot });
    apps.push(app);
    for (const hours of [3, 6, 12, 24, 72]) {
      const response = await app.inject({ method: "POST", url: "/api/backtest-datasets/composites", payload: { hours } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).not.toBe("INVALID_COMPOSITE_DURATION");
    }
    const unsupported = await app.inject({ method: "POST", url: "/api/backtest-datasets/composites", payload: { hours: 168 } });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toMatchObject({ error: { code: "INVALID_COMPOSITE_DURATION" } });
  });

  it("protects research mutations and archive downloads with one passcode", async () => {
    const { recordingRoot, resultRoot } = await completedTape();
    const archiveRoot = join(resultRoot, "protected-archives");
    await createDatasetArchive(recordingRoot, archiveRoot, "experiment-tape");
    const passcode = "0123456789abcdef0123456789abcdef";
    const app = await createApp({
      replayJsonl: "",
      recordingRootDir: recordingRoot,
      recordingArchiveRootDir: archiveRoot,
      backtestResultRootDir: resultRoot,
      adminPasscode: passcode
    });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/api/admin/status" })).json()).toEqual({ required: true });
    expect((await app.inject({ method: "POST", url: "/api/admin/verify" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/verify", headers: { "x-side-admin-passcode": "wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/verify", headers: { "x-side-admin-passcode": passcode } })).json()).toEqual({ accepted: true });
    expect((await app.inject({ method: "GET", url: "/api/recording/archives/experiment-tape/download" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET",
      url: "/api/recording/archives/experiment-tape/download",
      headers: { "x-side-admin-passcode": passcode }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: "/api/backtest-experiments",
      payload: { datasetId: "experiment-tape", configs: [baseConfig] }
    })).statusCode).toBe(401);
  });
});
