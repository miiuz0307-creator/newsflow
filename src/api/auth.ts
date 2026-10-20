/**
 * Access tokens for the API: tenant id + user + role + expiry, signed with
 * HMAC-SHA256. Phase 1 issues them from a dev endpoint; phase 3 adds real
 * login (password hashing, refresh tokens, rate-limited sign-in).
 *
 * Format: base64url(JSON payload) "." base64url(signature)
 */
import { createHmac } from 'node:crypto';
import { safeEqual } from '../crypto/keyring.js';

export interface TokenClaims {
  tenantId: string;
  userId: string;
  role: 'owner' | 'admin' | 'editor';
  /** Expiry, seconds since epoch. */
  exp: number;
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString('base64url');
}

export function signToken(claims: Omit<TokenClaims, 'exp'>, secret: string, ttlSeconds = 3600, now = Date.now()): string {
  if (secret.length < 32) throw new Error('token secret must be at least 32 characters');
  const payload = b64url(JSON.stringify({ ...claims, exp: Math.floor(now / 1000) + ttlSeconds }));
  const sig = b64url(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyToken(token: string, secret: string, now = Date.now()): TokenClaims | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(createHmac('sha256', secret).update(payload).digest());
  if (!safeEqual(sig, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenClaims;
    if (typeof c.exp !== 'number' || c.exp * 1000 < now) return null;
    if (!/^[0-9a-f-]{36}$/i.test(c.tenantId)) return null;
    return c;
  } catch {
    return null;
  }
}
