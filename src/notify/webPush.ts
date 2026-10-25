/**
 * Web Push (browser notifications) without third-party packages:
 *  - VAPID (RFC 8292): an ES256-signed token that identifies this server to the push service.
 *  - Message encryption (RFC 8291, "aes128gcm" content coding, RFC 8188).
 * Works with Chrome/Android (FCM), Firefox (Mozilla) and Safari/iPhone (Apple) push services.
 */
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type ECDH } from 'node:crypto';

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url: given to browsers as applicationServerKey. */
  publicKey: string;
  /** 32-byte private scalar, base64url. */
  privateKey: string;
}

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** Stable VAPID keys derived from a server secret, so they survive restarts without storage. */
export function vapidKeysFromSecret(secret: string, label = 'push-vapid'): VapidKeys {
  for (let i = 0; ; i++) {
    const d = createHmac('sha256', secret).update(`${label}:${i}`).digest();
    try {
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(d); // throws for the (astronomically rare) out-of-range value
      return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(d) };
    } catch {
      /* try the next value */
    }
  }
}

function vapidPrivateKeyObject(k: VapidKeys) {
  const pub = unb64u(k.publicKey);
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: k.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}

/** The Authorization header value for one push service (audience = its origin). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowS = Math.floor(Date.now() / 1000)): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  // Apple accepts tokens up to one hour; others up to 24 hours.
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowS + 50 * 60, sub: subject })));
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapidPrivateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** Encrypts a payload for one browser subscription (RFC 8291). Returns the request body. */
export function encryptPayload(sub: PushSubscriptionJson, payload: Buffer, salt = randomBytes(16), serverEcdh?: ECDH): Buffer {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const ecdh = serverEcdh ?? createECDH('prime256v1');
  if (!serverEcdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export interface PushResult { status: number; gone: boolean; detail?: string }

/** Sends one notification. `gone` = the device unsubscribed (404/410): delete it. */
export async function sendWebPush(sub: PushSubscriptionJson, data: unknown, keys: VapidKeys, subject: string,
  opts: { ttlS?: number; urgency?: 'normal' | 'high'; fetchImpl?: typeof fetch } = {}): Promise<PushResult> {
  const endpoint = new URL(sub.endpoint);
  if (endpoint.protocol !== 'https:' && !(endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost')) throw new Error('push endpoint must be https');
  const body = encryptPayload(sub, Buffer.from(JSON.stringify(data)));
  const res = await (opts.fetchImpl ?? fetch)(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(sub.endpoint, keys, subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(opts.ttlS ?? 24 * 3600),
      urgency: opts.urgency ?? 'high',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const detail = res.ok ? undefined : (await res.text().catch(() => '')).slice(0, 200);
  return { status: res.status, gone: res.status === 404 || res.status === 410, ...(detail ? { detail } : {}) };
}
