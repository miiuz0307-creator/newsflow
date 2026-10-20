/**
 * Duplicate suppression: the same news item arriving from two source groups
 * (or the same message replayed after a crash) is sent to each target once.
 */
export interface DedupStore {
  /**
   * Atomically claims `key` for `ttlMs` on behalf of `tenantId`. Returns true
   * if this caller got it (first time), false if it was already claimed and
   * has not expired.
   */
  claim(tenantId: string, key: string, ttlMs: number): Promise<boolean>;
  /** Batch form of claim(): returns the keys this caller got. Optional; falls back to claim(). */
  claimMany?(tenantId: string, keys: string[], ttlMs: number): Promise<Set<string>>;
}

export class MemoryDedupStore implements DedupStore {
  private readonly keys = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  async claim(tenantId: string, key: string, ttlMs: number): Promise<boolean> {
    const k = `${tenantId}|${key}`;
    const t = this.now();
    const exp = this.keys.get(k);
    if (exp !== undefined && exp > t) return false;
    this.keys.set(k, t + ttlMs);
    if (this.keys.size > 50_000) this.sweep(t);
    return true;
  }

  async claimMany(tenantId: string, keys: string[], ttlMs: number): Promise<Set<string>> {
    const got = new Set<string>();
    for (const k of keys) if (await this.claim(tenantId, k, ttlMs)) got.add(k);
    return got;
  }

  private sweep(t: number) {
    for (const [k, exp] of this.keys) if (exp <= t) this.keys.delete(k);
  }
}
