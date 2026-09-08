# SIDE-023 · Simple admin passcode

状态：implemented and workspace-verified
日期：2026-09-08

## 决定

SIDE 只使用一枚高熵共享 passcode 保护研究管理操作，不引入用户表、注册、密码重置、角色、JWT、OAuth 或持久 session。

本机已生成 256-bit 随机 passcode，保存于 Git 忽略的 `.env.admin.local`：

```text
SIDE_ADMIN_PASSCODE=<64 hex characters>
```

文件权限固定为 `0600`。passcode 不写入源码、tracked `.env`、日志、URL 或 archive。Web 页面用 password input 接收；验证后仅保存到当前 tab 的 `sessionStorage`，使页面间导航继续可用，关闭 tab 即清除。

## 保护范围

服务端使用 `x-side-admin-passcode` header，并以 SHA-256 后的 constant-time comparison 验证。配置值不足 24 个字符时 server fail-fast。

受保护：

- archive download/delete；
- 3h/6h/12h/24h/3d composite build；
- single backtest 与 batch experiment start；
- experiment STOP/cancel；
- replay 与全局 WebSocket disconnect/reconnect；
- paper preview/record/delete；
- dry strategy config save、run start/stop。

公开只读行情、dataset catalog、experiment history 和 health endpoints 不要求 passcode。`GET /api/admin/status` 只返回是否启用保护，不返回 secret；`POST /api/admin/verify` 验证当前输入。所有会改变服务状态的 HTTP route 统一受保护。

## 部署

生产环境只需把同一个 `SIDE_ADMIN_PASSCODE` 注入 server process。必须通过 HTTPS，避免 header 在明文链路上传输。更换 passcode 后重启 server；旧值立即失效。

这不是面向多用户产品的完整认证系统。它只满足当前单 operator、dry-run deployment 的轻量管理保护。

验证：191 tests passed，3 个 PostgreSQL integration tests 按环境跳过；全仓 typecheck、production build 与 `git diff --check` 通过。
