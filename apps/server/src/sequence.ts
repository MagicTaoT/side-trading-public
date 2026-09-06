export class IngestSequenceAllocator {
  #last: bigint;

  constructor(initial = "0") {
    this.#last = IngestSequenceAllocator.parse(initial);
  }

  static parse(value: string): bigint {
    if (!/^(0|[1-9]\d*)$/u.test(value)) {
      throw new TypeError(`Invalid ingest sequence: ${value}`);
    }
    return BigInt(value);
  }

  reset(initial = "0"): void {
    this.#last = IngestSequenceAllocator.parse(initial);
  }

  observe(value: string): void {
    const sequence = IngestSequenceAllocator.parse(value);
    if (sequence <= this.#last) {
      throw new RangeError(`ingestSeq must increase globally: ${value} <= ${this.#last}`);
    }
    this.#last = sequence;
  }

  next(): string {
    this.#last += 1n;
    return this.#last.toString();
  }

  current(): string {
    return this.#last.toString();
  }
}
