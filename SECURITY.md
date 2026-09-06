# Security and private deployment

SIDE is a short-window market decision and research tool. The published releases through v0.5 use paper/dry-run execution.

## Private data

Keep provider credentials, wallet material, local environment files, database dumps, recordings, backtest results and operator logs outside Git. Example credentials are placeholders. Configure separate, high-entropy credentials for each deployment; do not reuse example values.

## Access boundary

The application API is intended for a trusted operator. Earlier versions have no application authentication; v0.5's admin passcode protects mutations but does not by itself make read APIs or WebSocket streams private. These surfaces may include paper orders, strategy configuration, performance and storage paths.

Keep the application and development server on loopback. Never expose their ports directly. For network access, use HTTPS and an authenticated reverse proxy covering every page, API and WebSocket upgrade. In the sanitized v0.5 deployment, the bundled Caddy gateway requires a separate bcrypt password hash through SIDE_ACCESS_PASSWORD_HASH. Only /health/live is anonymous and returns a minimal liveness response. The admin passcode remains required for mutations. Existing deployments must be updated separately; publishing source does not update a running server.

For earlier releases, use the same authenticated gateway pattern, or keep them local-only. Configure the gateway's HTTPS endpoint in your own private infrastructure settings; no operator hostname is supplied by this repository.

## Review limits

Source and history have been checked for known secret formats, local credential values and identifying deployment details. This is not a guarantee of zero vulnerabilities or profitable trading. Dependency advisories, operating-system updates and access controls need ongoing review.
