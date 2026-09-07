import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Decimal from "decimal.js";
import type { PaperProvider, PaperQuoteLeg } from "./contracts.js";
import { USDC_MINT, WSOL_MINT } from "./contracts.js";

const ZEROEX_ENDPOINT = "https://api.0x.org/solana/swap-instructions";
const JUPITER_ENDPOINT = "https://api.jup.ag/swap/v1/quote";
const QUOTE_TAKER = "ZeroEx1111111111111111111111111111111111111";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface ProviderQuoteRequest {
  inputMint: string;
  outputMint: string;
  amountInAtomic: string;
}

export interface PaperQuoteProvider {
  readonly provider: PaperProvider;
  quote(request: ProviderQuoteRequest): Promise<PaperQuoteLeg>;
}

export class ProviderQuoteError extends Error {
  constructor(
    readonly code: "PROVIDER_HTTP_429" | "PROVIDER_HTTP_ERROR" | "PROVIDER_TIMEOUT" | "PROVIDER_NETWORK_ERROR" | "PROVIDER_SCHEMA_DRIFT",
    readonly httpStatus: number | null,
    readonly retriable: boolean
  ) {
    super(code);
  }
}

type FetchLike = typeof fetch;
type Clock = () => number;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function atomic(value: unknown): string | null {
  const raw = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
  if (!raw || !/^\d+$/u.test(raw)) return null;
  try {
    const parsed = new Decimal(raw);
    return parsed.isInteger() && parsed.gte(0) ? parsed.toFixed(0) : null;
  } catch {
    return null;
  }
}

function decimal(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() && parsed.gte(0) ? parsed.toFixed() : null;
  } catch {
    return null;
  }
}

function safeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sanitized = value.replace(/[^a-zA-Z0-9 ._:/()\-]/gu, "").trim().slice(0, 80);
  return sanitized.length > 0 ? sanitized : null;
}

function responseHash(raw: string): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ value: unknown; raw: string; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) throw new ProviderQuoteError("PROVIDER_SCHEMA_DRIFT", response.status, false);
    if (response.status === 429) throw new ProviderQuoteError("PROVIDER_HTTP_429", 429, true);
    if (!response.ok) throw new ProviderQuoteError("PROVIDER_HTTP_ERROR", response.status, response.status >= 500);
    try {
      return { value: JSON.parse(raw), raw, status: response.status };
    } catch {
      throw new ProviderQuoteError("PROVIDER_SCHEMA_DRIFT", response.status, false);
    }
  } catch (reason) {
    if (reason instanceof ProviderQuoteError) throw reason;
    if (reason instanceof Error && reason.name === "AbortError") {
      throw new ProviderQuoteError("PROVIDER_TIMEOUT", null, true);
    }
    throw new ProviderQuoteError("PROVIDER_NETWORK_ERROR", null, true);
  } finally {
    clearTimeout(timer);
  }
}

interface ProviderOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  now?: Clock;
  timeoutMs?: number;
}

export class ZeroExQuoteProvider implements PaperQuoteProvider {
  readonly provider = "zeroex" as const;
  readonly #fetch: FetchLike;
  readonly #now: Clock;
  readonly #timeoutMs: number;

  constructor(private readonly options: ProviderOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 1_800;
  }

  async quote(request: ProviderQuoteRequest): Promise<PaperQuoteLeg> {
    const requestedAtMs = this.#now();
    const numericAmountIn = Number(request.amountInAtomic);
    if (!Number.isSafeInteger(numericAmountIn) || numericAmountIn <= 0) {
      throw new ProviderQuoteError("PROVIDER_SCHEMA_DRIFT", null, false);
    }
    const { value, raw } = await fetchJson(this.#fetch, ZEROEX_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "0x-api-key": this.options.apiKey,
        "0x-version": "v2"
      },
      body: JSON.stringify({
        amount_in: numericAmountIn,
        taker: QUOTE_TAKER,
        token_in: request.inputMint,
        token_out: request.outputMint,
        slippage_bps: 50
      })
    }, this.#timeoutMs);
    const response = object(value);
    const amountOutAtomic = atomic(response?.amount_out);
    const minimumAmountOutAtomic = atomic(response?.min_amount_out);
    const route = Array.isArray(response?.route_plan) ? response.route_plan : null;
    if (!response || !amountOutAtomic || !minimumAmountOutAtomic || !route || new Decimal(amountOutAtomic).lte(0)) {
      throw new ProviderQuoteError("PROVIDER_SCHEMA_DRIFT", 200, false);
    }
    const receivedAtMs = this.#now();
    const zid = safeLabel(response.zid);
    const routeSummary = route
      .map((leg) => safeLabel(object(leg)?.dex_label))
      .filter((label): label is string => label !== null)
      .slice(0, 8);
    return {
      provider: this.provider,
      requestId: zid ?? `zeroex:${randomUUID()}`,
      requestedAtMs,
      receivedAtMs,
      latencyMs: Math.max(0, receivedAtMs - requestedAtMs),
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amountInAtomic: request.amountInAtomic,
      amountOutAtomic,
      minimumAmountOutAtomic,
      routeSummary,
      rawResponseHash: responseHash(raw),
      priceImpactPct: null,
      zid
    };
  }
}

export class JupiterQuoteProvider implements PaperQuoteProvider {
  readonly provider = "jupiter" as const;
  readonly #fetch: FetchLike;
  readonly #now: Clock;
  readonly #timeoutMs: number;

  constructor(private readonly options: ProviderOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 1_800;
  }

  async quote(request: ProviderQuoteRequest): Promise<PaperQuoteLeg> {
    const requestedAtMs = this.#now();
    const query = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amountInAtomic,
      slippageBps: "50",
      restrictIntermediateTokens: "true",
      swapMode: "ExactIn"
    });
    const { value, raw } = await fetchJson(this.#fetch, `${JUPITER_ENDPOINT}?${query.toString()}`, {
      headers: { "x-api-key": this.options.apiKey }
    }, this.#timeoutMs);
    const response = object(value);
    const amountOutAtomic = atomic(response?.outAmount);
    const minimumAmountOutAtomic = atomic(response?.otherAmountThreshold);
    const route = Array.isArray(response?.routePlan) ? response.routePlan : null;
    if (!response || !amountOutAtomic || !minimumAmountOutAtomic || !route || new Decimal(amountOutAtomic).lte(0)) {
      throw new ProviderQuoteError("PROVIDER_SCHEMA_DRIFT", 200, false);
    }
    const receivedAtMs = this.#now();
    const routeSummary = route
      .map((leg) => safeLabel(object(object(leg)?.swapInfo)?.label))
      .filter((label): label is string => label !== null)
      .slice(0, 8);
    return {
      provider: this.provider,
      requestId: `jupiter:${randomUUID()}`,
      requestedAtMs,
      receivedAtMs,
      latencyMs: Math.max(0, receivedAtMs - requestedAtMs),
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amountInAtomic: request.amountInAtomic,
      amountOutAtomic,
      minimumAmountOutAtomic,
      routeSummary,
      rawResponseHash: responseHash(raw),
      priceImpactPct: decimal(response.priceImpactPct),
      zid: null
    };
  }
}

export class ReplayQuoteProvider implements PaperQuoteProvider {
  readonly provider = "zeroex" as const;

  constructor(private readonly now: Clock = Date.now) {}

  async quote(request: ProviderQuoteRequest): Promise<PaperQuoteLeg> {
    const requestedAtMs = this.now();
    await delay(0);
    const isBuy = request.inputMint === USDC_MINT && request.outputMint === WSOL_MINT;
    const amountOutAtomic = isBuy ? "56710000000" : "9950000000";
    const minimumAmountOutAtomic = isBuy ? "56426450000" : "9900250000";
    const receivedAtMs = this.now();
    const raw = JSON.stringify({ fixture: "side-010", request, amountOutAtomic, minimumAmountOutAtomic });
    return {
      provider: this.provider,
      requestId: `replay:${isBuy ? "anchor" : "sell"}:side-010`,
      requestedAtMs,
      receivedAtMs,
      latencyMs: Math.max(0, receivedAtMs - requestedAtMs),
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amountInAtomic: request.amountInAtomic,
      amountOutAtomic,
      minimumAmountOutAtomic,
      routeSummary: ["Frozen 0x response-shaped fixture"],
      rawResponseHash: responseHash(raw),
      priceImpactPct: null,
      zid: "replay-side-010"
    };
  }
}
