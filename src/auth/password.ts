/**
 * Password hashing with scrypt (memory-hard, built into Node.js).
 * Format: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
 * Parameters are stored with each hash, so they can be raised later and old
 * hashes still verify (and can be re-hashed on next login).
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash!, 'base64');
  const key = await scrypt(password, Buffer.from(salt!, 'base64'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash that never matches, used to spend the same time when the email doesn't exist. */
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$AAAAAAAAAAAAAAAAAAAAAA==$${Buffer.alloc(KEYLEN).toString('base64')}`;

export interface PasswordProblem {
  code: 'too_short' | 'too_long' | 'too_common' | 'contains_email';
  message: string;
}

const COMMON = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'qwertyui', 'qwerty123', '11111111', 'abcdefgh', '00000000', 'iloveyou']);

/** Minimal policy (NIST 800-63B style): length and a deny-list, no composition rules. */
export function checkPassword(password: string, email?: string): PasswordProblem | null {
  if ([...password].length < 8) return { code: 'too_short', message: 'הסיסמה צריכה להכיל לפחות 8 תווים' };
  if (password.length > 200) return { code: 'too_long', message: 'הסיסמה ארוכה מדי' };
  if (COMMON.has(password.toLowerCase())) return { code: 'too_common', message: 'הסיסמה נפוצה מדי; בחר סיסמה אחרת' };
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return { code: 'contains_email', message: 'הסיסמה לא יכולה להכיל את כתובת האימייל' };
  return null;
}
