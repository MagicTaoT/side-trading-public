# SIDE-004 - Deterministic Jury and Verdict Engine

状态：**COMPLETE**
日期：2026-09-04
依赖：[SIDE-002](SIDE-002_FOUNDATION.md)、[SIDE-003](SIDE-003_RUNTIME_SPINE.md)

## 1. 已交付

- 独立 `@side/signal-engine` package；
- 固定、可审计 `modelVersion=s0-v1`；
- CEX spot、CEX perp、DEX spot、DeFi perp 四个 segment jury；
- 30 秒 price impulse 与 aggressor flow imbalance；
- minimum quote notional、freshness、missing feature 与 transport gap gates；
- BUY / SELL / NEUTRAL jury 以及 BUY_BIAS / SELL_BIAS / NO_EDGE / INSUFFICIENT_DATA central verdict；
- `lastValidVerdict`，只在当前 data state insufficient 时展示；
- 确定性 `tick()`，即使所有 source 同时静默也能按时间变 stale；
- server state snapshot 与 WebSocket `signal_state` 集成；
- Web 最小 signal diagnostics，不提前实现 SIDE-005 正式 cockpit。

## 2. `s0-v1` 冻结规则

```text
window                         = 30,000 ms
freshness                      = 5,000 ms
price threshold               = ±2 bp
aggressor imbalance threshold = ±0.15
minimum quote notional        = 1,000 per segment
```

- CEX/Hyperliquid price 使用 BBO mid；DEX 使用 Bitquery economic-swap effective price；
- CEX/Hyperliquid flow notional = trade price × `sizeSOL`；
- S0 DEX 固定 WSOL/USDC，quote notional 使用 USDC 6-decimal atomic amount；
- price impulse 与 flow imbalance 都 available、同向且越过阈值时才投 BUY/SELL；
- missing、warming、minimum volume 未满足或 feature disagreement 都投 NEUTRAL，绝不 zero-fill；
- source 未观察、disconnect、stale 或 gap 时 jury 为 UNAVAILABLE；
- 三个以上 fresh jury 才计算有效 central verdict；3/4 同向为 BUY/SELL BIAS，否则 NO EDGE；
- 少于三个 fresh jury 为 INSUFFICIENT DATA，并携带 `PAPER_PREVIEW_DISABLED` reason。

所有数值计算使用 Decimal；feature 输出使用固定精度 string，保证同一输入序列化结果可复现。

## 3. Golden scenarios

| Scenario | Jury topology | Expected verdict |
|---|---|---|
| `spot-led` | CEX spot BUY、CEX perp BUY、DEX BUY、DeFi perp NEUTRAL | BUY_BIAS |
| `leverage-heavy` | CEX spot SELL、CEX perp SELL、DEX NEUTRAL、DeFi perp SELL | SELL_BIAS |
| `disagreement` | 两个 spot BUY、两个 perp SELL | NO_EDGE |
| `stale` | 先形成 4/4 BUY，再让 CEX spot disconnect、DEX gap | INSUFFICIENT_DATA；last valid BUY_BIAS |

`leverage-heavy` 是测试拓扑名，不会在没有 OI/funding 极端证据时输出 crowding 或 leverage 标签。

## 4. 验收记录

- [x] 四个 golden scenarios 输出与期望一致；
- [x] 同一 event log + model version 的 snapshot/transitions byte-for-byte 一致；
- [x] missing flow 保持 `status=missing, value=null`；
- [x] quiet + live transport 为 FRESH/NEUTRAL，closed/stale transport 为 UNAVAILABLE；
- [x] `tick()` 在 5,001 ms 使 silent source 变 stale，并拒绝时钟回退；
- [x] runtime HTTP snapshot 与 WebSocket 包含 `s0-v1` signal state；
- [x] `pnpm check`：26 tests passed（含 REST snapshot / WebSocket event 竞态去重）；
- [x] `pnpm build` passed；
- [x] `pnpm smoke:s0` passed；
- [x] 浏览器显示 2/4 fresh → INSUFFICIENT DATA，控制台无 warning/error。

## 5. 明确边界

- 当前 runtime fixture 只有 Coinbase spot 与 Bitquery，因此正确结果是 INSUFFICIENT DATA，不为演示伪造 BUY/SELL；
- live adapter 和 source-specific freshness calibration 属于 SIDE-006 至 SIDE-009；
- 正式 event-driven cockpit 属于 SIDE-005；
- paper preview disable 的服务端强制门属于 SIDE-010；
- funding/OI 只在后续有足够证据时生成 context label，不直接参与 `s0-v1` 方向票。
