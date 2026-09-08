import { describe, expect, it } from "vitest";
import { BITQUERY_MIN_USDC_NOTIONAL, BITQUERY_SUBSCRIPTION } from "../src/live/bitquery.js";

describe("Bitquery live subscription", () => {
  it("filters on the fixed USDC side amount before data is streamed", () => {
    expect(BITQUERY_MIN_USDC_NOTIONAL).toBe("100");
    expect(BITQUERY_SUBSCRIPTION).toContain(
      `Side: {Amount: {ge: "100"}, Currency: {MintAddress: {is: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}}}`
    );
  });
});
