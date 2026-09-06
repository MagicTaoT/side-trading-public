#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight } from "./runner.js";
import { writeReportFiles } from "./report.js";
import { SECRET_ENV_NAMES } from "./manifest.js";
import type { PreflightReport } from "./contracts.js";

interface CliOptions {
  envFile: string;
  outDir: string;
  region: string;
  samples: number;
  timeoutMs: number;
  includeJupiter: boolean;
  strict: boolean;
}

export const DEFAULT_ENV_FILE = ".env.preflight.local";

function usage(): string {
  return `SIDE S0 source preflight

Usage: pnpm preflight:s0 -- [options]

  --out-dir <path>       Report directory (default reports/preflight/latest)
  --env-file <path>      Credential file (default .env.preflight.local)
  --region <name>        Requested deployment region label
  --samples <1-20>       HTTP/WS samples per probe (default 3)
  --timeout-ms <ms>      Per-attempt timeout, 250-30000 (default 6000)
  --include-jupiter      Explicitly test Jupiter fallback
  --strict               Exit non-zero unless CEX profile and independent sources pass
  --help                 Show this help

Credentials are read only from BITQUERY_TOKEN, ZEROEX_API_KEY and JUPITER_API_KEY.`;
}

function integer(value: string | undefined, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

export function parseArgs(args: string[], environment: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    envFile: DEFAULT_ENV_FILE,
    outDir: "reports/preflight/latest",
    region: environment.AWS_REGION ?? "unknown-local",
    samples: 3,
    timeoutMs: 6_000,
    includeJupiter: false,
    strict: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else if (argument === "--env-file") options.envFile = args[++index] ?? "";
    else if (argument === "--out-dir") options.outDir = args[++index] ?? "";
    else if (argument === "--region") options.region = args[++index] ?? "";
    else if (argument === "--samples") options.samples = integer(args[++index], "--samples", 1, 20);
    else if (argument === "--timeout-ms") options.timeoutMs = integer(args[++index], "--timeout-ms", 250, 30_000);
    else if (argument === "--include-jupiter") options.includeJupiter = true;
    else if (argument === "--strict") options.strict = true;
    else throw new Error(`Unknown argument: ${argument ?? ""}`);
  }
  if (!options.envFile || !options.outDir || !options.region) throw new Error("--env-file, --out-dir and --region must not be empty");
  return options;
}

function requestedEnvFile(args: string[]): string | undefined {
  const index = args.indexOf("--env-file");
  return index >= 0 ? args[index + 1] ?? "" : undefined;
}

export function loadPreflightEnvironment(args: string[], invocationDirectory: string): string | null {
  const explicitlyRequested = requestedEnvFile(args);
  const envFile = explicitlyRequested ?? DEFAULT_ENV_FILE;
  if (!envFile) throw new Error("--env-file must not be empty");
  const path = resolve(invocationDirectory, envFile);
  if (!existsSync(path)) {
    if (explicitlyRequested !== undefined) throw new Error(`Credential file not found: ${path}`);
    return null;
  }
  process.loadEnvFile(path);
  return path;
}

export function strictReady(report: Pick<PreflightReport, "profile" | "probes">, includeJupiter: boolean): boolean {
  const required = ["hyperliquid.metadata", "hyperliquid.ws", "bitquery.wsol-usdc.ws", "zeroex.swap-instructions"];
  if (includeJupiter) required.push("jupiter.quote");
  return report.profile.selected !== "unavailable" && required.every((id) => report.probes.find((probe) => probe.id === id)?.status === "pass");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  loadPreflightEnvironment(args, invocationDirectory);
  const options = parseArgs(args);
  const report = await runPreflight({
    requestedRegion: options.region,
    samples: options.samples,
    timeoutMs: options.timeoutMs,
    includeJupiter: options.includeJupiter
  });
  const secrets = SECRET_ENV_NAMES.map((name) => process.env[name]).filter((value): value is string => Boolean(value));
  const paths = await writeReportFiles(report, resolve(invocationDirectory, options.outDir), secrets);
  process.stdout.write(`${report.profile.env}\n`);
  process.stdout.write(`PASS=${report.probes.filter(({ status }) => status === "pass").length} FAIL=${report.probes.filter(({ status }) => status === "fail").length} BLOCKED=${report.probes.filter(({ status }) => status === "blocked").length} SKIPPED=${report.probes.filter(({ status }) => status === "skipped").length}\n`);
  for (const path of paths) process.stdout.write(`${path}\n`);
  if (options.strict && !strictReady(report, options.includeJupiter)) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((reason: unknown) => {
    process.stderr.write(`preflight_failed:${reason instanceof Error ? reason.message : String(reason)}\n`);
    process.exitCode = 1;
  });
}
