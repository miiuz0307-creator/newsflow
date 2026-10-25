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
import type { ChannelSender, InboundMessage, SyncEvent } from '../core/types.js';
import { chatKey } from '../core/types.js';
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
import { InboundPipeline, type PipelineOptions, type RouteSource } from './pipeline.js';
import { Reporter } from './reporter.js';
import { MemorySourceMessageStore, SyncPlanner, isDeleteCommand, type SourceMessageStore, type SyncOutcome } from './sync.js';

export interface WorkerOptions {
  workerId: string;
  connections: ConnectionManager;
  queue: JobQueue;
  routes: RouteSource;
  dedup: DedupStore;
  killSwitches: KillSwitchStore;
  media: MediaStore;
  /** Burns the customer's logo into videos/photos (see InboundPipeline). */
  brand?: PipelineOptions['brand'];
  /** PUSH Sync state of source messages. Default: in memory (tests, simulator). */
  sources?: SourceMessageStore;
  /** Called after each edit / delete from a control group was planned (monitoring, tests). */
  onSync?: (e: SyncEvent, out: SyncOutcome) => void;
  /** Daily send cap for an account (from its tenant's plan). */
  dailyCapFor: (accountId: string) => number;
  rulesOverride?: Partial<Record<'wa' | 'tg', Partial<Omit<RateRules, 'dailyCap'>>>>;
  onSafetyEvent?: (e: SafetyEvent) => void | Promise<void>;
  onStatus?: (e: StatusEvent) => void | Promise<void>;
  logger?: Logger;
  now?: () => number;
  dispatcherOverrides?: { retryDelaysMs?: number[]; retryJitter?: number; maxJobAgeMs?: number; killedRecheckMs?: number; batchSize?: number };
  /** Inbound messages planned at the same time; the rest wait in order. Default 16. */
  inboundConcurrency?: number;
}

type InboundItem = { kind: 'msg'; m: InboundMessage } | { kind: 'sync'; e: SyncEvent };

export class Worker {
  readonly pipeline: InboundPipeline;
  readonly dispatcher: Dispatcher;
  readonly sync: SyncPlanner;
  readonly reporter: Reporter;
  readonly sources: SourceMessageStore;
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
    this.sources = o.sources ?? new MemorySourceMessageStore();
    this.reporter = new Reporter({
      queue: o.queue, routes: o.routes, logger: o.logger, now: () => new Date(now()),
      react: async (_tenantId, src, messageId, emoji) => {
        if (src.platform === 'wa') await o.connections.react(src.accountId, src.chatId, messageId, emoji);
      },
    });
    this.sync = new SyncPlanner({ routes: o.routes, sources: this.sources, queue: o.queue, logger: o.logger, now: () => new Date(now()) });
    this.pipeline = new InboundPipeline({
      routes: o.routes, router, queue: o.queue, media: o.media, sources: this.sources, logger: o.logger, ...(o.brand ? { brand: o.brand } : {}),
      onStart: (msg, plan) => this.track(this.reporter.onDistributionStarted(msg.tenantId, msg.source, msg.messageId, plan.jobs)),
      onPlanned: (msg, plan, inserted) => {
        if (inserted) this.track(this.reporter.onDistributionPlanned(msg.tenantId, msg.source, msg.messageId, plan.jobs));
      },
    });
    this.dispatcher = new Dispatcher({
      workerId: o.workerId,
      queue: o.queue,
      killSwitches: o.killSwitches,
      limiter: this.limiter,
      safety: this.safety,
      media: o.media,
      senderFor: (platform, accountId) => this.senderFor(platform, accountId),
      accountIds: () => this.accountIds(),
      sourceState: (job) => this.sources.state(job.source, job.sourceMessageId),
      onResult: (job, outcome) => this.track(this.reporter.onJobResult(job, outcome)),
      logger: o.logger,
      now,
      ...(o.dispatcherOverrides ?? {}),
    });

    this.inboundLimit = o.inboundConcurrency ?? 16;
    o.connections.onMessage((m) => this.enqueueInbound({ kind: 'msg', m }));
    o.connections.onSync((e) => this.enqueueInbound({ kind: 'sync', e }));
    // Reads are counters only: no ordering needed, they go straight to the queue.
    // Reads are counted per copy. A one-line summary each minute shows they arrive (no names or numbers).
    const reads = { counted: 0, repeat: 0 };
    o.connections.onReceipt((r) => this.track(o.queue.recordRead(r.platform, r.chatId, r.messageId, r.readerId).then((n) => { if (n) reads.counted++; else reads.repeat++; })));
    setInterval(() => {
      if (!reads.counted && !reads.repeat) return;
      this.log.info('read receipts', { ...reads });
      reads.counted = 0; reads.repeat = 0;
    }, 60_000).unref();
    o.connections.onSafetySignal((s) => this.track(this.safety.onConnectionSignal(s)));
    if (o.onStatus) o.connections.onStatus((e) => this.track(Promise.resolve(o.onStatus!(e))));
  }

  /** Registers a Telegram bot with this worker (its inbound goes to the pipeline). */
  addTelegram(acc: TelegramAccount) {
    this.telegram.set(acc.accountId, acc);
  }

  removeTelegram(botId: string) {
    this.telegram.delete(botId);
  }

  /** Called by a TelegramAccount's onMessage hook. */
  handleTelegram(m: InboundMessage) {
    this.enqueueInbound({ kind: 'msg', m });
  }

  /** Called by a TelegramAccount's onSync hook (edits). */
  handleTelegramSync(e: SyncEvent) {
    this.enqueueInbound({ kind: 'sync', e });
  }

  /**
   * Bounded concurrency for inbound work: a burst waits in a FIFO instead of
   * opening thousands of database calls at once. Items from the same chat are
   * handled one at a time, in arrival order — an edit or delete must never be
   * planned before the message it changes. Different chats run in parallel.
   */
  private readonly inboundWaiting: InboundItem[] = [];
  private readonly busyChats = new Set<string>();
  private inboundActive = 0;
  private readonly inboundLimit: number;

  private enqueueInbound(item: InboundItem) {
    this.inboundWaiting.push(item);
    this.pumpInbound();
  }

  private pumpInbound() {
    for (let i = 0; i < this.inboundWaiting.length && this.inboundActive < this.inboundLimit; ) {
      const item = this.inboundWaiting[i]!;
      const chat = chatKey(item.kind === 'msg' ? item.m.source : item.e.source);
      if (this.busyChats.has(chat)) {
        i++;
        continue;
      }
      this.inboundWaiting.splice(i, 1);
      this.busyChats.add(chat);
      this.inboundActive++;
      this.track(
        this.handleInbound(item).finally(() => {
          this.inboundActive--;
          this.busyChats.delete(chat);
          this.pumpInbound();
        }),
      );
    }
  }

  private async handleInbound(item: InboundItem): Promise<void> {
    if (item.kind === 'sync') {
      const out = await this.sync.handle(item.e);
      if (out.handled) await this.reporter.onSyncPlanned(item.e.tenantId, item.e.source, item.e.messageId, out);
      this.o.onSync?.(item.e, out);
      return;
    }
    const m = item.m;
    // Telegram does not tell bots about deletions, so in a Telegram control group the customer
    // replies "/delete" (or "מחק") to the message. Outside control groups the reply is a normal message.
    if (m.source.platform === 'tg' && m.replyToMessageId && m.content.kind === 'text' && isDeleteCommand(m.content.text)) {
      const e: SyncEvent = { type: 'delete', tenantId: m.tenantId, source: m.source, messageId: m.replyToMessageId, senderId: m.senderId, fromSelf: m.fromSelf, at: m.receivedAt };
      const out = await this.sync.handle(e);
      if (out.handled || out.reason !== 'not_control_group') {
        if (out.handled) await this.reporter.onSyncPlanned(e.tenantId, e.source, e.messageId, out);
        this.o.onSync?.(e, out);
        return;
      }
    }
    await this.pipeline.handle(m);
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
