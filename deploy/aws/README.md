# SIDE AWS deployment

This deployment is intentionally co-host safe for the existing existing service EC2 instance:

- `side-web` binds only to `127.0.0.1:8088` on the host;
- `side-server` and `side-postgres` are reachable only on the Compose network;
- the host's existing HTTPS reverse proxy owns ports 80/443 and forwards the SIDE hostname to `http://127.0.0.1:8088`;
- secrets and persistent data remain outside the checkout and Docker image.

## Host baseline

- Ubuntu LTS on ARM64 (`t4g.medium`);
- Docker Engine with the Compose plugin;
- at least 50 GiB free as an initial hard gate; 100+ GiB is preferred because recorder data currently grows by roughly 3.5–3.7 GiB/day and is not auto-deleted;
- a working NTP/chrony clock;
- an existing HTTPS reverse proxy and DNS name for SIDE.

The pinned Node 24, PostgreSQL 18 and Caddy images all publish ARM64 variants. Compose caps SIDE at 2.0 burst vCPU and about 2.4 GiB combined memory so existing service and the host retain headroom. These are ceilings, not capacity proof; inspect actual host use before starting SIDE.

## Prepare

From the repository checkout on EC2:

```bash
sudo bash deploy/aws/prepare-host.sh
sudo install -m 0600 -o "$USER" -g "$(id -gn)" deploy/aws/side.env.example /etc/side/side.env
sudoedit /etc/side/side.env
SIDE_ENV_FILE=/etc/side/side.env bash deploy/aws/preflight.sh
```

Generate independent values for `SIDE_DB_PASSWORD` and `SIDE_ADMIN_PASSCODE` with `openssl rand -hex 32`. Copy the already-issued SIDE admin passcode only through the operator's secure channel; never place it in Git, shell history, a URL, or a Docker build argument.
Set `SIDE_RUNTIME_UID` and `SIDE_RUNTIME_GID` to the owner of `/srv/side/data` (`id -u` and `id -g`); Ubuntu normally uses `1000:1000`.
The pinned PostgreSQL 18 image writes its versioned data directory as `999:999`; `prepare-host.sh` assigns `/srv/side/postgres` to that numeric owner. Override `SIDE_POSTGRES_UID` and `SIDE_POSTGRES_GID` only if a replacement image uses different IDs.

Run the target-region source gate before public exposure:

```bash
pnpm install --frozen-lockfile
pnpm preflight:s0 -- --env-file /etc/side/side.env --region us-east-1 --samples 5 --out-dir reports/preflight/aws-us-east-1 --strict
```

## Build and start

```bash
docker compose --env-file /etc/side/side.env -f deploy/aws/compose.yaml config --quiet
docker compose --env-file /etc/side/side.env -f deploy/aws/compose.yaml build --pull
docker compose --env-file /etc/side/side.env -f deploy/aws/compose.yaml up -d
docker compose --env-file /etc/side/side.env -f deploy/aws/compose.yaml ps
curl --fail --silent http://127.0.0.1:8088/health/ready
curl --fail --silent http://127.0.0.1:8088/health/sources
```

Do not publish port 8088 directly. Add a virtual host to the existing reverse proxy, route it to `127.0.0.1:8088`, and verify HTTPS before entering the admin passcode.

## Operate

```bash
docker compose --env-file /etc/side/side.env -f deploy/aws/compose.yaml logs --tail=200 side-server
docker compose --env-file /etc/side/side.env -f deploy/aws/compose.yaml restart side-server
docker compose --env-file /etc/side/side.env -f deploy/aws/compose.yaml down
du -sh /srv/side/data/* /srv/side/postgres
```

`down` does not delete bind-mounted data. Never run `down -v`, delete `/srv/side`, or prune volumes as part of a routine deploy. The server has a 60-second shutdown grace period so the recorder can finalize its active manifest.

Before every deploy, download required archives, verify checksums, confirm free disk, and retain the previous checkout/image tag for rollback. Public release is allowed only after the target host is reachable, source preflight passes there, and the existing reverse proxy change has been validated and backed up. The first us-east-1 deployment completed those gates on 2026-09-08; Jupiter remained explicitly degraded after a 401 response, while the required Coinbase/Hyperliquid/Bitquery/0x path passed.

## Private access

The web gateway requires HTTP Basic authentication for every page, API and WebSocket upgrade, except the minimal `/health/live` response. Its username is `side`. Generate a unique password hash interactively with `docker run --rm -it caddy:2.11.4-alpine caddy hash-password`, then set `SIDE_ACCESS_PASSWORD_HASH` in the external Compose env file. Wrap the hash in single quotes to preserve its dollar signs. Do not commit either the password or its hash. Missing or invalid configuration must be fixed before starting the gateway.

Use a different high-entropy `SIDE_ADMIN_PASSCODE` for state-changing operations. The full-site gate protects read-only data as well as controls. Keep port 8088 on host loopback and terminate public traffic through HTTPS; never send credentials over a public plaintext connection. This is a deployment template, not a claim that an existing instance has been updated.

After starting, `/health/live` should return 200 anonymously; `/`, `/api/state`, `/api/recording/status`, `/api/paper-orders` and `/ws` should return 401 without access credentials. Verify the dashboard and WebSocket after authenticating. The outer proxy must preserve the Authorization header.
