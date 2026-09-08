import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { decodeEventLog, listEventDatasets, RotatingEventRecorder } from "../src/index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/golden/spot-led.jsonl", import.meta.url));
const event = decodeEventLog(readFileSync(fixturePath, "utf8"))[0];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("rotating event recorder", () => {
  it("finalizes a segment without stopping accepted writes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "side-rotation-"));
    temporaryDirectories.push(rootDir);
    let nowMs = 0;
    let id = 0;
    const completed: string[] = [];
    const recorder = new RotatingEventRecorder({
      rootDir,
      segmentMs: 60_000,
      now: () => nowMs,
      id: () => `id${++id}`,
      onSegmentComplete: async ({ datasetId }) => { completed.push(datasetId); }
    });

    recorder.record(event as NonNullable<typeof event>);
    nowMs = 60_001;
    recorder.record({ ...event as NonNullable<typeof event>, eventId: "rotation-second", ingestSeq: "101" });
    await recorder.close();

    const datasets = await listEventDatasets(rootDir);
    expect(datasets).toHaveLength(2);
    expect(datasets.every(({ status, eventCount }) => status === "COMPLETE" && eventCount === 1)).toBe(true);
    expect(completed).toHaveLength(2);
    expect(await readdir(rootDir)).toEqual(expect.arrayContaining(completed));
    expect(await readFile(join(rootDir, completed[0] as string, "manifest.json"), "utf8")).toContain('"status": "COMPLETE"');
  });
});
