/** "תזמון (12:20)" — reading the schedule line in Israel time. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, stripSchedule, zonedTime } from '../src/routing/schedule.js';

const at = (iso: string) => new Date(iso);

describe('scheduled messages', () => {
  test('a time later today is today, Israel time (winter: UTC+2, summer: UTC+3)', () => {
    const w = parseSchedule('תזמון (12:20)\nמבזק', at('2026-11-10T08:00:00Z')); // 10:00 in Israel
    assert.equal(w.kind, 'scheduled');
    assert.equal(w.kind === 'scheduled' && w.at.toISOString(), '2026-11-10T10:20:00.000Z');
    assert.equal(w.kind === 'scheduled' && w.rest, 'מבזק');
    const s = parseSchedule('תזמון (12:20)\nמבזק', at('2026-07-10T06:00:00Z')); // 09:00 in Israel
    assert.equal(s.kind === 'scheduled' && s.at.toISOString(), '2026-07-10T09:20:00.000Z');
  });

  test('a time that already passed means tomorrow; a minute late still means now', () => {
    const r = parseSchedule('תזמון (09:00)\nמחר בבוקר', at('2026-11-10T10:00:00Z')); // 12:00 in Israel
    assert.equal(r.kind === 'scheduled' && r.at.toISOString(), '2026-11-11T07:00:00.000Z');
    const now = at('2026-11-10T10:21:00Z'); // 12:21
    const late = parseSchedule('תזמון (12:20)\nאיחור קטן', now);
    assert.equal(late.kind === 'scheduled' && late.at.getTime(), now.getTime());
  });

  test('accepted forms, and what is not a schedule', () => {
    for (const line of ['תזמון (12:20)', 'תזמון 12:20', 'תזמון: 12.20', 'תזמון [12:20]', '  תזמון ( 12:20 )  ']) {
      assert.equal(parseSchedule(`${line}\nטקסט`, at('2026-11-10T08:00:00Z')).kind, 'scheduled', line);
    }
    assert.equal(parseSchedule('תזמון (25:00)\nטקסט', new Date()).kind, 'invalid');
    assert.equal(parseSchedule('תזמון מחר\nטקסט', new Date()).kind, 'invalid');
    assert.equal(parseSchedule('תזמונים חדשים לאוטובוסים', new Date()).kind, 'none', 'a word that only starts with it');
    assert.equal(parseSchedule('מבזק\nתזמון (12:20)', new Date()).kind, 'none', 'only the first line counts');
    assert.equal(stripSchedule('תזמון (12:20)\n\nמבזק'), 'מבזק');
    assert.equal(stripSchedule('מבזק רגיל'), 'מבזק רגיל');
  });

  test('forgiving: invisible marks, bold, "ל-", whole hours, message on the same line', () => {
    const now = at('2026-11-10T08:00:00Z'); // 10:00 in Israel
    const iso = (t: string) => { const p = parseSchedule(t, now); return p.kind === 'scheduled' ? [p.at.toISOString(), p.rest] : p.kind; };
    assert.deepEqual(iso('‏תזמון (12:20)‏\nמבזק'), ['2026-11-10T10:20:00.000Z', 'מבזק'], 'RLM marks WhatsApp adds');
    assert.deepEqual(iso('*תזמון (12:20)*\nמבזק'), ['2026-11-10T10:20:00.000Z', 'מבזק'], 'bold');
    assert.deepEqual(iso('תזמון ל-12:20\nמבזק'), ['2026-11-10T10:20:00.000Z', 'מבזק']);
    assert.deepEqual(iso('תזמון לשעה 12:20\nמבזק'), ['2026-11-10T10:20:00.000Z', 'מבזק']);
    assert.deepEqual(iso('תזמון 13\nמבזק'), ['2026-11-10T11:00:00.000Z', 'מבזק'], 'a whole hour');
    assert.deepEqual(iso('תזמון 12:20 מבזק: הכביש נפתח\nפרטים בהמשך'), ['2026-11-10T10:20:00.000Z', 'מבזק: הכביש נפתח\nפרטים בהמשך'], 'same line');
    assert.deepEqual(iso('תזמון (12:20)\nמבזק'), ['2026-11-10T10:20:00.000Z', 'מבזק'], 'no-break space');
    assert.deepEqual(iso('\nתזמון (12:20)\n\nמבזק'), ['2026-11-10T10:20:00.000Z', 'מבזק'], 'blank lines around');
    assert.deepEqual(iso('תזמון (05:13) *ספר ים 170ש* מסילת יוסף זמן'), ['2026-11-11T03:13:00.000Z', '*ספר ים 170ש* מסילת יוסף זמן'], 'the example from the owner: same line, bold kept');
    assert.deepEqual(iso('תזמון (12:20) מבזק *חשוב*\nעוד שורה'), ['2026-11-10T10:20:00.000Z', 'מבזק *חשוב*\nעוד שורה'], 'bold at the end of the line kept');
    assert.deepEqual(iso('*תזמון 12:20 מבזק*'), ['2026-11-10T10:20:00.000Z', '*מבזק*'], 'whole line in bold');
    assert.deepEqual(iso('תיזמון (12:20)\nמבזק'), ['2026-11-10T10:20:00.000Z', 'מבזק'], 'spelled with yod');
    assert.deepEqual(iso('תזמן 12:20\nמבזק'), ['2026-11-10T10:20:00.000Z', 'מבזק']);
    assert.equal(iso('תזמון 1220\nמבזק'), 'invalid');
  });

  test('wall-clock time in summer and winter', () => {
    assert.equal(zonedTime(2026, 8, 1, 12, 20).toISOString(), '2026-08-01T09:20:00.000Z');
    assert.equal(zonedTime(2026, 12, 1, 12, 20).toISOString(), '2026-12-01T10:20:00.000Z');
  });
});
