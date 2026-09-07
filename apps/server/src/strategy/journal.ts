import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolClient, QueryResultRow } from "pg";
import pg from "pg";
import type { StrategyEvent } from "@side/strategy-engine";
import type {
  CheckpointStrategyRunInput,
  CreateStrategyConfigRevisionInput,
  CreateStrategyRunInput,
  RecordStrategyBatchInput,
  RecordStrategyEventInput,
  StrategyBasketRecord,
  StrategyConfigRevision,
  StrategyEventClass,
  StrategyJournalEvent,
  StrategyPersistence,
  StrategyRecovery,
  StrategyRunRecovery,
  StrategyRunRecord
} from "./contracts.js";

const { Pool } = pg;

const FILL_EVENT_KINDS = new Set<StrategyEvent["kind"]>(["ENTRY_FILLED", "ADD_FILLED", "EXIT_FILLED"]);
const STATE_EVENT_KINDS = new Set<StrategyEvent["kind"]>([
  "RUN_STARTED",
  "RUN_STOPPED",
  "ARMING_STARTED",
  "ARMING_RESET",
  "EXIT_PENDING_PRICE",
  "COOLDOWN_COMPLETED"
]);

export type StrategyJournalErrorCode =
  | "CONFIG_REVISION_IMMUTABLE"
  | "CONFIG_REVISION_NOT_FOUND"
  | "RUN_ID_REUSED"
  | "RUN_NOT_FOUND"
  | "RUN_ALREADY_COMPLETED"
  | "ACTIVE_RUN_EXISTS"
  | "BASKET_ID_REUSED"
  | "EVENT_SEQUENCE_REUSED"
  | "STALE_SNAPSHOT"
  | "INVALID_STRATEGY_RECORD"
  | "INVALID_STRATEGY_EVENT";

export class StrategyJournalConflictError extends Error {
  constructor(readonly code: StrategyJournalErrorCode) {
    super(code);
  }
}

export interface StrategyJournal {
  readonly persistence: StrategyPersistence;
  initialize(): Promise<void>;
  close(): Promise<void>;
  createConfigRevision(input: CreateStrategyConfigRevisionInput): Promise<StrategyConfigRevision>;
  getConfigRevision(strategyId: string, revision?: number): Promise<StrategyConfigRevision | null>;
  listConfigRevisions(limit: number, strategyId?: string): Promise<StrategyConfigRevision[]>;
  createRun(input: CreateStrategyRunInput): Promise<StrategyRunRecord>;
  checkpoint(input: CheckpointStrategyRunInput): Promise<StrategyRunRecord>;
  recordBatch(input: RecordStrategyBatchInput): Promise<StrategyJournalEvent[]>;
  recordStateChange(input: RecordStrategyEventInput): Promise<StrategyJournalEvent>;
  recordFill(input: RecordStrategyEventInput & { basket: StrategyBasketRecord }): Promise<StrategyJournalEvent>;
  getRun(runId: string): Promise<StrategyRunRecord | null>;
  getRunRecovery(runId: string): Promise<StrategyRunRecovery | null>;
  getRunHistory(runId: string): Promise<StrategyRecovery | null>;
  listRuns(limit: number, strategyId?: string): Promise<StrategyRunRecord[]>;
  listBaskets(runId: string): Promise<StrategyBasketRecord[]>;
  listEvents(runId: string, limit: number): Promise<StrategyJournalEvent[]>;
  recoverActiveRuns(): Promise<StrategyRunRecovery[]>;
}

interface CanonicalValue {
  text: string;
  hash: string;
}

function invalid(code: StrategyJournalErrorCode): never {
  throw new StrategyJournalConflictError(code);
}

function assertId(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) invalid("INVALID_STRATEGY_RECORD");
}

function assertTime(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) invalid("INVALID_STRATEGY_RECORD");
}

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("INVALID_STRATEGY_RECORD");
    return value;
  }
  if (typeof value !== "object") invalid("INVALID_STRATEGY_RECORD");
  if (seen.has(value)) invalid("INVALID_STRATEGY_RECORD");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item, seen)])
    );
  } finally {
    seen.delete(value);
  }
}

function canonical(value: unknown): CanonicalValue {
  const text = JSON.stringify(canonicalize(value, new Set()));
  return { text, hash: `sha256:${createHash("sha256").update(text).digest("hex")}` };
}

function clone<T>(value: T): T {
  return JSON.parse(canonical(value).text) as T;
}

function milliseconds(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error("INVALID_DATABASE_TIMESTAMP");
  return parsed;
}

function objectJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) invalid("INVALID_STRATEGY_RECORD");
  return Math.min(limit, 1_000);
}

function eventClass(event: StrategyEvent): StrategyEventClass {
  const fillKind = FILL_EVENT_KINDS.has(event.kind);
  const stateKind = STATE_EVENT_KINDS.has(event.kind);
  if ((!fillKind && !stateKind) || fillKind !== (event.fill !== null)) invalid("INVALID_STRATEGY_EVENT");
  return fillKind ? "FILL" : "STATE_CHANGE";
}

function validateConfigInput(input: CreateStrategyConfigRevisionInput): void {
  assertId(input.strategyId);
  assertTime(input.createdAtMs);
  if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 1)) {
    invalid("INVALID_STRATEGY_RECORD");
  }
  if (input.config.schemaVersion !== 1 || !input.config.name) invalid("INVALID_STRATEGY_RECORD");
  canonical(input.config);
}

function validateRun(run: StrategyRunRecord): void {
  assertId(run.runId);
  assertId(run.strategyId);
  assertTime(run.startedAtMs);
  assertTime(run.updatedAtMs);
  assertTime(run.completedAtMs);
  if (run.configRevision < 1 || run.executionMode !== "DRY_RUN" || run.updatedAtMs < run.startedAtMs) {
    invalid("INVALID_STRATEGY_RECORD");
  }
  if (run.completedAtMs !== null && run.completedAtMs < run.startedAtMs) invalid("INVALID_STRATEGY_RECORD");
  if (run.status !== run.snapshot.state || run.startedAtMs !== run.snapshot.startedAtMs || run.completedAtMs !== run.snapshot.stoppedAtMs) {
    invalid("INVALID_STRATEGY_RECORD");
  }
  canonical(run.snapshot);
}

function validateBasket(basket: StrategyBasketRecord, run: StrategyRunRecord): void {
  assertId(basket.basketId);
  assertTime(basket.openedAtMs);
  assertTime(basket.updatedAtMs);
  assertTime(basket.closedAtMs);
  if (
    basket.runId !== run.runId ||
    !Number.isSafeInteger(basket.basketSequence) || basket.basketSequence < 1 ||
    basket.basketSequence !== basket.snapshot.basketSequence ||
    basket.direction !== basket.snapshot.direction ||
    basket.status !== basket.snapshot.status ||
    basket.openedAtMs !== basket.snapshot.openedAtMs ||
    basket.closedAtMs !== basket.snapshot.closedAtMs ||
    basket.updatedAtMs < basket.openedAtMs
  ) {
    invalid("INVALID_STRATEGY_RECORD");
  }
  canonical(basket.snapshot);
}

function validateEvent(input: RecordStrategyEventInput, expectedClass: StrategyEventClass): void {
  validateRun(input.run);
  const actualClass = eventClass(input.event);
  if (actualClass !== expectedClass || !Number.isSafeInteger(input.event.sequence) || input.event.sequence < 1) {
    invalid("INVALID_STRATEGY_EVENT");
  }
  assertTime(input.event.atMs);
  if (input.event.sequence > input.run.snapshot.eventSequence || input.event.atMs > input.run.updatedAtMs) {
    invalid("INVALID_STRATEGY_EVENT");
  }
  const basketSequence = input.event.basketSequence;
  if (basketSequence === null) {
    if (expectedClass === "FILL" || input.basket) invalid("INVALID_STRATEGY_EVENT");
  } else {
    if (
      !input.basket ||
      input.basket.basketSequence !== basketSequence ||
      input.event.basket === null ||
      !same(input.event.basket, input.basket.snapshot)
    ) invalid("INVALID_STRATEGY_EVENT");
    validateBasket(input.basket, input.run);
  }
  canonical(input.event);
}

function validateBatch(input: RecordStrategyBatchInput): StrategyEventClass[] {
  validateRun(input.run);
  if (!Array.isArray(input.records) || input.records.length === 0) invalid("INVALID_STRATEGY_EVENT");
  const classes: StrategyEventClass[] = [];
  let previous: StrategyEvent | null = null;
  for (const record of input.records) {
    const currentClass = eventClass(record.event);
    validateEvent({
      run: input.run,
      event: record.event,
      ...(record.basket === undefined ? {} : { basket: record.basket })
    }, currentClass);
    if (previous && (
      record.event.sequence !== previous.sequence + 1 ||
      record.event.atMs < previous.atMs ||
      record.event.fromState !== previous.toState
    )) invalid("INVALID_STRATEGY_EVENT");
    previous = record.event;
    classes.push(currentClass);
  }
  if (
    previous?.sequence !== input.run.snapshot.eventSequence ||
    previous.toState !== input.run.status
  ) invalid("INVALID_STRATEGY_EVENT");
  return classes;
}

function validateRunStart(input: CreateStrategyRunInput): void {
  if (
    input.event.kind !== "RUN_STARTED" ||
    input.event.sequence !== 1 ||
    input.event.fromState !== "STOPPED" ||
    input.event.toState !== "IDLE" ||
    input.run.status !== "IDLE" ||
    input.run.completedAtMs !== null ||
    input.run.snapshot.eventSequence !== 1
  ) invalid("INVALID_STRATEGY_EVENT");
  validateEvent({ run: input.run, event: input.event }, "STATE_CHANGE");
}

function configFromRow(row: QueryResultRow): StrategyConfigRevision {
  return {
    strategyId: String(row.strategy_id),
    revision: Number(row.revision),
    name: String(row.name),
    config: objectJson(row.config_snapshot),
    createdAtMs: milliseconds(row.created_at)
  };
}

function runFromRow(row: QueryResultRow): StrategyRunRecord {
  return {
    runId: String(row.run_id),
    strategyId: String(row.strategy_id),
    configRevision: Number(row.config_revision),
    executionMode: "DRY_RUN",
    status: String(row.state) as StrategyRunRecord["status"],
    startedAtMs: milliseconds(row.started_at),
    updatedAtMs: milliseconds(row.updated_at),
    completedAtMs: row.completed_at === null ? null : milliseconds(row.completed_at),
    snapshot: objectJson(row.run_snapshot)
  };
}

function runRecoveryFromRow(row: QueryResultRow): StrategyRunRecovery {
  return {
    run: runFromRow(row),
    configRevision: {
      strategyId: String(row.recovery_config_strategy_id),
      revision: Number(row.recovery_config_revision),
      name: String(row.recovery_config_name),
      config: objectJson(row.recovery_config_snapshot),
      createdAtMs: milliseconds(row.recovery_config_created_at)
    }
  };
}

function basketFromRow(row: QueryResultRow): StrategyBasketRecord {
  return {
    basketId: String(row.basket_id),
    runId: String(row.run_id),
    basketSequence: Number(row.basket_sequence),
    direction: String(row.direction) as StrategyBasketRecord["direction"],
    status: String(row.state) as StrategyBasketRecord["status"],
    openedAtMs: milliseconds(row.opened_at),
    updatedAtMs: milliseconds(row.updated_at),
    closedAtMs: row.closed_at === null ? null : milliseconds(row.closed_at),
    snapshot: objectJson(row.basket_snapshot)
  };
}

function eventFromRow(row: QueryResultRow): StrategyJournalEvent {
  return {
    runId: String(row.run_id),
    basketId: row.basket_id === null ? null : String(row.basket_id),
    eventClass: String(row.event_class) as StrategyEventClass,
    event: eventDelta(objectJson(row.event_snapshot))
  };
}

function eventDelta(event: StrategyEvent): StrategyEvent {
  return clone({ ...event, basket: null });
}

function journalEvent(
  runId: string,
  basketId: string | null,
  event: StrategyEvent,
  kind: StrategyEventClass
): StrategyJournalEvent {
  return clone({ runId, basketId, eventClass: kind, event: eventDelta(event) });
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left).hash === canonical(right).hash;
}

function sameConfigRevisionContent(left: StrategyConfigRevision, right: StrategyConfigRevision): boolean {
  return left.strategyId === right.strategyId &&
    left.revision === right.revision &&
    left.name === right.name &&
    same(left.config, right.config);
}

function isTrailingTerminalEvent(
  current: StrategyRunRecord,
  next: StrategyRunRecord,
  event: StrategyEvent
): boolean {
  return current.completedAtMs !== null &&
    event.kind === "RUN_STOPPED" &&
    event.atMs <= current.updatedAtMs &&
    same(current, next);
}

export class MemoryStrategyJournal implements StrategyJournal {
  readonly persistence = "memory-strategy-v1" as const;
  readonly #configs = new Map<string, StrategyConfigRevision>();
  readonly #runs = new Map<string, StrategyRunRecord>();
  readonly #baskets = new Map<string, StrategyBasketRecord>();
  readonly #events = new Map<string, Map<number, StrategyJournalEvent>>();

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async createConfigRevision(input: CreateStrategyConfigRevisionInput): Promise<StrategyConfigRevision> {
    validateConfigInput(input);
    const revisions = [...this.#configs.values()].filter(({ strategyId }) => strategyId === input.strategyId);
    const revision = input.revision ?? revisions.reduce((highest, current) => Math.max(highest, current.revision), 0) + 1;
    const key = `${input.strategyId}:${revision}`;
    const candidate: StrategyConfigRevision = {
      strategyId: input.strategyId,
      revision,
      name: input.config.name,
      config: clone(input.config),
      createdAtMs: input.createdAtMs
    };
    const existing = this.#configs.get(key);
    if (existing) {
      if (!sameConfigRevisionContent(existing, candidate)) invalid("CONFIG_REVISION_IMMUTABLE");
      return clone(existing);
    }
    this.#configs.set(key, candidate);
    return clone(candidate);
  }

  async getConfigRevision(strategyId: string, revision?: number): Promise<StrategyConfigRevision | null> {
    assertId(strategyId);
    const matches = [...this.#configs.values()]
      .filter((candidate) => candidate.strategyId === strategyId && (revision === undefined || candidate.revision === revision))
      .sort((left, right) => right.revision - left.revision);
    return matches[0] ? clone(matches[0]) : null;
  }

  async listConfigRevisions(limit: number, strategyId?: string): Promise<StrategyConfigRevision[]> {
    const bounded = boundedLimit(limit);
    if (strategyId !== undefined) assertId(strategyId);
    return [...this.#configs.values()]
      .filter((candidate) => strategyId === undefined || candidate.strategyId === strategyId)
      .sort((left, right) => right.createdAtMs - left.createdAtMs || right.revision - left.revision)
      .slice(0, bounded)
      .map(clone);
  }

  async createRun(input: CreateStrategyRunInput): Promise<StrategyRunRecord> {
    validateRunStart(input);
    if (!this.#configs.has(`${input.run.strategyId}:${input.run.configRevision}`)) invalid("CONFIG_REVISION_NOT_FOUND");
    const existing = this.#runs.get(input.run.runId);
    const wrapped = this.#wrapEvent(input.run.runId, null, input.event, "STATE_CHANGE");
    if (existing) {
      const existingEvent = this.#events.get(input.run.runId)?.get(input.event.sequence);
      if (!same(existing, input.run) || !existingEvent || !same(existingEvent, wrapped)) invalid("RUN_ID_REUSED");
      return clone(existing);
    }
    if ([...this.#runs.values()].some(({ completedAtMs }) => completedAtMs === null)) invalid("ACTIVE_RUN_EXISTS");
    this.#runs.set(input.run.runId, clone(input.run));
    this.#events.set(input.run.runId, new Map([[input.event.sequence, wrapped]]));
    return clone(input.run);
  }

  async recordStateChange(input: RecordStrategyEventInput): Promise<StrategyJournalEvent> {
    validateEvent(input, "STATE_CHANGE");
    return this.#record(input, "STATE_CHANGE");
  }

  async checkpoint(input: CheckpointStrategyRunInput): Promise<StrategyRunRecord> {
    validateRun(input.run);
    if (input.basket) validateBasket(input.basket, input.run);
    const current = this.#runs.get(input.run.runId);
    if (!current) invalid("RUN_NOT_FOUND");
    if (
      input.run.strategyId !== current.strategyId ||
      input.run.configRevision !== current.configRevision ||
      input.run.startedAtMs !== current.startedAtMs
    ) invalid("RUN_ID_REUSED");
    if (current.completedAtMs !== null) {
      if (same(current, input.run)) return clone(current);
      invalid("RUN_ALREADY_COMPLETED");
    }
    if (
      input.run.completedAtMs !== null ||
      input.run.snapshot.eventSequence !== current.snapshot.eventSequence ||
      input.run.updatedAtMs < current.updatedAtMs
    ) invalid("STALE_SNAPSHOT");
    if (input.basket) this.#storeBasket(input.basket);
    this.#runs.set(input.run.runId, clone(input.run));
    return clone(input.run);
  }

  async recordFill(input: RecordStrategyEventInput & { basket: StrategyBasketRecord }): Promise<StrategyJournalEvent> {
    validateEvent(input, "FILL");
    return this.#record(input, "FILL");
  }

  async recordBatch(input: RecordStrategyBatchInput): Promise<StrategyJournalEvent[]> {
    const classes = validateBatch(input);
    const batch = clone(input);
    const current = this.#runs.get(batch.run.runId);
    if (!current) invalid("RUN_NOT_FOUND");
    const events = this.#events.get(batch.run.runId);
    if (!events) invalid("RUN_NOT_FOUND");
    const wrapped = batch.records.map((record, index) => this.#wrapEvent(
      batch.run.runId,
      record.basket?.basketId ?? null,
      record.event,
      classes[index] as StrategyEventClass
    ));
    const highestSequence = Math.max(0, ...events.keys());
    const newIndexes: number[] = [];
    for (const [index, candidate] of wrapped.entries()) {
      const existing = events.get(candidate.event.sequence);
      if (existing) {
        if (!same(existing, candidate)) invalid("EVENT_SEQUENCE_REUSED");
      } else {
        if (candidate.event.sequence <= highestSequence) invalid("STALE_SNAPSHOT");
        newIndexes.push(index);
      }
    }
    if (newIndexes.length === 0) return wrapped.map(clone);
    if ((wrapped[newIndexes[0] as number] as StrategyJournalEvent).event.sequence !== highestSequence + 1) {
      invalid("STALE_SNAPSHOT");
    }
    if (
      batch.run.strategyId !== current.strategyId ||
      batch.run.configRevision !== current.configRevision ||
      batch.run.startedAtMs !== current.startedAtMs
    ) invalid("RUN_ID_REUSED");
    if (current.completedAtMs !== null) {
      const onlyTrailingStop = same(current, batch.run) && newIndexes.every((index) => {
        const candidate = wrapped[index] as StrategyJournalEvent;
        return candidate.event.kind === "RUN_STOPPED" && candidate.event.atMs <= current.updatedAtMs;
      });
      if (!onlyTrailingStop) invalid("RUN_ALREADY_COMPLETED");
    }
    if (batch.run.updatedAtMs < current.updatedAtMs) invalid("STALE_SNAPSHOT");

    const stagedBaskets = new Map(this.#baskets);
    const stagedEvents = new Map(events);
    const changedBasketIds = new Set<string>();
    for (const index of newIndexes) {
      const record = batch.records[index] as RecordStrategyBatchInput["records"][number];
      const candidate = wrapped[index] as StrategyJournalEvent;
      if (record.basket) {
        this.#storeBasket(record.basket, stagedBaskets);
        changedBasketIds.add(record.basket.basketId);
      }
      stagedEvents.set(candidate.event.sequence, candidate);
    }
    const nextRun = clone(batch.run);
    for (const basketId of changedBasketIds) {
      this.#baskets.set(basketId, stagedBaskets.get(basketId) as StrategyBasketRecord);
    }
    this.#events.set(batch.run.runId, stagedEvents);
    this.#runs.set(batch.run.runId, nextRun);
    return wrapped.map(clone);
  }

  async #record(input: RecordStrategyEventInput, kind: StrategyEventClass): Promise<StrategyJournalEvent> {
    const current = this.#runs.get(input.run.runId);
    if (!current) invalid("RUN_NOT_FOUND");
    const wrapped = this.#wrapEvent(input.run.runId, input.basket?.basketId ?? null, input.event, kind);
    const events = this.#events.get(input.run.runId) as Map<number, StrategyJournalEvent>;
    const existingEvent = events.get(input.event.sequence);
    if (existingEvent) {
      if (!same(existingEvent, wrapped)) invalid("EVENT_SEQUENCE_REUSED");
      return clone(existingEvent);
    }
    const highestSequence = Math.max(0, ...events.keys());
    if (
      input.run.strategyId !== current.strategyId ||
      input.run.configRevision !== current.configRevision ||
      input.run.startedAtMs !== current.startedAtMs
    ) invalid("RUN_ID_REUSED");
    if (current.completedAtMs !== null && !isTrailingTerminalEvent(current, input.run, input.event)) {
      invalid("RUN_ALREADY_COMPLETED");
    }
    if (input.run.updatedAtMs < current.updatedAtMs || input.event.sequence !== highestSequence + 1) invalid("STALE_SNAPSHOT");

    if (input.basket) this.#storeBasket(input.basket);
    this.#runs.set(input.run.runId, clone(input.run));
    events.set(input.event.sequence, wrapped);
    return clone(wrapped);
  }

  #wrapEvent(runId: string, basketId: string | null, event: StrategyEvent, kind: StrategyEventClass): StrategyJournalEvent {
    return journalEvent(runId, basketId, event, kind);
  }

  #storeBasket(basket: StrategyBasketRecord, baskets = this.#baskets): void {
    const existingBasket = baskets.get(basket.basketId);
    const sameSequence = [...baskets.values()].find(
      (candidate) => candidate.runId === basket.runId && candidate.basketSequence === basket.basketSequence
    );
    if (
      (existingBasket && (existingBasket.runId !== basket.runId || existingBasket.basketSequence !== basket.basketSequence || existingBasket.direction !== basket.direction)) ||
      (sameSequence && sameSequence.basketId !== basket.basketId)
    ) invalid("BASKET_ID_REUSED");
    if (existingBasket && basket.updatedAtMs < existingBasket.updatedAtMs) invalid("STALE_SNAPSHOT");
    baskets.set(basket.basketId, clone(basket));
  }

  async getRun(runId: string): Promise<StrategyRunRecord | null> {
    assertId(runId);
    const run = this.#runs.get(runId);
    return run ? clone(run) : null;
  }

  async getRunRecovery(runId: string): Promise<StrategyRunRecovery | null> {
    const run = await this.getRun(runId);
    if (!run) return null;
    const configRevision = await this.getConfigRevision(run.strategyId, run.configRevision);
    if (!configRevision) throw new Error("STRATEGY_CONFIG_SNAPSHOT_MISSING");
    return { configRevision, run };
  }

  async getRunHistory(runId: string): Promise<StrategyRecovery | null> {
    const recovery = await this.getRunRecovery(runId);
    if (!recovery) return null;
    return {
      ...recovery,
      baskets: await this.listBaskets(runId),
      events: [...(this.#events.get(runId)?.values() ?? [])]
        .sort((left, right) => left.event.sequence - right.event.sequence)
        .map(clone)
    };
  }

  async listRuns(limit: number, strategyId?: string): Promise<StrategyRunRecord[]> {
    const bounded = boundedLimit(limit);
    if (strategyId !== undefined) assertId(strategyId);
    return [...this.#runs.values()]
      .filter((run) => strategyId === undefined || run.strategyId === strategyId)
      .sort((left, right) => right.startedAtMs - left.startedAtMs)
      .slice(0, bounded)
      .map(clone);
  }

  async listBaskets(runId: string): Promise<StrategyBasketRecord[]> {
    assertId(runId);
    return [...this.#baskets.values()]
      .filter((basket) => basket.runId === runId)
      .sort((left, right) => left.basketSequence - right.basketSequence)
      .map(clone);
  }

  async listEvents(runId: string, limit: number): Promise<StrategyJournalEvent[]> {
    assertId(runId);
    const bounded = boundedLimit(limit);
    return [...(this.#events.get(runId)?.values() ?? [])]
      .sort((left, right) => left.event.sequence - right.event.sequence)
      .slice(-bounded)
      .map(clone);
  }

  async recoverActiveRuns(): Promise<StrategyRunRecovery[]> {
    const active = [...this.#runs.values()]
      .filter(({ completedAtMs }) => completedAtMs === null)
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
    const recoveries = await Promise.all(active.map(({ runId }) => this.getRunRecovery(runId)));
    return recoveries.filter((recovery): recovery is StrategyRunRecovery => recovery !== null);
  }
}

export class PostgresStrategyJournal implements StrategyJournal {
  readonly persistence = "postgres-strategy-v1" as const;
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
  }

  async initialize(): Promise<void> {
    const migrationUrl = new URL("../../migrations/002_paper_strategy.sql", import.meta.url);
    await this.#pool.query(await readFile(migrationUrl, "utf8"));
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async createConfigRevision(input: CreateStrategyConfigRevisionInput): Promise<StrategyConfigRevision> {
    validateConfigInput(input);
    const snapshot = canonical(input.config);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`strategy-config:${input.strategyId}`]);
      const revision = input.revision ?? Number((await client.query(
        "SELECT coalesce(max(revision), 0) + 1 AS revision FROM strategy_config_revisions WHERE strategy_id=$1",
        [input.strategyId]
      )).rows[0]?.revision ?? 1);
      const existing = await client.query(
        "SELECT * FROM strategy_config_revisions WHERE strategy_id=$1 AND revision=$2",
        [input.strategyId, revision]
      );
      if (existing.rows[0]) {
        const current = configFromRow(existing.rows[0]);
        const candidate = { strategyId: input.strategyId, revision, name: input.config.name, config: input.config, createdAtMs: input.createdAtMs };
        if (!sameConfigRevisionContent(current, candidate)) invalid("CONFIG_REVISION_IMMUTABLE");
        await client.query("COMMIT");
        return current;
      }
      const result = await client.query(
        `INSERT INTO strategy_config_revisions (
          strategy_id, revision, name, schema_version, config_snapshot, config_sha256, created_at
        ) VALUES ($1,$2,$3,1,$4::jsonb,$5,$6) RETURNING *`,
        [input.strategyId, revision, input.config.name, snapshot.text, snapshot.hash, new Date(input.createdAtMs)]
      );
      await client.query("COMMIT");
      return configFromRow(result.rows[0]);
    } catch (reason) {
      await client.query("ROLLBACK");
      throw reason;
    } finally {
      client.release();
    }
  }

  async getConfigRevision(strategyId: string, revision?: number): Promise<StrategyConfigRevision | null> {
    assertId(strategyId);
    const result = revision === undefined
      ? await this.#pool.query("SELECT * FROM strategy_config_revisions WHERE strategy_id=$1 ORDER BY revision DESC LIMIT 1", [strategyId])
      : await this.#pool.query("SELECT * FROM strategy_config_revisions WHERE strategy_id=$1 AND revision=$2", [strategyId, revision]);
    return result.rows[0] ? configFromRow(result.rows[0]) : null;
  }

  async listConfigRevisions(limit: number, strategyId?: string): Promise<StrategyConfigRevision[]> {
    const bounded = boundedLimit(limit);
    if (strategyId !== undefined) assertId(strategyId);
    const result = strategyId === undefined
      ? await this.#pool.query("SELECT * FROM strategy_config_revisions ORDER BY created_at DESC, revision DESC LIMIT $1", [bounded])
      : await this.#pool.query("SELECT * FROM strategy_config_revisions WHERE strategy_id=$1 ORDER BY revision DESC LIMIT $2", [strategyId, bounded]);
    return result.rows.map(configFromRow);
  }

  async createRun(input: CreateStrategyRunInput): Promise<StrategyRunRecord> {
    validateRunStart(input);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`strategy-run:${input.run.runId}`]);
      const existing = await client.query("SELECT * FROM strategy_runs WHERE run_id=$1", [input.run.runId]);
      if (existing.rows[0]) {
        const existingEvent = await client.query("SELECT * FROM strategy_events WHERE run_id=$1 AND event_sequence=$2", [input.run.runId, input.event.sequence]);
        if (!same(runFromRow(existing.rows[0]), input.run) || !existingEvent.rows[0] || !same(eventFromRow(existingEvent.rows[0]).event, input.event)) {
          invalid("RUN_ID_REUSED");
        }
        await client.query("COMMIT");
        return runFromRow(existing.rows[0]);
      }
      await this.#insertRun(client, input.run);
      await this.#insertEvent(client, { runId: input.run.runId, basketId: null, eventClass: "STATE_CHANGE", event: input.event });
      await client.query("COMMIT");
      return clone(input.run);
    } catch (reason) {
      await client.query("ROLLBACK");
      if ((reason as { code?: string }).code === "23503") invalid("CONFIG_REVISION_NOT_FOUND");
      if (
        (reason as { code?: string; constraint?: string }).code === "23505" &&
        (reason as { constraint?: string }).constraint === "strategy_runs_single_active_idx"
      ) invalid("ACTIVE_RUN_EXISTS");
      throw reason;
    } finally {
      client.release();
    }
  }

  async recordStateChange(input: RecordStrategyEventInput): Promise<StrategyJournalEvent> {
    validateEvent(input, "STATE_CHANGE");
    return this.#record(input, "STATE_CHANGE");
  }

  async checkpoint(input: CheckpointStrategyRunInput): Promise<StrategyRunRecord> {
    validateRun(input.run);
    if (input.basket) validateBasket(input.basket, input.run);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`strategy-run:${input.run.runId}`]);
      const result = await client.query("SELECT * FROM strategy_runs WHERE run_id=$1", [input.run.runId]);
      if (!result.rows[0]) invalid("RUN_NOT_FOUND");
      const current = runFromRow(result.rows[0]);
      if (
        input.run.strategyId !== current.strategyId ||
        input.run.configRevision !== current.configRevision ||
        input.run.startedAtMs !== current.startedAtMs
      ) invalid("RUN_ID_REUSED");
      if (current.completedAtMs !== null) {
        if (!same(current, input.run)) invalid("RUN_ALREADY_COMPLETED");
        await client.query("COMMIT");
        return current;
      }
      if (
        input.run.completedAtMs !== null ||
        input.run.snapshot.eventSequence !== current.snapshot.eventSequence ||
        input.run.updatedAtMs < current.updatedAtMs
      ) invalid("STALE_SNAPSHOT");
      if (input.basket) await this.#upsertBasket(client, input.basket);
      await this.#updateRun(client, input.run);
      await client.query("COMMIT");
      return clone(input.run);
    } catch (reason) {
      await client.query("ROLLBACK");
      throw reason;
    } finally {
      client.release();
    }
  }

  async recordFill(input: RecordStrategyEventInput & { basket: StrategyBasketRecord }): Promise<StrategyJournalEvent> {
    validateEvent(input, "FILL");
    return this.#record(input, "FILL");
  }

  async recordBatch(input: RecordStrategyBatchInput): Promise<StrategyJournalEvent[]> {
    const classes = validateBatch(input);
    const batch = clone(input);
    const wrapped = batch.records.map((record, index) => journalEvent(
      batch.run.runId,
      record.basket?.basketId ?? null,
      record.event,
      classes[index] as StrategyEventClass
    ));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`strategy-run:${batch.run.runId}`]);
      const runResult = await client.query("SELECT * FROM strategy_runs WHERE run_id=$1", [batch.run.runId]);
      if (!runResult.rows[0]) invalid("RUN_NOT_FOUND");
      const current = runFromRow(runResult.rows[0]);
      const sequences = wrapped.map(({ event }) => event.sequence);
      const existingResult = await client.query(
        "SELECT * FROM strategy_events WHERE run_id=$1 AND event_sequence = ANY($2::bigint[])",
        [batch.run.runId, sequences]
      );
      const existingBySequence = new Map<number, StrategyJournalEvent>(
        existingResult.rows.map((row) => [Number(row.event_sequence), eventFromRow(row)])
      );
      const highestSequence = Number((await client.query(
        "SELECT coalesce(max(event_sequence), 0) AS sequence FROM strategy_events WHERE run_id=$1",
        [batch.run.runId]
      )).rows[0]?.sequence ?? 0);
      const newIndexes: number[] = [];
      for (const [index, candidate] of wrapped.entries()) {
        const existing = existingBySequence.get(candidate.event.sequence);
        if (existing) {
          if (!same(existing, candidate)) invalid("EVENT_SEQUENCE_REUSED");
        } else {
          if (candidate.event.sequence <= highestSequence) invalid("STALE_SNAPSHOT");
          newIndexes.push(index);
        }
      }
      if (newIndexes.length === 0) {
        await client.query("COMMIT");
        return wrapped.map(clone);
      }
      if ((wrapped[newIndexes[0] as number] as StrategyJournalEvent).event.sequence !== highestSequence + 1) {
        invalid("STALE_SNAPSHOT");
      }
      if (
        batch.run.strategyId !== current.strategyId ||
        batch.run.configRevision !== current.configRevision ||
        batch.run.startedAtMs !== current.startedAtMs
      ) invalid("RUN_ID_REUSED");
      if (current.completedAtMs !== null) {
        const onlyTrailingStop = same(current, batch.run) && newIndexes.every((index) => {
          const candidate = wrapped[index] as StrategyJournalEvent;
          return candidate.event.kind === "RUN_STOPPED" && candidate.event.atMs <= current.updatedAtMs;
        });
        if (!onlyTrailingStop) invalid("RUN_ALREADY_COMPLETED");
      }
      if (batch.run.updatedAtMs < current.updatedAtMs) invalid("STALE_SNAPSHOT");

      for (const index of newIndexes) {
        const record = batch.records[index] as RecordStrategyBatchInput["records"][number];
        if (record.basket) await this.#upsertBasket(client, record.basket);
        await this.#insertEvent(client, wrapped[index] as StrategyJournalEvent);
      }
      await this.#updateRun(client, batch.run);
      await client.query("COMMIT");
      return wrapped.map(clone);
    } catch (reason) {
      await client.query("ROLLBACK");
      throw reason;
    } finally {
      client.release();
    }
  }

  async #record(input: RecordStrategyEventInput, kind: StrategyEventClass): Promise<StrategyJournalEvent> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`strategy-run:${input.run.runId}`]);
      const runResult = await client.query("SELECT * FROM strategy_runs WHERE run_id=$1", [input.run.runId]);
      const currentRow = runResult.rows[0];
      if (!currentRow) invalid("RUN_NOT_FOUND");
      const existingEvent = await client.query("SELECT * FROM strategy_events WHERE run_id=$1 AND event_sequence=$2", [input.run.runId, input.event.sequence]);
      const wrapped = journalEvent(input.run.runId, input.basket?.basketId ?? null, input.event, kind);
      if (existingEvent.rows[0]) {
        const currentEvent = eventFromRow(existingEvent.rows[0]);
        if (!same(currentEvent, wrapped)) invalid("EVENT_SEQUENCE_REUSED");
        await client.query("COMMIT");
        return currentEvent;
      }
      const current = runFromRow(currentRow);
      if (
        current.strategyId !== input.run.strategyId ||
        current.configRevision !== input.run.configRevision ||
        current.startedAtMs !== input.run.startedAtMs
      ) invalid("RUN_ID_REUSED");
      if (current.completedAtMs !== null && !isTrailingTerminalEvent(current, input.run, input.event)) {
        invalid("RUN_ALREADY_COMPLETED");
      }
      const highestSequence = Number((await client.query(
        "SELECT coalesce(max(event_sequence), 0) AS sequence FROM strategy_events WHERE run_id=$1",
        [input.run.runId]
      )).rows[0]?.sequence ?? 0);
      if (input.run.updatedAtMs < current.updatedAtMs || input.event.sequence !== highestSequence + 1) invalid("STALE_SNAPSHOT");

      if (input.basket) await this.#upsertBasket(client, input.basket);
      await this.#updateRun(client, input.run);
      await this.#insertEvent(client, wrapped);
      await client.query("COMMIT");
      return clone(wrapped);
    } catch (reason) {
      await client.query("ROLLBACK");
      throw reason;
    } finally {
      client.release();
    }
  }

  async #insertRun(client: PoolClient, run: StrategyRunRecord): Promise<void> {
    const snapshot = canonical(run.snapshot);
    await client.query(
      `INSERT INTO strategy_runs (
        run_id, strategy_id, config_revision, execution_mode, state, started_at,
        updated_at, completed_at, run_snapshot, run_snapshot_sha256
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        run.runId,
        run.strategyId,
        run.configRevision,
        run.executionMode,
        run.status,
        new Date(run.startedAtMs),
        new Date(run.updatedAtMs),
        run.completedAtMs === null ? null : new Date(run.completedAtMs),
        snapshot.text,
        snapshot.hash
      ]
    );
  }

  async #updateRun(client: PoolClient, run: StrategyRunRecord): Promise<void> {
    const snapshot = canonical(run.snapshot);
    await client.query(
      `UPDATE strategy_runs SET state=$2, updated_at=$3, completed_at=$4,
        run_snapshot=$5::jsonb, run_snapshot_sha256=$6 WHERE run_id=$1`,
      [
        run.runId,
        run.status,
        new Date(run.updatedAtMs),
        run.completedAtMs === null ? null : new Date(run.completedAtMs),
        snapshot.text,
        snapshot.hash
      ]
    );
  }

  async #upsertBasket(client: PoolClient, basket: StrategyBasketRecord): Promise<void> {
    const sameSequence = await client.query(
      "SELECT basket_id FROM strategy_baskets WHERE run_id=$1 AND basket_sequence=$2",
      [basket.runId, basket.basketSequence]
    );
    if (sameSequence.rows[0] && String(sameSequence.rows[0].basket_id) !== basket.basketId) invalid("BASKET_ID_REUSED");
    const existing = await client.query("SELECT * FROM strategy_baskets WHERE basket_id=$1", [basket.basketId]);
    if (existing.rows[0]) {
      const current = basketFromRow(existing.rows[0]);
      if (current.runId !== basket.runId || current.basketSequence !== basket.basketSequence || current.direction !== basket.direction) {
        invalid("BASKET_ID_REUSED");
      }
      if (basket.updatedAtMs < current.updatedAtMs) invalid("STALE_SNAPSHOT");
    }
    const snapshot = canonical(basket.snapshot);
    await client.query(
      `INSERT INTO strategy_baskets (
        basket_id, run_id, basket_sequence, direction, state, opened_at, updated_at,
        closed_at, basket_snapshot, basket_snapshot_sha256
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      ON CONFLICT (basket_id) DO UPDATE SET
        state=EXCLUDED.state,
        updated_at=EXCLUDED.updated_at,
        closed_at=EXCLUDED.closed_at,
        basket_snapshot=EXCLUDED.basket_snapshot,
        basket_snapshot_sha256=EXCLUDED.basket_snapshot_sha256`,
      [
        basket.basketId,
        basket.runId,
        basket.basketSequence,
        basket.direction,
        basket.status,
        new Date(basket.openedAtMs),
        new Date(basket.updatedAtMs),
        basket.closedAtMs === null ? null : new Date(basket.closedAtMs),
        snapshot.text,
        snapshot.hash
      ]
    );
  }

  async #insertEvent(client: PoolClient, wrapped: StrategyJournalEvent): Promise<void> {
    const persisted = journalEvent(wrapped.runId, wrapped.basketId, wrapped.event, wrapped.eventClass);
    const snapshot = canonical(persisted.event);
    await client.query(
      `INSERT INTO strategy_events (
        run_id, event_sequence, basket_id, event_class, event_kind, occurred_at,
        from_state, to_state, event_snapshot, event_sha256
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        persisted.runId,
        persisted.event.sequence,
        persisted.basketId,
        persisted.eventClass,
        persisted.event.kind,
        new Date(persisted.event.atMs),
        persisted.event.fromState,
        persisted.event.toState,
        snapshot.text,
        snapshot.hash
      ]
    );
  }

  async getRun(runId: string): Promise<StrategyRunRecord | null> {
    assertId(runId);
    const result = await this.#pool.query("SELECT * FROM strategy_runs WHERE run_id=$1", [runId]);
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async getRunRecovery(runId: string): Promise<StrategyRunRecovery | null> {
    assertId(runId);
    const result = await this.#pool.query(
      `SELECT r.*,
        c.strategy_id AS recovery_config_strategy_id,
        c.revision AS recovery_config_revision,
        c.name AS recovery_config_name,
        c.config_snapshot AS recovery_config_snapshot,
        c.created_at AS recovery_config_created_at
      FROM strategy_runs r
      JOIN strategy_config_revisions c
        ON c.strategy_id=r.strategy_id AND c.revision=r.config_revision
      WHERE r.run_id=$1`,
      [runId]
    );
    return result.rows[0] ? runRecoveryFromRow(result.rows[0]) : null;
  }

  async getRunHistory(runId: string): Promise<StrategyRecovery | null> {
    assertId(runId);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await this.#history(client, runId);
      await client.query("COMMIT");
      return result;
    } catch (reason) {
      await client.query("ROLLBACK");
      throw reason;
    } finally {
      client.release();
    }
  }

  async #history(client: PoolClient, runId: string): Promise<StrategyRecovery | null> {
    const runResult = await client.query("SELECT * FROM strategy_runs WHERE run_id=$1", [runId]);
    if (!runResult.rows[0]) return null;
    const run = runFromRow(runResult.rows[0]);
    const [configResult, basketsResult, eventsResult] = await Promise.all([
      client.query("SELECT * FROM strategy_config_revisions WHERE strategy_id=$1 AND revision=$2", [run.strategyId, run.configRevision]),
      client.query("SELECT * FROM strategy_baskets WHERE run_id=$1 ORDER BY basket_sequence ASC", [runId]),
      client.query("SELECT * FROM strategy_events WHERE run_id=$1 ORDER BY event_sequence ASC", [runId])
    ]);
    if (!configResult.rows[0]) throw new Error("STRATEGY_CONFIG_SNAPSHOT_MISSING");
    return {
      configRevision: configFromRow(configResult.rows[0]),
      run,
      baskets: basketsResult.rows.map(basketFromRow),
      events: eventsResult.rows.map(eventFromRow)
    };
  }

  async listRuns(limit: number, strategyId?: string): Promise<StrategyRunRecord[]> {
    const bounded = boundedLimit(limit);
    if (strategyId !== undefined) assertId(strategyId);
    const result = strategyId === undefined
      ? await this.#pool.query("SELECT * FROM strategy_runs ORDER BY started_at DESC LIMIT $1", [bounded])
      : await this.#pool.query("SELECT * FROM strategy_runs WHERE strategy_id=$1 ORDER BY started_at DESC LIMIT $2", [strategyId, bounded]);
    return result.rows.map(runFromRow);
  }

  async listBaskets(runId: string): Promise<StrategyBasketRecord[]> {
    assertId(runId);
    const result = await this.#pool.query("SELECT * FROM strategy_baskets WHERE run_id=$1 ORDER BY basket_sequence ASC", [runId]);
    return result.rows.map(basketFromRow);
  }

  async listEvents(runId: string, limit: number): Promise<StrategyJournalEvent[]> {
    assertId(runId);
    const bounded = boundedLimit(limit);
    const result = await this.#pool.query(
      `SELECT * FROM (
        SELECT * FROM strategy_events WHERE run_id=$1 ORDER BY event_sequence DESC LIMIT $2
      ) recent ORDER BY event_sequence ASC`,
      [runId, bounded]
    );
    return result.rows.map(eventFromRow);
  }

  async recoverActiveRuns(): Promise<StrategyRunRecovery[]> {
    const result = await this.#pool.query(
      `SELECT r.*,
        c.strategy_id AS recovery_config_strategy_id,
        c.revision AS recovery_config_revision,
        c.name AS recovery_config_name,
        c.config_snapshot AS recovery_config_snapshot,
        c.created_at AS recovery_config_created_at
      FROM strategy_runs r
      JOIN strategy_config_revisions c
        ON c.strategy_id=r.strategy_id AND c.revision=r.config_revision
      WHERE r.completed_at IS NULL
      ORDER BY r.started_at ASC`
    );
    return result.rows.map(runRecoveryFromRow);
  }
}
