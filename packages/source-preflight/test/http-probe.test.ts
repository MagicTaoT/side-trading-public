import { describe, expect, it } from "vitest";
import type { HttpProbeDefinition } from "../src/contracts.js";
import { runHttpProbe } from "../src/probes.js";

const definition: HttpProbeDefinition = {
  id: "test.http",
  source: "test",
  label: "test",
  url: "https://example.test/product",
  validate: (value, status) => ({
    pass: status === 200 && (value as { product?: string } | null)?.product === "SOL",
    entitlement: "public",
    metadata: { productId: (value as { product?: string } | null)?.product ?? "not-found" },
    reasons: status === 200 ? [] : ["not_ok"]
  })
};

describe("HTTP probe", () => {
  it("requires every sample to validate", async () => {
    const fetchImplementation = (async () =>
      new Response(JSON.stringify({ product: "SOL" }), { status: 200 })) as typeof fetch;
    const result = await runHttpProbe(definition, { attempts: 2, timeoutMs: 1000, secrets: [] }, fetchImplementation);
    expect(result).toMatchObject({ status: "pass", attempts: 2, httpStatusCounts: { "200": 2 }, rateLimited: false });
    expect(result.latencyMs.samples).toHaveLength(2);
  });

  it("records HTTP 429 as a hard failure", async () => {
    const fetchImplementation = (async () =>
      new Response(JSON.stringify({ product: "SOL" }), { status: 429 })) as typeof fetch;
    const result = await runHttpProbe(definition, { attempts: 1, timeoutMs: 1000, secrets: [] }, fetchImplementation);
    expect(result).toMatchObject({ status: "fail", rateLimited: true, httpStatusCounts: { "429": 1 } });
    expect(result.reasons).toContain("http_429_rate_limited");
    expect(result.reasons).not.toContain("not_ok");
    expect(result.metadata.validatedAttempts).toBe(0);
  });

  it("paces repeated calls when the source defines a minimum sampling interval", async () => {
    const waits: number[] = [];
    const fetchImplementation = (async () =>
      new Response(JSON.stringify({ product: "SOL" }), { status: 200 })) as typeof fetch;
    await runHttpProbe(
      { ...definition, delayBetweenAttemptsMs: 1_100 },
      { attempts: 3, timeoutMs: 1000, secrets: [] },
      fetchImplementation,
      async (milliseconds) => waits.push(milliseconds)
    );
    expect(waits).toEqual([1_100, 1_100]);
  });

  it("redacts credentials embedded in transport errors", async () => {
    const exposed = "do-not-persist-1234";
    const fetchImplementation = (async () => {
      throw new Error(`socket failed with ${exposed}`);
    }) as typeof fetch;
    const result = await runHttpProbe(definition, { attempts: 1, timeoutMs: 1000, secrets: [exposed] }, fetchImplementation);
    expect(JSON.stringify(result)).not.toContain(exposed);
    expect(result.reasons.join(" ")).toContain("[REDACTED]");
  });
});
