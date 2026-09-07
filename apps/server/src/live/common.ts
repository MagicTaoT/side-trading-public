import Decimal from "decimal.js";
import type { SourceRuntimeState } from "../contracts.js";

export interface LiveEventSink {
  emit(draft: Record<string, unknown>): void;
  log(message: string, detail?: string): void;
}

export interface LiveSourceSpec {
  provider: "coinbase" | "coinbase-derivatives" | "kraken-futures" | "hyperliquid" | "bitquery";
  venue: "coinbase" | "coinbase-derivatives" | "kraken-futures" | "hyperliquid" | "solana-dex";
  segment: "spot" | "perp" | "dex-spot";
  instrumentId: string;
  quote: "USD" | "USDC";
}

let healthEventSequence = 0;

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
}

export function text(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

export function decimal(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  try {
    const parsed = new Decimal(raw);
    return parsed.isFinite() && parsed.gte(0) ? parsed.toFixed() : null;
  } catch {
    return null;
  }
}

export function signedDecimal(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  try {
    const parsed = new Decimal(raw);
    return parsed.isFinite() ? parsed.toFixed() : null;
  } catch {
    return null;
  }
}

export function eventBase(
  spec: LiveSourceSpec,
  channel: string,
  generation: number,
  eventId: string,
  occurredAtMs: number,
  receivedAtUnixMs = Date.now()
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId,
    source: { provider: spec.provider, channel, connectionGeneration: generation },
    venue: spec.venue,
    segment: spec.segment,
    instrumentId: spec.instrumentId,
    base: "SOL",
    quote: spec.quote,
    occurredAtMs,
    timeOrigin: "venue",
    receivedAtUnixMs,
    receivedMonoNs: process.hrtime.bigint().toString(),
    quality: {
      state: "fresh",
      latencyMs: Math.max(0, receivedAtUnixMs - occurredAtMs),
      outOfOrder: false,
      replay: false
    }
  };
}

export function healthDraft(
  spec: LiveSourceSpec,
  connection: SourceRuntimeState["connection"],
  generation: number,
  reason?: string
): Record<string, unknown> {
  const now = Date.now();
  const quality = connection === "live" ? "fresh" : connection === "closed" ? "stale" : "degraded";
  return {
    ...eventBase(spec, "transport", generation, `${spec.provider}:health:${generation}:${now}:${connection}:${healthEventSequence++}`, now, now),
    kind: "source-health",
    quality: { state: quality, latencyMs: 0, outOfOrder: false, replay: false },
    payload: {
      connection,
      transportLastSeenAtMs: now,
      stateLastChangedAtMs: now,
      ...(reason ? { gapReason: reason.slice(0, 200) } : {})
    }
  };
}

export function safeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
