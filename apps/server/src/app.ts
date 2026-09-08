import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type WebSocket from "ws";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  createDurationCompositeDataset,
  datasetArchivePath,
  deleteDatasetArchive,
  listEventDatasets,
  listDatasetArchives,
  type EventDatasetManifest,
  type EventRecorder
} from "@side/recorder-replay";
import { StrategyConfigError, type StrategyConfigV1, type StrategyObservation } from "@side/strategy-engine";
import { BacktestError, BacktestRunner } from "./backtest/runner.js";
import { BacktestExperimentService } from "./backtest/experiments.js";
import { LiveCoordinator } from "./live/coordinator.js";
import { PaperEstimateBroker, PaperPolicyError } from "./paper/broker.js";
import type { PaperAction, PaperProvider, PaperSide } from "./paper/contracts.js";
import { MemoryDecisionJournal, type DecisionJournal } from "./paper/journal.js";
import { MarkoutWorker } from "./paper/markout.js";
import { PaperPriceBoard } from "./paper/price-board.js";
import { JupiterQuoteProvider, ReplayQuoteProvider, ZeroExQuoteProvider } from "./paper/providers.js";
import { S0Runtime } from "./runtime.js";
import type { RuntimeMode } from "./contracts.js";
import { StrategyCoordinator, StrategyPolicyError, strategyObservation } from "./strategy/coordinator.js";
import {
  MemoryStrategyJournal,
  StrategyJournalConflictError,
  type StrategyJournal
} from "./strategy/journal.js";

export interface CreateAppOptions {
  replayJsonl: string;
  queueCapacity?: number;
  logger?: boolean;
  mode?: RuntimeMode;
  cexProfile?: "coinbase" | "binance" | "unavailable";
  live?: {
    bitqueryToken: string;
    coinbasePerpProductId: string;
  };
  paper?: {
    zeroexApiKey?: string;
    jupiterApiKey?: string;
    fetchImpl?: typeof fetch;
  };
  paperBroker?: PaperEstimateBroker;
  journal?: DecisionJournal;
  strategyJournal?: StrategyJournal;
  eventRecorder?: EventRecorder;
  recordingRootDir?: string;
  recordingArchiveRootDir?: string;
  backtestResultRootDir?: string;
  adminPasscode?: string;
}

const MAX_SOCKET_BUFFER_BYTES = 256 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PaperPolicyError(400, "INVALID_REQUEST_BODY");
  }
  return value as Record<string, unknown>;
}

function requestIdempotencyKey(headers: Record<string, unknown>, body: Record<string, unknown>): string {
  const header = headers["idempotency-key"];
  const headerValue = typeof header === "string" ? header : null;
  const bodyValue = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
  if (headerValue && bodyValue && headerValue !== bodyValue) throw new PaperPolicyError(400, "IDEMPOTENCY_KEY_MISMATCH");
  const value = headerValue ?? bodyValue;
  if (!value) throw new PaperPolicyError(400, "IDEMPOTENCY_KEY_REQUIRED");
  return value;
}

function paperError(reply: { code(statusCode: number): { send(value: unknown): unknown } }, reason: unknown): unknown {
  if (reason instanceof PaperPolicyError) {
    return reply.code(reason.statusCode).send({ error: { code: reason.code } });
  }
  return reply.code(500).send({ error: { code: "PAPER_BROKER_ERROR" } });
}

function strategyError(reply: { code(statusCode: number): { send(value: unknown): unknown } }, reason: unknown): unknown {
  if (reason instanceof PaperPolicyError) {
    return reply.code(reason.statusCode).send({ error: { code: reason.code } });
  }
  if (reason instanceof StrategyPolicyError) {
    return reply.code(reason.statusCode).send({ error: { code: reason.code } });
  }
  if (reason instanceof StrategyConfigError) {
    return reply.code(400).send({ error: { code: reason.code } });
  }
  if (reason instanceof StrategyJournalConflictError) {
    const statusCode = reason.code === "CONFIG_REVISION_NOT_FOUND" || reason.code === "RUN_NOT_FOUND"
      ? 404
      : reason.code === "INVALID_STRATEGY_RECORD" || reason.code === "INVALID_STRATEGY_EVENT"
        ? 400
        : 409;
    return reply.code(statusCode).send({ error: { code: reason.code } });
  }
  return reply.code(500).send({ error: { code: "STRATEGY_ERROR" } });
}

function backtestError(reply: { code(statusCode: number): { send(value: unknown): unknown } }, reason: unknown): unknown {
  if (reason instanceof PaperPolicyError) {
    return reply.code(reason.statusCode).send({ error: { code: reason.code } });
  }
  if (reason instanceof BacktestError) {
    return reply.code(reason.statusCode).send({ error: { code: reason.code } });
  }
  if (reason instanceof StrategyConfigError) {
    return reply.code(400).send({ error: { code: reason.code } });
  }
  return reply.code(500).send({ error: { code: "BACKTEST_ERROR" } });
}

function boundedLimit(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(1, parsed)) : fallback;
}

function optionalStrategyId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const strategyId = value.trim();
  if (!strategyId) throw new StrategyPolicyError(400, "INVALID_STRATEGY_ID");
  return strategyId;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const adminPasscode = options.adminPasscode?.trim() || null;
  if (adminPasscode !== null && adminPasscode.length < 24) throw new Error("SIDE_ADMIN_PASSCODE_TOO_SHORT");
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (adminPasscode === null) return;
    const candidate = request.headers["x-side-admin-passcode"];
    const candidateHash = createHash("sha256").update(typeof candidate === "string" ? candidate : "").digest();
    const expectedHash = createHash("sha256").update(adminPasscode).digest();
    if (!timingSafeEqual(candidateHash, expectedHash)) {
      return reply.code(401).send({ error: { code: "ADMIN_PASSCODE_REQUIRED" } });
    }
  };
  const adminRoute = { preHandler: requireAdmin };
  const mode = options.mode ?? "REPLAY";
  const runtime = new S0Runtime(
    options.replayJsonl,
    options.queueCapacity,
    mode,
    options.cexProfile ?? "coinbase",
    options.eventRecorder
  );
  const strategy = new StrategyCoordinator(options.strategyJournal ?? new MemoryStrategyJournal());
  const backtests = options.recordingRootDir ? new BacktestRunner(options.recordingRootDir) : null;
  const backtestExperiments = backtests && options.backtestResultRootDir
    ? new BacktestExperimentService(backtests, options.backtestResultRootDir)
    : null;
  await strategy.initialize();
  await backtestExperiments?.initialize();
  let lastReplayObservation: StrategyObservation | null = null;
  let closing = false;
  const observeLiveStrategy = async (atMs = Date.now()) => {
    const signal = runtime.snapshot().signal;
    const observation = strategyObservation(signal, runtime.paperDryReference(atMs), atMs);
    try {
      options.eventRecorder?.recordObservation({
        schemaVersion: 1,
        ...observation,
        signalModelVersion: signal.modelVersion,
        asOfIngestSeq: signal.asOfIngestSeq,
        freshJuryCount: signal.verdict.freshJuryCount,
        coverageState: signal.verdict.dataState
      });
    } catch (reason) {
      app.log.error({ err: reason }, "Strategy observation recording failed");
    }
    await strategy.evaluate(observation);
  };
  const evidence = () => {
    const snapshot = runtime.snapshot();
    return { mode: snapshot.mode, signal: snapshot.signal, sources: snapshot.sources };
  };
  const providerOptions = (apiKey: string) => ({
    apiKey,
    ...(options.paper?.fetchImpl ? { fetchImpl: options.paper.fetchImpl } : {})
  });
  const journal = options.journal ?? options.paperBroker?.journal ?? new MemoryDecisionJournal();
  const paper = options.paperBroker ?? new PaperEstimateBroker({
    mode,
    evidence,
    journal,
    reference: (evaluatedAtMs) => runtime.bitqueryReference(evaluatedAtMs),
    ...(mode === "REPLAY"
      ? { zeroex: new ReplayQuoteProvider() }
      : options.paper?.zeroexApiKey
        ? { zeroex: new ZeroExQuoteProvider(providerOptions(options.paper.zeroexApiKey)) }
        : {}),
    ...(options.paper?.jupiterApiKey
      ? { jupiter: new JupiterQuoteProvider(providerOptions(options.paper.jupiterApiKey)) }
      : {})
  });
  await paper.journal.initialize();
  const paperPrices = new PaperPriceBoard({
    mode,
    broker: paper,
    dryReference: (evaluatedAtMs) => runtime.paperDryReference(evaluatedAtMs)
  });
  const markoutWorker = new MarkoutWorker({
    journal: paper.journal,
    reference: paper.reference,
    onComplete: (markout) => runtime.publishMarkout(markout),
    onError: (reason) => app.log.error({ err: reason }, "Paper markout worker failed")
  });
  const live = mode === "LIVE" && options.live
    ? new LiveCoordinator({
        ...options.live,
        sink: {
          emit: (draft) => {
            try {
              runtime.ingestLive(draft);
            } catch (reason) {
              app.log.error({ err: reason }, "Rejected live market event");
            }
          },
          log: (message, detail) => app.log.info({ detail }, message)
        }
      })
    : null;
  if (mode === "LIVE" && !live) throw new Error("LIVE mode requires live source configuration");
  let tickTimer: NodeJS.Timeout | null = null;
  let recorderFlushTimer: NodeJS.Timeout | null = null;
  let recorderFlushPromise: Promise<void> | null = null;
  let websocketsEnabled = true;
  const dashboardSockets = new Map<WebSocket, () => void>();

  const websocketStatus = () => ({
    enabled: websocketsEnabled,
    mode,
    dashboardClients: dashboardSockets.size,
    liveSourcesEnabled: live !== null && websocketsEnabled
  });
  const removeDashboardSocket = (socket: WebSocket) => {
    const disconnect = dashboardSockets.get(socket);
    if (!disconnect) return;
    dashboardSockets.delete(socket);
    disconnect();
  };

  await app.register(websocket);

  app.get("/health/live", async () => ({ status: "ok" as const }));
  app.get("/health/ready", async () => ({
    status: "ready" as const,
    mode: runtime.snapshot().mode,
    paperPersistence: paper.journal.persistence,
    strategyPersistence: strategy.journal.persistence
  }));
  app.get("/health/sources", async () => ({ mode: runtime.snapshot().mode, sources: runtime.snapshot().sources }));
  app.get("/api/state", async () => runtime.snapshot());
  app.get("/api/admin/status", async () => ({ required: adminPasscode !== null }));
  app.post("/api/admin/verify", adminRoute, async () => ({ accepted: true }));
  app.get("/api/recording/status", async () => options.eventRecorder?.status() ?? { enabled: false as const });
  app.get("/api/recording/archives", async () => ({
    archives: options.recordingArchiveRootDir ? await listDatasetArchives(options.recordingArchiveRootDir) : []
  }));
  app.get<{ Params: { datasetId: string } }>("/api/recording/archives/:datasetId/download", adminRoute, async (request, reply) => {
    if (!options.recordingArchiveRootDir) {
      return reply.code(503).send({ error: { code: "RECORDING_ARCHIVE_STORAGE_NOT_CONFIGURED" } });
    }
    try {
      const target = datasetArchivePath(options.recordingArchiveRootDir, request.params.datasetId);
      const archiveStat = await stat(target);
      return reply
        .header("content-type", "application/gzip")
        .header("content-length", String(archiveStat.size))
        .header("content-disposition", `attachment; filename="${request.params.datasetId}.tar.gz"`)
        .send(createReadStream(target));
    } catch {
      return reply.code(404).send({ error: { code: "RECORDING_ARCHIVE_NOT_FOUND" } });
    }
  });
  app.delete<{ Params: { datasetId: string }; Headers: { "x-side-confirm-delete"?: string } }>(
    "/api/recording/archives/:datasetId",
    adminRoute,
    async (request, reply) => {
      const datasetId = request.params.datasetId;
      if (!options.recordingArchiveRootDir || !options.recordingRootDir) {
        return reply.code(503).send({ error: { code: "RECORDING_ARCHIVE_STORAGE_NOT_CONFIGURED" } });
      }
      if (request.headers["x-side-confirm-delete"] !== datasetId) {
        return reply.code(400).send({ error: { code: "RECORDING_DELETE_CONFIRMATION_REQUIRED" } });
      }
      if (options.eventRecorder?.status().datasetId === datasetId) {
        return reply.code(409).send({ error: { code: "ACTIVE_RECORDING_CANNOT_BE_DELETED" } });
      }
      try {
        const dependent = (await listEventDatasets(options.recordingRootDir)).find(({ segments }) =>
          segments?.some((segment) => segment.datasetId === datasetId)
        );
        if (dependent) {
          return reply.code(409).send({ error: { code: "RECORDING_REFERENCED_BY_COMPOSITE", dependentDatasetId: dependent.datasetId } });
        }
        const recordingRoot = resolve(options.recordingRootDir);
        const datasetRoot = resolve(recordingRoot, datasetId);
        if (!datasetRoot.startsWith(`${recordingRoot}${sep}`)) throw new Error("INVALID_DATASET_PATH");
        const manifest = JSON.parse(await readFile(resolve(datasetRoot, "manifest.json"), "utf8")) as EventDatasetManifest;
        if (manifest.datasetId !== datasetId || manifest.status !== "COMPLETE") {
          return reply.code(409).send({ error: { code: "ONLY_COMPLETE_RECORDING_CAN_BE_DELETED" } });
        }
        const archiveDeleted = await deleteDatasetArchive(options.recordingArchiveRootDir, datasetId);
        if (!archiveDeleted) return reply.code(404).send({ error: { code: "RECORDING_ARCHIVE_NOT_FOUND" } });
        await rm(datasetRoot, { recursive: true });
        return reply.send({ deleted: true, datasetId });
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code === "ENOENT") {
          return reply.code(404).send({ error: { code: "RECORDING_ARCHIVE_NOT_FOUND" } });
        }
        throw reason;
      }
    }
  );
  app.get("/api/backtest-datasets", async (_request, reply) => {
    if (!backtests) return reply.send({ datasets: [] });
    try {
      return reply.send({ datasets: await backtests.listDatasets() });
    } catch (reason) {
      return backtestError(reply, reason);
    }
  });
  app.post<{ Body: unknown }>("/api/backtest-datasets/composites", { bodyLimit: 8 * 1024, ...adminRoute }, async (request, reply) => {
    if (!options.recordingRootDir) return reply.code(503).send({ error: { code: "BACKTEST_STORAGE_NOT_CONFIGURED" } });
    try {
      const body = object(request.body);
      if (body.hours !== 3 && body.hours !== 6 && body.hours !== 12 && body.hours !== 24 && body.hours !== 72) {
        throw new BacktestError(400, "INVALID_COMPOSITE_DURATION");
      }
      const manifest = await createDurationCompositeDataset(options.recordingRootDir, { hours: body.hours });
      return reply.code(201).send({ dataset: manifest });
    } catch (reason) {
      if (reason instanceof BacktestError) return backtestError(reply, reason);
      const code = reason instanceof Error ? reason.message : "COMPOSITE_DATASET_ERROR";
      return backtestError(reply, new BacktestError(409, code));
    }
  });
  app.post<{ Body: unknown }>("/api/backtests", adminRoute, async (request, reply) => {
    if (!backtests) return reply.code(503).send({ error: { code: "BACKTEST_STORAGE_NOT_CONFIGURED" } });
    try {
      const body = object(request.body);
      if (typeof body.datasetId !== "string" || body.datasetId.trim().length === 0 || body.config === undefined) {
        throw new BacktestError(400, "INVALID_BACKTEST_REQUEST");
      }
      return reply.send({ result: await backtests.run(body.datasetId.trim(), body.config) });
    } catch (reason) {
      return backtestError(reply, reason);
    }
  });
  app.get<{ Querystring: { limit?: string } }>("/api/backtest-experiments", async (request, reply) => {
    if (!backtestExperiments) return reply.send({ experiments: [] });
    return reply.send({ experiments: backtestExperiments.list(boundedLimit(request.query.limit, 30, 100)) });
  });
  app.post<{ Body: unknown }>("/api/backtest-experiments", adminRoute, async (request, reply) => {
    if (!backtestExperiments) {
      return reply.code(503).send({ error: { code: "BACKTEST_STORAGE_NOT_CONFIGURED" } });
    }
    try {
      return reply.code(202).send({ experiment: await backtestExperiments.create(request.body) });
    } catch (reason) {
      return backtestError(reply, reason);
    }
  });
  app.get<{ Params: { experimentId: string } }>("/api/backtest-experiments/:experimentId", async (request, reply) => {
    if (!backtestExperiments) {
      return reply.code(503).send({ error: { code: "BACKTEST_STORAGE_NOT_CONFIGURED" } });
    }
    try {
      const experiment = backtestExperiments.get(request.params.experimentId);
      return experiment
        ? reply.send({ experiment })
        : reply.code(404).send({ error: { code: "BACKTEST_EXPERIMENT_NOT_FOUND" } });
    } catch (reason) {
      return backtestError(reply, reason);
    }
  });
  app.post<{ Params: { experimentId: string } }>("/api/backtest-experiments/:experimentId/cancel", adminRoute, async (request, reply) => {
    if (!backtestExperiments) {
      return reply.code(503).send({ error: { code: "BACKTEST_STORAGE_NOT_CONFIGURED" } });
    }
    try {
      return reply.send({ experiment: await backtestExperiments.cancel(request.params.experimentId) });
    } catch (reason) {
      return backtestError(reply, reason);
    }
  });
  app.get<{ Params: { experimentId: string; variantId: string } }>(
    "/api/backtest-experiments/:experimentId/variants/:variantId",
    async (request, reply) => {
      if (!backtestExperiments) {
        return reply.code(503).send({ error: { code: "BACKTEST_STORAGE_NOT_CONFIGURED" } });
      }
      try {
        return reply.send({
          result: await backtestExperiments.result(request.params.experimentId, request.params.variantId)
        });
      } catch (reason) {
        return backtestError(reply, reason);
      }
    }
  );
  app.get("/api/websockets/status", async () => websocketStatus());
  app.post("/api/websockets/disconnect", adminRoute, async () => {
    const wasEnabled = websocketsEnabled;
    websocketsEnabled = false;
    if (wasEnabled) live?.stop();
    const sockets = [...dashboardSockets.keys()];
    for (const socket of sockets) {
      removeDashboardSocket(socket);
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        socket.close(4001, "all websockets disconnected by operator");
      }
    }
    return {
      accepted: true,
      disconnectedDashboardClients: sockets.length,
      ...websocketStatus()
    };
  });
  app.post("/api/websockets/reconnect", adminRoute, async () => {
    const wasEnabled = websocketsEnabled;
    websocketsEnabled = true;
    if (!wasEnabled) live?.start();
    return { accepted: true, ...websocketStatus() };
  });
  app.get("/api/paper-prices", async (_request, reply) => {
    try {
      return reply.send({ prices: await paperPrices.current() });
    } catch (reason) {
      return paperError(reply, reason);
    }
  });

  app.post("/api/paper-orders/preview", { bodyLimit: 8 * 1024, ...adminRoute }, async (request, reply) => {
    try {
      const body = object(request.body);
      const side = body.side;
      const provider = body.provider ?? "zeroex";
      const primaryFailureId = body.primaryFailureId ?? null;
      if (side !== "BUY" && side !== "SELL") throw new PaperPolicyError(400, "INVALID_PAPER_SIDE");
      if (provider !== "zeroex" && provider !== "jupiter") throw new PaperPolicyError(400, "INVALID_PAPER_PROVIDER");
      if (primaryFailureId !== null && typeof primaryFailureId !== "string") throw new PaperPolicyError(400, "INVALID_PRIMARY_FAILURE_ID");
      const preview = await paper.preview({
        side: side as PaperSide,
        provider: provider as PaperProvider,
        idempotencyKey: requestIdempotencyKey(request.headers, body),
        primaryFailureId
      });
      return reply.send({ preview });
    } catch (reason) {
      return paperError(reply, reason);
    }
  });

  app.post("/api/paper-orders", { bodyLimit: 8 * 1024, ...adminRoute }, async (request, reply) => {
    try {
      const body = object(request.body);
      const action = body.action;
      const previewId = body.previewId ?? null;
      const provider = body.provider ?? null;
      if (action !== "BUY" && action !== "SELL" && action !== "WAIT") throw new PaperPolicyError(400, "INVALID_PAPER_ACTION");
      if (previewId !== null && typeof previewId !== "string") throw new PaperPolicyError(400, "INVALID_PREVIEW_ID");
      if (provider !== null && provider !== "zeroex" && provider !== "jupiter") throw new PaperPolicyError(400, "INVALID_PAPER_PROVIDER");
      const order = await paper.record({
        action: action as PaperAction,
        idempotencyKey: requestIdempotencyKey(request.headers, body),
        previewId,
        provider: provider as PaperProvider | null
      });
      return reply.code(201).send({ order });
    } catch (reason) {
      return paperError(reply, reason);
    }
  });

  app.get<{ Params: { id: string } }>("/api/paper-orders/:id", async (request, reply) => {
    const order = await paper.getOrder(request.params.id);
    return order ? reply.send({ order }) : reply.code(404).send({ error: { code: "PAPER_ORDER_NOT_FOUND" } });
  });

  app.delete<{ Params: { id: string } }>("/api/paper-orders/:id", adminRoute, async (request, reply) => {
    try {
      const deleted = await paper.deleteOrder(request.params.id);
      return deleted
        ? reply.send({ deleted: true, orderId: request.params.id })
        : reply.code(404).send({ error: { code: "PAPER_ORDER_NOT_FOUND" } });
    } catch (reason) {
      return paperError(reply, reason);
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/paper-orders", async (request) => {
    const parsed = Number.parseInt(request.query.limit ?? "50", 10);
    const limit = Number.isSafeInteger(parsed) ? Math.min(100, Math.max(1, parsed)) : 50;
    return { orders: await paper.listOrders(limit) };
  });

  app.get("/api/shadow-performance", async () => ({ performance: await paper.performance() }));

  app.post("/api/paper-strategy-configs", { bodyLimit: 16 * 1024, ...adminRoute }, async (request, reply) => {
    try {
      const body = object(request.body);
      const strategyId = body.strategyId ?? null;
      if (strategyId !== null && typeof strategyId !== "string") {
        throw new StrategyPolicyError(400, "INVALID_STRATEGY_ID");
      }
      const config = object(body.config) as unknown as StrategyConfigV1;
      return reply.code(201).send({ config: await strategy.saveConfig(config, strategyId) });
    } catch (reason) {
      return strategyError(reply, reason);
    }
  });

  app.get<{ Querystring: { limit?: string; strategyId?: string } }>("/api/paper-strategy-configs", async (request, reply) => {
    try {
      return reply.send({
        configs: await strategy.listConfigs(
          boundedLimit(request.query.limit, 50, 200),
          optionalStrategyId(request.query.strategyId)
        )
      });
    } catch (reason) {
      return strategyError(reply, reason);
    }
  });

  app.get("/api/paper-strategy-runs/active", async () => ({ run: strategy.activeRun() }));

  app.post("/api/paper-strategy-runs", { bodyLimit: 8 * 1024, ...adminRoute }, async (request, reply) => {
    try {
      const body = object(request.body);
      if (typeof body.strategyId !== "string") throw new StrategyPolicyError(400, "INVALID_STRATEGY_ID");
      const revision = body.revision === undefined ? undefined : Number(body.revision);
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
        throw new StrategyPolicyError(400, "INVALID_STRATEGY_REVISION");
      }
      const run = await strategy.start(body.strategyId, revision);
      return reply.code(201).send({ run });
    } catch (reason) {
      return strategyError(reply, reason);
    }
  });

  app.post<{ Params: { id: string } }>("/api/paper-strategy-runs/:id/stop", adminRoute, async (request, reply) => {
    try {
      const active = strategy.activeRun();
      const atMs = mode === "REPLAY"
        ? active?.snapshot.evaluatedAtMs ?? active?.startedAtMs ?? 0
        : Date.now();
      const signal = runtime.snapshot().signal;
      const referenceAtMs = mode === "REPLAY" ? signal.evaluatedAtMs : atMs;
      const observation = mode === "REPLAY" && lastReplayObservation
        ? { ...lastReplayObservation, atMs }
        : strategyObservation(signal, runtime.paperDryReference(referenceAtMs), atMs);
      return reply.send({ run: await strategy.stop(request.params.id, observation) });
    } catch (reason) {
      return strategyError(reply, reason);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { eventLimit?: string } }>("/api/paper-strategy-runs/:id", async (request, reply) => {
    const detail = await strategy.runDetail(request.params.id, boundedLimit(request.query.eventLimit, 500, 999));
    return detail ? reply.send(detail) : reply.code(404).send({ error: { code: "STRATEGY_RUN_NOT_FOUND" } });
  });

  app.get<{ Querystring: { limit?: string; strategyId?: string } }>("/api/paper-strategy-runs", async (request, reply) => {
    try {
      return reply.send({
        runs: await strategy.listRuns(
          boundedLimit(request.query.limit, 20, 100),
          optionalStrategyId(request.query.strategyId)
        )
      });
    } catch (reason) {
      return strategyError(reply, reason);
    }
  });

  app.post("/api/replay/start", adminRoute, async (_request, reply) => {
    if (mode === "LIVE") return reply.code(409).send({ accepted: false, reason: "replay_disabled_in_live_mode" });
    const active = strategy.activeRun();
    if (active && active.snapshot.evaluatedAtMs !== active.startedAtMs) {
      return reply.code(409).send({ accepted: false, reason: "active_strategy_already_consumed_replay" });
    }
    try {
      const observations: ReturnType<typeof strategyObservation>[] = [];
      lastReplayObservation = null;
      const snapshot = runtime.startReplay(({ elapsedMs, referenceAtMs }) => {
        if (!active) return;
        const observation = strategyObservation(
          runtime.snapshot().signal,
          runtime.paperDryReference(referenceAtMs),
          active.startedAtMs + elapsedMs
        );
        lastReplayObservation = observation;
        observations.push(observation);
      });
      for (const observation of observations) await strategy.evaluate(observation);
      return reply.send({ accepted: true, snapshot });
    } catch (reason) {
      return strategyError(reply, reason);
    }
  });

  app.post("/api/replay/stop", adminRoute, async (_request, reply) => {
    if (mode === "LIVE") return reply.code(409).send({ accepted: false, reason: "replay_disabled_in_live_mode" });
    const snapshot = runtime.stopReplay();
    return reply.send({ accepted: true, snapshot });
  });

  app.get("/ws", { websocket: true }, (socket) => {
    if (!websocketsEnabled) {
      socket.close(4001, "websockets paused by operator");
      return;
    }
    const disconnect = runtime.connect((serialized) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
        socket.close(1013, "client too slow; reconnect for snapshot");
        return;
      }
      socket.send(serialized);
    });
    dashboardSockets.set(socket, disconnect);
    socket.on("close", () => removeDashboardSocket(socket));
    socket.on("error", () => removeDashboardSocket(socket));
  });

  app.addHook("onReady", async () => {
    live?.start();
    markoutWorker.start();
    if (live) {
      let flushingRecorder = false;
      recorderFlushTimer = setInterval(() => {
        if (flushingRecorder || recorderFlushPromise || closing || !options.eventRecorder) return;
        flushingRecorder = true;
        recorderFlushPromise = options.eventRecorder.flush()
          .catch((reason) => app.log.error({ err: reason }, "Recording manifest checkpoint failed"))
          .finally(() => {
            flushingRecorder = false;
            recorderFlushPromise = null;
          });
      }, 60_000);
      recorderFlushTimer.unref();
      tickTimer = setInterval(() => {
        if (closing) return;
        const atMs = Date.now();
        runtime.tick(atMs);
        void observeLiveStrategy(atMs).catch((reason) => app.log.error({ err: reason }, "Strategy evaluation failed"));
      }, 1_000);
      tickTimer.unref();
    }
  });
  app.addHook("onClose", async () => {
    closing = true;
    if (tickTimer) clearInterval(tickTimer);
    if (recorderFlushTimer) clearInterval(recorderFlushTimer);
    markoutWorker.stop();
    live?.stop();
    for (const socket of dashboardSockets.keys()) removeDashboardSocket(socket);
    if (recorderFlushPromise) await recorderFlushPromise;
    await Promise.all([
      backtestExperiments?.close() ?? Promise.resolve(),
      strategy.close(),
      paper.journal.close(),
      options.eventRecorder?.close() ?? Promise.resolve()
    ]);
  });

  return app;
}
