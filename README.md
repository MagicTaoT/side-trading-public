# SIDE — 短窗口交易判断工具

SIDE 面向主动 SOL 交易者，汇总中心化交易所和 DeFi 的现货、永续合约行情，帮助判断未来几秒到几分钟内的方向偏向、跨市场一致性与等待时机。初始观察窗口为 5 分钟。

它将价格变化、主动买卖流和数据新鲜度归纳为 `BUY BIAS`、`SELL BIAS`、`NO EDGE` 或 `INSUFFICIENT DATA`，同时展示判断依据。模拟决策、策略回放和历史回测用于检验这些判断；信号不代表成交保证或已经验证的盈利能力。

## 当前规划产物

- [产品、范围与交付计划](docs/PROJECT_PLAN.md)
- [技术架构与数据接入规范](docs/TECHNICAL_ARCHITECTURE.md)
- [SIDE-001 S0 数据源与执行冻结基线](docs/SIDE-001_SOURCE_FREEZE.md)
- [SIDE-002 Canonical event 与 replay foundation](docs/SIDE-002_FOUNDATION.md)
- [SIDE-003 Runnable runtime spine](docs/SIDE-003_RUNTIME_SPINE.md)
- [SIDE-004 Deterministic jury 与 verdict engine](docs/SIDE-004_SIGNAL_ENGINE.md)
- [SIDE-005 Event-driven cockpit 与 R0 验收](docs/SIDE-005_EVENT_DRIVEN_COCKPIT.md)
- [SIDE-006 Source preflight 与原子 profile selector](docs/SIDE-006_SOURCE_PREFLIGHT.md)
- [SIDE-010 Paper estimate broker](docs/SIDE-010_PAPER_ESTIMATE_BROKER.md)
- [更新后的 S0 可运行 Product Slice](docs/S0_RUNNABLE_PRODUCT_SLICE.md)
- [Process log](PROCESS_LOG.md)
- [主 Cockpit 视觉方向](ui-concepts/side-cockpit-v3.png)
- [5 分钟加权 Bubble Matrix 视觉方向](ui-concepts/side-bubble-weighted-v3.png)
- [Paper Order 视觉方向](ui-concepts/side-paper-order-v3.png)

## 当前建议

- 市场判断与模拟验证版：真实公开行情 + 本地 paper execution；不使用真实资金，不签名，不广播，不上链。
- S0 CEX：Coinbase `SOL-USD` spot；CEX perp 同时接 Coinbase Derivatives `SLP` 与 Kraken Futures `PF_SOLUSD`。Binance spot/perp 保留为经过部署区域 preflight 后才启用的候选源。
- S0 DEX flow：Bitquery WSOL/USDC decoded realized swaps；明确展示 coverage，不声称 Solana 全市场。
- 0x Solana：paper 下单时获取一次可执行报价/指令作为成交参考，但不提交交易。
- Jupiter：仅在 0x 失败且用户明确选择后作为 paper estimate fallback，不作 S0 连续行情或 DEX 成交流。
- 产品延伸版：真实 0x Solana swap 作为 feature-gated 模块，使用用户钱包本地签名；绝不把 Solana 私钥交给服务端。
- 首页：event-driven，而不是定时快照。每个进入可视层的标准化事件都有对应区域的局部反馈；bursty event 以 75 ms visual micro-batch 呈现并显示事件数，避免视觉噪声。

规划基线日期：2026-09-04。

## Foundation 验证

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm dev:s0
pnpm smoke:s0
```

本地真实行情模式由项目根目录的 `.env.live.local` 控制（格式见 [`.env.live.example`](.env.live.example)）。凭据继续只放在 `.env.preflight.local`。当前工作区已启用 `S0_RUNTIME_MODE=LIVE`，运行 `pnpm dev:s0` 后打开 `http://127.0.0.1:5173`，服务器会动态发现当前 Coinbase SLP 合约，并持久连接 Coinbase、Kraken Futures、Hyperliquid 与 Bitquery；不会自动载入 replay fixture。Kraken 使用无需凭据的公开 `PF_SOLUSD` trade/book/ticker feeds。

Source preflight：

```bash
# 先把 key 填入项目根目录的 .env.preflight.local
pnpm preflight:s0 -- --region us-east-1 --samples 5 --out-dir reports/preflight/aws-us-east-1 --strict
```

本地凭据的固定位置是 [`.env.preflight.local`](.env.preflight.local)，格式参考 [`.env.preflight.example`](.env.preflight.example)。CLI 会自动读取该文件；它已被 Git 忽略并设置为仅当前用户可读写。也可用 `--env-file <path>` 显式指定其他位置。必填凭据为 `BITQUERY_TOKEN`、`ZEROEX_API_KEY`；只有显式验证 Jupiter fallback 时才同时提供 `JUPITER_API_KEY` 和 `--include-jupiter`。secret 值不会进入报告。

当前已完成 SIDE-002 foundation、SIDE-003 runtime spine、SIDE-004 deterministic signal engine、SIDE-005 event-driven cockpit 与 SIDE-010 paper estimate broker。SIDE-006 的[本机 required strict 报告](reports/preflight/local-required-pass-2026-09-05/source-preflight.md) 已以退出码 0 选择 Coinbase，并连续验证 Hyperliquid、Bitquery 与 0x；显式 Jupiter 检查因当前 key 返回 401 而单独失败。产品 runtime 现已接入本地真实 Coinbase spot/SLP、Kraken Futures `PF_SOLUSD`、Hyperliquid 与 Bitquery WebSocket，页面明确显示 `LIVE`，心跳不生成成交粒子，Bitquery 同签名 route legs 合并为单一净经济成交。目标 AWS SSH 入口仍超时，所以 SIDE-006 的目标部署 gate 继续 blocked；Bitquery historical backfill/checkpoint 也仍是 R1 完整退出门。Paper drawer 现会在用户打开时请求真实 0x estimate，SELL 使用同 provider anchor，Jupiter 只允许用户携带 0x failure id 显式触发；记录仍是 SIDE-010 的有界进程内存，Postgres 与 +5m markout 进入 SIDE-011。
