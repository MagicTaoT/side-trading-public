import { parseMarketEvent, type MarketEvent } from "@side/market-core";
import type { ReplayClock } from "./clock.js";

export interface ReplayEmission {
  event: MarketEvent;
  replayClockMs: number;
}

export interface FixedReplayTick {
  replayClockMs: number;
  elapsedMs: number;
  referenceAtMs: number;
}

export interface FixedReplayHandlers {
  onEvent(emission: ReplayEmission): void;
  onTick(tick: FixedReplayTick): void;
}

export interface FixedReplayOptions {
  tickIntervalMs?: number;
  /** Extends the virtual clock beyond the last event, for example to a recorder close time. */
  endAtReceivedMs?: number;
}

function compareIngestSeq(left: MarketEvent, right: MarketEvent): number {
  const leftSeq = BigInt(left.ingestSeq);
  const rightSeq = BigInt(right.ingestSeq);
  return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : 0;
}

export function orderForReplay(input: readonly unknown[]): MarketEvent[] {
  const events = input.map(parseMarketEvent).sort(compareIngestSeq);
  const eventIds = new Set<string>();
  let previousSeq: bigint | undefined;

  for (const event of events) {
    const seq = BigInt(event.ingestSeq);
    if (previousSeq === seq) {
      throw new Error(`Duplicate ingestSeq ${event.ingestSeq}`);
    }
    if (eventIds.has(event.eventId)) {
      throw new Error(`Duplicate eventId ${event.eventId}`);
    }
    eventIds.add(event.eventId);
    previousSeq = seq;
  }

  return events;
}

export function replayEvents(
  input: readonly unknown[],
  clock: ReplayClock,
  emit: (emission: ReplayEmission) => void
): void {
  const events = orderForReplay(input);
  const firstReceivedAt = events[0]?.receivedAtUnixMs;
  const replayStart = clock.nowMs();

  for (const event of events) {
    const recordedOffset = firstReceivedAt === undefined ? 0 : Math.max(0, event.receivedAtUnixMs - firstReceivedAt);
    clock.advanceTo(Math.max(clock.nowMs(), replayStart + recordedOffset));
    emit({
      event: {
        ...event,
        quality: { ...event.quality, replay: true }
      },
      replayClockMs: clock.nowMs()
    });
  }
}

/**
 * Replays events in ingest order while evaluating a fixed virtual timer. All
 * events observed by a tick are emitted before that tick, matching LIVE's
 * ingest-immediately/evaluate-on-one-second-timer ordering.
 */
export function replayEventsWithFixedTicks(
  input: readonly unknown[],
  clock: ReplayClock,
  handlers: FixedReplayHandlers,
  options: FixedReplayOptions = {}
): void {
  const events = orderForReplay(input);
  if (events.length === 0) return;
  const intervalMs = options.tickIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new RangeError("Invalid replay tick interval");
  const firstReceivedAtMs = (events[0] as MarketEvent).receivedAtUnixMs;
  if (
    options.endAtReceivedMs !== undefined &&
    (!Number.isSafeInteger(options.endAtReceivedMs) || options.endAtReceivedMs < firstReceivedAtMs)
  ) {
    throw new RangeError("Invalid replay end time");
  }

  let monotonicOffset = 0;
  const scheduled = events.map((event) => {
    monotonicOffset = Math.max(monotonicOffset, Math.max(0, event.receivedAtUnixMs - firstReceivedAtMs));
    return { event, offsetMs: monotonicOffset };
  });
  const requestedDuration = options.endAtReceivedMs === undefined
    ? monotonicOffset
    : Math.max(monotonicOffset, options.endAtReceivedMs - firstReceivedAtMs);
  const finalTickOffset = Math.ceil(requestedDuration / intervalMs) * intervalMs;
  if (!Number.isSafeInteger(finalTickOffset)) throw new RangeError("Replay timeline exceeds safe integer range");

  const replayStartMs = clock.nowMs();
  let eventIndex = 0;
  for (let tickOffset = 0; tickOffset <= finalTickOffset; tickOffset += intervalMs) {
    while (eventIndex < scheduled.length && (scheduled[eventIndex] as { offsetMs: number }).offsetMs <= tickOffset) {
      const current = scheduled[eventIndex] as { event: MarketEvent; offsetMs: number };
      clock.advanceTo(replayStartMs + current.offsetMs);
      handlers.onEvent({
        event: { ...current.event, quality: { ...current.event.quality, replay: true } },
        replayClockMs: clock.nowMs()
      });
      eventIndex += 1;
    }
    clock.advanceTo(replayStartMs + tickOffset);
    handlers.onTick({
      replayClockMs: clock.nowMs(),
      elapsedMs: tickOffset,
      referenceAtMs: firstReceivedAtMs + tickOffset
    });
    if (tickOffset === finalTickOffset) break;
  }
  if (eventIndex !== scheduled.length) throw new Error("Replay timeline did not consume every event");
}
