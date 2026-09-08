import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeEventLog,
  encodeEventLog,
  ManualReplayClock,
  orderForReplay,
  replayEvents,
  replayEventsWithFixedTicks
} from "../src/index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/golden/spot-led.jsonl", import.meta.url));
const fixture = readFileSync(fixturePath, "utf8");

describe("event log", () => {
  it("round-trips canonical JSONL", () => {
    const events = decodeEventLog(fixture);
    expect(decodeEventLog(encodeEventLog(events))).toEqual(events);
  });

  it("reports the invalid line and fails closed", () => {
    const corrupted = `${fixture.trimEnd()}\n{\"not\":\"an event\"}\n`;
    expect(() => decodeEventLog(corrupted)).toThrow(/line 4/u);
  });
});

describe("deterministic replay", () => {
  it("merges shuffled partitions by ingestSeq", () => {
    const events = decodeEventLog(fixture);
    const ordered = orderForReplay([events[2], events[0], events[1]]);
    expect(ordered.map(({ ingestSeq }) => ingestSeq)).toEqual(["100", "101", "102"]);
  });

  it("replays with deterministic receive-time offsets and replay labels", () => {
    const events = decodeEventLog(fixture);
    const run = () => {
      const emissions: Array<{ id: string; at: number; replay: boolean }> = [];
      replayEvents([events[2], events[0], events[1]], new ManualReplayClock(5_000), ({ event, replayClockMs }) => {
        emissions.push({ id: event.eventId, at: replayClockMs, replay: event.quality.replay });
      });
      return emissions;
    };

    const firstRun = run();
    expect(JSON.stringify(firstRun)).toBe(JSON.stringify(run()));
    expect(firstRun).toEqual([
      { id: "coinbase:trade:100", at: 5_000, replay: true },
      { id: "coinbase:bbo:101", at: 5_025, replay: true },
      { id: "bitquery:swap:102", at: 6_190, replay: true }
    ]);
  });

  it("rejects duplicate global ordering keys", () => {
    const [event] = decodeEventLog(fixture);
    expect(() => orderForReplay([event, { ...event, eventId: "different" }])).toThrow(/Duplicate ingestSeq/u);
  });

  it("rejects duplicate event ids even when sequence differs", () => {
    const [event] = decodeEventLog(fixture);
    expect(() => orderForReplay([event, { ...event, ingestSeq: "999" }])).toThrow(/Duplicate eventId/u);
  });

  it("emits all observed events before deterministic one-second strategy ticks", () => {
    const events = decodeEventLog(fixture);
    const timeline: string[] = [];
    replayEventsWithFixedTicks(
      events,
      new ManualReplayClock(10_000),
      {
        onEvent: ({ event, replayClockMs }) => timeline.push(`event:${event.ingestSeq}:${replayClockMs}`),
        onTick: ({ elapsedMs, replayClockMs }) => timeline.push(`tick:${elapsedMs}:${replayClockMs}`)
      }
    );

    expect(timeline).toEqual([
      "event:100:10000",
      "tick:0:10000",
      "event:101:10025",
      "tick:1000:11000",
      "event:102:11190",
      "tick:2000:12000"
    ]);
  });
});
