/**
 * The delivery loop: takes ready jobs from the queue and sends them, one
 * account at a time, under kill switches, rate limits and retry rules.
 *
 * Order of checks for every send:
 *   1. too old? → skipped as stale (news loses value; default 2 hours)
 *   2. any kill switch active (global / tenant / account / route)? → put back
 *   3. is the sending account on this worker? → put back for its owner
 *   4. rate limits → put back until the limiter's retry time
 *   5. send → done, retry, fail, or 'unknown' depending on the error kind
 *
 * Edit and delete jobs (PUSH Sync) take a separate path: they wait for the
 * copy they change to be sent, are skipped when a newer edit or a delete
 * replaced them, and fail without retrying once the platform's time window
 * for that change has passed. Repeating an edit or delete is harmless, so an
 * unknown outcome there is simply retried.
 */
import type { ChannelSender, MessageContent } from '../core/types.js';
import { CAPABILITIES, SendError, chatKey } from '../core/types.js';
import type { SourceState } from '../engine/sync.js';
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
  /** Current version / deleted flag of a source message (PUSH Sync). */
  sourceState?: (job: StoredJob) => Promise<SourceState | undefined>;
  /** Spread retries by ±this fraction so many failures don't retry in the same second. Default 0.2. */
  retryJitter?: number;
  random?: () => number;
  onResult?: (job: StoredJob, outcome: Outcome, detail?: string) => void;
  /** A send is about to be attempted (used for the ⏳ mark on scheduled messages). */
  onSendStart?: (job: StoredJob) => void;
}

export type Outcome = 'sent' | 'retry' | 'failed' | 'deferred' | 'skipped' | 'unknown';

export interface TickStats {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  deferred: number;
  skipped: number;
  unknown: number;
}

export class Dispatcher {
  private running = false;
  private loop?: Promise<void>;
  private readonly log: Logger;
  private readonly o: Required<Omit<DispatcherOptions, 'media' | 'accountIds' | 'logger' | 'onResult' | 'sourceState' | 'onSendStart'>> &
    Pick<DispatcherOptions, 'media' | 'accountIds' | 'onResult' | 'sourceState' | 'onSendStart'>;

  constructor(opts: DispatcherOptions) {
    this.log = (opts.logger ?? silentLogger).child({ component: 'dispatcher', worker: opts.workerId });
    this.o = {
      ...opts,
      batchSize: opts.batchSize ?? 50,
      // Longer than the slowest send (a large media upload can take up to 2 minutes),
      // so a job is never reclaimed by another worker while it is still being sent.
      lockMs: opts.lockMs ?? 5 * 60_000,
      maxAttempts: opts.maxAttempts ?? 4,
      // Spec: 30 seconds, 2 minutes, 5 minutes.
      retryDelaysMs: opts.retryDelaysMs ?? [30_000, 120_000, 300_000],
      retryJitter: opts.retryJitter ?? 0.2,
      random: opts.random ?? Math.random,
      maxJobAgeMs: opts.maxJobAgeMs ?? 2 * 60 * 60_000,
      killedRecheckMs: opts.killedRecheckMs ?? 60_000,
      now: opts.now ?? Date.now,
    };
  }

  /** One pass over ready jobs. Exposed for tests and the simulator. */
  async tick(): Promise<TickStats> {
    const stats: TickStats = { claimed: 0, sent: 0, retried: 0, failed: 0, deferred: 0, skipped: 0, unknown: 0 };
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
          stats[outcome === 'retry' ? 'retried' : outcome] += 1;
        }
      }),
    );
    return stats;
  }

  /** Delay before retry n (1-based), spread by jitter, never shorter than the platform asked. */
  private retryDelay(attempt: number, retryAfterMs?: number): number {
    const base = this.o.retryDelaysMs[Math.min(attempt - 1, this.o.retryDelaysMs.length - 1)] ?? 60_000;
    const spread = base * this.o.retryJitter * (this.o.random() * 2 - 1);
    return Math.max(Math.round(base + spread), retryAfterMs ?? 0);
  }

  private async process(job: StoredJob): Promise<Outcome> {
    if (job.action === 'edit' || job.action === 'delete') return this.processChange(job);
    const now = this.o.now();
    const q = this.o.queue;
    const report = (o: Outcome, d?: string) => {
      this.o.onResult?.(job, o, d);
      // Spacing between sends is expected and not logged; everything else is, without content.
      if (o !== 'deferred' || (d !== 'account_gap' && d !== 'chat_gap')) {
        this.log.info(`job ${o}`, { jobId: job.id, action: job.action, chatId: job.target.chatId, ...(d ? { detail: d } : {}) });
      }
      return o;
    };

    // A scheduled message counts its age from the time it was set to go out.
    if (now - Math.max(job.createdAt.getTime(), job.scheduledAt?.getTime() ?? 0) > this.o.maxJobAgeMs) {
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

    // The control group is the source of truth at the moment of sending: a message deleted there
    // is never sent, even from a batch claimed before the delete or from a retry.
    if (job.action === 'send' && this.o.sourceState) {
      const st = await this.o.sourceState(job);
      if (st?.deleted) {
        await q.skip(job.id, 'source_deleted');
        return report('skipped', 'source_deleted');
      }
    }

    if (job.action === 'send') this.o.onSendStart?.(job);
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
        case 'unknown':
          // The copy may already be in the group. Sending again could duplicate it, so it waits
          // for verification by the customer instead ("ממתין לאימות").
          await q.markUnknown(job.id, e.message);
          return report('unknown', e.message);
        case 'transient':
        case 'disconnected': {
          if (job.attempts >= this.o.maxAttempts) {
            await q.fail(job.id, e.kind, e.message);
            return report('failed', e.kind);
          }
          await q.retry(job.id, new Date(now + this.retryDelay(job.attempts, e.retryAfterMs)), e.kind, e.message);
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

  /** Edit or delete of a copy that was (or is being) sent. */
  private async processChange(job: StoredJob): Promise<Outcome> {
    const now = this.o.now();
    const q = this.o.queue;
    const report = (o: Outcome, d?: string) => {
      this.o.onResult?.(job, o, d);
      if (o !== 'deferred' || (d !== 'account_gap' && d !== 'chat_gap')) {
        this.log.info(`job ${o}`, { jobId: job.id, action: job.action, chatId: job.target.chatId, ...(d ? { detail: d } : {}) });
      }
      return o;
    };

    const ks = await this.o.killSwitches.find({ tenantId: job.tenantId, accountId: job.target.accountId, routeId: job.routeId });
    if (ks) {
      await q.defer(job.id, new Date(now + this.o.killedRecheckMs));
      return report('deferred', `kill switch ${ks.scope}`);
    }

    const parent = job.parentJobId ? await q.get(job.parentJobId) : undefined;
    if (!parent) {
      await q.skip(job.id, 'parent_missing');
      return report('skipped', 'parent_missing');
    }
    if (parent.status === 'queued' || parent.status === 'sending' || parent.status === 'pending_approval') {
      if (parent.status !== 'sending') {
        // The copy went back to the queue (a retry) before it was sent: change it there instead.
        if (job.action === 'delete') {
          await q.cancelUnsent(job.tenantId, job.source, job.sourceMessageId, ['send', 'edit'], 'source_deleted');
          await q.skip(job.id, 'cancelled_before_send');
          return report('skipped', 'cancelled_before_send');
        }
        if (await q.replaceUnsentContent(parent.id, { ...parent.content, text: job.content.text }, job.version)) {
          await q.skip(job.id, 'merged_into_send');
          return report('skipped', 'merged_into_send');
        }
      }
      await q.defer(job.id, new Date(now + 3_000));
      return report('deferred', 'waiting for the copy to be sent');
    }
    if (parent.status !== 'sent' || !parent.sentMessageId) {
      const why = parent.status === 'unknown' ? 'copy_unknown' : 'copy_not_sent';
      await q.skip(job.id, why);
      return report('skipped', why);
    }

    if (job.action === 'edit' && this.o.sourceState) {
      const st = await this.o.sourceState(job);
      if (st?.deleted) {
        await q.skip(job.id, 'source_deleted');
        return report('skipped', 'source_deleted');
      }
      if (st && st.version > job.version) {
        await q.skip(job.id, 'superseded');
        return report('skipped', 'superseded');
      }
    }

    const caps = CAPABILITIES[job.target.platform];
    const windowMs = job.action === 'edit' ? caps.editWindowMs : caps.deleteWindowMs;
    const sentAt = parent.sentAt?.getTime() ?? now;
    if (windowMs !== undefined && now - sentAt > windowMs) {
      await q.fail(job.id, 'window_closed', `${job.action} window of ${Math.round(windowMs / 60_000)} minutes has passed`);
      return report('failed', 'window_closed');
    }

    const sender = this.o.senderFor(job.target.platform, job.target.accountId);
    if (!sender) {
      await q.defer(job.id, new Date(now + 5_000));
      return report('deferred', 'account not on this worker');
    }
    const op = job.action === 'edit' ? sender.edit : sender.remove;
    if (!op) {
      await q.fail(job.id, 'not_supported', `${job.target.platform} connector has no ${job.action}`);
      return report('failed', 'not_supported');
    }

    const targetKey = chatKey(job.target);
    const rsv = await this.o.limiter.reserve(job.target.platform, job.target.accountId, targetKey);
    if (!rsv.ok) {
      await q.defer(job.id, rsv.retryAt);
      return report('deferred', rsv.reason);
    }

    try {
      if (job.action === 'edit') await sender.edit!(job.target.chatId, parent.sentMessageId, job.content);
      else await sender.remove!(job.target.chatId, parent.sentMessageId);
      await q.complete(job.id, { messageId: parent.sentMessageId, sentAt: new Date(now) });
      await this.o.safety.onSendSuccess(job.target.accountId, targetKey);
      return report('sent');
    } catch (err) {
      const e = err instanceof SendError ? err : new SendError('transient', String((err as Error)?.message ?? err));
      if (e.kind !== 'window_closed' && e.kind !== 'not_found') {
        await this.o.safety.onSendError(job.tenantId, job.target.accountId, targetKey, e.kind, e.retryAfterMs);
      }
      this.log.warn(`${job.action} failed`, { jobId: job.id, kind: e.kind, attempt: job.attempts });
      switch (e.kind) {
        case 'transient':
        case 'disconnected':
        case 'unknown': {
          if (job.attempts >= this.o.maxAttempts) {
            await q.fail(job.id, e.kind, e.message);
            return report('failed', e.kind);
          }
          await q.retry(job.id, new Date(now + this.retryDelay(job.attempts, e.retryAfterMs)), e.kind, e.message);
          return report('retry', e.kind);
        }
        case 'rate_limited':
          await q.defer(job.id, new Date(now + Math.max(e.retryAfterMs ?? 0, 60_000)));
          return report('deferred', 'rate_limited');
        default:
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
