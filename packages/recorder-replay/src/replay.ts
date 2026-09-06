import { parseMarketEvent, type MarketEvent } from "@side/market-core";
import type { ReplayClock } from "./clock.js";

export interface ReplayEmission {
  event: MarketEvent;
  replayClockMs: number;
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
