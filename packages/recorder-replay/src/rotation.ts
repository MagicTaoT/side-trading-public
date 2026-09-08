import { randomUUID } from "node:crypto";
import { parseMarketEvent, type MarketEvent } from "@side/market-core";
import {
  parseRecordedStrategyObservation,
  PartitionedEventRecorder,
  type EventRecorder,
  type EventRecorderStatus,
  type RecordedStrategyObservation
} from "./recording.js";

export const THREE_HOURS_MS = 3 * 60 * 60 * 1_000;

export interface RotatingEventRecorderOptions {
  rootDir: string;
  segmentMs?: number;
  now?: () => number;
  id?: () => string;
  queueCapacity?: number;
  onSegmentComplete?: (status: EventRecorderStatus) => Promise<void>;
  onError?: (reason: Error) => void;
}

function segmentStamp(atMs: number): string {
  return new Date(atMs).toISOString().replace(/[-:.]/gu, "").replace("Z", "Z");
}

function segmentStart(atMs: number, segmentMs: number): number {
  return Math.floor(atMs / segmentMs) * segmentMs;
}

/**
 * Routes accepted records through one serial queue and swaps the underlying
 * immutable dataset at a wall-clock boundary. Source sockets remain running
 * while the previous segment is finalized and archived.
 */
export class RotatingEventRecorder implements EventRecorder {
  readonly rootDir: string;
  readonly segmentMs: number;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #queueCapacity: number;
  readonly #onSegmentComplete: ((status: EventRecorderStatus) => Promise<void>) | undefined;
  readonly #onError: ((reason: Error) => void) | undefined;
  #active: PartitionedEventRecorder;
  #activeSegmentStartMs: number;
  #tail: Promise<void> = Promise.resolve();
  #accepting = true;
  #failure: Error | null = null;
  #pendingOperations = 0;

  constructor(options: RotatingEventRecorderOptions) {
    const segmentMs = options.segmentMs ?? THREE_HOURS_MS;
    if (!Number.isSafeInteger(segmentMs) || segmentMs < 60_000) throw new Error("INVALID_RECORDING_SEGMENT_MS");
    this.rootDir = options.rootDir;
    this.segmentMs = segmentMs;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? (() => randomUUID().slice(0, 8));
    this.#queueCapacity = options.queueCapacity ?? 20_000;
    if (!Number.isSafeInteger(this.#queueCapacity) || this.#queueCapacity < 1) throw new Error("INVALID_RECORDING_QUEUE_CAPACITY");
    this.#onSegmentComplete = options.onSegmentComplete;
    this.#onError = options.onError;
    this.#activeSegmentStartMs = segmentStart(this.#now(), this.segmentMs);
    this.#active = this.#newRecorder(this.#activeSegmentStartMs);
  }

  record(input: MarketEvent): void {
    const event = parseMarketEvent(input);
    const acceptedAtMs = this.#now();
    this.#enqueue(() => this.#route(acceptedAtMs, (recorder) => recorder.record(event)));
  }

  recordObservation(input: RecordedStrategyObservation): void {
    const observation = parseRecordedStrategyObservation(input);
    const acceptedAtMs = this.#now();
    this.#enqueue(() => this.#route(acceptedAtMs, (recorder) => recorder.recordObservation(observation)));
  }

  status(): EventRecorderStatus {
    const active = this.#active.status();
    return this.#failure ? { ...active, state: "FAILED", failure: this.#failure.message } : active;
  }

  async flush(): Promise<void> {
    await this.#tail;
    await this.#active.flush();
    if (this.#failure) throw this.#failure;
  }

  async close(): Promise<void> {
    if (!this.#accepting) {
      await this.#tail;
      return;
    }
    this.#accepting = false;
    this.#tail = this.#tail.then(() => this.#finalizeActive());
    await this.#tail;
    if (this.#failure) throw this.#failure;
  }

  #newRecorder(startMs: number): PartitionedEventRecorder {
    const endMs = startMs + this.segmentMs;
    const datasetId = `live-${segmentStamp(startMs)}-${segmentStamp(endMs)}-${this.#id()}`;
    return new PartitionedEventRecorder({ rootDir: this.rootDir, datasetId, now: this.#now });
  }

  #enqueue(operation: () => Promise<void>): void {
    if (!this.#accepting) throw new Error("EVENT_RECORDER_CLOSED");
    if (this.#failure) throw this.#failure;
    if (this.#pendingOperations >= this.#queueCapacity) {
      this.#failure = new Error("RECORDING_QUEUE_OVERFLOW");
      this.#onError?.(this.#failure);
      throw this.#failure;
    }
    this.#pendingOperations += 1;
    this.#tail = this.#tail.then(operation).catch((reason: unknown) => {
      this.#failure = reason instanceof Error ? reason : new Error(String(reason));
      this.#onError?.(this.#failure);
    }).finally(() => {
      this.#pendingOperations -= 1;
    });
  }

  async #route(acceptedAtMs: number, write: (recorder: PartitionedEventRecorder) => void): Promise<void> {
    const observedSegmentStartMs = segmentStart(acceptedAtMs, this.segmentMs);
    if (observedSegmentStartMs > this.#activeSegmentStartMs) {
      await this.#finalizeActive();
      this.#activeSegmentStartMs = observedSegmentStartMs;
      this.#active = this.#newRecorder(observedSegmentStartMs);
    }
    write(this.#active);
  }

  async #finalizeActive(): Promise<void> {
    await this.#active.close();
    if (this.#onSegmentComplete) await this.#onSegmentComplete(this.#active.status());
  }
}
