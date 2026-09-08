import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import {
  listEventDatasets,
  loadEventDataset,
  loadObservationTape,
  type EventDatasetManifest,
  type RecordedStrategyObservation
} from "@side/recorder-replay";
import {
  DryRunStrategyEngine,
  strategyConfigFingerprint,
  validateStrategyConfigV1,
  type StrategyBasketSnapshot,
  type StrategyConfigV1,
  type StrategyEvent,
  type StrategyExitReason,
  type StrategyObservation,
  type StrategySnapshot
} from "@side/strategy-engine";
import { S0Runtime } from "../runtime.js";
import { strategyObservation } from "../strategy/coordinator.js";

const RUNNER_VERSION = "backtest-v1";

export class BacktestError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
  }
}

export interface BacktestSummary {
  observationCount: number;
  readyObservationCount: number;
  coverageRatio: string;
  basketCount: number;
  closedBasketCount: number;
  openBasketCount: number;
  winCount: number;
  lossCount: number;
  flatCount: number;
  entryFillCount: number;
  totalEntryNotionalQuote: string;
  maxCapitalQuote: string;
  closedPnlQuote: string;
  openPnlQuote: string | null;
  totalTheoreticalPnlQuote: string | null;
  averageClosedPnlQuote: string | null;
  returnOnMaxCapitalBps: string | null;
  maxDrawdownQuote: string;
  exitReasonCounts: Record<StrategyExitReason, number>;
}

export interface BacktestDatasetReference {
  datasetId: string;
  datasetSha256: string;
  eventCount: number;
  observationCount: number;
  firstAtMs: number;
  lastAtMs: number;
  signalModelVersion: string;
  observationSource: "RECORDED_TAPE" | "RECONSTRUCTED_EVENTS";
}

export interface BacktestEquityPoint {
  atMs: number;
  equityQuote: string | null;
  closedPnlQuote: string;
  openPnlQuote: string | null;
}

export interface BacktestResult {
  schemaVersion: 1;
  runnerVersion: typeof RUNNER_VERSION;
  resultId: string;
  resultSha256: string;
  executionModel: "GROSS_THEORETICAL_V1";
  dataset: BacktestDatasetReference;
  config: StrategyConfigV1;
  configSha256: string;
  startedAtMs: number;
  completedAtMs: number;
  summary: BacktestSummary;
  equityCurve: BacktestEquityPoint[];
  baskets: StrategyBasketSnapshot[];
  events: StrategyEvent[];
  finalSnapshot: StrategySnapshot;
}

export interface BacktestObservation extends StrategyObservation {
  coverageState: "READY" | "INSUFFICIENT_DATA";
}

export interface PreparedBacktestDataset {
  manifest: EventDatasetManifest;
  observations: BacktestObservation[];
  observationSource: BacktestDatasetReference["observationSource"];
}

function fixedQuote(value: Decimal): string {
  return value.toDecimalPlaces(6).toFixed(6);
}

function fixedBps(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

function observationFromTape(value: RecordedStrategyObservation): BacktestObservation {
  return {
    atMs: value.atMs,
    direction: value.direction,
    edgeBps: value.edgeBps,
    price: value.price,
    referenceSource: value.referenceSource,
    coverageState: value.coverageState
  };
}

function strategyHash(config: StrategyConfigV1): string {
  return createHash("sha256").update(strategyConfigFingerprint(config)).digest("hex");
}

function emptyExitCounts(): Record<StrategyExitReason, number> {
  return { TAKE_PROFIT: 0, STOP_LOSS: 0, FORCE_EXIT: 0, MANUAL_STOP: 0 };
}

function sampledCurve(points: BacktestEquityPoint[], maximum = 600): BacktestEquityPoint[] {
  if (points.length <= maximum) return points;
  const stride = Math.ceil((points.length - 1) / (maximum - 1));
  const sampled = points.filter((_point, index) => index === 0 || index === points.length - 1 || index % stride === 0);
  return sampled.length <= maximum ? sampled : [...sampled.slice(0, maximum - 1), points[points.length - 1] as BacktestEquityPoint];
}

export function runObservationBacktest(input: {
  manifest: EventDatasetManifest;
  observations: readonly BacktestObservation[];
  observationSource: BacktestDatasetReference["observationSource"];
  config: StrategyConfigV1;
}): BacktestResult {
  const config = validateStrategyConfigV1(input.config);
  const observations = [...input.observations];
  if (input.manifest.status !== "COMPLETE" || input.manifest.datasetSha256 === null) {
    throw new BacktestError(409, "BACKTEST_DATASET_NOT_COMPLETE");
  }
  if (observations.length === 0) throw new BacktestError(409, "BACKTEST_DATASET_HAS_NO_OBSERVATIONS");
  for (let index = 1; index < observations.length; index += 1) {
    if ((observations[index - 1] as BacktestObservation).atMs >= (observations[index] as BacktestObservation).atMs) {
      throw new BacktestError(409, "BACKTEST_OBSERVATIONS_NOT_STRICTLY_ORDERED");
    }
  }

  const engine = new DryRunStrategyEngine(config);
  const startedAtMs = (observations[0] as BacktestObservation).atMs;
  const allEvents: StrategyEvent[] = [...engine.start(startedAtMs)];
  const baskets: StrategyBasketSnapshot[] = [];
  const exitReasonCounts = emptyExitCounts();
  let closedPnl = new Decimal(0);
  let totalEntryNotional = new Decimal(0);
  let maxCapital = new Decimal(0);
  let highWater = new Decimal(0);
  let maxDrawdown = new Decimal(0);
  let readyObservationCount = 0;
  const rawEquityCurve: BacktestEquityPoint[] = [];

  for (const observation of observations) {
    if (observation.coverageState === "READY") readyObservationCount += 1;
    const emitted = engine.evaluate(observation);
    allEvents.push(...emitted);
    for (const event of emitted) {
      if ((event.kind === "ENTRY_FILLED" || event.kind === "ADD_FILLED") && event.fill) {
        totalEntryNotional = totalEntryNotional.plus(event.fill.quoteNotional);
      }
      if (event.kind === "EXIT_FILLED" && event.basket) {
        baskets.push(event.basket);
        closedPnl = closedPnl.plus(event.basket.grossPnlQuote ?? 0);
        if (event.basket.exitReason) exitReasonCounts[event.basket.exitReason] += 1;
      }
    }
    const current = engine.snapshot().currentBasket;
    if (current) maxCapital = Decimal.max(maxCapital, current.totalQuoteNotional);
    const pricedOpenPnl: Decimal | null = !current
      ? new Decimal(0)
      : current.grossPnlQuote === null
        ? null
        : new Decimal(current.grossPnlQuote);
    if (!current || pricedOpenPnl !== null) {
      const equity = closedPnl.plus(pricedOpenPnl ?? 0);
      highWater = Decimal.max(highWater, equity);
      maxDrawdown = Decimal.max(maxDrawdown, highWater.minus(equity));
    }
    rawEquityCurve.push({
      atMs: observation.atMs,
      equityQuote: current && pricedOpenPnl === null ? null : fixedQuote(closedPnl.plus(pricedOpenPnl ?? 0)),
      closedPnlQuote: fixedQuote(closedPnl),
      openPnlQuote: current && pricedOpenPnl === null ? null : fixedQuote(pricedOpenPnl as Decimal)
    });
  }

  const finalSnapshot = engine.snapshot();
  const openBasket = finalSnapshot.currentBasket;
  const openPnl = openBasket?.grossPnlQuote === null
    ? null
    : new Decimal(openBasket?.grossPnlQuote ?? 0);
  if (openBasket) maxCapital = Decimal.max(maxCapital, openBasket.totalQuoteNotional);
  const totalPnl = openPnl === null ? null : closedPnl.plus(openPnl);
  const winCount = baskets.filter((basket) => new Decimal(basket.grossPnlQuote ?? 0).gt(0)).length;
  const lossCount = baskets.filter((basket) => new Decimal(basket.grossPnlQuote ?? 0).lt(0)).length;
  const flatCount = baskets.length - winCount - lossCount;
  const summary: BacktestSummary = {
    observationCount: observations.length,
    readyObservationCount,
    coverageRatio: new Decimal(readyObservationCount).div(observations.length).toDecimalPlaces(8).toFixed(8),
    basketCount: baskets.length + (openBasket ? 1 : 0),
    closedBasketCount: baskets.length,
    openBasketCount: openBasket ? 1 : 0,
    winCount,
    lossCount,
    flatCount,
    entryFillCount: allEvents.filter((event) => event.kind === "ENTRY_FILLED" || event.kind === "ADD_FILLED").length,
    totalEntryNotionalQuote: fixedQuote(totalEntryNotional),
    maxCapitalQuote: fixedQuote(maxCapital),
    closedPnlQuote: fixedQuote(closedPnl),
    openPnlQuote: openPnl === null ? null : fixedQuote(openPnl),
    totalTheoreticalPnlQuote: totalPnl === null ? null : fixedQuote(totalPnl),
    averageClosedPnlQuote: baskets.length === 0 ? null : fixedQuote(closedPnl.div(baskets.length)),
    returnOnMaxCapitalBps: maxCapital.eq(0) || totalPnl === null
      ? null
      : fixedBps(totalPnl.div(maxCapital).mul(10_000)),
    maxDrawdownQuote: fixedQuote(maxDrawdown),
    exitReasonCounts
  };
  const configSha256 = strategyHash(config);
  const completedAtMs = (observations[observations.length - 1] as BacktestObservation).atMs;
  const resultBody: Omit<BacktestResult, "resultId" | "resultSha256"> = {
    schemaVersion: 1 as const,
    runnerVersion: RUNNER_VERSION,
    executionModel: "GROSS_THEORETICAL_V1" as const,
    dataset: {
      datasetId: input.manifest.datasetId,
      datasetSha256: input.manifest.datasetSha256,
      eventCount: input.manifest.eventCount,
      observationCount: observations.length,
      firstAtMs: startedAtMs,
      lastAtMs: completedAtMs,
      signalModelVersion: "s0-v1",
      observationSource: input.observationSource
    },
    config,
    configSha256,
    startedAtMs,
    completedAtMs,
    summary,
    equityCurve: sampledCurve(rawEquityCurve),
    baskets,
    events: allEvents,
    finalSnapshot
  };
  const resultSha256 = createHash("sha256").update(JSON.stringify(resultBody)).digest("hex");
  return {
    ...resultBody,
    resultId: `backtest:${resultSha256.slice(0, 24)}`,
    resultSha256
  };
}

export class BacktestRunner {
  constructor(readonly recordingRootDir: string) {}

  listDatasets(): Promise<EventDatasetManifest[]> {
    return listEventDatasets(this.recordingRootDir);
  }

  async prepare(datasetId: string): Promise<PreparedBacktestDataset> {
    try {
      const tape = await loadObservationTape(this.recordingRootDir, datasetId);
      if (tape.observations.length > 0) {
        const unsupported = tape.observations.find(({ signalModelVersion }) => signalModelVersion !== "s0-v1");
        if (unsupported) throw new BacktestError(409, "BACKTEST_SIGNAL_MODEL_NOT_SUPPORTED");
        return {
          manifest: tape.manifest,
          observations: tape.observations.map(observationFromTape),
          observationSource: "RECORDED_TAPE"
        };
      }

      const loaded = await loadEventDataset(this.recordingRootDir, datasetId);
      if (loaded.events.length === 0) throw new BacktestError(409, "BACKTEST_DATASET_HAS_NO_EVENTS");
      const runtime = new S0Runtime("", 64, "REPLAY", "coinbase");
      const observations: BacktestObservation[] = [];
      const endAtReceivedMs = loaded.manifest.closedAtMs === null
        ? undefined
        : Math.max(loaded.manifest.closedAtMs, loaded.events[loaded.events.length - 1]?.receivedAtUnixMs ?? 0);
      runtime.startReplayEvents(
        loaded.events,
        ({ referenceAtMs }) => {
          const signal = runtime.snapshot().signal;
          observations.push({
            ...strategyObservation(signal, runtime.paperDryReference(referenceAtMs), referenceAtMs),
            coverageState: signal.verdict.dataState
          });
        },
        endAtReceivedMs
      );
      return {
        manifest: loaded.manifest,
        observations,
        observationSource: "RECONSTRUCTED_EVENTS"
      };
    } catch (reason) {
      if (reason instanceof BacktestError) throw reason;
      if ((reason as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BacktestError(404, "BACKTEST_DATASET_NOT_FOUND");
      }
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.startsWith("DATASET_") || message === "INVALID_DATASET_ID") {
        throw new BacktestError(409, message);
      }
      throw reason;
    }
  }

  runPrepared(prepared: PreparedBacktestDataset, rawConfig: unknown): BacktestResult {
    return runObservationBacktest({
      manifest: prepared.manifest,
      observations: prepared.observations,
      observationSource: prepared.observationSource,
      config: validateStrategyConfigV1(rawConfig)
    });
  }

  async run(datasetId: string, rawConfig: unknown): Promise<BacktestResult> {
    return this.runPrepared(await this.prepare(datasetId), rawConfig);
  }
}
