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
import type { ControlSettings, PlannedJob, QuietHours, Route, RouteFilters, RouteTarget, RoutingPlan, SkipReason, Template } from './types.js';

const SUPPORTED_DEFAULT = new Set(['text', 'image', 'video', 'audio', 'document']);

/** Every status message PUSH posts into a control group starts with an emoji and this tag. */
export const REPORT_TAG = 'PUSH ·';

/** True for a status message PUSH itself posted (so it is never distributed). */
export function isOwnReport(msg: InboundMessage): boolean {
  if (!msg.fromSelf || msg.content.kind !== 'text') return false;
  const head = (msg.content.text ?? '').slice(0, 16);
  return head.includes(REPORT_TAG);
}

/** The phone number or user id in a sender id ("972501234567:3@s.whatsapp.net" → "972501234567"). */
export function senderDigits(senderId: string): string {
  return senderId.split('@')[0]!.split(':')[0]!.replace(/^\+/, '');
}

/** Whether a control group's sender list lets this sender distribute. */
export function senderAllowed(route: Pick<Route, 'control'>, msg: Pick<InboundMessage, 'senderId' | 'fromSelf'>): boolean {
  const list = route.control?.allowedSenders?.map((s) => s.replace(/[\s+\-()]/g, '')).filter(Boolean);
  if (!list?.length) return true;
  if (msg.fromSelf) return true; // the linked number itself is always the customer's
  return list.includes(senderDigits(msg.senderId));
}

/** The text and media one target receives: cleanup, then the route's template. Used for sends and for edits. */
export function renderCopy(
  route: Pick<Route, 'filters' | 'control'>,
  template: Template | undefined,
  source: { kind: MessageContent['kind']; text?: string; media?: MessageContent['media'] },
  target: RouteTarget,
  now: Date,
): MessageContent | null {
  let body = source.text ?? '';
  if (route.filters.removeInviteLinks ?? true) body = removeInviteLinks(body);
  if (source.kind === 'text' && !body.trim()) return null;
  // The control group's fixed signature goes under the message (and under the template, if any).
  const signature = route.control?.signature?.trim();
  const tpl = signature ? { body: `${template?.body ?? '{content}'}\n\n${signature}`, vars: template?.vars ?? {} } : template;
  const rendered = renderTemplate(tpl, {
    content: body,
    groupName: target.title,
    now,
    platform: target.platform,
    isCaption: source.kind !== 'text',
  });
  return { kind: source.kind, text: rendered.text, ...(source.media ? { media: source.media } : {}) };
}

export interface RouterOptions {
  dedup: DedupStore;
  /** How long a fingerprint blocks the same content to the same target. Default 6 hours. */
  dedupWindowMs?: number;
  templates: (tenantId: string, id: string) => Template | undefined | Promise<Template | undefined>;
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

const hmFormatters = new Map<string, Intl.DateTimeFormat>();

/** Local hour and minute in a time zone (formatters cached: they hold native memory). */
function zonedMinutes(d: Date, timeZone: string): number {
  let f = hmFormatters.get(timeZone);
  if (!f) hmFormatters.set(timeZone, (f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })));
  const parts = f.formatToParts(d);
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
    const fingerprint = contentFingerprint(msg.content.text, msg.content.media, `${srcKey}|${msg.messageId}`);
    plan.claimedKeys = [];

    for (const route of routes) {
      if (route.tenantId !== msg.tenantId) continue; // never cross tenants
      if (!route.sources.some((s) => chatKey(s) === srcKey)) {
        continue; // not relevant; not worth reporting
      }
      if (!route.enabled) {
        plan.skipped.push({ routeId: route.id, reason: 'route_disabled' });
        continue;
      }
      // A PUSH status message is never content, for any route reading this group.
      if (isOwnReport(msg)) {
        plan.skipped.push({ routeId: route.id, reason: 'own_report' });
        continue;
      }
      if (!senderAllowed(route, msg)) {
        plan.skipped.push({ routeId: route.id, reason: 'sender_not_allowed' });
        continue;
      }
      // In a control group the customer usually writes from the linked number itself, so "from
      // this number" is the content, not an echo. PUSH's own copies and reports are still never
      // redistributed: copies go to other groups and are recognised by message id (wasSentByUs),
      // and reports carry REPORT_TAG (isOwnReport above).
      const reason = checkFilters(route.control ? { ...route.filters, ignoreFromSelf: false } : route.filters, msg);
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

      const template = route.templateId ? await this.opts.templates(route.tenantId, route.templateId) : undefined;
      const now = this.now();
      let notBefore = new Date(now.getTime() + (route.delaySeconds ?? 0) * 1000);
      if (route.quietHours) notBefore = nextAllowedTime(notBefore, route.quietHours);

      const targets = route.targets.filter((t) => chatKey(t) !== srcKey); // a group never feeds itself
      const keyOf = (t: RouteTarget) => `fp:${route.tenantId}:${chatKey(t)}:${fingerprint}`;
      // A control group is the customer posting on purpose: the same text sent twice goes out twice.
      // (A redelivered message is still caught by the job's idempotency key, which uses the message id.)
      const claimed = route.control ? new Set(targets.map(keyOf)) : await this.claimAll(route.tenantId, targets.map(keyOf));
      if (!route.control) for (const k of claimed) plan.claimedKeys.push({ tenantId: route.tenantId, key: k });

      for (const target of targets) {
        const tKey = chatKey(target);
        if (!claimed.has(keyOf(target))) {
          plan.skipped.push({ routeId: route.id, reason: 'duplicate', target: tKey });
          continue;
        }
        const content = renderCopy(route, template, msg.content, target, now)!;
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
          action: 'send',
          version: 1,
        });
      }
    }
    return plan;
  }

  /** Releases the duplicate keys of a plan whose jobs could not be stored, so a retry isn't skipped. */
  async release(plan: RoutingPlan): Promise<void> {
    const d = this.opts.dedup;
    if (!d.release || !plan.claimedKeys?.length) return;
    const byTenant = new Map<string, string[]>();
    for (const { tenantId, key } of plan.claimedKeys) byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), key]);
    for (const [t, keys] of byTenant) await d.release(t, keys);
  }

  private async claimAll(tenantId: string, keys: string[]): Promise<Set<string>> {
    if (!keys.length) return new Set();
    const d = this.opts.dedup;
    if (d.claimMany) return d.claimMany(tenantId, keys, this.dedupWindowMs);
    const got = new Set<string>();
    for (const k of keys) if (await d.claim(tenantId, k, this.dedupWindowMs)) got.add(k);
    return got;
  }
}

/**
 * Cleans control-group settings from an API request. Returns undefined for
 * "not a control group", or throws a message for invalid input.
 */
export function parseControlSettings(input: unknown): ControlSettings | undefined {
  if (input === undefined || input === null || input === false) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('הגדרות קבוצת השליטה אינן תקינות');
  const i = input as Record<string, unknown>;
  const modes = ['all', 'failures', 'summary', 'off'];
  if (i.reportMode !== undefined && !modes.includes(String(i.reportMode))) throw new Error('סוג הדיווח חייב להיות all, failures, summary או off');
  let allowed: string[] | undefined;
  if (i.allowedSenders !== undefined) {
    if (!Array.isArray(i.allowedSenders) || i.allowedSenders.length > 50) throw new Error('רשימת השולחים המורשים אינה תקינה (עד 50)');
    allowed = i.allowedSenders.map((x) => String(x).replace(/[\s+\-()]/g, ''));
    if (allowed.some((x) => !/^\d{5,15}$/.test(x))) throw new Error('שולח מורשה הוא מספר טלפון עם קידומת מדינה, או מזהה משתמש בטלגרם');
  }
  if (i.signature !== undefined && typeof i.signature !== 'string') throw new Error('החתימה חייבת להיות טקסט');
  if (typeof i.signature === 'string' && i.signature.trim().length > 1000) throw new Error('החתימה ארוכה מדי (עד 1,000 תווים)');
  return {
    syncEdits: i.syncEdits !== false,
    syncDeletes: i.syncDeletes !== false,
    reportMode: (i.reportMode as 'all' | 'failures' | 'summary' | 'off' | undefined) ?? 'summary',
    ...(allowed?.length ? { allowedSenders: allowed } : {}),
    ...(typeof i.signature === 'string' && i.signature.trim() ? { signature: i.signature.trim() } : {}),
  };
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
    | 'bad_quiet_hours'
    | 'route_cycle';
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

/**
 * Finds a cycle among a tenant's routes: A→B in one route and B→A in another
 * (possibly through other groups, or through different connected accounts)
 * would bounce every message forever. Chats are compared by platform and chat
 * id only, because two of the tenant's numbers can sit in the same group.
 * Returns the chats on the cycle, or null.
 */
export function findRouteCycle(routes: Pick<Route, 'sources' | 'targets'>[]): string[] | null {
  const key = (c: ChatRef) => `${c.platform}:${c.chatId}`;
  const edges = new Map<string, Set<string>>();
  for (const r of routes) {
    for (const s of r.sources) {
      const set = edges.get(key(s)) ?? new Set<string>();
      for (const t of r.targets) set.add(key(t));
      edges.set(key(s), set);
    }
  }
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.has(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of edges.keys()) {
    if (!state.has(n)) {
      const c = visit(n);
      if (c) return c;
    }
  }
  return null;
}
