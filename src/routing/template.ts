/**
 * Message templates.
 *
 * Placeholders are written in braces and accept English or Hebrew names, so
 * the customer can paste the template from the spec as-is:
 *
 *   🔴 חדשות בזמן אמת
 *   {תוכן החדשות}
 *   📲 להצטרפות: {קישור WhatsApp}
 *
 * Platform limits are respected by shortening only the news content, never
 * the customer's header, footer or links.
 */
import type { Platform } from '../core/types.js';
import type { Template } from './types.js';
import { codePointLength, truncate } from './text.js';

const ALIASES: Record<string, string> = {
  content: 'content',
  'תוכן': 'content',
  'תוכן החדשות': 'content',
  'תוכן ההודעה': 'content',
  group_name: 'group_name',
  'שם הקבוצה': 'group_name',
  whatsapp_link: 'whatsapp_link',
  'קישור whatsapp': 'whatsapp_link',
  'קישור וואטסאפ': 'whatsapp_link',
  telegram_link: 'telegram_link',
  'קישור telegram': 'telegram_link',
  'קישור טלגרם': 'telegram_link',
  date: 'date',
  'תאריך': 'date',
  time: 'time',
  'שעה': 'time',
};

const PLACEHOLDER = /\{([^{}\n]{1,40})\}/g;

/** Maximum characters per platform and message type. */
export const LIMITS: Record<Platform, { text: number; caption: number }> = {
  wa: { text: 65_000, caption: 1_024 },
  tg: { text: 4_096, caption: 1_024 },
};

export interface RenderContext {
  content: string;
  groupName?: string;
  now?: Date;
  timeZone?: string;
  platform: Platform;
  isCaption: boolean;
}

export interface RenderResult {
  text: string;
  /** Placeholders that had no value; shown as warnings in the template preview. */
  unknown: string[];
  truncated: boolean;
}

function canonical(name: string): string {
  const key = name.trim().toLowerCase();
  return ALIASES[key] ?? key.replace(/\s+/g, '_');
}

/** Lists the placeholders a template uses, in canonical form. */
export function placeholdersOf(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => canonical(m[1]!)))];
}

export function renderTemplate(tpl: Pick<Template, 'body' | 'vars'> | undefined, ctx: RenderContext): RenderResult {
  const body = tpl?.body ?? '{content}';
  const tz = ctx.timeZone ?? 'Asia/Jerusalem';
  const now = ctx.now ?? new Date();
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(tpl?.vars ?? {})) vars[canonical(k)] = v;
  const builtins: Record<string, string> = {
    group_name: ctx.groupName ?? '',
    date: new Intl.DateTimeFormat('he-IL', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(now),
    time: new Intl.DateTimeFormat('he-IL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now),
  };
  const unknown: string[] = [];

  const fill = (content: string) =>
    body.replace(PLACEHOLDER, (whole, rawName: string) => {
      const name = canonical(rawName);
      if (name === 'content') return content;
      if (name in vars) return vars[name]!;
      if (name in builtins) return builtins[name]!;
      if (!unknown.includes(name)) unknown.push(name);
      return whole;
    });

  const limit = ctx.isCaption ? LIMITS[ctx.platform].caption : LIMITS[ctx.platform].text;
  let text = fill(ctx.content);
  let truncated = false;
  if (codePointLength(text) > limit) {
    truncated = true;
    const overhead = codePointLength(fill(''));
    const room = Math.max(0, limit - overhead);
    text = fill(truncate(ctx.content, room));
    if (codePointLength(text) > limit) text = truncate(text, limit); // template itself too long
  }
  // Lines that held only an empty placeholder (e.g. missing link) collapse.
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { text, unknown, truncated };
}
