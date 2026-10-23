/**
 * The outbound job queue contract, plus an in-memory implementation used by
 * unit tests and the simulator. The production implementation is
 * PgJobQueue (src/db/pgStores.ts), which uses FOR UPDATE SKIP LOCKED so
 * several workers can share the queue without double-sending.
 */
import type { ChatRef, MessageContent, SendErrorKind, SendResult } from '../core/types.js';
import { chatKey } from '../core/types.js';
import { ACTION_PRIORITY, type JobAction, type PlannedJob } from '../routing/types.js';

/** 'unknown' = the request may or may not have reached the platform ("ממתין לאימות"). */
export type JobStatus = 'pending_approval' | 'queued' | 'sending' | 'sent' | 'failed' | 'skipped' | 'cancelled' | 'unknown';

/** Statuses after which nothing more will happen to a job by itself. */
export const TERMINAL: ReadonlySet<JobStatus> = new Set(['sent', 'failed', 'skipped', 'cancelled', 'unknown']);

/** Counts of one distribution (or one edit / delete wave) by outcome. */
export interface ActionSummary {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
  unknown: number;
  /** queued, sending or waiting for approval. */
  pending: number;
  /** Error kind → count, for failed and skipped jobs. */
  reasons: Record<string, number>;
  /** Reason → count, for cancelled jobs (e.g. source_deleted, superseded). */
  cancelledReasons: Record<string, number>;
  /** Titles of targets that failed (for the report), at most 10. */
  failedTargets: string[];
}

export interface StoredJob extends PlannedJob {
  id: string;
  action: JobAction;
  version: number;
  status: JobStatus;
  /** Number of real send attempts so far (deferrals don't count). */
  attempts: number;
  errorKind?: SendErrorKind | string;
  lastError?: string;
  sentMessageId?: string;
  createdAt: Date;
  sentAt?: Date;
  /** Members who read this copy (WhatsApp read receipts). */
  readCount?: number;
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

  // ---- PUSH Sync

  /** The outcome is not known; never resent automatically ("ממתין לאימות"). */
  markUnknown(id: string, message: string): Promise<void>;
  /** The send jobs (copies) made from one source message, in every status. */
  copiesOf(tenantId: string, source: ChatRef, messageId: string): Promise<StoredJob[]>;
  /**
   * Replaces the content of a copy that has not gone out yet (queued, held for
   * approval, failed or unknown — the last two wait for a manual retry). False
   * if it already left that state — the caller then plans an edit instead.
   */
  replaceUnsentContent(id: string, content: MessageContent, version: number): Promise<boolean>;
  /** Cancels jobs of a source message that have not gone out; returns how many. */
  cancelUnsent(tenantId: string, source: ChatRef, messageId: string, actions: JobAction[], reason: string): Promise<number>;
  /** Cancels queued edits of one copy that carry an older version than `version`. */
  cancelOlderEdits(parentJobId: string, version: number): Promise<number>;
  /** Outcome counts for one action on one source message (edits: one version; optionally one route). */
  summary(tenantId: string, source: ChatRef, messageId: string, action: JobAction, version?: number, routeId?: string): Promise<ActionSummary>;
  /** Manual retry of a failed or unknown job by the customer. */
  requeue(tenantId: string, id: string): Promise<boolean>;
  /** Counts one reader of a copy this system sent. False if unknown or already counted. */
  recordRead(platform: string, chatId: string, messageId: string, reader: string): Promise<boolean>;
}

export function emptySummary(): ActionSummary {
  return { total: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0, unknown: 0, pending: 0, reasons: {}, cancelledReasons: {}, failedTargets: [] };
}

/** Adds one job to a summary. Shared by the memory and database queues. */
export function addToSummary(s: ActionSummary, status: JobStatus, errorKind: string | undefined, title: string | undefined, n = 1) {
  s.total += n;
  switch (status) {
    case 'sent': s.sent += n; break;
    case 'failed': s.failed += n; if (title && s.failedTargets.length < 10) s.failedTargets.push(title); break;
    case 'skipped': s.skipped += n; break;
    case 'cancelled': s.cancelled += n; break;
    case 'unknown': s.unknown += n; break;
    default: s.pending += n;
  }
  if ((status === 'failed' || status === 'skipped') && errorKind) s.reasons[errorKind] = (s.reasons[errorKind] ?? 0) + n;
  if (status === 'cancelled' && errorKind) s.cancelledReasons[errorKind] = (s.cancelledReasons[errorKind] ?? 0) + n;
}

const sameSource = (j: PlannedJob, tenantId: string, source: ChatRef, messageId: string) =>
  j.tenantId === tenantId && j.sourceMessageId === messageId && chatKey(j.source) === chatKey(source);

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
      this.jobs.set(id, {
        ...j, id, action: j.action ?? 'send', version: j.version ?? 1,
        status: j.requiresApproval ? 'pending_approval' : 'queued', attempts: 0, createdAt: new Date(this.now()),
      });
      inserted++;
    }
    return { inserted };
  }

  async claim(workerId: string, limit: number, lockMs: number, filter?: { accountIds?: string[] }) {
    const t = this.now();
    const ready = [...this.jobs.values()]
      .filter((j) => j.status === 'queued' && j.notBefore.getTime() <= t)
      .filter((j) => !filter?.accountIds || filter.accountIds.includes(j.target.accountId))
      .sort((a, b) => ACTION_PRIORITY[a.action] - ACTION_PRIORITY[b.action] || a.notBefore.getTime() - b.notBefore.getTime() || Number(a.id) - Number(b.id))
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
    for (const j of this.jobs.values()) if (j.action === 'send' && j.status === 'sent' && j.target.accountId === accountId && j.sentAt && j.sentAt >= since) n++;
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
      if ((j.action === 'send' || j.action === 'report') && j.sentMessageId === messageId && j.target.chatId === chatId && j.target.platform === platform) return true;
    }
    return false;
  }

  private readonly readers = new Map<string, Set<string>>();
  async recordRead(platform: string, chatId: string, messageId: string, reader: string) {
    for (const j of this.jobs.values()) {
      if (j.action === 'send' && j.sentMessageId === messageId && j.target.chatId === chatId && j.target.platform === platform) {
        let set = this.readers.get(j.id);
        if (!set) this.readers.set(j.id, (set = new Set()));
        if (set.has(reader)) return false;
        set.add(reader);
        j.readCount = (j.readCount ?? 0) + 1;
        return true;
      }
    }
    return false;
  }

  async markUnknown(id: string, message: string) {
    const j = this.sending(id);
    if (j) Object.assign(j, { status: 'unknown', errorKind: 'unknown', lastError: message, lockedUntil: undefined });
  }

  async copiesOf(tenantId: string, source: ChatRef, messageId: string) {
    return [...this.jobs.values()]
      .filter((j) => j.action === 'send' && sameSource(j, tenantId, source, messageId))
      .map((j) => ({ ...j }));
  }

  async replaceUnsentContent(id: string, content: MessageContent, version: number) {
    const j = this.jobs.get(id);
    if (!j || !['queued', 'pending_approval', 'failed', 'unknown'].includes(j.status) || j.version > version) return false;
    Object.assign(j, { content, version });
    return true;
  }

  async cancelUnsent(tenantId: string, source: ChatRef, messageId: string, actions: JobAction[], reason: string) {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (actions.includes(j.action) && sameSource(j, tenantId, source, messageId) && ['queued', 'pending_approval', 'failed'].includes(j.status)) {
        Object.assign(j, { status: 'cancelled', errorKind: reason, lastError: reason });
        n++;
      }
    }
    return n;
  }

  async cancelOlderEdits(parentJobId: string, version: number) {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.action === 'edit' && j.parentJobId === parentJobId && j.version < version && j.status === 'queued') {
        Object.assign(j, { status: 'cancelled', errorKind: 'superseded', lastError: 'superseded' });
        n++;
      }
    }
    return n;
  }

  async summary(tenantId: string, source: ChatRef, messageId: string, action: JobAction, version?: number, routeId?: string) {
    const s = emptySummary();
    for (const j of this.jobs.values()) {
      if (j.action !== action || !sameSource(j, tenantId, source, messageId)) continue;
      if (routeId !== undefined && j.routeId !== routeId) continue;
      if (version !== undefined && j.version !== version) continue;
      addToSummary(s, j.status, j.errorKind, j.target.title ?? j.target.chatId);
    }
    return s;
  }

  async requeue(tenantId: string, id: string) {
    const j = this.jobs.get(id);
    if (!j || j.tenantId !== tenantId || !['failed', 'unknown'].includes(j.status)) return false;
    // A manual retry is a new decision by the customer: its age starts now (otherwise it would be skipped as stale).
    Object.assign(j, { status: 'queued', attempts: 0, notBefore: new Date(this.now()), createdAt: new Date(this.now()), errorKind: undefined, lastError: undefined });
    return true;
  }

  /** Test helper: what each target received, in order. */
  sentTo(target: { platform: string; accountId: string; chatId: string }) {
    const k = chatKey(target as never);
    return [...this.jobs.values()].filter((j) => j.status === 'sent' && chatKey(j.target) === k);
  }
}
