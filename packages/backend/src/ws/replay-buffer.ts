/**
 * In-memory circular replay buffer for a single WS scope.
 *
 * Stores the last `maxSize` events so reconnecting clients can resume
 * a missed gap without a full REST snapshot. The interface is designed
 * to be swappable — a SQLite-backed implementation can replace this
 * without changing callers.
 *
 * Epoch safety: each entry records the epoch at write time. If the
 * caller's epoch differs from the stored epoch, replay returns empty
 * (caller must do a snapshot instead).
 */

export interface ReplayEntry {
  seq: number;
  epoch: string;
  kind: string;
  payload: unknown;
}

export class ReplayBuffer {
  private readonly buf: ReplayEntry[];
  private head = 0; // next write position (circular)
  private count = 0;

  constructor(private readonly maxSize = 200) {
    this.buf = new Array(maxSize);
  }

  /** Append a new entry. Overwrites the oldest when full. */
  push(entry: ReplayEntry): void {
    this.buf[this.head] = entry;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) this.count++;
  }

  /**
   * Return all entries with seq > fromSeq and matching epoch, in order.
   * Returns an empty array if the epoch doesn't match (client must snapshot).
   */
  replay(fromSeq: number, epoch: string): ReplayEntry[] {
    if (this.count === 0) return [];

    // Walk entries in insertion order (oldest → newest).
    const result: ReplayEntry[] = [];
    const start = this.count < this.maxSize ? 0 : this.head;

    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.maxSize;
      const entry = this.buf[idx]!;
      if (entry.epoch !== epoch) {
        // Epoch mismatch anywhere → whole buffer is from a different process lifetime.
        return [];
      }
      if (entry.seq > fromSeq) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * Returns the highest seq in the buffer for the given epoch,
   * or 0 if empty / epoch mismatch.
   */
  currentSeq(epoch: string): number {
    if (this.count === 0) return 0;
    // The most recently written entry is at (head - 1 + maxSize) % maxSize.
    const lastIdx = (this.head - 1 + this.maxSize) % this.maxSize;
    const last = this.buf[lastIdx]!;
    return last.epoch === epoch ? last.seq : 0;
  }

  /** Number of entries currently stored. */
  get size(): number {
    return this.count;
  }
}
