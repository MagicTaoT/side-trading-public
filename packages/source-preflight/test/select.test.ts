import { describe, expect, it } from "vitest";
import type { ProbeResult } from "../src/contracts.js";
import { REQUIRED_PROBES } from "../src/manifest.js";
import { selectCexProfile } from "../src/select.js";

function probe(id: string, status: ProbeResult["status"] = "pass"): ProbeResult {
  return {
    id,
    source: id.split(".")[0] ?? "source",
    label: id,
    transport: id.endsWith(".ws") ? "websocket" : "http",
    endpoint: "https://example.test",
    status,
    attempts: 1,
    httpStatusCounts: {},
    rateLimited: false,
    latencyMs: { samples: [1], p50: 1, p95: 1 },
    entitlement: "public",
    metadata: {},
    reasons: status === "pass" ? [] : ["failed"]
  };
}

const all = (profile: keyof typeof REQUIRED_PROBES, status: ProbeResult["status"] = "pass") =>
  REQUIRED_PROBES[profile].map((id) => probe(id, status));

describe("atomic CEX selector", () => {
  it("prefers a complete Coinbase spot+SLP profile", () => {
    const decision = selectCexProfile([...all("coinbase"), ...all("binance")]);
    expect(decision.selected).toBe("coinbase");
    expect(decision.env).toBe("S0_CEX_PROFILE=coinbase");
  });

  it("falls back atomically to Binance when any Coinbase leg fails", () => {
    const coinbase = all("coinbase");
    coinbase[2] = probe(REQUIRED_PROBES.coinbase[2] ?? "coinbase.perp.metadata", "fail");
    const decision = selectCexProfile([...coinbase, ...all("binance")]);
    expect(decision.selected).toBe("binance");
    expect(decision.env).toBe("S0_CEX_PROFILE=binance");
    expect(decision.candidates[0]?.complete).toBe(false);
  });

  it("emits unavailable instead of a mixed half-profile", () => {
    const probes = [
      probe("coinbase.spot.metadata"),
      probe("coinbase.spot.ws"),
      probe("binance.perp.metadata"),
      probe("binance.perp.ws")
    ];
    expect(selectCexProfile(probes)).toMatchObject({
      selected: "unavailable",
      env: "S0_CEX_PROFILE=unavailable"
    });
  });
});
