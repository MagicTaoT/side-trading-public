import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { LiveCoordinator } from "./live/coordinator.js";
import { PaperEstimateBroker, PaperPolicyError } from "./paper/broker.js";
import type { PaperAction, PaperProvider, PaperSide } from "./paper/contracts.js";
import { JupiterQuoteProvider, ReplayQuoteProvider, ZeroExQuoteProvider } from "./paper/providers.js";
import { S0Runtime } from "./runtime.js";
import type { RuntimeMode } from "./contracts.js";

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

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const mode = options.mode ?? "REPLAY";
  const runtime = new S0Runtime(options.replayJsonl, options.queueCapacity, mode, options.cexProfile ?? "coinbase");
  const evidence = () => {
    const snapshot = runtime.snapshot();
    return { mode: snapshot.mode, signal: snapshot.signal, sources: snapshot.sources };
  };
  const providerOptions = (apiKey: string) => ({
    apiKey,
    ...(options.paper?.fetchImpl ? { fetchImpl: options.paper.fetchImpl } : {})
  });
  const paper = options.paperBroker ?? new PaperEstimateBroker({
    mode,
    evidence,
    ...(mode === "REPLAY"
      ? { zeroex: new ReplayQuoteProvider() }
      : options.paper?.zeroexApiKey
        ? { zeroex: new ZeroExQuoteProvider(providerOptions(options.paper.zeroexApiKey)) }
        : {}),
    ...(options.paper?.jupiterApiKey
      ? { jupiter: new JupiterQuoteProvider(providerOptions(options.paper.jupiterApiKey)) }
      : {})
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

  await app.register(websocket);

  app.get("/health/live", async () => ({ status: "ok" as const }));
  app.get("/health/ready", async () => ({ status: "ready" as const, mode: runtime.snapshot().mode }));
  app.get("/health/sources", async () => ({ mode: runtime.snapshot().mode, sources: runtime.snapshot().sources }));
  app.get("/api/state", async () => runtime.snapshot());

  app.post("/api/paper-orders/preview", { bodyLimit: 8 * 1024 }, async (request, reply) => {
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

  app.post("/api/paper-orders", { bodyLimit: 8 * 1024 }, async (request, reply) => {
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
    const order = paper.getOrder(request.params.id);
    return order ? reply.send({ order }) : reply.code(404).send({ error: { code: "PAPER_ORDER_NOT_FOUND" } });
  });

  app.post("/api/replay/start", async (_request, reply) => {
    if (mode === "LIVE") return reply.code(409).send({ accepted: false, reason: "replay_disabled_in_live_mode" });
    const snapshot = runtime.startReplay();
    return reply.send({ accepted: true, snapshot });
  });

  app.post("/api/replay/stop", async (_request, reply) => {
    if (mode === "LIVE") return reply.code(409).send({ accepted: false, reason: "replay_disabled_in_live_mode" });
    const snapshot = runtime.stopReplay();
    return reply.send({ accepted: true, snapshot });
  });

  app.get("/ws", { websocket: true }, (socket) => {
    const disconnect = runtime.connect((serialized) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
        socket.close(1013, "client too slow; reconnect for snapshot");
        return;
      }
      socket.send(serialized);
    });
    socket.on("close", disconnect);
    socket.on("error", disconnect);
  });

  app.addHook("onReady", async () => {
    live?.start();
    if (live) {
      tickTimer = setInterval(() => runtime.tick(Date.now()), 1_000);
      tickTimer.unref();
    }
  });
  app.addHook("onClose", async () => {
    if (tickTimer) clearInterval(tickTimer);
    live?.stop();
  });

  return app;
}
