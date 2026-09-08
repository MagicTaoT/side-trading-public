# SIDE-021 · Historical recorder、fixed-tick replay 与 backtest MVP

状态：implemented and workspace-verified
日期：2026-09-07
安全边界：`GROSS_THEORETICAL_V1` only；不提交订单，不调用 signer/broadcast path。

## 目标

完成历史回测闭环：持续记录可重放行情、让 reconstructed replay 与 LIVE 保持相同的“event first / one-second strategy tick second”顺序、运行确定性回测，并提供批量配置/参数网格、持久化实验历史及独立的 `/backtest` 分析页面。

## 双层数据集

> SIDE-022 已把这里的“每次启动一个 dataset”扩展为 UTC 对齐的 3h 自动轮转与归档；本节保留 SIDE-021 原始格式 contract，运行时生命周期以 SIDE-022 为准。

LIVE 服务每次启动创建一个 dataset，默认目录为 `data/recordings/`：

```text
data/recordings/<dataset-id>/
  manifest.json
  events/YYYY-MM-DD/HH/<provider>.ndjson
  observations/YYYY-MM-DD/HH/s0-v1.ndjson
```

第一层记录所有被 runtime 接受的 canonical `MarketEvent`。第二层记录 LIVE 每秒实际送入策略的 direction、edge、理论参考价、reference source、signal model、as-of sequence 和 coverage。两者共用异步串行 writer，保持进程内调用顺序。

写入期间 partition 使用 `.partial`，manifest 状态为 `OPEN`。正常关闭时 recorder：

1. 等待所有 queued writes；
2. 为每个 partition 计算 SHA-256；
3. 将 `.partial` 原子改名为 `.ndjson`；
4. 写入包含 partition checksums 和 dataset fingerprint 的 `COMPLETE` manifest。

写入、rename 或 manifest 更新失败时 dataset 为 `FAILED`。Backtest loader 默认拒绝 OPEN/FAILED、checksum 不符、event count 不符、重复 `ingestSeq`/event ID，以及 observation 时间不严格递增的数据。

配置：

- `SIDE_RECORDING_DIR`：覆盖默认 recording root；
- SIDE-021 原始实现曾支持 `SIDE_RECORDING_DATASET_ID`；SIDE-022 的轮转 recorder 不再接受固定 ID，避免窗口覆盖和混写；
- `GET /api/recording/status`：当前 dataset、计数和 failure；
- `GET /api/backtest-datasets`：可发现的 manifest，包括 OPEN/FAILED，供 UI 明确显示但不可运行。

服务必须正常收到 SIGINT/SIGTERM 或完成 Fastify close，dataset 才会变为 COMPLETE。强制杀进程留下的 partial dataset 不会被静默纳入回测。

## Fixed-tick replay contract

Canonical replay 仍以 `ingestSeq` 为权威顺序。相对第一个 event 的 receive-time offset 形成单调 event timeline；receive timestamp rollback 不允许虚拟时钟倒退。

每个 tick 的固定顺序：

```text
ingest every event whose effective receive offset <= tick
  -> signal/runtime state update
  -> advance runtime clock to tick
  -> prune/freshness transition
  -> create exactly one strategy observation
```

tick interval 固定为 1,000 ms，从 offset 0 开始，结束位置向上补齐到 dataset 尾部的完整 tick。LIVE observation tape 保存真实运行时的每次 evaluation，因此 backtest 优先使用 tape；fixed-tick reconstruction 只用于没有 observation tape 的旧数据集或 golden fixture。

## Backtest runner

`BacktestRunner` 接受 `datasetId + StrategyConfigV1`。只读取 `COMPLETE` dataset：

1. 有 observation tape 时直接验证 model version 并送入 `DryRunStrategyEngine`；
2. 没有 tape 时重放 canonical events，由 `S0Runtime + s0-v1` 每秒重建 observation；
3. 收集所有 strategy transition、fill、closed basket 和最终 open basket；
4. 计算 gross theoretical PnL、win/loss、entry notional、最大资金占用、capital-normalized return 与 mark-to-market drawdown；
5. 对 dataset fingerprint、config fingerprint、runner version 和完整结果计算确定性 SHA-256。

HTTP：

```http
POST /api/backtests
Content-Type: application/json

{
  "datasetId": "live-...",
  "config": { "schemaVersion": 1, "...": "StrategyConfigV1" }
}
```

返回：

- `executionModel=GROSS_THEORETICAL_V1`；
- dataset/config/result SHA-256；
- observation source：`RECORDED_TAPE` 或 `RECONSTRUCTED_EVENTS`；
- total/closed/open PnL、coverage、basket/win/loss、fill/exposure、return/drawdown、exit reasons；
- baskets、strategy events 和 final snapshot。

同一 dataset、config 和代码版本必须返回完全相同的 `resultId` 与 `resultSha256`。

## Batch experiments 与持久化历史

`POST /api/backtest-experiments` 支持两种互斥输入：

- `configs`：一次运行一个或多个已有 `StrategyConfigV1`；
- `baseConfig + parameterGrid`：对 entry、scale-in、exit 与 cooldown 参数做笛卡尔积。

服务端先验证并去重配置，最多接受 128 个 unique variants。一个 experiment 只读取并校验一次 dataset，然后所有 variant 复用同一份 immutable observation sequence，避免参数 sweep 重复解析大文件。任务以 `QUEUED → RUNNING → COMPLETED/PARTIAL/FAILED/CANCELLED` 推进；单个 variant 失败不会抹掉已经完成的结果。

默认结果目录为 `data/backtests/`，可通过 `SIDE_BACKTEST_DIR` 覆盖：

```text
data/backtests/<experiment-id>/
  experiment.json
  variants/variant-001.json
  variants/variant-002.json
```

experiment index、每个 variant 的 config/hash/summary，以及完整 result/equity/baskets 都原子写入。服务启动时恢复历史；非正常退出遗留的非终态 experiment 明确标记为 `FAILED / BACKTEST_EXPERIMENT_INTERRUPTED`，不会伪装成完成。

HTTP：

- `GET /api/backtest-experiments`：实验历史；
- `POST /api/backtest-experiments`：提交配置批次或参数网格；
- `GET /api/backtest-experiments/:id`：进度与 leaderboard summaries；
- `POST /api/backtest-experiments/:id/cancel`：请求取消；
- `GET /api/backtest-experiments/:id/variants/:variantId`：读取完整结果。

## `/backtest` UI

独立 Backtest Lab 提供：completed dataset 选择及 event/observation/provider 概览、内置/历史 config 选择、参数网格输入、异步进度与 durable experiment history、按 Total Theoretical PnL 排序并以较低 drawdown 打破平局的 leaderboard、最多 600 点的 equity curve、exit reason 汇总，以及 basket/fill drill-down。Dashboard 与 `/strategy` 均提供英文导航入口。

## 明确限制

- 当前 experiment queue 在单 server process 内串行执行；没有 worker pool、跨进程 lease 或分布式调度。
- 单次 experiment 最多 128 个 unique variants，且固定在一个 dataset 上；跨 dataset walk-forward 留给后续版本。
- 不模拟 fee、spread、slippage、funding、market impact、partial fill 或 limit queue。
- 不把 OPEN/FAILED dataset、损坏 partition 或不支持的 signal model 纳入结果。
- `Total Theoretical PnL` 仍为 closed gross PnL 加最终 open basket MTM，不能命名为 realized/net PnL。
- 绝对 size 会放大美元结果；跨配置比较应使用固定 capital cap 或 `returnOnMaxCapitalBps`。

## 验证

- recorder：双 provider 分区、observation tape、complete manifest、partition/dataset hash、checksum corruption fail-closed；
- replay：event-before-tick 顺序、0/1/2 秒固定 tick、LIVE/replay observation parity；
- backtest：确定性 result hash、理论 basket PnL、capital-normalized metrics、sampled equity curve、recorded tape 与 reconstructed-event fallback；
- batch/API：typed grid expansion、去重、dataset 单次 prepare、持久化恢复、异步 history 与 variant drill-down；
- UI：独立 route、saved config/grid、leaderboard、equity curve 与 basket fill drill-down 的 responsive/static contracts。
- LIVE smoke：五个 provider 的 13,541 canonical events 和 259 actual-tick observations 完整 finalize；HTTP backtest 读取 `RECORDED_TAPE`，coverage `1.00000000`，生成 1 closed + 1 open basket 和确定性 result ID。
- workspace：183 tests passed，3 个 PostgreSQL integration tests 按环境跳过；typecheck、production build、`git diff --check` 与本地 LIVE browser smoke 通过。
