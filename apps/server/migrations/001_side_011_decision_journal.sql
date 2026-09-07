CREATE TABLE IF NOT EXISTS side_schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_decisions (
  decision_id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  action text NOT NULL CHECK (action IN ('BUY', 'SELL', 'WAIT')),
  pair text NOT NULL CHECK (pair = 'SOL-USDC'),
  target_notional_quote numeric NOT NULL CHECK (target_notional_quote = 10000),
  provider text CHECK (provider IN ('zeroex', 'jupiter')),
  preview_id text,
  mode text NOT NULL CHECK (mode IN ('LIVE', 'REPLAY')),
  verdict text NOT NULL,
  alignment text NOT NULL,
  signal_model_version text NOT NULL,
  recorded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decision_evidence_snapshots (
  decision_id text PRIMARY KEY REFERENCES paper_decisions(decision_id) ON DELETE CASCADE,
  evidence jsonb NOT NULL,
  evidence_sha256 text NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_order_snapshots (
  decision_id text PRIMARY KEY REFERENCES paper_decisions(decision_id) ON DELETE CASCADE,
  execution_mode text NOT NULL CHECK (execution_mode = 'paper'),
  preview jsonb,
  order_snapshot jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_markouts (
  decision_id text NOT NULL REFERENCES paper_decisions(decision_id) ON DELETE CASCADE,
  horizon_ms integer NOT NULL CHECK (horizon_ms = 300000),
  reference_policy_version text NOT NULL,
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'SCORED', 'UNSCORED')),
  entry_reference jsonb NOT NULL,
  future_reference jsonb,
  directional_markout_bps numeric,
  directional_pnl_quote numeric,
  reason text,
  attempts integer NOT NULL DEFAULT 0,
  computed_at timestamptz,
  PRIMARY KEY (decision_id, horizon_ms, reference_policy_version)
);

CREATE INDEX IF NOT EXISTS paper_markouts_due_idx ON paper_markouts (due_at) WHERE state = 'PENDING';

INSERT INTO side_schema_migrations (version, name)
VALUES (1, 'side_011_decision_journal')
ON CONFLICT (version) DO NOTHING;
