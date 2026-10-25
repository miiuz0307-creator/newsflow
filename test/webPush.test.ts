/**
 * Browser notifications: encryption checked against the RFC 8291 example, the VAPID
 * token checked with the public key, and a full send to a local push endpoint that
 * decrypts what it receives.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { decryptPush, fakeDevice } from './pushHelpers.js';
import { encryptPayload, sendWebPush, vapidAuthorization, vapidKeysFromSecret } from '../src/notify/webPush.js';
import { adminIconPng } from '../src/api/adminIcon.js';

describe('web push', () => {
  test('encryption matches the RFC 8291 example byte for byte', () => {
    const as = createECDH('prime256v1');
    as.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
    const out = encryptPayload({ endpoint: 'https://x', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } },
      Buffer.from('When I grow up, I want to be a watermelon'), Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), as);
    assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
    const ua = Buffer.from('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'base64url');
    assert.equal(decryptPush(out, ua, Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url')), 'When I grow up, I want to be a watermelon');
  });

  test('VAPID keys are stable per secret and the token verifies with the public key', () => {
    const k = vapidKeysFromSecret('a'.repeat(40));
    assert.deepEqual(vapidKeysFromSecret('a'.repeat(40)), k);
    assert.notEqual(vapidKeysFromSecret('b'.repeat(40)).publicKey, k.publicKey);
    assert.equal(Buffer.from(k.publicKey, 'base64url').length, 65);
    const auth = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', k, 'https://push.example', 1_000_000);
    const m = auth.match(/^vapid t=([^,]+), k=(.+)$/)!;
    assert.equal(m[2], k.publicKey);
    const [h, c, sig] = m[1]!.split('.');
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_000_000 + 3000, sub: 'https://push.example' });
    const pub = Buffer.from(k.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url')));
  });

  test('a full send reaches the push endpoint with the right headers and a readable payload', async () => {
    const dev = fakeDevice();
    let got: { headers: http.IncomingHttpHeaders; body: Buffer } | null = null;
    const srv = http.createServer((req, res) => { const parts: Buffer[] = []; req.on('data', (d) => parts.push(d)); req.on('end', () => { got = { headers: req.headers, body: Buffer.concat(parts) }; res.writeHead(201); res.end(); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const keys = vapidKeysFromSecret('c'.repeat(40));
    const r = await sendWebPush({ endpoint: `http://127.0.0.1:${port}/push/1`, keys: dev.keys }, { title: 'לקוח חדש', body: 'שלום' }, keys, 'mailto:a@b.c');
    srv.close();
    assert.equal(r.status, 201);
    assert.equal(got!.headers['content-encoding'], 'aes128gcm');
    assert.match(String(got!.headers.authorization), /^vapid t=/);
    assert.ok(Number(got!.headers.ttl) > 0);
    assert.deepEqual(JSON.parse(decryptPush(got!.body, dev.priv, dev.auth)), { title: 'לקוח חדש', body: 'שלום' });
  });

  test('the app icon is a valid PNG of the asked size', () => {
    const png = adminIconPng(192);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 192);
    assert.equal(png.readUInt32BE(20), 192);
  });
});
