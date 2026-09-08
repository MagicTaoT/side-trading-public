import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { loadObservationTape, type EventDatasetManifest } from "./recording.js";

const DATASET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ARCHIVE_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.tar\.gz$/u;

export interface DatasetArchive {
  schemaVersion: 1;
  datasetId: string;
  fileName: string;
  createdAtMs: number;
  bytes: number;
  sha256: string;
}

function safeDatasetId(value: string): string {
  if (!DATASET_ID.test(value)) throw new Error("INVALID_DATASET_ID");
  return value;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { error += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveRun() : reject(new Error(`ARCHIVE_COMMAND_FAILED:${code}:${error.trim()}`)));
  });
}

export async function createDatasetArchive(rootDir: string, archiveRootDir: string, rawDatasetId: string): Promise<DatasetArchive> {
  const datasetId = safeDatasetId(rawDatasetId);
  const sourceRoot = resolve(rootDir);
  const datasetDir = resolve(sourceRoot, datasetId);
  if (!datasetDir.startsWith(`${sourceRoot}${sep}`)) throw new Error("INVALID_DATASET_PATH");
  const manifest = JSON.parse(await readFile(join(datasetDir, "manifest.json"), "utf8")) as EventDatasetManifest;
  if (manifest.datasetId !== datasetId || manifest.status !== "COMPLETE" || manifest.datasetSha256 === null) {
    throw new Error("ARCHIVE_REQUIRES_COMPLETE_DATASET");
  }
  const archiveRoot = resolve(archiveRootDir);
  await mkdir(archiveRoot, { recursive: true });
  const fileName = `${datasetId}.tar.gz`;
  const target = join(archiveRoot, fileName);
  const metadataPath = `${target}.json`;
  try {
    const existing = JSON.parse(await readFile(metadataPath, "utf8")) as DatasetArchive;
    const existingStat = await stat(target);
    if (existing.datasetId === datasetId && existing.bytes === existingStat.size && existing.sha256 === await sha256(target)) return existing;
  } catch {
    // Missing or invalid cached archive is rebuilt atomically.
  }
  const temporary = `${target}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  await run("tar", ["-czf", temporary, "-C", sourceRoot, datasetId]);
  const archiveStat = await stat(temporary);
  const archive: DatasetArchive = {
    schemaVersion: 1,
    datasetId,
    fileName,
    createdAtMs: Date.now(),
    bytes: archiveStat.size,
    sha256: await sha256(temporary)
  };
  await rename(temporary, target);
  const metadataTemporary = `${metadataPath}.${process.pid}.tmp`;
  await writeFile(metadataTemporary, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(metadataTemporary, metadataPath);
  return archive;
}

export async function listDatasetArchives(archiveRootDir: string): Promise<DatasetArchive[]> {
  const root = resolve(archiveRootDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw reason;
  }
  const archives: DatasetArchive[] = [];
  for (const entry of entries) {
    const match = ARCHIVE_FILE.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    try {
      const metadata = JSON.parse(await readFile(join(root, `${entry.name}.json`), "utf8")) as DatasetArchive;
      const archiveStat = await stat(join(root, entry.name));
      if (metadata.schemaVersion === 1 && metadata.datasetId === match[1] && metadata.fileName === entry.name && metadata.bytes === archiveStat.size) {
        archives.push(metadata);
      }
    } catch {
      // Do not advertise partial or unauditable archives.
    }
  }
  return archives.sort((left, right) => right.createdAtMs - left.createdAtMs);
}

export function datasetArchivePath(archiveRootDir: string, rawDatasetId: string): string {
  const datasetId = safeDatasetId(rawDatasetId);
  const root = resolve(archiveRootDir);
  const target = resolve(root, `${datasetId}.tar.gz`);
  if (!target.startsWith(`${root}${sep}`)) throw new Error("INVALID_ARCHIVE_PATH");
  return target;
}

/** Explicit operator action only. Never called by rotation or retention timers. */
export async function deleteDatasetArchive(archiveRootDir: string, rawDatasetId: string): Promise<boolean> {
  const target = datasetArchivePath(archiveRootDir, rawDatasetId);
  let existed = true;
  try { await stat(target); } catch { existed = false; }
  await rm(target, { force: true });
  await rm(`${target}.json`, { force: true });
  return existed;
}

/** Imports one SIDE-created archive into a local recording catalog. */
export async function importDatasetArchive(archivePath: string, recordingRootDir: string): Promise<EventDatasetManifest> {
  const source = resolve(archivePath);
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) throw new Error("INVALID_RECORDING_ARCHIVE");
  const root = resolve(recordingRootDir);
  await mkdir(root, { recursive: true });
  const temporaryRoot = await mkdtemp(join(root, ".import-"));
  try {
    await run("tar", ["-xzf", source, "-C", temporaryRoot]);
    const entries = (await readdir(temporaryRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (entries.length !== 1) throw new Error("INVALID_RECORDING_ARCHIVE_LAYOUT");
    const datasetId = safeDatasetId((entries[0] as (typeof entries)[number]).name);
    const importedRoot = join(temporaryRoot, datasetId);
    const manifest = JSON.parse(await readFile(join(importedRoot, "manifest.json"), "utf8")) as EventDatasetManifest;
    if (manifest.datasetId !== datasetId || manifest.status !== "COMPLETE" || manifest.datasetSha256 === null) {
      throw new Error("INVALID_RECORDING_ARCHIVE_MANIFEST");
    }
    const target = join(root, datasetId);
    try {
      await stat(target);
      throw new Error("RECORDING_DATASET_ALREADY_EXISTS");
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== "ENOENT") throw reason;
    }
    await rename(importedRoot, target);
    try {
      await loadObservationTape(root, datasetId);
    } catch (reason) {
      await rename(target, importedRoot);
      throw reason;
    }
    return manifest;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
