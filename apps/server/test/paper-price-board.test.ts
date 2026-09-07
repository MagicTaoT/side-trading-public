import { S0SignalEngine } from "@side/signal-engine";
import { describe, expect, it } from "vitest";
import { PaperEstimateBroker } from "../src/paper/broker.js";
import type { DexReferenceSnapshot, PaperEvidence, PaperQuoteLeg } from "../src/paper/contracts.js";
import { REFERENCE_POLICY_VERSION } from "../src/paper/contracts.js";
import { PaperPriceBoard } from "../src/paper/price-board.js";
import { ProviderQuoteError, type PaperQuoteProvider, type ProviderQuoteRequest } from "../src/paper/providers.js";

function evidence(): PaperEvidence {
  const signal = new S0SignalEngine().snapshot();
  return { mode: "LIVE", signal: { ...signal, verdict: { ...signal.verdict, freshJuryCount: 4 } }, sources: [] };
}

function reference(now: number): DexReferenceSnapshot {
  return {
    policyVersion: REFERENCE_POLICY_VERSION,
    status: "READY",
    evaluatedAtMs: now,
    windowStartMs: now - 15_000,
    windowEndMs: now,
    priceQuotePerSol: "176.000000",
    sampleCount: 8,
    rejectedSampleCount: 0,
    reason: null
  };
}

function leg(request: ProviderQuoteRequest, amountOutAtomic: string, now: number): PaperQuoteLeg {
  return {
    provider: "zeroex",
    requestId: `quote:${request.inputMint}`,
    requestedAtMs: now,
    receivedAtMs: now,
    latencyMs: 0,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amountInAtomic: request.amountInAtomic,
    amountOutAtomic,
    minimumAmountOutAtomic: amountOutAtomic,
    routeSummary: ["Orca"],
    rawResponseHash: "sha256:test",
    priceImpactPct: null,
    zid: "test"
  };
}

describe("paper display price board", () => {
  it("coalesces the 0x display snapshot for five seconds and never marks it recordable", async () => {
    let now = 10_000;
    let calls = 0;
    const provider: PaperQuoteProvider = {
      provider: "zeroex",
      quote: async (request) => {
        calls += 1;
        return leg(request, request.inputMint.includes("EPjF") ? "56710000000" : "9950000000", now);
      }
    };
    const broker = new PaperEstimateBroker({ mode: "LIVE", evidence, zeroex: provider, now: () => now, reference });
    const board = new PaperPriceBoard({ mode: "LIVE", broker, now: () => now });

    const first = await board.current();
    await board.current();
    expect(calls).toBe(2);
    expect(first.buy).toMatchObject({ status: "LIVE", source: "zeroex-estimate", recordable: false });
    expect(first.sell).toMatchObject({ status: "LIVE", source: "zeroex-estimate", recordable: false });

    now += 4_999;
    await board.current();
    expect(calls).toBe(2);
    now += 1;
    await board.current();
    expect(calls).toBe(4);
  });

  it("shows an explicit Bitquery dry model when 0x is unavailable", async () => {
    const now = 20_000;
    const provider: PaperQuoteProvider = {
      provider: "zeroex",
      quote: async () => { throw new ProviderQuoteError("PROVIDER_TIMEOUT", null, true); }
    };
    const broker = new PaperEstimateBroker({ mode: "LIVE", evidence, zeroex: provider, now: () => now, reference });
    const board = new PaperPriceBoard({ mode: "LIVE", broker, now: () => now });

    const snapshot = await board.current();
    expect(snapshot.buy).toMatchObject({
      status: "DRY",
      priceQuotePerSol: "176.880000",
      source: "bitquery-dry",
      upstreamFailure: "PROVIDER_TIMEOUT",
      dryAssumptionBps: 50,
      recordable: false
    });
    expect(snapshot.sell).toMatchObject({ status: "DRY", priceQuotePerSol: "175.120000" });
  });
});
