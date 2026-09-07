# SIDE-020 · Dry-run 自动策略与 basket history

状态：implemented and workspace-verified
日期：2026-09-07
安全边界：`DRY_RUN` only；没有 wallet、signer、order submission 或 transaction broadcast 路径。

## 目标

把现有 `s0-v1` 市场 verdict 接入一个可配置、可恢复、可审计的自动策略生命周期。该功能与人工 0x paper preview/record 完全独立：自动策略只使用 SIDE 当前理论参考价即时成交，首版不模拟手续费、滑点、深度或部分成交。

## Edge 定义

`s0-v1` 原本只输出离散 `BUY_BIAS / SELL_BIAS / NO_EDGE / INSUFFICIENT_DATA`。SIDE-020 不修改已冻结的 signal engine，而是在策略 adapter 中定义：

- 方向来自 `BUY_BIAS` 或 `SELL_BIAS`；
- 只使用 fresh 且 vote 与 verdict 同向的 jury；
- `edgeBps` 是这些 jury 的第三强绝对 `priceImpulse30s`，也就是形成 3/4 quorum 所需的最弱一票；
- 没有三票同向时 direction/edge 都为 `null`，入场连续计时清零。

这一口径使用户配置的 `minEdgeBps` 有稳定、可审计的含义，同时保留 `s0-v1` 自身的价格与 flow confirmation gate。

## 配置

```ts
interface StrategyConfigV1 {
  schemaVersion: 1;
  name: string;
  pair: "SOL-USDC";
  entry: {
    minEdgeBps: string;
    holdSec: number;
    initialSizeQuote: string;
  };
  scaling: {
    enabled: boolean;
    intervalSec: number;
    intervalMultiplier: string;
    sizeQuote: string;
    sizeMultiplier: string;
    maxEntries: number;
    maxTotalSizeQuote: string;
  };
  exit: {
    takeProfitBps: string;
    linearDecayToZero: boolean;
    stopLossBps: string;
    forceExitSec: number;
  };
  cooldownSec: number;
}
```

所有 size 都是 USDC quote notional。第 1 次使用 `holdSec` 与 `initialSizeQuote`；第 `k >= 2` 次使用：

```text
interval(k) = intervalSec × intervalMultiplier^(k-2)
size(k)     = sizeQuote × sizeMultiplier^(k-2)
```

Multiplier 由用户自行决定，不强制小于等于 1，但 `maxEntries`（1–100）与 `maxTotalSizeQuote` 始终是硬上限；最后一段允许被总仓位上限裁小。配置保存前会预计算全部分段 interval，无法安全表示的指数时间表会直接被拒绝，不会在运行中留下半笔仓位。

配置保存为不可变 revision。编辑现有策略只会生成下一个 revision，历史 run 始终引用其启动时的完整配置版本，不会被后来编辑覆盖。

## 生命周期

```text
STOPPED → IDLE → ARMING → OPEN → COOLDOWN → IDLE
                              ↘ EXIT_PENDING_PRICE
```

- 首次入场要求同一方向且 edge 达标持续 `holdSec`；弱化、缺失或反向会重置完整计时。
- 同一 run 同时最多只有一个 open basket；同一趋势内的首次和后续 fills 按 SOL quantity 加权进入该 basket。
- 后续计时从上一笔理论 fill 开始；原方向 edge 必须在整个后续 interval 内继续达标。
- 反向 edge 不触发退出，也不改变止盈、止损或强退时间；它只阻止原方向继续加仓。
- 强退时间从 basket 首次 fill 开始，加仓不会重置。
- 退出优先级固定为 `STOP_LOSS → FORCE_EXIT → TAKE_PROFIT`。
- 线性止盈只配置初始目标；开启后从首次 fill 起线性降至强退时的 `0 bps`。
- 需要退出但理论参考价不可用时进入 `EXIT_PENDING_PRICE`，禁止加仓，并在下一次有效理论价出现时成交。
- 退出后经过 `cooldownSec`，重新完成首次连续确认才会产生下一个 basket。

## 理论成交与 PnL

- 使用 Bitquery WSOL/USDC robust reference；不可用时沿用当前 fresh Coinbase SOL-USD dry reference；
- 理论立即成交；零手续费、零滑点、无 partial fill；
- 每笔 fill 保存 price、reference source、edge、scheduled/actual quote size 与 SOL quantity；
- basket 保存总 quote、总 SOL、加权平均价、gross PnL bps/USDC 和退出原因；
- `BUY` 与 `SELL` 使用对称 directional gross PnL。

这些结果是策略逻辑验证，不是可执行收益估计。未来 order-book/perp/limit adapter 可以替换理论执行层，不改变状态机合同。

## Persistence 与 API

PostgreSQL migration `002_paper_strategy.sql` 保存：

- 不可变 config revisions；
- run snapshot 与恢复状态；
- basket snapshots；
- 稀疏的 state-change/fill events。

每次 evaluation 额外 checkpoint 最新 run/basket snapshot，但只有状态变化与 fill 才写 history event。数据库和内存实现都强制同一时间最多一个 active run。

同一次 evaluation 产生的多条事件（例如 `EXIT_FILLED + RUN_STOPPED`）与最终 snapshot 原子提交。事件表只保存 transition/fill delta，完整 basket 另存一份，避免多段加仓历史呈平方增长；启动恢复只读取 config revision 与最新 run snapshot，不扫描完整历史。详情 API 默认返回最近 500 条事件并标记是否截断，同时返回该 run 对应的不可变 config revision。

REPLAY 不使用 wall clock 重复采样完成后的最后一帧。策略必须先启动，再由每条 replay event 的录制时间间隔驱动；同一 active run 已消费一次 replay 后，必须先停止才能重新运行 replay。LIVE 模式才使用每秒 tick 推进连续确认、退出目标与 freshness。

HTTP surface：

```text
POST /api/paper-strategy-configs
GET  /api/paper-strategy-configs
POST /api/paper-strategy-runs
GET  /api/paper-strategy-runs
GET  /api/paper-strategy-runs/active
GET  /api/paper-strategy-runs/:id
POST /api/paper-strategy-runs/:id/stop
GET  /api/websockets/status
POST /api/websockets/disconnect
POST /api/websockets/reconnect
```

独立的 `/strategy` 页面提供完整参数表单、历史 revisions、启动/停止、active basket mark-to-market，以及 run → basket → event 执行历史。主 Dashboard 只保留导航入口，不再承载策略表单或策略轮询。

Run detail 按 `summary → basket results → event timeline` 分层展示。Total Theoretical PnL 为全部 closed basket gross PnL 加当前 open basket mark-to-market；页面同时拆分显示 Closed PnL、Open MTM、win/loss、entry fills 与累计 entry notional。它仍是未计手续费和滑点的 dry-run 理论值，不描述为 realized/net PnL。

Dashboard 最底部提供可逆的 WebSocket 资源控制。`DISCONNECT ALL WS` 会关闭全部 dashboard gateway 客户端；LIVE 模式还会停止 Coinbase、Kraken Futures、Hyperliquid 与 Bitquery adapter，并阻止其自动重连。`RECONNECT ALL WS` 会重新启动 LIVE adapters 并建立新的 dashboard gateway 连接。策略、HTTP API 与历史 journal 不会因断开 WS 被删除或停止。独立 Strategy 页面和 Dashboard 的 WS controls 统一使用英文。

非人工断线（例如 server 重启或瞬时网络中断）会让 dashboard gateway client 进入 `RECONNECTING`，按 1、2、4、8、15 秒上限的指数退避自动重建连接；连接成功后计数归零。人工全局断开使用专用 WebSocket close code `4001`，客户端收到后保持 `PAUSED`，不会后台重试，直到显式点击 `RECONNECT ALL WS`。

首版部署假设单个 server process 驱动策略；PostgreSQL 可保证唯一 active run，但尚未加入多副本 worker lease。

## Verification

- `pnpm check`：169 passed，3 个需要独立 `TEST_DATABASE_URL` 的 PostgreSQL tests 按环境跳过；
- `pnpm build`：全部 workspace packages 与 production web build 通过；
- 浏览器 smoke：配置保存、revision history、RUN、recorded-time replay、STOP、run/basket/event detail，以及 Dashboard → `/strategy` 独立页面导航均完成检查。
