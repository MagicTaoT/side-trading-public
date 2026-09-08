# SIDE-024 · AWS deployment preparation

状态：**DEPLOYED · LIVE/FRESH · JUPITER FALLBACK DEGRADED**

日期：2026-09-08

## 范围

为现有 existing service `t4g.medium` 主机提供 ARM64 单机 deployment：

- Node 24 production server image；
- Caddy static web + same-origin API/WebSocket proxy；
- PostgreSQL 18 durable journal；
- repository 外的 secret env 与 bind-mounted recorder/backtest/database data；
- 健康检查、资源 ceiling、日志轮转、优雅停机和只读 host preflight；
- 默认只绑定 `127.0.0.1:8088`，避免抢占 existing service 的 80/443。

## 安全边界

- build context 排除全部 `.env*` local secret、`data/`、reports、Git metadata 和本地依赖；
- `SIDE_ADMIN_PASSCODE` 与第三方 key 仅从 `/etc/side/side.env` 注入；
- server/Postgres 不映射宿主机端口；
- SIDE 的 HTTP 入口只在 loopback，由既有 HTTPS proxy 转发；
- server/web 容器使用非 root user、drop Linux capabilities、启用 no-new-privileges，root filesystem read-only；Caddy image 移除不需要的 privileged-port file capability 后只监听 8080；
- server 使用与宿主机 data owner 对齐的非 root UID/GID，preflight 会拒绝不可写的 owner 配置；
- Caddy 设置 CSP、frame denial、no-sniff、permissions policy，并限制 request body；
- 不包含 signer、transaction assembly 或 broadcast path。

## 容量策略

Compose ceiling：server 1536 MiB / 1.25 CPU、Postgres 768 MiB / 0.5 CPU、web 128 MiB / 0.25 CPU。preflight 要求至少 3.5 GiB 可见内存和默认 50 GiB 空闲磁盘。50 GiB 只是阻止明显错误的最低门槛；按本机约 3.5–3.7 GiB/day 的 raw recorder 增长，实际建议 100+ GiB，并设置磁盘告警与人工下载/删除纪律。

## AWS deployment verification

- 目标实例：`side-host`，Elastic IP `192.0.2.20`，`t4g.medium` / ARM64，EC2 3/3 status checks passed；旧地址 `192.0.2.10` 已失效。
- encrypted gp3 root volume 从 30 GiB 扩为用户指定的 60 GiB，ext4 在线扩展后约 58 GiB 可用文件系统；部署完成时约 47 GiB free。本机以 45 GiB host gate 启动，必须保持人工下载/清理纪律。
- existing service 继续拥有 80/443；SIDE 只监听 host loopback `127.0.0.1:8088`。既有 Caddy 经离线 validate、配置备份和热 reload 后新增 `side.example.com` HTTPS route，existing service 与 SIDE 均返回 200。
- us-east-1 necessary-source strict gate 选择完整 Coinbase profile；Coinbase spot/perp、Hyperliquid、Bitquery 与 0x 全部通过。Binance metadata/spot WS 返回区域 451，不参与所选 profile；Jupiter key/endpoint 返回 401，明确标记 degraded。
- PostgreSQL 18、server、web 三容器 healthy；admin verify 无 passcode/正确 passcode 分别返回 401/200；journal migrations 建立 9 张 public tables；LIVE recorder 已写入 provider NDJSON 与一秒 observation tape。
- 10 秒共机采样保持约 49–70% CPU idle；SIDE server 约占 0.8–1.0 vCPU、约 160 MiB RAM，三 SIDE 容器合计约 221 MiB RAM。该结果支持 S0 共机运行，但不是长期 soak 或 HA 证明。

## 本地验证

- linux/arm64 images：server 约 101 MB，web 约 39 MB；
- Docker build context 约 821 KB，未包含 `data/`、local env 或 Git metadata；
- PostgreSQL、server、web 三容器健康检查通过；
- SIDE-011/SIDE-020 journal migrations 创建并可读取；
- `/backtest` SPA、`/health/ready`、`/api/admin/status` 与 WebSocket reverse proxy 通过；
- admin missing/valid passcode 分别返回 401/200；
- security headers 与 secret-log scan 通过；
- 目标 ARM64 production build、Compose config、host/source preflight、Caddy config/reload、HTTP/browser smoke 与 real recorder write 均通过。
