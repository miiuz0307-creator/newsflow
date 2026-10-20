/**
 * Regression tests for the findings of the independent security review
 * (2026-10-20). Each test names the finding it guards.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { InboundMessage } from '../src/core/types.js';
import { parseTimestamp } from '../src/db/pg.js';
import { MemoryMediaStore } from '../src/delivery/mediaStore.js';
import { MemoryJobQueue } from '../src/delivery/queue.js';
import { InboundPipeline, MemoryRouteSource } from '../src/engine/pipeline.js';
import { createLogger } from '../src/logger.js';
import { MemoryDedupStore } from '../src/routing/dedup.js';
import { Router, findRouteCycle } from '../src/routing/router.js';
import type { PlannedJob, Route } from '../src/routing/types.js';

const SRC = { platform: 'wa' as const, accountId: 'a1', chatId: 'src@g.us' };
const T = { platform: 'wa' as const, accountId: 'a1', chatId: 't@g.us' };
const route: Route = { id: 'r', tenantId: 't', name: 'r', enabled: true, sources: [SRC], targets: [T], filters: {}, requireApproval: false };
let n = 0;
const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  tenantId: 't', source: SRC, messageId: `m${++n}`, senderId: 's', fromSelf: false, isForwarded: false, receivedAt: new Date(),
  content: { kind: 'text', text: 'ידיעה' }, ...over,
});

describe('review #1 — Postgres timestamps', () => {
  test('offsets without minutes, with minutes, UTC, no zone', () => {
    assert.equal(parseTimestamp('2026-10-20 04:17:36.78+03', true).toISOString(), '2026-10-20T01:17:36.780Z');
    assert.equal(parseTimestamp('2026-10-20 01:17:36+00', true).toISOString(), '2026-10-20T01:17:36.000Z');
    assert.equal(parseTimestamp('2026-10-20 04:17:36+05:30', true).toISOString(), '2026-10-19T22:47:36.000Z');
    assert.equal(parseTimestamp('2026-10-20 04:17:36', false).toISOString(), '2026-10-20T04:17:36.000Z');
    assert.throws(() => parseTimestamp('not a date', true));
  });
});

describe('review #5 — failed enqueue does not burn duplicate keys', () => {
  test('a redelivered message is planned again after an enqueue failure', async () => {
    const dedup = new MemoryDedupStore();
    const routes = new MemoryRouteSource();
    routes.upsertRoute(route);
    const router = new Router({ dedup, templates: () => undefined });
    const queue = new MemoryJobQueue();
    let fail = true;
    const flaky = Object.assign(Object.create(queue), {
      enqueue: async (jobs: PlannedJob[]) => {
        if (fail) throw new Error('db down');
        return queue.enqueue(jobs);
      },
    });
    const p = new InboundPipeline({ routes, router, queue: flaky });
    const m = msg();
    await assert.rejects(p.handle(m), /db down/);
    fail = false;
    const r = await p.handle(m);
    assert.equal(r.inserted, 1, 'must not be skipped as a duplicate');
  });
});

describe('review #6 — loops between routes', () => {
  const g = (id: string, acc = 'a1') => ({ platform: 'wa' as const, accountId: acc, chatId: id });
  test('detects A→B + B→A, including across accounts', () => {
    assert.ok(findRouteCycle([{ sources: [g('A')], targets: [g('B')] }, { sources: [g('B', 'a2')], targets: [g('A', 'a2')] }]));
  });
  test('detects longer cycles and allows trees', () => {
    assert.ok(findRouteCycle([
      { sources: [g('A')], targets: [g('B')] }, { sources: [g('B')], targets: [g('C')] }, { sources: [g('C')], targets: [g('A')] },
    ]));
    assert.equal(findRouteCycle([{ sources: [g('A')], targets: [g('B'), g('C')] }, { sources: [g('B')], targets: [g('C')] }]), null);
  });
  test('a message the system sent is never used as a source', async () => {
    const routes = new MemoryRouteSource();
    routes.upsertRoute(route);
    const queue = new MemoryJobQueue();
    await queue.enqueue([{ tenantId: 't', routeId: 'x', source: T, sourceMessageId: 'o', target: SRC, content: { kind: 'text', text: 'x' }, notBefore: new Date(0), requiresApproval: false, idempotencyKey: 'k' }]);
    const [j] = await queue.claim('w', 1, 1000);
    await queue.complete(j!.id, { messageId: 'OURS-1', sentAt: new Date() });
    const p = new InboundPipeline({ routes, router: new Router({ dedup: new MemoryDedupStore(), templates: () => undefined }), queue });
    const r = await p.handle(msg({ messageId: 'OURS-1' }));
    assert.equal(r.planned, 0);
    assert.equal(r.skipped[0]?.reason, 'own_forward');
  });
});

describe('review #7 — media is deleted after retention', () => {
  test('sweep removes old media only', async () => {
    let t = 0;
    const m = new MemoryMediaStore(() => t);
    await m.put('t', Buffer.from('old'), 'image/jpeg');
    t = 10_000;
    const fresh = await m.put('t', Buffer.from('new'), 'image/jpeg');
    assert.equal(await m.sweep(5_000), 1);
    assert.equal(m.size, 1);
    assert.equal((await m.get('t', fresh)).toString(), 'new');
  });
});

describe('review #9 — finishing a job that is no longer ours does nothing', () => {
  test('complete after the job was reaped and re-queued is ignored', async () => {
    let t = 0;
    const q = new MemoryJobQueue(() => t);
    await q.enqueue([{ tenantId: 't', routeId: 'r', source: SRC, sourceMessageId: 'm', target: T, content: { kind: 'text', text: 'x' }, notBefore: new Date(0), requiresApproval: false, idempotencyKey: 'k1' }]);
    const [j] = await q.claim('slow-worker', 1, 100);
    t = 200;
    await q.reapStale();
    await q.complete(j!.id, { messageId: 'late', sentAt: new Date() });
    assert.equal((await q.get(j!.id))!.status, 'queued');
  });
});

describe('review #11 — captionless images', () => {
  test('two different captionless images are both sent', async () => {
    const routes = new MemoryRouteSource();
    routes.upsertRoute(route);
    const queue = new MemoryJobQueue();
    const p = new InboundPipeline({ routes, router: new Router({ dedup: new MemoryDedupStore(), templates: () => undefined }), queue, media: new MemoryMediaStore() });
    const img = (b: string) => msg({ content: { kind: 'image', media: { mimeType: 'image/jpeg', data: Buffer.from(b) } } });
    assert.equal((await p.handle(img('photo-1'))).inserted, 1);
    assert.equal((await p.handle(img('photo-2'))).inserted, 1);
    assert.equal((await p.handle(img('photo-1'))).inserted, 0, 'the very same image is still a duplicate');
  });
  test('without bytes or size, an image is treated as unique', async () => {
    const routes = new MemoryRouteSource();
    routes.upsertRoute(route);
    const queue = new MemoryJobQueue();
    const media = new MemoryMediaStore();
    const p = new InboundPipeline({ routes, router: new Router({ dedup: new MemoryDedupStore(), templates: () => undefined }), queue, media });
    const lazy = () => msg({ content: { kind: 'image', media: { mimeType: 'image/jpeg', load: async () => Buffer.from(String(Math.random())) } } });
    assert.equal((await p.handle(lazy())).inserted, 1);
    assert.equal((await p.handle(lazy())).inserted, 1);
  });
});

describe('review #13 — log redaction', () => {
  test('partial and nested secret keys are redacted', () => {
    const lines: string[] = [];
    const log = createLogger({}, 'info', (l) => lines.push(l));
    log.info('x', { accessToken: 'AAA', wrapped_dek: 'BBB', nested: { token_blob: 'CCC', a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } }, phoneNumber: '972500000001', accountId: 'keep-me' });
    const out = lines[0]!;
    for (const secret of ['AAA', 'BBB', 'CCC', '972500000001', 'deep']) assert.ok(!out.includes(secret), `${secret} leaked`);
    assert.ok(out.includes('keep-me'));
  });
});
