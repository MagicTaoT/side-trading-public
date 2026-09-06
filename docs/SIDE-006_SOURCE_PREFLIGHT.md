# SIDE-006 - Source preflight and atomic profile selector

状态：**LOCAL REQUIRED GATES COMPLETE · TARGET AWS RUN BLOCKED**
日期：2026-09-04
Manifest：`s0-preflight-v1`

## 1. 交付结论

SIDE-006 已交付可执行的 TypeScript preflight package。它对每个 source 做真实 HTTP/WebSocket 探测，输出 JSON、Markdown 与唯一的 CEX profile 环境赋值，并严格执行以下原子选择规则：

```text
Coinbase SOL-USD metadata + WS
AND Coinbase Derivatives SLP metadata + WS
  -> S0_CEX_PROFILE=coinbase

否则，Binance SOLUSDT spot metadata + WS
AND Binance SOLUSDT USD-M perp metadata + WS
  -> S0_CEX_PROFILE=binance

否则
  -> S0_CEX_PROFILE=unavailable
```

不允许 Coinbase spot 与 Binance perp 等半 profile 混搭。Hyperliquid、Bitquery、0x 和 Jupiter 是独立 readiness gates，不改变 CEX profile 的原子性。

## 2. 运行方式

从项目根目录执行：

```bash
pnpm preflight:s0 -- \
  --region us-east-1 \
  --samples 5 \
  --timeout-ms 6000 \
  --out-dir reports/preflight/aws-us-east-1 \
  --strict
```

项目根目录已经创建 `.env.preflight.local` 作为固定的本地凭据位置；CLI 默认自动读取它。该文件已被 Git 忽略，权限为 `0600`，格式模板为 `.env.preflight.example`。需要改用 AWS Secret Manager 渲染出的临时文件时，可传入 `--env-file <path>`。

文件中的变量为：

- `BITQUERY_TOKEN`
- `ZEROEX_API_KEY`
- `JUPITER_API_KEY`，只在同时传入 `--include-jupiter` 时使用

默认不探测 Jupiter，因为它是 0x 失败后由用户明确触发的备份。报告只保存凭据变量名，不保存值；JSON、Markdown 和 `profile.env` 均以 `0600` 权限写入。

## 3. 已实现探针

| Source | 探针证据 |
|---|---|
| Coinbase spot | `SOL-USD` public product metadata；Advanced Trade ticker WS |
| Coinbase Derivatives | public futures discovery 中实际 `SLP-*-CDE` product id；对应 ticker WS |
| Binance fallback | spot / USD-M `SOLUSDT` metadata 与 bookTicker WS；记录 451/429 |
| Hyperliquid | `metaAndAssetCtxs` 中动态发现 `SOL`；`l2Book` WS |
| Bitquery | 带 Bearer token 的 `graphql-transport-ws`；WSOL/USDC `DEXTradeByTokens` subscription |
| 0x | 带 API key 的 Solana `swap-instructions` response contract；不保存 instructions body |
| Jupiter | 仅显式启用的 Swap v1 quote response contract |

每个结果记录 endpoint、transport、product/instrument metadata、entitlement、HTTP 状态计数、429 标记、p50/p95 RTT 和稳定 reason code。

## 4. 2026-09-04 本机真实探测

报告：[Markdown](../reports/preflight/local-2026-09-04/source-preflight.md) · [JSON](../reports/preflight/local-2026-09-04/source-preflight.json) · [profile.env](../reports/preflight/local-2026-09-04/profile.env)

实际结果：

- `S0_CEX_PROFILE=coinbase`；`SOL-USD` 与发现到的 `SLP-20DEC30-CDE` metadata/ticker WS 各连续通过 3 次；
- Hyperliquid `SOL` metadata/l2Book WS 各连续通过 3 次；
- Binance spot REST 与 WS、USD-M REST 从当前美国网络返回 HTTP 451，因此 Binance 原子 profile 不完整；
- Bitquery 与 0x 因未注入凭据标为 `blocked`；Jupiter 未显式请求，标为 `skipped`；
- 总计 `PASS=7 FAIL=3 BLOCKED=2 SKIPPED=1`，未观察到 HTTP 429。

这个本机结果只证明 selector 与 source 在当前网络的行为，不替代目标 AWS region 的部署选择门。

### 4.1 2026-09-05 凭据验证

填入本地 secret 文件后再次执行 3-sample strict run：[Markdown](../reports/preflight/local-credentials-2026-09-05/source-preflight.md) · [JSON](../reports/preflight/local-credentials-2026-09-05/source-preflight.json)。

- Bitquery token 被接受，WSOL/USDC subscription 连续 3 次收到有效 `next` evidence，p50 `984.25 ms`、p95 `1064.65 ms`；
- 0x key 被接受，`swap-instructions` 返回 `2×HTTP 200` 且响应合同有效；第 3 次返回 `HTTP 429`，因此 strict readiness 正确失败；
- 报告为 `PASS=8 FAIL=4 BLOCKED=0 SKIPPED=1`，CEX 仍原子选择 `coinbase`；
- 对三个本地 key 做逐值扫描，JSON 报告无 secret 泄漏，输出文件保持 `0600`。

凭据本身可用，但 0x 的当前 quota/请求节奏尚未通过连续采样门，不能把这次 strict run 写成全部通过。

### 4.2 2026-09-05 最终本机 required run

探针为 0x/Jupiter 加入每次采样间 1.1 秒的 source-specific cadence；它不会重试或抹掉真实 429，只避免 preflight 自己形成不符合产品调用方式的瞬时 burst。

- required strict 报告：[Markdown](../reports/preflight/local-required-pass-2026-09-05/source-preflight.md) · [JSON](../reports/preflight/local-required-pass-2026-09-05/source-preflight.json)；
- 结果为 `PASS=9 FAIL=3 BLOCKED=0 SKIPPED=1`，进程退出码 `0`；
- Coinbase 原子 profile、Hyperliquid、Bitquery 与 0x 均连续 3 次通过；0x 为 `3×HTTP 200`，p50 `212.51 ms`、p95 `336.41 ms`；
- 三个 failure 都属于未被选中的 Binance fallback 在当前美国网络的 451，不影响已完整通过的 Coinbase profile；
- Jupiter 按默认规则保持 skipped。

另一次显式 `--include-jupiter` strict run 中，0x 同样 `3×HTTP 200` 通过，但 Jupiter 返回 `3×HTTP 401`。报告见 [Markdown](../reports/preflight/local-complete-2026-09-05/source-preflight.md) 与 [JSON](../reports/preflight/local-complete-2026-09-05/source-preflight.json)。这说明当前 Jupiter key 未被 `api.jup.ag` 接受；由于 Jupiter 是显式备份，它不影响默认 required run，但在替换为有效 key 前不能宣称 fallback 已验证。

## 5. 目标 AWS 阻塞记录

既定目标为美国东部 AWS 主机 `192.0.2.10`。本轮两次以 10/12 秒连接超时执行只读 SSH 检查，均得到：

```text
ssh: connect to host 192.0.2.10 port 22: Operation timed out
```

因此无法把 package 送入该主机或从目标 region 生成报告。目标部署的 `S0_CEX_PROFILE` 仍未获授权；不能用本机的 `coinbase` 结果代替 AWS gate。恢复实例并开放本机到 TCP/22，或提供可用的 SSM/新 SSH 入口后，直接运行第 2 节命令即可完成该 gate。

### 5.1 本地 LIVE 接线验证

为回应本地验收需要，产品 runtime 已从只有 3 条事件的同步 golden replay 扩展为明确的 `LIVE` 模式：

- Coinbase Advanced Trade WebSocket 同时订阅 `SOL-USD` 与启动时动态发现的 `SLP-*-CDE`，接收 `market_trades`、`level2` 与 heartbeat；SLP 合约数量按冻结的 `5 SOL` multiplier 归一化；
- Hyperliquid 持久订阅 SOL trades、BBO 与 active asset context；
- Bitquery 使用 Bearer token 和 `graphql-transport-ws` 持久订阅 WSOL/USDC；同 signature 数据先短暂聚合，重复 wrapper/pool rows 去重，route legs 归并为一个净 economic swap；非方向性或 schema-invalid group fail closed；
- server 统一分配全局 `ingestSeq`、做 event-id dedupe、通过 canonical schema 后才推向浏览器；source-health 参与 freshness，但不制造成交 bubble；
- UI 对四个市场分别保留 50 条 visual history，避免高频 DEX 数据挤掉 CEX/Hyperliquid 事件。

本地 soak 观察到四个 source provider 均为 `connection=live`、`quality=fresh`、`replay=false`，全局序号持续增长，页面显示 Coinbase 真实成交、Coinbase SLP BBO、Hyperliquid 成交与 Bitquery 多协议 economic swaps。该证据只证明当前本机真实连线，不替代目标 AWS gate，也不等于完成 Bitquery historical backfill/checkpoint。

## 6. 安全与验收

- package 不包含 wallet、signer、transaction assembly、simulation 或 send client；
- 0x/Jupiter 只验证 estimate response contract，不签名、不广播；
- fetch/WS 错误、URL query、Bearer/API key 和最终报告均经过脱敏；
- selector、统计、采样 cadence、429、strict fallback gate、CLI、manifest、脱敏和文件权限共有 17 个 package tests；
- `pnpm check` 已通过 52 个 workspace tests；`pnpm build`、`pnpm smoke:s0` 与 `pnpm install --frozen-lockfile` 均通过。新增 LIVE runtime 测试覆盖全局 sequence、duplicate event id、transport state 与 replay 禁用边界。

参考合同：

- [Coinbase Advanced Trade WebSocket](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview)
- [Coinbase SLP contract specifications](https://help.coinbase.com/en/derivatives/perpetual-style-futures/contract-specifications)
- [Coinbase Derivatives market access](https://help.coinbase.com/en/derivatives/perpetual-style-futures/market-access)
- [Bitquery WebSocket subscriptions](https://docs.bitquery.io/docs/subscriptions/websockets/)
- [0x Solana swap instructions](https://docs.0x.org/api-reference/solana-swap-ap-is/swap/instructions)
- [Jupiter Swap v1 quote](https://developers.jup.ag/docs/swap/v1/get-quote)

## 7. 剩余退出门

- [x] 可执行 CLI、版本化 manifest 与审计报告；
- [x] Coinbase/Binance 原子 profile selector；
- [x] 本机真实 source probe 与报告；
- [x] secret 脱敏与无 execution path 静态边界；
- [x] package tests；
- [ ] 从目标美国 AWS region 执行；
- [x] 注入并验证 Bitquery token、subscription 与连续采样；
- [x] 0x key、`3×HTTP 200` response contract 与 paced continuous sampling；
- [ ] 若产品演示需要，显式传入 Jupiter key 与 `--include-jupiter` 验证备份。

所以 SIDE-006 的代码与本机 required gates 已完成，但 task 不能标记为最终 `COMPLETE`，直到目标 AWS gate 通过。Jupiter 是可选 backup gate；当前 key 的 401 已单独保留，未影响或污染 required 结果。
