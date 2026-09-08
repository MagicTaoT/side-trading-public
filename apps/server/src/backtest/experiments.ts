import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  strategyConfigFingerprint,
  validateStrategyConfigV1,
  type StrategyConfigV1
} from "@side/strategy-engine";
import {
  BacktestError,
  BacktestRunner,
  type BacktestDatasetReference,
  type BacktestResult,
  type BacktestSummary
} from "./runner.js";

export const BACKTEST_GRID_FIELDS = [
  "entry.minEdgeBps",
  "entry.holdSec",
  "entry.initialSizeQuote",
  "scaling.enabled",
  "scaling.intervalSec",
  "scaling.intervalMultiplier",
  "scaling.sizeQuote",
  "scaling.sizeMultiplier",
  "scaling.maxEntries",
  "scaling.maxTotalSizeQuote",
  "exit.takeProfitBps",
  "exit.linearDecayToZero",
  "exit.stopLossBps",
  "exit.forceExitSec",
  "cooldownSec"
] as const;

export type BacktestGridField = (typeof BACKTEST_GRID_FIELDS)[number];
export type BacktestParameterGrid = Partial<Record<BacktestGridField, unknown[]>>;
export type BacktestExperimentStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED";
export type BacktestVariantStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

const MAX_VARIANTS = 128;
const EXPERIMENT_ID = /^experiment-[a-f0-9-]{36}$/u;
const VARIANT_ID = /^variant-\d{3}$/u;

export interface BacktestVariantRecord {
  variantId: string;
  ordinal: number;
  status: BacktestVariantStatus;
  config: StrategyConfigV1;
  configSha256: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
  resultId: string | null;
  resultSha256: string | null;
  summary: BacktestSummary | null;
  error: string | null;
}

export interface BacktestExperimentRecord {
  schemaVersion: 1;
  experimentId: string;
  name: string;
  datasetId: string;
  dataset: BacktestDatasetReference | null;
  status: BacktestExperimentStatus;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  variantCount: number;
  completedVariantCount: number;
  failedVariantCount: number;
  cancelRequested: boolean;
  variants: BacktestVariantRecord[];
  error: string | null;
}

export interface CreateBacktestExperimentInput {
  name?: unknown;
  datasetId?: unknown;
  configs?: unknown;
  baseConfig?: unknown;
  parameterGrid?: unknown;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BacktestError(400, code);
  return value as Record<string, unknown>;
}

function configSha256(config: StrategyConfigV1): string {
  return createHash("sha256").update(strategyConfigFingerprint(config)).digest("hex");
}

function cloneConfig(config: StrategyConfigV1): StrategyConfigV1 {
  return {
    ...config,
    entry: { ...config.entry },
    scaling: { ...config.scaling },
    exit: { ...config.exit }
  };
}

function setGridValue(config: StrategyConfigV1, field: BacktestGridField, value: unknown): StrategyConfigV1 {
  const next = cloneConfig(config);
  switch (field) {
    case "entry.minEdgeBps": next.entry.minEdgeBps = value as string; break;
    case "entry.holdSec": next.entry.holdSec = value as number; break;
    case "entry.initialSizeQuote": next.entry.initialSizeQuote = value as string; break;
    case "scaling.enabled": next.scaling.enabled = value as boolean; break;
    case "scaling.intervalSec": next.scaling.intervalSec = value as number; break;
    case "scaling.intervalMultiplier": next.scaling.intervalMultiplier = value as string; break;
    case "scaling.sizeQuote": next.scaling.sizeQuote = value as string; break;
    case "scaling.sizeMultiplier": next.scaling.sizeMultiplier = value as string; break;
    case "scaling.maxEntries": next.scaling.maxEntries = value as number; break;
    case "scaling.maxTotalSizeQuote": next.scaling.maxTotalSizeQuote = value as string; break;
    case "exit.takeProfitBps": next.exit.takeProfitBps = value as string; break;
    case "exit.linearDecayToZero": next.exit.linearDecayToZero = value as boolean; break;
    case "exit.stopLossBps": next.exit.stopLossBps = value as string; break;
    case "exit.forceExitSec": next.exit.forceExitSec = value as number; break;
    case "cooldownSec": next.cooldownSec = value as number; break;
  }
  return next;
}

function deduplicated(configs: StrategyConfigV1[]): StrategyConfigV1[] {
  const seen = new Set<string>();
  return configs.filter((config) => {
    const fingerprint = strategyConfigFingerprint(config);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

export function expandExperimentConfigs(input: CreateBacktestExperimentInput): {
  name: string;
  datasetId: string;
  configs: StrategyConfigV1[];
} {
  if (typeof input.datasetId !== "string" || input.datasetId.trim().length === 0) {
    throw new BacktestError(400, "INVALID_BACKTEST_DATASET_ID");
  }
  const name = typeof input.name === "string" && input.name.trim().length > 0
    ? input.name.trim()
    : "Backtest experiment";
  if (name.length > 120) throw new BacktestError(400, "INVALID_BACKTEST_EXPERIMENT_NAME");

  const hasConfigs = input.configs !== undefined;
  const hasGrid = input.baseConfig !== undefined || input.parameterGrid !== undefined;
  if (hasConfigs === hasGrid) throw new BacktestError(400, "BACKTEST_EXPERIMENT_REQUIRES_CONFIGS_OR_GRID");

  let configs: StrategyConfigV1[];
  if (hasConfigs) {
    if (!Array.isArray(input.configs) || input.configs.length === 0 || input.configs.length > MAX_VARIANTS) {
      throw new BacktestError(400, "INVALID_BACKTEST_CONFIG_BATCH");
    }
    configs = input.configs.map((config) => validateStrategyConfigV1(config));
  } else {
    const base = validateStrategyConfigV1(input.baseConfig);
    const grid = object(input.parameterGrid, "INVALID_BACKTEST_PARAMETER_GRID");
    const entries = Object.entries(grid);
    if (entries.length === 0) throw new BacktestError(400, "EMPTY_BACKTEST_PARAMETER_GRID");
    configs = [base];
    for (const [rawField, rawValues] of entries) {
      if (!(BACKTEST_GRID_FIELDS as readonly string[]).includes(rawField) || !Array.isArray(rawValues) || rawValues.length === 0) {
        throw new BacktestError(400, "INVALID_BACKTEST_PARAMETER_GRID");
      }
      if (configs.length * rawValues.length > MAX_VARIANTS) {
        throw new BacktestError(400, "BACKTEST_VARIANT_LIMIT_EXCEEDED");
      }
      const field = rawField as BacktestGridField;
      configs = configs.flatMap((config) => rawValues.map((value) => setGridValue(config, field, value)));
    }
    configs = deduplicated(configs.map((config) => validateStrategyConfigV1(config)))
      .map((config, index) => validateStrategyConfigV1({
        ...config,
        name: `${base.name.slice(0, 108)} · G${index + 1}`
      }));
  }
  configs = deduplicated(configs);
  if (configs.length === 0 || configs.length > MAX_VARIANTS) throw new BacktestError(400, "INVALID_BACKTEST_CONFIG_BATCH");
  return { name, datasetId: input.datasetId.trim(), configs };
}

function safeId(value: string, pattern: RegExp, code: string): string {
  if (!pattern.test(value)) throw new BacktestError(400, code);
  return value;
}

function terminal(status: BacktestExperimentStatus): boolean {
  return status === "COMPLETED" || status === "PARTIAL" || status === "FAILED" || status === "CANCELLED";
}

function immediate(): Promise<void> {
  return new Promise((resolveImmediate) => setImmediate(resolveImmediate));
}

export class BacktestExperimentService {
  readonly rootDir: string;
  readonly #experiments = new Map<string, BacktestExperimentRecord>();
  #queue: Promise<void> = Promise.resolve();
  #writes: Promise<void> = Promise.resolve();
  #closing = false;

  constructor(readonly runner: BacktestRunner, rootDir: string, readonly now: () => number = Date.now) {
    this.rootDir = resolve(rootDir);
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !EXPERIMENT_ID.test(entry.name)) continue;
      try {
        const serialized = await readFile(join(this.rootDir, entry.name, "experiment.json"), "utf8");
        const experiment = JSON.parse(serialized) as BacktestExperimentRecord;
        if (experiment.schemaVersion !== 1 || experiment.experimentId !== entry.name || !Array.isArray(experiment.variants)) continue;
        if (!terminal(experiment.status)) {
          experiment.status = "FAILED";
          experiment.completedAtMs = this.now();
          experiment.error = "BACKTEST_EXPERIMENT_INTERRUPTED";
          for (const variant of experiment.variants) {
            if (variant.status === "RUNNING" || variant.status === "QUEUED") {
              variant.status = "FAILED";
              variant.completedAtMs = experiment.completedAtMs;
              variant.error = "BACKTEST_EXPERIMENT_INTERRUPTED";
            }
          }
          this.#recount(experiment);
          await this.#persistExperiment(experiment);
        }
        this.#experiments.set(experiment.experimentId, experiment);
      } catch {
        // A malformed artifact is not admitted into history.
      }
    }
  }

  list(limit = 50): BacktestExperimentRecord[] {
    return [...this.#experiments.values()]
      .sort((left, right) => right.createdAtMs - left.createdAtMs)
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map((experiment) => structuredClone(experiment));
  }

  get(experimentId: string): BacktestExperimentRecord | null {
    safeId(experimentId, EXPERIMENT_ID, "INVALID_BACKTEST_EXPERIMENT_ID");
    const experiment = this.#experiments.get(experimentId);
    return experiment ? structuredClone(experiment) : null;
  }

  async create(rawInput: unknown): Promise<BacktestExperimentRecord> {
    if (this.#closing) throw new BacktestError(503, "BACKTEST_SERVICE_CLOSING");
    const input = expandExperimentConfigs(object(rawInput, "INVALID_BACKTEST_EXPERIMENT_REQUEST"));
    const createdAtMs = this.now();
    const experimentId = `experiment-${randomUUID()}`;
    const experiment: BacktestExperimentRecord = {
      schemaVersion: 1,
      experimentId,
      name: input.name,
      datasetId: input.datasetId,
      dataset: null,
      status: "QUEUED",
      createdAtMs,
      startedAtMs: null,
      completedAtMs: null,
      variantCount: input.configs.length,
      completedVariantCount: 0,
      failedVariantCount: 0,
      cancelRequested: false,
      variants: input.configs.map((config, index) => ({
        variantId: `variant-${String(index + 1).padStart(3, "0")}`,
        ordinal: index + 1,
        status: "QUEUED",
        config,
        configSha256: configSha256(config),
        startedAtMs: null,
        completedAtMs: null,
        resultId: null,
        resultSha256: null,
        summary: null,
        error: null
      })),
      error: null
    };
    this.#experiments.set(experimentId, experiment);
    await this.#persistExperiment(experiment);
    this.#queue = this.#queue.then(() => this.#execute(experimentId), () => this.#execute(experimentId));
    return structuredClone(experiment);
  }

  async cancel(experimentId: string): Promise<BacktestExperimentRecord> {
    const experiment = this.#experiments.get(safeId(experimentId, EXPERIMENT_ID, "INVALID_BACKTEST_EXPERIMENT_ID"));
    if (!experiment) throw new BacktestError(404, "BACKTEST_EXPERIMENT_NOT_FOUND");
    if (terminal(experiment.status)) throw new BacktestError(409, "BACKTEST_EXPERIMENT_ALREADY_FINISHED");
    experiment.cancelRequested = true;
    await this.#persistExperiment(experiment);
    return structuredClone(experiment);
  }

  async result(experimentId: string, variantId: string): Promise<BacktestResult> {
    const safeExperimentId = safeId(experimentId, EXPERIMENT_ID, "INVALID_BACKTEST_EXPERIMENT_ID");
    const safeVariantId = safeId(variantId, VARIANT_ID, "INVALID_BACKTEST_VARIANT_ID");
    const experiment = this.#experiments.get(safeExperimentId);
    if (!experiment) throw new BacktestError(404, "BACKTEST_EXPERIMENT_NOT_FOUND");
    const variant = experiment.variants.find((candidate) => candidate.variantId === safeVariantId);
    if (!variant) throw new BacktestError(404, "BACKTEST_VARIANT_NOT_FOUND");
    if (variant.status !== "COMPLETED") throw new BacktestError(409, "BACKTEST_VARIANT_NOT_COMPLETE");
    const path = this.#variantResultPath(safeExperimentId, safeVariantId);
    const serialized = await readFile(path, "utf8");
    const result = JSON.parse(serialized) as BacktestResult;
    if (result.resultId !== variant.resultId || result.resultSha256 !== variant.resultSha256) {
      throw new BacktestError(409, "BACKTEST_RESULT_IDENTITY_MISMATCH");
    }
    return result;
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#queue;
    await this.#writes;
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  async #execute(experimentId: string): Promise<void> {
    const experiment = this.#experiments.get(experimentId);
    if (!experiment || terminal(experiment.status)) return;
    if (experiment.cancelRequested) {
      await this.#finishCancelled(experiment);
      return;
    }
    experiment.status = "RUNNING";
    experiment.startedAtMs = this.now();
    await this.#persistExperiment(experiment);
    try {
      const prepared = await this.runner.prepare(experiment.datasetId);
      for (const variant of experiment.variants) {
        if (experiment.cancelRequested || this.#closing) {
          await this.#finishCancelled(experiment);
          return;
        }
        variant.status = "RUNNING";
        variant.startedAtMs = this.now();
        await this.#persistExperiment(experiment);
        await immediate();
        try {
          const result = this.runner.runPrepared(prepared, variant.config);
          experiment.dataset = result.dataset;
          await this.#persistResult(experiment.experimentId, variant.variantId, result);
          variant.status = "COMPLETED";
          variant.completedAtMs = this.now();
          variant.resultId = result.resultId;
          variant.resultSha256 = result.resultSha256;
          variant.summary = result.summary;
        } catch (reason) {
          variant.status = "FAILED";
          variant.completedAtMs = this.now();
          variant.error = reason instanceof Error ? reason.message : String(reason);
        }
        this.#recount(experiment);
        await this.#persistExperiment(experiment);
      }
      experiment.status = experiment.failedVariantCount === 0 ? "COMPLETED" : "PARTIAL";
      experiment.completedAtMs = this.now();
      await this.#persistExperiment(experiment);
    } catch (reason) {
      experiment.status = "FAILED";
      experiment.completedAtMs = this.now();
      experiment.error = reason instanceof Error ? reason.message : String(reason);
      for (const variant of experiment.variants) {
        if (variant.status === "QUEUED" || variant.status === "RUNNING") {
          variant.status = "FAILED";
          variant.completedAtMs = experiment.completedAtMs;
          variant.error = experiment.error;
        }
      }
      this.#recount(experiment);
      await this.#persistExperiment(experiment);
    }
  }

  async #finishCancelled(experiment: BacktestExperimentRecord): Promise<void> {
    experiment.status = "CANCELLED";
    experiment.completedAtMs = this.now();
    for (const variant of experiment.variants) {
      if (variant.status === "QUEUED" || variant.status === "RUNNING") {
        variant.status = "CANCELLED";
        variant.completedAtMs = experiment.completedAtMs;
        variant.error = "BACKTEST_EXPERIMENT_CANCELLED";
      }
    }
    this.#recount(experiment);
    await this.#persistExperiment(experiment);
  }

  #recount(experiment: BacktestExperimentRecord): void {
    experiment.completedVariantCount = experiment.variants.filter(({ status }) => status === "COMPLETED").length;
    experiment.failedVariantCount = experiment.variants.filter(({ status }) => status === "FAILED").length;
  }

  #experimentDir(experimentId: string): string {
    const directory = resolve(this.rootDir, experimentId);
    if (!directory.startsWith(`${this.rootDir}${sep}`)) throw new BacktestError(400, "INVALID_BACKTEST_EXPERIMENT_PATH");
    return directory;
  }

  #variantResultPath(experimentId: string, variantId: string): string {
    return join(this.#experimentDir(experimentId), "variants", `${variantId}.json`);
  }

  async #atomicWrite(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }

  async #persistExperiment(experiment: BacktestExperimentRecord): Promise<void> {
    const path = join(this.#experimentDir(experiment.experimentId), "experiment.json");
    const snapshot = structuredClone(experiment);
    this.#writes = this.#writes.then(() => this.#atomicWrite(path, snapshot));
    await this.#writes;
  }

  async #persistResult(experimentId: string, variantId: string, result: BacktestResult): Promise<void> {
    await this.#atomicWrite(this.#variantResultPath(experimentId, variantId), result);
  }
}
