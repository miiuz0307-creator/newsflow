/** Test helpers: a fake browser device that can read web push messages (RFC 8291, receiving side). */
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';

const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();

/** What a browser does with a push message (RFC 8291, receiving side). */
export function decryptPush(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const prkKey = hmac(auth, ua.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, 'last-record delimiter');
  return plain.subarray(0, end).toString('utf8');
}

export function fakeDevice() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  return { priv: ua.getPrivateKey(), auth, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

