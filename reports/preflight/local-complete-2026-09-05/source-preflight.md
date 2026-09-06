# SIDE S0 Source Preflight

- Manifest: `s0-preflight-v1`
- Executed: `2026-09-06T05:11:47.642Z`
- Host: `development-host`
- Requested region: `local-development`
- Runtime: `darwin 23.1.0 · v26.0.0`
- Selected profile: `S0_CEX_PROFILE=coinbase`
- Secrets persisted: `false`

## Atomic CEX decision

| Candidate | Complete | Failed required probes |
|---|---:|---|
| coinbase | yes | — |
| binance | no | binance.spot.metadata, binance.spot.ws, binance.perp.metadata |

Coinbase and Binance are evaluated as whole spot+perp profiles. A half-profile is never emitted.

## Probe results

| Probe | Transport | Status | HTTP | 429 | p50 ms | p95 ms | Product / instrument | Entitlement | Reason |
|---|---|---|---|---:|---:|---:|---|---|---|
| binance.perp.metadata | http | fail | 451×3 | no | 30.09 | 175.51 | — | public | region_restricted_http_451 |
| binance.perp.ws | websocket | pass | — | no | 485.51 | 486.03 | SOLUSDT | public | — |
| binance.spot.metadata | http | fail | 451×3 | no | 17.72 | 127.32 | — | public | region_restricted_http_451 |
| binance.spot.ws | websocket | fail | 451×3 | no | 398.62 | 403.63 | — | unknown | ws_upgrade_http_451 |
| bitquery.wsol-usdc.ws | websocket | pass | — | no | 1023.16 | 1217.63 | — | credential-present | — |
| coinbase.perp.metadata | http | pass | 200×3 | no | 48.89 | 287.27 | SLP-20DEC30-CDE | public | — |
| coinbase.perp.ws | websocket | pass | — | no | 429.18 | 462.45 | SLP-20DEC30-CDE | public | — |
| coinbase.spot.metadata | http | pass | 200×3 | no | 265.72 | 281.69 | SOL-USD | public | — |
| coinbase.spot.ws | websocket | pass | — | no | 453.07 | 479.62 | SOL-USD | public | — |
| hyperliquid.metadata | http | pass | 200×3 | no | 337.64 | 454.99 | SOL | public | — |
| hyperliquid.ws | websocket | pass | — | no | 393.49 | 408.18 | SOL | public | — |
| jupiter.quote | http | fail | 401×3 | no | 57.09 | 159.87 | — | credential-missing | entitlement_http_401 |
| zeroex.swap-instructions | http | pass | 200×3 | no | 184.54 | 524.15 | — | credential-present | — |

## Endpoints

- `binance.perp.metadata`: https://fapi.binance.com/fapi/v1/exchangeInfo
- `binance.perp.ws`: wss://fstream.binance.com/ws/solusdt@bookTicker
- `binance.spot.metadata`: https://api.binance.com/api/v3/exchangeInfo?symbol=SOLUSDT
- `binance.spot.ws`: wss://stream.binance.com:9443/ws/solusdt@bookTicker
- `bitquery.wsol-usdc.ws`: wss://streaming.bitquery.io/graphql
- `coinbase.perp.metadata`: https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&limit=1000
- `coinbase.perp.ws`: wss://advanced-trade-ws.coinbase.com/
- `coinbase.spot.metadata`: https://api.coinbase.com/api/v3/brokerage/market/products/SOL-USD
- `coinbase.spot.ws`: wss://advanced-trade-ws.coinbase.com/
- `hyperliquid.metadata`: https://api.hyperliquid.xyz/info
- `hyperliquid.ws`: wss://api.hyperliquid.xyz/ws
- `jupiter.quote`: https://api.jup.ag/swap/v1/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=10000000000&slippageBps=50&restrictIntermediateTokens=true
- `zeroex.swap-instructions`: https://api.0x.org/solana/swap-instructions

## Credential gates

- `BITQUERY_TOKEN`: checked by name only; value never persisted
- `ZEROEX_API_KEY`: checked by name only; value never persisted
- `JUPITER_API_KEY`: checked by name only; value never persisted
