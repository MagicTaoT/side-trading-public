import type { UiEvent } from "@side/market-core";

export interface UiEventMerge {
  events: UiEvent[];
  added: boolean;
}

export const VISUAL_BATCH_MS = 75;
export const UI_EVENT_WINDOW_MS = 300_000;
export const BITQUERY_VISUAL_BUCKET_MS = 1_000;
export const BITQUERY_MATERIAL_NOTIONAL = 1_000;
const RECENT_STATE_EVENT_LIMIT_PER_ZONE = 50;

export function clampedVolumeShare(
  primaryVolume: number,
  secondaryVolume: number,
  minimumPercent: number,
  maximumPercent: number
): number {
  if (!Number.isFinite(primaryVolume) || !Number.isFinite(secondaryVolume)) return 50;
  const primary = Math.max(0, primaryVolume);
  const secondary = Math.max(0, secondaryVolume);
  const total = primary + secondary;
  if (total === 0) return 50;
  const clamped = Math.min(maximumPercent, Math.max(minimumPercent, primary / total * 100));
  return Math.round(clamped * 2) / 2;
}

const BATCHABLE_KINDS = new Set<UiEvent["kind"]>([
  "trade",
  "bbo",
  "book-delta",
  "dex-quote",
  "onchain-swap",
  "route-change"
]);

export function bubbleVisualKey(event: UiEvent): string {
  return event.eventId;
}

export function isTradeBubbleEvent(event: UiEvent): boolean {
  return (event.kind === "trade" || event.kind === "onchain-swap") &&
    (event.tradeSide === "buy" || event.tradeSide === "sell");
}

export function pruneUiEvents(events: UiEvent[], evaluatedAtMs: number, windowMs = UI_EVENT_WINDOW_MS): UiEvent[] {
  const cutoff = evaluatedAtMs - windowMs;
  return events.filter(({ batchEndMs }) => batchEndMs > cutoff);
}

export function mergeUiEvent(
  events: UiEvent[],
  next: UiEvent,
  stateEventLimit = RECENT_STATE_EVENT_LIMIT_PER_ZONE,
  windowMs = UI_EVENT_WINDOW_MS
): UiEventMerge {
  const latestEventMs = events.reduce(
    (latest, { batchEndMs }) => Math.max(latest, batchEndMs),
    next.batchEndMs
  );
  const retained = pruneUiEvents(events, latestEventMs, windowMs);

  if (retained.some(({ eventId }) => eventId === next.eventId)) {
    return { events: retained, added: false };
  }

  if (isTradeBubbleEvent(next)) return { events: [...retained, next], added: true };

  const sameZoneStateEvents = retained.filter(
    (event) => event.zone === next.zone && !isTradeBubbleEvent(event)
  );
  const removeEventId = sameZoneStateEvents.length >= stateEventLimit ? sameZoneStateEvents[0]?.eventId : null;
  return {
    events: [...retained.filter((event) => event.eventId !== removeEventId), next],
    added: true
  };
}

function batchKey(event: UiEvent): string {
  return [event.zone, event.sourceProvider, event.venueLabel, event.instrumentId, event.quoteAsset, event.kind].join(":");
}

function bubbleBatchKey(event: UiEvent): string {
  return `${batchKey(event)}:${event.tradeSide}`;
}

function bitqueryVisualBucketKey(event: UiEvent): string {
  const bucket = Math.floor(event.batchStartMs / BITQUERY_VISUAL_BUCKET_MS);
  return [event.zone, event.sourceProvider, event.instrumentId, event.quoteAsset, event.kind, event.tradeSide, bucket].join(":");
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

export function microBatchBubbleEvents(events: UiEvent[], windowMs = VISUAL_BATCH_MS): UiEvent[] {
  const batches: UiEvent[] = [];
  const latestBatchByLane = new Map<string, number>();
  const bitqueryBatchByBucket = new Map<string, number>();

  for (const event of events.filter(isTradeBubbleEvent)) {
    const notional = Number(event.maxNotional ?? event.buyNotional ?? event.sellNotional ?? 0);
    const isBitquerySmallSwap = event.sourceProvider === "bitquery" &&
      event.kind === "onchain-swap" &&
      Number.isFinite(notional) &&
      notional < BITQUERY_MATERIAL_NOTIONAL;

    if (isBitquerySmallSwap) {
      const key = bitqueryVisualBucketKey(event);
      const previousIndex = bitqueryBatchByBucket.get(key);
      const previous = previousIndex === undefined ? undefined : batches[previousIndex];
      if (!previous || previousIndex === undefined) {
        batches.push({
          ...event,
          eventId: `visual:bitquery:${key}`,
          venueLabel: "DEX FLOW",
          label: "bitquery one-second visual aggregate"
        });
        bitqueryBatchByBucket.set(key, batches.length - 1);
        continue;
      }

      batches[previousIndex] = mergeBubbleBatch(previous, event);
      continue;
    }

    // Material Bitquery swaps retain their canonical identity and never disappear
    // into a nearby small-flow aggregate.
    if (event.sourceProvider === "bitquery" && event.kind === "onchain-swap") {
      batches.push(event);
      continue;
    }

    const key = bubbleBatchKey(event);
    const previousIndex = latestBatchByLane.get(key);
    const previous = previousIndex === undefined ? undefined : batches[previousIndex];
    const gapMs = previous === undefined ? Number.POSITIVE_INFINITY : event.batchStartMs - previous.batchEndMs;
    const canMerge = previous !== undefined && gapMs >= 0 && gapMs <= windowMs;

    if (!canMerge || !previous || previousIndex === undefined) {
      batches.push(event);
      latestBatchByLane.set(key, batches.length - 1);
      continue;
    }

    batches[previousIndex] = mergeBubbleBatch(previous, event);
  }

  return batches;
}

function mergeBubbleBatch(previous: UiEvent, event: UiEvent): UiEvent {
  const buyNotional = sumDecimal(previous.buyNotional, event.buyNotional);
  const sellNotional = sumDecimal(previous.sellNotional, event.sellNotional);
  const maxNotional = maxDecimal(previous.maxNotional, event.maxNotional);
  const minPx = minDecimal(previous.minPx, event.minPx);
  const maxPx = maxDecimal(previous.maxPx, event.maxPx);

  return {
    ...previous,
    streamSeq: event.streamSeq,
    stateVersion: event.stateVersion,
    count: previous.count + event.count,
    batchEndMs: Math.max(previous.batchEndMs, event.batchEndMs),
    buyCount: (previous.buyCount ?? 0) + (event.buyCount ?? 0),
    sellCount: (previous.sellCount ?? 0) + (event.sellCount ?? 0),
    ...(buyNotional === undefined ? {} : { buyNotional }),
    ...(sellNotional === undefined ? {} : { sellNotional }),
    ...(maxNotional === undefined ? {} : { maxNotional }),
    ...(minPx === undefined ? {} : { minPx }),
    ...(maxPx === undefined ? {} : { maxPx })
  };
}

export interface SeededVisual {
  xPercent: number;
  yPercent: number;
  diameterPx: number;
  delayMs: number;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function unitInterval(value: number): number {
  return value / 0x1_0000_0000;
}

export function bubbleAgeOpacity(
  event: UiEvent,
  evaluatedAtMs: number,
  windowMs = UI_EVENT_WINDOW_MS
): number {
  const ageRatio = Math.min(1, Math.max(0, (evaluatedAtMs - event.batchEndMs) / windowMs));
  if (ageRatio <= 0.5) return 0.85 - ageRatio / 0.5 * 0.55;
  return 0.3 - (ageRatio - 0.5) / 0.5 * 0.2;
}

export function seededVisual(event: UiEvent): SeededVisual {
  let seed = 2166136261;
  for (const character of event.eventId) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  const unsigned = seed >>> 0;
  const notional = Number(event.maxNotional ?? event.buyNotional ?? event.sellNotional ?? 0);
  const diameterPx = Math.round(Math.min(72, Math.max(22, 22 + Math.sqrt(notional) * 0.42)));
  const sizeRatio = (diameterPx - 22) / (72 - 22);
  const xMargin = 6 + sizeRatio * 6;
  const yMargin = 12 + sizeRatio * 9;
  const xUnit = unitInterval(mix32(unsigned ^ 0x9e3779b9));
  const yUnit = unitInterval(mix32(unsigned ^ 0x85ebca6b));

  return {
    xPercent: Math.round((xMargin + xUnit * (100 - xMargin * 2)) * 10) / 10,
    yPercent: Math.round((yMargin + yUnit * (100 - yMargin * 2)) * 10) / 10,
    diameterPx,
    delayMs: mix32(unsigned ^ 0xc2b2ae35) % 180
  };
}
