import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileAuthStore } from '../src/wa/fileAuthStore.js';
import { cipherFor } from './helpers.js';

test('FileAuthStore: encrypted, survives a new instance, wipe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nf-auth-'));
  const a = new FileAuthStore(root, 'acc-972500000001', cipherFor('t1'));
  await a.writeCreds({ registered: true, me: { id: '972500000001' }, k: Buffer.from([1, 2]) });
  await a.setKeys({ 'pre-key': { '1': { x: 1 }, 'a/b:c': { y: 2 } } });
  const b = new FileAuthStore(root, 'acc-972500000001', cipherFor('t1'));
  assert.deepEqual(((await b.readCreds()) as { k: Buffer }).k, Buffer.from([1, 2]));
  assert.deepEqual(await b.getKeys('pre-key', ['1', 'a/b:c', 'nope']), { '1': { x: 1 }, 'a/b:c': { y: 2 } });
  const dir = path.join(root, 'acc-972500000001');
  for (const f of await readdir(dir)) assert.ok(!(await readFile(path.join(dir, f), 'utf8')).includes('972500000001'));
  await b.setKeys({ 'pre-key': { '1': null } });
  assert.deepEqual(await b.getKeys('pre-key', ['1']), {});
  await b.wipe();
  assert.equal(await b.hasCreds(), false);
});
