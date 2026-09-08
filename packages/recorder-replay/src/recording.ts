import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parseMarketEvent, type MarketEvent } from "@side/market-core";
import { decodeEventLog } from "./event-log.js";
import { orderForReplay } from "./replay.js";

const DATASET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MANIFEST_FILE = "manifest.json";

export interface RecordedStrategyObservation {
  schemaVersion: 1;
  atMs: number;
  direction: "BUY" | "SELL" | null;
  edgeBps: string | null;
  price: string | null;
  referenceSource: string | null;
  signalModelVersion: string;
  asOfIngestSeq: string;
  freshJuryCount: number;
  coverageState: "READY" | "INSUFFICIENT_DATA";
}

export interface RecordedPartition {
  path: string;
  hourStartMs: number;
  recordCount: number;
  firstAtMs: number;
  lastAtMs: number;
  sha256: string | null;
}

export interface RecordedEventPartition extends RecordedPartition {
  provider: string;
  firstIngestSeq: string;
  lastIngestSeq: string;
}

export interface RecordedObservationPartition extends RecordedPartition {
  signalModelVersion: string;
}

export interface EventDatasetManifest {
  schemaVersion: 1;
  datasetId: string;
  format: "side-canonical-dataset-v1";
  status: "OPEN" | "COMPLETE" | "FAILED";
  createdAtMs: number;
  closedAtMs: number | null;
  marketEventSchemaVersion: 1;
  observationCadenceMs: 1_000;
  eventCount: number;
  observationCount: number;
  firstReceivedAtMs: number | null;
  lastReceivedAtMs: number | null;
  firstObservationAtMs: number | null;
  lastObservationAtMs: number | null;
  firstIngestSeq: string | null;
  lastIngestSeq: string | null;
  providers: string[];
  signalModelVersions: string[];
  eventPartitions: RecordedEventPartition[];
  observationPartitions: RecordedObservationPartition[];
  datasetSha256: string | null;
  failure: string | null;
}

export interface EventRecorderStatus {
  enabled: true;
  datasetId: string;
  state: "OPEN" | "COMPLETE" | "FAILED";
  rootDir: string;
  eventCount: number;
  observationCount: number;
  failure: string | null;
}

export interface EventRecorder {
  record(event: MarketEvent): void;
  recordObservation(observation: RecordedStrategyObservation): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  status(): EventRecorderStatus;
}

interface WriterState {
  partialPath: string;
  finalPath: string;
  relativePartialPath: string;
  relativeFinalPath: string;
  hourStartMs: number;
  recordCount: number;
  firstAtMs: number;
  lastAtMs: number;
  hash: ReturnType<typeof createHash>;
  sha256: string | null;
  provider?: string;
  firstIngestSeq?: string;
  lastIngestSeq?: string;
  signalModelVersion?: string;
  finalized: boolean;
}

export interface PartitionedEventRecorderOptions {
  rootDir: string;
  datasetId?: string;
  now?: () => number;
}

function safeDatasetId(value: string): string {
  if (!DATASET_ID.test(value)) throw new Error("INVALID_DATASET_ID");
  return value;
}

function generatedDatasetId(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:.]/gu, "").replace("Z", "Z-");
  return `live-${stamp}${randomUUID().slice(0, 8)}`;
}

function hourParts(atMs: number): { day: string; hour: string; hourStartMs: number } {
  const date = new Date(atMs);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_PARTITION_TIME");
  const iso = date.toISOString();
  return {
    day: iso.slice(0, 10),
    hour: iso.slice(11, 13),
    hourStartMs: Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours()
    )
  };
}

function assertSafeTimestamp(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
  return value as number;
}

function nullableString(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

export function parseRecordedStrategyObservation(value: unknown): RecordedStrategyObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_RECORDED_OBSERVATION");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new Error("INVALID_RECORDED_OBSERVATION_SCHEMA");
  if (!(input.direction === null || input.direction === "BUY" || input.direction === "SELL")) {
    throw new Error("INVALID_RECORDED_OBSERVATION_DIRECTION");
  }
  const edgeBps = nullableString(input.edgeBps, "INVALID_RECORDED_OBSERVATION_EDGE");
  const price = nullableString(input.price, "INVALID_RECORDED_OBSERVATION_PRICE");
  const referenceSource = nullableString(input.referenceSource, "INVALID_RECORDED_OBSERVATION_REFERENCE");
  if ((price === null) !== (referenceSource === null)) throw new Error("RECORDED_OBSERVATION_REFERENCE_MISMATCH");
  if (typeof input.signalModelVersion !== "string" || input.signalModelVersion.length === 0) {
    throw new Error("INVALID_RECORDED_OBSERVATION_MODEL");
  }
  if (typeof input.asOfIngestSeq !== "string" || !/^(0|[1-9]\d*)$/u.test(input.asOfIngestSeq)) {
    throw new Error("INVALID_RECORDED_OBSERVATION_SEQUENCE");
  }
  if (!Number.isSafeInteger(input.freshJuryCount) || (input.freshJuryCount as number) < 0) {
    throw new Error("INVALID_RECORDED_OBSERVATION_COVERAGE");
  }
  if (!(input.coverageState === "READY" || input.coverageState === "INSUFFICIENT_DATA")) {
    throw new Error("INVALID_RECORDED_OBSERVATION_COVERAGE_STATE");
  }
  return {
    schemaVersion: 1,
    atMs: assertSafeTimestamp(input.atMs, "INVALID_RECORDED_OBSERVATION_TIME"),
    direction: input.direction,
    edgeBps,
    price,
    referenceSource,
    signalModelVersion: input.signalModelVersion,
    asOfIngestSeq: input.asOfIngestSeq,
    freshJuryCount: input.freshJuryCount as number,
    coverageState: input.coverageState
  };
}

function manifestFingerprint(manifest: EventDatasetManifest): string {
  const payload = {
    format: manifest.format,
    datasetId: manifest.datasetId,
    eventCount: manifest.eventCount,
    observationCount: manifest.observationCount,
    firstIngestSeq: manifest.firstIngestSeq,
    lastIngestSeq: manifest.lastIngestSeq,
    eventPartitions: manifest.eventPartitions.map(({ path, recordCount, sha256 }) => ({ path, recordCount, sha256 })),
    observationPartitions: manifest.observationPartitions.map(({ path, recordCount, sha256 }) => ({ path, recordCount, sha256 }))
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export class PartitionedEventRecorder implements EventRecorder {
  readonly rootDir: string;
  readonly datasetId: string;
  readonly datasetDir: string;
  readonly #createdAtMs: number;
  readonly #now: () => number;
  readonly #eventWriters = new Map<string, WriterState>();
  readonly #observationWriters = new Map<string, WriterState>();
  #tail: Promise<void> = Promise.resolve();
  #initialized = false;
  #accepting = true;
  #completed = false;
  #closePromise: Promise<void> | null = null;
  #closedAtMs: number | null = null;
  #failure: Error | null = null;
  #eventCount = 0;
  #observationCount = 0;
  #firstReceivedAtMs: number | null = null;
  #lastReceivedAtMs: number | null = null;
  #firstObservationAtMs: number | null = null;
  #lastObservationAtMs: number | null = null;
  #firstIngestSeq: string | null = null;
  #lastIngestSeq: string | null = null;
  readonly #providers = new Set<string>();
  readonly #signalModelVersions = new Set<string>();

  constructor(options: PartitionedEventRecorderOptions) {
    this.rootDir = resolve(options.rootDir);
    this.#now = options.now ?? Date.now;
    this.#createdAtMs = assertSafeTimestamp(this.#now(), "INVALID_RECORDER_START_TIME");
    this.datasetId = safeDatasetId(options.datasetId ?? generatedDatasetId(this.#createdAtMs));
    this.datasetDir = join(this.rootDir, this.datasetId);
  }

  record(input: MarketEvent): void {
    const event = parseMarketEvent(input);
    this.#enqueue(() => this.#appendEvent(event));
  }

  recordObservation(input: RecordedStrategyObservation): void {
    const observation = parseRecordedStrategyObservation(input);
    this.#enqueue(() => this.#appendObservation(observation));
  }

  status(): EventRecorderStatus {
    return {
      enabled: true,
      datasetId: this.datasetId,
      state: this.#failure ? "FAILED" : this.#completed ? "COMPLETE" : "OPEN",
      rootDir: this.rootDir,
      eventCount: this.#eventCount,
      observationCount: this.#observationCount,
      failure: this.#failure?.message ?? null
    };
  }

  async flush(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    await this.#tail;
    await this.#ensureInitialized();
    await this.#writeManifest(this.#failure ? "FAILED" : "OPEN");
    if (this.#failure) throw this.#failure;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#accepting = false;
    this.#closePromise = this.#finishClose();
    return this.#closePromise;
  }

  async #finishClose(): Promise<void> {
    await this.#tail;
    await this.#ensureInitialized();
    this.#closedAtMs = assertSafeTimestamp(this.#now(), "INVALID_RECORDER_CLOSE_TIME");
    if (this.#failure) {
      await this.#writeManifest("FAILED");
      throw this.#failure;
    }
    try {
      for (const writer of [...this.#eventWriters.values(), ...this.#observationWriters.values()]) {
        writer.sha256 = writer.hash.digest("hex");
        await rename(writer.partialPath, writer.finalPath);
        writer.finalized = true;
      }
      await this.#writeManifest("COMPLETE");
      this.#completed = true;
    } catch (reason) {
      this.#failure = reason instanceof Error ? reason : new Error(String(reason));
      await this.#writeManifest("FAILED");
      throw this.#failure;
    }
  }

  #enqueue(operation: () => Promise<void>): void {
    if (!this.#accepting) throw new Error("EVENT_RECORDER_CLOSED");
    if (this.#failure) throw this.#failure;
    this.#tail = this.#tail.then(async () => {
      if (this.#failure) return;
      try {
        await this.#ensureInitialized();
        await operation();
      } catch (reason) {
        this.#failure = reason instanceof Error ? reason : new Error(String(reason));
      }
    });
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.datasetDir, { recursive: true });
    this.#initialized = true;
    await this.#writeManifest("OPEN");
  }

  async #writer(
    collection: Map<string, WriterState>,
    key: string,
    relativeFinalPath: string,
    atMs: number,
    metadata: Pick<WriterState, "provider" | "signalModelVersion">
  ): Promise<WriterState> {
    const existing = collection.get(key);
    if (existing) return existing;
    const finalPath = join(this.datasetDir, relativeFinalPath);
    const writer: WriterState = {
      partialPath: `${finalPath}.partial`,
      finalPath,
      relativePartialPath: `${relativeFinalPath}.partial`,
      relativeFinalPath,
      hourStartMs: hourParts(atMs).hourStartMs,
      recordCount: 0,
      firstAtMs: atMs,
      lastAtMs: atMs,
      hash: createHash("sha256"),
      sha256: null,
      finalized: false,
      ...metadata
    };
    await mkdir(dirname(finalPath), { recursive: true });
    collection.set(key, writer);
    return writer;
  }

  async #appendEvent(event: MarketEvent): Promise<void> {
    const { day, hour } = hourParts(event.receivedAtUnixMs);
    const relativePath = join("events", day, hour, `${event.source.provider}.ndjson`);
    const key = `${day}/${hour}/${event.source.provider}`;
    const writer = await this.#writer(this.#eventWriters, key, relativePath, event.receivedAtUnixMs, {
      provider: event.source.provider
    });
    const line = `${JSON.stringify(event)}\n`;
    await appendFile(writer.partialPath, line, { encoding: "utf8", mode: 0o600 });
    writer.hash.update(line);
    writer.recordCount += 1;
    writer.lastAtMs = event.receivedAtUnixMs;
    writer.firstIngestSeq ??= event.ingestSeq;
    writer.lastIngestSeq = event.ingestSeq;
    this.#eventCount += 1;
    this.#firstReceivedAtMs ??= event.receivedAtUnixMs;
    this.#lastReceivedAtMs = Math.max(this.#lastReceivedAtMs ?? event.receivedAtUnixMs, event.receivedAtUnixMs);
    this.#firstIngestSeq ??= event.ingestSeq;
    this.#lastIngestSeq = event.ingestSeq;
    this.#providers.add(event.source.provider);
  }

  async #appendObservation(observation: RecordedStrategyObservation): Promise<void> {
    const { day, hour } = hourParts(observation.atMs);
    const safeModel = observation.signalModelVersion.replace(/[^A-Za-z0-9._-]/gu, "_");
    const relativePath = join("observations", day, hour, `${safeModel}.ndjson`);
    const key = `${day}/${hour}/${safeModel}`;
    const writer = await this.#writer(this.#observationWriters, key, relativePath, observation.atMs, {
      signalModelVersion: observation.signalModelVersion
    });
    const line = `${JSON.stringify(observation)}\n`;
    await appendFile(writer.partialPath, line, { encoding: "utf8", mode: 0o600 });
    writer.hash.update(line);
    writer.recordCount += 1;
    writer.lastAtMs = observation.atMs;
    this.#observationCount += 1;
    this.#firstObservationAtMs ??= observation.atMs;
    this.#lastObservationAtMs = observation.atMs;
    this.#signalModelVersions.add(observation.signalModelVersion);
  }

  #manifest(status: EventDatasetManifest["status"]): EventDatasetManifest {
    const complete = status === "COMPLETE";
    const eventPartitions = [...this.#eventWriters.values()]
      .map((writer): RecordedEventPartition => ({
        path: complete || writer.finalized ? writer.relativeFinalPath : writer.relativePartialPath,
        provider: writer.provider as string,
        hourStartMs: writer.hourStartMs,
        recordCount: writer.recordCount,
        firstAtMs: writer.firstAtMs,
        lastAtMs: writer.lastAtMs,
        firstIngestSeq: writer.firstIngestSeq as string,
        lastIngestSeq: writer.lastIngestSeq as string,
        sha256: writer.sha256
      }))
      .sort((left, right) => left.hourStartMs - right.hourStartMs || left.provider.localeCompare(right.provider));
    const observationPartitions = [...this.#observationWriters.values()]
      .map((writer): RecordedObservationPartition => ({
        path: complete || writer.finalized ? writer.relativeFinalPath : writer.relativePartialPath,
        signalModelVersion: writer.signalModelVersion as string,
        hourStartMs: writer.hourStartMs,
        recordCount: writer.recordCount,
        firstAtMs: writer.firstAtMs,
        lastAtMs: writer.lastAtMs,
        sha256: writer.sha256
      }))
      .sort((left, right) => left.hourStartMs - right.hourStartMs || left.signalModelVersion.localeCompare(right.signalModelVersion));
    const manifest: EventDatasetManifest = {
      schemaVersion: 1,
      datasetId: this.datasetId,
      format: "side-canonical-dataset-v1",
      status,
      createdAtMs: this.#createdAtMs,
      closedAtMs: this.#closedAtMs,
      marketEventSchemaVersion: 1,
      observationCadenceMs: 1_000,
      eventCount: this.#eventCount,
      observationCount: this.#observationCount,
      firstReceivedAtMs: this.#firstReceivedAtMs,
      lastReceivedAtMs: this.#lastReceivedAtMs,
      firstObservationAtMs: this.#firstObservationAtMs,
      lastObservationAtMs: this.#lastObservationAtMs,
      firstIngestSeq: this.#firstIngestSeq,
      lastIngestSeq: this.#lastIngestSeq,
      providers: [...this.#providers].sort(),
      signalModelVersions: [...this.#signalModelVersions].sort(),
      eventPartitions,
      observationPartitions,
      datasetSha256: null,
      failure: this.#failure?.message ?? null
    };
    if (complete) manifest.datasetSha256 = manifestFingerprint(manifest);
    return manifest;
  }

  async #writeManifest(status: EventDatasetManifest["status"]): Promise<void> {
    const manifest = this.#manifest(status);
    const target = join(this.datasetDir, MANIFEST_FILE);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }
}

function parseManifest(value: unknown): EventDatasetManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_DATASET_MANIFEST");
  const manifest = value as EventDatasetManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.format !== "side-canonical-dataset-v1" ||
    !DATASET_ID.test(manifest.datasetId) ||
    !(manifest.status === "OPEN" || manifest.status === "COMPLETE" || manifest.status === "FAILED") ||
    !Array.isArray(manifest.eventPartitions) ||
    !Array.isArray(manifest.observationPartitions)
  ) {
    throw new Error("INVALID_DATASET_MANIFEST");
  }
  return manifest;
}

async function readManifest(rootDir: string, datasetId: string): Promise<EventDatasetManifest> {
  const safeId = safeDatasetId(datasetId);
  const serialized = await readFile(join(resolve(rootDir), safeId, MANIFEST_FILE), "utf8");
  const manifest = parseManifest(JSON.parse(serialized) as unknown);
  if (manifest.datasetId !== safeId) throw new Error("DATASET_MANIFEST_ID_MISMATCH");
  return manifest;
}

export async function listEventDatasets(rootDir: string): Promise<EventDatasetManifest[]> {
  let entries;
  try {
    entries = await readdir(resolve(rootDir), { withFileTypes: true });
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw reason;
  }
  const manifests = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && DATASET_ID.test(entry.name))
    .map(async (entry) => {
      try {
        return await readManifest(rootDir, entry.name);
      } catch {
        return null;
      }
    }));
  return manifests
    .filter((manifest): manifest is EventDatasetManifest => manifest !== null)
    .sort((left, right) => right.createdAtMs - left.createdAtMs);
}

async function verifiedPartition(rootDir: string, datasetId: string, partition: RecordedPartition): Promise<string> {
  const datasetDir = join(resolve(rootDir), safeDatasetId(datasetId));
  const target = resolve(datasetDir, partition.path);
  if (!target.startsWith(`${datasetDir}${sep}`)) throw new Error("INVALID_DATASET_PARTITION_PATH");
  const content = await readFile(target, "utf8");
  if (partition.sha256 !== null) {
    const checksum = createHash("sha256").update(content).digest("hex");
    if (checksum !== partition.sha256) throw new Error(`DATASET_PARTITION_CHECKSUM_MISMATCH:${partition.path}`);
  }
  return content;
}

export async function loadEventDataset(
  rootDir: string,
  datasetId: string,
  options: { allowOpen?: boolean } = {}
): Promise<{ manifest: EventDatasetManifest; events: MarketEvent[] }> {
  const manifest = await readManifest(rootDir, datasetId);
  if (manifest.status !== "COMPLETE" && !options.allowOpen) throw new Error("DATASET_NOT_COMPLETE");
  const contents = await Promise.all(manifest.eventPartitions.map((partition) => verifiedPartition(rootDir, datasetId, partition)));
  const events = orderForReplay(contents.flatMap((content) => decodeEventLog(content)));
  if (events.length !== manifest.eventCount) throw new Error("DATASET_EVENT_COUNT_MISMATCH");
  return { manifest, events };
}

export async function loadObservationTape(
  rootDir: string,
  datasetId: string,
  options: { allowOpen?: boolean } = {}
): Promise<{ manifest: EventDatasetManifest; observations: RecordedStrategyObservation[] }> {
  const manifest = await readManifest(rootDir, datasetId);
  if (manifest.status !== "COMPLETE" && !options.allowOpen) throw new Error("DATASET_NOT_COMPLETE");
  const contents = await Promise.all(
    manifest.observationPartitions.map((partition) => verifiedPartition(rootDir, datasetId, partition))
  );
  const observations = contents
    .flatMap((content) => content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))
    .map((line) => parseRecordedStrategyObservation(JSON.parse(line) as unknown))
    .sort((left, right) => left.atMs - right.atMs);
  if (observations.length !== manifest.observationCount) throw new Error("DATASET_OBSERVATION_COUNT_MISMATCH");
  for (let index = 1; index < observations.length; index += 1) {
    if ((observations[index - 1] as RecordedStrategyObservation).atMs >= (observations[index] as RecordedStrategyObservation).atMs) {
      throw new Error("DATASET_OBSERVATION_TIME_NOT_STRICTLY_INCREASING");
    }
  }
  return { manifest, observations };
}
