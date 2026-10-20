import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChannelSender, InboundMessage, MessageContent } from '../src/core/types.js';
import { SendError } from '../src/core/types.js';
import { Dispatcher } from '../src/delivery/dispatcher.js';
import { MemoryKillSwitchStore } from '../src/delivery/killSwitch.js';
import { MemoryMediaStore } from '../src/delivery/mediaStore.js';
import { MemoryJobQueue } from '../src/delivery/queue.js';
import { RateLimiter, type RateRules } from '../src/delivery/rateLimiter.js';
import { SafetyMonitor, type SafetyEvent } from '../src/delivery/safety.js';
import { InboundPipeline, MemoryRouteSource } from '../src/engine/pipeline.js';
import { MemoryDedupStore } from '../src/routing/dedup.js';
import { Router } from '../src/routing/router.js';
import type { Route } from '../src/routing/types.js';

const SRC = { platform: 'wa' as const, accountId: 'acc1', chatId: 'src@g.us' };
const targets = Array.from({ length: 5 }, (_, i) => ({ platform: 'wa' as const, accountId: 'acc1', chatId: `t${i}@g.us`, title: `יעד ${i}` }));

class Clock {
  t = Date.parse('2026-10-20T10:00:00Z');
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

class ScriptedSender implements ChannelSender {
  readonly platform = 'wa' as const;
  sent: { chatId: string; content: MessageContent }[] = [];
  /** Errors to throw for the next sends, in order. */
  script: (SendError | null)[] = [];
  constructor(public readonly accountId: string) {}
  async send(chatId: string, content: MessageContent) {
    const e = this.script.shift();
    if (e) throw e;
    this.sent.push({ chatId, content });
    return { messageId: `out${this.sent.length}`, sentAt: new Date() };
  }
}

function harness(rules: Partial<RateRules> = {}) {
  const clock = new Clock();
  const queue = new MemoryJobQueue(clock.now);
  const ks = new MemoryKillSwitchStore();
  const media = new MemoryMediaStore();
  const fullRules: RateRules = { accountMinGapMs: 0, accountPerMinute: 1000, chatMinGapMs: 0, dailyCap: 10_000, ...rules };
  const limiter = new RateLimiter(() => fullRules, (acc) => queue.sentCountSince(acc, new Date(clock.now() - 86_400_000)), clock.now);
  const events: SafetyEvent[] = [];
  const safety = new SafetyMonitor({ killSwitches: ks, limiter, onEvent: (e) => void events.push(e), now: clock.now });
  const sender = new ScriptedSender('acc1');
  const dispatcher = new Dispatcher({
    workerId: 'w1', queue, killSwitches: ks, limiter, safety, media,
    senderFor: (_p, acc) => (acc === 'acc1' ? sender : undefined),
    now: clock.now, retryDelaysMs: [1000, 2000, 4000],
  });
  const routes = new MemoryRouteSource();
  const route: Route = { id: 'r1', tenantId: 'ten1', name: 'r', enabled: true, sources: [SRC], targets, filters: {}, requireApproval: false };
  routes.upsertRoute(route);
  const router = new Router({ dedup: new MemoryDedupStore(clock.now), templates: () => undefined, now: () => new Date(clock.now()) });
  const pipeline = new InboundPipeline({ routes, router, queue, media });
  let n = 0;
  const inbound = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
    tenantId: 'ten1', source: SRC, messageId: `in${++n}`, senderId: 's', fromSelf: false, isForwarded: false,
    receivedAt: new Date(clock.now()), content: { kind: 'text', text }, ...over,
  });
  return { clock, queue, ks, media, limiter, safety, events, sender, dispatcher, routes, route, pipeline, inbound };
}

describe('pipeline + dispatcher', () => {
  test('one inbound message is delivered once to every target', async () => {
    const h = harness();
    const m = h.inbound('מבזק: אזעקה');
    assert.equal((await h.pipeline.handle(m)).inserted, 5);
    assert.equal((await h.pipeline.handle(m)).inserted, 0, 'replaying the same message enqueues nothing');
    const s = await h.dispatcher.tick();
    assert.equal(s.sent, 5);
    assert.deepEqual(h.sender.sent.map((x) => x.chatId).sort(), targets.map((t) => t.chatId).sort());
    assert.equal((await h.dispatcher.tick()).claimed, 0);
  });

  test('approval holds the message until the customer approves', async () => {
    const h = harness();
    h.route.requireApproval = true;
    await h.pipeline.handle(h.inbound('לאישור'));
    assert.equal((await h.dispatcher.tick()).claimed, 0);
    const pending = await h.queue.listPendingApproval('ten1');
    assert.equal(pending.length, 5);
    assert.equal(await h.queue.approve('other-tenant', pending[0]!.id), false, 'cannot approve another tenant\'s job');
    for (const j of pending.slice(0, 3)) assert.equal(await h.queue.approve('ten1', j.id), true);
    await h.queue.reject('ten1', pending[3]!.id);
    assert.equal((await h.dispatcher.tick()).sent, 3);
  });

  test('media is stored once and sent to each target', async () => {
    const h = harness();
    const data = Buffer.from('fake-jpeg-bytes');
    await h.pipeline.handle(h.inbound('', { content: { kind: 'image', text: 'תמונה', media: { mimeType: 'image/jpeg', data } } }));
    const job = [...h.queue.jobs.values()][0]!;
    assert.ok(job.content.media?.ref, 'job holds a reference');
    assert.equal(job.content.media?.data, undefined, 'job does not hold bytes');
    await h.dispatcher.tick();
    assert.equal(h.sender.sent.length, 5);
    assert.ok(h.sender.sent.every((s) => s.content.media?.data?.equals(data)));
  });

  test('rate limits space out sends instead of dropping them', async () => {
    const h = harness({ accountMinGapMs: 3000, chatMinGapMs: 0 });
    await h.pipeline.handle(h.inbound('x'));
    let s = await h.dispatcher.tick();
    assert.equal(s.sent, 1);
    assert.equal(s.deferred, 4);
    for (let i = 0; i < 4; i++) {
      h.clock.advance(3000);
      s = await h.dispatcher.tick();
      assert.equal(s.sent, 1);
    }
    assert.equal(h.sender.sent.length, 5);
    const sent = [...h.queue.jobs.values()].filter((j) => j.status === 'sent');
    assert.ok(sent.every((j) => j.attempts === 1), 'deferrals do not count as attempts');
  });

  test('daily cap from the plan', async () => {
    const h = harness({ dailyCap: 3 });
    await h.pipeline.handle(h.inbound('x'));
    const s = await h.dispatcher.tick();
    assert.equal(s.sent, 3);
    assert.equal(s.deferred, 2);
  });

  test('transient errors retry with backoff, then fail', async () => {
    const h = harness();
    h.route.targets = [targets[0]!];
    await h.pipeline.handle(h.inbound('x'));
    h.sender.script = [new SendError('transient', 'timeout'), new SendError('transient', 'timeout'), new SendError('transient', 'timeout'), new SendError('transient', 'timeout')];
    assert.equal((await h.dispatcher.tick()).retried, 1);
    assert.equal((await h.dispatcher.tick()).claimed, 0, 'waits for backoff');
    h.clock.advance(1000); assert.equal((await h.dispatcher.tick()).retried, 1);
    h.clock.advance(2000); assert.equal((await h.dispatcher.tick()).retried, 1);
    h.clock.advance(4000); assert.equal((await h.dispatcher.tick()).failed, 1);
    const j = [...h.queue.jobs.values()][0]!;
    assert.equal(j.status, 'failed');
    assert.equal(j.attempts, 4);
  });

  test('forbidden target fails without retry and is flagged after repeats', async () => {
    const h = harness();
    h.route.targets = [targets[0]!];
    for (let i = 0; i < 3; i++) {
      await h.pipeline.handle(h.inbound(`msg ${i}`));
      h.sender.script = [new SendError('forbidden', 'only admins')];
      assert.equal((await h.dispatcher.tick()).failed, 1);
    }
    assert.ok(h.events.some((e) => e.kind === 'target_forbidden' && !e.stoppedAccount));
  });

  test('a platform rate-limit cools the account; a second one stops it', async () => {
    const h = harness();
    await h.pipeline.handle(h.inbound('x'));
    h.sender.script = [new SendError('rate_limited', 'rate-overlimit')];
    const s = await h.dispatcher.tick();
    assert.equal(s.sent, 0, 'nothing else is sent during cooldown');
    assert.equal(h.events[0]?.kind, 'rate_limited');
    assert.equal(await h.ks.find({ tenantId: 'ten1', accountId: 'acc1' }), null, 'first time: cooldown only');
    h.clock.advance(16 * 60_000);
    h.sender.script = [new SendError('rate_limited', 'rate-overlimit')];
    await h.dispatcher.tick();
    const sw = await h.ks.find({ tenantId: 'ten1', accountId: 'acc1' });
    assert.equal(sw?.setBy, 'system:auto');
    assert.ok(h.events.some((e) => e.kind === 'repeated_rate_limit' && e.stoppedAccount));
    h.clock.advance(60 * 60_000);
    const after = await h.dispatcher.tick();
    assert.equal(after.sent, 0, 'stopped account sends nothing until a human resumes it');
  });

  test('a ban stops the account at once and the job fails', async () => {
    const h = harness();
    await h.pipeline.handle(h.inbound('x'));
    h.sender.script = [new SendError('account_blocked', 'banned')];
    const s = await h.dispatcher.tick();
    assert.equal(s.failed, 1);
    assert.equal(s.sent, 0);
    assert.ok(await h.ks.find({ tenantId: 'ten1', accountId: 'acc1' }));
  });

  test('kill switches at every level hold jobs; clearing resumes', async () => {
    for (const scope of ['global', 'tenant', 'account', 'route'] as const) {
      const h = harness();
      const scopeId = { global: '*', tenant: 'ten1', account: 'acc1', route: 'r1' }[scope];
      await h.ks.set({ scope, scopeId, tenantId: scope === 'global' ? null : 'ten1', reason: 'test', setBy: 'admin' });
      await h.pipeline.handle(h.inbound('x'));
      const s = await h.dispatcher.tick();
      assert.equal(s.sent, 0, `${scope} switch must block`);
      assert.equal(s.deferred, 5);
      await h.ks.clear(scope, scopeId);
      h.clock.advance(61_000);
      assert.equal((await h.dispatcher.tick()).sent, 5, `${scope} cleared resumes`);
    }
  });

  test('stale jobs are skipped instead of sending old news', async () => {
    const h = harness();
    await h.ks.set({ scope: 'account', scopeId: 'acc1', tenantId: 'ten1', reason: 'paused', setBy: 'customer' });
    await h.pipeline.handle(h.inbound('ישן'));
    await h.dispatcher.tick();
    await h.ks.clear('account', 'acc1');
    h.clock.advance(3 * 60 * 60_000);
    const s = await h.dispatcher.tick();
    assert.equal(s.skipped, 5);
    assert.equal(h.sender.sent.length, 0);
  });

  test('a crashed worker\'s jobs are picked up again', async () => {
    const h = harness();
    await h.pipeline.handle(h.inbound('x'));
    const claimed = await h.queue.claim('dead-worker', 10, 1000);
    assert.equal(claimed.length, 5);
    assert.equal((await h.dispatcher.tick()).claimed, 0, 'locked jobs are not taken');
    h.clock.advance(1001);
    assert.equal((await h.dispatcher.tick()).sent, 5);
  });

  test('jobs for accounts on other workers are left for them', async () => {
    const h = harness();
    h.route.targets = [{ platform: 'wa', accountId: 'acc-elsewhere', chatId: 'z@g.us' }];
    await h.pipeline.handle(h.inbound('x'));
    const s = await h.dispatcher.tick();
    assert.equal(s.deferred, 1);
    assert.equal(s.sent, 0);
  });
});
