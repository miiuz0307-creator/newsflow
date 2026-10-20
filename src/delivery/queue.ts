/**
 * The outbound job queue contract, plus an in-memory implementation used by
 * unit tests and the simulator. The production implementation is
 * PgJobQueue (src/db/pgStores.ts), which uses FOR UPDATE SKIP LOCKED so
 * several workers can share the queue without double-sending.
 */
import type { SendErrorKind, SendResult } from '../core/types.js';
import { chatKey } from '../core/types.js';
import type { PlannedJob } from '../routing/types.js';

export type JobStatus = 'pending_approval' | 'queued' | 'sending' | 'sent' | 'failed' | 'skipped' | 'cancelled';

export interface StoredJob extends PlannedJob {
  id: string;
  status: JobStatus;
  /** Number of real send attempts so far (deferrals don't count). */
  attempts: number;
  errorKind?: SendErrorKind | string;
  lastError?: string;
  sentMessageId?: string;
  createdAt: Date;
  sentAt?: Date;
}

export interface JobQueue {
  /** Inserts jobs; a job whose idempotencyKey already exists is ignored. */
  enqueue(jobs: PlannedJob[]): Promise<{ inserted: number }>;
  /** Atomically takes up to `limit` ready jobs for this worker and marks them sending. */
  claim(workerId: string, limit: number, lockMs: number, filter?: { accountIds?: string[] }): Promise<StoredJob[]>;
  complete(id: string, result: SendResult): Promise<void>;
  /** A failed attempt that may succeed later. */
  retry(id: string, at: Date, kind: string, message: string): Promise<void>;
  /** Put back without counting an attempt (rate limit spacing, account not here). */
  defer(id: string, at: Date): Promise<void>;
  fail(id: string, kind: string, message: string): Promise<void>;
  skip(id: string, reason: string): Promise<void>;
  /** Moves a job held for approval into the queue. Scoped to the tenant. */
  approve(tenantId: string, id: string): Promise<boolean>;
  reject(tenantId: string, id: string): Promise<boolean>;
  listPendingApproval(tenantId: string): Promise<StoredJob[]>;
  /** Successful sends from an account since a time (daily caps). */
  sentCountSince(accountId: string, since: Date): Promise<number>;
  /** Jobs stuck in "sending" past their lock (crashed worker) go back to the queue. */
  reapStale(): Promise<number>;
  get(id: string): Promise<StoredJob | undefined>;
  /** True if this system sent `messageId` into that chat (loop guard). */
  wasSentByUs?(platform: string, chatId: string, messageId: string): Promise<boolean>;
}

export class MemoryJobQueue implements JobQueue {
  private seq = 0;
  readonly jobs = new Map<string, StoredJob & { lockedUntil?: number; lockedBy?: string }>();
  private readonly keys = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  async enqueue(jobs: PlannedJob[]) {
    let inserted = 0;
    for (const j of jobs) {
      if (this.keys.has(j.idempotencyKey)) continue;
      this.keys.add(j.idempotencyKey);
      const id = String(++this.seq);
      this.jobs.set(id, { ...j, id, status: j.requiresApproval ? 'pending_approval' : 'queued', attempts: 0, createdAt: new Date(this.now()) });
      inserted++;
    }
    return { inserted };
  }

  async claim(workerId: string, limit: number, lockMs: number, filter?: { accountIds?: string[] }) {
    const t = this.now();
    const ready = [...this.jobs.values()]
      .filter((j) => j.status === 'queued' && j.notBefore.getTime() <= t)
      .filter((j) => !filter?.accountIds || filter.accountIds.includes(j.target.accountId))
      .sort((a, b) => a.notBefore.getTime() - b.notBefore.getTime() || Number(a.id) - Number(b.id))
      .slice(0, limit);
    for (const j of ready) {
      j.status = 'sending';
      j.attempts++;
      j.lockedBy = workerId;
      j.lockedUntil = t + lockMs;
    }
    return ready.map((j) => ({ ...j }));
  }

  private must(id: string) {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`no job ${id}`);
    return j;
  }

  /** Like the database version: only a job still being sent can be finished. */
  private sending(id: string) {
    const j = this.must(id);
    return j.status === 'sending' ? j : undefined;
  }

  async complete(id: string, r: SendResult) {
    const j = this.sending(id);
    if (!j) return;
    Object.assign(j, { status: 'sent', sentMessageId: r.messageId, sentAt: r.sentAt, lockedUntil: undefined });
  }
  async retry(id: string, at: Date, kind: string, message: string) {
    const j = this.sending(id);
    if (j) Object.assign(j, { status: 'queued', notBefore: at, errorKind: kind, lastError: message, lockedUntil: undefined });
  }
  async defer(id: string, at: Date) {
    const j = this.sending(id);
    if (!j) return;
    Object.assign(j, { status: 'queued', notBefore: at, attempts: Math.max(0, j.attempts - 1), lockedUntil: undefined });
  }
  async fail(id: string, kind: string, message: string) {
    const j = this.sending(id);
    if (j) Object.assign(j, { status: 'failed', errorKind: kind, lastError: message, lockedUntil: undefined });
  }
  async skip(id: string, reason: string) {
    const j = this.sending(id);
    if (!j) return;
    Object.assign(j, { status: 'skipped', errorKind: reason, lastError: reason, attempts: Math.max(0, j.attempts - 1), lockedUntil: undefined });
  }
  async approve(tenantId: string, id: string) {
    const j = this.jobs.get(id);
    if (!j || j.tenantId !== tenantId || j.status !== 'pending_approval') return false;
    j.status = 'queued';
    if (j.notBefore.getTime() < this.now()) j.notBefore = new Date(this.now());
    return true;
  }
  async reject(tenantId: string, id: string) {
    const j = this.jobs.get(id);
    if (!j || j.tenantId !== tenantId || j.status !== 'pending_approval') return false;
    j.status = 'cancelled';
    return true;
  }
  async listPendingApproval(tenantId: string) {
    return [...this.jobs.values()].filter((j) => j.tenantId === tenantId && j.status === 'pending_approval').map((j) => ({ ...j }));
  }
  async sentCountSince(accountId: string, since: Date) {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === 'sent' && j.target.accountId === accountId && j.sentAt && j.sentAt >= since) n++;
    return n;
  }
  async reapStale() {
    const t = this.now();
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'sending' && (j.lockedUntil ?? 0) < t) {
        j.status = 'queued';
        n++;
      }
    }
    return n;
  }
  async get(id: string) {
    const j = this.jobs.get(id);
    return j ? { ...j } : undefined;
  }

  async wasSentByUs(platform: string, chatId: string, messageId: string) {
    for (const j of this.jobs.values()) {
      if (j.sentMessageId === messageId && j.target.chatId === chatId && j.target.platform === platform) return true;
    }
    return false;
  }

  /** Test helper: what each target received, in order. */
  sentTo(target: { platform: string; accountId: string; chatId: string }) {
    const k = chatKey(target as never);
    return [...this.jobs.values()].filter((j) => j.status === 'sent' && chatKey(j.target) === k);
  }
}
