import type { GatewayMessage, RuntimeSnapshot } from "./contracts.js";

type Scheduler = (flush: () => void) => void;

function messageKind(message: GatewayMessage): string {
  return message.type === "ui_event" ? message.event.kind : message.type;
}

export class BoundedGatewayQueue {
  #pending: GatewayMessage[] = [];
  #scheduled = false;
  #resyncPending = false;
  #suppressedCountByKind: Record<string, number> = {};

  constructor(
    private readonly send: (serialized: string) => void,
    private readonly snapshot: () => RuntimeSnapshot,
    private readonly capacity = 64,
    private readonly schedule: Scheduler = (flush) => setImmediate(flush)
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Gateway queue capacity must be a positive integer");
    }
  }

  get size(): number {
    return this.#pending.length;
  }

  enqueue(message: GatewayMessage): void {
    if (this.#resyncPending) {
      this.#suppress(message);
      this.#replaceResyncMessage();
      return;
    }

    if (this.#pending.length >= this.capacity) {
      for (const pendingMessage of this.#pending) {
        this.#suppress(pendingMessage);
      }
      this.#suppress(message);
      this.#pending = [];
      this.#resyncPending = true;
      this.#replaceResyncMessage();
    } else {
      this.#pending.push(message);
    }

    this.#requestFlush();
  }

  drain(): void {
    const messages = this.#pending;
    this.#pending = [];
    this.#scheduled = false;
    this.#resyncPending = false;
    this.#suppressedCountByKind = {};

    for (const message of messages) {
      this.send(JSON.stringify(message));
    }
  }

  #suppress(message: GatewayMessage): void {
    const kind = messageKind(message);
    this.#suppressedCountByKind[kind] = (this.#suppressedCountByKind[kind] ?? 0) + 1;
  }

  #replaceResyncMessage(): void {
    this.#pending = [
      {
        type: "resync_required",
        suppressedCountByKind: { ...this.#suppressedCountByKind },
        snapshot: this.snapshot()
      }
    ];
    this.#requestFlush();
  }

  #requestFlush(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.schedule(() => this.drain());
  }
}
