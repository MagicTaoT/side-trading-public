export const PREFLIGHT_MANIFEST_VERSION = "s0-preflight-v1" as const;

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const ENDPOINTS = Object.freeze({
  coinbasePublicProduct: "https://api.coinbase.com/api/v3/brokerage/market/products/SOL-USD",
  coinbasePublicProducts: "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&limit=1000",
  coinbaseMarketWs: "wss://advanced-trade-ws.coinbase.com",
  binanceSpotExchangeInfo: "https://api.binance.com/api/v3/exchangeInfo?symbol=SOLUSDT",
  binanceSpotWs: "wss://stream.binance.com:9443/ws/solusdt@bookTicker",
  binancePerpExchangeInfo: "https://fapi.binance.com/fapi/v1/exchangeInfo",
  binancePerpWs: "wss://fstream.binance.com/ws/solusdt@bookTicker",
  hyperliquidInfo: "https://api.hyperliquid.xyz/info",
  hyperliquidWs: "wss://api.hyperliquid.xyz/ws",
  bitqueryWs: "wss://streaming.bitquery.io/graphql",
  zeroexSwapInstructions: "https://api.0x.org/solana/swap-instructions",
  jupiterQuote: `https://api.jup.ag/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${WSOL_MINT}&amount=10000000000&slippageBps=50&restrictIntermediateTokens=true`
});

export const REQUIRED_PROBES = Object.freeze({
  coinbase: ["coinbase.spot.metadata", "coinbase.spot.ws", "coinbase.perp.metadata", "coinbase.perp.ws"],
  binance: ["binance.spot.metadata", "binance.spot.ws", "binance.perp.metadata", "binance.perp.ws"]
});

export const SECRET_ENV_NAMES = ["BITQUERY_TOKEN", "ZEROEX_API_KEY", "JUPITER_API_KEY"] as const;
