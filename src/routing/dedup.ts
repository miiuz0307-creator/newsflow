/**
 * Duplicate suppression: the same news item arriving from two source groups
 * (or the same message replayed after a crash) is sent to each target once.
 */
export interface DedupStore {
  /**
   * Atomically claims `key` for `ttlMs`. Returns true if this caller got it
   * (first time), false if it was already claimed and not yet expired.
   */
  claim(key: string, ttlMs: number): Promise<boolean>;
}

export class MemoryDedupStore implements DedupStore {
  private readonly keys = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const t = this.now();
    const exp = this.keys.get(key);
    if (exp !== undefined && exp > t) return false;
    this.keys.set(key, t + ttlMs);
    if (this.keys.size > 50_000) this.sweep(t);
    return true;
  }

  private sweep(t: number) {
    for (const [k, exp] of this.keys) if (exp <= t) this.keys.delete(k);
  }
}
