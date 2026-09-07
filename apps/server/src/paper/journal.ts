import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolClient, QueryResultRow } from "pg";
import pg from "pg";
import Decimal from "decimal.js";
import type {
  PaperAction,
  PaperMarkout,
  PaperOrder,
  PaperPerformanceSummary,
  PaperPersistence
} from "./contracts.js";

const { Pool } = pg;

export interface RecordDecisionInput {
  order: PaperOrder;
  idempotencyKey: string;
  requestFingerprint: string;
}

export interface DueMarkoutJob {
  decisionId: string;
  action: PaperAction;
  targetNotionalQuote: string;
  markout: PaperMarkout;
}

export interface DecisionJournal {
  readonly persistence: PaperPersistence;
  initialize(): Promise<void>;
  close(): Promise<void>;
  recordDecision(input: RecordDecisionInput): Promise<PaperOrder>;
  getDecision(decisionId: string): Promise<PaperOrder | null>;
  listDecisions(limit: number): Promise<PaperOrder[]>;
  deleteDecision(decisionId: string): Promise<boolean>;
  dueMarkouts(nowMs: number, limit: number): Promise<DueMarkoutJob[]>;
  completeMarkout(markout: PaperMarkout): Promise<PaperMarkout>;
  performance(): Promise<PaperPerformanceSummary>;
}

export class JournalConflictError extends Error {
  constructor(readonly code: "IDEMPOTENCY_KEY_REUSED") {
    super(code);
  }
}

interface StoredDecision {
  order: PaperOrder;
  idempotencyKey: string;
  requestFingerprint: string;
}

function mean(values: Decimal[]): string | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total.plus(value), new Decimal(0)).div(values.length).toFixed(8);
}

export class MemoryDecisionJournal implements DecisionJournal {
  readonly persistence = "memory-side-011-test" as const;
  readonly #byId = new Map<string, StoredDecision>();
  readonly #byIdempotency = new Map<string, StoredDecision>();

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async recordDecision(input: RecordDecisionInput): Promise<PaperOrder> {
    const existing = this.#byIdempotency.get(input.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) throw new JournalConflictError("IDEMPOTENCY_KEY_REUSED");
      return existing.order;
    }
    const stored = { ...input, order: { ...input.order, persistence: this.persistence } };
    this.#byId.set(stored.order.orderId, stored);
    this.#byIdempotency.set(stored.idempotencyKey, stored);
    return stored.order;
  }

  async getDecision(decisionId: string): Promise<PaperOrder | null> {
    return this.#byId.get(decisionId)?.order ?? null;
  }

  async listDecisions(limit: number): Promise<PaperOrder[]> {
    return [...this.#byId.values()]
      .map(({ order }) => order)
      .sort((left, right) => right.recordedAtMs - left.recordedAtMs)
      .slice(0, limit);
  }

  async deleteDecision(decisionId: string): Promise<boolean> {
    const stored = this.#byId.get(decisionId);
    if (!stored) return false;
    this.#byId.delete(decisionId);
    this.#byIdempotency.delete(stored.idempotencyKey);
    return true;
  }

  async dueMarkouts(nowMs: number, limit: number): Promise<DueMarkoutJob[]> {
    return [...this.#byId.values()]
      .map(({ order }) => order)
      .filter(({ markout }) => markout.status === "PENDING" && markout.dueAtMs <= nowMs)
      .sort((left, right) => left.markout.dueAtMs - right.markout.dueAtMs)
      .slice(0, limit)
      .map((order) => ({
        decisionId: order.orderId,
        action: order.action,
        targetNotionalQuote: order.targetNotionalQuote,
        markout: order.markout
      }));
  }

  async completeMarkout(markout: PaperMarkout): Promise<PaperMarkout> {
    const stored = this.#byId.get(markout.decisionId);
    if (!stored) throw new Error("DECISION_NOT_FOUND");
    if (stored.order.markout.status !== "PENDING") return stored.order.markout;
    stored.order = { ...stored.order, markout };
    return markout;
  }

  async performance(): Promise<PaperPerformanceSummary> {
    const orders = [...this.#byId.values()].map(({ order }) => order);
    const scored = orders.filter(({ markout }) => markout.status === "SCORED");
    const values = scored.flatMap(({ markout }) => markout.directionalMarkoutBps === null ? [] : [new Decimal(markout.directionalMarkoutBps)]);
    const unscoredReasonCounts: Record<string, number> = {};
    for (const { markout } of orders) {
      if (markout.status !== "UNSCORED" || markout.reason === null) continue;
      unscoredReasonCounts[markout.reason] = (unscoredReasonCounts[markout.reason] ?? 0) + 1;
    }
    return {
      scoredCount: scored.length,
      unscoredCount: orders.filter(({ markout }) => markout.status === "UNSCORED").length,
      pendingCount: orders.filter(({ markout }) => markout.status === "PENDING").length,
      buyCount: orders.filter(({ action }) => action === "BUY").length,
      sellCount: orders.filter(({ action }) => action === "SELL").length,
      waitCount: orders.filter(({ action }) => action === "WAIT").length,
      winCount: values.filter((value) => value.gt(0)).length,
      meanDirectionalMarkoutBps: mean(values),
      unscoredReasonCounts
    };
  }
}

function alignment(action: PaperAction, verdict: string): string {
  if (action === "WAIT") return "WAIT";
  if ((action === "BUY" && verdict === "BUY_BIAS") || (action === "SELL" && verdict === "SELL_BIAS")) return "ALIGNED";
  return verdict === "NO_EDGE" || verdict === "INSUFFICIENT_DATA" ? "NO_EDGE" : "DIVERGENT";
}

function objectJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function milliseconds(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error("INVALID_DATABASE_TIMESTAMP");
  return parsed;
}

function markoutFromRow(row: QueryResultRow): PaperMarkout {
  return {
    decisionId: String(row.decision_id),
    horizonMs: 300_000,
    referencePolicyVersion: String(row.reference_policy_version) as PaperMarkout["referencePolicyVersion"],
    dueAtMs: milliseconds(row.due_at),
    status: String(row.state) as PaperMarkout["status"],
    entryReference: objectJson(row.entry_reference),
    futureReference: row.future_reference === null ? null : objectJson(row.future_reference),
    directionalMarkoutBps: row.directional_markout_bps === null ? null : String(row.directional_markout_bps),
    directionalPnlQuote: row.directional_pnl_quote === null ? null : String(row.directional_pnl_quote),
    reason: row.reason === null ? null : String(row.reason) as PaperMarkout["reason"],
    computedAtMs: row.computed_at === null ? null : milliseconds(row.computed_at)
  };
}

export class PostgresDecisionJournal implements DecisionJournal {
  readonly persistence = "postgres-side-011" as const;
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
  }

  async initialize(): Promise<void> {
    const migrationUrl = new URL("../../migrations/001_side_011_decision_journal.sql", import.meta.url);
    await this.#pool.query(await readFile(migrationUrl, "utf8"));
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async recordDecision(input: RecordDecisionInput): Promise<PaperOrder> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.idempotencyKey]);
      const existing = await client.query(
        "SELECT decision_id, request_fingerprint FROM paper_decisions WHERE idempotency_key = $1",
        [input.idempotencyKey]
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.request_fingerprint !== input.requestFingerprint) throw new JournalConflictError("IDEMPOTENCY_KEY_REUSED");
        const order = await this.#getDecision(client, String(existing.rows[0]?.decision_id));
        await client.query("COMMIT");
        if (!order) throw new Error("DECISION_SNAPSHOT_MISSING");
        return order;
      }

      const order = { ...input.order, persistence: this.persistence };
      const verdict = order.evidence.signal.verdict.verdict;
      await client.query(
        `INSERT INTO paper_decisions (
          decision_id, idempotency_key, request_fingerprint, action, pair, target_notional_quote,
          provider, preview_id, mode, verdict, alignment, signal_model_version, recorded_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          order.orderId,
          input.idempotencyKey,
          input.requestFingerprint,
          order.action,
          order.pair,
          order.targetNotionalQuote,
          order.provider,
          order.previewId,
          order.evidence.mode,
          verdict,
          alignment(order.action, verdict),
          order.evidence.signal.modelVersion,
          new Date(order.recordedAtMs)
        ]
      );
      const evidenceJson = JSON.stringify(order.evidence);
      const evidenceHash = `sha256:${createHash("sha256").update(evidenceJson).digest("hex")}`;
      await client.query(
        "INSERT INTO decision_evidence_snapshots (decision_id, evidence, evidence_sha256) VALUES ($1,$2::jsonb,$3)",
        [order.orderId, evidenceJson, evidenceHash]
      );
      await client.query(
        "INSERT INTO paper_order_snapshots (decision_id, execution_mode, preview, order_snapshot) VALUES ($1,'paper',$2::jsonb,$3::jsonb)",
        [order.orderId, order.preview === null ? null : JSON.stringify(order.preview), JSON.stringify(order)]
      );
      await client.query(
        `INSERT INTO paper_markouts (
          decision_id, horizon_ms, reference_policy_version, due_at, entry_reference
        ) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          order.orderId,
          order.markout.horizonMs,
          order.markout.referencePolicyVersion,
          new Date(order.markout.dueAtMs),
          JSON.stringify(order.markout.entryReference)
        ]
      );
      await client.query("COMMIT");
      return order;
    } catch (reason) {
      await client.query("ROLLBACK");
      throw reason;
    } finally {
      client.release();
    }
  }

  async getDecision(decisionId: string): Promise<PaperOrder | null> {
    const client = await this.#pool.connect();
    try {
      return await this.#getDecision(client, decisionId);
    } finally {
      client.release();
    }
  }

  async #getDecision(client: PoolClient, decisionId: string): Promise<PaperOrder | null> {
    const result = await client.query(
      `SELECT o.order_snapshot, m.*
       FROM paper_order_snapshots o
       JOIN paper_markouts m ON m.decision_id = o.decision_id
       WHERE o.decision_id = $1`,
      [decisionId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...objectJson<PaperOrder>(row.order_snapshot), persistence: this.persistence, markout: markoutFromRow(row) };
  }

  async listDecisions(limit: number): Promise<PaperOrder[]> {
    const result = await this.#pool.query(
      `SELECT o.order_snapshot, m.*
       FROM paper_order_snapshots o
       JOIN paper_markouts m ON m.decision_id = o.decision_id
       JOIN paper_decisions d ON d.decision_id = o.decision_id
       ORDER BY d.recorded_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      ...objectJson<PaperOrder>(row.order_snapshot),
      persistence: this.persistence,
      markout: markoutFromRow(row)
    }));
  }

  async deleteDecision(decisionId: string): Promise<boolean> {
    const result = await this.#pool.query(
      "DELETE FROM paper_decisions WHERE decision_id=$1 RETURNING decision_id",
      [decisionId]
    );
    return result.rowCount === 1;
  }

  async dueMarkouts(nowMs: number, limit: number): Promise<DueMarkoutJob[]> {
    const result = await this.#pool.query(
      `SELECT d.action, d.target_notional_quote, m.*
       FROM paper_markouts m
       JOIN paper_decisions d ON d.decision_id = m.decision_id
       WHERE m.state = 'PENDING' AND m.due_at <= $1
       ORDER BY m.due_at ASC LIMIT $2`,
      [new Date(nowMs), limit]
    );
    return result.rows.map((row) => ({
      decisionId: String(row.decision_id),
      action: String(row.action) as PaperAction,
      targetNotionalQuote: String(row.target_notional_quote),
      markout: markoutFromRow(row)
    }));
  }

  async completeMarkout(markout: PaperMarkout): Promise<PaperMarkout> {
    const result = await this.#pool.query(
      `UPDATE paper_markouts SET
        state = $4,
        future_reference = $5::jsonb,
        directional_markout_bps = $6,
        directional_pnl_quote = $7,
        reason = $8,
        computed_at = $9,
        attempts = attempts + 1
       WHERE decision_id = $1 AND horizon_ms = $2 AND reference_policy_version = $3 AND state = 'PENDING'
       RETURNING *`,
      [
        markout.decisionId,
        markout.horizonMs,
        markout.referencePolicyVersion,
        markout.status,
        markout.futureReference === null ? null : JSON.stringify(markout.futureReference),
        markout.directionalMarkoutBps,
        markout.directionalPnlQuote,
        markout.reason,
        markout.computedAtMs === null ? null : new Date(markout.computedAtMs)
      ]
    );
    if (result.rows[0]) return markoutFromRow(result.rows[0]);
    const existing = await this.#pool.query(
      "SELECT * FROM paper_markouts WHERE decision_id=$1 AND horizon_ms=$2 AND reference_policy_version=$3",
      [markout.decisionId, markout.horizonMs, markout.referencePolicyVersion]
    );
    if (!existing.rows[0]) throw new Error("MARKOUT_NOT_FOUND");
    return markoutFromRow(existing.rows[0]);
  }

  async performance(): Promise<PaperPerformanceSummary> {
    const [result, reasonResult] = await Promise.all([
      this.#pool.query(`
      SELECT
        count(*) FILTER (WHERE m.state='SCORED')::int AS scored_count,
        count(*) FILTER (WHERE m.state='UNSCORED')::int AS unscored_count,
        count(*) FILTER (WHERE m.state='PENDING')::int AS pending_count,
        count(*) FILTER (WHERE d.action='BUY')::int AS buy_count,
        count(*) FILTER (WHERE d.action='SELL')::int AS sell_count,
        count(*) FILTER (WHERE d.action='WAIT')::int AS wait_count,
        count(*) FILTER (WHERE m.state='SCORED' AND m.directional_markout_bps > 0)::int AS win_count,
        avg(m.directional_markout_bps) FILTER (WHERE m.state='SCORED') AS mean_bps
      FROM paper_decisions d JOIN paper_markouts m ON m.decision_id=d.decision_id
    `),
      this.#pool.query(`
        SELECT reason, count(*)::int AS count
        FROM paper_markouts
        WHERE state='UNSCORED' AND reason IS NOT NULL
        GROUP BY reason
        ORDER BY count DESC, reason ASC
      `)
    ]);
    const row = result.rows[0] ?? {};
    return {
      scoredCount: Number(row.scored_count ?? 0),
      unscoredCount: Number(row.unscored_count ?? 0),
      pendingCount: Number(row.pending_count ?? 0),
      buyCount: Number(row.buy_count ?? 0),
      sellCount: Number(row.sell_count ?? 0),
      waitCount: Number(row.wait_count ?? 0),
      winCount: Number(row.win_count ?? 0),
      meanDirectionalMarkoutBps: row.mean_bps === null || row.mean_bps === undefined ? null : String(row.mean_bps),
      unscoredReasonCounts: Object.fromEntries(reasonResult.rows.map((reasonRow) => [String(reasonRow.reason), Number(reasonRow.count)]))
    };
  }
}
