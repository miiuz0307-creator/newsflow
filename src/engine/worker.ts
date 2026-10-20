/**
 * A delivery worker process: holds WhatsApp sessions and Telegram bots for a
 * set of tenants, feeds inbound messages into the pipeline and runs the
 * dispatcher. Many workers can run side by side; the database queue keeps
 * them from sending the same job twice, and each account lives on exactly
 * one worker (assignment comes from the control plane — phase 2).
 *
 * All dependencies are injected, so the same class runs with in-memory
 * stores (tests, simulator) or PostgreSQL (staging, production).
 */
import type { ChannelSender } from '../core/types.js';
import { Dispatcher } from '../delivery/dispatcher.js';
import type { KillSwitchStore } from '../delivery/killSwitch.js';
import type { MediaStore } from '../delivery/mediaStore.js';
import type { JobQueue } from '../delivery/queue.js';
import { DEFAULT_RULES, RateLimiter, type RateRules } from '../delivery/rateLimiter.js';
import { SafetyMonitor, type SafetyEvent } from '../delivery/safety.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { DedupStore } from '../routing/dedup.js';
import { Router } from '../routing/router.js';
import type { TelegramAccount } from '../telegram/account.js';
import type { ConnectionManager, StatusEvent } from '../wa/connectionManager.js';
import { InboundPipeline, type RouteSource } from './pipeline.js';

export interface WorkerOptions {
  workerId: string;
  connections: ConnectionManager;
  queue: JobQueue;
  routes: RouteSource;
  dedup: DedupStore;
  killSwitches: KillSwitchStore;
  media: MediaStore;
  /** Daily send cap for an account (from its tenant's plan). */
  dailyCapFor: (accountId: string) => number;
  rulesOverride?: Partial<Record<'wa' | 'tg', Partial<Omit<RateRules, 'dailyCap'>>>>;
  onSafetyEvent?: (e: SafetyEvent) => void | Promise<void>;
  onStatus?: (e: StatusEvent) => void | Promise<void>;
  logger?: Logger;
  now?: () => number;
  dispatcherOverrides?: { retryDelaysMs?: number[]; maxJobAgeMs?: number; killedRecheckMs?: number; batchSize?: number };
  /** Inbound messages planned at the same time; the rest wait in order. Default 16. */
  inboundConcurrency?: number;
}

export class Worker {
  readonly pipeline: InboundPipeline;
  readonly dispatcher: Dispatcher;
  readonly safety: SafetyMonitor;
  readonly limiter: RateLimiter;
  get media() {
    return this.o.media;
  }
  private readonly telegram = new Map<string, TelegramAccount>();
  private readonly log: Logger;
  private inflight = new Set<Promise<unknown>>();
  readonly errors: Error[] = [];

  constructor(private readonly o: WorkerOptions) {
    this.log = (o.logger ?? silentLogger).child({ component: 'worker', worker: o.workerId });
    const now = o.now ?? Date.now;
    this.limiter = new RateLimiter(
      (accountId, platform) => ({ ...DEFAULT_RULES[platform], ...(o.rulesOverride?.[platform] ?? {}), dailyCap: o.dailyCapFor(accountId) }),
      (accountId) => o.queue.sentCountSince(accountId, new Date(now() - 86_400_000)),
      now,
    );
    this.safety = new SafetyMonitor({ killSwitches: o.killSwitches, limiter: this.limiter, onEvent: o.onSafetyEvent, logger: o.logger, now });
    const router = new Router({ dedup: o.dedup, templates: (t, id) => o.routes.template(t, id), now: () => new Date(now()) });
    this.pipeline = new InboundPipeline({ routes: o.routes, router, queue: o.queue, media: o.media, logger: o.logger });
    this.dispatcher = new Dispatcher({
      workerId: o.workerId,
      queue: o.queue,
      killSwitches: o.killSwitches,
      limiter: this.limiter,
      safety: this.safety,
      media: o.media,
      senderFor: (platform, accountId) => this.senderFor(platform, accountId),
      accountIds: () => this.accountIds(),
      logger: o.logger,
      now,
      ...(o.dispatcherOverrides ?? {}),
    });

    this.inboundLimit = o.inboundConcurrency ?? 16;
    o.connections.onMessage((m) => this.enqueueInbound(m));
    o.connections.onSafetySignal((s) => this.track(this.safety.onConnectionSignal(s)));
    if (o.onStatus) o.connections.onStatus((e) => this.track(Promise.resolve(o.onStatus!(e))));
  }

  /** Registers a Telegram bot with this worker (its inbound goes to the pipeline). */
  addTelegram(acc: TelegramAccount) {
    this.telegram.set(acc.accountId, acc);
  }

  /** Called by a TelegramAccount's onMessage hook. */
  handleTelegram(m: Parameters<InboundPipeline['handle']>[0]) {
    this.enqueueInbound(m);
  }

  /**
   * Bounded concurrency for inbound planning: a burst (e.g. a busy source
   * group) waits in a FIFO instead of opening thousands of database calls
   * at once. Order of planning follows arrival order.
   */
  private readonly inboundWaiting: Parameters<InboundPipeline['handle']>[0][] = [];
  private inboundActive = 0;
  private readonly inboundLimit: number;

  private enqueueInbound(m: Parameters<InboundPipeline['handle']>[0]) {
    this.inboundWaiting.push(m);
    this.pumpInbound();
  }

  private pumpInbound() {
    while (this.inboundActive < this.inboundLimit && this.inboundWaiting.length) {
      const m = this.inboundWaiting.shift()!;
      this.inboundActive++;
      this.track(
        this.pipeline.handle(m).finally(() => {
          this.inboundActive--;
          this.pumpInbound();
        }),
      );
    }
  }

  /** Inbound messages waiting to be planned (for monitoring). */
  get inboundBacklog(): number {
    return this.inboundWaiting.length;
  }

  senderFor(platform: 'wa' | 'tg', accountId: string): ChannelSender | undefined {
    if (platform === 'tg') return this.telegram.get(accountId);
    return this.o.connections.getState(accountId)?.status === 'connected' ? this.o.connections.sender(accountId) : undefined;
  }

  accountIds(): string[] {
    return [...this.o.connections.listStates().map((s) => s.accountId), ...this.telegram.keys()];
  }

  /** Waits until every inbound message received so far has been planned. */
  async settle(): Promise<void> {
    while (this.inflight.size || this.inboundWaiting.length) {
      if (this.inflight.size) await Promise.allSettled([...this.inflight]);
      else await new Promise((r) => setImmediate(r));
    }
  }

  async shutdown(): Promise<void> {
    await this.dispatcher.stop();
    await this.settle();
    await Promise.all([...this.telegram.values()].map((t) => t.stop()));
    await this.o.connections.shutdown();
  }

  private track(p: Promise<unknown>) {
    const q = p.catch((err: Error) => {
      this.errors.push(err);
      this.log.error('background task failed', { err: String(err) });
    });
    this.inflight.add(q);
    void q.finally(() => this.inflight.delete(q));
  }
}
