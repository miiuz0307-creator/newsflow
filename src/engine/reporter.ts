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

/** Hebrew text of a final report. Exported for tests. */
export function finalReportText(action: Exclude<JobAction, 'report'>, s: ActionSummary): string {
  const done = s.sent;
  // Jobs that merged into a send or were made moot don't count as targets of this wave.
  const moot = (s.reasons.superseded ?? 0) + (s.reasons.merged_into_send ?? 0) + (s.reasons.cancelled_before_send ?? 0);
  const total = s.total - s.cancelled - moot;
  const bad = s.failed + (s.skipped - moot);
  const lines: string[] = [];
  if (action === 'send') {
    lines.push(bad || s.unknown ? `${tag('⚠️')}ההודעה נשלחה ל-${done} מתוך ${total} קבוצות.` : `${tag('✅')}ההודעה נשלחה בהצלחה ל-${done} מתוך ${total} קבוצות.`);
  } else if (action === 'edit') {
    lines.push(`${tag('✏️')}ההודעה עודכנה ב-${done} קבוצות.`);
  } else {
    lines.push(`${tag('🗑️')}ההודעה נמחקה ב-${done} קבוצות.`);
  }
  if (bad > 0) {
    const names = s.failedTargets.length ? `: ${s.failedTargets.slice(0, 5).join(', ')}${s.failedTargets.length > 5 ? '…' : ''}` : '';
    lines.push(`${bad} לא הצליחו${names}${reasonsLine(s)}`);
  }
  if (s.unknown > 0) lines.push(`⏳ ${s.unknown} ממתינות לאימות — בדקו בלוח הבקרה לפני שליחה חוזרת.`);
  return lines.join('\n');
}

export interface ReporterOptions {
  queue: JobQueue;
  routes: RouteSource;
  logger?: Logger;
  now?: () => Date;
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

  /** "🕒 received, distributing to N groups" — only in mode 'all'. */
  async onDistributionPlanned(tenantId: string, source: ChatRef, messageId: string, jobs: PlannedJob[]): Promise<void> {
    const byRoute = new Map<string, number>();
    for (const j of jobs) byRoute.set(j.routeId, (byRoute.get(j.routeId) ?? 0) + 1);
    for (const [routeId, n] of byRoute) {
      const route = await this.controlRoute(tenantId, source, routeId);
      if (!route || this.mode(route) !== 'all') continue;
      await this.post(route, source, messageId, `received`, `${tag('🕒')}התקבלה הודעה, מפיץ ל-${n} קבוצות…`, 1);
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
    if (mode === 'off') return;
    const version = job.action === 'edit' ? job.version : undefined;
    const s = await this.o.queue.summary(job.tenantId, job.source, job.sourceMessageId, job.action, version);
    if (s.pending > 0) return;
    const bad = s.failed + s.unknown;
    if (mode === 'failures' && bad === 0) return;
    if (job.action === 'edit' && s.sent === 0 && bad === 0) return; // all merged or superseded: nothing visible happened
    const text = finalReportText(job.action, s);
    await this.post(route, job.source, job.sourceMessageId, `${job.action}|v${job.version}|final`, text, job.version);
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
