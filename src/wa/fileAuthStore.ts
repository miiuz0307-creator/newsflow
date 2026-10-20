/**
 * Encrypted file-based auth store, for the feasibility test on a single
 * server with a persistent volume. Every value is encrypted with the tenant
 * key, exactly like the database store; production uses PgAuthStore.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { TenantCipher } from '../crypto/keyring.js';
import type { AuthStore } from './authStore.js';
import { deserialize, serialize } from './authStore.js';

export class FileAuthStore implements AuthStore {
  private readonly dir: string;

  constructor(root: string, public readonly accountId: string, private readonly cipher: TenantCipher) {
    this.dir = path.join(root, accountId.replace(/[^A-Za-z0-9_-]/g, '_'));
  }

  private file(key: string) {
    // Key names can contain ':' and '/'; hash them into safe file names.
    return path.join(this.dir, createHash('sha256').update(key).digest('hex').slice(0, 40) + '.enc');
  }
  private purpose(key: string) {
    return `wa-auth:${this.accountId}:${key}`;
  }

  private async get(key: string): Promise<unknown | undefined> {
    try {
      const blob = await readFile(this.file(key), 'utf8');
      return deserialize(this.cipher.decryptString(this.purpose(key), blob));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  private async put(key: string, value: unknown) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = this.file(key) + '.tmp';
    await writeFile(tmp, this.cipher.encrypt(this.purpose(key), serialize(value)), { mode: 0o600 });
    const { rename } = await import('node:fs/promises');
    await rename(tmp, this.file(key)); // atomic replace: a crash never leaves half a file
  }

  async readCreds() {
    return (await this.get('creds')) ?? null;
  }
  async writeCreds(creds: unknown) {
    await this.put('creds', creds);
  }
  async hasCreds() {
    return (await this.get('creds')) !== undefined;
  }
  async getKeys(type: string, ids: string[]) {
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const v = await this.get(`key:${type}:${id}`);
      if (v !== undefined) out[id] = v;
    }
    return out;
  }
  async setKeys(data: Record<string, Record<string, unknown | null>>) {
    for (const [type, entries] of Object.entries(data)) {
      for (const [id, value] of Object.entries(entries)) {
        const key = `key:${type}:${id}`;
        if (value === null || value === undefined) await rm(this.file(key), { force: true });
        else await this.put(key, value);
      }
    }
  }
  async wipe() {
    await rm(this.dir, { recursive: true, force: true });
  }
  async fileCount(): Promise<number> {
    return (await readdir(this.dir).catch(() => [])).length;
  }
}
