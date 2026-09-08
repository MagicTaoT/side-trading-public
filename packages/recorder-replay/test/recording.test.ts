import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeEventLog,
  listEventDatasets,
  loadEventDataset,
  loadObservationTape,
  PartitionedEventRecorder
} from "../src/index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/golden/spot-led.jsonl", import.meta.url));
const events = decodeEventLog(readFileSync(fixturePath, "utf8"));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("partitioned event recorder", () => {
  it("records canonical events and one-second observations into a verified complete dataset", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "side-recording-"));
    temporaryDirectories.push(rootDir);
    let nowMs = 1_750_000_000_000;
    const recorder = new PartitionedEventRecorder({ rootDir, datasetId: "dataset-test-001", now: () => nowMs });

    for (const event of events) recorder.record(event);
    recorder.recordObservation({
      schemaVersion: 1,
      atMs: 1_750_000_001_000,
      direction: null,
      edgeBps: null,
      price: "176.33574325",
      referenceSource: "bitquery-wsol-usdc",
      signalModelVersion: "s0-v1",
      asOfIngestSeq: "102",
      freshJuryCount: 2,
      coverageState: "INSUFFICIENT_DATA"
    });
    nowMs = 1_750_000_002_000;
    await recorder.close();

    expect(recorder.status()).toMatchObject({
      state: "COMPLETE",
      eventCount: 3,
      observationCount: 1,
      failure: null
    });
    const [manifest] = await listEventDatasets(rootDir);
    expect(manifest).toMatchObject({
      datasetId: "dataset-test-001",
      status: "COMPLETE",
      eventCount: 3,
      observationCount: 1,
      providers: ["bitquery", "coinbase"],
      signalModelVersions: ["s0-v1"]
    });
    expect(manifest?.datasetSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest?.eventPartitions).toHaveLength(2);
    expect(manifest?.eventPartitions.every(({ path, sha256 }) => path.endsWith(".ndjson") && sha256 !== null)).toBe(true);

    const loadedEvents = await loadEventDataset(rootDir, "dataset-test-001");
    expect(loadedEvents.events.map(({ ingestSeq }) => ingestSeq)).toEqual(["100", "101", "102"]);
    const tape = await loadObservationTape(rootDir, "dataset-test-001");
    expect(tape.observations).toEqual([
      expect.objectContaining({ atMs: 1_750_000_001_000, signalModelVersion: "s0-v1", asOfIngestSeq: "102" })
    ]);
  });

  it("fails closed when a completed partition no longer matches its checksum", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "side-recording-corrupt-"));
    temporaryDirectories.push(rootDir);
    let nowMs = 1_750_000_000_000;
    const recorder = new PartitionedEventRecorder({ rootDir, datasetId: "dataset-corrupt", now: () => nowMs });
    recorder.record(events[0] as (typeof events)[number]);
    nowMs += 1_000;
    await recorder.close();
    const [manifest] = await listEventDatasets(rootDir);
    const partition = manifest?.eventPartitions[0];
    expect(partition).toBeDefined();
    await appendFile(join(rootDir, "dataset-corrupt", partition?.path as string), " ");

    await expect(loadEventDataset(rootDir, "dataset-corrupt")).rejects.toThrow("CHECKSUM_MISMATCH");
  });
});
