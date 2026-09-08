import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDatasetArchive,
  datasetArchivePath,
  deleteDatasetArchive,
  importDatasetArchive,
  listDatasetArchives,
  PartitionedEventRecorder
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("recording archives", () => {
  it("archives only a complete dataset and deletes only on an explicit call", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "side-archive-recordings-"));
    const archiveDir = await mkdtemp(join(tmpdir(), "side-archives-"));
    const importDir = await mkdtemp(join(tmpdir(), "side-imported-recordings-"));
    temporaryDirectories.push(rootDir, archiveDir, importDir);
    let nowMs = 1_000;
    const recorder = new PartitionedEventRecorder({ rootDir, datasetId: "archive-test", now: () => nowMs });
    recorder.recordObservation({
      schemaVersion: 1,
      atMs: 1_000,
      direction: null,
      edgeBps: null,
      price: "100",
      referenceSource: "test",
      signalModelVersion: "s0-v1",
      asOfIngestSeq: "0",
      freshJuryCount: 4,
      coverageState: "READY"
    });
    await recorder.flush();
    await expect(createDatasetArchive(rootDir, archiveDir, "archive-test")).rejects.toThrow("ARCHIVE_REQUIRES_COMPLETE_DATASET");
    nowMs = 2_000;
    await recorder.close();

    const archive = await createDatasetArchive(rootDir, archiveDir, "archive-test");
    expect(archive).toMatchObject({ datasetId: "archive-test" });
    expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(datasetArchivePath(archiveDir, "archive-test")).toContain("archive-test.tar.gz");
    expect(await listDatasetArchives(archiveDir)).toEqual([archive]);
    const imported = await importDatasetArchive(datasetArchivePath(archiveDir, "archive-test"), importDir);
    expect(imported).toMatchObject({ datasetId: "archive-test", status: "COMPLETE" });
    expect(await deleteDatasetArchive(archiveDir, "archive-test")).toBe(true);
    expect(await listDatasetArchives(archiveDir)).toEqual([]);
  });
});
