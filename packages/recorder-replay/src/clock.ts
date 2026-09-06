export interface ReplayClock {
  nowMs(): number;
  advanceTo(targetMs: number): void;
}

export class ManualReplayClock implements ReplayClock {
  #currentMs: number;

  constructor(startMs = 0) {
    if (!Number.isFinite(startMs) || startMs < 0) {
      throw new RangeError("Replay clock start must be a non-negative finite number");
    }
    this.#currentMs = startMs;
  }

  nowMs(): number {
    return this.#currentMs;
  }

  advanceTo(targetMs: number): void {
    if (!Number.isFinite(targetMs) || targetMs < this.#currentMs) {
      throw new RangeError("Replay clock cannot move backwards");
    }
    this.#currentMs = targetMs;
  }
}
