# SIDE-016 - Shadow Performance UI

状态：**COMPLETE · DURABLE HISTORY VISIBLE · PAPER ONLY**
日期：2026-09-07

## 1. 交付结论

SIDE-016 把 SIDE-011 已有的 PostgreSQL decision journal 和 markout API 提升为首页常驻的评估界面，不再要求用户保持 Paper Drawer 打开：

- 首页自动读取 `/api/shadow-performance` 与最近 12 条 `/api/paper-orders`；
- 首次加载、每 5 秒、页面从后台恢复、paper decision 记录成功和 `paper_markout` WebSocket 消息都会触发同步；
- 显示总 decision、BUY/SELL/WAIT 分布、scored sample、win rate、mean +5m、pending 与 unscored；
- PostgreSQL 对全部历史 `UNSCORED` 结果按 reason 聚合，不用最近列表推测总体原因；
- 最近 decision 显示时间、action、provider、entry/future Bitquery reference、+5m 结果和 paper PnL；
- bubble 在 pointer hover 或 keyboard focus 时显示 source、instrument、side、batch count、notional、price range 与 age。

## 2. 统计口径

```text
win rate = positive scored BUY/SELL / all scored BUY/SELL
```

- WAIT 到期写 `UNSCORED / WAIT_ACTION`，不进入 sample 或 win rate；
- missing reference、source gap、source stale 和 outlier 仍在历史与 reason counts 中可见，但不进入胜率；
- mean +5m 使用 `directionalMarkoutBps`；BUY/SELL 已由 SIDE-011 使用同一 `future / entry` 分母和相反 sign；
- 页面明确标记当前结果为 gross directional markout，不把它称为 executable 或 net PnL。

## 3. 验收

- 本地 LIVE 页面从 PostgreSQL 读取 3 条真实 paper decisions；
- 页面显示 `UNSCORED 3`、`WAIT ACTION ×2`、`SOURCE NOT FRESH ×1`；
- `SCORED SAMPLE 0` 时 win rate 和 mean 显示 `—`，没有伪造 0% 或样本外结论；
- 关闭 drawer 后历史和聚合统计继续存在并自动刷新；
- 89 项 workspace tests（含 PostgreSQL integration）、typecheck 与 production build 均通过。

## 4. 明确边界

- SIDE-016 不改变 reference policy、signal model 或交易权限；
- 不计算 fee/slippage 后的 net performance，gross/net 归因属于后续 Project MVP；
- 不增加真钱、钱包、签名、simulation 或 broadcast 路径；
- 当前列表加载最近 12 条 decision，聚合统计与 unscored reasons 仍来自全部 journal。

## 5. UI follow-up：按钮内双向报价

- PAPER BUY/SELL 框内直接显示 $10k directional estimate、0x/DRY 来源与 age；
- 页面每 5 秒请求一次服务端共享快照，服务端对 429/timeout 退避；
- 0x display estimate 与 dry model 都不可直接 record；点击后抽屉另取新 action-time quote，并以 5 秒 cadence 自动刷新；
- Jupiter 继续只允许用户在 0x 明确失败后点击触发，没有自动 fallback。

## 6. Decision history follow-up

- 每条历史记录新增 `ENTRY EDGE`，直接读取该 decision 已持久化的 signal snapshot，显示当时的 `BUY EDGE`、`SELL EDGE`、`NO EDGE` 或 `INSUFFICIENT DATA`；不使用当前 verdict 改写历史；
- 每行末尾新增两步确认的 `DELETE → CONFIRM`，确认后调用 `DELETE /api/paper-orders/:id`；
- PostgreSQL 删除 `paper_decisions` 主记录后通过外键级联删除 evidence snapshot、paper order snapshot 与 markout，聚合统计随即重算；
- 删除是明确用户操作，不影响普通自动刷新，也不开放批量删除。

## 7. Auto Strategy 上线后的职责复核

Shadow Performance 与 Auto Strategy 的历史不属于同一统计口径，当前仍保留：

- Shadow Performance 评价主 Dashboard 上人工记录的单点 `PAPER BUY / SELL / WAIT`，回答“当时的方向判断在固定 +5m 后是否正确”；
- Auto Strategy 评价参数化规则驱动的完整生命周期，回答“按持续确认、分段加仓和退出规则运行后，一个 basket 的理论结果如何”；
- 前者是 signal/decision validation，后者是 strategy simulation。固定 +5m markout 不能替代实际策略持仓期 PnL，策略 basket history 也不能识别人工判断是否存在选择偏差；
- 因此现阶段不删除 PostgreSQL decision journal、markout worker 或首页 Shadow Performance。若产品以后取消人工 PAPER BUY/SELL/WAIT，Shadow Performance 才应连同入口一起退役，而不是因为新增 Auto Strategy 就直接删除。
