import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const fixturePath = fileURLToPath(
  new URL("../../../packages/recorder-replay/test/fixtures/golden/spot-led.jsonl", import.meta.url)
);
const replayJsonl = readFileSync(fixturePath, "utf8");
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("S0 runtime HTTP surface", () => {
  it("reports process, readiness and empty source health before replay", async () => {
    const app = await createApp({ replayJsonl });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/health/live" })).json()).toEqual({ status: "ok" });
    expect((await app.inject({ method: "GET", url: "/health/ready" })).json()).toEqual({
      status: "ready",
      mode: "REPLAY",
      paperPersistence: "memory-side-011-test",
      strategyPersistence: "memory-strategy-v1"
    });
    expect((await app.inject({ method: "GET", url: "/health/sources" })).json()).toEqual({
      mode: "REPLAY",
      sources: []
    });
  });

  it("disconnects every dashboard WebSocket and allows an explicit reconnect", async () => {
    const app = await createApp({ replayJsonl });
    apps.push(app);
    await app.ready();

    const firstSocket = await app.injectWS("/ws");
    expect((await app.inject({ method: "GET", url: "/api/websockets/status" })).json()).toEqual({
      enabled: true,
      mode: "REPLAY",
      dashboardClients: 1,
      liveSourcesEnabled: false
    });

    const firstClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      firstSocket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const disconnected = await app.inject({ method: "POST", url: "/api/websockets/disconnect" });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toEqual({
      accepted: true,
      disconnectedDashboardClients: 1,
      enabled: false,
      mode: "REPLAY",
      dashboardClients: 0,
      liveSourcesEnabled: false
    });
    await expect(firstClosed).resolves.toEqual({
      code: 4001,
      reason: "all websockets disconnected by operator"
    });

    const reconnected = await app.inject({ method: "POST", url: "/api/websockets/reconnect" });
    expect(reconnected.json()).toEqual({
      accepted: true,
      enabled: true,
      mode: "REPLAY",
      dashboardClients: 0,
      liveSourcesEnabled: false
    });
    const secondSocket = await app.injectWS("/ws");
    expect((await app.inject({ method: "GET", url: "/api/websockets/status" })).json().dashboardClients).toBe(1);
    secondSocket.close();
  });

  it("replays canonical events into state and source health", async () => {
    const app = await createApp({ replayJsonl });
    apps.push(app);

    const start = await app.inject({ method: "POST", url: "/api/replay/start" });
    expect(start.statusCode).toBe(200);
    expect(start.json().snapshot).toMatchObject({
      mode: "REPLAY",
      replayStatus: "completed",
      eventsIngested: 3,
      lastIngestSeq: "102",
      paperPreview: {
        mode: "REPLAY",
        provider: "zeroex",
        pair: "SOL-USDC",
        recordable: false
      },
      signal: {
        modelVersion: "s0-v1",
        verdict: {
          verdict: "INSUFFICIENT_DATA",
          dataState: "INSUFFICIENT_DATA",
          freshJuryCount: 2
        }
      }
    });

    const sources = (await app.inject({ method: "GET", url: "/health/sources" })).json().sources;
    expect(sources.map(({ provider }: { provider: string }) => provider)).toEqual(["bitquery", "coinbase"]);
    expect(sources.every(({ replay }: { replay: boolean }) => replay)).toBe(true);

    const state = (await app.inject({ method: "GET", url: "/api/state" })).json();
    expect(state.recentUiEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: "coinbase:trade:100",
          sourceProvider: "coinbase",
          instrumentId: "SOL-USD",
          buyNotional: "1762.00",
          minPx: "176.20",
          maxPx: "176.20"
        }),
        expect.objectContaining({
          eventId: "bitquery:swap:102",
          sourceProvider: "bitquery",
          instrumentId: "WSOL-USDC",
          buyNotional: "10000.00"
        })
      ])
    );

    const stop = await app.inject({ method: "POST", url: "/api/replay/stop" });
    expect(stop.json().snapshot.replayStatus).toBe("stopped");
    expect(
      stop.json().snapshot.sources.every(
        ({ connection, quality }: { connection: string; quality: string }) => connection === "closed" && quality === "stale"
      )
    ).toBe(true);
  });

  it("previews and records a replay paper order through idempotent HTTP routes", async () => {
    const app = await createApp({ replayJsonl });
    apps.push(app);
    await app.inject({ method: "POST", url: "/api/replay/start" });

    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/paper-orders/preview",
      headers: { "idempotency-key": "http-preview-001" },
      payload: { side: "SELL", provider: "zeroex" }
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json().preview;
    expect(preview).toMatchObject({
      mode: "REPLAY",
      status: "READY",
      side: "SELL",
      provider: "zeroex",
      inputAmountSOL: "56.710000000",
      estimatedOutputUSDC: "9950.000000"
    });

    const orderResponse = await app.inject({
      method: "POST",
      url: "/api/paper-orders",
      payload: {
        action: "SELL",
        provider: "zeroex",
        previewId: preview.previewId,
        idempotencyKey: "http-record-0001"
      }
    });
    expect(orderResponse.statusCode).toBe(201);
    const order = orderResponse.json().order;
    expect(order).toMatchObject({
      executionMode: "paper",
      persistence: "memory-side-011-test",
      action: "SELL",
      previewId: preview.previewId,
      markout: { status: "PENDING", horizonMs: 300_000 }
    });
    expect((await app.inject({ method: "GET", url: `/api/paper-orders/${encodeURIComponent(order.orderId)}` })).json().order)
      .toEqual(order);
    expect((await app.inject({ method: "GET", url: "/api/paper-orders" })).json().orders).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/shadow-performance" })).json().performance)
      .toMatchObject({ pendingCount: 1, sellCount: 1, scoredCount: 0 });

    const deleted = await app.inject({ method: "DELETE", url: `/api/paper-orders/${encodeURIComponent(order.orderId)}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true, orderId: order.orderId });
    expect((await app.inject({ method: "GET", url: `/api/paper-orders/${encodeURIComponent(order.orderId)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/paper-orders" })).json().orders).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/shadow-performance" })).json().performance)
      .toMatchObject({ pendingCount: 0, sellCount: 0, scoredCount: 0 });
    expect((await app.inject({ method: "DELETE", url: `/api/paper-orders/${encodeURIComponent(order.orderId)}` })).statusCode).toBe(404);

    const recreated = await app.inject({
      method: "POST",
      url: "/api/paper-orders",
      payload: {
        action: "SELL",
        provider: "zeroex",
        previewId: preview.previewId,
        idempotencyKey: "http-record-0001"
      }
    });
    expect(recreated.statusCode).toBe(201);
    expect(recreated.json().order.orderId).not.toBe(order.orderId);
  });

  it("serves a shared five-second display-only BUY/SELL price board", async () => {
    const app = await createApp({ replayJsonl });
    apps.push(app);
    await app.inject({ method: "POST", url: "/api/replay/start" });

    const response = await app.inject({ method: "GET", url: "/api/paper-prices" });
    expect(response.statusCode).toBe(200);
    expect(response.json().prices).toMatchObject({
      mode: "REPLAY",
      pair: "SOL-USDC",
      targetNotionalQuote: "10000",
      refreshIntervalMs: 5000,
      buy: {
        status: "LIVE",
        priceQuotePerSol: "176.335743",
        source: "replay-estimate",
        recordable: false
      },
      sell: {
        status: "LIVE",
        priceQuotePerSol: "175.454065",
        source: "replay-estimate",
        recordable: false
      }
    });
  });

  it("versions dry-run strategy configs and records run history", async () => {
    const app = await createApp({ replayJsonl });
    apps.push(app);
    const config = {
      schemaVersion: 1,
      name: "HTTP edge persistence",
      pair: "SOL-USDC",
      entry: { minEdgeBps: "3", holdSec: 5, initialSizeQuote: "1000" },
      scaling: {
        enabled: true,
        intervalSec: 5,
        intervalMultiplier: "1",
        sizeQuote: "500",
        sizeMultiplier: "1",
        maxEntries: 3,
        maxTotalSizeQuote: "2000"
      },
      exit: { takeProfitBps: "12", linearDecayToZero: true, stopLossBps: "15", forceExitSec: 180 },
      cooldownSec: 15
    };

    const created = await app.inject({ method: "POST", url: "/api/paper-strategy-configs", payload: { config } });
    expect(created.statusCode).toBe(201);
    const first = created.json().config;
    expect(first).toMatchObject({ revision: 1, name: config.name, config });

    const revised = await app.inject({
      method: "POST",
      url: "/api/paper-strategy-configs",
      payload: { strategyId: first.strategyId, config: { ...config, entry: { ...config.entry, holdSec: 8 } } }
    });
    expect(revised.statusCode).toBe(201);
    expect(revised.json().config).toMatchObject({ strategyId: first.strategyId, revision: 2, config: { entry: { holdSec: 8 } } });
    expect((await app.inject({ method: "GET", url: "/api/paper-strategy-configs" })).json().configs).toHaveLength(2);

    const started = await app.inject({
      method: "POST",
      url: "/api/paper-strategy-runs",
      payload: { strategyId: first.strategyId, revision: 1 }
    });
    expect(started.statusCode).toBe(201);
    const run = started.json().run;
    expect(run).toMatchObject({ strategyId: first.strategyId, configRevision: 1, executionMode: "DRY_RUN", status: "IDLE" });
    expect((await app.inject({ method: "GET", url: "/api/paper-strategy-runs/active" })).json().run.runId).toBe(run.runId);
    expect((await app.inject({ method: "POST", url: "/api/paper-strategy-runs", payload: { strategyId: first.strategyId } })).statusCode).toBe(409);

    const stopped = await app.inject({ method: "POST", url: `/api/paper-strategy-runs/${encodeURIComponent(run.runId)}/stop` });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().run).toMatchObject({ runId: run.runId, status: "STOPPED" });
    expect((await app.inject({ method: "GET", url: "/api/paper-strategy-runs/active" })).json().run).toBeNull();
    const detail = (await app.inject({ method: "GET", url: `/api/paper-strategy-runs/${encodeURIComponent(run.runId)}` })).json();
    expect(detail.run.runId).toBe(run.runId);
    expect(detail.configRevision).toMatchObject({ strategyId: first.strategyId, revision: 1, config });
    expect(detail.eventsTruncated).toBe(false);
    expect(detail.events.map(({ event }: { event: { kind: string } }) => event.kind)).toEqual(["RUN_STARTED", "RUN_STOPPED"]);
    const truncated = (await app.inject({
      method: "GET",
      url: `/api/paper-strategy-runs/${encodeURIComponent(run.runId)}?eventLimit=1`
    })).json();
    expect(truncated.eventsTruncated).toBe(true);
    expect(truncated.events.map(({ event }: { event: { kind: string } }) => event.kind)).toEqual(["RUN_STOPPED"]);
  });

  it("returns stable client errors for malformed strategy requests", async () => {
    const app = await createApp({ replayJsonl });
    apps.push(app);

    expect((await app.inject({
      method: "POST",
      url: "/api/paper-strategy-configs",
      payload: { config: null }
    })).json()).toEqual({ error: { code: "INVALID_REQUEST_BODY" } });

    expect((await app.inject({
      method: "POST",
      url: "/api/paper-strategy-configs",
      payload: {
        config: {
          schemaVersion: 1,
          name: "broken",
          pair: "SOL-USDC",
          entry: {},
          scaling: {},
          exit: {},
          cooldownSec: 0
        }
      }
    })).json()).toEqual({ error: { code: "INVALID_SCALING_ENABLED" } });

    expect((await app.inject({
      method: "POST",
      url: "/api/paper-strategy-runs",
      payload: { strategyId: "missing" }
    })).statusCode).toBe(404);

    expect((await app.inject({
      method: "GET",
      url: "/api/paper-strategy-configs?strategyId=%20"
    })).json()).toEqual({ error: { code: "INVALID_STRATEGY_ID" } });
  });

  it("evaluates a replay strategy on recorded offsets without sampling the frozen final signal", async () => {
    const app = await createApp({ replayJsonl });
    apps.push(app);
    const config = {
      schemaVersion: 1,
      name: "Replay timeline guard",
      pair: "SOL-USDC",
      entry: { minEdgeBps: "999", holdSec: 5, initialSizeQuote: "100" },
      scaling: {
        enabled: false,
        intervalSec: 0,
        intervalMultiplier: "1",
        sizeQuote: "10",
        sizeMultiplier: "1",
        maxEntries: 1,
        maxTotalSizeQuote: "100"
      },
      exit: { takeProfitBps: "10", linearDecayToZero: true, stopLossBps: "10", forceExitSec: 60 },
      cooldownSec: 0
    };
    const revision = (await app.inject({
      method: "POST",
      url: "/api/paper-strategy-configs",
      payload: { config }
    })).json().config;
    const started = (await app.inject({
      method: "POST",
      url: "/api/paper-strategy-runs",
      payload: { strategyId: revision.strategyId, revision: revision.revision }
    })).json().run;

    expect((await app.inject({ method: "POST", url: "/api/replay/start" })).statusCode).toBe(200);
    const active = (await app.inject({ method: "GET", url: "/api/paper-strategy-runs/active" })).json().run;
    expect(active).toMatchObject({
      status: "IDLE",
      updatedAtMs: started.startedAtMs + 1_190,
      snapshot: {
        evaluatedAtMs: started.startedAtMs + 1_190,
        eventSequence: 1
      }
    });

    const repeated = await app.inject({ method: "POST", url: "/api/replay/start" });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toEqual({ accepted: false, reason: "active_strategy_already_consumed_replay" });
  });
});
