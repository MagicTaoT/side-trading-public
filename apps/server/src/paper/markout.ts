import Decimal from "decimal.js";
import type { DexReferenceSnapshot, PaperMarkout } from "./contracts.js";
import type { DecisionJournal, DueMarkoutJob } from "./journal.js";

const WORKER_BATCH_SIZE = 100;

export function directionalMarkout(
  action: "BUY" | "SELL",
  entryPriceQuotePerSol: string,
  futurePriceQuotePerSol: string,
  targetNotionalQuote: string
): { directionalMarkoutBps: string; directionalPnlQuote: string } {
  const entry = new Decimal(entryPriceQuotePerSol);
  const future = new Decimal(futurePriceQuotePerSol);
  if (!entry.isFinite() || !future.isFinite() || entry.lte(0) || future.lte(0)) throw new Error("INVALID_REFERENCE_PRICE");
  const sign = action === "BUY" ? new Decimal(1) : new Decimal(-1);
  const returnRatio = future.div(entry).minus(1).mul(sign);
  return {
    directionalMarkoutBps: returnRatio.mul(10_000).toFixed(8),
    directionalPnlQuote: returnRatio.mul(targetNotionalQuote).toFixed(6)
  };
}

export interface MarkoutWorkerOptions {
  journal: DecisionJournal;
  reference: (evaluatedAtMs: number) => DexReferenceSnapshot;
  now?: () => number;
  intervalMs?: number;
  onComplete?: (markout: PaperMarkout) => void;
  onError?: (reason: unknown) => void;
}

export class MarkoutWorker {
  readonly #journal: DecisionJournal;
  readonly #reference: (evaluatedAtMs: number) => DexReferenceSnapshot;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #onComplete: (markout: PaperMarkout) => void;
  readonly #onError: (reason: unknown) => void;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(options: MarkoutWorkerOptions) {
    this.#journal = options.journal;
    this.#reference = options.reference;
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? 1_000;
    this.#onComplete = options.onComplete ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#timer) return;
    void this.runOnce().catch(this.#onError);
    this.#timer = setInterval(() => void this.runOnce().catch(this.#onError), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async runOnce(): Promise<PaperMarkout[]> {
    if (this.#running) return [];
    this.#running = true;
    try {
      const nowMs = this.#now();
      const jobs = await this.#journal.dueMarkouts(nowMs, WORKER_BATCH_SIZE);
      const results: PaperMarkout[] = [];
      for (const job of jobs) {
        const completed = await this.#journal.completeMarkout(this.#compute(job, nowMs));
        results.push(completed);
        this.#onComplete(completed);
      }
      return results;
    } finally {
      this.#running = false;
    }
  }

  #compute(job: DueMarkoutJob, computedAtMs: number): PaperMarkout {
    if (job.action === "WAIT") {
      return {
        ...job.markout,
        status: "UNSCORED",
        futureReference: null,
        directionalMarkoutBps: null,
        directionalPnlQuote: null,
        reason: "WAIT_ACTION",
        computedAtMs
      };
    }
    if (job.markout.entryReference.status !== "READY" || job.markout.entryReference.priceQuotePerSol === null) {
      return {
        ...job.markout,
        status: "UNSCORED",
        futureReference: null,
        directionalMarkoutBps: null,
        directionalPnlQuote: null,
        reason: job.markout.entryReference.reason ?? "INSUFFICIENT_SAMPLES",
        computedAtMs
      };
    }

    const futureReference = this.#reference(job.markout.dueAtMs);
    if (futureReference.status !== "READY" || futureReference.priceQuotePerSol === null) {
      return {
        ...job.markout,
        status: "UNSCORED",
        futureReference,
        directionalMarkoutBps: null,
        directionalPnlQuote: null,
        reason: futureReference.reason ?? "INSUFFICIENT_SAMPLES",
        computedAtMs
      };
    }
    const score = directionalMarkout(
      job.action,
      job.markout.entryReference.priceQuotePerSol,
      futureReference.priceQuotePerSol,
      job.targetNotionalQuote
    );
    return {
      ...job.markout,
      status: "SCORED",
      futureReference,
      ...score,
      reason: null,
      computedAtMs
    };
  }
}
