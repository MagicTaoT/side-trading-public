# SIDE-005 - Event-driven Cockpit

状态：**COMPLETE · R0 REPLAY RUNNABLE**
日期：2026-09-04
依赖：[SIDE-003](SIDE-003_RUNTIME_SPINE.md)、[SIDE-004](SIDE-004_SIGNAL_ENGINE.md)

## 1. 已交付

- 固定 `SOL / USD · 5 MIN DECISION WINDOW` cockpit；
- CEX spot、CEX perp、DEX spot、DeFi perp 四个稳定 jury zones；
- SPOT / PERP 两行之间约 82px 高的 compact full-width verdict bar；BUY/SELL 操作分居左右并对应 power 方向，结论、解释与 WAIT 居中，不覆盖 bubble field；
- mode、原子 CEX profile shape、jury coverage、source freshness、model version、last valid verdict；
- 75 ms visual micro-batch，保留 source、instrument、kind、`×N`、buy/sell count、双边 notional、最大 notional与价格范围；
- trade/onchain-swap 才生成经济成交 bubble；BBO 只产生 quote pulse，不伪装成成交；
- event-id seeded bubble geometry、手动 pause、hidden-page snapshot recovery、`prefers-reduced-motion`；
- weighted matrix：Spot/Perp 行高固定，行内 BUY/SELL 随 5m volume 在 35%–65% 间变化，source subpanel 在 30%–70% 间变化；
- BUY / SELL / WAIT paper drawer 外壳，消费 server 提供的明确 `REPLAY` preview contract；
- R0 页面内明确显示 `REPLAY`、`PAPER MODE` 与 `LIMITED S0 COVERAGE`。

## 2. 十秒可读信息

中间 verdict bar 始终直接回答四个问题：

1. 当前 verdict 是 BUY BIAS、SELL BIAS、NO EDGE 还是 INSUFFICIENT DATA；
2. juries 是否达到 3/4 一致，或 coverage 尚未 ready；
3. `FIRST OBSERVED BY SIDE` 的 leading segment；
4. 一句由当前 jury state 生成的原因说明。

当前短 fixture 的诚实结果是：`2/4 fresh · two buy-flow observations · CEX SPOT first · INSUFFICIENT DATA`。页面不会把只有 spot 证据的回放包装成方向性结论。

## 3. Visual event contract

`UiEvent` 在 SIDE-005 增加：

- `sourceProvider`、`instrumentId`、`quoteAsset`；
- `minPx`、`maxPx`；
- 已存在的 count、buy/sell count、buy/sell/max notional 由 runtime 填充。

event rail 按 `zone + source + venue + instrument + quote + kind` 做 75 ms 分桶。不同 venue 不合并；混合方向保留 buy/sell 两侧数据并显示为 flat，而不是只保留净方向。成交 bubble 另按 side-specific lane 分桶，以首个 canonical event id 作为稳定视觉身份：首次入场播放一次 0.8 秒、继承 BUY/SELL 颜色的外扩高光圈。Bitquery 的高频 DEX 流采用额外的纯视觉压缩：低于 `$1,000` 的 swap 按固定 1 秒、instrument 与 side 跨协议合并成 `DEX FLOW ×N`，保留双边 count/notional、最大单笔、价格与时间范围；达到 `$1,000` 的 material swap 保留 canonical event id 并独立显示。原始 swap 仍逐笔进入 signal、5 分钟 flow、reference 与审计链路。用户可独立选择 30s、60s、3m 或 5m 的 bubble visual window（默认 60s）；opacity 在所选窗口的前半段由 85% 降至 30%，随后在窗口边界前降至 10%，到期移除。切换窗口只改变视觉留存，不改变 30 秒 signal/verdict 或 5 分钟 realized-flow 布局口径。高频非成交 state event 继续受每 zone 50-event hard bound 约束。

布局采用分层 volume 权重：Spot/Perp 保持等高以便比较；每行 BUY/SELL 按该 market 的 5m realized volume 分配宽度并 clamp 到 35%–65%；每个象限内的两个 source panel 再按各自 volume 分配宽度并 clamp 到 30%–70%。比例量化到 0.5 percentage point，并使用平滑 CSS transition，避免逐笔微小变化造成视觉抖动。verdict bar 位于 SPOT 与 PERP 行之间的正常文档流中，始终全宽且不随分界线移动。

Bubble 坐标由 event id 经独立的 32-bit avalanche mixing 生成 X/Y 序列，禁止从同一 hash 的重叠位段直接取坐标，以免结构相似的 Bitquery bucket id 形成对角线相关。边缘留白按 bubble 直径动态计算：小 bubble 使用更大可用区域，大 bubble 保留足够裁切安全区；相同 event id 的 replay 坐标仍完全可复现。

## 4. Paper drawer 真值边界

- server snapshot 提供 frozen、response-shaped 的 0x BUY replay fixture；
- drawer 固定标注 `REPLAY FIXTURE · NOT A LIVE QUOTE`；
- `minimum output`、`price impact`、`fee breakdown` 未供应时显示 unknown，不猜测；
- SELL fixture 缺少 fresh USDC→SOL anchor，因此 fail closed 为 unavailable；
- WAIT 不要求 estimate；
- 所有 record 按钮在 server implementation 进入 SIDE-010 前保持 disabled；
- 没有 wallet、signer、transaction assembly 或 broadcast code path。

Bitquery realized swap 与 0x-shaped preview contract 分开呈现，前者不会被重命名成可执行 estimate。

## 5. 验收记录

- [x] `pnpm check`：33 tests passed；
- [x] `pnpm build` passed；
- [x] `pnpm smoke:s0`：HTTP + WebSocket + replay pipeline passed；
- [x] micro-batch 同桶合并、跨 venue/超窗不合并、双边字段不被 net away；
- [x] seeded visual geometry byte-for-byte deterministic 且有界；
- [x] 360 / 736 为单列、1024 为双行 verdict strip、1440 为三列 verdict strip 的 breakpoint contract；
- [x] 浏览器完成 replay、BUY/SELL/WAIT drawer、motion pause 交互；
- [x] 浏览器显示 `2/4 · CEX SPOT leading · INSUFFICIENT DATA`；
- [x] 浏览器控制台无 warning/error。

## 6. 明确边界

- SIDE-005 不接 live venue；source preflight 与 profile selection 从 SIDE-006 开始；
- frozen preview 只证明 UI contract，0x live estimate adapter 属于 SIDE-009；
- paper estimate broker 属于 SIDE-010；decision persistence 与 markout 属于 SIDE-011；
- 当前 bubble history 只保留 rolling 5m；非成交 state history 仍 bounded，不引入长期图表、策略编辑器或真实执行。

SIDE-005 完成后，第一个可运行里程碑成立：**R0 · REPLAY RUNNABLE**。
