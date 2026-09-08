# SIDE v0.4

SIDE v0.4 freezes the historical recorder, deterministic replay, and backtest lab built on top of the v0.3 dry-run strategy workspace.

## Highlights

- Added default LIVE recording of accepted canonical market events and the exact per-second strategy observation tape.
- Added hourly provider/model partitions, checksums, deterministic dataset fingerprints, atomic finalization, and fail-closed `OPEN` / `FAILED` dataset handling.
- Added fixed one-second replay reconstruction for legacy datasets without an observation tape, with events ingested before each strategy tick.
- Added deterministic single-config backtests with basket, fill, event, equity, exposure, return, drawdown, coverage, and exit-reason results.
- Added asynchronous batch experiments for saved configurations and typed parameter grids, with validation, deduplication, cancellation, restart-safe history, and a 128-variant cap.
- Added a dedicated `/backtest` lab with dataset selection, experiment history, progress, leaderboard, equity curve, exit summaries, and basket/fill drill-down.

## Result semantics

Backtests use the same dry-run strategy engine as `/strategy`. Results are labeled `GROSS_THEORETICAL_V1`: they model theoretical immediate fills and do not include fees, spread, slippage, funding, market impact, partial fills, or limit-order queue position.

Only finalized `COMPLETE` datasets whose partition checksums, counts, ordering, and fingerprints validate are accepted. A recorded observation tape is preferred; deterministic fixed-tick reconstruction is used only when the tape is absent.

## Safety boundary

This release remains paper and dry-run only. It contains no Hyperliquid or CEX authenticated trading client, wallet, signer, transaction assembly, simulation, broadcast, or live order-submission path. Live execution planning is outside the v0.4 release scope.

## Verification

- 183 tests passed.
- 3 PostgreSQL integration tests requiring an isolated `TEST_DATABASE_URL` were skipped in the final local environment.
- Workspace typecheck, production build, `git diff --check`, and the local HTTP + WebSocket + replay smoke test passed.
- LIVE recorder and browser smoke checks passed for completed-dataset discovery, recorded-tape backtesting, batch experiment progress/history, leaderboard, chart, and basket/fill detail.

## Public-source privacy revision

This public-source edition uses sanitized documentation and Git metadata. Its test dependency is updated to Vitest 4.1.11. Keep this version local-only or behind a fully authenticated HTTPS gateway; it has no application authentication. See SECURITY.md. The public-source commit IDs differ from the original development repository.
