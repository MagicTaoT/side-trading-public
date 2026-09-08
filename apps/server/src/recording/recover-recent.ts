import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, join, resolve } from "node:path";
import {
  createDatasetArchive,
  parseRecordedStrategyObservation,
  PartitionedEventRecorder,
  THREE_HOURS_MS,
  type RecordedStrategyObservation
} from "@side/recorder-replay";

interface Candidate {
  observation: RecordedStrategyObservation;
  sourceDatasetId: string;
  sourceCreatedAtMs: number;
}

interface RecoveryWindow {
  windowStartMs: number;
  windowEndMs: number;
  datasetId: string;
  observationCount: number;
  firstObservationAtMs: number;
  lastObservationAtMs: number;
  sourceDatasetIds: string[];
  archiveFileName: string;
  archiveSha256: string;
}

function stamp(atMs: number): string {
  return new Date(atMs).toISOString().replace(/[-:.]/gu, "");
}

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else result.push(target);
    }
  };
  if (existsSync(root)) await visit(root);
  return result.sort();
}

async function sourceCreatedAtMs(datasetDir: string): Promise<number> {
  try {
    const manifest = JSON.parse(await readFile(join(datasetDir, "manifest.json"), "utf8")) as { createdAtMs?: unknown };
    return Number.isSafeInteger(manifest.createdAtMs) ? manifest.createdAtMs as number : 0;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const recordingRoot = resolve(invocationDirectory, process.env.SIDE_RECORDING_DIR ?? "data/recordings");
  const archiveRoot = resolve(invocationDirectory, process.env.SIDE_RECORDING_ARCHIVE_DIR ?? "data/recording-archives");
  const hoursArgument = process.argv.slice(2).find((value) => value !== "--");
  const hours = Number.parseInt(hoursArgument ?? "12", 10);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 24 * 31) throw new Error("INVALID_RECOVERY_HOURS");
  const nowMs = Date.now();
  const currentWindowStartMs = Math.floor(nowMs / THREE_HOURS_MS) * THREE_HOURS_MS;
  const startMs = currentWindowStartMs - hours * 60 * 60 * 1_000;
  const observationsByWindow = new Map<number, Map<number, Candidate>>();
  const sourceDirectories = (await readdir(recordingRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("live-"))
    .map((entry) => join(recordingRoot, entry.name));

  for (const datasetDir of sourceDirectories) {
    const sourceDatasetId = basename(datasetDir);
    const createdAtMs = await sourceCreatedAtMs(datasetDir);
    const observationFiles = (await filesBelow(join(datasetDir, "observations")))
      .filter((path) => path.endsWith(".ndjson") || path.endsWith(".ndjson.partial"));
    for (const path of observationFiles) {
      const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      let lineNumber = 0;
      for await (const rawLine of lines) {
        lineNumber += 1;
        const line = rawLine.trim();
        if (!line) continue;
        let observation: RecordedStrategyObservation;
        try {
          observation = parseRecordedStrategyObservation(JSON.parse(line) as unknown);
        } catch (reason) {
          throw new Error(`INVALID_RECOVERY_OBSERVATION:${path}:${lineNumber}:${reason instanceof Error ? reason.message : String(reason)}`);
        }
        if (observation.atMs < startMs || observation.atMs > nowMs) continue;
        const windowStartMs = Math.floor(observation.atMs / THREE_HOURS_MS) * THREE_HOURS_MS;
        const candidates = observationsByWindow.get(windowStartMs) ?? new Map<number, Candidate>();
        const current = candidates.get(observation.atMs);
        if (!current || createdAtMs >= current.sourceCreatedAtMs) {
          candidates.set(observation.atMs, { observation, sourceDatasetId, sourceCreatedAtMs: createdAtMs });
        }
        observationsByWindow.set(windowStartMs, candidates);
      }
    }
  }

  await mkdir(archiveRoot, { recursive: true });
  const recovered: RecoveryWindow[] = [];
  for (const [windowStartMs, candidates] of [...observationsByWindow.entries()].sort(([left], [right]) => left - right)) {
    const values = [...candidates.values()].sort((left, right) => left.observation.atMs - right.observation.atMs);
    if (values.length === 0) continue;
    const windowEndMs = windowStartMs + THREE_HOURS_MS;
    const datasetId = `recovered-tape-${stamp(windowStartMs)}-${stamp(windowEndMs)}`;
    if (existsSync(join(recordingRoot, datasetId))) throw new Error(`RECOVERY_DATASET_ALREADY_EXISTS:${datasetId}`);
    let clockMs = values[0]?.observation.atMs as number;
    const recorder = new PartitionedEventRecorder({ rootDir: recordingRoot, datasetId, now: () => clockMs });
    for (let index = 0; index < values.length; index += 1) {
      recorder.recordObservation((values[index] as Candidate).observation);
      if ((index + 1) % 5_000 === 0) await recorder.flush();
    }
    clockMs = values[values.length - 1]?.observation.atMs as number;
    await recorder.close();
    const sourceDatasetIds = [...new Set(values.map(({ sourceDatasetId }) => sourceDatasetId))].sort();
    await writeFile(join(recordingRoot, datasetId, "recovery.json"), `${JSON.stringify({
      schemaVersion: 1,
      recoveryType: "OBSERVATION_TAPE_FROM_IMMUTABLE_SOURCE_FILES",
      windowStartMs,
      windowEndMs,
      recoveredAtMs: nowMs,
      sourceDatasetIds,
      rawSourceFilesRetained: true
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const archive = await createDatasetArchive(recordingRoot, archiveRoot, datasetId);
    recovered.push({
      windowStartMs,
      windowEndMs,
      datasetId,
      observationCount: values.length,
      firstObservationAtMs: values[0]?.observation.atMs as number,
      lastObservationAtMs: values[values.length - 1]?.observation.atMs as number,
      sourceDatasetIds,
      archiveFileName: archive.fileName,
      archiveSha256: archive.sha256
    });
  }

  const reportPath = join(archiveRoot, `recovery-report-${stamp(nowMs)}.json`);
  await writeFile(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    requestedHours: hours,
    alignedStartMs: startMs,
    recoveredAtMs: nowMs,
    rawSourceFilesRetained: true,
    windows: recovered
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ reportPath, windows: recovered }, null, 2)}\n`);
}

await main();
