/**
 * PUSH Sync: an edit or a "delete for everyone" in a control group follows
 * every copy of the message.
 *
 * Per copy, by its state when the change arrives:
 *
 *   copy not sent yet (queued, held, failed)  → edit: its content is replaced in place
 *                                              → delete: it is cancelled
 *   copy being sent or already sent          → an edit / delete job is queued for it
 *   copy in 'unknown' state                  → left alone and counted (its message id is not known)
 *   copy skipped or cancelled                → nothing to do
 *
 * Versions: every edit bumps the source message's version. Jobs carry the
 * version they were planned for; the dispatcher skips a job whose version is
 * older than the current one, so an old edit never overwrites a newer one.
 * Deletes cancel every pending send and edit of the message and run first.
 */
import type { ChatRef, MessageContent, SyncEvent } from '../core/types.js';
import { CAPABILITIES, chatKey } from '../core/types.js';
import type { JobQueue, StoredJob } from '../delivery/queue.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import { renderCopy, senderAllowed } from '../routing/router.js';
import { parseSchedule } from '../routing/schedule.js';
import type { PlannedJob, Route } from '../routing/types.js';
import type { RouteSource } from './pipeline.js';

export interface SourceState {
  version: number;
  deleted: boolean;
}

/** Remembers which source messages were distributed, their version, and whether they were deleted. */
export interface SourceMessageStore {
  /** Records a distributed message as version 1. No-op if already known. */
  record(tenantId: string, source: ChatRef, messageId: string, text?: string): Promise<void>;
  /** Moves a known, not-deleted message to its next version. Undefined otherwise. */
  bump(tenantId: string, source: ChatRef, messageId: string, text?: string): Promise<number | undefined>;
  /** Marks a known message deleted. True only the first time. */
  markDeleted(tenantId: string, source: ChatRef, messageId: string): Promise<boolean>;
  state(source: ChatRef, messageId: string): Promise<SourceState | undefined>;
}

export class MemorySourceMessageStore implements SourceMessageStore {
  readonly rows = new Map<string, SourceState & { tenantId: string; texts: (string | undefined)[] }>();
  private key(source: ChatRef, id: string) {
    return `${chatKey(source)}|${id}`;
  }
  async record(tenantId: string, source: ChatRef, messageId: string, text?: string) {
    const k = this.key(source, messageId);
    if (!this.rows.has(k)) this.rows.set(k, { tenantId, version: 1, deleted: false, texts: [text] });
  }
  async bump(tenantId: string, source: ChatRef, messageId: string, text?: string) {
    const r = this.rows.get(this.key(source, messageId));
    if (!r || r.tenantId !== tenantId || r.deleted) return undefined;
    r.version++;
    r.texts.push(text);
    return r.version;
  }
  async markDeleted(tenantId: string, source: ChatRef, messageId: string) {
    const r = this.rows.get(this.key(source, messageId));
    if (!r || r.tenantId !== tenantId || r.deleted) return false;
    r.deleted = true;
    return true;
  }
  async state(source: ChatRef, messageId: string) {
    const r = this.rows.get(this.key(source, messageId));
    return r ? { version: r.version, deleted: r.deleted } : undefined;
  }
}

export type SyncIgnoredReason = 'not_control_group' | 'sync_disabled' | 'sender_not_allowed' | 'unknown_message' | 'already_deleted';

export type SyncOutcome =
  | { handled: false; reason: SyncIgnoredReason }
  | {
      handled: true;
      type: 'edit' | 'delete';
      version: number;
      /** Copies changed in place before they were sent (edit) or cancelled (delete). */
      changedBeforeSend: number;
      /** Edit / delete jobs queued for copies that were sent or being sent. */
      jobsQueued: number;
      /** Copies the platform cannot change (no edit / delete support). */
      notSupported: number;
      /** Copies whose send outcome is unknown, so they cannot be found to change. */
      unknownCopies: number;
    };

export interface SyncPlannerOptions {
  routes: RouteSource;
  sources: SourceMessageStore;
  queue: JobQueue;
  logger?: Logger;
  now?: () => Date;
}

/** Texts the customer can reply with in a Telegram control group to delete a message everywhere. */
const DELETE_COMMANDS = new Set(['/delete', '/מחק', 'מחק', 'מחק לכולם', '/del']);

export function isDeleteCommand(text: string | undefined): boolean {
  const t = (text ?? '').trim().toLowerCase().replace(/@\w+$/, '');
  return DELETE_COMMANDS.has(t);
}

export class SyncPlanner {
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(private readonly o: SyncPlannerOptions) {
    this.log = (o.logger ?? silentLogger).child({ component: 'sync' });
    this.now = o.now ?? (() => new Date());
  }

  /** The control-group routes of this tenant that use `source`. */
  private async controlRoutes(tenantId: string, source: ChatRef): Promise<Route[]> {
    const all = await this.o.routes.routesForSource(source);
    return all.filter((r) => r.tenantId === tenantId && r.control);
  }

  async handle(ev: SyncEvent): Promise<SyncOutcome> {
    const routes = await this.controlRoutes(ev.tenantId, ev.source);
    if (!routes.length) return { handled: false, reason: 'not_control_group' };
    const active = routes.filter((r) => (ev.type === 'edit' ? r.control!.syncEdits !== false : r.control!.syncDeletes !== false));
    if (!active.length) return { handled: false, reason: 'sync_disabled' };
    // The allowed-senders list guards edits and deletes too: a group admin (or, in Telegram, any member
    // replying "מחק") who may not distribute may not delete or change copies either.
    const allowed = active.filter((r) => senderAllowed(r, { senderId: ev.senderId, fromSelf: !!ev.fromSelf }));
    if (!allowed.length) return { handled: false, reason: 'sender_not_allowed' };
    const byId = new Map(allowed.map((r) => [r.id, r]));
    return ev.type === 'edit' ? this.edit(ev, byId) : this.remove(ev, byId);
  }

  private async edit(ev: Extract<SyncEvent, { type: 'edit' }>, routes: Map<string, Route>): Promise<SyncOutcome> {
    const version = await this.o.sources.bump(ev.tenantId, ev.source, ev.messageId, ev.content.text);
    if (version === undefined) {
      const st = await this.o.sources.state(ev.source, ev.messageId);
      return { handled: false, reason: st?.deleted ? 'already_deleted' : 'unknown_message' };
    }
    const now = this.now();
    const out = { handled: true as const, type: 'edit' as const, version, changedBeforeSend: 0, jobsQueued: 0, notSupported: 0, unknownCopies: 0 };
    const copies = await this.o.queue.copiesOf(ev.tenantId, ev.source, ev.messageId);
    const edits: PlannedJob[] = [];

    for (const copy of copies) {
      const route = routes.get(copy.routeId);
      if (!route) continue;
      const template = route.templateId ? await this.o.routes.template(route.tenantId, route.templateId) : undefined;
      // The copy keeps its own kind and media; only the text / caption changes.
      const content = renderCopy(route, template, { kind: copy.content.kind, text: ev.content.text, ...(copy.content.media ? { media: copy.content.media } : {}) }, copy.target, now);
      if (!content) continue; // edited down to nothing after cleanup: leave the copy as it is

      if (['queued', 'pending_approval', 'failed'].includes(copy.status)) {
        // A scheduled message edited before its time: a new time moves it, a removed line sends it now.
        let at: Date | null | undefined;
        if (route.control) {
          const s = parseSchedule(ev.content.text, now);
          if (s.kind === 'scheduled') at = s.at.getTime() === copy.scheduledAt?.getTime() ? undefined : s.at;
          else if (s.kind === 'none' && copy.scheduledAt && copy.scheduledAt > now) at = null;
        }
        if (await this.o.queue.replaceUnsentContent(copy.id, content, version, at)) {
          out.changedBeforeSend++;
          continue;
        }
        // It started sending in the meantime: fall through and plan an edit.
      } else if (copy.status === 'unknown') {
        // Its message id is unknown, so it can't be edited; but a later manual retry must send the new text.
        await this.o.queue.replaceUnsentContent(copy.id, content, version);
        out.unknownCopies++;
        continue;
      } else if (copy.status !== 'sending' && copy.status !== 'sent') {
        continue; // skipped / cancelled
      }

      const caps = CAPABILITIES[copy.target.platform];
      const canEdit = copy.content.kind === 'text' ? caps.edit : caps.editCaption;
      if (canEdit === false) {
        out.notSupported++;
        continue;
      }
      edits.push(this.changeJob(copy, 'edit', version, stripMedia(content), now));
    }

    if (edits.length) {
      out.jobsQueued = (await this.o.queue.enqueue(edits)).inserted;
      for (const e of edits) await this.o.queue.cancelOlderEdits(e.parentJobId!, version);
    }
    this.log.info('edit planned', { tenantId: ev.tenantId, messageId: ev.messageId, ...out });
    return out;
  }

  private async remove(ev: Extract<SyncEvent, { type: 'delete' }>, routes: Map<string, Route>): Promise<SyncOutcome> {
    if (!(await this.o.sources.markDeleted(ev.tenantId, ev.source, ev.messageId))) {
      const st = await this.o.sources.state(ev.source, ev.messageId);
      return { handled: false, reason: st?.deleted ? 'already_deleted' : 'unknown_message' };
    }
    const now = this.now();
    const st = await this.o.sources.state(ev.source, ev.messageId);
    const version = st?.version ?? 1;
    const out = { handled: true as const, type: 'delete' as const, version, changedBeforeSend: 0, jobsQueued: 0, notSupported: 0, unknownCopies: 0 };

    // Nothing that has not gone out yet may go out now: unsent copies and pending edits are cancelled.
    out.changedBeforeSend = await this.o.queue.cancelUnsent(ev.tenantId, ev.source, ev.messageId, ['send', 'edit'], 'source_deleted');

    const copies = await this.o.queue.copiesOf(ev.tenantId, ev.source, ev.messageId);
    const deletes: PlannedJob[] = [];
    for (const copy of copies) {
      if (!routes.has(copy.routeId)) continue;
      if (copy.status === 'unknown') {
        out.unknownCopies++;
        continue;
      }
      if (copy.status !== 'sending' && copy.status !== 'sent') continue;
      if (CAPABILITIES[copy.target.platform].delete === false) {
        out.notSupported++;
        continue;
      }
      deletes.push(this.changeJob(copy, 'delete', version, { kind: 'text' }, now));
    }
    if (deletes.length) out.jobsQueued = (await this.o.queue.enqueue(deletes)).inserted;
    this.log.info('delete planned', { tenantId: ev.tenantId, messageId: ev.messageId, ...out });
    return out;
  }

  private changeJob(copy: StoredJob, action: 'edit' | 'delete', version: number, content: MessageContent, now: Date): PlannedJob {
    return {
      tenantId: copy.tenantId,
      routeId: copy.routeId,
      source: copy.source,
      sourceMessageId: copy.sourceMessageId,
      target: copy.target,
      content,
      notBefore: now,
      requiresApproval: false,
      // One delete per copy; one edit per copy and version.
      idempotencyKey: action === 'delete' ? `${copy.idempotencyKey}|delete` : `${copy.idempotencyKey}|edit|v${version}`,
      action,
      parentJobId: copy.id,
      version,
    };
  }
}

/** An edit changes only text: the media reference is kept for the record, never re-uploaded. */
function stripMedia(c: MessageContent): MessageContent {
  if (!c.media) return c;
  const { data: _d, load: _l, ...media } = c.media;
  return { ...c, media };
}

