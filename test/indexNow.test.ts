import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { submitIndexNow } from '../src/api/indexNow.js';

describe('IndexNow (Bing and others)', () => {
  test('submits the pages once per page list, with the key location, and skips bad input', async () => {
    let saved: string | null = null;
    const store = { get: async () => saved, set: async (v: string) => { saved = v; } };
    const calls: any[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response(null, { status: 202 }); }) as unknown as typeof fetch;
    const o = { origin: 'https://groupush.test', key: 'abcdef0123456789', paths: ['/', '/terms'], store, fetchImpl };
    assert.equal(await submitIndexNow(o), 'sent');
    assert.equal(calls[0].url, 'https://api.indexnow.org/indexnow');
    assert.deepEqual(calls[0].body, { host: 'groupush.test', key: 'abcdef0123456789', keyLocation: 'https://groupush.test/abcdef0123456789.txt', urlList: ['https://groupush.test/', 'https://groupush.test/terms'] });
    assert.equal(await submitIndexNow(o), 'unchanged', 'same pages: nothing sent again');
    assert.equal(await submitIndexNow({ ...o, paths: ['/', '/terms', '/privacy'] }), 'sent');
    assert.equal(calls.length, 2);
    assert.equal(await submitIndexNow({ ...o, origin: 'http://localhost:8787' }), 'skipped', 'only a real https site');
    assert.equal(await submitIndexNow({ ...o, key: 'bad key!' }), 'skipped');
    const failing = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    assert.equal(await submitIndexNow({ ...o, paths: ['/x'], fetchImpl: failing }), 'failed:403');
  });
});
