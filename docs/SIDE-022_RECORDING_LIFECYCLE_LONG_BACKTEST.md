# SIDE-022 · 3h recorder lifecycle 与 3h/6h/12h/24h/3d backtest

状态：implemented and workspace-verified
日期：2026-09-08
版本边界：v0.4 冻结后的 v0.5 development work
安全边界：只记录公开行情并运行 `GROSS_THEORETICAL_V1`；无 signer、broadcast 或真实下单路径。

## 目标

把 SIDE-021 的“进程关闭时才形成一个可用 dataset”改造成可长期运行、可人工搬运的研究数据生命周期：

1. LIVE 行情连接持续运行，recorder 按 UTC 对齐的 3 小时窗口轮转；
2. 每个完成窗口自动生成可下载、带 SHA-256 的 `tar.gz`；
3. EC2 本地 dataset 与 archive 无限期保留，不做 S3、不设 TTL、不自动删除；
4. 本地导入后可在连续覆盖满足要求时建立 3h、6h、12h、24h 或 3d 虚拟数据集；
5. 长回测提供显式 STOP，避免误点后继续运行整个参数网格。

## 3 小时轮转与归档

默认窗口为 `00:00–03:00Z`、`03:00–06:00Z`，依此类推。窗口边界到达后的第一条 event/observation 会在 recorder 的同一串行队列内完成：

```text
finalize previous dataset
  -> checksum partitions
  -> write COMPLETE manifest
  -> create <dataset-id>.tar.gz + metadata SHA-256
  -> open next fixed-window dataset
  -> accept the triggering record
```

行情 WebSocket 不因文件轮转重连。队列默认最多积压 20,000 个操作；溢出或写入错误会把 recorder 标记为 FAILED，不能静默丢数据。LIVE 期间每 60 秒 checkpoint OPEN manifest，减少异常退出后 manifest 与 partial 文件计数差距。

配置：

- `SIDE_RECORDING_DIR`：dataset root，默认 `data/recordings`；
- `SIDE_RECORDING_ARCHIVE_DIR`：archive root，默认 `data/recording-archives`；
- `SIDE_RECORDING_SEGMENT_MS`：窗口长度，默认 `10800000`；生产策略固定为 3 小时，此 override 只用于测试/诊断。

正常停止时，尚未满 3 小时的当前窗口也会 finalize 和归档；它仍是真实、可校验的 partial-duration dataset，不会被伪装成完整 3 小时覆盖。强制 kill 留下的 OPEN/`.partial` 仍 fail closed，需要显式 recovery。

## 人工 retention workflow

`/backtest` 的 `3H RECORDING PACKAGES` 显示 archive 大小与 SHA-256 前缀，并提供：

- `DOWNLOAD`：下载原始 `tar.gz`；
- `DELETE → CONFIRM DELETE`：两步 UI 确认；HTTP 还要求 `x-side-confirm-delete: <dataset-id>`；
- delete 只允许 COMPLETE、非 active、未被 composite 引用的 dataset；成功后同时删除 archive 与服务器端 dataset；
- rotation、timer 和 archive creation 从不调用 delete。

本机导入：

```bash
pnpm recording:import -- /absolute/path/to/live-....tar.gz
```

导入拒绝多根目录、非法 dataset ID、非 COMPLETE manifest、已有同名 dataset、损坏 partition、计数或 observation 顺序异常。

公开部署前，这些 download/delete/build/stop mutation routes 必须由 SIDE-023 passcode/admin session 保护；SIDE-022 本身不把未认证接口视为可公网发布。

## 旧数据恢复

用于 v0.4 遗留 OPEN/partial 录制的显式命令：

```bash
pnpm recording:recover-recent -- 12
```

recovery 读取旧 dataset 的 observation partitions，按 observation timestamp 拆入 UTC 3 小时窗口；同 timestamp 重叠时采用较新 source process。输出是用于策略回测的 `recovered-tape-*` COMPLETE dataset、对应 archive、SHA-256 与 recovery report。

边界：recovery 包只重建 observation tape，不复制 canonical event log；原始 source dataset/files 完整保留，因此 canonical 数据没有被丢弃或覆盖。真实断档原样保留，不插值、不前向填充。旧数据清理仍是后续人工操作。

## 3h / 6h / 12h / 24h / 3d 虚拟数据集

`POST /api/backtest-datasets/composites` 只接受 `hours=3|6|12|24|72`。页面提供对应的五个 `BUILD … DATASET` 操作。

构建器：

1. 只读取 COMPLETE、带 hash、包含 observation tape 的非 composite datasets；
2. 选择截至最新 observation 的目标区间；
3. overlap timestamp 采用较新 dataset；
4. 首尾及任意相邻 observations 的 gap 默认不得超过 5 秒；
5. 缺少任何覆盖即返回错误，不创建虚假的完整时长结果；
6. 成功后只写一个带 segment IDs/hashes/range 的虚拟 manifest，不复制大型 partition。

运行 composite 时会重新验证所有 constituent dataset identity，并将目标区间内 observations 合并、去重、排序。底层 segment 只要被 composite 引用就不能删除；需要先明确处理 dependent composite。

AWS 与本机运行同一逻辑，没有“大 batch 禁用”分支。AWS 数据不连续时，build 自然 fail closed。用户手动下载所有包到本机、导入并取得目标连续覆盖后再运行长回测。

## STOP 语义

`STOP BACKTEST` 调用既有 cancel contract：

- QUEUED experiment 可在执行前取消；
- RUNNING experiment 设置 durable `cancelRequested`；
- 当前同步 variant 保持原子完成，随后所有未开始 variants 标记为 CANCELLED；
- 已完成 variant 及结果不被删除；
- server 异常重启时遗留非终态 experiment 仍明确标记 FAILED。

它不是进程 kill，也不会留下半个 variant result。单个 variant 若已接近完成，STOP 可能在它完成后才生效。

## 已知限制

- archive 同时保留未压缩 dataset，会增加 EC2 磁盘占用；这是用户选择的手动 retention policy，需要在 SIDE-023/部署监控中加入磁盘告警；
- 当前 archive 使用 gzip tar，不是 Parquet/Zstd；优先保证立即可下载与可恢复；
- 未正常关闭的最后一个窗口需要显式 recovery；
- 所有组合时长都是连续 observation-tape research dataset，不支持 composite canonical-event replay；
- backtest 仍是单进程、单队列、gross theoretical model；长数据不会改变 fee/slippage/funding 缺失的口径。

## 验收

- rotation：跨边界时前后 dataset 都 COMPLETE，触发边界的 record 不丢失；
- archive：只归档 COMPLETE dataset，SHA-256/list/download/import/delete contract 可验证；
- retention：没有定时或自动 delete；
- composite：连续覆盖成功；首尾缺失或中间 gap 明确失败；segment identity 变化时加载失败；
- API/UI：3h package list、download、二次删除确认、3h/6h/12h/24h/3d build、STOP；
- historical recovery：过去约 12 小时形成 UTC 3h tapes，source raw retained；
- real-data smoke：至少一个 recovered 3h tape 运行两次产生相同 result ID/hash。

最终验证：188 tests passed，3 个需要独立 PostgreSQL database 的 integration tests 按环境跳过；全仓 typecheck、production build 与 `git diff --check` 通过。真实 recovered 3h tape 两次运行得到相同 result ID，coverage 100%。
