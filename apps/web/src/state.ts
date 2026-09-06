import type { UiEvent } from "@side/market-core";

export interface UiEventMerge {
  events: UiEvent[];
  added: boolean;
}

export const VISUAL_BATCH_MS = 75;

const BATCHABLE_KINDS = new Set<UiEvent["kind"]>([
  "trade",
  "bbo",
  "book-delta",
  "dex-quote",
  "onchain-swap",
  "route-change"
]);

function eventKey(event: UiEvent): string {
  return `${event.eventId}:${event.streamSeq}`;
}

export function mergeUiEvent(events: UiEvent[], next: UiEvent, limit = 50): UiEventMerge {
  if (events.some((event) => eventKey(event) === eventKey(next))) {
    return { events, added: false };
  }

  const sameZone = events.filter(({ zone }) => zone === next.zone);
  const removeEventId = sameZone.length >= limit ? sameZone[0]?.eventId : null;
  return {
    events: [...events.filter((event) => !(event.zone === next.zone && event.eventId === removeEventId)), next],
    added: true
  };
}

function batchKey(event: UiEvent): string {
  return [event.zone, event.sourceProvider, event.venueLabel, event.instrumentId, event.quoteAsset, event.kind].join(":");
}

function sumDecimal(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined && right === undefined) return undefined;
  return ((Number(left ?? 0) + Number(right ?? 0))).toFixed(2);
}

function maxDecimal(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined && right === undefined) return undefined;
  return Math.max(Number(left ?? 0), Number(right ?? 0)).toFixed(2);
}

function minDecimal(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(Number(left), Number(right)).toString();
}

export function microBatchUiEvents(events: UiEvent[], windowMs = VISUAL_BATCH_MS): UiEvent[] {
  const batches: UiEvent[] = [];

  for (const event of events) {
    const previous = batches.at(-1);
    const canMerge =
      previous !== undefined &&
      BATCHABLE_KINDS.has(event.kind) &&
      batchKey(previous) === batchKey(event) &&
      event.batchStartMs - previous.batchEndMs <= windowMs;

    if (!canMerge || !previous) {
      batches.push(event);
      continue;
    }

    const buyCount = (previous.buyCount ?? 0) + (event.buyCount ?? 0);
    const sellCount = (previous.sellCount ?? 0) + (event.sellCount ?? 0);
    const buyNotional = sumDecimal(previous.buyNotional, event.buyNotional);
    const sellNotional = sumDecimal(previous.sellNotional, event.sellNotional);
    const maxNotional = maxDecimal(previous.maxNotional, event.maxNotional);
    const minPx = minDecimal(previous.minPx, event.minPx);
    const maxPx = maxDecimal(previous.maxPx, event.maxPx);

    batches[batches.length - 1] = {
      ...previous,
      streamSeq: event.streamSeq,
      stateVersion: event.stateVersion,
      changeDirection: buyCount > 0 && sellCount === 0 ? "up" : sellCount > 0 && buyCount === 0 ? "down" : "flat",
      tradeSide: buyCount > 0 && sellCount === 0 ? "buy" : sellCount > 0 && buyCount === 0 ? "sell" : "unknown",
      count: previous.count + event.count,
      batchEndMs: Math.max(previous.batchEndMs, event.batchEndMs),
      buyCount,
      sellCount,
      ...(buyNotional === undefined ? {} : { buyNotional }),
      ...(sellNotional === undefined ? {} : { sellNotional }),
      ...(maxNotional === undefined ? {} : { maxNotional }),
      ...(minPx === undefined ? {} : { minPx }),
      ...(maxPx === undefined ? {} : { maxPx })
    };
  }

  return batches;
}

export interface SeededVisual {
  xPercent: number;
  yPercent: number;
  diameterPx: number;
  delayMs: number;
}

export function seededVisual(event: UiEvent): SeededVisual {
  let seed = 2166136261;
  for (const character of event.eventId) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  const unsigned = seed >>> 0;
  const notional = Number(event.maxNotional ?? event.buyNotional ?? event.sellNotional ?? 0);

  return {
    xPercent: 14 + (unsigned % 72),
    yPercent: 20 + ((unsigned >>> 8) % 58),
    diameterPx: Math.round(Math.min(72, Math.max(22, 22 + Math.sqrt(notional) * 0.42))),
    delayMs: (unsigned >>> 16) % 180
  };
}
