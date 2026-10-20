/**
 * Turns one inbound message into the list of sends it should cause.
 *
 * Pure decision logic plus a duplicate check; it sends nothing itself. The
 * delivery engine stores the planned jobs and sends them under rate limits.
 */
import type { ChatRef, InboundMessage, MessageContent } from '../core/types.js';
import { chatKey } from '../core/types.js';
import type { DedupStore } from './dedup.js';
import { renderTemplate } from './template.js';
import { codePointLength, contentFingerprint, normalizeForMatch, removeInviteLinks } from './text.js';
import type { PlannedJob, QuietHours, Route, RouteFilters, RoutingPlan, SkipReason, Template } from './types.js';

const SUPPORTED_DEFAULT = new Set(['text', 'image', 'video', 'audio', 'document']);

export interface RouterOptions {
  dedup: DedupStore;
  /** How long a fingerprint blocks the same content to the same target. Default 6 hours. */
  dedupWindowMs?: number;
  templates: (tenantId: string, id: string) => Template | undefined;
  now?: () => Date;
}

/** Applies a route's filters. Returns the reason to skip, or null to pass. */
export function checkFilters(f: RouteFilters, msg: InboundMessage): SkipReason | null {
  if ((f.ignoreFromSelf ?? true) && msg.fromSelf) return 'from_self';
  if (f.ignoreForwarded && msg.isForwarded) return 'forwarded';
  const kinds = f.kinds?.length ? new Set<string>(f.kinds) : SUPPORTED_DEFAULT;
  if (!kinds.has(msg.content.kind)) return 'kind_not_allowed';
  const text = normalizeForMatch(msg.content.text ?? '');
  if (f.includeAny?.length && !f.includeAny.some((w) => text.includes(normalizeForMatch(w)))) return 'missing_keyword';
  if (f.excludeAny?.some((w) => w.trim() && text.includes(normalizeForMatch(w)))) return 'excluded_keyword';
  if (msg.content.kind === 'text' && f.minTextLength && codePointLength(text) < f.minTextLength) return 'too_short';
  return null;
}

/** Local hour and minute in a time zone. */
function zonedMinutes(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

function hm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad time "${s}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function inQuietHours(d: Date, q: QuietHours): boolean {
  const t = zonedMinutes(d, q.timeZone);
  const s = hm(q.start);
  const e = hm(q.end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

/** The first minute at or after `d` that is outside quiet hours. */
export function nextAllowedTime(d: Date, q: QuietHours): Date {
  let t = new Date(Math.ceil(d.getTime() / 60_000) * 60_000);
  if (!inQuietHours(d, q)) return d;
  for (let i = 0; i < 24 * 60 + 1; i++) {
    if (!inQuietHours(t, q)) return t;
    t = new Date(t.getTime() + 60_000);
  }
  return d; // a 24h quiet window would block forever; treat as no window
}

export class Router {
  private readonly dedupWindowMs: number;
  private readonly now: () => Date;

  constructor(private readonly opts: RouterOptions) {
    this.dedupWindowMs = opts.dedupWindowMs ?? 6 * 60 * 60 * 1000;
    this.now = opts.now ?? (() => new Date());
  }

  async plan(msg: InboundMessage, routes: Route[]): Promise<RoutingPlan> {
    const plan: RoutingPlan = { jobs: [], skipped: [] };
    const srcKey = chatKey(msg.source);
    const fingerprint = contentFingerprint(msg.content.text, msg.content.media);

    for (const route of routes) {
      if (route.tenantId !== msg.tenantId) continue; // never cross tenants
      if (!route.sources.some((s) => chatKey(s) === srcKey)) {
        continue; // not relevant; not worth reporting
      }
      if (!route.enabled) {
        plan.skipped.push({ routeId: route.id, reason: 'route_disabled' });
        continue;
      }
      const reason = checkFilters(route.filters, msg);
      if (reason) {
        plan.skipped.push({ routeId: route.id, reason });
        continue;
      }

      let body = msg.content.text ?? '';
      if (route.filters.removeInviteLinks ?? true) body = removeInviteLinks(body);
      if (msg.content.kind === 'text' && !body.trim()) {
        plan.skipped.push({ routeId: route.id, reason: 'empty_after_cleanup' });
        continue;
      }

      const template = route.templateId ? this.opts.templates(route.tenantId, route.templateId) : undefined;
      const now = this.now();
      let notBefore = new Date(now.getTime() + (route.delaySeconds ?? 0) * 1000);
      if (route.quietHours) notBefore = nextAllowedTime(notBefore, route.quietHours);

      for (const target of route.targets) {
        const tKey = chatKey(target);
        if (tKey === srcKey) continue; // a group never feeds itself
        const fresh = await this.opts.dedup.claim(`fp:${route.tenantId}:${tKey}:${fingerprint}`, this.dedupWindowMs);
        if (!fresh) {
          plan.skipped.push({ routeId: route.id, reason: 'duplicate', target: tKey });
          continue;
        }
        const rendered = renderTemplate(template, {
          content: body,
          groupName: target.title,
          now,
          platform: target.platform,
          isCaption: msg.content.kind !== 'text',
        });
        const content: MessageContent = { kind: msg.content.kind, text: rendered.text, ...(msg.content.media ? { media: msg.content.media } : {}) };
        plan.jobs.push({
          tenantId: route.tenantId,
          routeId: route.id,
          source: msg.source,
          sourceMessageId: msg.messageId,
          target,
          content,
          notBefore,
          requiresApproval: route.requireApproval,
          idempotencyKey: `${srcKey}|${msg.messageId}|${route.id}|${tKey}`,
        });
      }
    }
    return plan;
  }
}

export interface RouteProblem {
  code:
    | 'no_sources'
    | 'no_targets'
    | 'target_is_source'
    | 'cannot_send'
    | 'unknown_chat'
    | 'foreign_account'
    | 'too_many_targets'
    | 'bad_quiet_hours';
  message: string;
  chat?: string;
}

/**
 * Checks a route before it is saved. `chats` is what the connected accounts
 * can see right now; `ownAccounts` are this tenant's account ids;
 * `maxTargets` comes from the tenant's plan.
 */
export function validateRoute(
  route: Pick<Route, 'sources' | 'targets' | 'quietHours'>,
  ctx: { chats: Map<string, { canSend: boolean; title: string }>; ownAccounts: Set<string>; maxTargets: number },
): RouteProblem[] {
  const problems: RouteProblem[] = [];
  if (!route.sources.length) problems.push({ code: 'no_sources', message: 'יש לבחור לפחות קבוצת מקור אחת' });
  if (!route.targets.length) problems.push({ code: 'no_targets', message: 'יש לבחור לפחות קבוצת יעד אחת' });
  if (route.targets.length > ctx.maxTargets) {
    problems.push({ code: 'too_many_targets', message: `המסלול שלך מאפשר עד ${ctx.maxTargets} קבוצות יעד` });
  }
  const sourceKeys = new Set(route.sources.map(chatKey));
  const all: { ref: ChatRef; role: 'source' | 'target' }[] = [
    ...route.sources.map((ref) => ({ ref, role: 'source' as const })),
    ...route.targets.map((ref) => ({ ref, role: 'target' as const })),
  ];
  for (const { ref, role } of all) {
    const key = chatKey(ref);
    if (!ctx.ownAccounts.has(ref.accountId)) {
      problems.push({ code: 'foreign_account', message: 'הקבוצה שייכת לחשבון שאינו שלך', chat: key });
      continue;
    }
    const info = ctx.chats.get(key);
    if (!info) {
      problems.push({ code: 'unknown_chat', message: 'הקבוצה לא נמצאה במספר המחובר', chat: key });
      continue;
    }
    if (role === 'target') {
      if (sourceKeys.has(key)) problems.push({ code: 'target_is_source', message: `"${info.title}" מוגדרת גם כמקור וגם כיעד`, chat: key });
      if (!info.canSend) problems.push({ code: 'cannot_send', message: `אין לך הרשאה לשלוח ב"${info.title}"`, chat: key });
    }
  }
  if (route.quietHours) {
    try {
      hm(route.quietHours.start);
      hm(route.quietHours.end);
      new Intl.DateTimeFormat('en', { timeZone: route.quietHours.timeZone });
    } catch {
      problems.push({ code: 'bad_quiet_hours', message: 'שעות השקט אינן תקינות' });
    }
  }
  return problems;
}
