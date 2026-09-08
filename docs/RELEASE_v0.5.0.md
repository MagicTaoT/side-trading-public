# SIDE v0.5

SIDE v0.5 freezes the long-running recorder lifecycle, protected research controls, and first AWS-hosted LIVE deployment built on the v0.4 backtest lab.

## Highlights

- Rotates LIVE canonical events and one-second strategy observations into UTC-aligned three-hour datasets without reconnecting market WebSockets.
- Finalizes each completed segment with partition checksums, an immutable manifest, a gzip archive, and a separate SHA-256 metadata file.
- Adds protected archive download/two-step deletion, archive import, and explicit recovery of legacy OPEN/partial recordings; no automated retention or deletion is introduced.
- Builds zero-copy 3h, 6h, 12h, 24h, and 3d composite datasets only when continuous observation coverage validates, then runs deterministic single or parameter-grid backtests with an explicit stop control.
- Adds a simple high-entropy admin passcode gate to all state-changing, deletion, archive-download, paper-action, strategy, WebSocket-control, and backtest mutation routes.
- Adds an ARM64 AWS Compose deployment with PostgreSQL 18, the SIDE server, static Caddy web, health checks, resource ceilings, log rotation, non-root/read-only containers, external secret injection, and durable host storage.

## AWS deployment

The v0.5 deployment uses an ARM64 host with loopback-only application ports behind an HTTPS gateway. Host addresses and domain configuration are supplied privately by each operator.

Target-region strict validation selected the complete Coinbase spot/perp profile and passed Hyperliquid, Bitquery WSOL/USDC, and 0x. Binance returned expected regional HTTP 451 responses and was not selected. Jupiter fallback returned HTTP 401 after key-format normalization and remains explicitly degraded; 0x stays the primary quote source.

The encrypted gp3 root volume was expanded from 30 GiB to 60 GiB. At deployment completion the filesystem had about 47 GiB free. Because datasets and archives are retained together until manual download and deletion, operators must monitor disk usage frequently.

## Safety boundary

This release remains paper and dry-run only. It contains no authenticated exchange trading client, wallet, private key, signer, transaction assembly, simulation, broadcast, or live order-submission path. Backtests remain `GROSS_THEORETICAL_V1` and exclude fees, spread, slippage, funding, impact, partial fills, and queue position.

Secrets are excluded from Git and Docker build context. Runtime credentials live only in `/etc/side/side.env` with mode `0600`; server/PostgreSQL ports are not host-published, and admin credentials are never placed in URLs or persisted by the browser beyond the current tab session.

## Verification

- 191 tests passed; 3 PostgreSQL integration tests requiring an isolated test database were skipped.
- Workspace typecheck, production build, Docker Compose config, shell syntax, `git diff --check`, and exact-value secret scan passed.
- Target ARM64 image build and host/source preflight passed for the required source set.
- PostgreSQL, server, and web containers were healthy; 9 journal tables initialized; admin verification returned 401 without and 200 with the passcode.
- LIVE browser smoke showed connected/fresh market data and continuing ingest; the recorder wrote provider NDJSON and observation partitions.
- existing service remained HTTP 200 after a validated, backed-up Caddy hot reload; SIDE readiness also returned HTTP 200 over public HTTPS.

## Public-source privacy revision

The public-source edition removes operator identity and infrastructure addresses from documentation and Git metadata. Deployment now requires full-site gateway authentication covering read APIs and WebSocket upgrades, in addition to the existing mutation passcode. This source revision does not update any existing running deployment. Configure the new access hash before deploying.
