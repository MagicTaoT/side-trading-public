import { describe, expect, it } from "vitest";
import { USDC_MINT, WSOL_MINT } from "../src/paper/contracts.js";
import { JupiterQuoteProvider, ProviderQuoteError, ZeroExQuoteProvider } from "../src/paper/providers.js";

const request = { inputMint: USDC_MINT, outputMint: WSOL_MINT, amountInAtomic: "10000000000" };

describe("SIDE-010 quote providers", () => {
  it("sanitizes the 0x response and discards transaction instructions", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.headers).toMatchObject({ "0x-api-key": "test-only-key", "0x-version": "v2" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ amount_in: 10_000_000_000 });
      return new Response(JSON.stringify({
        amount_out: 56_710_000_000,
        min_amount_out: 56_426_450_000,
        zid: "abcdef123456",
        route_plan: [{ dex_label: "Orca Whirlpool" }],
        instructions: [{ data: "must-not-survive" }],
        address_lookup_tables: ["must-not-survive"]
      }), { status: 200 });
    };
    let now = 1_000;
    const provider = new ZeroExQuoteProvider({ apiKey: "test-only-key", fetchImpl, now: () => now += 25 });

    const quote = await provider.quote(request);

    expect(quote).toMatchObject({
      provider: "zeroex",
      requestId: "abcdef123456",
      amountOutAtomic: "56710000000",
      minimumAmountOutAtomic: "56426450000",
      routeSummary: ["Orca Whirlpool"]
    });
    expect(JSON.stringify(quote)).not.toMatch(/instructions|lookup|must-not-survive|test-only-key/iu);
    expect(quote.rawResponseHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("uses Jupiter quote-only fields for the explicit fallback", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      expect(url).toContain("/swap/v1/quote?");
      expect(url).toContain("amount=10000000000");
      expect(init?.method).toBeUndefined();
      return new Response(JSON.stringify({
        inAmount: "10000000000",
        outAmount: "56600000000",
        otherAmountThreshold: "56317000000",
        priceImpactPct: "0.0003",
        routePlan: [{ swapInfo: { label: "Meteora DLMM" } }]
      }), { status: 200 });
    };
    const quote = await new JupiterQuoteProvider({ apiKey: "test-only-key", fetchImpl }).quote(request);
    expect(quote).toMatchObject({
      provider: "jupiter",
      amountOutAtomic: "56600000000",
      minimumAmountOutAtomic: "56317000000",
      priceImpactPct: "0.0003",
      routeSummary: ["Meteora DLMM"],
      zid: null
    });
  });

  it("classifies 429, timeout and schema drift without exposing response bodies", async () => {
    const rateLimited = new ZeroExQuoteProvider({
      apiKey: "test-only-key",
      fetchImpl: async () => new Response("quota detail that must not escape", { status: 429 })
    });
    await expect(rateLimited.quote(request)).rejects.toMatchObject({ code: "PROVIDER_HTTP_429", httpStatus: 429 });

    const timedOut = new ZeroExQuoteProvider({
      apiKey: "test-only-key",
      timeoutMs: 1,
      fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("timed out");
          error.name = "AbortError";
          reject(error);
        });
      })
    });
    await expect(timedOut.quote(request)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });

    const drifted = new ZeroExQuoteProvider({
      apiKey: "test-only-key",
      fetchImpl: async () => new Response(JSON.stringify({ amount_out: "1", instructions: [] }), { status: 200 })
    });
    await expect(drifted.quote(request)).rejects.toBeInstanceOf(ProviderQuoteError);
    await expect(drifted.quote(request)).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_DRIFT" });
  });

  it("rejects an amount that cannot be represented as a JSON integer safely", async () => {
    let called = false;
    const provider = new ZeroExQuoteProvider({
      apiKey: "test-only-key",
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }
    });

    await expect(provider.quote({ ...request, amountInAtomic: "9007199254740992" }))
      .rejects.toMatchObject({ code: "PROVIDER_SCHEMA_DRIFT" });
    expect(called).toBe(false);
  });
});
