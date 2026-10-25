/**
 * Status messages in the control group ("✅ PUSH · נשלחה ל-48 מתוך 50 קבוצות").
 *
 * Reports are ordinary queue jobs (action 'report') addressed to the control
 * group itself, so they obey kill switches and rate limits, and the loop
 * guard recognises them: their message id is recorded like any copy, and
 * their text starts with the PUSH tag (see isOwnReport), so even a report
 * that arrives back before its id is stored is never distributed.
 *
 * When does a report go out? Once every job of a wave (the sends of one
 * message, the edits of one version, or the deletes) has a final outcome.
 * The decision is made from the database, not from memory, and the report's
 * idempotency key makes two workers finishing at once send it only once.
 *
 * Modes per control group: 'all' (also "received, distributing…"),
 * 'summary' (final results), 'failures' (only when something failed), 'off'.
 */
import type { ChatRef } from '../core/types.js';
import { chatKey } from '../core/types.js';
import type { ActionSummary, JobQueue, StoredJob } from '../delivery/queue.js';
import type { Outcome } from '../delivery/dispatcher.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import { REPORT_TAG } from '../routing/router.js';
import type { JobAction, PlannedJob, ReportMode, Route } from '../routing/types.js';
import type { RouteSource } from './pipeline.js';
import type { SyncOutcome } from './sync.js';

const tag = (emoji: string) => `${emoji} ${REPORT_TAG} `;

/** The send time of a message scheduled at least 30 seconds ahead, else undefined. */
function isLater(jobs: PlannedJob[], now: Date): Date | undefined {
  const at = jobs.find((j) => j.scheduledAt)?.scheduledAt;
  return at && at.getTime() - now.getTime() > 30_000 ? at : undefined;
}
const israelFmt = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const israelDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' });
function israelTime(d: Date): string {
  const tomorrow = israelDay.format(d) !== israelDay.format(new Date());
  return `${israelFmt.format(d)}${tomorrow ? ' מחר' : ''}`;
}

const REASON_HE: Record<string, string> = {
  window_closed: 'חלון הזמן של הפלטפורמה נסגר',
  forbidden: 'אין הרשאה לשלוח בקבוצה',
  not_found: 'הקבוצה או ההודעה לא נמצאו',
  not_supported: 'הפלטפורמה לא תומכת בפעולה',
  copy_not_sent: 'העותק לא נשלח מלכתחילה',
  copy_unknown: 'מצב העותק לא ידוע',
  superseded: 'הוחלפה בעריכה חדשה יותר',
  stale: 'עבר יותר מדי זמן',
  account_blocked: 'המספר חסום',
  invalid: 'תוכן לא תקין',
  transient: 'תקלה זמנית שלא נפתרה',
  disconnected: 'החיבור מנותק',
};

function reasonsLine(s: ActionSummary): string {
  const parts = Object.entries(s.reasons)
    .filter(([k]) => k !== 'superseded' && k !== 'merged_into_send' && k !== 'cancelled_before_send')
    .map(([k, n]) => `${REASON_HE[k] ?? k} (${n})`);
  return parts.length ? `\nסיבות: ${parts.join(', ')}` : '';
}

/** What a wave's own jobs don't show: copies handled before sending, and copies that could not be reached. */
export interface ReportExtra {
  /** Edit: copies that carried the new text before they were sent. */
  changedBeforeSend?: number;
  /** Delete: sends cancelled before they went out. */
  cancelledBeforeSend?: number;
  /** Copies in "pending verification", which an edit or delete cannot reach. */
  unknownCopies?: number;
}

/** Hebrew text of a final report. Exported for tests. */
export function finalReportText(action: Exclude<JobAction, 'report'>, s: ActionSummary, extra: ReportExtra = {}): string {
  const done = s.sent;
  // Jobs that merged into a send or were made moot don't count as targets of this wave.
  const moot = (s.reasons.superseded ?? 0) + (s.reasons.merged_into_send ?? 0) + (s.reasons.cancelled_before_send ?? 0);
  const total = s.total - s.cancelled - moot;
  const bad = s.failed + (s.skipped - moot);
  const lines: string[] = [];
  if (action === 'send') {
    lines.push(bad || s.unknown ? `${tag('⚠️')}ההודעה נשלחה ל-${done} מתוך ${total} קבוצות.` : `${tag('✅')}ההודעה נשלחה בהצלחה ל-${done} מתוך ${total} קבוצות.`);
  } else if (action === 'edit') {
    const before = extra.changedBeforeSend ?? 0;
    lines.push(`${tag('✏️')}ההודעה עודכנה ב-${done + before} קבוצות${before ? ` (${before} מהן עוד לפני השליחה)` : ''}.`);
  } else {
    const cancelled = extra.cancelledBeforeSend ?? 0;
    lines.push(`${tag('🗑️')}ההודעה נמחקה ב-${done} קבוצות.${cancelled ? ` ${cancelled} שליחות שטרם יצאו בוטלו.` : ''}`);
  }
  if (bad > 0) {
    const names = s.failedTargets.length ? `: ${s.failedTargets.slice(0, 5).join(', ')}${s.failedTargets.length > 5 ? '…' : ''}` : '';
    lines.push(`${bad} לא הצליחו${names}${reasonsLine(s)}`);
  }
  if (s.unknown > 0) lines.push(`⏳ ${s.unknown} ממתינות לאימות — בדקו בלוח הבקרה לפני שליחה חוזרת.`);
  if (action !== 'send' && extra.unknownCopies) {
    lines.push(`⏳ ${extra.unknownCopies} עותקים ממתינים לאימות, ולכן לא ${action === 'edit' ? 'עודכנו' : 'נמחקו'} — בדקו בקבוצות האלה ידנית.`);
  }
  return lines.join('\n');
}

/** Idempotency stage of a wave's final report: one per send, one per edit version, one per delete. */
const finalStage = (action: Exclude<JobAction, 'report'>, version: number) => (action === 'edit' ? `edit|v${version}|final` : `${action}|final`);

export interface ReporterOptions {
  queue: JobQueue;
  routes: RouteSource;
  logger?: Logger;
  now?: () => Date;
  /** Sets the linked number's reaction on the control-group message ('' removes it). */
  react?: (tenantId: string, source: ChatRef, messageId: string, emoji: string) => Promise<void>;
}

export class Reporter {
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(private readonly o: ReporterOptions) {
    this.log = (o.logger ?? silentLogger).child({ component: 'reporter' });
    this.now = o.now ?? (() => new Date());
  }

  private async controlRoute(tenantId: string, source: ChatRef, routeId: string): Promise<Route | undefined> {
    const routes = await this.o.routes.routesForSource(source);
    return routes.find((r) => r.id === routeId && r.tenantId === tenantId && r.control);
  }

  private mode(r: Route): ReportMode {
    return r.control?.reportMode ?? 'summary';
  }

  /** Reactions on one message are set in order, so ✅ never lands before ⏳. */
  private marks = new Map<string, Promise<void>>();
  private mark(route: Route, source: ChatRef, messageId: string, emoji: string): Promise<void> {
    if (!this.o.react || route.control?.reactions === false) return Promise.resolve();
    const k = `${chatKey(source)}|${messageId}`;
    const next = (this.marks.get(k) ?? Promise.resolve()).then(async () => {
      try {
        await this.o.react!(route.tenantId, source, messageId, emoji);
      } catch (err) {
        this.log.info('reaction not set', { err: String(err).slice(0, 200) });
      }
    });
    this.marks.set(k, next);
    void next.then(() => { if (this.marks.get(k) === next) this.marks.delete(k); });
    return next;
  }

  /** ⏳ on the control-group message as soon as it is accepted for distribution; 🕐 when it is scheduled for later. */
  async onDistributionStarted(tenantId: string, source: ChatRef, messageId: string, jobs: PlannedJob[]): Promise<void> {
    const later = isLater(jobs, this.now());
    const routeIds = new Set(jobs.map((j) => j.routeId));
    for (const routeId of routeIds) {
      const route = await this.controlRoute(tenantId, source, routeId);
      if (route) { await this.mark(route, source, messageId, later ? '🕐' : '⏳'); return; }
    }
  }

  /** A scheduled message's time came and its first copy is going out: 🕐 becomes ⏳ (once per message). */
  private sending = new Set<string>();
  async onSendStart(job: StoredJob): Promise<void> {
    if (!job.scheduledAt) return;
    const k = `${chatKey(job.source)}|${job.sourceMessageId}`;
    if (this.sending.has(k)) return;
    this.sending.add(k);
    if (this.sending.size > 5000) this.sending.clear();
    const route = await this.controlRoute(job.tenantId, job.source, job.routeId);
    if (route) await this.mark(route, job.source, job.sourceMessageId, '⏳');
  }

  /** "🕒 received, distributing to N groups" — only in mode 'all'. */
  async onDistributionPlanned(tenantId: string, source: ChatRef, messageId: string, jobs: PlannedJob[]): Promise<void> {
    const byRoute = new Map<string, number>();
    for (const j of jobs) byRoute.set(j.routeId, (byRoute.get(j.routeId) ?? 0) + 1);
    const later = isLater(jobs, this.now());
    for (const [routeId, n] of byRoute) {
      const route = await this.controlRoute(tenantId, source, routeId);
      if (!route || this.mode(route) !== 'all') continue;
      const text = later
        ? `${tag('🕐')}ההודעה תוזמנה ל-${israelTime(later)} ותישלח ל-${n} קבוצות.`
        : `${tag('🕒')}התקבלה הודעה, מפיץ ל-${n} קבוצות…`;
      await this.post(route, source, messageId, `received`, text, 1);
    }
  }

  /**
   * After an edit or delete was planned. Changes made before sending (or not
   * possible at all) have no jobs to wait for, so they are reported here.
   */
  async onSyncPlanned(tenantId: string, source: ChatRef, messageId: string, out: SyncOutcome): Promise<void> {
    if (!out.handled) return;
    const routes = (await this.o.routes.routesForSource(source)).filter((r) => r.tenantId === tenantId && r.control);
    for (const route of routes) {
      const mode = this.mode(route);
      if (mode === 'off') continue;
      if (out.jobsQueued > 0) {
        if (mode === 'all') {
          const text = out.type === 'edit'
            ? `${tag('✏️')}מעדכן את ההודעה ב-${out.jobsQueued} קבוצות…`
            : `${tag('🗑️')}מוחק את ההודעה מ-${out.jobsQueued} קבוצות…`;
          await this.post(route, source, messageId, `${out.type}|v${out.version}|started`, text, out.version);
        }
        continue;
      }
      const lines: string[] = [];
      if (out.changedBeforeSend) {
        lines.push(out.type === 'edit'
          ? `${tag('✏️')}ההודעה עודכנה לפני השליחה ב-${out.changedBeforeSend} קבוצות.`
          : `${tag('🗑️')}ההודעה נמחקה לפני שיצאה: ${out.changedBeforeSend} שליחות בוטלו.`);
      }
      const problems: string[] = [];
      if (out.notSupported) problems.push(`${out.notSupported} קבוצות בפלטפורמה שלא תומכת בפעולה.`);
      if (out.unknownCopies) problems.push(`⏳ ${out.unknownCopies} עותקים ממתינים לאימות, ולכן לא ${out.type === 'edit' ? 'עודכנו' : 'נמחקו'}.`);
      if (!lines.length && !problems.length) continue;
      if (mode === 'failures' && !problems.length) continue;
      if (!lines.length) lines.push(`${tag('⚠️')}${out.type === 'edit' ? 'העריכה' : 'המחיקה'} לא בוצעה בחלק מהקבוצות.`);
      await this.post(route, source, messageId, `${out.type}|v${out.version}|final`, [...lines, ...problems].join('\n'), out.version);
    }
  }

  /** Called for every job outcome; posts the final report when the job's wave is complete. */
  async onJobResult(job: StoredJob, outcome: Outcome): Promise<void> {
    if (job.action === 'report' || outcome === 'retry' || outcome === 'deferred') return;
    const route = await this.controlRoute(job.tenantId, job.source, job.routeId);
    if (!route) return;
    const mode = this.mode(route);
    // Counted per route: another route reading the same group never mixes into this report.
    const q = this.o.queue;
    const version = job.action === 'edit' ? job.version : undefined;
    const s = await q.summary(job.tenantId, job.source, job.sourceMessageId, job.action, version, route.id);
    if (s.pending > 0) return;
    // The wave is done: ✅ on the message when every copy went out, ⚠️ when some did not.
    if (job.action === 'send') await this.mark(route, job.source, job.sourceMessageId, s.failed + s.unknown > 0 ? '⚠️' : '✅');
    if (mode === 'off') return;
    const extra: ReportExtra = {};
    if (job.action !== 'send') {
      const sends = await q.summary(job.tenantId, job.source, job.sourceMessageId, 'send', undefined, route.id);
      extra.unknownCopies = sends.unknown;
      if (job.action === 'delete') extra.cancelledBeforeSend = sends.cancelledReasons.source_deleted ?? 0;
      if (job.action === 'edit') {
        const atVersion = await q.summary(job.tenantId, job.source, job.sourceMessageId, 'send', job.version, route.id);
        extra.changedBeforeSend = atVersion.sent + atVersion.pending;
      }
    }
    const bad = s.failed + s.unknown + (extra.unknownCopies ?? 0);
    if (mode === 'failures' && bad === 0) return;
    if (job.action === 'edit' && s.sent === 0 && bad === 0 && !extra.changedBeforeSend) return; // nothing visible happened
    await this.post(route, job.source, job.sourceMessageId, finalStage(job.action, job.version), finalReportText(job.action, s, extra), job.version);
  }

  private async post(route: Route, source: ChatRef, messageId: string, stage: string, text: string, version: number): Promise<void> {
    const job: PlannedJob = {
      tenantId: route.tenantId,
      routeId: route.id,
      source,
      sourceMessageId: messageId,
      target: { ...source },
      content: { kind: 'text', text },
      notBefore: this.now(),
      requiresApproval: false,
      idempotencyKey: `report|${chatKey(source)}|${messageId}|${route.id}|${stage}`,
      action: 'report',
      version: Math.max(1, version),
    };
    try {
      await this.o.queue.enqueue([job]);
    } catch (err) {
      this.log.warn('report not queued', { err: String(err) });
    }
  }
}
