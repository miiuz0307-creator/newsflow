/**
 * Where media bytes wait between receiving and sending. Jobs in the database
 * hold only a reference. Production will use object storage (Cloudflare R2
 * or S3) with automatic expiry; the file store here serves development.
 *
 * References are namespaced by tenant and checked on read, so one tenant can
 * never load another tenant's file even with a guessed reference.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface MediaStore {
  put(tenantId: string, data: Buffer, mimeType: string): Promise<string>;
  get(tenantId: string, ref: string): Promise<Buffer>;
  delete(tenantId: string, ref: string): Promise<void>;
}

function checkRef(tenantId: string, ref: string): string {
  const m = /^media:([0-9a-zA-Z-]+)\/([0-9a-f-]{36})$/.exec(ref);
  if (!m || m[1] !== tenantId) throw new Error('media reference does not belong to this tenant');
  return m[2]!;
}

export class MemoryMediaStore implements MediaStore {
  private readonly files = new Map<string, Buffer>();
  async put(tenantId: string, data: Buffer) {
    const ref = `media:${tenantId}/${randomUUID()}`;
    this.files.set(ref, data);
    return ref;
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
}
