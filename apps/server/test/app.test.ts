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
      mode: "REPLAY"
    });
    expect((await app.inject({ method: "GET", url: "/health/sources" })).json()).toEqual({
      mode: "REPLAY",
      sources: []
    });
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
    expect(order).toMatchObject({ executionMode: "paper", action: "SELL", previewId: preview.previewId });
    expect((await app.inject({ method: "GET", url: `/api/paper-orders/${encodeURIComponent(order.orderId)}` })).json().order)
      .toEqual(order);
  });
});
