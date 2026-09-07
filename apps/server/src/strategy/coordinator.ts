import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import {
  DryRunStrategyEngine,
  validateStrategyConfigV1,
  type StrategyBasketSnapshot,
  type StrategyConfigV1,
  type StrategyEvent,
  type StrategyObservation,
  type StrategySnapshot
} from "@side/strategy-engine";
import type { SignalSnapshot } from "@side/signal-engine";
import type { PaperDryReferenceSnapshot } from "../paper/contracts.js";
import type {
  StrategyBasketRecord,
  StrategyConfigRevision,
  StrategyRunRecord
} from "./contracts.js";
import type { StrategyJournal } from "./journal.js";

export class StrategyPolicyError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
  }
}

export interface StrategyRunDetail {
  run: StrategyRunRecord;
  configRevision: StrategyConfigRevision;
  baskets: StrategyBasketRecord[];
  events: Awaited<ReturnType<StrategyJournal["listEvents"]>>;
  eventsTruncated: boolean;
}

interface ActiveStrategyRun {
  configRevision: StrategyConfigRevision;
  run: StrategyRunRecord;
  engine: DryRunStrategyEngine;
}

function directionFor(signal: SignalSnapshot): "BUY" | "SELL" | null {
  if (signal.verdict.verdict === "BUY_BIAS") return "BUY";
  if (signal.verdict.verdict === "SELL_BIAS") return "SELL";
  return null;
}

/**
 * Converts the discrete s0-v1 verdict into an auditable scalar edge. The edge is
 * the third-strongest absolute price impulse among fresh juries voting with the
 * verdict, i.e. the weakest member needed to form the 3/4 quorum.
 */
export function strategyObservation(
  signal: SignalSnapshot,
  reference: PaperDryReferenceSnapshot,
  atMs: number
): StrategyObservation {
  const direction = directionFor(signal);
  const impulses = direction === null
    ? []
    : signal.juries
      .filter((jury) => jury.dataState === "FRESH" && jury.vote === direction)
      .flatMap((jury) => {
        const value = jury.features.priceImpulse30s.valueBps;
        if (jury.features.priceImpulse30s.status !== "available" || value === null) return [];
        const parsed = new Decimal(value).abs();
        return parsed.isFinite() ? [parsed] : [];
      })
      .sort((left, right) => right.comparedTo(left));
  const quorumEdge = impulses.length >= 3 ? impulses[2] as Decimal : null;
  return {
    atMs,
    direction: quorumEdge === null ? null : direction,
    edgeBps: quorumEdge?.toDecimalPlaces(8).toString() ?? null,
    price: reference.status === "READY" ? reference.priceQuotePerSol : null,
    referenceSource: reference.status === "READY" ? reference.source : null
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

function runRecord(
  identity: Pick<StrategyRunRecord, "runId" | "strategyId" | "configRevision" | "startedAtMs">,
  snapshot: StrategySnapshot
): StrategyRunRecord {
  const updatedAtMs = snapshot.evaluatedAtMs ?? identity.startedAtMs;
  return {
    ...identity,
    executionMode: "DRY_RUN",
    status: snapshot.state,
    startedAtMs: identity.startedAtMs,
    updatedAtMs,
    completedAtMs: snapshot.state === "STOPPED" ? snapshot.stoppedAtMs ?? updatedAtMs : null,
    snapshot
  };
}

export class StrategyCoordinator {
  #active: ActiveStrategyRun | null = null;
  #reconciliationRequired = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly journal: StrategyJournal,
    private readonly now: () => number = Date.now
  ) {}

  async initialize(): Promise<void> {
    await this.journal.initialize();
    await this.#reconcileFromJournal();
  }

  async #reconcileFromJournal(): Promise<void> {
    const recoveries = await this.journal.recoverActiveRuns();
    if (recoveries.length > 1) throw new Error("MULTIPLE_ACTIVE_STRATEGY_RUNS");
    const recovered = recoveries[0];
    this.#active = recovered
      ? {
          configRevision: recovered.configRevision,
          run: recovered.run,
          engine: DryRunStrategyEngine.restore(recovered.configRevision.config, recovered.run.snapshot)
        }
      : null;
    this.#reconciliationRequired = false;
  }

  async #ensureReconciled(): Promise<void> {
    if (this.#reconciliationRequired) await this.#reconcileFromJournal();
  }

  async #markAndTryReconcile(): Promise<void> {
    this.#reconciliationRequired = true;
    try {
      await this.#reconcileFromJournal();
    } catch {
      // Keep the last known committed in-memory state and retry reconciliation
      // before accepting another state transition.
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.journal.close();
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  activeRun(): StrategyRunRecord | null {
    if (!this.#active) return null;
    const current = runRecord(this.#active.run, this.#active.engine.snapshot());
    this.#active.run = current;
    return current;
  }

  async saveConfig(rawConfig: StrategyConfigV1, strategyId: string | null = null): Promise<StrategyConfigRevision> {
    const config = validateStrategyConfigV1(rawConfig);
    const id = strategyId?.trim() || `strategy:${randomUUID()}`;
    return this.journal.createConfigRevision({ strategyId: id, config, createdAtMs: this.now() });
  }

  listConfigs(limit: number, strategyId?: string): Promise<StrategyConfigRevision[]> {
    return this.journal.listConfigRevisions(limit, strategyId);
  }

  listRuns(limit: number, strategyId?: string): Promise<StrategyRunRecord[]> {
    return this.journal.listRuns(limit, strategyId);
  }

  async runDetail(runId: string, eventLimit = 500): Promise<StrategyRunDetail | null> {
    const recovery = await this.journal.getRunRecovery(runId);
    if (!recovery) return null;
    const run = this.#active?.run.runId === runId ? this.activeRun() as StrategyRunRecord : recovery.run;
    const [baskets, eventPage] = await Promise.all([
      this.journal.listBaskets(runId),
      this.journal.listEvents(runId, eventLimit + 1)
    ]);
    const eventsTruncated = eventPage.length > eventLimit;
    return {
      run,
      configRevision: recovery.configRevision,
      baskets,
      events: eventsTruncated ? eventPage.slice(1) : eventPage,
      eventsTruncated
    };
  }

  async start(strategyId: string, revision?: number, startedAtMs = this.now()): Promise<StrategyRunRecord> {
    return this.#serialized(async () => {
      await this.#ensureReconciled();
      if (this.#active) throw new StrategyPolicyError(409, "STRATEGY_RUN_ALREADY_ACTIVE");
      const configRevision = await this.journal.getConfigRevision(strategyId, revision);
      if (!configRevision) throw new StrategyPolicyError(404, "STRATEGY_CONFIG_NOT_FOUND");
      const atMs = startedAtMs;
      const engine = new DryRunStrategyEngine(configRevision.config);
      const events = engine.start(atMs);
      const event = events[0];
      if (!event || event.kind !== "RUN_STARTED") throw new Error("STRATEGY_ENGINE_DID_NOT_START");
      const identity = {
        runId: `strategy-run:${randomUUID()}`,
        strategyId: configRevision.strategyId,
        configRevision: configRevision.revision,
        startedAtMs: atMs
      };
      const run = runRecord(identity, engine.snapshot());
      try {
        await this.journal.createRun({ run, event });
      } catch (reason) {
        await this.#markAndTryReconcile();
        throw reason;
      }
      this.#active = { configRevision, run, engine };
      return run;
    });
  }

  evaluate(observation: StrategyObservation): Promise<StrategyRunRecord | null> {
    return this.#serialized(async () => {
      await this.#ensureReconciled();
      if (!this.#active) return null;
      const current = this.#active;
      const candidate = DryRunStrategyEngine.restore(current.configRevision.config, current.engine.snapshot());
      const events = candidate.evaluate(observation);
      let run: StrategyRunRecord;
      try {
        run = await this.#persistCandidate(current.run, candidate, events);
      } catch (reason) {
        await this.#markAndTryReconcile();
        throw reason;
      }
      this.#active = run.completedAtMs === null
        ? { configRevision: current.configRevision, run, engine: candidate }
        : null;
      return run;
    });
  }

  stop(runId: string, observation: StrategyObservation): Promise<StrategyRunRecord> {
    return this.#serialized(async () => {
      await this.#ensureReconciled();
      if (!this.#active || this.#active.run.runId !== runId) {
        throw new StrategyPolicyError(404, "ACTIVE_STRATEGY_RUN_NOT_FOUND");
      }
      const current = this.#active;
      const candidate = DryRunStrategyEngine.restore(current.configRevision.config, current.engine.snapshot());
      const events = candidate.stop(observation);
      let run: StrategyRunRecord;
      try {
        run = await this.#persistCandidate(current.run, candidate, events);
      } catch (reason) {
        await this.#markAndTryReconcile();
        throw reason;
      }
      this.#active = run.completedAtMs === null
        ? { configRevision: current.configRevision, run, engine: candidate }
        : null;
      return run;
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }

  async #persistCandidate(
    currentRun: StrategyRunRecord,
    candidate: DryRunStrategyEngine,
    events: StrategyEvent[]
  ): Promise<StrategyRunRecord> {
    const snapshot = candidate.snapshot();
    const run = runRecord(currentRun, snapshot);
    if (events.length === 0) {
      const basket = snapshot.currentBasket
        ? basketRecord(run.runId, snapshot.currentBasket, run.updatedAtMs)
        : null;
      await this.journal.checkpoint({ run, basket });
      return run;
    }
    const records = events.map((event) => {
      const basket = event.basket ? basketRecord(run.runId, event.basket, event.atMs) : null;
      if (event.fill && !basket) throw new Error("STRATEGY_FILL_WITHOUT_BASKET");
      return { event, basket };
    });
    await this.journal.recordBatch({ run, records });
    return run;
  }
}
