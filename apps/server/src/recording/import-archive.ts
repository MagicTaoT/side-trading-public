import { resolve } from "node:path";
import { importDatasetArchive } from "@side/recorder-replay";

const archiveArgument = process.argv.slice(2).find((value) => value !== "--");
if (!archiveArgument) throw new Error("RECORDING_ARCHIVE_PATH_REQUIRED");
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
const recordingRoot = resolve(invocationDirectory, process.env.SIDE_RECORDING_DIR ?? "data/recordings");
const manifest = await importDatasetArchive(resolve(invocationDirectory, archiveArgument), recordingRoot);
process.stdout.write(`${JSON.stringify({ imported: true, datasetId: manifest.datasetId, datasetSha256: manifest.datasetSha256 }, null, 2)}\n`);
