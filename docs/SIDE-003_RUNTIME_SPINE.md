# SIDE-003 - Runnable Runtime Spine

状态：**COMPLETE**
日期：2026-09-04
依赖：[SIDE-002](SIDE-002_FOUNDATION.md)

## 1. 已交付

- `apps/server`：Fastify HTTP + WebSocket runtime；
- `apps/web`：React/Vite S0 shell；
- `pnpm dev:s0`：并行启动 server `127.0.0.1:3001` 与 web `127.0.0.1:5173`；
- `pnpm smoke:s0`：真实监听随机本地端口，验证 HTTP、WebSocket 与 replay pipeline；
- SIDE-002 `spot-led` fixture 从 JSONL decoder、deterministic replay、runtime state 到浏览器；
- global `ingestSeq` allocator；
- application-level bounded client queue，溢出时生成带 suppression counts 的 `resync_required + snapshot`；
- WebSocket `bufferedAmount` 硬上限，慢客户端断开后必须重连取得 snapshot；
- REPLAY start/stop 与诚实的 source health 状态。

## 2. HTTP 与 WebSocket surface

```text
GET  /health/live
GET  /health/ready
GET  /health/sources
GET  /api/state
POST /api/replay/start
POST /api/replay/stop
WS   /ws
```

WebSocket 最小消息：

- `state_snapshot`；
- `ui_event`；
- `source_health`；
- `resync_required`，包含 `suppressedCountByKind` 与权威 snapshot。

无 secret、无 live adapter 时，runtime 只显示 `REPLAY`。点击 STOP 后 replay source 从 `live/fresh` 变为 `closed/stale`，不会留下误导性的 live health。

## 3. 验收记录

- [x] `pnpm install --frozen-lockfile`；
- [x] `pnpm check`：16 tests passed；
- [x] `pnpm build`：server TypeScript 与 web production bundle passed；
- [x] `pnpm smoke:s0`：HTTP + WebSocket + replay pipeline passed；
- [x] 浏览器验证 `REPLAY → START → 3 events → STOP`；
- [x] 浏览器控制台无 warning/error；
- [x] queue overflow 只保留一个 authoritative resync；
- [x] duplicate/backwards global ingest sequence rejected。

浏览器验收发现并修复了 React StrictMode effect cleanup 的旧 WebSocket error 回调竞态；修复后页面不会同时显示 `CONNECTED` 和错误告警。

## 4. 仍然明确不做

- jury、verdict 与 signal state；
- Coinbase/Binance、Hyperliquid、Bitquery live adapter；
- 0x/Jupiter paper broker；
- decision journal、markout、PostgreSQL；
- signer、transaction assembly、simulation 或 send。

这些边界分别进入 SIDE-004 及后续 tasks。SIDE-003 的完成只声明 **runtime spine 可运行**，不声明 S0 产品版本 已完成。
