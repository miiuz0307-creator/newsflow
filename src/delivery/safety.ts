/**
 * Watches for warning signs and stops sending before they get worse.
 *
 * Rules (all thresholds configurable):
 *  - Number banned / logged out / replaced / unable to reconnect → account
 *    kill switch at once. Only the customer (or an admin) can resume.
 *  - Platform says "slow down" (rate_limited) → account cools down for
 *    `rateLimitCooldownMs`. A second time within an hour → account kill
 *    switch: something is wrong and a human should look.
 *  - Several hard failures in a row from one account → account kill switch.
 *  - Repeated "not allowed to post" into one target → the target is flagged
 *    so the customer can fix or remove it.
 *
 * It never changes identities, numbers or timing to get past a limit.
 */
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { SafetySignal } from '../wa/connectionManager.js';
import type { KillSwitchStore } from './killSwitch.js';
import type { RateLimiter } from './rateLimiter.js';

export type SafetyEventKind =
  | 'account_blocked'
  | 'logged_out'
  | 'replaced'
  | 'reconnect_exhausted'
  | 'rate_limited'
  | 'repeated_rate_limit'
  | 'consecutive_failures'
  | 'target_forbidden';

export interface SafetyEvent {
  tenantId: string;
  accountId: string;
  kind: SafetyEventKind;
  detail: Record<string, unknown>;
  at: Date;
  /** True when sending from the account was stopped by this event. */
  stoppedAccount: boolean;
}

export interface SafetyOptions {
  killSwitches: KillSwitchStore;
  limiter: RateLimiter;
  /** Persist and notify (database row, push to the customer, alert to admins). */
  onEvent?: (e: SafetyEvent) => void | Promise<void>;
  logger?: Logger;
  rateLimitCooldownMs?: number;
  repeatedRateLimitWindowMs?: number;
  maxConsecutiveFailures?: number;
  targetForbiddenThreshold?: number;
  now?: () => number;
}

export class SafetyMonitor {
  private rateLimitHits = new Map<string, number[]>();
  private consecutiveFailures = new Map<string, number>();
  private forbiddenByTarget = new Map<string, number>();
  private readonly log: Logger;
  private readonly o: Required<Omit<SafetyOptions, 'onEvent' | 'logger'>> & Pick<SafetyOptions, 'onEvent'>;

  constructor(opts: SafetyOptions) {
    this.log = (opts.logger ?? silentLogger).child({ component: 'safety' });
    this.o = {
      killSwitches: opts.killSwitches,
      limiter: opts.limiter,
      onEvent: opts.onEvent,
      rateLimitCooldownMs: opts.rateLimitCooldownMs ?? 15 * 60_000,
      repeatedRateLimitWindowMs: opts.repeatedRateLimitWindowMs ?? 60 * 60_000,
      maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 5,
      targetForbiddenThreshold: opts.targetForbiddenThreshold ?? 3,
      now: opts.now ?? Date.now,
    };
  }

  /** From the connection manager: the session itself is in trouble. */
  async onConnectionSignal(s: SafetySignal): Promise<void> {
    await this.stopAccount(s.tenantId, s.accountId, s.kind, `connection: ${s.kind}`, {});
  }

  async onSendSuccess(accountId: string, targetKey: string): Promise<void> {
    this.consecutiveFailures.set(accountId, 0);
    this.forbiddenByTarget.delete(targetKey);
  }

  async onSendError(tenantId: string, accountId: string, targetKey: string, kind: string, retryAfterMs?: number): Promise<void> {
    const t = this.o.now();
    if (kind === 'account_blocked') {
      await this.stopAccount(tenantId, accountId, 'account_blocked', 'platform reported the account as blocked', {});
      return;
    }
    if (kind === 'rate_limited') {
      const hits = (this.rateLimitHits.get(accountId) ?? []).filter((x) => t - x < this.o.repeatedRateLimitWindowMs);
      hits.push(t);
      this.rateLimitHits.set(accountId, hits);
      if (hits.length >= 2) {
        await this.stopAccount(tenantId, accountId, 'repeated_rate_limit', 'rate limited twice within an hour', { hits: hits.length });
        return;
      }
      const until = t + Math.max(this.o.rateLimitCooldownMs, retryAfterMs ?? 0);
      this.o.limiter.coolDown(accountId, until);
      await this.emit({ tenantId, accountId, kind: 'rate_limited', detail: { cooldownUntil: new Date(until).toISOString() }, at: new Date(t), stoppedAccount: false });
      return;
    }
    if (kind === 'forbidden' || kind === 'not_found') {
      const n = (this.forbiddenByTarget.get(targetKey) ?? 0) + 1;
      this.forbiddenByTarget.set(targetKey, n);
      if (n === this.o.targetForbiddenThreshold) {
        await this.emit({ tenantId, accountId, kind: 'target_forbidden', detail: { target: targetKey, failures: n }, at: new Date(t), stoppedAccount: false });
      }
    }
    if (kind !== 'transient' && kind !== 'disconnected') {
      const n = (this.consecutiveFailures.get(accountId) ?? 0) + 1;
      this.consecutiveFailures.set(accountId, n);
      if (n >= this.o.maxConsecutiveFailures) {
        await this.stopAccount(tenantId, accountId, 'consecutive_failures', `${n} failed sends in a row`, { failures: n });
      }
    }
  }

  private async stopAccount(tenantId: string, accountId: string, kind: SafetyEventKind, reason: string, detail: Record<string, unknown>) {
    await this.o.killSwitches.set({ scope: 'account', scopeId: accountId, tenantId, reason, setBy: 'system:auto' });
    this.log.warn('account stopped', { tenantId, accountId, kind });
    await this.emit({ tenantId, accountId, kind, detail, at: new Date(this.o.now()), stoppedAccount: true });
  }

  private async emit(e: SafetyEvent) {
    try {
      await this.o.onEvent?.(e);
    } catch (err) {
      this.log.error('safety event handler failed', { err: String(err) });
    }
  }
}
