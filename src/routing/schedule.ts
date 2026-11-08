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
/** WhatsApp formatting markers, and the bullets or emoji people put in front ("⏰ תזמון"). */
const MARKS = /^[^\p{L}\p{N}]+|[\s*_~]+$/gu;
/** "תזמון", also spelled "תיזמון", or "תזמן". */
const WORD = /^(?:תי?זמון|תזמן)(?![\p{L}])/u;
const DAY = /^\s*(?:[:\-–]\s*)?(היום|מחר)(?![\p{L}])/u;
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

const HEAD = /^[^\p{L}\p{N}]*(?:תי?זמון|תזמן)\s*[*_~]*\s*(?:[:\-–]\s*)?(?:(?:היום|מחר)(?![\p{L}])\s*)?(?:[:\-–]\s*)?(?:(?:לשעה|בשעה|ל-?|ב-?)\s*)?[([]?\s*\d{1,2}(?:\s*[:.]\s*\d{2})?\s*[)\]]?\s*(?:[*_~](?=\s|$))?\s*[:\-–]?\s*/u;
function sameLineRest(line: string): string {
  const l = asciiDigits(line.replace(INVISIBLE, '').replace(/\u00A0/g, ' '));
  const head = HEAD.exec(l);
  if (!head) return '';
  let rest = l.slice(head[0].length).trim();
  // "*תזמון 12:20 מבזק*": the opening marker was before the word; give the text its pair back.
  const open = /^\s*([*_~])/.exec(l)?.[1];
  if (open && rest.endsWith(open) && (rest.split(open).length - 1) % 2 === 1) rest = open + rest;
  return rest;
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

function lastLine(text: string): { line: string; before: string } | null {
  const t = text.replace(/(?:\n[\s\p{Cf}]*)+$/u, '');
  const i = t.lastIndexOf('\n');
  if (i < 0) return null;
  return { line: t.slice(i + 1), before: t.slice(0, i).replace(/(?:\n[\s\p{Cf}]*)+$/u, '') };
}

type LineParse = null | 'invalid' | { h: number; mi: number; days: number; sameLine: string };

/** One line read as a schedule instruction ("תזמון (12:20)", "⏰ תזמון מחר 9", …). */
function readLine(line: string): LineParse {
  const c = clean(line);
  const w = WORD.exec(c);
  if (!w) return null;
  let after = c.slice(w[0].length);
  const day = DAY.exec(after);
  if (day) after = after.slice(day[0].length);
  const m = TIME.exec(after);
  if (!m) return 'invalid';
  const h = Number(m[1]);
  const mi = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || mi > 59) return 'invalid';
  return { h, mi, days: day?.[1] === 'מחר' ? 1 : 0, sameLine: sameLineRest(line) };
}

/**
 * Reads the schedule line of a control-group message (text or caption). The line is usually the
 * first one; a schedule written as the last line is read too ("מבזק…\nתזמון 21:30").
 */
export function parseSchedule(text: string | undefined, now: Date, timeZone = SCHEDULE_TIME_ZONE): ScheduleParse {
  if (!text) return { kind: 'none' };
  let r: LineParse;
  let body: string;
  const { line, rest } = firstLine(text);
  r = readLine(line);
  if (r && r !== 'invalid') {
    // The message may start on the same line, right after the time ("תזמון (05:13) *מבזק* ...").
    // Taken from the line as written, so its own *bold* and _italic_ markers stay intact.
    body = r.sameLine ? (rest ? `${r.sameLine}\n${rest}` : r.sameLine) : rest;
  } else if (r === null) {
    const last = lastLine(text);
    if (!last) return { kind: 'none' };
    r = readLine(last.line);
    // At the end only a real time counts: a last line that merely starts with the word is text.
    if (r === null || r === 'invalid') return { kind: 'none' };
    body = r.sameLine ? `${last.before}\n${r.sameLine}` : last.before;
  } else {
    return { kind: 'invalid' };
  }
  const { h, mi, days } = r;
  const today = zonedParts(now, timeZone);
  let at: Date;
  if (days > 0) {
    const tomorrow = new Date(Date.UTC(today.y, today.mo - 1, today.d) + 36 * 3_600_000); // safely inside the next day
    const p = zonedParts(tomorrow, 'UTC');
    at = zonedTime(p.y, p.mo, p.d, h, mi, timeZone);
  } else {
    at = zonedTime(today.y, today.mo, today.d, h, mi, timeZone);
    if (at.getTime() < now.getTime() - GRACE_MS) {
      const tomorrow = new Date(Date.UTC(today.y, today.mo - 1, today.d) + 36 * 3_600_000);
      const p = zonedParts(tomorrow, 'UTC');
      at = zonedTime(p.y, p.mo, p.d, h, mi, timeZone);
    } else if (at.getTime() < now.getTime()) {
      at = now;
    }
  }
  return { kind: 'scheduled', at, hhmm: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, rest: body };
}

/** The message without its schedule line (unchanged when there is none). */
export function stripSchedule(text: string): string {
  const p = parseSchedule(text, new Date());
  return p.kind === 'scheduled' ? p.rest : text;
}
