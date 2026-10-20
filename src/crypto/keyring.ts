/**
 * Envelope encryption for tenant secrets (WhatsApp sessions, Telegram tokens).
 *
 * - A master key (from a KMS or env in development) never touches the database.
 * - Each tenant gets its own random 32-byte data key (DEK). The DEK is stored
 *   in the database only in wrapped form (encrypted with the master key).
 * - Secrets are encrypted with AES-256-GCM using the tenant's DEK. The
 *   additional authenticated data (AAD) binds each ciphertext to its tenant
 *   and purpose, so a blob copied into another tenant's row fails to decrypt.
 *
 * Blob format (base64 of): version(1) | iv(12) | tag(16) | ciphertext
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export class CryptoError extends Error {}

function aead(key: Buffer, plaintext: Buffer, aad: string): string {
  if (key.length !== 32) throw new CryptoError('key must be 32 bytes');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]).toString('base64');
}

function unaead(key: Buffer, blobB64: string, aad: string): Buffer {
  const blob = Buffer.from(blobB64, 'base64');
  if (blob.length < 1 + IV_LEN + TAG_LEN) throw new CryptoError('ciphertext too short');
  if (blob[0] !== VERSION) throw new CryptoError(`unknown blob version ${blob[0]}`);
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = blob.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CryptoError('decryption failed (wrong key, tenant or tampered data)');
  }
}

export interface WrappedKey {
  masterKeyId: string;
  wrapped: string;
}

/** Wraps and unwraps tenant data keys with the master key. */
export class MasterKey {
  private readonly key: Buffer;
  constructor(public readonly id: string, keyB64: string) {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) throw new CryptoError('master key must be 32 bytes (base64)');
    this.key = key;
  }

  static generateB64(): string {
    return randomBytes(32).toString('base64');
  }

  newTenantKey(tenantId: string): { dek: Buffer; wrapped: WrappedKey } {
    const dek = randomBytes(32);
    return { dek, wrapped: { masterKeyId: this.id, wrapped: aead(this.key, dek, `dek:${tenantId}`) } };
  }

  unwrap(tenantId: string, w: WrappedKey): Buffer {
    if (w.masterKeyId !== this.id) {
      throw new CryptoError(`key ${w.masterKeyId} is not loaded (have ${this.id})`);
    }
    return unaead(this.key, w.wrapped, `dek:${tenantId}`);
  }
}

/** Encrypts secrets for exactly one tenant. */
export class TenantCipher {
  constructor(private readonly tenantId: string, private readonly dek: Buffer) {
    if (dek.length !== 32) throw new CryptoError('tenant key must be 32 bytes');
  }

  encrypt(purpose: string, plaintext: string | Buffer): string {
    const buf = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    return aead(this.dek, buf, `${this.tenantId}:${purpose}`);
  }

  decrypt(purpose: string, blob: string): Buffer {
    return unaead(this.dek, blob, `${this.tenantId}:${purpose}`);
  }

  decryptString(purpose: string, blob: string): string {
    return this.decrypt(purpose, blob).toString('utf8');
  }

  encryptJson(purpose: string, value: unknown): string {
    return this.encrypt(purpose, JSON.stringify(value));
  }

  decryptJson<T>(purpose: string, blob: string): T {
    return JSON.parse(this.decryptString(purpose, blob)) as T;
  }
}

/** Constant-time comparison for tokens and signatures. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
