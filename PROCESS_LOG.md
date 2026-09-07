# SIDE Process Log

本日志从 SIDE-006 开始建立。SIDE-001 至 SIDE-005 已在各自验收文档中记录；不对历史 focus time 做追溯估算。

## 2026-09-04 · SIDE-006

- 目标：把冻结的 source 决策变成可从目标美国 AWS region 执行和审计的 preflight。
- 实现：新增 `@side/source-preflight`，覆盖 Coinbase、Binance、Hyperliquid、Bitquery、0x 与显式 Jupiter fallback；输出 JSON、Markdown 和原子 `profile.env`。
- 验证：新增 15 个 tests；本机真实 run 选择 Coinbase，Hyperliquid 通过，Binance 在当前美国网络部分返回 451；无 429。
- 失败/阻塞：目标 AWS `192.0.2.10:22` 两次连接超时；本机没有 Bitquery/0x/Jupiter 凭据，相关 gate 未伪装成通过。
- 决策：保留 Coinbase primary / Binance atomic fallback；本机结果不替代目标 region gate；Jupiter 继续只允许显式触发。
- 安全检查：没有 signer、transaction assembly、simulation 或 transaction send path；报告不持久化 secret。
- Focus time：本次执行前未启用计时器，保持 `not measured`，不补造数字。

## 2026-09-05 · SIDE-006 credential follow-up

- 用户把本地凭据填入 Git-ignored、`0600` 的 `.env.preflight.local`；未在日志或报告中输出值。
- Bitquery WSOL/USDC subscription 连续 3 次通过。
- 0x key 连续获得两次有效 HTTP 200 response contract，第三次触发 HTTP 429；strict run 因此以退出码 2 结束。
- 决策：凭据鉴权有效；保留 429 为 readiness failure，不用部分成功覆盖 rate-limit 风险。

## 2026-09-05 · SIDE-006 local gate closure

- 为 0x/Jupiter 多样本探针加入 1.1 秒 source cadence；真实 429 仍是 hard failure。
- Required strict run 以退出码 0 完成：Coinbase 原子 profile、Hyperliquid、Bitquery、0x 各连续通过 3 次。
- 显式 Jupiter fallback run 返回 `3×HTTP 401`；未把它误写成通过，也未影响默认 required gate。
- 目标 AWS `192.0.2.10:22` 再次超时；本机没有 AWS CLI 或 Session Manager plugin，无法从替代管理通道进入。

## 2026-09-05 · local LIVE evidence follow-up

- 用户明确拒绝 demo/replay 数据，要求现有真实 WebSocket 持续向 UI push event。
- 新增 LIVE runtime：Coinbase `SOL-USD` + 动态 SLP、Hyperliquid SOL perp、Bitquery WSOL/USDC 三组持久连接；浏览器只消费 canonical gateway schema。
- Bitquery 同 signature rows 先聚合、去重 wrapper/pool 重复并形成一个净 economic swap；route legs 保留，非方向性 group fail closed。
- source heartbeat 不生成行情粒子；UI 改为每个市场独立保留 50 条事件，避免 DEX 高频流挤出其他 jury。
- 本地 soak 中四个 provider 均为 fresh/live/non-replay，sequence 持续增长；类型检查与 52 个 workspace tests 通过。
- 未扩大交易权限：LIVE paper quote 仍 unavailable；没有 signer、send 或自动 Jupiter fallback。目标 AWS gate 和 Bitquery historical backfill/checkpoint 仍未完成。

## 2026-09-06 · SIDE-010

- 目标：完成固定 SOL-USDC / $10k 的 action-time paper estimate、显式 fallback 和 record policy，不加入任何 live execution path。
- 实现：新增 0x provider、Jupiter quote-only provider 与 replay provider；BUY 单次 exact-in，SELL 使用同 provider USDC→SOL anchor 后再 SOL→USDC；2 秒 TTL、failure id、provider health recheck 和 preview/order idempotency 由服务端强制。
- UI：Paper Drawer 打开时请求新 estimate，显示 quote age、anchor amount、minimum output、reference price、route/request id；0x 失败后才显示 `TRY JUPITER ESTIMATE`。
- 安全：0x instruction body 与 lookup tables 不保存、不返回；只保留脱敏 amount/route/zid/time/hash。无 wallet、signer、assembly、simulation 或 send client。
- 失败纠正：Jupiter v1 quote 已被官方标记为 legacy；冻结 S0 仍使用已 preflight 的 quote-only contract，且完全不调用 transaction endpoint。后续迁移必须重新冻结 contract，不能在 SIDE-010 内静默切换。
- 测试：新增 provider、broker 与 HTTP integration tests，覆盖 success、429、timeout、schema drift、expired、SELL 任一必要 quote leg 过期、mixed-provider、market gate、idempotency 与禁止自动 fallback；最终 78 个 workspace tests 及 production build 通过。
- 真实验收：LIVE 浏览器从 0x 取得新鲜 $10k USDC→SOL estimate，并在 2 秒 TTL 内成功写入 `memory-side-010` paper record；返回与 UI 均未出现 instruction body 或 secret。
- 边界：paper record 明确为 `memory-side-010`；Postgres、重启恢复、decision journal 和 +5m markout 留给 SIDE-011。
- Focus time：未启用可靠计时，保持 `not measured`。
