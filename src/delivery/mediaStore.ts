/**
 * Where media bytes wait between receiving and sending. Jobs in the database
 * hold only a reference. Production will use object storage (Cloudflare R2
 * or S3) with automatic expiry; the file store here serves development.
 *
 * References are namespaced by tenant and checked on read, so one tenant can
 * never load another tenant's file even with a guessed reference.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface MediaStore {
  put(tenantId: string, data: Buffer, mimeType: string): Promise<string>;
  get(tenantId: string, ref: string): Promise<Buffer>;
  delete(tenantId: string, ref: string): Promise<void>;
  /** Deletes media older than `maxAgeMs`. Jobs are skipped as stale long before, so nothing still needs it. */
  sweep(maxAgeMs: number): Promise<number>;
}

function checkRef(tenantId: string, ref: string): string {
  const m = /^media:([0-9a-zA-Z-]+)\/([0-9a-f-]{36})$/.exec(ref);
  if (!m || m[1] !== tenantId) throw new Error('media reference does not belong to this tenant');
  return m[2]!;
}

export class MemoryMediaStore implements MediaStore {
  private readonly files = new Map<string, Buffer>();
  private readonly added = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  async put(tenantId: string, data: Buffer, _mimeType?: string) {
    const ref = `media:${tenantId}/${randomUUID()}`;
    this.files.set(ref, data);
    this.added.set(ref, this.now());
    return ref;
  }
  async sweep(maxAgeMs: number) {
    let n = 0;
    for (const [ref, at] of this.added) {
      if (this.now() - at > maxAgeMs) {
        this.files.delete(ref);
        this.added.delete(ref);
        n++;
      }
    }
    return n;
  }
  get size() {
    return this.files.size;
  }
  async get(tenantId: string, ref: string) {
    checkRef(tenantId, ref);
    const b = this.files.get(ref);
    if (!b) throw new Error('media expired or missing');
    return b;
  }
  async delete(tenantId: string, ref: string) {
    checkRef(tenantId, ref);
    this.files.delete(ref);
  }
}

export class FileMediaStore implements MediaStore {
  constructor(private readonly root: string) {}
  private file(tenantId: string, ref: string) {
    return path.join(this.root, tenantId, checkRef(tenantId, ref));
  }
  async put(tenantId: string, data: Buffer) {
    if (!/^[0-9a-zA-Z-]+$/.test(tenantId)) throw new Error('bad tenant id');
    const ref = `media:${tenantId}/${randomUUID()}`;
    await mkdir(path.join(this.root, tenantId), { recursive: true });
    await writeFile(this.file(tenantId, ref), data, { mode: 0o600 });
    return ref;
  }
  async get(tenantId: string, ref: string) {
    return readFile(this.file(tenantId, ref));
  }
  async delete(tenantId: string, ref: string) {
    await rm(this.file(tenantId, ref), { force: true });
  }
  async sweep(maxAgeMs: number) {
    let n = 0;
    const cutoff = Date.now() - maxAgeMs;
    let tenants: string[] = [];
    try {
      tenants = await readdir(this.root);
    } catch {
      return 0;
    }
    for (const t of tenants) {
      for (const f of await readdir(path.join(this.root, t)).catch(() => [] as string[])) {
        const p = path.join(this.root, t, f);
        const st = await stat(p).catch(() => null);
        if (st && st.mtimeMs < cutoff) {
          await rm(p, { force: true });
          n++;
        }
      }
    }
    return n;
  }
}
