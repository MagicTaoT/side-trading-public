import { S0SignalEngine } from "@side/signal-engine";
import { describe, expect, it } from "vitest";
import { PaperEstimateBroker, PaperPolicyError } from "../src/paper/broker.js";
import type { PaperEvidence, PaperProvider, PaperQuoteLeg } from "../src/paper/contracts.js";
import { USDC_MINT, WSOL_MINT } from "../src/paper/contracts.js";
import { ProviderQuoteError, type PaperQuoteProvider, type ProviderQuoteRequest } from "../src/paper/providers.js";

function evidence(freshJuryCount = 4): PaperEvidence {
  const signal = new S0SignalEngine().snapshot();
  return {
    mode: "LIVE",
    signal: { ...signal, verdict: { ...signal.verdict, freshJuryCount } },
    sources: []
  };
}

function leg(provider: PaperProvider, request: ProviderQuoteRequest, amountOutAtomic: string, now = 1_000): PaperQuoteLeg {
  return {
    provider,
    requestId: `${provider}:request`,
    requestedAtMs: now,
    receivedAtMs: now + 100,
    latencyMs: 100,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amountInAtomic: request.amountInAtomic,
    amountOutAtomic,
    minimumAmountOutAtomic: new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: 0 }).format(Number(amountOutAtomic) * 0.995),
    routeSummary: [provider === "zeroex" ? "Orca" : "Meteora"],
    rawResponseHash: "sha256:test",
    priceImpactPct: null,
    zid: provider === "zeroex" ? "abc123" : null
  };
}

class FakeProvider implements PaperQuoteProvider {
  calls: ProviderQuoteRequest[] = [];

  constructor(
    readonly provider: PaperProvider,
    private readonly respond: (request: ProviderQuoteRequest, call: number) => PaperQuoteLeg | Promise<PaperQuoteLeg>
  ) {}

  async quote(request: ProviderQuoteRequest): Promise<PaperQuoteLeg> {
    this.calls.push(request);
    return this.respond(request, this.calls.length);
  }
}

function ids(): () => string {
  let value = 0;
  return () => String(++value).padStart(4, "0");
}

describe("SIDE-010 paper estimate broker", () => {
  it("creates a sanitized, idempotent BUY preview without an execution body", async () => {
    const zeroex = new FakeProvider("zeroex", (request) => leg("zeroex", request, "56710000000"));
    const broker = new PaperEstimateBroker({ mode: "LIVE", evidence, zeroex, now: () => 1_200, id: ids() });
    const request = { side: "BUY" as const, provider: "zeroex" as const, idempotencyKey: "preview-buy-001", primaryFailureId: null };

    const first = await broker.preview(request);
    const second = await broker.preview(request);

    expect(first).toEqual(second);
    expect(zeroex.calls).toHaveLength(1);
    expect(first).toMatchObject({
      status: "READY",
      provider: "zeroex",
      side: "BUY",
      expiresAtMs: 11_100,
      estimatedOutputSOL: "56.710000000",
      referencePxQuotePerSol: "176.335743",
      effectivePxQuotePerSol: "176.335743",
      recordable: true
    });
    expect(JSON.stringify(first)).not.toMatch(/instructions|api.?key|taker/iu);
  });

  it("keeps the default action preview valid for ten seconds", async () => {
    let now = 11_099;
    const zeroex = new FakeProvider("zeroex", (request) => leg("zeroex", request, "56710000000", 1_000));
    const broker = new PaperEstimateBroker({ mode: "LIVE", evidence, zeroex, now: () => now, id: ids() });
    const preview = await broker.preview({ side: "BUY", provider: "zeroex", idempotencyKey: "preview-default-ttl", primaryFailureId: null });

    expect(preview).toMatchObject({ expiresAtMs: 11_100, quoteAgeMs: 9_999, recordable: true });
    now = 11_101;
    await expect(broker.record({
      action: "BUY",
      previewId: preview.previewId,
      provider: "zeroex",
      idempotencyKey: "record-default-ttl"
    })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED", statusCode: 410 });
  });

  it("uses a same-provider USDC anchor before the SELL exact-in request", async () => {
    const zeroex = new FakeProvider("zeroex", (request, call) => leg("zeroex", request, call === 1 ? "56710000000" : "9950000000"));
    const broker = new PaperEstimateBroker({ mode: "LIVE", evidence, zeroex, now: () => 1_200, id: ids() });

    const preview = await broker.preview({ side: "SELL", provider: "zeroex", idempotencyKey: "preview-sell-01", primaryFailureId: null });

    expect(zeroex.calls).toEqual([
      { inputMint: USDC_MINT, outputMint: WSOL_MINT, amountInAtomic: "10000000000" },
      { inputMint: WSOL_MINT, outputMint: USDC_MINT, amountInAtomic: "56710000000" }
    ]);
    expect(preview).toMatchObject({
      status: "READY",
      inputAmountSOL: "56.710000000",
      estimatedOutputUSDC: "9950.000000",
      effectivePxQuotePerSol: "175.454065",
      provider: "zeroex"
    });
    expect(preview.anchor?.provider).toBe(preview.directional?.provider);
  });

  it("expires a SELL preview from the oldest required quote leg", async () => {
    let now = 3_050;
    const zeroex = new FakeProvider("zeroex", (request, call) =>
      leg("zeroex", request, call === 1 ? "56710000000" : "9950000000", call === 1 ? 1_000 : 2_900)
    );
    const broker = new PaperEstimateBroker({ mode: "LIVE", evidence, zeroex, now: () => now, id: ids(), ttlMs: 2_000 });

    const preview = await broker.preview({ side: "SELL", provider: "zeroex", idempotencyKey: "preview-old-anchor", primaryFailureId: null });

    expect(preview).toMatchObject({ expiresAtMs: 3_100, quoteAgeMs: 1_950, recordable: true });
    now = 3_101;
    await expect(broker.record({
      action: "SELL",
      previewId: preview.previewId,
      provider: "zeroex",
      idempotencyKey: "record-old-anchor"
    })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED", statusCode: 410 });
  });

  it("never falls back automatically after 0x 429 and requires an explicit matching failure id", async () => {
    const zeroex = new FakeProvider("zeroex", async () => { throw new ProviderQuoteError("PROVIDER_HTTP_429", 429, true); });
    const jupiter = new FakeProvider("jupiter", (request) => leg("jupiter", request, "56600000000"));
    const broker = new PaperEstimateBroker({ mode: "LIVE", evidence, zeroex, jupiter, now: () => 2_000, id: ids() });

    const failed = await broker.preview({ side: "BUY", provider: "zeroex", idempotencyKey: "preview-fail-001", primaryFailureId: null });
    expect(failed).toMatchObject({ status: "UNAVAILABLE", failure: { code: "PROVIDER_HTTP_429", httpStatus: 429 } });
    expect(jupiter.calls).toHaveLength(0);
    await expect(broker.preview({ side: "BUY", provider: "jupiter", idempotencyKey: "fallback-no-id1", primaryFailureId: null }))
      .rejects.toMatchObject({ code: "JUPITER_REQUIRES_ZEROEX_FAILURE" });

    const fallback = await broker.preview({
      side: "BUY",
      provider: "jupiter",
      idempotencyKey: "fallback-with-id",
      primaryFailureId: failed.failure?.failureId ?? null
    });
    expect(fallback).toMatchObject({ status: "READY", provider: "jupiter", primaryFailureId: failed.failure?.failureId });
    expect(jupiter.calls).toHaveLength(1);
  });

  it.each([
    ["PROVIDER_TIMEOUT", true],
    ["PROVIDER_SCHEMA_DRIFT", false]
  ] as const)("returns an auditable %s failure", async (code, retriable) => {
    const zeroex = new FakeProvider("zeroex", async () => { throw new ProviderQuoteError(code, null, retriable); });
    const broker = new PaperEstimateBroker({ mode: "LIVE", evidence, zeroex, id: ids() });
    const preview = await broker.preview({ side: "BUY", provider: "zeroex", idempotencyKey: `preview-${code}`, primaryFailureId: null });
    expect(preview).toMatchObject({ status: "UNAVAILABLE", recordable: false, failure: { code, retriable } });
  });

  it("fails closed on mixed-provider SELL legs", async () => {
    const zeroex = new FakeProvider("zeroex", (request, call) => leg(call === 1 ? "zeroex" : "jupiter", request, call === 1 ? "56710000000" : "9950000000"));
    const broker = new PaperEstimateBroker({ mode: "LIVE", evidence, zeroex, id: ids() });
    const preview = await broker.preview({ side: "SELL", provider: "zeroex", idempotencyKey: "preview-mixed-01", primaryFailureId: null });
    expect(preview).toMatchObject({ status: "UNAVAILABLE", failure: { code: "MIXED_PROVIDER_RESPONSE" } });
  });

  it("rejects expired previews and records an unexpired order exactly once", async () => {
    let now = 1_200;
    const zeroex = new FakeProvider("zeroex", (request) => leg("zeroex", request, "56710000000", 1_000));
    const broker = new PaperEstimateBroker({ mode: "LIVE", evidence, zeroex, now: () => now, id: ids(), ttlMs: 2_000 });
    const preview = await broker.preview({ side: "BUY", provider: "zeroex", idempotencyKey: "preview-record-1", primaryFailureId: null });
    const recordRequest = { action: "BUY" as const, previewId: preview.previewId, provider: "zeroex" as const, idempotencyKey: "record-paper-001" };
    const first = await broker.record(recordRequest);
    const second = await broker.record(recordRequest);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      executionMode: "paper",
      persistence: "memory-side-011-test",
      action: "BUY",
      markout: { status: "PENDING", horizonMs: 300_000 }
    });

    const another = await broker.preview({ side: "BUY", provider: "zeroex", idempotencyKey: "preview-expire-1", primaryFailureId: null });
    now = 3_101;
    await expect(broker.record({ ...recordRequest, previewId: another.previewId, idempotencyKey: "record-expired-1" }))
      .rejects.toMatchObject({ code: "PREVIEW_EXPIRED", statusCode: 410 });
  });

  it("disables LIVE preview and records when fewer than three juries are fresh", async () => {
    const zeroex = new FakeProvider("zeroex", (request) => leg("zeroex", request, "56710000000"));
    const broker = new PaperEstimateBroker({ mode: "LIVE", evidence: () => evidence(2), zeroex, id: ids() });
    const preview = await broker.preview({ side: "BUY", provider: "zeroex", idempotencyKey: "preview-no-data1", primaryFailureId: null });
    expect(preview).toMatchObject({ status: "UNAVAILABLE", failure: { code: "MARKET_DATA_NOT_READY" } });
    expect(zeroex.calls).toHaveLength(0);
    await expect(broker.record({ action: "WAIT", previewId: null, provider: null, idempotencyKey: "record-no-data01" }))
      .rejects.toBeInstanceOf(PaperPolicyError);
  });
});
