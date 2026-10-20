/**
 * Storage for a linked device's credentials ("session").
 *
 * A session is equivalent to full access to the customer's WhatsApp account,
 * so it is only ever stored encrypted with the tenant's key. The store is a
 * simple key/value shape that maps directly onto Baileys' AuthenticationState
 * (one `creds` document plus many typed signal keys).
 */
import type { TenantCipher } from '../crypto/keyring.js';

export interface AuthStore {
  readonly accountId: string;
  readCreds(): Promise<unknown | null>;
  writeCreds(creds: unknown): Promise<void>;
  /** Returns the keys that exist among `ids`. Missing ids are simply absent. */
  getKeys(type: string, ids: string[]): Promise<Record<string, unknown>>;
  /** `null` deletes a key. */
  setKeys(data: Record<string, Record<string, unknown | null>>): Promise<void>;
  /** Deletes everything for this account. Used on logout and "disconnect and delete". */
  wipe(): Promise<void>;
  hasCreds(): Promise<boolean>;
}

/** Serializer that keeps Buffers intact through JSON (same shape as Baileys' BufferJSON). */
export const BufferJSON = {
  replacer(_k: string, value: unknown): unknown {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { type: 'Buffer', data: Buffer.from(value as Uint8Array).toString('base64') };
    }
    if (value && typeof value === 'object' && (value as { type?: string }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data)) {
      return { type: 'Buffer', data: Buffer.from((value as { data: number[] }).data).toString('base64') };
    }
    return value;
  },
  reviver(_k: string, value: unknown): unknown {
    if (value && typeof value === 'object' && (value as { type?: string }).type === 'Buffer') {
      const data = (value as { data: unknown }).data;
      return typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data as number[]);
    }
    return value;
  },
};

export function serialize(v: unknown): string {
  return JSON.stringify(v, BufferJSON.replacer);
}
export function deserialize<T>(s: string): T {
  return JSON.parse(s, BufferJSON.reviver) as T;
}

/**
 * In-memory store that still encrypts every value, so tests exercise the
 * same encryption path as production. Rows are visible via `rawRows()` for
 * tests that check nothing is kept in plaintext.
 */
export class MemoryAuthStore implements AuthStore {
  private readonly rows = new Map<string, string>();

  constructor(public readonly accountId: string, private readonly cipher: TenantCipher) {}

  private purpose(key: string): string {
    return `wa-auth:${this.accountId}:${key}`;
  }

  private put(key: string, value: unknown): void {
    this.rows.set(key, this.cipher.encrypt(this.purpose(key), serialize(value)));
  }

  private get(key: string): unknown | undefined {
    const blob = this.rows.get(key);
    if (blob === undefined) return undefined;
    return deserialize(this.cipher.decryptString(this.purpose(key), blob));
  }

  async readCreds() {
    return this.get('creds') ?? null;
  }
  async writeCreds(creds: unknown) {
    this.put('creds', creds);
  }
  async hasCreds() {
    return this.rows.has('creds');
  }
  async getKeys(type: string, ids: string[]) {
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const v = this.get(`key:${type}:${id}`);
      if (v !== undefined) out[id] = v;
    }
    return out;
  }
  async setKeys(data: Record<string, Record<string, unknown | null>>) {
    for (const [type, entries] of Object.entries(data)) {
      for (const [id, value] of Object.entries(entries)) {
        const key = `key:${type}:${id}`;
        if (value === null || value === undefined) this.rows.delete(key);
        else this.put(key, value);
      }
    }
  }
  async wipe() {
    this.rows.clear();
  }
  rawRows(): ReadonlyMap<string, string> {
    return this.rows;
  }
}
