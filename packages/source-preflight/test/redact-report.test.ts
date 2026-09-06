import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PreflightReport, ProbeResult } from "../src/contracts.js";
import { redactText, redactUrl, safeError } from "../src/redact.js";
import { renderMarkdown, writeReportFiles } from "../src/report.js";
import { selectCexProfile } from "../src/select.js";

const secret = "secret-value-1234";

function sampleProbe(): ProbeResult {
  return {
    id: "sample.http",
    source: "sample",
    label: "sample",
    transport: "http",
    endpoint: `https://example.test/data?token=${secret}`,
    status: "fail",
    attempts: 1,
    httpStatusCounts: { "429": 1 },
    rateLimited: true,
    latencyMs: { samples: [12.3], p50: 12.3, p95: 12.3 },
    entitlement: "credential-present",
    metadata: { productId: "SOL-USD" },
    reasons: [`transport_error:Bearer ${secret}`]
  };
}

function sampleReport(): PreflightReport {
  const probes = [sampleProbe()];
  return {
    schemaVersion: 1,
    manifestVersion: "s0-preflight-v1",
    target: {
      requestedRegion: "test",
      hostname: "test-host",
      platform: "test-platform",
      nodeVersion: "v24",
      executedAt: "2026-09-04T00:00:00.000Z"
    },
    profile: selectCexProfile(probes),
    probes,
    secretPolicy: { valuesPersisted: false, environmentVariablesChecked: ["BITQUERY_TOKEN"] }
  };
}

describe("secret-safe report output", () => {
  it("redacts sensitive URL values, bearer tokens and thrown errors", () => {
    expect(redactUrl(`https://example.test/data?token=${secret}`)).not.toContain(secret);
    expect(redactText(`Authorization: Bearer ${secret}`, [secret])).toBe("Authorization: Bearer [REDACTED]");
    expect(safeError(new Error(`request rejected for ${secret}`), [secret])).not.toContain(secret);
  });

  it("renders the atomic profile and latency evidence", () => {
    const markdown = renderMarkdown(sampleReport());
    expect(markdown).toContain("S0_CEX_PROFILE=unavailable");
    expect(markdown).toContain("12.30");
    expect(markdown).toContain("Coinbase and Binance are evaluated as whole spot+perp profiles");
  });

  it("persists JSON, Markdown and the single profile assignment without secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "side-preflight-"));
    const paths = await writeReportFiles(sampleReport(), directory, [secret]);
    await Promise.all(paths.map((path) => chmod(path, 0o644)));
    await writeReportFiles(sampleReport(), directory, [secret]);
    const contents = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    expect(contents.join("\n")).not.toContain(secret);
    expect(contents[2]).toBe("S0_CEX_PROFILE=unavailable\n");
    expect(JSON.parse(contents[0] ?? "{}")).toMatchObject({ schemaVersion: 1 });
    for (const path of paths) expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
