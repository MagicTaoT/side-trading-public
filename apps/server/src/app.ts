import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { LiveCoordinator } from "./live/coordinator.js";
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
}

const MAX_SOCKET_BUFFER_BYTES = 256 * 1024;

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const mode = options.mode ?? "REPLAY";
  const runtime = new S0Runtime(options.replayJsonl, options.queueCapacity, mode, options.cexProfile ?? "coinbase");
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
