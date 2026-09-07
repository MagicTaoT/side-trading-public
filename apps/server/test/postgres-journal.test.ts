import { S0SignalEngine } from "@side/signal-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { DexReferenceSnapshot, PaperOrder } from "../src/paper/contracts.js";
import { PAPER_MARKOUT_HORIZON_MS, REFERENCE_POLICY_VERSION } from "../src/paper/contracts.js";
import { JournalConflictError, PostgresDecisionJournal } from "../src/paper/journal.js";
import { MarkoutWorker } from "../src/paper/markout.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const journals: PostgresDecisionJournal[] = [];

function reference(price: string, atMs: number): DexReferenceSnapshot {
  return {
    policyVersion: REFERENCE_POLICY_VERSION,
    status: "READY",
    evaluatedAtMs: atMs,
    windowStartMs: atMs - 15_000,
    windowEndMs: atMs,
    priceQuotePerSol: price,
    sampleCount: 3,
    rejectedSampleCount: 0,
    reason: null
  };
}

function order(): PaperOrder {
  const recordedAtMs = 1_000;
  return {
    schemaVersion: 1,
    orderId: "paper:postgres-restart",
    executionMode: "paper",
    persistence: "postgres-side-011",
    action: "BUY",
    pair: "SOL-USDC",
    targetNotionalQuote: "10000",
    provider: "zeroex",
    previewId: "preview:postgres",
    recordedAtMs,
    preview: null,
    evidence: { mode: "REPLAY", signal: new S0SignalEngine().snapshot(), sources: [] },
    markout: {
      decisionId: "paper:postgres-restart",
      horizonMs: PAPER_MARKOUT_HORIZON_MS,
      referencePolicyVersion: REFERENCE_POLICY_VERSION,
      dueAtMs: recordedAtMs + PAPER_MARKOUT_HORIZON_MS,
      status: "PENDING",
      entryReference: reference("100", recordedAtMs),
      futureReference: null,
      directionalMarkoutBps: null,
      directionalPnlQuote: null,
      reason: null,
      computedAtMs: null
    }
  };
}

beforeEach(async () => {
  if (!databaseUrl) return;
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`
    DROP TABLE IF EXISTS paper_markouts, paper_order_snapshots, decision_evidence_snapshots, paper_decisions, side_schema_migrations CASCADE
  `);
  await pool.end();
});

afterEach(async () => {
  await Promise.all(journals.splice(0).map((journal) => journal.close()));
});

describePostgres("PostgreSQL SIDE-011 journal", () => {
  it("migrates, survives restart, catches up and remains idempotent with duplicate workers", async () => {
    const first = new PostgresDecisionJournal(databaseUrl as string);
    journals.push(first);
    await first.initialize();
    const input = { order: order(), idempotencyKey: "postgres-record-001", requestFingerprint: "BUY:preview:postgres:zeroex" };
    await first.recordDecision(input);
    await first.close();
    journals.splice(journals.indexOf(first), 1);

    const restarted = new PostgresDecisionJournal(databaseUrl as string);
    journals.push(restarted);
    await restarted.initialize();
    expect(await restarted.getDecision(input.order.orderId)).toMatchObject({
      orderId: input.order.orderId,
      persistence: "postgres-side-011",
      markout: { status: "PENDING" }
    });
    expect((await restarted.recordDecision(input)).orderId).toBe(input.order.orderId);
    await expect(restarted.recordDecision({ ...input, requestFingerprint: "SELL:preview:postgres:zeroex" }))
      .rejects.toBeInstanceOf(JournalConflictError);

    const workerA = new MarkoutWorker({ journal: restarted, now: () => 301_001, reference: () => reference("105", 301_000) });
    const workerB = new MarkoutWorker({ journal: restarted, now: () => 301_001, reference: () => reference("105", 301_000) });
    await Promise.all([workerA.runOnce(), workerB.runOnce()]);

    expect(await restarted.getDecision(input.order.orderId)).toMatchObject({
      markout: {
        status: "SCORED",
        directionalMarkoutBps: "500.00000000",
        directionalPnlQuote: "500.000000",
        futureReference: { sampleCount: 3 }
      }
    });
    expect(await restarted.performance()).toMatchObject({ scoredCount: 1, pendingCount: 0, winCount: 1 });

    const pool = new Pool({ connectionString: databaseUrl as string });
    const rows = await pool.query("SELECT attempts FROM paper_markouts WHERE decision_id=$1", [input.order.orderId]);
    expect(rows.rows).toEqual([{ attempts: 1 }]);
    expect(await restarted.deleteDecision(input.order.orderId)).toBe(true);
    expect(await restarted.getDecision(input.order.orderId)).toBeNull();
    const cascaded = await pool.query(
      `SELECT
        (SELECT count(*) FROM paper_decisions)::int AS decisions,
        (SELECT count(*) FROM decision_evidence_snapshots)::int AS evidence,
        (SELECT count(*) FROM paper_order_snapshots)::int AS orders,
        (SELECT count(*) FROM paper_markouts)::int AS markouts`
    );
    expect(cascaded.rows).toEqual([{ decisions: 0, evidence: 0, orders: 0, markouts: 0 }]);
    await pool.end();
  });
});
