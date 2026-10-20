/**
 * Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30 s) — the
 * standard used by Google Authenticator, Authy, 1Password, etc. Required for
 * every Super Admin login.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from '../crypto/keyring.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, timeMs = Date.now(), step = 30): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Accepts the current code and one step either side (clock drift). Returns the
 * matched time step, or null. Callers store the step and refuse any step not
 * strictly greater than the last one used, so each code works only once.
 */
export function verifyTotpStep(secret: string, code: string, timeMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  for (const d of [-1, 0, 1]) {
    const t = timeMs + d * 30_000;
    if (safeEqual(totpCode(secret, t), code)) return Math.floor(t / 30_000);
  }
  return null;
}

export function verifyTotp(secret: string, code: string, timeMs = Date.now()): boolean {
  return verifyTotpStep(secret, code, timeMs) !== null;
}

/** TOTP secrets are stored encrypted with a key derived from the master key. */
export function totpCipherKey(masterKeyB64: string): Buffer {
  return createHmac('sha256', Buffer.from(masterKeyB64, 'base64')).update('admin-totp-v1').digest();
}

export function otpauthUrl(secret: string, account: string, issuer = 'NewsFlow Admin'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
