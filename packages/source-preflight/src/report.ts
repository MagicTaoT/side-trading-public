import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreflightReport, ProbeResult } from "./contracts.js";
import { redactText } from "./redact.js";

function display(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

function metadataSummary(probe: ProbeResult): string {
  const target = probe.metadata.targetProductId;
  const product = probe.metadata.productId;
  const instrument = probe.metadata.instrument;
  return String(target ?? product ?? instrument ?? "—");
}

export function renderMarkdown(report: PreflightReport): string {
  const lines = [
    "# SIDE S0 Source Preflight",
    "",
    `- Manifest: \`${report.manifestVersion}\``,
    `- Executed: \`${report.target.executedAt}\``,
    `- Host: \`${report.target.hostname}\``,
    `- Requested region: \`${report.target.requestedRegion}\``,
    `- Runtime: \`${report.target.platform} · ${report.target.nodeVersion}\``,
    `- Selected profile: \`${report.profile.env}\``,
    "- Secrets persisted: `false`",
    "",
    "## Atomic CEX decision",
    "",
    "| Candidate | Complete | Failed required probes |",
    "|---|---:|---|",
    ...report.profile.candidates.map(
      (candidate) =>
        `| ${candidate.profile} | ${candidate.complete ? "yes" : "no"} | ${candidate.failedProbeIds.join(", ") || "—"} |`
    ),
    "",
    "Coinbase and Binance are evaluated as whole spot+perp profiles. A half-profile is never emitted.",
    "",
    "## Probe results",
    "",
    "| Probe | Transport | Status | HTTP | 429 | p50 ms | p95 ms | Product / instrument | Entitlement | Reason |",
    "|---|---|---|---|---:|---:|---:|---|---|---|",
    ...report.probes.map((probe) => {
      const statuses = Object.entries(probe.httpStatusCounts)
        .map(([status, count]) => `${status}×${count}`)
        .join(", ");
      return `| ${probe.id} | ${probe.transport} | ${probe.status} | ${statuses || "—"} | ${probe.rateLimited ? "yes" : "no"} | ${display(probe.latencyMs.p50)} | ${display(probe.latencyMs.p95)} | ${metadataSummary(probe)} | ${probe.entitlement} | ${probe.reasons.join("; ") || "—"} |`;
    }),
    "",
    "## Endpoints",
    "",
    ...report.probes.map((probe) => `- \`${probe.id}\`: ${probe.endpoint}`),
    "",
    "## Credential gates",
    "",
    ...report.secretPolicy.environmentVariablesChecked.map((name) => `- \`${name}\`: checked by name only; value never persisted`),
    ""
  ];
  return lines.join("\n");
}

export async function writeReportFiles(report: PreflightReport, outDir: string, secrets: string[]): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "source-preflight.json");
  const markdownPath = join(outDir, "source-preflight.md");
  const envPath = join(outDir, "profile.env");
  const json = redactText(`${JSON.stringify(report, null, 2)}\n`, secrets);
  const markdown = redactText(renderMarkdown(report), secrets);
  await Promise.all([
    writeFile(jsonPath, json, { mode: 0o600 }),
    writeFile(markdownPath, markdown, { mode: 0o600 }),
    writeFile(envPath, `${report.profile.env}\n`, { mode: 0o600 })
  ]);
  await Promise.all([jsonPath, markdownPath, envPath].map((path) => chmod(path, 0o600)));
  return [jsonPath, markdownPath, envPath];
}
