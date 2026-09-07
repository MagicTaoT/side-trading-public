# SIDE-011 - Decision Journal and +5m Markout

状态：**COMPLETE · POSTGRES DURABLE · PAPER ONLY**
日期：2026-09-06

## 1. 交付结论

SIDE-011 已把 SIDE-010 的易失 paper record 升级为 PostgreSQL decision journal，并补齐唯一 5 分钟窗口的方向性 markout：

- migration `001_side_011_decision_journal.sql` 建立 decision、evidence snapshot、paper order snapshot 与 markout schedule/result；
- `PAPER BUY`、`PAPER SELL`、`RECORD WAIT` 都在一个事务中写入 decision、完整 signal/source evidence、脱敏 preview/order 与 `+300000ms` schedule；
- idempotency key 在数据库有唯一约束，同 key 同请求在进程重启后返回原 decision，同 key 改参数 fail closed；
- worker 启动时立即扫描已到期任务，之后每秒扫描；服务重启会补跑 due job；
- markout 唯一键为 `(decision_id, 300000, bitquery-wsol-usdc-robust-v1)`，并以 `UPDATE ... WHERE state='PENDING'` 保证重复 worker 只完成一次；
- `GET /api/paper-orders/:id`、`GET /api/paper-orders` 与 `GET /api/shadow-performance` 从 journal 返回当前持久状态；
- Paper Drawer 显示 `postgres-side-011`、markout 倒计时，并在保持打开时轮询最终 `SCORED/UNSCORED` 结果。

SIDE-016 已在首页接入上述列表与聚合 API，并为全部 `UNSCORED` 结果增加 reason counts；详见 [SIDE-016](SIDE-016_SHADOW_PERFORMANCE_UI.md)。

## 2. Reference policy

`bitquery-wsol-usdc-robust-v1` 只消费已完成 economic grouping 的 Bitquery WSOL/USDC realized swaps：

- reference window：评价时点前 15 秒；
- 至少 3 个去重 economic swaps；
- reference 为样本中位数；偏离初始中位数超过 100 bps 的样本被拒绝；
- 拒绝比例超过 25%、过滤后少于 3 笔、Bitquery source stale/gap 或价格异常时写 `UNSCORED`；
- entry 与 future 使用同一 policy version；不允许 Coinbase、Kraken、Hyperliquid 或旧 0x estimate 补值；
- 普通 raw feed 不写 PostgreSQL，runtime 只保留有界 DEX reference samples。

方向公式固定为：

```text
side_sign = BUY ? +1 : -1
directional_markout_bps = side_sign * (future_reference / entry_reference - 1) * 10,000
directional_pnl_quote = directional_markout_bps / 10,000 * 10,000 USDC
```

SELL 与 BUY 使用完全相同的 `future / entry` 分母，仅 sign 相反。WAIT 到期后明确写 `UNSCORED / WAIT_ACTION`，不混入方向胜率。

## 3. PostgreSQL 与启动

LIVE 模式现在强制要求 `DATABASE_URL`。本地示例：

```bash
brew install postgresql@18
brew services start postgresql@18
createdb side
```

`.env.live.local`：

```dotenv
S0_RUNTIME_MODE=LIVE
DATABASE_URL=postgresql://127.0.0.1:5432/side
```

应用启动时幂等执行 migration；`/health/ready` 返回 `paperPersistence=postgres-side-011` 后才表示 journal ready。REPLAY/test 可以显式使用 `memory-side-011-test`，不会被描述为 durable。

## 4. 验收

- unit tests：robust median、dedupe、minimum samples、stale/gap、outlier、BUY/SELL symmetry、WAIT unscored；
- PostgreSQL integration：实际 migration、事务写入、journal 重开、到期补跑、持久 idempotency、两个 worker 并发且 `attempts=1`；
- LIVE browser：真实记录显示 `PERSISTED · ... · +5M PENDING`；自然等待 5 分钟后，WAIT 决策自动刷新为 `UNSCORED / WAIT_ACTION`；
- LIVE database：decision、evidence SHA-256、paper order snapshot 与 markout row 均可联表读取；
- production build 的 server 可独立启动，readiness 返回 `paperPersistence=postgres-side-011`；
- `pnpm check`、带 `TEST_DATABASE_URL` 的 84 项完整测试与 `pnpm build` 均以退出码 0 完成。

## 5. 明确边界

- 没有 executable PnL、钱包、signer、transaction assembly、simulation 或 broadcast；
- Bitquery historical backfill/checkpoint 未完成时，进程停机覆盖 future reference window 的任务会诚实 `UNSCORED`，不能用恢复后的新价格倒填；
- PostgreSQL backup、Docker Compose、TLS、production hardening 与部署属于 SIDE-012。
