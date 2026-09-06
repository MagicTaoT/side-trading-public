import { hostname, platform, release } from "node:os";
import type {
  HttpProbeDefinition,
  PreflightReport,
  ProbeResult,
  ProbeRunOptions,
  ValidationResult
} from "./contracts.js";
import { ENDPOINTS, PREFLIGHT_MANIFEST_VERSION, SECRET_ENV_NAMES, USDC_MINT, WSOL_MINT } from "./manifest.js";
import { blockedProbe, runHttpProbe, runWebSocketProbe, type WebSocketSession } from "./probes.js";
import { selectCexProfile } from "./select.js";

export interface PreflightOptions {
  requestedRegion: string;
  samples: number;
  timeoutMs: number;
  includeJupiter: boolean;
  environment?: NodeJS.ProcessEnv;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function coinbaseSpotValidation(value: unknown, status: number): ValidationResult {
  const product = object(value);
  const productId = string(product?.product_id);
  const disabled = product?.trading_disabled === true || product?.is_disabled === true;
  return {
    pass: status === 200 && productId === "SOL-USD" && !disabled,
    entitlement: "public",
    metadata: { productId: productId ?? "not-found", tradingDisabled: disabled },
    reasons: productId !== "SOL-USD" ? ["coinbase_sol_usd_not_found"] : disabled ? ["coinbase_sol_usd_disabled"] : []
  };
}

function coinbasePerpValidation(value: unknown, status: number): ValidationResult {
  const products = objects(object(value)?.products);
  const candidates = products
    .map((product) => string(product.product_id))
    .filter((id): id is string => id !== null && (/SLP/iu.test(id) || /SOL.*PERP/iu.test(id)))
    .slice(0, 20);
  const target = candidates.find((id) => /^SLP(?:-|$)/iu.test(id) && !/INTX/iu.test(id));
  return {
    pass: status === 200 && target !== undefined,
    entitlement: "public",
    metadata: { targetProductId: target ?? "not-found", observedProductIds: candidates },
    reasons: target ? [] : ["coinbase_cde_slp_not_discovered_publicly", "coinbase_intx_substitute_forbidden"]
  };
}

function binanceSymbolValidation(value: unknown, status: number, market: "spot" | "perp"): ValidationResult {
  const symbols = objects(object(value)?.symbols);
  const sol = symbols.find((candidate) => candidate.symbol === "SOLUSDT");
  const state = string(sol?.status);
  return {
    pass: status === 200 && sol !== undefined && state === "TRADING",
    entitlement: "public",
    metadata: { productId: string(sol?.symbol) ?? "not-found", market, tradingStatus: state ?? "unknown" },
    reasons: sol ? (state === "TRADING" ? [] : [`binance_${market}_not_trading`]) : [`binance_${market}_solusdt_not_found`]
  };
}

function hyperliquidValidation(value: unknown, status: number): ValidationResult {
  const tuple = Array.isArray(value) ? value : [];
  const universe = objects(object(tuple[0])?.universe);
  const solIndex = universe.findIndex((candidate) => candidate.name === "SOL");
  return {
    pass: status === 200 && solIndex >= 0,
    entitlement: "public",
    metadata: { instrument: solIndex >= 0 ? "SOL" : "not-found", assetIndex: solIndex },
    reasons: solIndex >= 0 ? [] : ["hyperliquid_sol_not_found"]
  };
}

function zeroexValidation(value: unknown, status: number): ValidationResult {
  const response = object(value);
  const amountOut = response?.amount_out;
  const route = response?.route_plan;
  const valid = (typeof amountOut === "string" || typeof amountOut === "number") && Array.isArray(route);
  return {
    pass: status === 200 && valid,
    entitlement: status === 401 || status === 403 ? "credential-missing" : "credential-present",
    metadata: {
      pair: "USDC-SOL",
      responseShape: valid ? "amount_out+route_plan" : "unexpected",
      routeLegCount: Array.isArray(route) ? route.length : 0
    },
    reasons: valid ? [] : ["zeroex_response_contract_not_met"]
  };
}

function jupiterValidation(value: unknown, status: number): ValidationResult {
  const response = object(value);
  const valid = typeof response?.outAmount === "string" && Array.isArray(response.routePlan);
  return {
    pass: status === 200 && valid,
    entitlement: status === 401 || status === 403 ? "credential-missing" : "credential-present",
    metadata: { pair: "USDC-SOL", responseShape: valid ? "outAmount+routePlan" : "unexpected" },
    reasons: valid ? [] : ["jupiter_response_contract_not_met"]
  };
}

function coinbaseSession(productId: string): WebSocketSession {
  return {
    onOpen: (send) => {
      send(JSON.stringify({ type: "subscribe", product_ids: [productId], channel: "ticker" }));
      send(JSON.stringify({ type: "subscribe", product_ids: [productId], channel: "heartbeats" }));
    },
    onMessage: (value) => {
      const message = object(value);
      if (message?.type === "error") return { pass: false, reasons: ["coinbase_ws_subscription_error"] };
      if (message?.channel !== "ticker") return null;
      const events = objects(message.events);
      const products = events.flatMap((event) => objects(event.tickers)).map((ticker) => string(ticker.product_id));
      return products.includes(productId)
        ? { pass: true, entitlement: "public", metadata: { productId, channel: "ticker" } }
        : null;
    }
  };
}

function directSymbolSession(expectedSymbol: string, channel: string): WebSocketSession {
  return {
    onOpen: () => undefined,
    onMessage: (value) => {
      const message = object(value);
      return message?.s === expectedSymbol
        ? { pass: true, entitlement: "public", metadata: { productId: expectedSymbol, channel } }
        : null;
    }
  };
}

function hyperliquidSession(): WebSocketSession {
  return {
    onOpen: (send) => send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: "SOL" } })),
    onMessage: (value) => {
      const message = object(value);
      return message?.channel === "subscriptionResponse" || message?.channel === "l2Book"
        ? { pass: true, entitlement: "public", metadata: { instrument: "SOL", channel: "l2Book" } }
        : null;
    }
  };
}

const BITQUERY_SUBSCRIPTION = `subscription SidePreflight {
  Solana {
    DEXTradeByTokens(where: {Transaction: {Result: {Success: true}}, Trade: {Currency: {MintAddress: {is: "${WSOL_MINT}"}}, Side: {Currency: {MintAddress: {is: "${USDC_MINT}"}}}}}) {
      Block { Time Slot }
      Transaction { Signature Result { Success } }
      Trade { Market { MarketAddress } Dex { ProtocolName } Price Amount Side { Type Amount Currency { MintAddress Symbol } } }
    }
  }
}`;

function bitquerySession(): WebSocketSession {
  let acknowledged = false;
  return {
    onOpen: (send) => send(JSON.stringify({ type: "connection_init" })),
    onMessage: (value, send) => {
      const message = object(value);
      if (message?.type === "connection_ack") {
        acknowledged = true;
        send(JSON.stringify({ id: "side-preflight", type: "subscribe", payload: { query: BITQUERY_SUBSCRIPTION } }));
        return null;
      }
      if (message?.type === "error") return { pass: false, entitlement: "credential-present", reasons: ["bitquery_subscription_rejected"] };
      if (acknowledged && message?.type === "next") {
        return {
          pass: true,
          entitlement: "credential-present",
          metadata: { pair: "WSOL-USDC", protocol: "graphql-transport-ws", subscriptionEvidence: "next" }
        };
      }
      return null;
    }
  };
}

function httpDefinitions(environment: NodeJS.ProcessEnv): HttpProbeDefinition[] {
  const definitions: HttpProbeDefinition[] = [
    {
      id: "coinbase.spot.metadata",
      source: "coinbase",
      label: "Coinbase SOL-USD public metadata",
      url: ENDPOINTS.coinbasePublicProduct,
      headers: { "cache-control": "no-cache" },
      validate: coinbaseSpotValidation
    },
    {
      id: "coinbase.perp.metadata",
      source: "coinbase-derivatives",
      label: "Coinbase CDE SLP public discovery",
      url: ENDPOINTS.coinbasePublicProducts,
      headers: { "cache-control": "no-cache" },
      validate: coinbasePerpValidation
    },
    {
      id: "binance.spot.metadata",
      source: "binance",
      label: "Binance spot SOLUSDT exchangeInfo",
      url: ENDPOINTS.binanceSpotExchangeInfo,
      validate: (value, status) => binanceSymbolValidation(value, status, "spot")
    },
    {
      id: "binance.perp.metadata",
      source: "binance",
      label: "Binance USD-M SOLUSDT exchangeInfo",
      url: ENDPOINTS.binancePerpExchangeInfo,
      validate: (value, status) => binanceSymbolValidation(value, status, "perp")
    },
    {
      id: "hyperliquid.metadata",
      source: "hyperliquid",
      label: "Hyperliquid SOL perp metadata",
      url: ENDPOINTS.hyperliquidInfo,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      validate: hyperliquidValidation
    }
  ];
  const zeroexKey = environment.ZEROEX_API_KEY;
  if (zeroexKey) {
    definitions.push({
      id: "zeroex.swap-instructions",
      source: "zeroex",
      label: "0x Solana swap-instructions response contract",
      url: ENDPOINTS.zeroexSwapInstructions,
      method: "POST",
      headers: { "content-type": "application/json", "0x-api-key": zeroexKey, "0x-version": "v2" },
      delayBetweenAttemptsMs: 1_100,
      body: JSON.stringify({
        amount_in: 10_000_000_000,
        taker: "ZeroEx1111111111111111111111111111111111111",
        token_in: USDC_MINT,
        token_out: WSOL_MINT,
        slippage_bps: 50
      }),
      validate: zeroexValidation
    });
  }
  return definitions;
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const environment = options.environment ?? process.env;
  const secrets = SECRET_ENV_NAMES.map((name) => environment[name]).filter((value): value is string => Boolean(value));
  const runOptions: ProbeRunOptions = { attempts: options.samples, timeoutMs: options.timeoutMs, secrets };
  const httpResults = await Promise.all(httpDefinitions(environment).map((definition) => runHttpProbe(definition, runOptions)));
  const coinbasePerp = httpResults.find(({ id }) => id === "coinbase.perp.metadata");
  const targetProductId = coinbasePerp?.metadata.targetProductId;
  const wsDefinitions = [
    {
      id: "coinbase.spot.ws",
      source: "coinbase",
      label: "Coinbase SOL-USD ticker WebSocket",
      url: ENDPOINTS.coinbaseMarketWs,
      createSession: () => coinbaseSession("SOL-USD")
    },
    {
      id: "binance.spot.ws",
      source: "binance",
      label: "Binance spot SOLUSDT bookTicker WebSocket",
      url: ENDPOINTS.binanceSpotWs,
      createSession: () => directSymbolSession("SOLUSDT", "bookTicker")
    },
    {
      id: "binance.perp.ws",
      source: "binance",
      label: "Binance USD-M SOLUSDT bookTicker WebSocket",
      url: ENDPOINTS.binancePerpWs,
      createSession: () => directSymbolSession("SOLUSDT", "bookTicker")
    },
    {
      id: "hyperliquid.ws",
      source: "hyperliquid",
      label: "Hyperliquid SOL l2Book WebSocket",
      url: ENDPOINTS.hyperliquidWs,
      createSession: hyperliquidSession
    }
  ];
  const wsResults = await Promise.all(wsDefinitions.map((definition) => runWebSocketProbe(definition, runOptions)));
  const probes: ProbeResult[] = [...httpResults, ...wsResults];

  if (typeof targetProductId === "string" && targetProductId !== "not-found" && coinbasePerp?.status === "pass") {
    probes.push(
      await runWebSocketProbe(
        {
          id: "coinbase.perp.ws",
          source: "coinbase-derivatives",
          label: "Coinbase CDE SLP public ticker WebSocket",
          url: ENDPOINTS.coinbaseMarketWs,
          createSession: () => coinbaseSession(targetProductId)
        },
        runOptions
      )
    );
  } else {
    probes.push(blockedProbe("coinbase.perp.ws", "coinbase-derivatives", "Coinbase CDE SLP public ticker WebSocket", "websocket", ENDPOINTS.coinbaseMarketWs, "metadata_gate_failed:slp_not_discovered", "public"));
  }

  const bitqueryToken = environment.BITQUERY_TOKEN;
  if (bitqueryToken) {
    probes.push(
      await runWebSocketProbe(
        {
          id: "bitquery.wsol-usdc.ws",
          source: "bitquery",
          label: "Bitquery decoded WSOL/USDC subscription",
          url: ENDPOINTS.bitqueryWs,
          protocols: ["graphql-transport-ws"],
          headers: { authorization: `Bearer ${bitqueryToken}` },
          createSession: bitquerySession
        },
        runOptions
      )
    );
  } else {
    probes.push(blockedProbe("bitquery.wsol-usdc.ws", "bitquery", "Bitquery decoded WSOL/USDC subscription", "credential", ENDPOINTS.bitqueryWs, "credential_missing:BITQUERY_TOKEN", "credential-missing"));
  }

  if (!environment.ZEROEX_API_KEY) {
    probes.push(blockedProbe("zeroex.swap-instructions", "zeroex", "0x Solana swap-instructions response contract", "credential", ENDPOINTS.zeroexSwapInstructions, "credential_missing:ZEROEX_API_KEY", "credential-missing"));
  }

  if (!options.includeJupiter) {
    probes.push(blockedProbe("jupiter.quote", "jupiter", "Jupiter explicit fallback quote", "credential", ENDPOINTS.jupiterQuote, "skipped:explicit_fallback_not_requested", "not-applicable"));
  } else if (!environment.JUPITER_API_KEY) {
    probes.push(blockedProbe("jupiter.quote", "jupiter", "Jupiter explicit fallback quote", "credential", ENDPOINTS.jupiterQuote, "credential_missing:JUPITER_API_KEY", "credential-missing"));
  } else {
    probes.push(
      await runHttpProbe(
        {
          id: "jupiter.quote",
          source: "jupiter",
          label: "Jupiter explicit fallback quote",
          url: ENDPOINTS.jupiterQuote,
          headers: { "x-api-key": environment.JUPITER_API_KEY },
          delayBetweenAttemptsMs: 1_100,
          validate: jupiterValidation
        },
        runOptions
      )
    );
  }

  probes.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    manifestVersion: PREFLIGHT_MANIFEST_VERSION,
    target: {
      requestedRegion: options.requestedRegion,
      hostname: hostname(),
      platform: `${platform()} ${release()}`,
      nodeVersion: process.version,
      executedAt: new Date().toISOString()
    },
    profile: selectCexProfile(probes),
    probes,
    secretPolicy: { valuesPersisted: false, environmentVariablesChecked: [...SECRET_ENV_NAMES] }
  };
}
