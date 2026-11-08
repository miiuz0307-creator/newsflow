/**
 * "🎉 100 people read this message": the customer sets read counts per control group; when a
 * message's copies together reach one, a note goes to the control group once, and the phone
 * is told. Only the highest of several milestones passed at once is announced.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryJobQueue } from '../src/delivery/queue.js';
import { Reporter, readMilestoneText } from '../src/engine/reporter.js';
import { ReadMilestones, snippetOf, type MilestoneNotice } from '../src/engine/readMilestones.js';
import { parseControlSettings, parseReadMilestones } from '../src/routing/router.js';
import type { PlannedJob, Route } from '../src/routing/types.js';

const control = { platform: 'wa' as const, accountId: 'acc', chatId: 'ctrl@g.us' };
const targets = ['a@g.us', 'b@g.us', 'c@g.us'];

function setup(milestones: number[] | undefined) {
  const route: Route = {
    id: 'r1', tenantId: 't1', name: 'שליטה', enabled: true, sources: [control],
    targets: targets.map((chatId) => ({ platform: 'wa' as const, accountId: 'acc', chatId })), filters: {}, requireApproval: false,
    control: { reportMode: 'summary', ...(milestones ? { readMilestones: milestones } : {}) },
  } as Route;
  const routes = { routesForSource: async () => [route], template: async () => undefined };
  const queue = new MemoryJobQueue();
  const reporter = new Reporter({ queue, routes });
  const notices: MilestoneNotice[] = [];
  const ms = new ReadMilestones({ queue, routes, reporter, notify: (n) => { notices.push(n); } });
  return { queue, ms, notices };
}

async function distribute(queue: MemoryJobQueue, text: string) {
  const jobs: PlannedJob[] = targets.map((chatId, i) => ({
    tenantId: 't1', routeId: 'r1', source: control, sourceMessageId: 'SRC1', target: { platform: 'wa', accountId: 'acc', chatId },
    content: { kind: 'text', text }, notBefore: new Date(), requiresApproval: false, idempotencyKey: `send|${i}`, action: 'send', version: 1,
  }));
  await queue.enqueue(jobs);
  for (const j of await queue.claim('w', 10, 60_000)) await queue.complete(j.id, { messageId: `OUT-${j.target.chatId}`, sentAt: new Date() });
}

const reports = (queue: MemoryJobQueue) => [...queue.jobs.values()].filter((j) => j.action === 'report').map((j) => (j.content as { text: string }).text);

async function read(q: MemoryJobQueue, ms: ReadMilestones, chatId: string, reader: string) {
  if (await q.recordRead('wa', chatId, `OUT-${chatId}`, reader)) await ms.onRead('wa', chatId, `OUT-${chatId}`);
}

describe('read milestones', () => {
  test('settings: "100, 500 1000" is read as a sorted list; bad values are refused', () => {
    assert.deepEqual(parseReadMilestones('1000, 100 500,100'), [100, 500, 1000]);
    assert.deepEqual(parseReadMilestones(''), []);
    assert.throws(() => parseReadMilestones('0'));
    assert.throws(() => parseReadMilestones('1,2,3,4,5,6,7'));
    assert.deepEqual(parseControlSettings({ readMilestones: '50, 10' })!.readMilestones, [10, 50]);
    assert.equal(parseControlSettings({ readMilestones: '' })!.readMilestones, undefined);
  });

  test('the note in the control group, once, when the copies together reach the number; the phone is told', async () => {
    const { queue, ms, notices } = setup([5]);
    await distribute(queue, '🔴 *מבזק:* עומסים כבדים בכניסה לירושלים, מומלץ להקדים את היציאה מהבית היום');
    let n = 0;
    for (const chat of targets) for (let i = 0; i < 2; i++) await read(queue, ms, chat, `user${n++}`); // 6 readers across 3 groups
    await read(queue, ms, 'a@g.us', 'user0'); // the same reader again: not counted
    const r = reports(queue);
    assert.equal(r.length, 1, 'announced once');
    assert.equal(r[0], readMilestoneText(5, snippetOf('🔴 *מבזק:* עומסים כבדים בכניסה לירושלים, מומלץ להקדים את היציאה מהבית היום')));
    assert.match(r[0]!, /^🎉 Groupush · יפהההה! 5 אנשים קראו את ההודעה:\n„🔴 מבזק: עומסים/);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.threshold, 5);
    assert.equal(notices[0]!.tenantId, 't1');
  });

  test('several milestones passed together: only the highest is announced, and lower ones never later', async () => {
    const { queue, ms } = setup([1, 2, 3]);
    await distribute(queue, 'שלום');
    // Two reads land before the first check runs (e.g. a burst of receipts).
    await queue.recordRead('wa', 'a@g.us', 'OUT-a@g.us', 'x');
    await queue.recordRead('wa', 'b@g.us', 'OUT-b@g.us', 'y');
    await ms.onRead('wa', 'b@g.us', 'OUT-b@g.us');
    assert.deepEqual(reports(queue).map((t) => /(\d+) אנשים/.exec(t)![1]), ['2']);
    await read(queue, ms, 'c@g.us', 'z');
    assert.deepEqual(reports(queue).map((t) => /(\d+) אנשים/.exec(t)![1]), ['2', '3']);
  });

  test('nothing when the customer set no milestones', async () => {
    const { queue, ms, notices } = setup(undefined);
    await distribute(queue, 'שלום');
    for (let i = 0; i < 5; i++) await read(queue, ms, 'a@g.us', `u${i}`);
    assert.equal(reports(queue).length, 0);
    assert.equal(notices.length, 0);
  });
});
