import { describe, expect, it } from "vitest";
import { DEFAULT_ENV_FILE, parseArgs, strictReady } from "../src/cli.js";
import type { PreflightReport, ProbeResult } from "../src/contracts.js";
import { ENDPOINTS, REQUIRED_PROBES, SECRET_ENV_NAMES } from "../src/manifest.js";

describe("preflight CLI and frozen manifest", () => {
  it("keeps Jupiter opt-in and reads only credential names from the environment", () => {
    const options = parseArgs([], { AWS_REGION: "us-east-1" });
    expect(options).toMatchObject({ envFile: DEFAULT_ENV_FILE, region: "us-east-1", includeJupiter: false });
    expect(SECRET_ENV_NAMES).toEqual(["BITQUERY_TOKEN", "ZEROEX_API_KEY", "JUPITER_API_KEY"]);
  });

  it("parses explicit execution controls", () => {
    expect(
      parseArgs(["--", "--env-file", "secrets/preflight.env", "--out-dir", "reports/test", "--region", "us-east-1", "--samples", "5", "--timeout-ms", "9000", "--include-jupiter", "--strict"])
    ).toEqual({ envFile: "secrets/preflight.env", outDir: "reports/test", region: "us-east-1", samples: 5, timeoutMs: 9000, includeJupiter: true, strict: true });
  });

  it("contains both legs for each atomic CEX candidate and secure endpoints", () => {
    expect(REQUIRED_PROBES.coinbase).toEqual(expect.arrayContaining(["coinbase.spot.metadata", "coinbase.perp.metadata"]));
    expect(REQUIRED_PROBES.binance).toEqual(expect.arrayContaining(["binance.spot.metadata", "binance.perp.metadata"]));
    expect(Object.values(ENDPOINTS).every((endpoint) => endpoint.startsWith("https://") || endpoint.startsWith("wss://"))).toBe(true);
  });

  it("requires Jupiter only when its explicit fallback probe is requested", () => {
    const probe = (id: string, status: ProbeResult["status"]): ProbeResult => ({
      id,
      source: "test",
      label: id,
      transport: "http",
      endpoint: "https://example.test",
      status,
      attempts: 1,
      httpStatusCounts: {},
      rateLimited: false,
      latencyMs: { samples: [1], p50: 1, p95: 1 },
      entitlement: "public",
      metadata: {},
      reasons: []
    });
    const required = ["hyperliquid.metadata", "hyperliquid.ws", "bitquery.wsol-usdc.ws", "zeroex.swap-instructions"];
    const report = {
      profile: { selected: "coinbase" },
      probes: [...required.map((id) => probe(id, "pass")), probe("jupiter.quote", "fail")]
    } as Pick<PreflightReport, "profile" | "probes">;
    expect(strictReady(report, false)).toBe(true);
    expect(strictReady(report, true)).toBe(false);
  });
});
