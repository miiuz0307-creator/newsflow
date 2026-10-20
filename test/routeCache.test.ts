import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatRef } from '../src/core/types.js';
import type { RouteSource } from '../src/engine/pipeline.js';
import { CachedRouteSource } from '../src/engine/routeCache.js';
import type { Route } from '../src/routing/types.js';

const chat: ChatRef = { platform: 'wa', accountId: 'a', chatId: 'c' };
const route = (name: string): Route => ({ id: 'r', tenantId: 't', name, enabled: true, sources: [chat], targets: [], filters: {}, requireApproval: false });

function counting(results: (Route[] | Error)[]) {
  let calls = 0;
  const src: RouteSource = {
    async routesForSource() {
      const r = results[Math.min(calls++, results.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    },
    async template() {
      return undefined;
    },
  };
  return { src, calls: () => calls };
}

describe('CachedRouteSource', () => {
  test('serves from cache within the TTL, refreshes after', async () => {
    let t = 0;
    const inner = counting([[route('v1')], [route('v2')]]);
    const c = new CachedRouteSource(inner.src, 5000, () => t);
    assert.equal((await c.routesForSource(chat))[0]!.name, 'v1');
    assert.equal((await c.routesForSource(chat))[0]!.name, 'v1');
    assert.equal(inner.calls(), 1);
    t = 5001;
    assert.equal((await c.routesForSource(chat))[0]!.name, 'v2');
  });

  test('invalidate takes effect at once', async () => {
    const inner = counting([[route('v1')], [route('v2')]]);
    const c = new CachedRouteSource(inner.src);
    await c.routesForSource(chat);
    c.invalidate();
    assert.equal((await c.routesForSource(chat))[0]!.name, 'v2');
  });

  test('failures are not cached', async () => {
    const inner = counting([new Error('db down'), [route('ok')]]);
    const c = new CachedRouteSource(inner.src);
    await assert.rejects(c.routesForSource(chat));
    await new Promise((r) => setImmediate(r));
    assert.equal((await c.routesForSource(chat))[0]!.name, 'ok');
  });
});
