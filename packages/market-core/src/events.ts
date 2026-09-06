import { z } from "zod";

const nonNegativeIntegerString = z.string().regex(/^(0|[1-9]\d*)$/);
const decimalString = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, "expected a base-10 decimal string");
const nonNegativeDecimalString = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "expected a non-negative base-10 decimal string");
const timestampMs = z.number().int().nonnegative().finite();

function compareNonNegativeDecimals(left: string, right: string): number {
  const [leftInteger = "0", leftFraction = ""] = left.split(".");
  const [rightInteger = "0", rightFraction = ""] = right.split(".");

  if (leftInteger.length !== rightInteger.length) {
    return leftInteger.length < rightInteger.length ? -1 : 1;
  }
  if (leftInteger !== rightInteger) {
    return leftInteger < rightInteger ? -1 : 1;
  }

  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeftFraction = leftFraction.padEnd(fractionLength, "0");
  const normalizedRightFraction = rightFraction.padEnd(fractionLength, "0");
  return normalizedLeftFraction < normalizedRightFraction
    ? -1
    : normalizedLeftFraction > normalizedRightFraction
      ? 1
      : 0;
}

export const sourceProviderSchema = z.enum([
  "coinbase",
  "coinbase-derivatives",
  "binance",
  "kucoin",
  "okx",
  "hyperliquid",
  "bitquery",
  "jupiter",
  "zeroex",
  "solana-rpc",
  "managed-solana-stream"
]);

export const venueSchema = z.enum([
  "coinbase",
  "coinbase-derivatives",
  "binance",
  "kucoin",
  "okx",
  "hyperliquid",
  "solana-dex"
]);

export const segmentSchema = z.enum(["spot", "perp", "dex-spot"]);
export const eventKindSchema = z.enum([
  "bbo",
  "book-delta",
  "trade",
  "mark",
  "funding",
  "open-interest",
  "dex-quote",
  "onchain-swap",
  "route-change",
  "source-health"
]);

const streamCursorSchema = z.object({
  first: z.string().optional(),
  last: z.string().optional(),
  previous: z.string().optional(),
  snapshot: z.boolean().optional(),
  connectionGeneration: z.number().int().nonnegative()
});

const qualitySchema = z.object({
  state: z.enum(["fresh", "degraded", "stale", "gap"]),
  latencyMs: z.number().nonnegative().finite().optional(),
  outOfOrder: z.boolean(),
  replay: z.boolean()
});

const baseEventShape = {
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  ingestSeq: nonNegativeIntegerString,
  source: z.object({
    provider: sourceProviderSchema,
    channel: z.string().min(1),
    connectionGeneration: z.number().int().nonnegative()
  }),
  venue: venueSchema,
  protocol: z.string().min(1).optional(),
  segment: segmentSchema,
  instrumentId: z.string().min(1),
  base: z.literal("SOL"),
  quote: z.enum(["USDT", "USDC", "USD"]),
  occurredAtMs: timestampMs,
  timeOrigin: z.enum(["venue", "block", "receive-fallback"]),
  sourceEventTimeRaw: z.string().min(1).optional(),
  sourceEventTimeUnit: z.enum(["ms", "us", "ns"]).optional(),
  receivedAtUnixMs: timestampMs,
  receivedMonoNs: nonNegativeIntegerString,
  cursor: streamCursorSchema.optional(),
  quality: qualitySchema
} as const;

const priceLevelSchema = z.object({
  px: nonNegativeDecimalString,
  sizeNative: nonNegativeDecimalString,
  sizeSOL: nonNegativeDecimalString
});

const routeStepSchema = z.object({
  source: z.string().min(1),
  programId: z.string().min(1).optional(),
  poolAddress: z.string().min(1).optional(),
  tokenIn: z.string().min(1).optional(),
  tokenOut: z.string().min(1).optional(),
  amountInAtomic: nonNegativeIntegerString.optional(),
  amountOutAtomic: nonNegativeIntegerString.optional(),
  share: z
    .object({
      value: nonNegativeIntegerString,
      unit: z.enum(["bps-of-input", "ppb-of-remaining"])
    })
    .optional()
});

const bboPayloadSchema = z
  .object({
    bidPx: nonNegativeDecimalString,
    bidSizeNative: nonNegativeDecimalString,
    bidSizeSOL: nonNegativeDecimalString,
    askPx: nonNegativeDecimalString,
    askSizeNative: nonNegativeDecimalString,
    askSizeSOL: nonNegativeDecimalString
  })
  .refine(({ bidPx, askPx }) => compareNonNegativeDecimals(bidPx, askPx) <= 0, {
    message: "bidPx must not exceed askPx"
  });

const payloadSchemas = {
  bbo: bboPayloadSchema,
  "book-delta": z.object({
    bids: z.array(priceLevelSchema),
    asks: z.array(priceLevelSchema)
  }),
  trade: z.object({
    px: nonNegativeDecimalString,
    sizeNative: nonNegativeDecimalString,
    sizeSOL: nonNegativeDecimalString,
    aggressor: z.enum(["buy", "sell", "unknown"]),
    tradeId: z.string().min(1).optional()
  }),
  mark: z.object({
    markPx: nonNegativeDecimalString,
    indexPx: nonNegativeDecimalString.optional(),
    oraclePx: nonNegativeDecimalString.optional()
  }),
  funding: z.object({
    fundingRate: decimalString,
    fundingIntervalMs: z.number().int().positive(),
    nextFundingTs: timestampMs.optional(),
    semantics: z.enum(["predicted", "realized"])
  }),
  "open-interest": z.object({
    oiNative: nonNegativeDecimalString,
    oiSOL: nonNegativeDecimalString,
    oiQuote: nonNegativeDecimalString.optional(),
    contractValueSOL: nonNegativeDecimalString.optional()
  }),
  "dex-quote": z.object({
    quoteProvider: z.enum(["jupiter", "zeroex"]),
    requestId: z.string().min(1),
    requestedAtUnixMs: timestampMs,
    tokenIn: z.string().min(1),
    tokenOut: z.string().min(1),
    amountInAtomic: nonNegativeIntegerString,
    amountOutAtomic: nonNegativeIntegerString,
    minAmountOutAtomic: nonNegativeIntegerString.optional(),
    slippageBps: z.number().int().nonnegative(),
    side: z.enum(["buy-sol", "sell-sol"]),
    targetNotionalQuote: nonNegativeDecimalString.optional(),
    sellNotionalAnchorPx: nonNegativeDecimalString.optional(),
    sellNotionalAnchorTs: timestampMs.optional(),
    effectivePxQuotePerSol: nonNegativeDecimalString,
    priceImpactBps: decimalString.optional(),
    priceImpactSource: z.enum(["provider", "derived"]).optional(),
    route: z.array(routeStepSchema),
    quoteLatencyMs: z.number().nonnegative().finite(),
    zid: z.string().min(1).optional()
  }),
  "onchain-swap": z.object({
    cluster: z.literal("mainnet-beta"),
    signature: z.string().min(1),
    slot: nonNegativeIntegerString,
    transactionIndex: z.number().int().nonnegative().optional(),
    economicSwapIndex: z.number().int().nonnegative(),
    commitment: z.enum(["processed", "confirmed", "finalized", "provider-indexed"]),
    finalitySource: z.enum(["rpc", "provider"]),
    protocol: z.string().min(1),
    poolAddresses: z.array(z.string().min(1)),
    aggregator: z.string().min(1).optional(),
    inputMint: z.string().min(1),
    outputMint: z.string().min(1),
    amountInAtomic: nonNegativeIntegerString,
    amountOutAtomic: nonNegativeIntegerString,
    side: z.enum(["buy-sol", "sell-sol"]),
    effectivePxQuotePerSol: nonNegativeDecimalString,
    routeLegs: z
      .array(
        z.object({
          protocol: z.string().min(1),
          poolAddress: z.string().min(1).optional(),
          inputMint: z.string().min(1),
          outputMint: z.string().min(1),
          amountInAtomic: nonNegativeIntegerString.optional(),
          amountOutAtomic: nonNegativeIntegerString.optional()
        })
      )
      .optional(),
    blockTimeMs: timestampMs.optional(),
    parserVersion: z.string().min(1),
    parseQuality: z.object({
      protocolDecoded: z.boolean(),
      tokenBalancesReconciled: z.boolean(),
      providerParsed: z.boolean().optional(),
      nativeSolAccounting: z.enum(["not-applicable", "verified-wrap-flow"])
    }),
    coverageGroup: z.string().min(1)
  }),
  "route-change": z.object({
    previousRouteHash: z.string().min(1).optional(),
    routeHash: z.string().min(1),
    route: z.array(routeStepSchema)
  }),
  "source-health": z.object({
    connection: z.enum(["connecting", "live", "reconnecting", "closed"]),
    transportLastSeenAtMs: timestampMs.optional(),
    stateLastChangedAtMs: timestampMs.optional(),
    gapReason: z.string().min(1).optional()
  })
} as const;

function eventSchema<K extends keyof typeof payloadSchemas>(kind: K) {
  return z.object({
    ...baseEventShape,
    kind: z.literal(kind),
    payload: payloadSchemas[kind]
  });
}

export const marketEventSchema = z.discriminatedUnion("kind", [
  eventSchema("bbo"),
  eventSchema("book-delta"),
  eventSchema("trade"),
  eventSchema("mark"),
  eventSchema("funding"),
  eventSchema("open-interest"),
  eventSchema("dex-quote"),
  eventSchema("onchain-swap"),
  eventSchema("route-change"),
  eventSchema("source-health")
]);

export const uiEventSchema = z.object({
  eventId: z.string().min(1),
  streamSeq: nonNegativeIntegerString,
  stateVersion: z.string().min(1),
  sourceProvider: sourceProviderSchema,
  instrumentId: z.string().min(1),
  quoteAsset: z.enum(["USDT", "USDC", "USD"]),
  zone: z.enum(["cex-spot", "cex-perps", "dex-spot", "defi-perps"]),
  venueLabel: z.string().min(1),
  kind: z.union([eventKindSchema, z.literal("signal-changed")]),
  changeDirection: z.enum(["up", "down", "flat", "unknown"]),
  tradeSide: z.enum(["buy", "sell", "unknown"]).optional(),
  signalPolarity: z.enum(["bullish", "bearish", "neutral", "not-applicable"]).optional(),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  count: z.number().int().positive(),
  batchStartMs: timestampMs,
  batchEndMs: timestampMs,
  buyCount: z.number().int().nonnegative().optional(),
  sellCount: z.number().int().nonnegative().optional(),
  buyNotional: nonNegativeDecimalString.optional(),
  sellNotional: nonNegativeDecimalString.optional(),
  maxNotional: nonNegativeDecimalString.optional(),
  minPx: nonNegativeDecimalString.optional(),
  maxPx: nonNegativeDecimalString.optional(),
  label: z.string().min(1),
  quality: z.enum(["fresh", "degraded", "stale", "gap"])
});

export type SourceProvider = z.infer<typeof sourceProviderSchema>;
export type Venue = z.infer<typeof venueSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type EventKind = z.infer<typeof eventKindSchema>;
export type MarketEvent = z.infer<typeof marketEventSchema>;
export type UiEvent = z.infer<typeof uiEventSchema>;

export function parseMarketEvent(input: unknown): MarketEvent {
  return marketEventSchema.parse(input);
}

export function parseUiEvent(input: unknown): UiEvent {
  return uiEventSchema.parse(input);
}
