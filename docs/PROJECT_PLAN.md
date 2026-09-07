# SIDE - 产品、范围与交付计划

> 工作定义：**See what the market is actually saying - and where it disagrees.**

状态：规划基线 v0.2；SIDE-001 至 SIDE-005、SIDE-010、SIDE-011、SIDE-016 complete；SIDE-006 local required gates complete / target AWS gate blocked；SIDE-007 至 SIDE-009 runtime adapters 已接入但 R1 完整退出门未完成；R0 REPLAY RUNNABLE；S0 产品版本 in execution
日期：2026-09-07
目标市场：SOL only
核心决策周期：未来 5 分钟（MVP 唯一窗口）

## 0. 结论先行

项目值得做，但必须区分两个交付轨道：

1. **市场判断与模拟验证**：使用真实行情与报价 API，以 paper run 验证短窗口判断；已发布版本不使用真实资金、不签名、不广播。
2. **执行扩展**：在独立版本中验证真实执行，配置凭据、风险限额和恢复机制。

用户新增的 Binance、KuCoin、OKX spot/perp、Solana SOL-USDC/SOL-USDT、Hyperliquid SOL-perp 全部进入 Project MVP。S0 按 [SIDE-001](SIDE-001_SOURCE_FREEZE.md) 冻结为：Coinbase `SOL-USD` + Coinbase Derivatives `SLP` 原子 CEX profile 优先，任一 source 未通过目标美国 AWS region preflight 时整组回退 Binance spot/perp；Hyperliquid 提供 DeFi perp；Bitquery 提供 WSOL/USDC decoded realized DEX flow；0x 提供 5 秒共享显示 estimate 与独立 action-time paper estimate，Jupiter 只做用户明确触发的 fallback。为了不把范围膨胀成交易终端，第一阶段只采对核心判断有用的字段，并在 UI 中聚合成四个 jury，不增加多资产、策略编辑器或多场所真实下单。

最重要的 UI 调整是：**首页由事件驱动，而不是一组定时刷新卡片。** 每个被可视层接纳的标准化事件都会在其来源区域留下瞬时、语义化反馈；中央 verdict 只在累积证据跨越阈值后改变，避免随着每个 tick 闪烁。

---

## 1. 产品目标与版本边界

SIDE 帮助 SOL 交易者判断短窗口内的方向、一致性和等待时机。初始窗口为 5 分钟，输入来自 CEX/DeFi 的现货与永续市场。

- 用价格和主动买卖流相互确认，展示数据新鲜度与覆盖范围。
- 输出 BUY BIAS、SELL BIAS、NO EDGE 或 INSUFFICIENT DATA，并保留可解释证据。
- 已发布版本以模拟决策、自动 dry-run、录制与回测验证信号。
- 真实执行属于独立扩展，以版本、凭据、风险限额和执行记录区分。
- 报价服务提供执行估算，不作为真实成交或市场方向输入。

---

## 2. 产品定义

### 2.1 One user

正在观察 SOL、准备在未来 5 分钟做一次方向性决策的主动 crypto trader。

### 2.2 One job

> 在准备发起一笔固定 $10k 的 SOL↔USDC 链上 swap 前，让我在 10 秒内判断跨市场证据是否支持该方向、是否应该等待，并看到此刻实际可执行的链上估算输出。

### 2.3 产品 thesis

单一价格掩盖了 fragmented markets 的分歧。对短周期交易者而言，**谁先动、什么资金在动、spot 与 perp 是否互相确认、在指定规模下是否真的能成交**，比再画一条技术指标更接近真实决策。SIDE 不承诺预测价格；它把当前证据归纳为 supports buy / supports sell / conflicted，并用 forward markout 检查这项归纳是否有用。

### 2.4 Why now 与待验证假设

当前替代流程通常是同时打开 CEX spot/perp、Hyperliquid 和 Solana quote 页面，手工判断是否一致，再回到 swap UI。核心假设不是“市场规模很大”，而是：**在价格快速变化时，手工切页会让交易者遗漏 leverage crowding、跨 venue 分歧或真实 $10k 可执行价格。**

现在值得验证，因为 Solana 聚合执行已经可以返回 route 与可执行指令，而跨 CeFi/DeFi 的实时数据仍分散。第一轮用户验证门槛：5 位真实活跃交易者中，至少 4 位能在 10 秒内正确读出 bias/分歧/可执行输出，且至少 3 位认为它替代了自己现有的多页面检查步骤。没有通过前，不宣称存在产品市场匹配或可交易 alpha。

### 2.5 核心输出

- `BUY BIAS`
- `SELL BIAS`
- `NO EDGE`
- `INSUFFICIENT DATA`（系统健康状态，不是交易判断）
- 伴随明确的结构标签：`SPOT-LED`、`LEVERAGE-HEAVY`、`CROSS-VENUE CONFIRMED`、`MARKET DISAGREEMENT`
- 四个 jury 的离散判断与原因，而不是不可解释的百分比
- 数据完整性：fresh / degraded / stale、事件延迟、缺失来源

### 2.6 非目标

首版明确不做：

- 多币种、watchlist、portfolio；
- TradingView 替代品、K 线工作台、RSI/MACD；
- 新闻、社交情绪、prediction market；
- LLM 生成买卖建议；
- 自动策略、杠杆设置、仓位管理；
- CEX 或 Hyperliquid 真实下单；
- maker queue 的虚假 paper fill；
- 任何要求服务端保存用户钱包私钥的流程。

---

## 3. 唯一主流程

```text
打开 SIDE
  -> 自动进入 SOL / USD、5 MIN WINDOW、PAPER MODE
  -> 看到实时事件在四个市场区域发生
  -> 中央 verdict 只在跨市场证据成立时变化
  -> PAPER BUY / SELL 框直接看到双向 $10k estimate 或明确 dry 状态
  -> 点击 PAPER BUY、PAPER SELL 或 RECORD WAIT
  -> review 固定名义金额、0x 估算输出、最小输出、route 与 quote age
  -> RECORD PAPER ORDER（不签名、不广播）
  -> 保存当时全部证据、报价和模型版本
  -> +5m 自动计算 markout
  -> 在同一页面看到结果与 shadow performance
```

主流程不要求登录、不要求钱包、不要求用户配置十几个参数。默认 paper notional 为 10,000 USDC。S0 不开放修改，减少状态和测试面；M0 再允许在受控范围内修改。

S0 的“双向 $10k paper estimate”使用明确且可重放的 exact-in 口径：

- **BUY SOL**：固定输入 10,000 USDC，记录预计得到的 SOL；
- **SELL SOL**：先向同一 estimate provider 请求一次 fresh `10,000 USDC → SOL` anchor，再以该 estimated SOL 数量请求 `SOL → USDC` exact-in；同时固化两个 request id、时间、provider、derived `referencePx` 与 `amountInSOL`；
- bid/ask、amount out、min output 和 route 分方向保存，不能把 BUY 与 SELL 都写成“输入 10,000 USDC”，也不能把两侧混成一个与规模无关的 DEX mid。

---

## 4. 功能需求

### S0 - Product validation slice

| ID | 需求 | 完成标准 |
|---|---|---|
| S0-01 | SOL-only 固定上下文 | 页面打开即为 SOL、5 MIN WINDOW；没有多资产或 timeframe 选择器 |
| S0-02 | 四类最小 live evidence | CEX 原子 profile（Coinbase spot + `SLP` 优先，Binance spot/perp fallback）、Hyperliquid `SOL` perp、Bitquery WSOL/USDC realized swaps 各自产生真实标准化事件；profile 选择门按 SIDE-001 固化 |
| S0-03 | 四类 Market Jury | CEX spot、CEX perp、DEX spot、DeFi perp 各给 BUY/SELL/NEUTRAL 与 1-2 条可解释证据 |
| S0-04 | Event-driven 首页 | 每个 UI gateway 接纳的 visual event 在具体 venue lane 触发局部反馈；100 ms batch 明示 `×N` |
| S0-05 | Verdict 状态机 | BUY BIAS / SELL BIAS / NO EDGE；数据不足时单独显示 INSUFFICIENT DATA |
| S0-06 | Paper order | 固定 SOL-USDC、双向 $10k 口径；按钮 5 秒刷新 display-only estimate，点击后 fresh 0x preview → record；0x 失败后只能由用户明确触发 Jupiter fallback；无 signer/send code path |
| S0-07 | 决策记录与 5m markout | PAPER BUY / PAPER SELL / RECORD WAIT；保存 decision-time evidence；+5m 计算或明确 unscored |
| S0-08 | Demo resilience | 一段明确标记为 REPLAY 的黄金场景；最小 source health/freshness；部署链接可运行 |

### M0 - 用户要求的完整 Project MVP

| ID | 需求 | 完成标准 |
|---|---|---|
| M0-01 | 三家 CEX spot/perp | Binance、KuCoin、OKX 的目标品种均 live；metadata、单位、freshness、reconnect 可验证 |
| M0-02 | 两个 Solana DEX pair | SOL-USDC、SOL-USDT 双向、固定名义金额 quote 分开显示；每个 pair 沿用 S0 的分方向 exact-in 定义并保存 reference |
| M0-03 | 实际链上 swap events | 至少覆盖选定 SOL-USDC/USDT pools/program allowlist；实际成交与 quote event 分开建模、去重并处理确认状态 |
| M0-04 | Hyperliquid hardening | BBO/L2、trades、mark/oracle、funding、OI；snapshot/reconnect/metadata 完整 |
| M0-05 | Venue lanes | 三家 CEX 各有稳定 lane；DEX 两 pair 各有 lane；每个 event 能看出来源、类型、age 与改变的字段 |
| M0-06 | 完整 motion grammar | micro/meso/macro 三级动效、pause、reduced-motion、性能预算与页面失焦策略 |
| M0-07 | Record/replay | 所有标准化事件可录制；同一 replay + model version 产生相同 verdict transition |
| M0-08 | Paper/shadow evaluation | 0x reference、+5m markout、gross/net、sample size 与 unscored |
| M0-09 | AWS hardening | HTTPS、source health、structured logs、备份、重启恢复、secret 管理 |
| M0-10 | Stablecoin basis gate | USDT 数据进入 verdict 前必须完成 USDC/USDT basis 定义、freshness 与异常保护；否则只作旁路显示 |

### M1 - 产品化补强

- 真实多档 order-book paper VWAP；
- lead/lag 事件回放与可审计因果链；
- stablecoin basis 归一化；
- 0x route/program validation、transaction simulation；
- feature-gated 真实 0x swap；
- 长周期 shadow performance 与参数版本比较。

### P2 - 暂不承诺

- CEX/Hyperliquid live execution；
- 多资产与账户体系；
- 移动端完整交易；
- alerting、策略编辑器、自动化下单；
- 复杂机器学习或在线模型。

---

## 5. UI / UX 方向

### 5.1 信息架构

桌面首页改为由方向与市场类型共同定义的四象限；full-width verdict bar 位于 SPOT 与 PERP 两行之间，BUY/SELL 操作分居左右并与 power 方向对齐，结论、解释和 WAIT 居中；顶部保留 SIDE、SOL/USD、5 MIN WINDOW、数据状态与 PAPER MODE：

```text
┌────────────────────────────────────────────────────────────────────┐
│ SIDE  SOL/USD  5 MIN WINDOW   LIVE · PAPER MODE   freshness 184ms │
├───────────────────────────────┬────────────────────────────────────┤
│ SPOT · BUY POWER              │ SPOT · SELL POWER                  │
│ ┌──── CEX ────┬──── DEX ────┐│┌──── CEX ────┬──── DEX ─────────┐ │
│ │ 5m bubbles  │ 5m bubbles  │││ 5m bubbles  │ 5m bubbles      │ │
│ └─────────────┴──────────────┘│└─────────────┴─────────────────┘ │
├──────────────────── MARKET VERDICT ───────────────────────────────┤
│ PERP · BUY POWER              │ PERP · SELL POWER                  │
│ ┌──── CEX ────┬──── DEFI ───┐│┌──── CEX ────┬──── DEFI ────────┐ │
│ │ 5m bubbles  │ 5m bubbles  │││ 5m bubbles  │ 5m bubbles      │ │
│ └─────────────┴──────────────┘│└─────────────┴─────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

视觉基调：graphite 黑、暖白文字、低饱和结构线；绿色只表示 buy/up，红色只表示 sell/down，青色表示 neutral/live，琥珀色表示 warning/stale。不同 venue 不用彩虹配色，避免认知负担。

四个区域不是固定等分，而是一个 **weighted matrix**：上下 Spot/Perp 各占 50%，保持稳定的纵向阅读地图；左右 BUY/SELL 分界线则由 rolling 5m normalized strength share 决定。verdict 使用两行之间的独立全宽条带，不跟随分界线移动，也不遮挡 bubble。布局比例使用 2 秒 EMA、每秒最多移动 2 个百分点，并 clamp 在 35%-65%，避免单笔大额成交让界面跳动或把某区挤到不可读。S0 的 strength 先计算每个 source 内部的 buy share，再按 versioned reliability weight 合并，不能直接把 USDC、USDT 与 USD notional 假设为同一数值相加。分界线只是描述性 flow balance，不等同于 directional verdict；verdict 仍由四个 jury 与数据健康门决定。

#### Bubble field 语义

- 上排只显示 spot trades/swaps，下排只显示 perp trades；左侧为 aggressor BUY，右侧为 aggressor SELL。
- Spot 子区为 `CEX | DEX`；Perp 子区为 `CEX | DEFI`，其中 Hyperliquid 属于 DEFI perp，不能标成 CEX。
- 一个 bubble 代表一个通过 schema、dedupe 与 side-classification gate 的真实经济成交事件；高频小额事件允许显式合并为 `×N` micro-batch bubble，但 summary 必须计入全部事件。
- bubble **面积**映射 volume，因此实现为 `radius = clamp(k × sqrt(volume), rMin, rMax)`；对极端大单在配置的 p99 截断视觉尺寸，但 tooltip 保留原始 volume。
- bubble 到达时从所属 subpanel 边缘进入并轻微 settle；随事件年龄降低 opacity；恰好在 rolling five-minute window 之外移除。颜色、位置或漂移动画不能改变 side/venue 的语义。
- 每个 subpanel 固定显示 accepted event count、5m total volume、在所属象限的 volume share 与 freshness；最大 bubble 可显示 venue，其他 bubble 通过 hover/focus 读取 source、time、side 与 volume。
- `bbo`、`book_delta`、`dex_quote`、funding 与 OI 只更新 summary、context 和 verdict，不产生 trade bubble。否则会让报价或状态变化伪装成真实成交。
- verdict 使用独立 in-flow strip；bubble 在各自 Canvas clip region 内运动，不能穿过象限边界。

### 5.2 Live event 视觉语法

“每个 event 有效果”不等于让所有数字持续闪。动效必须表达事件类型、方向、来源与重要度。

| 事件 | 对应区域的即时反馈 | 跨区域反馈 | 建议时长 |
|---|---|---|---:|
| `trade` | 在对应 spot/perp、buy/sell、CEX/DEX/DEFI subpanel 生成 bubble；面积按 volume 映射并保留 5 分钟 | 达到异常阈值时向 verdict 发出一条 evidence tracer | 进入 300-700 ms；驻留至 5m 到期 |
| `bbo` | bid 或 ask 数值定向 tick；卡片边缘一次短脉冲 | spread 或 mid 异常时才传播 | 180-350 ms |
| `book_delta` | 深度轮廓局部隆起；同一 100 ms 内合并并标 `×N` | 仅 imbalance 越阈值时传播 | 200-450 ms |
| `funding` | funding 字段缓慢翻页，背景出现一次低频呼吸 | crowded leverage 状态改变时传播 | 500-900 ms |
| `open_interest` | OI 条带伸缩，并标明价格同向/反向 | 触发 leverage-heavy 标签时传播 | 450-800 ms |
| `dex_quote` | Paper drawer 内 SOL → stable 路径流动；amount out 与 min output tick | S0 不传播到 verdict；M0 只有跨 numeraire gate 通过后才可作 context | 350-700 ms |
| `onchain_swap` | S0 Bitquery provider-indexed 或 M0 confirmed event 通过各自 coverage/gap gate 后，在 DEX buy/sell subpanel 生成 bubble；标 side、size 与 coverage | 形成真实 DEX flow cluster 时才传播 | 进入 300-700 ms；驻留至 5m 到期 |
| `route_change` | route segment 重新排列并高亮变动的 pool/source | 不直接改变 verdict，除非价格/impact 也变 | 450-750 ms |
| `source_health` | 受影响 lane/区域冻结、去饱和、显示 stale/reconnecting | fresh jury 少于 3 时逻辑状态立即进入 INSUFFICIENT DATA；200-500 ms 仅是视觉退场时长 | 200-500 ms |
| `signal_changed` | 中央 verdict 形态切换并锁定最短 dwell time | event tape 写入可审计原因 | 450-700 ms |

### 5.3 高频事件的处理原则

- 浏览器只维护当前 rolling 5 分钟的 bubble/state，并用单一 Canvas/WebGL layer 渲染；不为每个 event 创建永久 DOM 节点。
- 大额 `trade`/`onchain_swap` 逐事件生成 bubble；密集小额事件按 `venue + instrument + side` 进入 50-100 ms micro-batch，并在 bubble/tooltip 明示 `×N`。
- 高频 BBO/book delta 进入独立 100 ms visual micro-batch，只更新 summary/轮廓，不生成成交 bubble；必须显示 `×N events`、净方向和最大强度。
- UI gateway 对每个 zone 设置上限，建议 10 visual events/s；超过后聚合。验收口径为：同一 replay 中所有 `UiEvent.count` 之和等于被可视层接纳的 normalized event 数，零静默丢失。
- 动画运行在 `requestAnimationFrame`；粒子/轨迹用 Canvas 或单一 SVG overlay，React 只更新业务状态。
- 页面失焦时降到 1 fps，恢复后先给 state snapshot 再继续事件。
- 支持 Pause Motion 与 `prefers-reduced-motion`；降低动效时仍通过文字、形状和 event tape 传达事件。

### 5.4 避免误导的 UX 规则

- 明确标记 `LIVE`、`REPLAY` 或 `SIMULATED EVENT FEED`，三者不能混用。
- quote 必须显示方向、名义金额、quote age、source、estimated/min output；不叫“锁价”。
- 数据 stale 时只冻结受影响区域的最后数值并显示 age；中央可交易 verdict 立即失效，进入 `INSUFFICIENT DATA`，绝不沿用旧信号。
- verdict 不因单一大单立即翻转；需 minimum dwell + hysteresis。
- `NO EDGE` 是正常、专业的产品输出，不是错误态。
- `Verdict` 与 `DataState` 正交：`Verdict = SUPPORTS_BUY | SUPPORTS_SELL | NO_EDGE`；`DataState = LIVE | DEGRADED | INSUFFICIENT_DATA | REPLAY`。
- 任何百分比都必须能拆成 freshness、jury agreement 与 sample coverage；首版优先显示 `3/4 market segments confirm`，不显示神秘“AI 78%”。

### 5.5 Paper order drawer

只保留做决定所需的信息：

- BUY / SELL；
- notional；
- pair（SOL-USDC 或 SOL-USDT）；
- execution reference = 0x estimated executable output；
- amount out / minimum out；
- route sources；0x Solana swap-instructions 当前不提供可直接展示的 price-impact 或 fee breakdown，若产品另行计算，必须标明独立数据源、公式与 `estimated`，不能归因于 0x 响应；
- quote age 与重新报价条件；
- `RECORD PAPER ORDER`；
- `RECORD WAIT`：无须请求交易 quote，但必须保存当时 verdict 与 evidence；
- 明示：`No wallet. No funds. Nothing onchain.`

真实 swap 延伸版需要不同的 CTA 与 review 文案，不能把 paper 按钮悄悄升级为真钱按钮。

---

## 6. Signal 与 Market Jury

### 6.1 原则

- deterministic、可解释、可重放；
- 输入只来自 market microstructure；
- 保留原生数值、单位、event time 与 receive time；
- 先做可靠的规则系统，不在样本不足时做 ML；
- 所有阈值带 `model_version`，从 replay 调整，不在 demo 中手工改结果。

### 6.2 四类 jury

#### CEX Spot

输入：三家 spot 的短周期 mid return、aggressive buy/sell notional、BBO spread、有限深度 imbalance、venue lead/lag。
输出：BUY / SELL / NEUTRAL，以及最强的 2-3 个原因。

#### CEX Perps

输入：三家 perp 的 price impulse、basis、aggressor flow、OI 变化、funding 与下一结算时间。
注意：funding interval 必须按实际窗口归一化，不能统一假设为 8 小时。

#### DEX Spot

S0 输入：Bitquery WSOL/USDC decoded economic swaps 的 effective price、aggressor flow、protocol/market coverage 与 source health。M0 再加入 SOL-USDT、直接 RPC/managed stream 的可审计 confirmed swap ingest，以及持续、多规模 executable quote context。quote 是前瞻估算，onchain swap 是滞后的已实现成交，两者不能混为一个事件。任何 impact/fee 指标都必须独立推导并明确标成估算，不能假设 0x 响应原生提供。
DEX 没有传统 BBO 时，不能伪造一个与交易规模无关的“mid”。

#### DeFi Perps

输入：Hyperliquid `SOL` 的 BBO/L2、trades、mark/index/oracle、funding、OI 与 CEX composite basis。

### 6.3 S0 判定逻辑：先用能完整解释的多数规则

S0 不先做半定义的加权分数。每个 segment 只使用方向输入，funding/OI 暂时只生成 crowding 标签：

| Feature | Calculation | Window | 初始方向规则 | Missing behavior |
|---|---|---:|---|---|
| Price impulse | `(mid_now / mid_30s_ago - 1) × 10,000` | 30s | > +2 bp 支持 BUY；< -2 bp 支持 SELL | NEUTRAL |
| Aggressor imbalance | `(buy_notional - sell_notional) / total_notional` | 30s | > +0.15 支持 BUY；< -0.15 支持 SELL；同时要求 minimum volume | NEUTRAL |
| CEX spot/perp jury | price impulse 与 aggressor imbalance | 30s | 两者同向才投 BUY/SELL，否则 NEUTRAL | venue 不足则 jury unavailable |
| Hyperliquid jury | price impulse 与 aggressor imbalance | 30s | 同上 | unavailable |
| DEX spot jury | Bitquery economic-swap price impulse + aggressor imbalance | 30s | 两者同向且满足 minimum volume 才投 BUY/SELL，否则 NEUTRAL | transport/backfill gap 未修复则 unavailable |

中央 verdict：3/4 **market segments** 同向才显示 BUY BIAS 或 SELL BIAS；否则为 NO EDGE。少于 3 个 fresh segment 时 `DataState = INSUFFICIENT_DATA`，禁用 paper preview，并另显带时间戳的 `lastValidVerdict`。健康门不等待 2 秒 dwell。

这些阈值只是 replay 的初始假设；模拟验证版必须展示计算表和 golden scenarios，而不是把它称为已验证 alpha。

### 6.4 M0 判定演进

M0 才把多 venue 输入标准化为 `[-1, +1]` 分数，加入 freshness weights、进入/退出阈值和最短 dwell。funding、OI 在经历史 replay 验证前只改变 `LEVERAGE-HEAVY` / `CROWDING RISK` 标签，不直接反转方向票。UI 分开显示 `3/4 market segments confirm` 与 `2/3 CEX venues aligned`。

### 6.5 结构标签

- `SPOT-LED`：spot juries 同向先动，perp 未出现过度拥挤；
- `LEVERAGE-HEAVY`：perp 同向、OI 上升且 funding/premium 进入极端分位；
- `CROSS-VENUE CONFIRMED`：至少 3 个 jury 同向且均 fresh；
- `MARKET DISAGREEMENT`：spot 与 perp 方向相反；
- `INSUFFICIENT DATA`：fresh jury 少于 3，不把它包装成 NO EDGE。

### 6.6 First observed 的严谨表达

首版标签使用 `FIRST OBSERVED BY SIDE`，不要声称发现了稳定的因果 price discovery。候选规则：按接收侧单调时钟，某 venue 先越过 2 bp impulse，其他 venue 在 1-3 秒内同向确认，则记录一次 lead event，同时显示各源 latency 不确定性。规模化验证再看 lead 后续确认率与稳定性。

---

## 7. Paper run 与验证闭环

### 7.1 Paper fill

模拟验证版仅支持 marketable/taker 模拟：

- DEX paper：以点击时重新请求的 0x `amount_out` 为 estimated fill，并保存 `min_amount_out`、route、quote latency 和 `zid`；不声称它是 firm quote。
- 0x preview 不提供可直接消费的 price-impact/fee breakdown；S0 不伪造这两个字段。后续若用 reference price、route 或独立 fee source 推导，必须保存方法与来源并标 `estimated`。
- 如 0x 失败：不回退到旧价；只有用户明确点击 fallback action 后才请求 Jupiter estimate，并记录 source、两个 anchor/directional request 与 0x 失败原因。
- CEX/HL 的多场所 paper execution 不进入唯一主流程；后续若加入，必须逐档走 book 计算 VWAP，不能只取 mid。
- BUY 定义为花费固定 10,000 USDC 换入 SOL；SELL 先用同一 provider 的 fresh `10,000 USDC → SOL` estimate 建立 anchor，再卖出该 estimated SOL 数量。

### 7.2 Markout

每次 paper order 保存：

```text
decision_id
system_verdict / user_action / alignment
side / pair / notional / token_in_amount
event_ts / receive_ts / quote_ts
estimated_fill / min_output / route / zid
derived_cost_estimates? / derivation_source?
four jury votes + reasons
raw feature snapshot
data-health snapshot
signal_model_version
```

评价：

- S0 的 +5m signal markout：`sideSign × (P_future / P_entry - 1) × 10,000`，BUY 的 `sideSign=+1`，SELL 为 `-1`；`P_entry/P_future` 使用同一 `referencePolicyVersion` 的 Bitquery WSOL/USDC robust realized-price reference；任一窗口没有足够成交、存在未修复 gap 或 reference 异常时标 `unscored`；
- M0 再加入 execution markout：+5m 用反向、同规模 executable quote 估算 round-trip wallet value；
- gross 与已知成本后的 net 分开；
- stale、断流、无法形成参考价时标记 `unscored`，不按输赢处理；
- WAIT 单独统计“避免进入了无优势区间”的结果，不伪装成 BUY/SELL 胜率；
- 自动 signal transition 也进入 shadow log，避免只挑用户点击的样本。

S0 的存储边界也跟随唯一 5 分钟窗口：运行时只保留当前 5 分钟 rolling state；长期保存 decision snapshot、+5m markout、健康转移和用户明确开启的 golden replay recording。普通原始行情不在 S0 无限落盘。M0 如需研究/回放，再配置短期、可轮转的 compressed event retention，并明确容量与删除策略。

### 7.3 “好输出”的定义

首版不以短样本赚钱作为唯一成功标准。四层指标：

1. **数据正确**：symbol/单位/合约乘数正确，sequence gap 可检测，时间戳不倒退。
2. **系统及时**：CEX/HL event-to-browser p95 < 500 ms；Bitquery provider-indexed flow 单独报告 source-to-browser p50/p95，S0 初始预算为 p95 < 2 s；paper estimate age 清晰且符合本地 TTL。
3. **解释一致**：相同 replay + 相同模型版本得到完全相同 verdict 和原因。
4. **决策价值**：用户在 10 秒内能说出当前 bias、是否一致、谁在 leading、为什么；规模化后再看各 consensus bucket 的净 markout 分布。

---

## 8. 交付阶段与范围门

### Phase A - Product slice

目标：完成题目要求的一条端到端 flow。

更新后的可执行 task、依赖、两级 runnable milestone 与最终 Definition of Done 以 [S0 Runnable Product Slice](S0_RUNNABLE_PRODUCT_SLICE.md) 为准；本节保留产品范围摘要。

- SIDE-001 选择出的原子 CEX profile、Hyperliquid perp 与 Bitquery WSOL/USDC decoded realized flow；
- 四个最小 jury 与 event-driven venue lanes；
- 固定 SOL-USDC / $10k 的 0x primary、显式 Jupiter fallback paper preview、record 与 +5m markout；
- 一段 golden replay；
- 部署链接、1 页 PRD、半页测试、半页 process log。

S0 聚焦一个资产、四类市场证据与模拟验证。更多场所、完整深度和真实执行按独立里程碑推进；DEX flow 必须明确标注覆盖范围。

### Phase B - Project MVP hardening

- 三家 CEX adapter 契约测试与 reconnect/gap recovery；
- Hyperliquid `l2Book` full-snapshot refresh、staleness detection 与 reconnect/resubscribe；不把它描述成带 sequence 的 delta recovery；
- DEX 双向、多规模 quote；
- 选定 pool/program 的 confirmed onchain swap stream、去重与 reconnect backfill；
- 标准化 stablecoin basis；
- replay corpus 与 fault injection；
- AWS 单机 Docker 部署、监控和备份；
- motion 压测与长时稳定性。

### Phase C - 0x real swap beta

进入条件：

- 0x API key 与真实响应 contract test 通过；
- dedicated mainnet RPC + fallback；
- wallet local signing；
- allowlisted mint、program、recipient；
- quote age、slippage、notional、daily loss/canary 限制；
- transaction simulate 成功；
- 完成 native SOL 与 WSOL wrap/unwrap 测试；
- UI 使用 `REVIEW LIVE SWAP`，与 paper mode 明确隔离。

### Phase D - 研究与扩展

- lead/lag 的长期统计显著性；
- 多档 paper fill；
- 多资产可复制性；
- 真实执行是否值得扩展到 CEX/HL；
- 告警或交易 journal。

---

## 9. 建议工作包

| Workstream | 第一可交付物 | 主要退出条件 |
|---|---|---|
| Product | 1 页 PRD + scope ledger | one user/job/flow 清楚；cuts 可辩护 |
| Data adapters | S0 source 出标准化事件；随后补齐 M0 | contract tests、freshness、reconnect 可见 |
| Signal | 四 jury + central verdict | replay deterministic；NO EDGE 与 INSUFFICIENT DATA 分离 |
| UI | event-driven cockpit + paper drawer | 每种 event 有视觉语法；60 fps budget；reduced motion |
| Paper broker | 0x reference + record + markout | 无签名/广播路径；审计字段齐全 |
| Reliability | record/replay + fault injection | demo 断网仍能跑完整 flow，且明确标 REPLAY |
| Deploy | 单机 HTTPS deployment | restart 后恢复；health/metrics 可见；secrets 不进镜像 |
| Product documentation | PRD/test/process log/demo script | 说明产品行为与验证范围 |

---

## 10. 产品交付物与 process log

以下文档帮助使用者理解产品、运行方式及验证边界：

- [ ] `README.md`：部署链接、运行方式、LIVE/REPLAY 标识、当前已实现状态和明确 cuts；
- [ ] `docs/PRD.md`：约 1 页，覆盖 problem/user、why now、one job/flow、成功标准与非目标；
- [ ] `docs/BUILD_AND_CUTS.md`：实际构建内容、刻意未做内容、S0 与后续 M0/L0 的边界；
- [ ] `docs/TESTS_AND_FAILURES.md`：约半页，说明测试、good output、scale metrics、已知失败和 fail-closed 行为；
- [ ] `docs/PROCESS_LOG.md`：约半页，实时记录 AI 工具与工作流、AI 失败、人工纠正；
- [ ] `docs/DEMO_SCRIPT.md`：10 分钟主路径、断流/REPLAY fallback 和可用于 live extension 的接口切入点；
- [ ] 版本标签与部署记录对应，后续增强在独立版本中记录。

`PROCESS_LOG.md` 每条至少包含：目标、使用的 AI/tool、采用的输出、失败或不可信之处、人工验证/修正、最终产品决定。它必须随构建即时追加，依据可验证的开发记录更新。若 S0 实际调用 0x，还需记录 integration feedback：首次成功请求耗时、文档歧义、错误处理、缺失字段，以及为何没有把 `swap-instructions` 的输出误称为 firm quote、price impact 或 fee breakdown。

---

## 11. 资源需求

### S0 - Product validation

- **AWS 主机信息**：Ubuntu 版本、CPU/RAM/磁盘、region、固定公网 IP、域名/DNS、SSH 方式；
- **0x API key**：用于页面活跃时的 5 秒共享 display sampler 与用户 action-time preview，放服务端 secret store，不贴进聊天、代码或浏览器；
- **Jupiter API key/quota**：只用于 0x 失败后由用户明确触发的 paper estimate fallback，不作连续行情源；
- **Bitquery API token 与 stream entitlement**：使用美国区域 GraphQL WebSocket；需要同时支持 live subscription 与 reconnect historical backfill query；
- Coinbase `SOL-USD` 与 Hyperliquid public market feed 不需要 private/trading credential；Coinbase Derivatives `SLP` 只有在无需 CDE participant entitlement 即可取得 S0 所需 BBO/trades 时才通过 primary profile 选择门；
- **Binance fallback preflight**：Coinbase profile 未通过时，在目标 AWS region 验证 spot 与 USDⓈ-M endpoints，整组启用或整组 unavailable；
- S0 不签名、不广播，也不要求主备 execution RPC、钱包或链上资产。

### M0 - 完整 Project MVP

- **Solana Mainnet data provider**：需支持目标 pool/program 的 live stream 与 reconnect backfill；可用 HTTP/WSS、indexer 或 Geyser，但先以真实事件量和回补窗口测算容量，不预先写死 20 RPS；
- **独立 failover data provider**：在主 provider 的 fault-injection 通过后再设为 M0 上线门，不作为 S0 阻塞项；
- **AWS 扩容信息**：磁盘、event-log retention、备份目标和监控告警；
- CEX/Hyperliquid 行情默认继续使用 public feed；只有经 rate-limit/preflight 证明需要时才申请 read-only credential，永不复用 trade-enabled key。

### L0 - 0x real swap beta

- **0x production key/quota** 与通过真实响应的 contract test；
- **主、备 Solana Mainnet RPC HTTP + WSS**：支持 blockhash、simulation、priority fee、send 与 confirmation；
- 一只独立、低余额、可随时废弃的 Solana mainnet wallet，由浏览器钱包本地签名；
- 极小额 SOL/USDC/USDT canary 资产；
- Solana wallet private key/seed phrase 任何阶段都不得进入服务端、代码、日志或聊天。

Hyperliquid/CEX live execution 不属于 L0；如未来单独立项，再定义 master/subaccount、API wallet/agent、固定出口 IP 与无提现权限的 credential policy。

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 数据源过多，扩大验证范围 | 高 | S0 只启用一个原子 CEX profile、HL、Bitquery WSOL/USDC flow 与 action-time paper estimate；完整覆盖进入 M0 |
| 动效变成噪声或掉帧 | 高 | 100 ms micro-batch、zone rate cap、Canvas/SVG overlay、motion pause/reduced mode |
| 0x/Jupiter 被当作成交或 signal evidence | 高 | S0 DEX evidence 仍只来自 Bitquery realized swaps；0x display sampler 不生成 bubble/jury 且不可 record，Jupiter 仅为显式 fallback |
| 0x Solana 仅 mainnet beta | 高 | 模拟验证版不广播；真实路径按 decode → validate → simulate → canary 开门 |
| Bitquery 被误称为 Solana 全市场 | 高 | 显示 decoded coverage；RFQ/未知协议标 gap；多腿 route 合并为一个 economic swap |
| Bitquery WS at-most-once 且无 replay | 高 | live buffer + historical query backfill + logical dedupe；未修复 gap 时 DEX jury unavailable |
| stablecoin 被假设 1:1 | 中高 | USDC/USDT 分开显示；保存 quote asset；后续加入 stable basis |
| perp contract size/asset id 写死 | 高 | 启动时拉 metadata；原生单位与 SOL 标准单位同时保存 |
| WS gap/重连导致错误信号 | 高 | sequence 检测、snapshot/replay、stale fail-closed |
| API/地区可用性 | 中高 | AWS 部署前按 SIDE-001 先测 Coinbase spot + `SLP`；失败时原子回退并预检 Binance spot/perp |
| demo 时外部 API 失败 | 高 | 真实 live 为首选；录制 replay 为显式 fallback，不混淆状态 |
| 短期绩效样本被过度解读 | 中 | 展示 sample size、成本后分布与 unscored；不宣称确定 alpha |

---

## 13. SIDE-001 已冻结决定与待完成选择门

已冻结：

1. 产品名 `SIDE`；
2. 默认 pair 为 SOL-USDC，默认 paper notional 为 $10k，S0 不显示额外 depth ladder；
3. CEX 使用原子 profile：Coinbase `SOL-USD` + Coinbase Derivatives `SLP` 优先，失败时整组回退 Binance spot/perp；
4. Hyperliquid 提供 DeFi perp；Bitquery 提供 WSOL/USDC decoded realized flow；
5. 0x 为 paper estimate primary，Jupiter 只在用户明确选择后 fallback；S0 不签名、不广播。

SIDE-006 已交付可执行 preflight、原子 selector 与[本机 required strict 报告](../reports/preflight/local-required-pass-2026-09-05/source-preflight.md)：本机 Coinbase profile、Hyperliquid、Bitquery 与 0x 均连续 3 次通过；Binance fallback 受 451 限制。显式 Jupiter 检查因当前 key 返回 401 单独失败。目标 AWS SSH 入口仍超时，所以仍须从目标美国 AWS region 完成 strict run；详见 [SIDE-006 验收记录](SIDE-006_SOURCE_PREFLIGHT.md)。选择门只决定哪个已冻结 profile 被启用，不重新打开产品范围。
