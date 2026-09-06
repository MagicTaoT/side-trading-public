# SIDE S0 Source Preflight

- Manifest: `s0-preflight-v1`
- Executed: `2026-09-06T05:07:18.224Z`
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
| binance.perp.metadata | http | fail | 451×3 | no | 18.99 | 124.24 | not-found | public | binance_perp_solusdt_not_found; region_restricted_http_451 |
| binance.perp.ws | websocket | pass | — | no | 511.85 | 564.55 | SOLUSDT | public | — |
| binance.spot.metadata | http | fail | 451×3 | no | 18.42 | 88.98 | not-found | public | binance_spot_solusdt_not_found; region_restricted_http_451 |
| binance.spot.ws | websocket | fail | 451×3 | no | 397.20 | 424.27 | — | unknown | ws_upgrade_http_451 |
| bitquery.wsol-usdc.ws | websocket | pass | — | no | 984.25 | 1064.65 | — | credential-present | — |
| coinbase.perp.metadata | http | pass | 200×3 | no | 29.34 | 206.68 | SLP-20DEC30-CDE | public | — |
| coinbase.perp.ws | websocket | pass | — | no | 455.10 | 477.15 | SLP-20DEC30-CDE | public | — |
| coinbase.spot.metadata | http | pass | 200×3 | no | 27.69 | 249.51 | SOL-USD | public | — |
| coinbase.spot.ws | websocket | pass | — | no | 447.50 | 479.58 | SOL-USD | public | — |
| hyperliquid.metadata | http | pass | 200×3 | no | 164.08 | 237.72 | SOL | public | — |
| hyperliquid.ws | websocket | pass | — | no | 407.14 | 412.90 | SOL | public | — |
| jupiter.quote | credential | skipped | — | no | — | — | — | not-applicable | skipped:explicit_fallback_not_requested |
| zeroex.swap-instructions | http | fail | 200×2, 429×1 | yes | 334.13 | 414.25 | — | credential-present | http_429_rate_limited; zeroex_response_contract_not_met |

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
