import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CryptoError, MasterKey, TenantCipher, safeEqual } from '../src/crypto/keyring.js';
import { MemoryAuthStore } from '../src/wa/authStore.js';

describe('envelope encryption', () => {
  const mk = new MasterKey('mk-1', MasterKey.generateB64());

  test('tenant key round-trips through wrapping', () => {
    const { dek, wrapped } = mk.newTenantKey('tenant-a');
    assert.deepEqual(mk.unwrap('tenant-a', wrapped), dek);
  });

  test('a wrapped key cannot be unwrapped as another tenant', () => {
    const { wrapped } = mk.newTenantKey('tenant-a');
    assert.throws(() => mk.unwrap('tenant-b', wrapped), CryptoError);
  });

  test('a different master key cannot unwrap', () => {
    const other = new MasterKey('mk-1', MasterKey.generateB64());
    const { wrapped } = mk.newTenantKey('tenant-a');
    assert.throws(() => other.unwrap('tenant-a', wrapped), CryptoError);
  });

  test('ciphertext is bound to tenant and purpose', () => {
    const { dek } = mk.newTenantKey('t1');
    const a = new TenantCipher('t1', dek);
    const sameKeyOtherTenant = new TenantCipher('t2', dek);
    const blob = a.encrypt('wa-auth:acc1:creds', 'secret-session');
    assert.equal(a.decryptString('wa-auth:acc1:creds', blob), 'secret-session');
    assert.throws(() => a.decrypt('wa-auth:acc2:creds', blob), CryptoError);
    assert.throws(() => sameKeyOtherTenant.decrypt('wa-auth:acc1:creds', blob), CryptoError);
  });

  test('tampering is detected', () => {
    const { dek } = mk.newTenantKey('t1');
    const c = new TenantCipher('t1', dek);
    const blob = Buffer.from(c.encrypt('p', 'hello'), 'base64');
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0x01;
    assert.throws(() => c.decrypt('p', blob.toString('base64')), CryptoError);
  });

  test('same plaintext encrypts differently each time', () => {
    const { dek } = mk.newTenantKey('t1');
    const c = new TenantCipher('t1', dek);
    assert.notEqual(c.encrypt('p', 'x'), c.encrypt('p', 'x'));
  });

  test('rejects malformed keys', () => {
    assert.throws(() => new MasterKey('m', Buffer.alloc(16).toString('base64')), CryptoError);
    assert.throws(() => new TenantCipher('t', Buffer.alloc(31)), CryptoError);
  });

  test('safeEqual', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
  });
});

describe('MemoryAuthStore', () => {
  const mk = new MasterKey('mk-1', MasterKey.generateB64());
  const { dek } = mk.newTenantKey('t1');
  const cipher = new TenantCipher('t1', dek);

  test('stores creds and keys encrypted, Buffers intact', async () => {
    const s = new MemoryAuthStore('acc1', cipher);
    const creds = { registered: true, noiseKey: { private: Buffer.from([1, 2, 3]), public: new Uint8Array([4, 5]) } };
    await s.writeCreds(creds);
    await s.setKeys({ 'pre-key': { '1': { keyPair: Buffer.from('abc') }, '2': { x: 1 } } });
    const back = (await s.readCreds()) as { noiseKey: { private: Buffer; public: Buffer } };
    assert.deepEqual(back.noiseKey.private, Buffer.from([1, 2, 3]));
    assert.deepEqual(Buffer.from(back.noiseKey.public), Buffer.from([4, 5]));
    const keys = await s.getKeys('pre-key', ['1', '2', '3']);
    assert.deepEqual(Object.keys(keys).sort(), ['1', '2']);
    for (const raw of s.rawRows().values()) {
      assert.ok(!raw.includes('registered'), 'plaintext leaked into storage');
      assert.ok(!raw.includes('abc'));
    }
  });

  test('null deletes a key, wipe deletes everything', async () => {
    const s = new MemoryAuthStore('acc1', cipher);
    await s.writeCreds({ a: 1 });
    await s.setKeys({ session: { x: { v: 1 } } });
    await s.setKeys({ session: { x: null } });
    assert.deepEqual(await s.getKeys('session', ['x']), {});
    await s.wipe();
    assert.equal(await s.hasCreds(), false);
    assert.equal(await s.readCreds(), null);
  });
});
