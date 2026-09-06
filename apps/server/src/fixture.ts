import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const FIXTURE_RELATIVE_PATH = "packages/recorder-replay/test/fixtures/golden/spot-led.jsonl";

export async function loadDefaultReplayFixture(explicitPath = process.env.S0_REPLAY_FIXTURE): Promise<string> {
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : [resolve(process.cwd(), FIXTURE_RELATIVE_PATH), resolve(process.cwd(), "../..", FIXTURE_RELATIVE_PATH)];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return readFile(candidate, "utf8");
    } catch {
      // Try the next deterministic workspace location.
    }
  }

  throw new Error(`S0 replay fixture not found. Checked: ${candidates.join(", ")}`);
}
