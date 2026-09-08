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

## 2026-09-06 · SIDE-011

- 目标：把 paper decision 从进程内存升级为可重启恢复的 PostgreSQL journal，并关闭唯一 +5m 方向评价闭环。
- 实现：新增 migration、PostgreSQL/测试内存 journal、数据库级 idempotency、decision/evidence/order snapshot、markout schedule/result、列表与 shadow-performance API。
- Reference：冻结 `bitquery-wsol-usdc-robust-v1`；15 秒 trailing window、至少 3 个去重 economic swaps、中位数、100 bps outlier gate、最多 25% rejected。stale/gap/insufficient/anomaly 一律 unscored，不使用 CEX/HL/旧 estimate 补值。
- Worker：启动即 catch up，之后每秒扫描；唯一键 `(decisionId, 300000, policyVersion)`，完成更新只接受 `PENDING`，两个 worker 并发验收后 attempts 仍为 1。
- UI：record 后显示 PostgreSQL persistence、+5m 倒计时、entry reference/sample count 或明确 unavailable 原因；抽屉保持打开时轮询最终结果。
- 真实验收：本地 PostgreSQL 18 migration、浏览器 paper decision、四表联查、服务重启读取均通过；LIVE readiness 返回 `postgres-side-011`。带独立 PostgreSQL test database 的完整 84 tests 与 production build 通过。
- 边界：普通 raw feed 不落 PostgreSQL；无 Bitquery backfill 证明时停机窗口只能 unscored。backup/Compose/TLS 与 production hardening 留给 SIDE-012。
- Focus time：未启用可靠计时，保持 `not measured`。

## 2026-09-07 · SIDE-016

- 目标：把 SIDE-011 journal 和 +5m markout 变成不依赖 Paper Drawer 的常驻 shadow-performance 与 decision-history 界面。
- 实现：首页加载全部历史聚合和最近 12 条 decision；首次加载、5 秒轮询、页面恢复、record 成功与 markout WebSocket 事件均会同步。PostgreSQL/内存 journal 新增全量 unscored reason counts。
- UI：显示 decision/action 分布、scored sample、win rate、mean +5m、pending、unscored、entry/future reference、paper PnL 和明确 reason；bubble hover/focus 显示 source、instrument、side、batch、notional、price 与 age。
- 口径：WAIT 与任何 unscored 结果不进入 sample/win rate；mean 和 paper PnL 明示为 gross directional markout，不包装为 executable PnL。
- 真实验收：LIVE 页面从 PostgreSQL 读取 3 条 decision，正确显示 `WAIT_ACTION ×2`、`SOURCE_NOT_FRESH ×1`，scored sample 为 0 时 win rate/mean 为 `—`。
- 测试：新增 performance 纯函数和静态 UI contract tests；带独立 PostgreSQL test database 的 89 项 workspace tests、typecheck 与 production build 通过。
- 安全边界：无 wallet、signer、assembly、simulation 或 send path；未改变 SIDE-011 reference policy。
- Focus time：未启用可靠计时，保持 `not measured`。

## 2026-09-07 · SIDE-016 paper price UI follow-up

- 目标：让 PAPER BUY/SELL 不打开 drawer 也能看到真实双向价格，并修复“只有手动 refresh”的体验。
- 实现：首页每 5 秒读取服务端共享 display snapshot；一轮 0x SELL contract 的 anchor 复用于 BUY display，减少为两次上游调用。点击后的 action-time preview 仍与 display cache 隔离，并每 5 秒自动刷新。
- 稳定性：真实复现 BUY timeout 与 SELL 接近 2 秒 TTL 边界；随后又观察到 0x 429。加入 429=30 秒、timeout/network=10 秒退避，Jupiter 没有自动调用。
- Dry policy：0x 不可用时使用 Bitquery strict WSOL/USDC reference；该 reference 不可用时允许 fresh Coinbase SOL-USD reference，固定 BUY +50bp / SELL -50bp，并显式显示 `DRY · COINBASE USD`。dry 值永远 `recordable=false`，不进入 jury 或 markout reference。
- 真实验收：LIVE 浏览器先显示 Coinbase dry 双边价格，退避结束后自动恢复为 0x LIVE；BUY drawer 在 5 秒后自动取得新 preview，quote age 回到 2 秒内。未触发 Jupiter。
- 验证：server 32 tests、web 23 tests；workspace 共 92 tests 通过、1 个需独立 PostgreSQL test database 的 integration test 按环境跳过，production build 通过。

## 2026-09-07 · SIDE-016 decision history follow-up

- 目标：让每条 paper decision 明确显示记录时的 edge，并允许用户逐条清理测试记录。
- 实现：历史新增 `ENTRY EDGE`，直接读取持久化 evidence 内的 entry verdict；新增逐行 `DELETE → CONFIRM` 与服务端 DELETE route。
- 删除语义：PostgreSQL 使用既有 `ON DELETE CASCADE` 同步删除 evidence、order snapshot 和 markout；内存 journal 同步移除 idempotency 映射，删除后重新拉取 aggregate。
- 验证：memory、HTTP 与独立 `side_test` PostgreSQL cascade integration tests 均通过；没有删除 LIVE market event 或其他 decision。

## 2026-09-07 · v0.2 freeze 与 SIDE-020

- Freeze：将现有 paper estimate、PostgreSQL decision journal、+5m markout、shadow performance 与 price UI 基线统一标记为 package `0.2.0`；完整 typecheck、98 tests（另 1 个环境条件 PostgreSQL test skipped）和 production build 通过后，提交 `429824d`、tag `v0.2.0` 并创建 GitHub Release `SIDE v0.2`。
- SIDE-020：新增独立 `@side/strategy-engine`，支持 edge 持续确认、首次/后续 size、interval/size multiplier、硬性段数/总仓位上限、basket 加权成本、对称 gross PnL、止盈/线性降至 0、止损、强退、pending price、cooldown 与 restart restore。
- Edge：不修改冻结的 `s0-v1`；策略 edge 定义为同向 fresh quorum 的第三强绝对 price impulse。
- Persistence/UI：新增不可变 config revision、run/basket/event journal 与 checkpoint；Cockpit 增加 DRY RUN ONLY 参数、active basket、配置历史和执行历史面板。
- 一致性：单次 evaluation 的事件与最终 snapshot 原子提交；journal failure 后先恢复已提交状态再接受下一帧。event history 保存 delta，active restart 只读取 config + run snapshot，避免分段 history 平方增长或恢复时全表加载。
- Replay：只按录制事件间隔推进策略；完成/停止后不再以 wall clock 重复最终 signal。`maxEntries` 硬上限为 100，全部 interval 与绝对 deadline 在改仓前验证。
- 安全：自动策略使用理论即时成交，零手续费/滑点/partial fill；不调用交易接口，不包含 signer 或 broadcast path。
- 验证：workspace typecheck 与 production build 通过；161 tests passed，3 个需要独立 `TEST_DATABASE_URL` 的 PostgreSQL tests 按环境跳过。

## 2026-09-07 · SIDE-020 WebSocket resource controls

- Dashboard footer 新增英文 `DISCONNECT ALL WS` 与 `RECONNECT ALL WS`，明确显示 CONNECTING、CONNECTED 或 PAUSED；Strategy 面板与 validation messages 也统一为英文。
- 断开操作关闭所有 dashboard gateway WebSocket；LIVE 模式同时停止四组行情 adapters，并由 `PersistentSocket.stop()` 取消退避 timer，避免后台自动重连。
- 重连操作先恢复 LIVE adapters，再创建新的 dashboard gateway WebSocket；REPLAY 模式只控制 dashboard gateway。
- Dashboard gateway 对 server restart/瞬时断流加入 1/2/4/8/15 秒封顶的指数退避自动重连；人工全局断开使用 close code `4001`，明确进入 PAUSED 而不自动占用网络。
- 策略状态、HTTP API、配置 revision 与执行 history 独立保留，不因 WS 断开而清空。
- 验证：165 tests passed，3 个需要独立 `TEST_DATABASE_URL` 的 PostgreSQL tests 按环境跳过；workspace typecheck 与 production build 通过。

## 2026-09-07 · Paper action quote TTL follow-up

- 将 action-time preview 的默认 TTL 从 2 秒调整为 10 秒，与 5 秒自动 requote cadence 配套；正常情况下新报价会在旧报价过期前替换，并允许容忍一次刷新失败。
- SELL 仍从 anchor 与 directional 两个必要请求中较早收到的一腿起算 TTL；超过 10 秒后服务端拒绝 record。
- 首页共享 display snapshot 与 dry model 仍固定 `recordable=false`，本次调整不扩大其提交权限。

## 2026-09-07 · Auto Strategy 独立页面与 Shadow Performance 复核

- Auto Strategy 从主 Dashboard 移到独立 `/strategy` 页面；Dashboard 仅保留 `AUTO STRATEGY` 导航，不再加载策略配置/run/history 的每秒轮询。
- 独立页面显示 LIVE/REPLAY、DRY RUN ONLY、market inputs 状态，并保留完整配置 revision、active basket 与 run/basket/event history。
- Shadow Performance 当前保留：它评价人工 `PAPER BUY / SELL / WAIT` 的固定 +5m 方向 markout；Auto Strategy history 评价规则驱动的实际持仓生命周期，两者分别承担 signal validation 与 strategy simulation。
- 退役条件：只有当产品取消人工 paper decision workflow 时，才连同 Shadow UI、journal API 和 markout worker 一起移除；新增 Auto Strategy 本身不足以证明它已无意义。
- 验证：167 tests passed，3 个需要独立 `TEST_DATABASE_URL` 的 PostgreSQL tests 按环境跳过；workspace typecheck、web production build、LIVE Dashboard 与 `/strategy` browser smoke 均通过。

## 2026-09-07 · Strategy run history readability follow-up

- 将挤压的 basket cards 和无标题 event 流重构为 run columns、PnL summary、basket result table 与 latest-first event timeline；长 run ID 缩为可识别短码并保留完整值用于审计。
- 新增 Total Theoretical PnL，口径固定为 closed basket gross PnL + open basket mark-to-market；同时拆分 Closed PnL、Open MTM、win/loss、entry fills 与 cumulative entry notional，未定价 basket 单独计数。
- Basket table 独立显示 direction、exit reason、entry count、exposure、average entry、exit/current price、PnL bps 与 PnL USDC；take-profit、stop-loss、force-exit/manual-stop 分色，不把所有 closed basket 都显示为绿色。
- 真实 run browser check：12 closed baskets、6 win / 6 loss、39 entry fills、$31,734.38 cumulative entry notional、Total Theoretical PnL `+$2.72`。
- 验证：169 tests passed，3 个需要独立 `TEST_DATABASE_URL` 的 PostgreSQL tests 按环境跳过；workspace typecheck、production build 与 LIVE browser visual check 通过。

## 2026-09-07 · v0.3 freeze

- Freeze scope：以 `v0.2.0` 为基线，纳入 SIDE-020 dry-run strategy engine、PostgreSQL strategy journal/recovery、独立 `/strategy` 页面、PnL/history UI、WebSocket 资源控制与自动重连，以及 10 秒 paper action quote TTL。
- Version：root、apps 与全部 workspace packages 统一升级为 `0.3.0`，release tag 使用 `v0.3.0`。
- 安全边界：继续保持 dry-run only；没有 wallet、signer、transaction assembly、simulation、broadcast 或 live order submission path。
- Release verification：169 tests passed，3 个需要独立 `TEST_DATABASE_URL` 的 PostgreSQL tests 按环境跳过；workspace typecheck、production build、LIVE browser smoke 与 PnL 汇总检查通过。

## 2026-09-07 · SIDE-021 Historical backtest foundation

- Recorder：LIVE 默认记录 canonical market events 与每秒 strategy observation tape；按 UTC hour/provider/model 分区，写入期使用 `.partial`，正常关闭后计算 SHA-256、原子 finalize 并产生 COMPLETE manifest。OPEN、FAILED、checksum/count/order 异常全部 fail closed。
- Replay parity：新增固定 1 秒虚拟 timeline；每个 tick 先 ingest 已到达 events，再执行 signal freshness/prune 与 strategy observation。LIVE tape 保存真实 tick，旧 dataset/golden fixture 才从 canonical events 重建。
- Backtest：新增单 dataset/单 `StrategyConfigV1` runner 与 HTTP API，输出确定性 result hash、basket/events/final snapshot、gross theoretical PnL、coverage、capital-normalized return、drawdown 和 exit reason counts。
- 安全与口径：继续不含任何真实下单路径；第一版不模拟 fee、slippage、funding、market impact 或 partial fill，结果固定标记 `GROSS_THEORETICAL_V1`。
- LIVE 验收：本地 recorder 对 Coinbase spot/derivatives、Kraken Futures、Hyperliquid 与 Bitquery 生成 COMPLETE dataset；选取含 13,541 events / 259 observations 的 dataset 通过 HTTP 跑通 recorded-tape backtest，coverage 100%，产生 1 个 closed + 1 个 open basket 与确定性 result ID。
- 验证：176 tests passed，3 个需要独立 `TEST_DATABASE_URL` 的 PostgreSQL tests 按环境跳过；workspace typecheck、production build 与 `git diff --check` 全部通过。

## 2026-09-07 · SIDE-021 Batch experiments 与 Backtest Lab

- Batch runner：新增 explicit config batch 与 typed parameter grid，覆盖 entry、scale-in、exit、cooldown 参数；最多 128 个 unique variants。每个 experiment 只 prepare 一次 dataset，所有变体复用同一 immutable observation sequence。
- Persistence：experiment index 与每个完整 variant result 分文件原子写入 `data/backtests/`；提供 queued/running/completed/partial/failed/cancelled 状态、取消、重启 history 恢复及 interrupted fail-closed 语义。
- API/UI：新增 experiment list/create/detail/cancel/result endpoints；独立 `/backtest` 页面提供 completed dataset 概览、saved config/grid 两种输入、进度、leaderboard、Total Theoretical PnL、return/drawdown、equity curve、exit reasons 和 basket/fill drill-down。
- 口径：leaderboard 默认按 gross Total Theoretical PnL 降序、同 PnL 以较低 max drawdown 优先；页面始终标识 DRY RUN MODEL / GROSS THEORETICAL，不引入真实下单能力。
- 验证：typed grid、dedupe、single-prepare、artifact restore、HTTP async flow、ranking/chart helpers、responsive route contracts；183 tests passed、3 个 PostgreSQL integration tests 按环境跳过，workspace typecheck/build、`git diff --check` 与 LIVE browser smoke 通过。真实 5,869-event / 193-observation dataset 的 4 个 variants 全部完成且 coverage 100%。

## 2026-09-08 · v0.4 freeze

- Freeze scope：以 `v0.3.0` 为基线，纳入 SIDE-021 canonical event/observation recorder、checksum + fingerprint dataset finalization、fixed-tick replay fallback、deterministic backtest runner、batch experiments 与独立 `/backtest` lab。
- Version：root、apps 与全部 workspace packages 统一升级为 `0.4.0`，release tag 使用 `v0.4.0`。
- Scope boundary：Hyperliquid/CEX 认证交易、maker 预入场、真实 TP/SL 与任何 live execution 实现全部延后，不进入周五 demo 和 v0.4 release。
- Safety boundary：继续保持 paper/dry-run only；没有认证交易 client、wallet、signer、transaction assembly、simulation、broadcast 或 live order submission path。
- Release verification：183 tests passed，3 个需要独立 `TEST_DATABASE_URL` 的 PostgreSQL tests 按环境跳过；workspace typecheck、production build、`git diff --check` 与本地 HTTP + WebSocket + replay smoke 通过。
