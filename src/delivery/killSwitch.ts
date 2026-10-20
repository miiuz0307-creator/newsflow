/**
 * Emergency stops ("kill switches") at four levels. When any switch that
 * covers a job is active, the job is not sent.
 *
 *   global  — the whole system (owner/admin only)
 *   tenant  — one customer
 *   account — one WhatsApp number or Telegram bot (set automatically on a ban or repeated rate limits)
 *   route   — one distribution route
 */
export type KillScope = 'global' | 'tenant' | 'account' | 'route';

export interface KillSwitch {
  scope: KillScope;
  scopeId: string;
  tenantId: string | null;
  reason: string;
  setBy: string;
  setAt: Date;
}

export interface KillTarget {
  tenantId: string;
  accountId: string;
  routeId?: string;
}

export interface KillSwitchStore {
  set(s: Omit<KillSwitch, 'setAt'>): Promise<void>;
  clear(scope: KillScope, scopeId: string, by: string): Promise<void>;
  /** The first active switch covering the target, or null. */
  find(t: KillTarget): Promise<KillSwitch | null>;
  list(tenantId?: string): Promise<KillSwitch[]>;
}

export class MemoryKillSwitchStore implements KillSwitchStore {
  private readonly active = new Map<string, KillSwitch>();

  async set(s: Omit<KillSwitch, 'setAt'>) {
    if ((s.scope === 'global') !== (s.tenantId === null)) throw new Error('global switches have no tenant; others must');
    const existing = this.active.get(`${s.scope}:${s.scopeId}`);
    // A customer's stop never replaces a stop set by an administrator or the system.
    if (existing && !existing.setBy.startsWith('user:') && s.setBy.startsWith('user:')) return;
    this.active.set(`${s.scope}:${s.scopeId}`, { ...s, setAt: new Date() });
  }
  async clear(scope: KillScope, scopeId: string) {
    this.active.delete(`${scope}:${scopeId}`);
  }
  async find(t: KillTarget) {
    return (
      this.active.get('global:*') ??
      this.active.get(`tenant:${t.tenantId}`) ??
      this.active.get(`account:${t.accountId}`) ??
      (t.routeId ? this.active.get(`route:${t.routeId}`) : undefined) ??
      null
    );
  }
  async list(tenantId?: string) {
    return [...this.active.values()].filter((s) => !tenantId || s.tenantId === tenantId || s.tenantId === null);
  }
}

/**
 * Wraps a store with a short cache, so the dispatcher can check switches for
 * every job without a database round trip each time. Setting or clearing
 * through the wrapper invalidates immediately; switches set elsewhere take
 * effect within `ttlMs`.
 */
export class CachedKillSwitches implements KillSwitchStore {
  private cache = new Map<string, { at: number; v: KillSwitch | null }>();
  constructor(private readonly inner: KillSwitchStore, private readonly ttlMs = 2_000) {}

  async set(s: Omit<KillSwitch, 'setAt'>) {
    this.cache.clear();
    await this.inner.set(s);
  }
  async clear(scope: KillScope, scopeId: string, by: string) {
    this.cache.clear();
    await this.inner.clear(scope, scopeId, by);
  }
  async find(t: KillTarget) {
    const k = `${t.tenantId}|${t.accountId}|${t.routeId ?? ''}`;
    const c = this.cache.get(k);
    if (c && Date.now() - c.at < this.ttlMs) return c.v;
    const v = await this.inner.find(t);
    this.cache.set(k, { at: Date.now(), v });
    return v;
  }
  list(tenantId?: string) {
    return this.inner.list(tenantId);
  }
}
