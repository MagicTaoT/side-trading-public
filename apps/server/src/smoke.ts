import assert from "node:assert/strict";
import WebSocket from "ws";
import { createApp } from "./app.js";
import { loadDefaultReplayFixture } from "./fixture.js";

const replayJsonl = await loadDefaultReplayFixture();
const app = await createApp({ replayJsonl });
await app.listen({ port: 0, host: "127.0.0.1" });

try {
  const address = app.server.address();
  assert(address && typeof address === "object");
  const messages: Array<{ type?: string }> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as { type?: string }));

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket open timed out")), 2_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", reject);
  });

  const response = await app.inject({ method: "POST", url: "/api/replay/start" });
  assert.equal(response.statusCode, 200);

  await new Promise((resolve) => setTimeout(resolve, 25));
  const state = await app.inject({ method: "GET", url: "/api/state" });
  const body = state.json();
  assert.equal(body.mode, "REPLAY");
  assert.equal(body.replayStatus, "completed");
  assert.equal(body.eventsIngested, 3);
  assert.equal(body.signal.modelVersion, "s0-v1");
  assert.equal(body.signal.verdict.verdict, "INSUFFICIENT_DATA");
  assert(messages.some(({ type }) => type === "state_snapshot"));
  assert(messages.some(({ type }) => type === "ui_event"));
  assert(messages.some(({ type }) => type === "source_health"));
  assert(messages.some(({ type }) => type === "signal_state"));
  socket.close();

  process.stdout.write("S0 smoke passed: HTTP + WebSocket + replay pipeline\n");
} finally {
  await app.close();
}
