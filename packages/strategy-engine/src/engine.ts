import Decimal from "decimal.js";
import {
  scalingIntervalMilliseconds,
  secondsToMilliseconds,
  strategyConfigFingerprint,
  validateStrategyConfigV1
} from "./config.js";
import type {
  StrategyArmingSnapshot,
  StrategyBasketSnapshot,
  StrategyConfigV1,
  StrategyDirection,
  StrategyEvent,
  StrategyEventKind,
  StrategyEventReason,
  StrategyExitReason,
  StrategyFill,
  StrategyFillKind,
  StrategyObservation,
  StrategySnapshot,
  StrategyState
} from "./contracts.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const BPS = new Decimal(10_000);

export class StrategyObservationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class StrategyStateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class StrategySnapshotError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function plain(value: Decimal): string {
  return value.toFixed();
}

function bps(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

function quote(value: Decimal): string {
  return value.toDecimalPlaces(6).toFixed(6);
}

function cloneObservation(value: StrategyObservation | null): StrategyObservation | null {
  return value ? { ...value } : null;
}

function cloneFill(value: StrategyFill | null): StrategyFill | null {
  return value ? { ...value } : null;
}

function cloneBasket(value: StrategyBasketSnapshot | null): StrategyBasketSnapshot | null {
  return value
    ? {
        ...value,
        entries: value.entries.map((entry) => ({ ...entry })),
        exitFill: cloneFill(value.exitFill)
      }
    : null;
}

function cloneArming(value: StrategyArmingSnapshot | null): StrategyArmingSnapshot | null {
  return value ? { ...value } : null;
}

function frozenConfig(value: StrategyConfigV1): StrategyConfigV1 {
  return Object.freeze({
    ...value,
    entry: Object.freeze({ ...value.entry }),
    scaling: Object.freeze({ ...value.scaling }),
    exit: Object.freeze({ ...value.exit })
  });
}

function safeAtMs(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new StrategyObservationError(code);
  return value;
}

function secondsToMs(value: number): number {
  return secondsToMilliseconds(value);
}

function safeDeadlineAtMs(sinceMs: number, durationMs: number, code: string): number {
  if (durationMs > Number.MAX_SAFE_INTEGER - sinceMs) throw new StrategyStateError(code);
  return sinceMs + durationMs;
}

function scaledDurationMs(baseSeconds: number, multiplier: string, exponent: number): number {
  try {
    return scalingIntervalMilliseconds(baseSeconds, multiplier, exponent);
  } catch {
    throw new StrategyStateError("SCALING_INTERVAL_OVERFLOW");
  }
}

function scaledDueAtMs(sinceMs: number, baseSeconds: number, multiplier: string, exponent: number): number {
  const durationMs = scaledDurationMs(baseSeconds, multiplier, exponent);
  return safeDeadlineAtMs(sinceMs, durationMs, "SCALING_DUE_TIME_OVERFLOW");
}

function normalizedObservation(input: StrategyObservation): StrategyObservation {
  safeAtMs(input.atMs, "INVALID_OBSERVATION_TIME");
  if (input.direction !== null && input.direction !== "BUY" && input.direction !== "SELL") {
    throw new StrategyObservationError("INVALID_DIRECTION");
  }
  let edgeBps: string | null = null;
  if (input.edgeBps !== null) {
    try {
      const edge = new Decimal(input.edgeBps);
      if (!edge.isFinite()) throw new Error("not finite");
      edgeBps = plain(edge);
    } catch {
      throw new StrategyObservationError("INVALID_EDGE_BPS");
    }
  }
  let price: string | null = null;
  if (input.price !== null) {
    try {
      const parsed = new Decimal(input.price);
      if (!parsed.isFinite() || !parsed.gt(0)) throw new Error("not positive");
      price = plain(parsed);
    } catch {
      throw new StrategyObservationError("INVALID_PRICE");
    }
    if (typeof input.referenceSource !== "string" || input.referenceSource.trim().length === 0) {
      throw new StrategyObservationError("REFERENCE_SOURCE_REQUIRED");
    }
  }
  if (input.referenceSource !== null && typeof input.referenceSource !== "string") {
    throw new StrategyObservationError("INVALID_REFERENCE_SOURCE");
  }
  return {
    atMs: input.atMs,
    direction: input.direction,
    edgeBps,
    price,
    referenceSource: input.referenceSource?.trim() || null
  };
}

function targetProfitBps(config: StrategyConfigV1, openedAtMs: number, atMs: number): Decimal {
  const initial = new Decimal(config.exit.takeProfitBps);
  if (!config.exit.linearDecayToZero) return initial;
  const forceExitMs = secondsToMs(config.exit.forceExitSec);
  const elapsedMs = Math.max(0, Math.min(forceExitMs, atMs - openedAtMs));
  return Decimal.max(0, initial.mul(new Decimal(1).minus(new Decimal(elapsedMs).div(forceExitMs))));
}

export function currentTargetProfitBps(config: StrategyConfigV1, openedAtMs: number, atMs: number): string {
  const normalized = validateStrategyConfigV1(config);
  safeAtMs(openedAtMs, "INVALID_OPEN_TIME");
  safeAtMs(atMs, "INVALID_EVALUATION_TIME");
  return bps(targetProfitBps(normalized, openedAtMs, atMs));
}

function assertSnapshotInteger(value: unknown, code: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new StrategySnapshotError(code);
  return value as number;
}

function assertSnapshotDecimal(value: unknown, code: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new StrategySnapshotError(code);
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return value;
  } catch {
    throw new StrategySnapshotError(code);
  }
}

function validateFillSnapshot(value: StrategyFill, expectedDirection: StrategyDirection): StrategyFill {
  if (!value || typeof value !== "object") throw new StrategySnapshotError("INVALID_FILL");
  assertSnapshotInteger(value.sequence, "INVALID_FILL_SEQUENCE");
  if (!(value.kind === "ENTRY" || value.kind === "ADD" || value.kind === "EXIT")) {
    throw new StrategySnapshotError("INVALID_FILL_KIND");
  }
  if (value.direction !== expectedDirection) throw new StrategySnapshotError("INVALID_FILL_DIRECTION");
  assertSnapshotInteger(value.atMs, "INVALID_FILL_TIME");
  for (const [field, raw] of [
    ["PRICE", value.price],
    ["QUOTE_NOTIONAL", value.quoteNotional],
    ["SCHEDULED_QUOTE_NOTIONAL", value.scheduledQuoteNotional],
    ["BASE_QUANTITY", value.baseQuantity]
  ] as const) {
    const parsed = new Decimal(assertSnapshotDecimal(raw, `INVALID_FILL_${field}`) as string);
    if (!parsed.gt(0)) throw new StrategySnapshotError(`INVALID_FILL_${field}`);
  }
  assertSnapshotDecimal(value.edgeBps, "INVALID_FILL_EDGE", true);
  if (typeof value.cappedByMaxTotal !== "boolean") throw new StrategySnapshotError("INVALID_FILL_CAP_STATE");
  if (typeof value.referenceSource !== "string" || value.referenceSource.length === 0) {
    throw new StrategySnapshotError("INVALID_FILL_REFERENCE_SOURCE");
  }
  return { ...value };
}

function validateBasketSnapshot(
  value: StrategyBasketSnapshot,
  config: StrategyConfigV1,
  expectedStatus?: StrategyBasketSnapshot["status"]
): StrategyBasketSnapshot {
  if (!value || typeof value !== "object") throw new StrategySnapshotError("INVALID_BASKET");
  assertSnapshotInteger(value.basketSequence, "INVALID_BASKET_SEQUENCE");
  if (value.direction !== "BUY" && value.direction !== "SELL") throw new StrategySnapshotError("INVALID_BASKET_DIRECTION");
  if (!(value.status === "OPEN" || value.status === "EXIT_PENDING_PRICE" || value.status === "CLOSED")) {
    throw new StrategySnapshotError("INVALID_BASKET_STATUS");
  }
  if (expectedStatus && value.status !== expectedStatus) throw new StrategySnapshotError("BASKET_STATE_MISMATCH");
  assertSnapshotInteger(value.openedAtMs, "INVALID_BASKET_OPEN_TIME");
  assertSnapshotInteger(value.closedAtMs, "INVALID_BASKET_CLOSE_TIME", true);
  if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > config.scaling.maxEntries) {
    throw new StrategySnapshotError("INVALID_BASKET_ENTRIES");
  }
  const entries = value.entries.map((entry, index) => {
    const validated = validateFillSnapshot(entry, value.direction);
    if (validated.kind !== (index === 0 ? "ENTRY" : "ADD")) throw new StrategySnapshotError("INVALID_ENTRY_FILL_KIND");
    return validated;
  });
  const exitFill = value.exitFill === null ? null : validateFillSnapshot(value.exitFill, value.direction);
  if (exitFill && exitFill.kind !== "EXIT") throw new StrategySnapshotError("INVALID_EXIT_FILL_KIND");
  if ((value.status === "CLOSED") !== Boolean(exitFill && value.closedAtMs !== null && value.exitReason !== null)) {
    throw new StrategySnapshotError("INVALID_CLOSED_BASKET");
  }
  if (value.status !== "CLOSED" && (exitFill || value.closedAtMs !== null || value.exitReason !== null)) {
    throw new StrategySnapshotError("INVALID_OPEN_BASKET");
  }

  const totalQuote = entries.reduce((total, entry) => total.plus(entry.quoteNotional), new Decimal(0));
  const totalBase = entries.reduce((total, entry) => total.plus(entry.baseQuantity), new Decimal(0));
  if (!totalQuote.eq(assertSnapshotDecimal(value.totalQuoteNotional, "INVALID_TOTAL_QUOTE") as string)) {
    throw new StrategySnapshotError("TOTAL_QUOTE_MISMATCH");
  }
  if (!totalBase.eq(assertSnapshotDecimal(value.totalBaseQuantity, "INVALID_TOTAL_BASE") as string)) {
    throw new StrategySnapshotError("TOTAL_BASE_MISMATCH");
  }
  if (totalQuote.gt(config.scaling.maxTotalSizeQuote)) throw new StrategySnapshotError("BASKET_TOTAL_EXCEEDS_CAP");
  const average = totalQuote.div(totalBase);
  if (!average.eq(assertSnapshotDecimal(value.averageEntryPrice, "INVALID_AVERAGE_ENTRY") as string)) {
    throw new StrategySnapshotError("AVERAGE_ENTRY_MISMATCH");
  }
  assertSnapshotDecimal(value.currentPrice, "INVALID_CURRENT_PRICE", true);
  assertSnapshotDecimal(value.grossPnlBps, "INVALID_GROSS_PNL_BPS", true);
  assertSnapshotDecimal(value.grossPnlQuote, "INVALID_GROSS_PNL_QUOTE", true);
  assertSnapshotDecimal(value.currentTargetProfitBps, "INVALID_CURRENT_TARGET");
  assertSnapshotInteger(value.nextEntryQualificationSinceMs, "INVALID_NEXT_ENTRY_SINCE", true);
  assertSnapshotInteger(value.nextEntryDueAtMs, "INVALID_NEXT_ENTRY_DUE", true);
  return { ...value, entries, exitFill };
}

function validateSnapshotShape(config: StrategyConfigV1, value: StrategySnapshot): StrategySnapshot {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new StrategySnapshotError("INVALID_SNAPSHOT_SCHEMA");
  }
  if (value.configFingerprint !== strategyConfigFingerprint(config)) {
    throw new StrategySnapshotError("CONFIG_FINGERPRINT_MISMATCH");
  }
  const states: readonly StrategyState[] = ["STOPPED", "IDLE", "ARMING", "OPEN", "EXIT_PENDING_PRICE", "COOLDOWN"];
  if (!states.includes(value.state)) throw new StrategySnapshotError("INVALID_STRATEGY_STATE");
  assertSnapshotInteger(value.startedAtMs, "INVALID_STARTED_AT", true);
  assertSnapshotInteger(value.stoppedAtMs, "INVALID_STOPPED_AT", true);
  assertSnapshotInteger(value.evaluatedAtMs, "INVALID_EVALUATED_AT", true);
  assertSnapshotInteger(value.basketCount, "INVALID_BASKET_COUNT");
  assertSnapshotInteger(value.eventSequence, "INVALID_EVENT_SEQUENCE");
  assertSnapshotInteger(value.fillSequence, "INVALID_FILL_SEQUENCE");
  assertSnapshotInteger(value.cooldownUntilMs, "INVALID_COOLDOWN_UNTIL", true);

  const lastObservation = value.lastObservation === null ? null : normalizedObservation(value.lastObservation);
  if (lastObservation && lastObservation.atMs !== value.evaluatedAtMs) {
    throw new StrategySnapshotError("OBSERVATION_TIME_MISMATCH");
  }
  const arming = cloneArming(value.arming);
  if (arming) {
    if (arming.direction !== "BUY" && arming.direction !== "SELL") throw new StrategySnapshotError("INVALID_ARMING_DIRECTION");
    assertSnapshotInteger(arming.startedAtMs, "INVALID_ARMING_START");
    assertSnapshotInteger(arming.readyAtMs, "INVALID_ARMING_READY");
    if (typeof arming.waitingForPrice !== "boolean") throw new StrategySnapshotError("INVALID_ARMING_PRICE_STATE");
  }
  const expectedCurrentStatus = value.state === "OPEN"
    ? "OPEN"
    : value.state === "EXIT_PENDING_PRICE"
      ? "EXIT_PENDING_PRICE"
      : undefined;
  const currentBasket = value.currentBasket === null
    ? null
    : validateBasketSnapshot(value.currentBasket, config, expectedCurrentStatus);
  const lastClosedBasket = value.lastClosedBasket === null
    ? null
    : validateBasketSnapshot(value.lastClosedBasket, config, "CLOSED");

  if ((value.state === "ARMING") !== Boolean(arming)) throw new StrategySnapshotError("ARMING_STATE_MISMATCH");
  if ((value.state === "OPEN" || value.state === "EXIT_PENDING_PRICE") !== Boolean(currentBasket)) {
    throw new StrategySnapshotError("CURRENT_BASKET_STATE_MISMATCH");
  }
  if ((value.state === "COOLDOWN") !== (value.cooldownUntilMs !== null)) {
    throw new StrategySnapshotError("COOLDOWN_STATE_MISMATCH");
  }
  if ((value.state === "EXIT_PENDING_PRICE") !== (value.pendingExitReason !== null)) {
    throw new StrategySnapshotError("PENDING_EXIT_STATE_MISMATCH");
  }
  if (value.pendingExitReason !== null && !(["STOP_LOSS", "FORCE_EXIT", "TAKE_PROFIT", "MANUAL_STOP"] as const).includes(value.pendingExitReason)) {
    throw new StrategySnapshotError("INVALID_PENDING_EXIT_REASON");
  }
  if (typeof value.stopRequested !== "boolean" || (value.stopRequested && value.state !== "EXIT_PENDING_PRICE")) {
    throw new StrategySnapshotError("INVALID_STOP_REQUEST_STATE");
  }
  if (value.state !== "STOPPED" && value.startedAtMs === null) throw new StrategySnapshotError("MISSING_STARTED_AT");
  if (currentBasket && currentBasket.basketSequence > value.basketCount) throw new StrategySnapshotError("INVALID_BASKET_COUNT");
  if (lastClosedBasket && lastClosedBasket.basketSequence > value.basketCount) throw new StrategySnapshotError("INVALID_BASKET_COUNT");
  const fillSequences = [currentBasket, lastClosedBasket]
    .flatMap((basket) => basket ? [...basket.entries, basket.exitFill].filter((fill): fill is StrategyFill => fill !== null) : [])
    .map(({ sequence }) => sequence);
  if (fillSequences.some((sequence) => sequence > value.fillSequence)) throw new StrategySnapshotError("INVALID_FILL_SEQUENCE");

  return {
    ...value,
    lastObservation,
    arming,
    currentBasket,
    lastClosedBasket
  };
}

function validatedSnapshot(config: StrategyConfigV1, value: unknown): StrategySnapshot {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new StrategySnapshotError("INVALID_SNAPSHOT_SCHEMA");
    }
    return validateSnapshotShape(config, value as StrategySnapshot);
  } catch (reason) {
    if (reason instanceof StrategySnapshotError) throw reason;
    throw new StrategySnapshotError("INVALID_SNAPSHOT");
  }
}

export class DryRunStrategyEngine {
  readonly config: StrategyConfigV1;
  readonly #configFingerprint: string;
  #state: StrategyState = "STOPPED";
  #startedAtMs: number | null = null;
  #stoppedAtMs: number | null = null;
  #evaluatedAtMs: number | null = null;
  #lastObservation: StrategyObservation | null = null;
  #arming: StrategyArmingSnapshot | null = null;
  #currentBasket: StrategyBasketSnapshot | null = null;
  #lastClosedBasket: StrategyBasketSnapshot | null = null;
  #basketCount = 0;
  #eventSequence = 0;
  #fillSequence = 0;
  #cooldownUntilMs: number | null = null;
  #pendingExitReason: StrategyExitReason | null = null;
  #stopRequested = false;

  constructor(config: StrategyConfigV1) {
    this.config = frozenConfig(validateStrategyConfigV1(config));
    this.#configFingerprint = strategyConfigFingerprint(this.config);
  }

  static restore(config: StrategyConfigV1, snapshot: unknown): DryRunStrategyEngine {
    const engine = new DryRunStrategyEngine(config);
    const restored = validatedSnapshot(engine.config, snapshot);
    engine.#state = restored.state;
    engine.#startedAtMs = restored.startedAtMs;
    engine.#stoppedAtMs = restored.stoppedAtMs;
    engine.#evaluatedAtMs = restored.evaluatedAtMs;
    engine.#lastObservation = cloneObservation(restored.lastObservation);
    engine.#arming = cloneArming(restored.arming);
    engine.#currentBasket = cloneBasket(restored.currentBasket);
    engine.#lastClosedBasket = cloneBasket(restored.lastClosedBasket);
    engine.#basketCount = restored.basketCount;
    engine.#eventSequence = restored.eventSequence;
    engine.#fillSequence = restored.fillSequence;
    engine.#cooldownUntilMs = restored.cooldownUntilMs;
    engine.#pendingExitReason = restored.pendingExitReason;
    engine.#stopRequested = restored.stopRequested;
    return engine;
  }

  start(atMs: number): StrategyEvent[] {
    safeAtMs(atMs, "INVALID_START_TIME");
    if (this.#startedAtMs !== null) throw new StrategyStateError("STRATEGY_ALREADY_STARTED");
    const fromState = this.#state;
    this.#state = "IDLE";
    this.#startedAtMs = atMs;
    this.#evaluatedAtMs = atMs;
    return [this.#event("RUN_STARTED", atMs, fromState, null, null, null, null)];
  }

  evaluate(input: StrategyObservation): StrategyEvent[] {
    if (this.#startedAtMs === null || this.#state === "STOPPED") {
      throw new StrategyStateError("STRATEGY_NOT_RUNNING");
    }
    const observation = this.#observe(input);
    const events: StrategyEvent[] = [];

    if (this.#state === "COOLDOWN") {
      if ((this.#cooldownUntilMs as number) > observation.atMs) return events;
      const fromState = this.#state;
      this.#state = "IDLE";
      this.#cooldownUntilMs = null;
      events.push(this.#event("COOLDOWN_COMPLETED", observation.atMs, fromState, "COOLDOWN_ELAPSED", observation, null, null));
    }

    if (this.#state === "IDLE") {
      if (!this.#qualifies(observation)) return events;
      const fromState = this.#state;
      const readyAtMs = safeDeadlineAtMs(
        observation.atMs,
        secondsToMs(this.config.entry.holdSec),
        "ENTRY_READY_TIME_OVERFLOW"
      );
      this.#state = "ARMING";
      this.#arming = {
        direction: observation.direction as StrategyDirection,
        startedAtMs: observation.atMs,
        readyAtMs,
        waitingForPrice: readyAtMs <= observation.atMs && observation.price === null
      };
      events.push(this.#event("ARMING_STARTED", observation.atMs, fromState, null, observation, null, null));
    }

    if (this.#state === "ARMING") {
      const arming = this.#arming as StrategyArmingSnapshot;
      if (!this.#qualifies(observation)) {
        const fromState = this.#state;
        this.#state = "IDLE";
        this.#arming = null;
        events.push(this.#event("ARMING_RESET", observation.atMs, fromState, "EDGE_NOT_QUALIFIED", observation, null, null));
        return events;
      }
      if (observation.direction !== arming.direction) {
        const readyAtMs = safeDeadlineAtMs(
          observation.atMs,
          secondsToMs(this.config.entry.holdSec),
          "ENTRY_READY_TIME_OVERFLOW"
        );
        this.#arming = {
          direction: observation.direction as StrategyDirection,
          startedAtMs: observation.atMs,
          readyAtMs,
          waitingForPrice: readyAtMs <= observation.atMs && observation.price === null
        };
        events.push(this.#event("ARMING_RESET", observation.atMs, "ARMING", "EDGE_DIRECTION_CHANGED", observation, null, null));
        return events;
      }
      arming.waitingForPrice = observation.atMs >= arming.readyAtMs && observation.price === null;
      if (observation.atMs < arming.readyAtMs || observation.price === null) return events;
      events.push(this.#open(observation));
      return events;
    }

    if (this.#state === "EXIT_PENDING_PRICE") {
      if (observation.price === null) {
        this.#markCurrentBasket(observation);
        return events;
      }
      const reason = this.#pendingExitReason === "MANUAL_STOP"
        ? "MANUAL_STOP"
        : this.#automaticExitReason(observation) ?? (this.#pendingExitReason as StrategyExitReason);
      events.push(...this.#close(observation, reason));
      return events;
    }

    if (this.#state === "OPEN") {
      if (observation.price === null && this.#forceExitDue(observation.atMs)) {
        this.#markCurrentBasket(observation);
        const fromState = this.#state;
        this.#state = "EXIT_PENDING_PRICE";
        this.#pendingExitReason = "FORCE_EXIT";
        (this.#currentBasket as StrategyBasketSnapshot).status = "EXIT_PENDING_PRICE";
        this.#clearScaleTimer();
        events.push(this.#event("EXIT_PENDING_PRICE", observation.atMs, fromState, "FORCE_EXIT", observation, null, this.#currentBasket));
        return events;
      }
      const exitReason = observation.price === null ? null : this.#automaticExitReason(observation);
      if (exitReason) {
        events.push(...this.#close(observation, exitReason));
        return events;
      }
      this.#markCurrentBasket(observation);
      const add = this.#maybeScaleIn(observation);
      if (add) events.push(add);
    }

    return events;
  }

  stop(input: StrategyObservation): StrategyEvent[] {
    if (this.#startedAtMs === null) throw new StrategyStateError("STRATEGY_NOT_RUNNING");
    if (this.#state === "STOPPED") return [];
    const observation = this.#observe(input);
    if (this.#state === "OPEN") {
      if (observation.price === null) {
        this.#markCurrentBasket(observation);
        const fromState = this.#state;
        this.#state = "EXIT_PENDING_PRICE";
        this.#pendingExitReason = "MANUAL_STOP";
        this.#stopRequested = true;
        (this.#currentBasket as StrategyBasketSnapshot).status = "EXIT_PENDING_PRICE";
        this.#clearScaleTimer();
        return [this.#event("EXIT_PENDING_PRICE", observation.atMs, fromState, "MANUAL_STOP", observation, null, this.#currentBasket)];
      }
      this.#stopRequested = true;
      return this.#close(observation, "MANUAL_STOP");
    }
    if (this.#state === "EXIT_PENDING_PRICE") {
      this.#stopRequested = true;
      this.#pendingExitReason = "MANUAL_STOP";
      if (observation.price !== null) return this.#close(observation, "MANUAL_STOP");
      return [this.#event("EXIT_PENDING_PRICE", observation.atMs, "EXIT_PENDING_PRICE", "MANUAL_STOP", observation, null, this.#currentBasket)];
    }
    const fromState = this.#state;
    this.#state = "STOPPED";
    this.#stoppedAtMs = observation.atMs;
    this.#arming = null;
    this.#cooldownUntilMs = null;
    this.#pendingExitReason = null;
    return [this.#event("RUN_STOPPED", observation.atMs, fromState, "MANUAL_STOP", observation, null, null)];
  }

  snapshot(): StrategySnapshot {
    return {
      schemaVersion: 1,
      configFingerprint: this.#configFingerprint,
      state: this.#state,
      startedAtMs: this.#startedAtMs,
      stoppedAtMs: this.#stoppedAtMs,
      evaluatedAtMs: this.#evaluatedAtMs,
      lastObservation: cloneObservation(this.#lastObservation),
      arming: cloneArming(this.#arming),
      currentBasket: cloneBasket(this.#currentBasket),
      lastClosedBasket: cloneBasket(this.#lastClosedBasket),
      basketCount: this.#basketCount,
      eventSequence: this.#eventSequence,
      fillSequence: this.#fillSequence,
      cooldownUntilMs: this.#cooldownUntilMs,
      pendingExitReason: this.#pendingExitReason,
      stopRequested: this.#stopRequested
    };
  }

  #observe(input: StrategyObservation): StrategyObservation {
    const observation = normalizedObservation(input);
    if (this.#evaluatedAtMs !== null && observation.atMs < this.#evaluatedAtMs) {
      throw new StrategyObservationError("STRATEGY_CLOCK_MOVED_BACKWARDS");
    }
    this.#evaluatedAtMs = observation.atMs;
    this.#lastObservation = observation;
    return observation;
  }

  #qualifies(observation: StrategyObservation, direction?: StrategyDirection): boolean {
    if (observation.direction === null || observation.edgeBps === null) return false;
    if (direction && observation.direction !== direction) return false;
    return new Decimal(observation.edgeBps).abs().gte(this.config.entry.minEdgeBps);
  }

  #open(observation: StrategyObservation): StrategyEvent {
    const fromState = this.#state;
    const initialQuote = new Decimal(this.config.entry.initialSizeQuote);
    const nextScaleTimer = this.#nextScaleTimer(observation.atMs, 1, initialQuote);
    const fill = this.#fill(
      "ENTRY",
      this.#arming?.direction as StrategyDirection,
      observation,
      initialQuote,
      initialQuote
    );
    this.#basketCount += 1;
    const totalQuote = new Decimal(fill.quoteNotional);
    const totalBase = new Decimal(fill.baseQuantity);
    this.#currentBasket = {
      basketSequence: this.#basketCount,
      direction: fill.direction,
      status: "OPEN",
      openedAtMs: observation.atMs,
      closedAtMs: null,
      entries: [fill],
      exitFill: null,
      totalQuoteNotional: plain(totalQuote),
      totalBaseQuantity: plain(totalBase),
      averageEntryPrice: plain(totalQuote.div(totalBase)),
      currentPrice: observation.price,
      currentReferenceSource: observation.referenceSource,
      grossPnlBps: bps(new Decimal(0)),
      grossPnlQuote: quote(new Decimal(0)),
      currentTargetProfitBps: bps(targetProfitBps(this.config, observation.atMs, observation.atMs)),
      exitReason: null,
      nextEntryQualificationSinceMs: nextScaleTimer?.qualificationSinceMs ?? null,
      nextEntryDueAtMs: nextScaleTimer?.dueAtMs ?? null
    };
    this.#state = "OPEN";
    this.#arming = null;
    return this.#event("ENTRY_FILLED", observation.atMs, fromState, null, observation, fill, this.#currentBasket);
  }

  #fill(
    kind: StrategyFillKind,
    direction: StrategyDirection,
    observation: StrategyObservation,
    actualQuote: Decimal,
    scheduledQuote: Decimal,
    baseOverride?: Decimal
  ): StrategyFill {
    if (observation.price === null || observation.referenceSource === null) {
      throw new StrategyStateError("FILL_REQUIRES_PRICE");
    }
    this.#fillSequence += 1;
    return {
      sequence: this.#fillSequence,
      kind,
      direction,
      atMs: observation.atMs,
      price: observation.price,
      referenceSource: observation.referenceSource,
      quoteNotional: plain(actualQuote),
      scheduledQuoteNotional: plain(scheduledQuote),
      cappedByMaxTotal: actualQuote.lt(scheduledQuote),
      baseQuantity: plain(baseOverride ?? actualQuote.div(observation.price)),
      edgeBps: observation.edgeBps
    };
  }

  #markCurrentBasket(observation: StrategyObservation): void {
    const basket = this.#currentBasket as StrategyBasketSnapshot;
    basket.currentTargetProfitBps = bps(targetProfitBps(this.config, basket.openedAtMs, observation.atMs));
    if (observation.price === null) {
      basket.currentPrice = null;
      basket.currentReferenceSource = null;
      basket.grossPnlBps = null;
      basket.grossPnlQuote = null;
      return;
    }
    const markValue = new Decimal(basket.totalBaseQuantity).mul(observation.price);
    const entryValue = new Decimal(basket.totalQuoteNotional);
    const pnl = basket.direction === "BUY" ? markValue.minus(entryValue) : entryValue.minus(markValue);
    basket.currentPrice = observation.price;
    basket.currentReferenceSource = observation.referenceSource;
    basket.grossPnlQuote = quote(pnl);
    basket.grossPnlBps = bps(pnl.div(entryValue).mul(BPS));
  }

  #automaticExitReason(observation: StrategyObservation): StrategyExitReason | null {
    const basket = this.#currentBasket as StrategyBasketSnapshot;
    if (observation.price === null) return null;
    const markValue = new Decimal(basket.totalBaseQuantity).mul(observation.price);
    const entryValue = new Decimal(basket.totalQuoteNotional);
    const pnl = basket.direction === "BUY" ? markValue.minus(entryValue) : entryValue.minus(markValue);
    const pnlBps = pnl.div(entryValue).mul(BPS);
    if (pnlBps.lte(new Decimal(this.config.exit.stopLossBps).negated())) return "STOP_LOSS";
    if (this.#forceExitDue(observation.atMs)) return "FORCE_EXIT";
    if (pnlBps.gte(targetProfitBps(this.config, basket.openedAtMs, observation.atMs))) return "TAKE_PROFIT";
    return null;
  }

  #forceExitDue(atMs: number): boolean {
    const basket = this.#currentBasket as StrategyBasketSnapshot;
    return atMs - basket.openedAtMs >= secondsToMs(this.config.exit.forceExitSec);
  }

  #maybeScaleIn(observation: StrategyObservation): StrategyEvent | null {
    const basket = this.#currentBasket as StrategyBasketSnapshot;
    if (!this.#canScale()) {
      this.#clearScaleTimer();
      return null;
    }
    if (!this.#qualifies(observation, basket.direction)) {
      this.#clearScaleTimer();
      return null;
    }
    if (basket.nextEntryQualificationSinceMs === null) this.#setScaleTimer(observation.atMs);
    if (observation.atMs < (basket.nextEntryDueAtMs as number) || observation.price === null) return null;

    const exponent = basket.entries.length - 1;
    const scheduled = new Decimal(this.config.scaling.sizeQuote)
      .mul(new Decimal(this.config.scaling.sizeMultiplier).pow(exponent));
    const remaining = new Decimal(this.config.scaling.maxTotalSizeQuote).minus(basket.totalQuoteNotional);
    const actual = Decimal.min(scheduled, remaining);
    if (!actual.gt(0)) {
      this.#clearScaleTimer();
      return null;
    }
    const totalQuote = new Decimal(basket.totalQuoteNotional).plus(actual);
    const nextScaleTimer = this.#nextScaleTimer(
      observation.atMs,
      basket.entries.length + 1,
      totalQuote
    );
    const fill = this.#fill("ADD", basket.direction, observation, actual, scheduled);
    basket.entries.push(fill);
    const totalBase = new Decimal(basket.totalBaseQuantity).plus(fill.baseQuantity);
    basket.totalQuoteNotional = plain(totalQuote);
    basket.totalBaseQuantity = plain(totalBase);
    basket.averageEntryPrice = plain(totalQuote.div(totalBase));
    this.#markCurrentBasket(observation);
    basket.nextEntryQualificationSinceMs = nextScaleTimer?.qualificationSinceMs ?? null;
    basket.nextEntryDueAtMs = nextScaleTimer?.dueAtMs ?? null;
    return this.#event("ADD_FILLED", observation.atMs, "OPEN", null, observation, fill, basket);
  }

  #canScale(): boolean {
    const basket = this.#currentBasket as StrategyBasketSnapshot;
    return this.config.scaling.enabled &&
      basket.entries.length < this.config.scaling.maxEntries &&
      new Decimal(basket.totalQuoteNotional).lt(this.config.scaling.maxTotalSizeQuote);
  }

  #setScaleTimer(sinceMs: number): void {
    const basket = this.#currentBasket as StrategyBasketSnapshot;
    const timer = this.#nextScaleTimer(
      sinceMs,
      basket.entries.length,
      new Decimal(basket.totalQuoteNotional)
    );
    basket.nextEntryQualificationSinceMs = timer?.qualificationSinceMs ?? null;
    basket.nextEntryDueAtMs = timer?.dueAtMs ?? null;
  }

  #nextScaleTimer(
    sinceMs: number,
    entryCount: number,
    totalQuote: Decimal
  ): { qualificationSinceMs: number; dueAtMs: number } | null {
    if (
      !this.config.scaling.enabled ||
      entryCount >= this.config.scaling.maxEntries ||
      !totalQuote.lt(this.config.scaling.maxTotalSizeQuote)
    ) return null;
    return {
      qualificationSinceMs: sinceMs,
      dueAtMs: scaledDueAtMs(
        sinceMs,
        this.config.scaling.intervalSec,
        this.config.scaling.intervalMultiplier,
        entryCount - 1
      )
    };
  }

  #clearScaleTimer(): void {
    if (!this.#currentBasket) return;
    this.#currentBasket.nextEntryQualificationSinceMs = null;
    this.#currentBasket.nextEntryDueAtMs = null;
  }

  #close(observation: StrategyObservation, reason: StrategyExitReason): StrategyEvent[] {
    const shouldStop = this.#stopRequested || reason === "MANUAL_STOP";
    const cooldownUntilMs = !shouldStop && this.config.cooldownSec > 0
      ? safeDeadlineAtMs(
          observation.atMs,
          secondsToMs(this.config.cooldownSec),
          "COOLDOWN_TIME_OVERFLOW"
        )
      : null;
    const basket = this.#currentBasket as StrategyBasketSnapshot;
    const fromState = this.#state;
    this.#markCurrentBasket(observation);
    const exitValue = new Decimal(basket.totalBaseQuantity).mul(observation.price as string);
    const fill = this.#fill(
      "EXIT",
      basket.direction,
      observation,
      exitValue,
      exitValue,
      new Decimal(basket.totalBaseQuantity)
    );
    basket.status = "CLOSED";
    basket.closedAtMs = observation.atMs;
    basket.exitFill = fill;
    basket.exitReason = reason;
    basket.nextEntryQualificationSinceMs = null;
    basket.nextEntryDueAtMs = null;
    this.#lastClosedBasket = cloneBasket(basket);
    this.#currentBasket = null;
    this.#pendingExitReason = null;

    this.#stopRequested = false;
    if (shouldStop) {
      this.#state = "STOPPED";
      this.#stoppedAtMs = observation.atMs;
      this.#cooldownUntilMs = null;
    } else if (this.config.cooldownSec > 0) {
      this.#state = "COOLDOWN";
      this.#cooldownUntilMs = cooldownUntilMs;
    } else {
      this.#state = "IDLE";
      this.#cooldownUntilMs = null;
    }
    const events = [this.#event("EXIT_FILLED", observation.atMs, fromState, reason, observation, fill, basket)];
    if (shouldStop) {
      events.push(this.#event("RUN_STOPPED", observation.atMs, "STOPPED", "MANUAL_STOP", observation, null, basket));
    }
    return events;
  }

  #event(
    kind: StrategyEventKind,
    atMs: number,
    fromState: StrategyState,
    reason: StrategyEventReason,
    observation: StrategyObservation | null,
    fill: StrategyFill | null,
    basket: StrategyBasketSnapshot | null
  ): StrategyEvent {
    this.#eventSequence += 1;
    return {
      schemaVersion: 1,
      sequence: this.#eventSequence,
      kind,
      atMs,
      fromState,
      toState: this.#state,
      reason,
      basketSequence: basket?.basketSequence ?? this.#currentBasket?.basketSequence ?? null,
      observation: cloneObservation(observation),
      fill: cloneFill(fill),
      basket: cloneBasket(basket ?? this.#currentBasket)
    };
  }
}
