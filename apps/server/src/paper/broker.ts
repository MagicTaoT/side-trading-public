import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type {
  DexReferenceSnapshot,
  PaperAction,
  PaperEvidence,
  PaperFailureCode,
  PaperMarkout,
  PaperOrder,
  PaperPerformanceSummary,
  PaperPreview,
  PaperProvider,
  PaperQuoteFailure,
  PaperQuoteLeg,
  PaperSide,
  PreviewRequest,
  RecordPaperOrderRequest
} from "./contracts.js";
import {
  PAPER_MARKOUT_HORIZON_MS,
  PAPER_NOTIONAL_QUOTE,
  PAPER_PAIR,
  PAPER_PREVIEW_TTL_MS,
  REFERENCE_POLICY_VERSION,
  USDC_MINT,
  WSOL_MINT
} from "./contracts.js";
import { JournalConflictError, MemoryDecisionJournal, type DecisionJournal } from "./journal.js";
import { ProviderQuoteError, type PaperQuoteProvider } from "./providers.js";

const USDC_ATOMIC = "10000000000";
const MAX_CACHE_ENTRIES = 512;
const FALLBACK_FAILURE_TTL_MS = 60_000;
const IDEMPOTENCY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;

type Clock = () => number;
type IdFactory = () => string;

interface BrokerOptions {
  mode: "LIVE" | "REPLAY";
  evidence: () => PaperEvidence;
  zeroex?: PaperQuoteProvider;
  jupiter?: PaperQuoteProvider;
  now?: Clock;
  id?: IdFactory;
  ttlMs?: number;
  journal?: DecisionJournal;
  reference?: (evaluatedAtMs: number) => DexReferenceSnapshot;
}

interface Cached<T> {
  fingerprint: string;
  value: Promise<T>;
}

interface RegisteredFailure {
  failure: PaperQuoteFailure;
  side: PaperSide;
}

export class PaperPolicyError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
  }
}

function trimMap<K, V>(map: Map<K, V>): void {
  while (map.size > MAX_CACHE_ENTRIES) {
    const first = map.keys().next().value as K | undefined;
    if (first === undefined) return;
    map.delete(first);
  }
}

function validateIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_PATTERN.test(value)) throw new PaperPolicyError(400, "INVALID_IDEMPOTENCY_KEY");
}

function atomicToDecimal(value: string, decimals: number): string {
  return new Decimal(value).div(new Decimal(10).pow(decimals)).toFixed(decimals === 9 ? 9 : 6);
}

function routeSummary(provider: PaperProvider, legs: PaperQuoteLeg[]): string[] {
  const labels = [...new Set(legs.flatMap((leg) => leg.routeSummary))];
  return [`${provider === "zeroex" ? "0x" : "Jupiter"} · ExactIn`, ...labels].slice(0, 9);
}

export class PaperEstimateBroker {
  readonly #mode: "LIVE" | "REPLAY";
  readonly #evidence: () => PaperEvidence;
  readonly #providers: Partial<Record<PaperProvider, PaperQuoteProvider>>;
  readonly #now: Clock;
  readonly #id: IdFactory;
  readonly #ttlMs: number;
  readonly #journal: DecisionJournal;
  readonly #reference: (evaluatedAtMs: number) => DexReferenceSnapshot;
  readonly #previewRequests = new Map<string, Cached<PaperPreview>>();
  readonly #orderRequests = new Map<string, Cached<PaperOrder>>();
  readonly #previews = new Map<string, PaperPreview>();
  readonly #orders = new Map<string, PaperOrder>();
  readonly #failures = new Map<string, RegisteredFailure>();
  readonly #providerAvailableAt = new Map<PaperProvider, number>();
  readonly #providerFailedAt = new Map<PaperProvider, number>();

  constructor(options: BrokerOptions) {
    this.#mode = options.mode;
    this.#evidence = options.evidence;
    this.#providers = {
      ...(options.zeroex ? { zeroex: options.zeroex } : {}),
      ...(options.jupiter ? { jupiter: options.jupiter } : {})
    };
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#ttlMs = options.ttlMs ?? PAPER_PREVIEW_TTL_MS;
    this.#journal = options.journal ?? new MemoryDecisionJournal();
    this.#reference = options.reference ?? ((evaluatedAtMs) => ({
      policyVersion: REFERENCE_POLICY_VERSION,
      status: "UNAVAILABLE",
      evaluatedAtMs,
      windowStartMs: evaluatedAtMs - 15_000,
      windowEndMs: evaluatedAtMs,
      priceQuotePerSol: null,
      sampleCount: 0,
      rejectedSampleCount: 0,
      reason: "SOURCE_NOT_OBSERVED"
    }));
  }

  get journal(): DecisionJournal { return this.#journal; }
  get reference(): (evaluatedAtMs: number) => DexReferenceSnapshot { return this.#reference; }

  async preview(request: PreviewRequest): Promise<PaperPreview> {
    validateIdempotencyKey(request.idempotencyKey);
    if (request.side !== "BUY" && request.side !== "SELL") throw new PaperPolicyError(400, "INVALID_PAPER_SIDE");
    if (request.provider !== "zeroex" && request.provider !== "jupiter") throw new PaperPolicyError(400, "INVALID_PAPER_PROVIDER");
    this.#assertFallbackPolicy(request);
    const fingerprint = `${request.side}:${request.provider}:${request.primaryFailureId ?? "none"}`;
    const existing = this.#previewRequests.get(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PaperPolicyError(409, "IDEMPOTENCY_KEY_REUSED");
      return existing.value;
    }
    const value = this.#createPreview(request);
    this.#previewRequests.set(request.idempotencyKey, { fingerprint, value });
    trimMap(this.#previewRequests);
    return value;
  }

  async record(request: RecordPaperOrderRequest): Promise<PaperOrder> {
    validateIdempotencyKey(request.idempotencyKey);
    if (!(["BUY", "SELL", "WAIT"] as PaperAction[]).includes(request.action)) {
      throw new PaperPolicyError(400, "INVALID_PAPER_ACTION");
    }
    const fingerprint = `${request.action}:${request.previewId ?? "none"}:${request.provider ?? "none"}`;
    const existing = this.#orderRequests.get(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PaperPolicyError(409, "IDEMPOTENCY_KEY_REUSED");
      return existing.value;
    }
    const value = this.#record(request);
    this.#orderRequests.set(request.idempotencyKey, { fingerprint, value });
    trimMap(this.#orderRequests);
    return value;
  }

  getPreview(previewId: string): PaperPreview | null {
    const preview = this.#previews.get(previewId);
    if (!preview) return null;
    return this.#refreshPreview(preview);
  }

  async getOrder(orderId: string): Promise<PaperOrder | null> {
    return await this.#journal.getDecision(orderId) ?? this.#orders.get(orderId) ?? null;
  }

  async listOrders(limit: number): Promise<PaperOrder[]> {
    return this.#journal.listDecisions(limit);
  }

  async deleteOrder(orderId: string): Promise<boolean> {
    const deleted = await this.#journal.deleteDecision(orderId);
    if (!deleted) return false;
    this.#orders.delete(orderId);
    for (const [key, cached] of this.#orderRequests) {
      try {
        if ((await cached.value).orderId === orderId) this.#orderRequests.delete(key);
      } catch {
        // Failed cached requests never produced this persisted order.
      }
    }
    return true;
  }

  async performance(): Promise<PaperPerformanceSummary> {
    return this.#journal.performance();
  }

  #assertFallbackPolicy(request: PreviewRequest): void {
    if (request.provider === "zeroex") {
      if (request.primaryFailureId !== null) throw new PaperPolicyError(400, "PRIMARY_FAILURE_NOT_ALLOWED");
      return;
    }
    if (!request.primaryFailureId) throw new PaperPolicyError(409, "JUPITER_REQUIRES_ZEROEX_FAILURE");
    const registered = this.#failures.get(request.primaryFailureId);
    if (!registered || registered.failure.provider !== "zeroex" || registered.side !== request.side) {
      throw new PaperPolicyError(409, "INVALID_ZEROEX_FAILURE");
    }
    if (this.#now() - registered.failure.occurredAtMs > FALLBACK_FAILURE_TTL_MS) {
      throw new PaperPolicyError(410, "ZEROEX_FAILURE_EXPIRED");
    }
  }

  async #createPreview(request: PreviewRequest): Promise<PaperPreview> {
    const createdAtMs = this.#now();
    if (this.#mode === "LIVE" && this.#evidence().signal.verdict.freshJuryCount < 3) {
      return this.#unavailable(request, createdAtMs, "MARKET_DATA_NOT_READY", null, false);
    }
    const provider = this.#providers[request.provider];
    if (!provider) return this.#unavailable(request, createdAtMs, "PROVIDER_NOT_CONFIGURED", null, false);
    try {
      const anchor = request.side === "SELL"
        ? await provider.quote({ inputMint: USDC_MINT, outputMint: WSOL_MINT, amountInAtomic: USDC_ATOMIC })
        : null;
      const directional = request.side === "BUY"
        ? await provider.quote({ inputMint: USDC_MINT, outputMint: WSOL_MINT, amountInAtomic: USDC_ATOMIC })
        : await provider.quote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amountInAtomic: anchor?.amountOutAtomic as string });
      if (provider.provider !== request.provider || directional.provider !== request.provider || (anchor && anchor.provider !== directional.provider)) {
        return this.#unavailable(request, createdAtMs, "MIXED_PROVIDER_RESPONSE", null, false);
      }
      const previewId = `preview:${this.#id()}`;
      const completedAtMs = Math.max(directional.receivedAtMs, anchor?.receivedAtMs ?? 0);
      const oldestRequiredQuoteAtMs = Math.min(directional.receivedAtMs, anchor?.receivedAtMs ?? directional.receivedAtMs);
      const inputAmountSOL = request.side === "SELL" && anchor ? atomicToDecimal(anchor.amountOutAtomic, 9) : null;
      const estimatedOutputSOL = request.side === "BUY" ? atomicToDecimal(directional.amountOutAtomic, 9) : null;
      const estimatedOutputUSDC = request.side === "SELL" ? atomicToDecimal(directional.amountOutAtomic, 6) : null;
      const minimumOutputAmount = directional.minimumAmountOutAtomic === null
        ? null
        : atomicToDecimal(directional.minimumAmountOutAtomic, request.side === "BUY" ? 9 : 6);
      const referenceSolAtomic = request.side === "BUY" ? directional.amountOutAtomic : anchor?.amountOutAtomic as string;
      const referencePxQuotePerSol = new Decimal(PAPER_NOTIONAL_QUOTE)
        .div(new Decimal(referenceSolAtomic).div(1_000_000_000))
        .toFixed(6);
      const effectivePxQuotePerSol = request.side === "BUY"
        ? new Decimal(PAPER_NOTIONAL_QUOTE).div(estimatedOutputSOL as string).toFixed(6)
        : new Decimal(estimatedOutputUSDC as string).div(inputAmountSOL as string).toFixed(6);
      const preview: PaperPreview = {
        schemaVersion: 1,
        previewId,
        mode: this.#mode,
        status: "READY",
        provider: request.provider,
        side: request.side,
        pair: PAPER_PAIR,
        targetNotionalQuote: PAPER_NOTIONAL_QUOTE,
        createdAtMs,
        expiresAtMs: oldestRequiredQuoteAtMs + this.#ttlMs,
        quoteAgeMs: Math.max(0, this.#now() - oldestRequiredQuoteAtMs),
        recordable: true,
        primaryFailureId: request.primaryFailureId,
        failure: null,
        anchor,
        directional,
        inputAmountSOL,
        estimatedOutputSOL,
        estimatedOutputUSDC,
        minimumOutputAmount,
        referencePxQuotePerSol,
        effectivePxQuotePerSol,
        routeSummary: routeSummary(request.provider, [anchor, directional].filter((leg): leg is PaperQuoteLeg => leg !== null)),
        feeBreakdown: null
      };
      this.#providerAvailableAt.set(request.provider, completedAtMs);
      this.#previews.set(previewId, preview);
      trimMap(this.#previews);
      return preview;
    } catch (reason) {
      const error = reason instanceof ProviderQuoteError
        ? reason
        : new ProviderQuoteError("PROVIDER_NETWORK_ERROR", null, true);
      return this.#unavailable(request, createdAtMs, error.code, error.httpStatus, error.retriable);
    }
  }

  #unavailable(
    request: PreviewRequest,
    createdAtMs: number,
    code: PaperFailureCode,
    httpStatus: number | null,
    retriable: boolean
  ): PaperPreview {
    const failure: PaperQuoteFailure = {
      failureId: `failure:${this.#id()}`,
      provider: request.provider,
      code,
      occurredAtMs: this.#now(),
      retriable,
      httpStatus
    };
    if (request.provider === "zeroex" && code !== "MARKET_DATA_NOT_READY") {
      this.#failures.set(failure.failureId, { failure, side: request.side });
      trimMap(this.#failures);
    }
    this.#providerFailedAt.set(request.provider, failure.occurredAtMs);
    const preview: PaperPreview = {
      schemaVersion: 1,
      previewId: `preview:${this.#id()}`,
      mode: this.#mode,
      status: "UNAVAILABLE",
      provider: request.provider,
      side: request.side,
      pair: PAPER_PAIR,
      targetNotionalQuote: PAPER_NOTIONAL_QUOTE,
      createdAtMs,
      expiresAtMs: null,
      quoteAgeMs: null,
      recordable: false,
      primaryFailureId: request.primaryFailureId,
      failure,
      anchor: null,
      directional: null,
      inputAmountSOL: null,
      estimatedOutputSOL: null,
      estimatedOutputUSDC: null,
      minimumOutputAmount: null,
      referencePxQuotePerSol: null,
      effectivePxQuotePerSol: null,
      routeSummary: [],
      feeBreakdown: null
    };
    this.#previews.set(preview.previewId, preview);
    trimMap(this.#previews);
    return preview;
  }

  async #record(request: RecordPaperOrderRequest): Promise<PaperOrder> {
    const evidence = this.#evidence();
    if (this.#mode === "LIVE" && evidence.signal.verdict.freshJuryCount < 3) {
      throw new PaperPolicyError(409, "MARKET_DATA_NOT_READY");
    }
    let preview: PaperPreview | null = null;
    if (request.action === "WAIT") {
      if (request.previewId !== null || request.provider !== null) throw new PaperPolicyError(400, "WAIT_MUST_NOT_INCLUDE_PREVIEW");
    } else {
      if (!request.previewId || !request.provider) throw new PaperPolicyError(400, "PREVIEW_REQUIRED");
      const stored = this.#previews.get(request.previewId);
      if (!stored) throw new PaperPolicyError(404, "PREVIEW_NOT_FOUND");
      preview = this.#refreshPreview(stored);
      if (preview.status !== "READY") throw new PaperPolicyError(409, "PREVIEW_UNAVAILABLE");
      if (!preview.recordable) throw new PaperPolicyError(410, "PREVIEW_EXPIRED");
      if (preview.side !== request.action || preview.provider !== request.provider) {
        throw new PaperPolicyError(409, "PREVIEW_POLICY_MISMATCH");
      }
      const availableAt = this.#providerAvailableAt.get(preview.provider) ?? 0;
      const failedAt = this.#providerFailedAt.get(preview.provider) ?? 0;
      if (failedAt > availableAt) throw new PaperPolicyError(409, "PROVIDER_HEALTH_CHANGED");
    }
    const recordedAtMs = this.#now();
    const entryReference = this.#reference(recordedAtMs);
    const markout: PaperMarkout = {
      decisionId: `paper:${this.#id()}`,
      horizonMs: PAPER_MARKOUT_HORIZON_MS,
      referencePolicyVersion: REFERENCE_POLICY_VERSION,
      dueAtMs: recordedAtMs + PAPER_MARKOUT_HORIZON_MS,
      status: "PENDING",
      entryReference,
      futureReference: null,
      directionalMarkoutBps: null,
      directionalPnlQuote: null,
      reason: null,
      computedAtMs: null
    };
    const order: PaperOrder = {
      schemaVersion: 1,
      orderId: markout.decisionId,
      executionMode: "paper",
      persistence: this.#journal.persistence,
      action: request.action,
      pair: PAPER_PAIR,
      targetNotionalQuote: PAPER_NOTIONAL_QUOTE,
      provider: preview?.provider ?? null,
      previewId: preview?.previewId ?? null,
      recordedAtMs,
      preview,
      evidence,
      markout
    };
    let stored: PaperOrder;
    try {
      stored = await this.#journal.recordDecision({
        order,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: `${request.action}:${request.previewId ?? "none"}:${request.provider ?? "none"}`
      });
    } catch (reason) {
      if (reason instanceof JournalConflictError) throw new PaperPolicyError(409, reason.code);
      throw reason;
    }
    this.#orders.set(stored.orderId, stored);
    trimMap(this.#orders);
    return stored;
  }

  #refreshPreview(preview: PaperPreview): PaperPreview {
    if (preview.status !== "READY" || preview.expiresAtMs === null || preview.directional === null) return preview;
    const oldestRequiredQuoteAtMs = Math.min(
      preview.directional.receivedAtMs,
      preview.anchor?.receivedAtMs ?? preview.directional.receivedAtMs
    );
    const quoteAgeMs = Math.max(0, this.#now() - oldestRequiredQuoteAtMs);
    return { ...preview, quoteAgeMs, recordable: this.#now() <= preview.expiresAtMs };
  }
}
