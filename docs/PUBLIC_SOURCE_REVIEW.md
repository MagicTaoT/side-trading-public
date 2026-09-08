# Public-source review

This repository is a sanitized edition of SIDE through v0.5. Earlier development repositories and later local experiments are not included.

## Changes

- Reframed SIDE as a short-window SOL trading decision and validation tool.
- Removed personal workstation identity, operator deployment addresses and recruiting context from reachable history.
- Used the public maintainer handle and GitHub noreply address for commit and tag metadata.
- Excluded local credentials, runtime data, backups and review work files.
- Upgraded the v0.4/v0.5 test dependency to Vitest 4.1.11 and excluded compiled test output.
- Added mandatory full-site authentication to the v0.5 Caddy deployment, with cross-origin request rejection. The minimal liveness endpoint remains anonymous.

## Verification

- v0.4: 183 tests passed; 3 PostgreSQL tests skipped without an isolated test database. Typecheck and production build passed.
- v0.5: 191 tests passed; the same 3 PostgreSQL tests skipped. Typecheck and production build passed.
- Updated v0.5 dependency audit: zero known advisories across production and development dependencies at review time; v0.4 uses the same dependency lockfile.
- Gateway integration checks: anonymous pages/API/WebSocket rejected with 401; authenticated API accepted; same-origin WebSocket upgraded with 101; cross-origin WebSocket rejected with 403.
- Reachable source/history scanned for known secret formats, local credential values, personal hostnames and removed context. UI concept images were visually inspected and had no embedded metadata reported by the image reader.

These checks do not certify zero vulnerabilities. Old releases are historical source, not a recommendation to expose their unprotected application ports. Deployment changes must be applied separately; publishing this repository does not modify any running service. See SECURITY.md.
