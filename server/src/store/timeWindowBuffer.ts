export interface ByteLimit<T> {
  maxBytes: number;
  sizeOf: (item: T) => number;
}

/**
 * Append-only buffer that keeps items whose `ts` lies within `windowMs` of the newest timestamp,
 * capped at `maxItems` and optionally at a total byte size. Items are expected in (roughly)
 * ascending ts order. Reads return copies.
 */
export class TimeWindowBuffer<T extends { ts: number }> {
  private items: T[] = [];
  private sizes: number[] = [];
  private head = 0;
  private bytes = 0;

  constructor(
    readonly windowMs: number,
    readonly maxItems: number,
    private readonly byteLimit?: ByteLimit<T>,
  ) {}

  get size(): number {
    return this.items.length - this.head;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  push(...items: T[]): void {
    for (const item of items) {
      this.items.push(item);
      if (this.byteLimit) {
        const size = this.byteLimit.sizeOf(item);
        this.sizes.push(size);
        this.bytes += size;
      }
    }
    const newest = this.items.at(-1);
    if (newest) this.prune(newest.ts);
  }

  /** The newest item, without copying the buffer. */
  last(): T | undefined {
    return this.size > 0 ? this.items.at(-1) : undefined;
  }

  /** The newest item matching `predicate`, searching backwards from the end. */
  findLast(predicate: (item: T) => boolean): T | undefined {
    for (let i = this.items.length - 1; i >= this.head; i -= 1) {
      const item = this.items[i];
      if (item !== undefined && predicate(item)) return item;
    }
    return undefined;
  }

  /** Replace the newest item (e.g. to close an open span). No-op on an empty buffer. */
  replaceLast(item: T): void {
    const index = this.items.length - 1;
    if (index < this.head) return;
    this.items[index] = item;
    if (this.byteLimit) {
      const size = this.byteLimit.sizeOf(item);
      this.bytes += size - (this.sizes[index] ?? 0);
      this.sizes[index] = size;
    }
    this.prune(item.ts);
  }

  /** Drop items older than `nowMs - windowMs` and anything beyond the item / byte caps. */
  prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    const maxBytes = this.byteLimit?.maxBytes ?? Infinity;
    while (
      this.head < this.items.length &&
      ((this.items[this.head]?.ts ?? Infinity) < cutoff || this.size > this.maxItems || this.bytes > maxBytes)
    ) {
      this.dropHead();
    }
    // Compact occasionally so the backing arrays don't grow without bound.
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      if (this.byteLimit) this.sizes = this.sizes.slice(this.head);
      this.head = 0;
    }
  }

  /** Snapshot of the current contents, optionally pruned against the wall clock first. */
  toArray(nowMs?: number): T[] {
    if (nowMs !== undefined) this.prune(nowMs);
    return this.items.slice(this.head);
  }

  private dropHead(): void {
    if (this.byteLimit) this.bytes -= this.sizes[this.head] ?? 0;
    this.head += 1;
  }
}
