# SIDE-002 - Canonical Event and Replay Foundation

状态：**COMPLETE**
日期：2026-09-04
依赖：SIDE-001 scope freeze

## 1. 目标

建立 S0 所有 live adapter、signal、UI gateway 和 paper audit 共用的可信事件底座。SIDE-002 只实现本地、无凭证的基础能力，不把数据源 preflight 或 venue adapter 偷渡进来。

## 2. 交付范围

- pnpm + TypeScript workspace；
- `@side/market-core` canonical `MarketEvent` discriminated union；
- `UiEvent` contract；
- Zod runtime validation，外部数据 fail closed；
- 金额、原生数量、slot、sequence 和纳秒时间原文使用 string，避免 IEEE-754 精度损失；
- source provider 与 economic venue 分离；
- Bitquery `provider-indexed` finality 原样建模；
- canonical JSONL encode/decode；
- 多分片事件按全局 `ingestSeq` 确定性合并；
- 注入式 replay clock、REPLAY quality 标记与 `spot-led` golden fixture。

## 3. 明确不做

- Coinbase、Binance、Hyperliquid 或 Bitquery 网络连接；
- 0x/Jupiter API 调用；
- jury/verdict engine；
- Web UI、PostgreSQL 或 AWS deployment；
- signer、transaction assembly、simulation 或 broadcast。

这些能力依赖本 task 的 contract，但拥有各自独立的验收和失败面。

## 4. 验收条件

- [x] workspace dependency install 有 lockfile；
- [x] `pnpm typecheck` 通过；
- [x] `pnpm test` 通过；
- [x] 合法 trade、Bitquery onchain swap 与 UI event 可通过 runtime parser；
- [x] number amount、无效 UI batch 与损坏 JSONL 被拒绝；
- [x] shuffled partitions 产生固定 `ingestSeq` 顺序；
- [x] 同一 fixture 重放结果 byte-for-byte 一致；
- [x] duplicate `ingestSeq`/`eventId` fail closed；
- [x] 无 signer/send 依赖或源文件。

验收记录：Node `v26.0.0`、pnpm `11.5.2`；`pnpm check` 共 11 tests passed，`pnpm build` passed。依赖安装脚本默认拒绝，只在 `pnpm-workspace.yaml` 中明确允许锁定测试工具所需的 `esbuild`。

## 5. 后续接口

下一个 adapter task 必须把原始 packet 映射成 `@side/market-core` 事件并提交脱敏 fixture；不能让浏览器直接消费 venue schema，也不能使用 `any` 绕过 parser。signal task 只能消费通过 validation、dedupe、ordering 和 freshness gate 的 canonical events。
