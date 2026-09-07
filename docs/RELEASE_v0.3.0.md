# SIDE v0.3

SIDE v0.3 adds a durable, dry-run-only automated strategy workspace while preserving the v0.2 market cockpit and paper decision journal.

## Highlights

- Added configurable edge threshold and same-direction hold time before entry.
- Added optional scale-in timing and size multipliers, maximum entries, and maximum total exposure.
- Added one-trend/one-basket lifecycle management with weighted entry price, take-profit, linear take-profit decay to 0 bps, stop-loss, forced exit, and cooldown.
- Added immutable strategy configuration revisions plus durable run, basket, fill, transition, and restart-recovery history in PostgreSQL.
- Added a dedicated `/strategy` page with current-run monitoring, configuration history, run history, basket result tables, latest-first event timelines, and total theoretical PnL.
- Added reversible Dashboard WebSocket resource controls and automatic gateway reconnect with bounded exponential backoff.
- Increased paper action-time quote TTL to 10 seconds while keeping display snapshots non-recordable.

## PnL semantics

`Total Theoretical PnL = closed basket gross PnL + current open basket mark-to-market`.

The UI separately shows closed PnL, open mark-to-market, win/loss counts, entry fills, and cumulative entry notional. Fees, slippage, partial fills, funding, and executable venue constraints are not modeled.

## Safety boundary

This release remains dry run only. It contains no wallet, signer, transaction assembly, simulation, broadcast, or live order-submission path.

## Verification

- 169 tests passed.
- 3 PostgreSQL integration tests requiring an isolated `TEST_DATABASE_URL` were skipped in the final local environment.
- Workspace typecheck and production build passed.
- LIVE browser checks passed for Dashboard/Strategy navigation, market input status, configuration/run history, basket/event detail, PnL aggregation, WebSocket disconnect/reconnect, and unexpected-disconnect recovery.
