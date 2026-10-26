/**
 * Scheduled messages in a control group. A message whose first line is
 *   תזמון (12:20)
 * goes out at 12:20 Israel time, without that line. The time is today; a time that
 * has already passed (by more than two minutes) means tomorrow.
 *
 * Written on phones, so the reading is forgiving: invisible direction marks that
 * WhatsApp adds to Hebrew text, *bold* / _italic_ markers, "ל-12:20" / "לשעה 12:20",
 * 12.20 or 12:20, a whole hour ("תזמון 9"), and the message itself continuing on the
 * same line ("תזמון 12:20 מבזק: ...") are all accepted.
 */

export const SCHEDULE_TIME_ZONE = 'Asia/Jerusalem';
/** A time this far in the past still counts as "now" (someone typing 12:20 at 12:21). */
const GRACE_MS = 2 * 60_000;

/** Direction marks, zero-width characters and other invisible format characters. */
const INVISIBLE = /[\p{Cf}­]/gu;
/** WhatsApp formatting markers and the bullets people put in front. */
const MARKS = /^[\s*_~>•\-–—]+|[\s*_~]+$/gu;
/** "תזמון", also spelled "תיזמון", or "תזמן". */
const WORD = /^(?:תי?זמון|תזמן)(?![\p{L}])/u;
const TIME = /^\s*(?:[:\-–]\s*)?(?:(?:לשעה|בשעה|ל-?|ב-?)\s*)?[([]?\s*(\d{1,2})(?:\s*[:.]\s*(\d{2}))?\s*[)\]]?(?![\d:.])\s*[:\-–]?\s*(.*)$/u;

export type ScheduleParse =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'scheduled'; at: Date; hhmm: string; rest: string };

/** Arabic-Indic and Persian digits → 0-9 (some keyboards type those). */
function asciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) => String((c.charCodeAt(0) & 0xf) % 10));
}

function firstLine(text: string): { line: string; rest: string } {
  const t = text.replace(/^(?:[\s\p{Cf}]*\n)+/u, '');
  const i = t.indexOf('\n');
  return i < 0 ? { line: t, rest: '' } : { line: t.slice(0, i), rest: t.slice(i + 1).replace(/^(?:[\s\p{Cf}]*\n)+/u, '') };
}

/** The first line as a person reads it: no invisible marks, no bold/italic markers. */
function clean(line: string): string {
  return asciiDigits(line.replace(INVISIBLE, '').replace(/ /g, ' ')).replace(MARKS, '').trim();
}

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function zonedParts(d: Date, timeZone: string) {
  let f = partsFmt.get(timeZone);
  if (!f) partsFmt.set(timeZone, (f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })));
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
}

/** The instant when the wall clock in `timeZone` shows y-mo-d h:mi (handles summer/winter time). */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, timeZone = SCHEDULE_TIME_ZONE): Date {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(t), timeZone);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    t += want - shown;
  }
  return new Date(t);
}

/** Reads the schedule line of a control-group message (text or caption). */
export function parseSchedule(text: string | undefined, now: Date, timeZone = SCHEDULE_TIME_ZONE): ScheduleParse {
  if (!text) return { kind: 'none' };
  const { line, rest } = firstLine(text);
  const c = clean(line);
  const w = WORD.exec(c);
  if (!w) return { kind: 'none' };
  const m = TIME.exec(c.slice(w[0].length));
  if (!m) return { kind: 'invalid' };
  const h = Number(m[1]);
  const mi = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || mi > 59) return { kind: 'invalid' };
  // The message may start on the same line, right after the time.
  const sameLine = (m[3] ?? '').trim();
  const body = sameLine ? (rest ? `${sameLine}\n${rest}` : sameLine) : rest;
  const today = zonedParts(now, timeZone);
  let at = zonedTime(today.y, today.mo, today.d, h, mi, timeZone);
  if (at.getTime() < now.getTime() - GRACE_MS) {
    const tomorrow = new Date(Date.UTC(today.y, today.mo - 1, today.d) + 36 * 3_600_000); // safely inside the next day
    const p = zonedParts(tomorrow, 'UTC');
    at = zonedTime(p.y, p.mo, p.d, h, mi, timeZone);
  } else if (at.getTime() < now.getTime()) {
    at = now;
  }
  return { kind: 'scheduled', at, hhmm: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, rest: body };
}

/** The message without its schedule line (unchanged when there is none). */
export function stripSchedule(text: string): string {
  const p = parseSchedule(text, new Date());
  return p.kind === 'scheduled' ? p.rest : text;
}
