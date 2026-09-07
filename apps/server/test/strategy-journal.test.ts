import type {
  StrategyBasketSnapshot,
  StrategyConfigV1,
  StrategyEvent,
  StrategyFill,
  StrategySnapshot,
  StrategyState
} from "@side/strategy-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type {
  RecordStrategyBatchInput,
  StrategyBasketRecord,
  StrategyRunRecord
} from "../src/strategy/contracts.js";
import {
  MemoryStrategyJournal,
  PostgresStrategyJournal,
  StrategyJournalConflictError,
  type StrategyJournal
} from "../src/strategy/journal.js";

const config: StrategyConfigV1 = {
  schemaVersion: 1,
  name: "persistent-edge",
  pair: "SOL-USDC",
  entry: { minEdgeBps: "8", holdSec: 10, initialSizeQuote: "100" },
  scaling: {
    enabled: true,
    intervalSec: 5,
    intervalMultiplier: "1",
    sizeQuote: "50",
    sizeMultiplier: "0.8",
    maxEntries: 4,
    maxTotalSizeQuote: "250"
  },
  exit: { takeProfitBps: "20", linearDecayToZero: true, stopLossBps: "30", forceExitSec: 300 },
  cooldownSec: 20
};

function snapshot(
  state: StrategyState,
  atMs: number,
  eventSequence: number,
  basket: StrategyBasketSnapshot | null = null,
  stoppedAtMs: number | null = null
): StrategySnapshot {
  return {
    schemaVersion: 1,
    configFingerprint: "sha256:test-config",
    state,
    startedAtMs: 1_000,
    stoppedAtMs,
    evaluatedAtMs: atMs,
    lastObservation: null,
    arming: null,
    currentBasket: basket?.status === "CLOSED" ? null : basket,
    lastClosedBasket: basket?.status === "CLOSED" ? basket : null,
    basketCount: basket ? 1 : 0,
    eventSequence,
    fillSequence: basket ? basket.entries.length + (basket.exitFill ? 1 : 0) : 0,
    cooldownUntilMs: state === "COOLDOWN" ? atMs + 20_000 : null,
    pendingExitReason: null,
    stopRequested: false
  };
}

function run(state: StrategyState, atMs: number, eventSequence: number, basket: StrategyBasketSnapshot | null = null): StrategyRunRecord {
  const stoppedAtMs = state === "STOPPED" ? atMs : null;
  return {
    runId: "strategy-run:test-1",
    strategyId: "strategy:test",
    configRevision: 1,
    executionMode: "DRY_RUN",
    status: state,
    startedAtMs: 1_000,
    updatedAtMs: atMs,
    completedAtMs: stoppedAtMs,
    snapshot: snapshot(state, atMs, eventSequence, basket, stoppedAtMs)
  };
}

function event(
  sequence: number,
  kind: StrategyEvent["kind"],
  atMs: number,
  fromState: StrategyState,
  toState: StrategyState,
  basket: StrategyBasketSnapshot | null = null,
  fill: StrategyFill | null = null
): StrategyEvent {
  return {
    schemaVersion: 1,
    sequence,
    kind,
    atMs,
    fromState,
    toState,
    reason: kind === "RUN_STOPPED" ? "MANUAL_STOP" : null,
    basketSequence: basket?.basketSequence ?? null,
    observation: null,
    fill,
    basket
  };
}

function entryFill(): StrategyFill {
  return {
    sequence: 1,
    kind: "ENTRY",
    direction: "BUY",
    atMs: 2_000,
    price: "100",
    referenceSource: "theoretical-test",
    quoteNotional: "100",
    scheduledQuoteNotional: "100",
    baseQuantity: "1",
    edgeBps: "10",
    cappedByMaxTotal: false
  };
}

function openBasket(): StrategyBasketSnapshot {
  return {
    basketSequence: 1,
    direction: "BUY",
    status: "OPEN",
    openedAtMs: 2_000,
    closedAtMs: null,
    entries: [entryFill()],
    exitFill: null,
    totalQuoteNotional: "100",
    totalBaseQuantity: "1",
    averageEntryPrice: "100",
    currentPrice: "100",
    currentReferenceSource: "theoretical-test",
    grossPnlBps: "0",
    grossPnlQuote: "0",
    currentTargetProfitBps: "20",
    exitReason: null,
    nextEntryQualificationSinceMs: null,
    nextEntryDueAtMs: 7_000
  };
}

function closedBasket(): StrategyBasketSnapshot {
  const exit: StrategyFill = {
    sequence: 2,
    kind: "EXIT",
    direction: "BUY",
    atMs: 3_000,
    price: "101",
    referenceSource: "theoretical-test",
    quoteNotional: "101",
    scheduledQuoteNotional: "101",
    baseQuantity: "1",
    edgeBps: "11",
    cappedByMaxTotal: false
  };
  return {
    ...openBasket(),
    status: "CLOSED",
    closedAtMs: 3_000,
    exitFill: exit,
    currentPrice: "101",
    grossPnlBps: "100",
    grossPnlQuote: "1",
    exitReason: "TAKE_PROFIT",
    nextEntryDueAtMs: null
  };
}

function basketRecord(runId: string, basket: StrategyBasketSnapshot, updatedAtMs: number): StrategyBasketRecord {
  return {
    basketId: `${runId}:basket:${basket.basketSequence}`,
    runId,
    basketSequence: basket.basketSequence,
    direction: basket.direction,
    status: basket.status,
    openedAtMs: basket.openedAtMs,
    updatedAtMs,
    closedAtMs: basket.closedAtMs,
    snapshot: basket
  };
}

async function exerciseJournal(journal: StrategyJournal): Promise<void> {
  await journal.initialize();
  const first = await journal.createConfigRevision({ strategyId: "strategy:test", config, createdAtMs: 500 });
  expect(first).toMatchObject({ strategyId: "strategy:test", revision: 1, name: "persistent-edge" });

  const sameRevision = await journal.createConfigRevision({ strategyId: "strategy:test", revision: 1, config, createdAtMs: 999 });
  expect(sameRevision).toEqual(first);
  await expect(journal.createConfigRevision({
    strategyId: "strategy:test",
    revision: 1,
    config: { ...config, cooldownSec: 99 },
    createdAtMs: 500
  })).rejects.toMatchObject({ code: "CONFIG_REVISION_IMMUTABLE" });

  const started = run("IDLE", 1_000, 1);
  await journal.createRun({ run: started, event: event(1, "RUN_STARTED", 1_000, "STOPPED", "IDLE") });
  const opened = openBasket();
  const openRun = run("OPEN", 2_000, 2, opened);
  const openRecord = basketRecord(openRun.runId, opened, 2_000);
  await journal.recordFill({
    run: openRun,
    basket: openRecord,
    event: event(2, "ENTRY_FILLED", 2_000, "ARMING", "OPEN", opened, entryFill())
  });

  const qualified = {
    ...opened,
    currentPrice: "100.1",
    grossPnlBps: "10",
    grossPnlQuote: "0.1",
    nextEntryQualificationSinceMs: 2_500,
    nextEntryDueAtMs: 7_500
  };
  const checkpointed = run("OPEN", 2_500, 2, qualified);
  await journal.checkpoint({
    run: checkpointed,
    basket: basketRecord(checkpointed.runId, qualified, 2_500)
  });

  const active = await journal.recoverActiveRuns();
  expect(active).toHaveLength(1);
  expect(active[0]).toMatchObject({
    configRevision: { revision: 1, config: { entry: { minEdgeBps: "8" } } },
    run: { runId: openRun.runId, status: "OPEN", snapshot: { evaluatedAtMs: 2_500 } }
  });
  expect(Object.keys(active[0] as object).sort()).toEqual(["configRevision", "run"]);
  expect(await journal.getRunRecovery(openRun.runId)).toEqual(active[0]);

  const activeHistory = await journal.getRunHistory(openRun.runId);
  expect(activeHistory).toMatchObject({
    baskets: [{
      basketId: openRecord.basketId,
      status: "OPEN",
      snapshot: { nextEntryQualificationSinceMs: 2_500, nextEntryDueAtMs: 7_500 }
    }]
  });
  expect(activeHistory?.events.map(({ event: item, eventClass }) => [item.kind, eventClass, item.basket])).toEqual([
    ["RUN_STARTED", "STATE_CHANGE", null],
    ["ENTRY_FILLED", "FILL", null]
  ]);

  const closed = closedBasket();
  // The engine emits EXIT_FILLED + RUN_STOPPED together for a manual stop with
  // a usable price. The batch exposes the final STOPPED snapshot atomically.
  const stopped = run("STOPPED", 3_000, 4, closed);
  const terminalBatch: RecordStrategyBatchInput = {
    run: stopped,
    records: [
      {
        basket: basketRecord(stopped.runId, closed, 3_000),
        event: { ...event(3, "EXIT_FILLED", 3_000, "OPEN", "STOPPED", closed, closed.exitFill), reason: "MANUAL_STOP" }
      },
      {
        basket: basketRecord(stopped.runId, closed, 3_000),
        event: event(4, "RUN_STOPPED", 3_000, "STOPPED", "STOPPED", closed)
      }
    ]
  };
  const terminalRecords = await journal.recordBatch(terminalBatch);
  expect(terminalRecords.map(({ eventClass }) => eventClass)).toEqual(["FILL", "STATE_CHANGE"]);
  expect(terminalRecords.every(({ event: item }) => item.basket === null)).toBe(true);
  expect(terminalBatch.records[0]?.event.basket).toEqual(closed);
  expect(await journal.recordBatch(terminalBatch)).toHaveLength(2);

  expect(await journal.recoverActiveRuns()).toEqual([]);
  const stoppedHistory = await journal.getRunHistory(stopped.runId);
  expect(stoppedHistory?.events.map(({ event: item }) => item.kind)).toEqual([
    "RUN_STARTED", "ENTRY_FILLED", "EXIT_FILLED", "RUN_STOPPED"
  ]);
  expect(stoppedHistory?.events.every(({ event: item }) => item.basket === null)).toBe(true);
  expect(await journal.listBaskets(stopped.runId)).toMatchObject([{ status: "CLOSED", snapshot: { grossPnlQuote: "1" } }]);
  expect(await journal.listRuns(10, "strategy:test")).toMatchObject([{ status: "STOPPED" }]);
}

describe("strategy journal", () => {
  it("keeps immutable config revisions and sparse state/fill history in memory", async () => {
    const journal = new MemoryStrategyJournal();
    await exerciseJournal(journal);

    const returned = await journal.getConfigRevision("strategy:test", 1);
    if (!returned) throw new Error("missing config");
    returned.config.entry.minEdgeBps = "999";
    expect((await journal.getConfigRevision("strategy:test", 1))?.config.entry.minEdgeBps).toBe("8");
  });

  it("rejects a fill-shaped event from the state-change path", async () => {
    const journal = new MemoryStrategyJournal();
    await journal.createConfigRevision({ strategyId: "strategy:test", config, createdAtMs: 500 });
    const started = run("IDLE", 1_000, 1);
    await journal.createRun({ run: started, event: event(1, "RUN_STARTED", 1_000, "STOPPED", "IDLE") });
    const opened = openBasket();
    await expect(journal.recordStateChange({
      run: run("OPEN", 2_000, 2, opened),
      basket: basketRecord(started.runId, opened, 2_000),
      event: event(2, "ENTRY_FILLED", 2_000, "ARMING", "OPEN", opened, entryFill())
    })).rejects.toBeInstanceOf(StrategyJournalConflictError);
  });

  it("atomically records the two events produced by a holdSec=0 entry", async () => {
    const journal = new MemoryStrategyJournal();
    const instantConfig = { ...config, entry: { ...config.entry, holdSec: 0 } };
    await journal.createConfigRevision({ strategyId: "strategy:test", config: instantConfig, createdAtMs: 500 });
    const started = run("IDLE", 1_000, 1);
    await journal.createRun({ run: started, event: event(1, "RUN_STARTED", 1_000, "STOPPED", "IDLE") });
    const opened = openBasket();
    const openRun = run("OPEN", 2_000, 3, opened);
    const records = await journal.recordBatch({
      run: openRun,
      records: [
        { event: event(2, "ARMING_STARTED", 2_000, "IDLE", "ARMING") },
        {
          basket: basketRecord(openRun.runId, opened, 2_000),
          event: event(3, "ENTRY_FILLED", 2_000, "ARMING", "OPEN", opened, entryFill())
        }
      ]
    });

    expect(records.map(({ event: item }) => item.kind)).toEqual(["ARMING_STARTED", "ENTRY_FILLED"]);
    expect(records.every(({ event: item }) => item.basket === null)).toBe(true);
    expect(await journal.getRun(openRun.runId)).toMatchObject({ status: "OPEN", snapshot: { eventSequence: 3 } });
    expect((await journal.listEvents(openRun.runId, 10)).map(({ event: item }) => item.kind)).toEqual([
      "RUN_STARTED", "ARMING_STARTED", "ENTRY_FILLED"
    ]);
  });

  it("rolls back every in-memory mutation when a later batch record conflicts", async () => {
    const journal = new MemoryStrategyJournal();
    await journal.createConfigRevision({ strategyId: "strategy:test", config, createdAtMs: 500 });
    const started = run("IDLE", 1_000, 1);
    await journal.createRun({ run: started, event: event(1, "RUN_STARTED", 1_000, "STOPPED", "IDLE") });
    const opened = openBasket();
    const add: StrategyFill = {
      ...entryFill(),
      sequence: 2,
      kind: "ADD",
      atMs: 2_500,
      quoteNotional: "50",
      scheduledQuoteNotional: "50",
      baseQuantity: "0.5"
    };
    const scaled: StrategyBasketSnapshot = {
      ...opened,
      entries: [...opened.entries, add],
      totalQuoteNotional: "150",
      totalBaseQuantity: "1.5"
    };
    const finalRun = run("OPEN", 2_500, 3, scaled);
    const conflictingBasket = {
      ...basketRecord(finalRun.runId, scaled, 2_500),
      basketId: `${finalRun.runId}:basket:conflict`
    };

    await expect(journal.recordBatch({
      run: finalRun,
      records: [
        {
          basket: basketRecord(finalRun.runId, opened, 2_000),
          event: event(2, "ENTRY_FILLED", 2_000, "IDLE", "OPEN", opened, entryFill())
        },
        {
          basket: conflictingBasket,
          event: event(3, "ADD_FILLED", 2_500, "OPEN", "OPEN", scaled, add)
        }
      ]
    })).rejects.toMatchObject({ code: "BASKET_ID_REUSED" });
    expect(await journal.getRun(started.runId)).toEqual(started);
    expect(await journal.listBaskets(started.runId)).toEqual([]);
    expect((await journal.listEvents(started.runId, 10)).map(({ event: item }) => item.kind)).toEqual(["RUN_STARTED"]);
  });

  it("allows only one active run and rejects non-audit writes after completion", async () => {
    const journal = new MemoryStrategyJournal();
    await journal.createConfigRevision({ strategyId: "strategy:test", config, createdAtMs: 500 });
    const started = run("IDLE", 1_000, 1);
    await journal.createRun({ run: started, event: event(1, "RUN_STARTED", 1_000, "STOPPED", "IDLE") });

    const anotherRun = { ...started, runId: "strategy-run:test-2" };
    await expect(journal.createRun({
      run: anotherRun,
      event: event(1, "RUN_STARTED", 1_000, "STOPPED", "IDLE")
    })).rejects.toMatchObject({ code: "ACTIVE_RUN_EXISTS" });

    const stopped = run("STOPPED", 2_000, 2);
    await journal.recordStateChange({
      run: stopped,
      event: event(2, "RUN_STOPPED", 2_000, "IDLE", "STOPPED")
    });
    const forbiddenPostCompletion = {
      ...stopped,
      updatedAtMs: 3_000,
      snapshot: { ...stopped.snapshot, evaluatedAtMs: 3_000, eventSequence: 3 }
    };
    await expect(journal.recordStateChange({
      run: forbiddenPostCompletion,
      event: event(3, "ARMING_STARTED", 3_000, "STOPPED", "ARMING")
    })).rejects.toMatchObject({ code: "RUN_ALREADY_COMPLETED" });
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const postgresJournals: PostgresStrategyJournal[] = [];

beforeEach(async () => {
  if (!databaseUrl) return;
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query("DROP TABLE IF EXISTS strategy_events, strategy_baskets, strategy_runs, strategy_config_revisions CASCADE");
  await pool.end();
});

afterEach(async () => {
  await Promise.all(postgresJournals.splice(0).map((journal) => journal.close()));
});

describePostgres("PostgreSQL strategy journal", () => {
  it("migrates, restores an active run after restart, and preserves history", async () => {
    const first = new PostgresStrategyJournal(databaseUrl as string);
    postgresJournals.push(first);
    await first.initialize();
    await first.createConfigRevision({ strategyId: "strategy:test", config, createdAtMs: 500 });
    const started = run("IDLE", 1_000, 1);
    await first.createRun({ run: started, event: event(1, "RUN_STARTED", 1_000, "STOPPED", "IDLE") });
    const opened = openBasket();
    const openRun = run("OPEN", 2_000, 2, opened);
    await first.recordFill({
      run: openRun,
      basket: basketRecord(openRun.runId, opened, 2_000),
      event: event(2, "ENTRY_FILLED", 2_000, "ARMING", "OPEN", opened, entryFill())
    });
    await first.close();
    postgresJournals.splice(postgresJournals.indexOf(first), 1);

    const restarted = new PostgresStrategyJournal(databaseUrl as string);
    postgresJournals.push(restarted);
    await restarted.initialize();
    const active = await restarted.recoverActiveRuns();
    expect(active).toMatchObject([{ run: { status: "OPEN" }, configRevision: { revision: 1 } }]);
    expect(Object.keys(active[0] as object).sort()).toEqual(["configRevision", "run"]);
    expect(await restarted.getRunRecovery(openRun.runId)).toEqual(active[0]);
    expect(await restarted.getRunHistory(openRun.runId)).toMatchObject({
      baskets: [{ status: "OPEN" }],
      events: [{ eventClass: "STATE_CHANGE" }, { eventClass: "FILL" }]
    });

    await expect(restarted.createRun({
      run: { ...started, runId: "strategy-run:test-2" },
      event: event(1, "RUN_STARTED", 1_000, "STOPPED", "IDLE")
    })).rejects.toMatchObject({ code: "ACTIVE_RUN_EXISTS" });

    const closed = closedBasket();
    const stopped = run("STOPPED", 3_000, 4, closed);
    await restarted.recordBatch({
      run: stopped,
      records: [
        {
          basket: basketRecord(stopped.runId, closed, 3_000),
          event: { ...event(3, "EXIT_FILLED", 3_000, "OPEN", "STOPPED", closed, closed.exitFill), reason: "MANUAL_STOP" }
        },
        {
          basket: basketRecord(stopped.runId, closed, 3_000),
          event: event(4, "RUN_STOPPED", 3_000, "STOPPED", "STOPPED", closed)
        }
      ]
    });
    expect(await restarted.recoverActiveRuns()).toEqual([]);

    const pool = new Pool({ connectionString: databaseUrl as string });
    const stored = await pool.query(
      `SELECT event_kind, event_class,
        event_snapshot->'basket' = 'null'::jsonb AS basket_is_null
      FROM strategy_events ORDER BY event_sequence ASC`
    );
    expect(stored.rows).toEqual([
      { event_kind: "RUN_STARTED", event_class: "STATE_CHANGE", basket_is_null: true },
      { event_kind: "ENTRY_FILLED", event_class: "FILL", basket_is_null: true },
      { event_kind: "EXIT_FILLED", event_class: "FILL", basket_is_null: true },
      { event_kind: "RUN_STOPPED", event_class: "STATE_CHANGE", basket_is_null: true }
    ]);
    await pool.end();
  });

  it("rolls back the full PostgreSQL batch when its second event fails", async () => {
    const journal = new PostgresStrategyJournal(databaseUrl as string);
    postgresJournals.push(journal);
    await journal.initialize();
    await journal.createConfigRevision({ strategyId: "strategy:test", config, createdAtMs: 500 });
    const started = run("IDLE", 1_000, 1);
    await journal.createRun({ run: started, event: event(1, "RUN_STARTED", 1_000, "STOPPED", "IDLE") });

    const pool = new Pool({ connectionString: databaseUrl as string });
    await pool.query(`
      CREATE OR REPLACE FUNCTION strategy_batch_rollback_test() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced batch rollback'; END $$;
      CREATE TRIGGER strategy_batch_rollback_trigger
      BEFORE INSERT ON strategy_events FOR EACH ROW
      WHEN (NEW.event_kind = 'RUN_STOPPED')
      EXECUTE FUNCTION strategy_batch_rollback_test();
    `);
    try {
      const closed = closedBasket();
      const stopped = run("STOPPED", 3_000, 3, closed);
      await expect(journal.recordBatch({
        run: stopped,
        records: [
          {
            basket: basketRecord(stopped.runId, closed, 3_000),
            event: { ...event(2, "EXIT_FILLED", 3_000, "IDLE", "STOPPED", closed, closed.exitFill), reason: "MANUAL_STOP" }
          },
          {
            basket: basketRecord(stopped.runId, closed, 3_000),
            event: event(3, "RUN_STOPPED", 3_000, "STOPPED", "STOPPED", closed)
          }
        ]
      })).rejects.toThrow("forced batch rollback");

      expect(await journal.getRun(started.runId)).toEqual(started);
      expect(await journal.listBaskets(started.runId)).toEqual([]);
      expect((await journal.listEvents(started.runId, 10)).map(({ event: item }) => item.kind)).toEqual(["RUN_STARTED"]);
    } finally {
      await pool.query("DROP FUNCTION IF EXISTS strategy_batch_rollback_test() CASCADE");
      await pool.end();
    }
  });
});
