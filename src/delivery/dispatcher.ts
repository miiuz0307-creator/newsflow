/**
 * The delivery loop: takes ready jobs from the queue and sends them, one
 * account at a time, under kill switches, rate limits and retry rules.
 *
 * Order of checks for every job:
 *   1. too old? → skipped as stale (news loses value; default 2 hours)
 *   2. any kill switch active (global / tenant / account / route)? → put back
 *   3. is the sending account on this worker? → put back for its owner
 *   4. rate limits → put back until the limiter's retry time
 *   5. send → done, retry, or fail depending on the error kind
 */
import type { ChannelSender, MessageContent } from '../core/types.js';
import { SendError, chatKey } from '../core/types.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { KillSwitchStore } from './killSwitch.js';
import type { MediaStore } from './mediaStore.js';
import type { JobQueue, StoredJob } from './queue.js';
import type { RateLimiter } from './rateLimiter.js';
import type { SafetyMonitor } from './safety.js';

export interface DispatcherOptions {
  workerId: string;
  queue: JobQueue;
  killSwitches: KillSwitchStore;
  limiter: RateLimiter;
  safety: SafetyMonitor;
  media?: MediaStore;
  /** Returns a sender if this worker currently serves the account. */
  senderFor: (platform: 'wa' | 'tg', accountId: string) => ChannelSender | undefined;
  /** Accounts this worker serves; limits which jobs it claims. Undefined = all. */
  accountIds?: () => string[] | undefined;
  logger?: Logger;
  batchSize?: number;
  lockMs?: number;
  maxAttempts?: number;
  /** Delay before retry n (1-based), in ms. */
  retryDelaysMs?: number[];
  maxJobAgeMs?: number;
  /** When a kill switch blocks a job, look again after this long. */
  killedRecheckMs?: number;
  now?: () => number;
  onResult?: (job: StoredJob, outcome: 'sent' | 'retry' | 'failed' | 'deferred' | 'skipped', detail?: string) => void;
}

export interface TickStats {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  deferred: number;
  skipped: number;
}

export class Dispatcher {
  private running = false;
  private loop?: Promise<void>;
  private readonly log: Logger;
  private readonly o: Required<Omit<DispatcherOptions, 'media' | 'accountIds' | 'logger' | 'onResult'>> & Pick<DispatcherOptions, 'media' | 'accountIds' | 'onResult'>;

  constructor(opts: DispatcherOptions) {
    this.log = (opts.logger ?? silentLogger).child({ component: 'dispatcher', worker: opts.workerId });
    this.o = {
      ...opts,
      batchSize: opts.batchSize ?? 50,
      lockMs: opts.lockMs ?? 60_000,
      maxAttempts: opts.maxAttempts ?? 4,
      retryDelaysMs: opts.retryDelaysMs ?? [30_000, 120_000, 600_000],
      maxJobAgeMs: opts.maxJobAgeMs ?? 2 * 60 * 60_000,
      killedRecheckMs: opts.killedRecheckMs ?? 60_000,
      now: opts.now ?? Date.now,
    };
  }

  /** One pass over ready jobs. Exposed for tests and the simulator. */
  async tick(): Promise<TickStats> {
    const stats: TickStats = { claimed: 0, sent: 0, retried: 0, failed: 0, deferred: 0, skipped: 0 };
    await this.o.queue.reapStale();
    const ids = this.o.accountIds?.();
    const jobs = await this.o.queue.claim(this.o.workerId, this.o.batchSize, this.o.lockMs, ids ? { accountIds: ids } : undefined);
    stats.claimed = jobs.length;
    if (!jobs.length) return stats;

    // Same account → sequential (spacing); different accounts → in parallel.
    const byAccount = new Map<string, StoredJob[]>();
    for (const j of jobs) {
      const k = `${j.target.platform}:${j.target.accountId}`;
      byAccount.set(k, [...(byAccount.get(k) ?? []), j]);
    }
    await Promise.all(
      [...byAccount.values()].map(async (list) => {
        for (const job of list) {
          const outcome = await this.process(job);
          stats[outcome === 'sent' ? 'sent' : outcome === 'retry' ? 'retried' : outcome] += 1;
        }
      }),
    );
    return stats;
  }

  private async process(job: StoredJob): Promise<'sent' | 'retry' | 'failed' | 'deferred' | 'skipped'> {
    const now = this.o.now();
    const q = this.o.queue;
    const report = (o: 'sent' | 'retry' | 'failed' | 'deferred' | 'skipped', d?: string) => {
      this.o.onResult?.(job, o, d);
      return o;
    };

    if (now - job.createdAt.getTime() > this.o.maxJobAgeMs) {
      await q.skip(job.id, 'stale');
      return report('skipped', 'stale');
    }

    const ks = await this.o.killSwitches.find({ tenantId: job.tenantId, accountId: job.target.accountId, routeId: job.routeId });
    if (ks) {
      await q.defer(job.id, new Date(now + this.o.killedRecheckMs));
      return report('deferred', `kill switch ${ks.scope}`);
    }

    const sender = this.o.senderFor(job.target.platform, job.target.accountId);
    if (!sender) {
      await q.defer(job.id, new Date(now + 5_000));
      return report('deferred', 'account not on this worker');
    }

    const targetKey = chatKey(job.target);
    const rsv = await this.o.limiter.reserve(job.target.platform, job.target.accountId, targetKey);
    if (!rsv.ok) {
      await q.defer(job.id, rsv.retryAt);
      return report('deferred', rsv.reason);
    }

    let content: MessageContent = job.content;
    try {
      if (content.media?.ref && !content.media.data) {
        if (!this.o.media) throw new SendError('invalid', 'no media store configured');
        content = { ...content, media: { ...content.media, data: await this.o.media.get(job.tenantId, content.media.ref) } };
      }
      const res = await sender.send(job.target.chatId, content);
      await q.complete(job.id, res);
      await this.o.safety.onSendSuccess(job.target.accountId, targetKey);
      return report('sent');
    } catch (err) {
      const e = err instanceof SendError ? err : new SendError('transient', String((err as Error)?.message ?? err));
      await this.o.safety.onSendError(job.tenantId, job.target.accountId, targetKey, e.kind, e.retryAfterMs);
      this.log.warn('send failed', { jobId: job.id, kind: e.kind, attempt: job.attempts });
      switch (e.kind) {
        case 'transient':
        case 'disconnected': {
          if (job.attempts >= this.o.maxAttempts) {
            await q.fail(job.id, e.kind, e.message);
            return report('failed', e.kind);
          }
          const delay = this.o.retryDelaysMs[Math.min(job.attempts - 1, this.o.retryDelaysMs.length - 1)] ?? 60_000;
          await q.retry(job.id, new Date(now + delay), e.kind, e.message);
          return report('retry', e.kind);
        }
        case 'rate_limited':
          // The safety monitor has put the account in cooldown; this job waits for it.
          await q.defer(job.id, new Date(now + Math.max(e.retryAfterMs ?? 0, 60_000)));
          return report('deferred', 'rate_limited');
        default:
          // forbidden, not_found, invalid, account_blocked: retrying won't help.
          await q.fail(job.id, e.kind, e.message);
          return report('failed', e.kind);
      }
    }
  }

  /** Runs ticks until stop(); sleeps `idleMs` when there was nothing to do. */
  start(idleMs = 500): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          const s = await this.tick();
          if (!s.claimed) await new Promise((r) => setTimeout(r, idleMs));
        } catch (err) {
          this.log.error('tick failed', { err: String(err) });
          await new Promise((r) => setTimeout(r, idleMs * 4));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}
