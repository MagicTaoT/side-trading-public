# SIDE-001 - S0 Source and Execution Freeze

状态：**SCOPE COMPLETE · FROZEN v1**
日期：2026-09-04
适用 profile：`s0-paper`

## 1. 冻结结论

S0 将市场证据源与执行报价源分开：

| 能力 | Primary | Fallback | 禁止行为 |
|---|---|---|---|
| CEX spot + perp | Coinbase 原子 profile：Coinbase `SOL-USD` spot + Coinbase Derivatives nano Solana Perp `SLP` | Binance 原子 profile：`SOLUSDT` spot + USDⓈ-M `SOLUSDT` perp | 不把 Coinbase spot 与 Binance perp 静默拼成默认 profile |
| DeFi perp | Hyperliquid HyperCore `SOL` perpetual | 明确标记的 golden replay | 不静默换 venue |
| DEX realized flow | Bitquery WSOL/USDC decoded DEX trade stream | 明确标记的 golden replay / unavailable | 不声称覆盖 Solana 全市场；不把 route legs 重复计为经济成交 |
| Paper executable estimate | 0x Solana `swap-instructions` | 0x 失败后，由用户明确触发 Jupiter estimate | 不使用旧报价，不静默 fallback，不称为 firm quote |
| Live execution | 不存在 | 不存在 | 不组装、签名、模拟或广播交易 |

固定产品上下文仍为：SOL only、5 minute window、SOL-USDC、默认 10,000 USDC paper notional。

## 2. CEX profile 选择门

### Coinbase primary profile

Coinbase profile 只有在目标美国 AWS region 同时满足以下条件时才能启用：

1. `SOL-USD` metadata 为 online；公开 WebSocket 的 `status`、`heartbeats`、`level2` 与 `market_trades` 可持续接收；
2. 启动时能够发现 Coinbase Derivatives `SLP` 的实际 product identifier；
3. 无需 CDE participant entitlement 或 trade-enabled credential，即可取得 `SLP` 的 BBO 与逐笔/源端聚合成交；
4. 固化并验证 `contractMultiplier = 5 SOL`、交易时段、funding 语义与维护窗口；
5. 30 分钟 soak 中 reconnect、sequence/gap、时间戳与 p50/p95 receive latency 验收通过。

Coinbase International `SOL-PERP` 不作为 S0 primary：INTX WebSocket 首次订阅需要认证，产品面向符合条件的非美国用户，且 2026-09-09 计划迁移到 Deribit-powered API/market-data gateway。S0 不在这次迁移窗口上建立硬依赖。

参考：

- [Coinbase Advanced Trade public WebSocket](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/websocket)
- [Coinbase Derivatives SLP contract specifications](https://help.coinbase.com/en/derivatives/perpetual-style-futures/contract-specifications)
- [Coinbase Derivatives market access](https://help.coinbase.com/en/derivatives/perpetual-style-futures/market-access)
- [Coinbase INTX WebSocket authentication](https://docs.cdp.coinbase.com/international-exchange/websocket-feed/authentication)
- [Coinbase INTX / Deribit migration](https://help.coinbase.com/en/international-exchange/deribit/coinbase-faqs)

### Binance fallback profile

Coinbase spot 或 perp 任一选择门失败，整个 CEX profile 原子回退到 Binance spot + perp。Binance fallback 仍需在同一 AWS region 验证 REST metadata、spot WebSocket、USDⓈ-M WebSocket、429/地区限制与 reconnect。

若 Coinbase profile 与 Binance profile 都失败：CEX spot/perp jury 为 unavailable，LIVE S0 不算验收通过；只允许显式进入 REPLAY，不得用 replay 冒充 live 完成。

## 3. Bitquery DEX flow contract

S0 使用 Bitquery 美国区域 GraphQL WebSocket 订阅 WSOL/USDC 两个方向的已实现 DEX swap。至少请求：

```text
Block.Time / Block.Slot
Transaction.Signature / Transaction.Index / Transaction.Result.Success
Trade.Index
Trade.Dex.ProtocolFamily / ProtocolName / ProgramAddress
Trade.Market.MarketAddress
Trade.Buy.Currency.MintAddress / Amount
Trade.Sell.Currency.MintAddress / Amount
```

标准化规则：

- stable → SOL = aggressor buy SOL；SOL → stable = aggressor sell SOL；
- 使用原始 token amounts 计算 `effectivePxQuotePerSol`，不依赖不透明的 USD enrichment；
- 同一 signature 的 route legs 按 `Trade.Index` 排序，取首个输入与最终输出，合并为一个 economic swap；
- logical key 为 `(cluster, signature, economicSwapIndex)`；协议 leg 保留在 `routeLegs`；
- Bitquery provider-indexed 状态不伪装成 RPC `confirmed`/`finalized`；保存 `commitment = provider-indexed` 与 coverage label；
- GraphQL WebSocket 是 at-most-once、无 replay 且 block 数据可能分批/乱序到达。reconnect 后必须先 buffer live，再用历史 GraphQL query 从 checkpoint 回补并去重；
- UI 文案使用 `BITQUERY-DECODED SOLANA DEX FLOW`，不能使用 `ALL SOLANA DEX FLOW`；
- RFQ/off-chain quoted fills 与未被 Bitquery decoder 覆盖的协议是已知 coverage gap。

选择门：在美国区域 endpoint 连续运行至少 30 分钟，记录 receive latency、重复率、无法解析率、多腿交易比例、silent disconnect/reconnect 行为，并保存脱敏 fixture 和 coverage manifest。

参考：

- [Bitquery Solana DEX Trades](https://docs.bitquery.io/docs/blockchain/Solana/solana-dextrades/)
- [Bitquery streaming characteristics](https://docs.bitquery.io/docs/streams/)
- [Bitquery endpoints and regions](https://docs.bitquery.io/docs/start/endpoints/)

## 4. S0 DEX jury

S0 的 DEX spot jury 不再依赖连续 Jupiter quote。它使用 Bitquery economic swaps 的 30 秒 price impulse 与 aggressor flow imbalance：

```text
dexPriceImpulse30s = (robustPriceNow / robustPrice30sAgo - 1) * 10,000
dexFlowImbalance30s = (buyNotional - sellNotional) / totalNotional
```

只有两个 feature 同向、minimum volume 满足且 Bitquery transport/backfill 没有未修复 gap 时才投 BUY/SELL；否则为 NEUTRAL 或 unavailable。Bitquery event 生成 DEX bubble；0x/Jupiter estimate 只更新 paper drawer，不生成成交 bubble。

## 5. Paper quote policy

- BUY：0x ExactIn，输入固定 10,000 USDC；
- SELL：先用同一 provider 获取 fresh 10,000 USDC → SOL anchor estimate，再以得到的 SOL 数量请求 ExactIn SOL → USDC；两个 request id、时间与 source 一起固化；
- 0x 失败时先显示 unavailable；只有用户点击 `TRY JUPITER ESTIMATE` 才以同一双请求口径重新报价；
- record 时服务端复核 provider、pair、amount、source health 与 SIDE 本地 2 秒 TTL；
- 0x 与 Jupiter 都失败时禁止 record order；
- `amountOut`/`minAmountOut` 是 estimate，不是锁价或成交保证；0x 未提供的 price impact/fee breakdown 保持 `not-supplied`。

## 6. SIDE-001 范围退出条件

- [x] 冻结 Coinbase primary / Binance atomic fallback 顺序；
- [x] 冻结 Hyperliquid、Bitquery、0x 与 Jupiter 的职责边界；
- [x] 冻结 Bitquery coverage、finality、route grouping 与 reconnect/backfill 约束；
- [x] 冻结 S0 jury、paper BUY/SELL 及明确 fallback 语义；
- [x] 冻结 `s0-paper` 不含任何 live execution path；
- [x] 同步 README、项目计划与技术架构，不保留冲突的旧口径。

SIDE-001 的范围确定至此完成。以下条目是实施阶段的 source selection/readiness gate，不重新打开 SIDE-001 产品范围。

## 7. 实施阶段 preflight 清单

- [ ] 从目标 AWS region 完成 Coinbase spot 与 `SLP` preflight；
- [ ] 按选择门冻结 `S0_CEX_PROFILE=coinbase|binance`，并记录失败原因；
- [ ] 若需要 fallback，完成 Binance spot/perp region preflight；
- [ ] 完成 Bitquery WSOL/USDC subscription、route grouping、checkpoint/backfill spike；
- [x] 完成 0x primary 的真实响应 contract test；
- [ ] 完成显式 Jupiter fallback 的真实响应 contract test（当前 key 返回 HTTP 401）；
- [ ] 每个启用源至少保存一份脱敏 fixture；
- [ ] 生成 source preflight 报告、Bitquery coverage manifest 与 p50/p95 latency 记录；
- [x] 静态确认 `s0-paper` 不包含 signer、transaction assembly、simulation 或 send client；
- [ ] 将最终 profile、cuts 和凭证需求写入 README 与 development log。

在这些运行时选择门完成前，本文件冻结的是**决策规则和 fallback 顺序**，不是预先宣称 Coinbase 或 Binance 已通过目标 AWS region 验收。
