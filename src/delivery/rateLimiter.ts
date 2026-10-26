/**
 * Send-rate limits per connected account and per target chat.
 *
 * These are load and safety limits, not a disguise: spacing is fixed and
 * predictable, there is no random "human-like" jitter, and the daily cap
 * comes from the customer's plan. A worker holds all of an account's sends,
 * so in-memory spacing is exact; the daily count comes from the database.
 */

export interface RateRules {
  /** Minimum gap between any two sends from one account. */
  accountMinGapMs: number;
  /** Maximum sends from one account in any rolling minute. */
  accountPerMinute: number;
  /** Minimum gap between two sends into the same chat. */
  chatMinGapMs: number;
  /** Maximum sends per account per rolling 24 hours (from the plan). */
  dailyCap: number;
}

/** Defaults per platform. Telegram documents ~20 msgs/min per group and ~30/s per bot. */
export const DEFAULT_RULES: Record<'wa' | 'tg', Omit<RateRules, 'dailyCap'>> = {
  // WhatsApp: 30 groups a minute per number (one every 1.5 s). Doubled from 15 at the owner's request;
  // faster sending raises the chance that WhatsApp limits the number.
  wa: { accountMinGapMs: 1_500, accountPerMinute: 30, chatMinGapMs: 10_000 },
  tg: { accountMinGapMs: 50, accountPerMinute: 600, chatMinGapMs: 3_100 },
};

export type Reservation = { ok: true } | { ok: false; retryAt: Date; reason: 'account_gap' | 'account_minute' | 'chat_gap' | 'daily_cap' | 'cooldown' };

export class RateLimiter {
  private lastByAccount = new Map<string, number>();
  private minuteWindow = new Map<string, number[]>();
  private lastByChat = new Map<string, number>();
  private cooldownUntil = new Map<string, number>();

  constructor(
    private readonly rulesFor: (accountId: string, platform: 'wa' | 'tg') => RateRules,
    private readonly sentLast24h: (accountId: string) => Promise<number>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Checks every limit and, if all pass, records the send. A refusal says
   * when to try again.
   */
  async reserve(platform: 'wa' | 'tg', accountId: string, chatKey: string): Promise<Reservation> {
    const t = this.now();
    const r = this.rulesFor(accountId, platform);

    const cool = this.cooldownUntil.get(accountId) ?? 0;
    if (cool > t) return { ok: false, retryAt: new Date(cool), reason: 'cooldown' };

    const last = this.lastByAccount.get(accountId);
    if (last !== undefined && t - last < r.accountMinGapMs) {
      return { ok: false, retryAt: new Date(last + r.accountMinGapMs), reason: 'account_gap' };
    }
    const win = (this.minuteWindow.get(accountId) ?? []).filter((x) => t - x < 60_000);
    if (win.length >= r.accountPerMinute) {
      return { ok: false, retryAt: new Date(win[0]! + 60_000), reason: 'account_minute' };
    }
    const lastChat = this.lastByChat.get(chatKey);
    if (lastChat !== undefined && t - lastChat < r.chatMinGapMs) {
      return { ok: false, retryAt: new Date(lastChat + r.chatMinGapMs), reason: 'chat_gap' };
    }
    const sent = await this.dailyCount(accountId, t);
    if (sent >= r.dailyCap) {
      // Re-check in 15 minutes; the rolling window frees up gradually.
      this.dailyCache.delete(accountId);
      return { ok: false, retryAt: new Date(t + 15 * 60_000), reason: 'daily_cap' };
    }

    win.push(t);
    this.minuteWindow.set(accountId, win);
    this.lastByAccount.set(accountId, t);
    this.lastByChat.set(chatKey, t);
    const c = this.dailyCache.get(accountId);
    if (c) c.count++;
    return { ok: true };
  }

  /**
   * The rolling 24h count comes from the database, but asking for every send
   * would cost one query per message. It is fetched at most once per
   * `dailyRefreshMs` and counted locally in between (each account lives on
   * one worker, so the local count is accurate).
   */
  private dailyCache = new Map<string, { count: number; at: number }>();
  dailyRefreshMs = 60_000;

  private async dailyCount(accountId: string, t: number): Promise<number> {
    const c = this.dailyCache.get(accountId);
    if (c && t - c.at < this.dailyRefreshMs) return c.count;
    const count = await this.sentLast24h(accountId);
    this.dailyCache.set(accountId, { count, at: t });
    return count;
  }

  /** Stops all sends from an account until `until` (after a platform rate-limit signal). */
  coolDown(accountId: string, untilMs: number) {
    this.cooldownUntil.set(accountId, Math.max(untilMs, this.cooldownUntil.get(accountId) ?? 0));
  }
}
