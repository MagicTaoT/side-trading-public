# SIDE-010 - Paper Estimate Broker

状态：**COMPLETE · PAPER ONLY · SUPERSEDED BY SIDE-011 DURABLE JOURNAL**
日期：2026-09-06

## 1. 交付结论

SIDE-010 已把 paper drawer 从静态 preview contract 接到服务端 action-time estimate broker：

- `POST /api/paper-orders/preview`：默认且首次只允许 0x；
- `POST /api/paper-orders`：只记录仍在 SIDE 本地 10 秒 TTL 内的 preview，或记录 WAIT；
- `GET /api/paper-orders/:id`：读取本进程内的脱敏 paper record；
- BUY 固定以 `10,000 USDC` exact-in 获取 SOL；
- SELL 先由同一 provider 获取 `10,000 USDC → SOL` anchor，再把该 SOL 数量 exact-in 卖回 USDC；
- 0x 失败返回可审计 `failureId`；Jupiter 只有收到匹配 side、仍有效的 0x failure id 后才允许显式请求；
- preview 与 record 都要求 idempotency key；同 key 改变参数会 fail closed。

SIDE-010 最初使用有界进程内存；该边界现已由 [SIDE-011](SIDE-011_DECISION_JOURNAL_MARKOUT.md) 的 PostgreSQL journal、重启恢复与 +5m markout 取代。

## 2. 安全边界

- token mint、pair、notional 与 slippage 全部由服务端固定，浏览器不能透传任意 0x/Jupiter 请求；
- 0x 响应中的 instructions 与 address lookup tables 在解析后立即丢弃；只保留 amount、minimum amount、route label、`zid`、时间及原始响应 SHA-256；
- Jupiter 只调用 quote endpoint，不调用 swap/build/transaction endpoint；
- 没有 wallet、signer、transaction assembly、simulation 或 send client；
- API key 只从服务端环境变量读取；本地 `.env.live.local` / `.env.preflight.local` 均被 Git 忽略且权限为 `0600`，值不进入 response、浏览器或日志；
- LIVE 少于 3 个 fresh juries 时 preview 与 record 都返回不可用；过期 preview、混合 provider、后续 provider failure 均禁止 record。
- SELL 的 TTL 从 anchor 与 directional 两个必要请求中较早收到的那一腿起算；任一腿超过 10 秒即禁止 record。

## 3. 失败合同

已分类并测试：

- `MARKET_DATA_NOT_READY`；
- `PROVIDER_NOT_CONFIGURED`；
- `PROVIDER_HTTP_429` / `PROVIDER_HTTP_ERROR`；
- `PROVIDER_TIMEOUT` / `PROVIDER_NETWORK_ERROR`；
- `PROVIDER_SCHEMA_DRIFT`；
- `MIXED_PROVIDER_RESPONSE`；
- `PREVIEW_EXPIRED` / `PREVIEW_POLICY_MISMATCH`；
- `JUPITER_REQUIRES_ZEROEX_FAILURE` / `INVALID_ZEROEX_FAILURE`；
- `IDEMPOTENCY_KEY_REUSED`。

失败不会使用旧 preview，也不会自动调用 Jupiter。

## 4. 验收

- provider tests 验证 0x/Jupiter response mapping、响应哈希与 instruction 丢弃；
- broker tests 验证 BUY、SELL 同源 anchor、429、timeout、schema drift、mixed-provider、TTL、market gate、preview/order idempotency 和 explicit fallback；
- HTTP integration test 验证 REPLAY 无 secret 路径可以 preview → record → GET；
- Web drawer 会在打开时请求新 estimate，显示 quote age/TTL、anchor-derived SOL、minimum output、reference price、route/request ids，并允许显式 fallback、刷新和 record；
- 完整 workspace `pnpm check`（78 tests）与 `pnpm build` 已通过；
- 本地 LIVE 浏览器验收已使用真实 0x 响应完成 `PAPER BUY` preview → record，provider、route、request id 与 TTL 均在 UI 可见。

## 5. 未扩大范围

- SIDE-011：Postgres decision journal、重启恢复与 +5m markout；
- SIDE-012：部署限流、HTTPS 与 release documentation；
- 真实签名、模拟和广播继续不存在。

## 6. 2026-09-07 UI follow-up

- 首页 PAPER BUY/SELL 现在直接读取服务端共享 `/api/paper-prices`；页面打开时 base cadence 为 5 秒，无客户端时不主动消耗 quota；
- 一轮只取一次 SELL contract，其 USDC→SOL anchor 同时作为 BUY display，合计两次 0x 请求；
- display snapshot 固定 `recordable=false`。点击 BUY/SELL 后仍独立请求新的 10 秒 TTL preview，抽屉每 5 秒自动重取 0x；
- 429 退避 30 秒，timeout/network 退避 10 秒；不自动调用 Jupiter；
- 0x 不可用时先用严格 Bitquery WSOL/USDC reference，否则使用 fresh Coinbase SOL-USD reference，并施加固定双边 ±50bp dry assumption。两者均标记 `DRY`、不可执行、不可 record；Coinbase fallback 明示 USD/USDC basis 尚未建模。
