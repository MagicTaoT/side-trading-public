CREATE TABLE IF NOT EXISTS side_schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_config_revisions (
  strategy_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL CHECK (length(name) > 0),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  config_snapshot jsonb NOT NULL,
  config_sha256 text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (strategy_id, revision)
);

CREATE TABLE IF NOT EXISTS strategy_runs (
  run_id text PRIMARY KEY,
  strategy_id text NOT NULL,
  config_revision integer NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode = 'DRY_RUN'),
  state text NOT NULL CHECK (state IN ('STOPPED', 'IDLE', 'ARMING', 'OPEN', 'EXIT_PENDING_PRICE', 'COOLDOWN')),
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  run_snapshot jsonb NOT NULL,
  run_snapshot_sha256 text NOT NULL,
  FOREIGN KEY (strategy_id, config_revision)
    REFERENCES strategy_config_revisions(strategy_id, revision),
  CHECK (updated_at >= started_at),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS strategy_runs_recent_idx ON strategy_runs (started_at DESC);
DROP INDEX IF EXISTS strategy_runs_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS strategy_runs_single_active_idx ON strategy_runs ((true)) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS strategy_runs_strategy_idx ON strategy_runs (strategy_id, started_at DESC);

CREATE TABLE IF NOT EXISTS strategy_baskets (
  basket_id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES strategy_runs(run_id) ON DELETE CASCADE,
  basket_sequence integer NOT NULL CHECK (basket_sequence > 0),
  direction text NOT NULL CHECK (direction IN ('BUY', 'SELL')),
  state text NOT NULL CHECK (state IN ('OPEN', 'EXIT_PENDING_PRICE', 'CLOSED')),
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  basket_snapshot jsonb NOT NULL,
  basket_snapshot_sha256 text NOT NULL,
  UNIQUE (run_id, basket_sequence),
  UNIQUE (run_id, basket_id),
  CHECK (updated_at >= opened_at),
  CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

CREATE INDEX IF NOT EXISTS strategy_baskets_run_idx ON strategy_baskets (run_id, basket_sequence);

CREATE TABLE IF NOT EXISTS strategy_events (
  run_id text NOT NULL REFERENCES strategy_runs(run_id) ON DELETE CASCADE,
  event_sequence bigint NOT NULL CHECK (event_sequence > 0),
  basket_id text,
  event_class text NOT NULL CHECK (event_class IN ('STATE_CHANGE', 'FILL')),
  event_kind text NOT NULL CHECK (event_kind IN (
    'RUN_STARTED', 'RUN_STOPPED', 'ARMING_STARTED', 'ARMING_RESET',
    'ENTRY_FILLED', 'ADD_FILLED', 'EXIT_PENDING_PRICE', 'EXIT_FILLED', 'COOLDOWN_COMPLETED'
  )),
  occurred_at timestamptz NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  event_snapshot jsonb NOT NULL,
  event_sha256 text NOT NULL,
  PRIMARY KEY (run_id, event_sequence),
  FOREIGN KEY (run_id, basket_id) REFERENCES strategy_baskets(run_id, basket_id) ON DELETE CASCADE,
  CHECK (
    (event_class = 'FILL' AND event_kind IN ('ENTRY_FILLED', 'ADD_FILLED', 'EXIT_FILLED') AND basket_id IS NOT NULL)
    OR
    (event_class = 'STATE_CHANGE' AND event_kind NOT IN ('ENTRY_FILLED', 'ADD_FILLED', 'EXIT_FILLED'))
  )
);

CREATE INDEX IF NOT EXISTS strategy_events_run_time_idx ON strategy_events (run_id, occurred_at, event_sequence);

INSERT INTO side_schema_migrations (version, name)
VALUES (2, 'paper_strategy')
ON CONFLICT (version) DO NOTHING;
