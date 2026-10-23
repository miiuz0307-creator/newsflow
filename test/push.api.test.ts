/**
 * PUSH API on the real schema: control-group routes, distribution history,
 * per-copy status, manual retry (with confirmation for unknown copies),
 * tenant isolation, and the dashboard page.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/api/auth.js';
import { pushModule } from '../src/api/modules/push.js';
import { ApiServer } from '../src/api/server.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgDedupStore, PgJobQueue, PgKillSwitchStore, PgRouteSource, PgSourceMessageStore, TenantKeys, withTenant } from '../src/db/pgStores.js';
import { MemoryMediaStore } from '../src/delivery/mediaStore.js';
import { Worker } from '../src/engine/worker.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { memoryStores, waitFor } from './helpers.js';
import { adminSetTenant, createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const available = await pgAvailable();
const SECRET = 'push-api-secret-0123456789abcdefghijkl';
const LINKED = '972500000401';
const CUSTOMER = '972500000402';

describe('PUSH API', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb;
  let api: ApiServer;
  let worker: Worker;
  let conns: ConnectionManager;
  const net = new FakeWaNetwork({ connectDelayMs: 1 });
  let tA: string, tB: string, tokA: string, tokB: string, acc: string;
  let ctrl: string, g1: string, g2: string;

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(api.url + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, body: json, text, headers: r.headers };
  };
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      await worker.settle();
      if (!(await worker.dispatcher.tick()).claimed) break;
    }
    await worker.settle();
  };

  before(async () => {
    db = await createTestDb();
    const keys = new TenantKeys(new MasterKey('mk-push', MasterKey.generateB64()), db.worker);
    tA = await keys.provision(db.app, 'חדשות A', 'trial', 'push-a@example.com');
    await adminSetTenant(db, tA, 'premium');
    tB = await keys.provision(db.app, 'B', 'trial', 'push-b@example.com');
    const uid = async (t: string) => (await withTenant(db.app, t, (c) => c.query<{ id: string }>('SELECT id FROM users'))).rows[0]!.id;
    tokA = signToken({ tenantId: tA, userId: await uid(tA), role: 'owner' }, SECRET);
    tokB = signToken({ tenantId: tB, userId: await uid(tB), role: 'owner' }, SECRET);
    acc = (await withTenant(db.app, tA, (c) => c.query<{ id: string }>(`INSERT INTO wa_accounts (tenant_id, label) VALUES ($1, 'push') RETURNING id`, [tA]))).rows[0]!.id;

    ctrl = net.createGroup('שליטה', { members: [LINKED, CUSTOMER] });
    g1 = net.createGroup('יעד 1', { members: [LINKED] });
    g2 = net.createGroup('יעד 2', { members: [LINKED] });
    await withTenant(db.app, tA, async (c) => {
      for (const [jid, title] of [[ctrl, 'שליטה'], [g1, 'יעד 1'], [g2, 'יעד 2']] as const) {
        await c.query('INSERT INTO chats (tenant_id, platform, account_id, chat_id, title, can_send) VALUES ($1, $2, $3, $4, $5, true)', [tA, 'wa', acc, jid, title]);
      }
    });

    const { factory } = memoryStores();
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(net), storeFactory: async (t, a) => factory(t, a) });
    const queue = new PgJobQueue(db.worker, db.app);
    worker = new Worker({
      workerId: 'w-push-api', connections: conns, queue, routes: new PgRouteSource(db.worker), dedup: new PgDedupStore(db.worker),
      killSwitches: new PgKillSwitchStore(db.worker), media: new MemoryMediaStore(), sources: new PgSourceMessageStore(db.worker),
      dailyCapFor: () => 10_000, rulesOverride: { wa: { accountMinGapMs: 0, chatMinGapMs: 0, accountPerMinute: 10_000 } },
    });
    api = new ApiServer({ appPool: db.app, connections: conns, queue, killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET, modules: [pushModule()] });
    await api.listen();

    await conns.connect(tA, acc, { method: 'qr' });
    await waitFor(() => !!conns.getState(acc)?.qr);
    net.scanQr(LINKED, conns.getState(acc)!.qr!);
    await waitFor(() => conns.getState(acc)?.status === 'connected');
  });

  after(async () => {
    await api?.close();
    await worker?.shutdown();
    await db?.drop();
  });

  test('a control-group route is validated and saved', async () => {
    const base = {
      name: 'PUSH', sources: [{ platform: 'wa', accountId: acc, chatId: ctrl }],
      targets: [{ platform: 'wa', accountId: acc, chatId: g1, title: 'יעד 1' }, { platform: 'wa', accountId: acc, chatId: g2, title: 'יעד 2' }],
    };
    const bad = await call('POST', '/v1/routes', { ...base, control: { reportMode: 'loud' } }, tokA);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_control');
    const badSender = await call('POST', '/v1/routes', { ...base, control: { allowedSenders: ['not a phone'] } }, tokA);
    assert.equal(badSender.status, 400);
    const ok = await call('POST', '/v1/routes', { ...base, control: { reportMode: 'summary', allowedSenders: ['+972 50-000-0402'] } }, tokA);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const r = await withTenant(db.app, tA, (c) => c.query<{ control: any }>('SELECT control FROM routes'));
    assert.deepEqual(r.rows[0]!.control, { syncEdits: true, syncDeletes: true, reportMode: 'summary', allowedSenders: ['972500000402'] });
  });

  test('distribution history shows each copy; another tenant sees nothing', async () => {
    const id = net.humanPost(CUSTOMER, ctrl, { kind: 'text', text: 'עדכון חשוב' });
    await drain();
    const list = await call('GET', '/v1/distributions', undefined, tokA);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].copies.sent, 2);
    assert.equal(list.body[0].source.title, 'שליטה');
    assert.equal(list.body[0].preview, 'עדכון חשוב');

    const path = `/v1/distributions/wa/${acc}/${encodeURIComponent(ctrl)}/${encodeURIComponent(id)}`;
    const detail = await call('GET', path, undefined, tokA);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.copies.map((c: any) => [c.target.title, c.status]), [['יעד 1', 'sent'], ['יעד 2', 'sent']]);

    assert.deepEqual((await call('GET', '/v1/distributions', undefined, tokB)).body, []);
    assert.equal((await call('GET', path, undefined, tokB)).status, 404, 'RLS hides another tenant');
  });

  test('an unknown copy needs explicit confirmation before it is sent again', async () => {
    net.loseNextAck(LINKED);
    const id = net.humanPost(CUSTOMER, ctrl, { kind: 'text', text: 'ללא אישור' });
    await drain();
    const path = `/v1/distributions/wa/${acc}/${encodeURIComponent(ctrl)}/${encodeURIComponent(id)}`;
    const unknown = (await call('GET', path, undefined, tokA)).body.copies.find((c: any) => c.status === 'unknown');
    assert.ok(unknown);

    assert.equal((await call('POST', `/v1/jobs/${unknown.jobId}/retry`, {}, tokB)).status, 404, 'not another tenant\'s job');
    const refused = await call('POST', `/v1/jobs/${unknown.jobId}/retry`, {}, tokA);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'confirm_required');
    const ok = await call('POST', `/v1/jobs/${unknown.jobId}/retry`, { confirmNotDelivered: true }, tokA);
    assert.equal(ok.status, 200);
    await drain();
    const after = (await call('GET', path, undefined, tokA)).body.copies.find((c: any) => c.jobId === unknown.jobId);
    assert.equal(after.status, 'sent');
    const audit = await withTenant(db.app, tA, (c) => c.query(`SELECT 1 FROM audit_log WHERE action = 'job.requeued'`));
    assert.equal(audit.rowCount, 1);
  });

  test('an edit shows as a new version with the edit status per copy', async () => {
    const id = net.humanPost(CUSTOMER, ctrl, { kind: 'text', text: 'טעות כתיב' });
    await drain();
    net.humanEdit(CUSTOMER, ctrl, id, { kind: 'text', text: 'ללא טעות כתיב' });
    await drain();
    const path = `/v1/distributions/wa/${acc}/${encodeURIComponent(ctrl)}/${encodeURIComponent(id)}`;
    const d = (await call('GET', path, undefined, tokA)).body;
    assert.deepEqual(d.versions.map((v: any) => [v.version, v.text]), [[1, 'טעות כתיב'], [2, 'ללא טעות כתיב']]);
    assert.ok(d.copies.every((c: any) => c.edit?.status === 'sent' && c.edit.version === 2));
    const top = (await call('GET', '/v1/distributions', undefined, tokA)).body[0];
    assert.equal(top.version, 2);
    assert.equal(top.preview, 'ללא טעות כתיב', 'the list shows the latest wording');
    assert.equal(top.edits.sent, 2);
  });

  test('a message deleted in the control group cannot be retried, and its copies stay hidden', async () => {
    net.loseNextAck(LINKED);
    const id = net.humanPost(CUSTOMER, ctrl, { kind: 'text', text: 'נמחק אחר כך' });
    await drain();
    net.humanDeleteForEveryone(CUSTOMER, ctrl, id);
    await drain();
    const path = `/v1/distributions/wa/${acc}/${encodeURIComponent(ctrl)}/${encodeURIComponent(id)}`;
    const d = (await call('GET', path, undefined, tokA)).body;
    assert.equal(d.deleted, true);
    const unknown = d.copies.find((c: any) => c.status === 'unknown');
    assert.ok(unknown);
    const r = await call('POST', `/v1/jobs/${unknown.jobId}/retry`, { confirmNotDelivered: true }, tokA);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'source_deleted');
    // The queue refuses it too, even if called directly.
    assert.equal(await new PgJobQueue(db.worker, db.app).requeue(tA, unknown.jobId), false);
  });

  test('retention keeps the message kind and blocks retries of purged content', async () => {
    net.humanPost(CUSTOMER, ctrl, { kind: 'text', text: 'ישן מאוד' });
    await drain();
    await db.worker.query(`UPDATE outbound_jobs SET status = 'failed', updated_at = now() - interval '8 days' WHERE content->>'text' = 'ישן מאוד' AND action = 'send'`);
    await db.worker.query('SELECT * FROM purge_expired(7)');
    const rows = await db.worker.query<{ id: string; content: any }>(`SELECT id::text, content FROM outbound_jobs WHERE content ? 'purged'`);
    assert.ok(rows.rowCount >= 2);
    assert.ok(rows.rows.every((r) => r.content.kind === 'text' && r.content.text === undefined));
    const again = await db.worker.query('SELECT * FROM purge_expired(7)');
    assert.equal(Number((again.rows[0] as any).jobs_cleared), 0, 'purging is not repeated every hour');
    const r = await call('POST', `/v1/jobs/${rows.rows[0]!.id}/retry`, {}, tokA);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'purged');
  });

  test('capabilities are public; the dashboard page is served with a strict CSP', async () => {
    const caps = await call('GET', '/v1/capabilities');
    assert.equal(caps.status, 200);
    assert.equal(caps.body.tg.receiveDeletes, false);
    assert.equal(caps.body.wa.editWindowMs, 15 * 60_000);
    const home = await call('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy') ?? '', /font-src 'self'/);
    assert.match(home.text, /הודעה אחת\./);
    assert.ok(!/style="/.test(home.text), 'no inline style attributes (blocked by the CSP)');
    const page = await call('GET', '/app');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce && page.text.includes(`nonce="${nonce}"`));
    assert.match(page.text, /כל הקבוצות\./);
    assert.match(page.text, /\/v1\/auth\/signup/, 'the app can open an account');
    assert.ok(!/innerHTML/.test(page.text), 'no innerHTML in the page script');
  });

  test('the dashboard script parses (it lives inside a template string)', async () => {
    const page = await call('GET', '/app');
    const scripts = [...page.text.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    assert.ok(scripts.length > 0);
    for (const code of scripts) assert.doesNotThrow(() => new Function(code), 'a syntax error would leave the app blank');
  });

  test('the fixed signature is saved per account and added under every copy, also on edits', async () => {
    const empty = await call('GET', '/v1/push/settings', undefined, tokA);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.signature, '');
    assert.equal(empty.body.controlGroups.length, 1);

    assert.equal((await call('PUT', '/v1/push/settings', { signature: 'x'.repeat(1001) }, tokA)).status, 400);
    assert.equal((await call('PUT', '/v1/push/settings', { reportMode: 'loud' }, tokA)).status, 400);
    const none = await call('PUT', '/v1/push/settings', { signature: 'B' }, tokB);
    assert.equal(none.status, 404, 'another tenant has no control group');

    const sig = '📲 להצטרפות: chat.whatsapp.com/abc';
    const saved = await call('PUT', '/v1/push/settings', { signature: sig, reportMode: 'failures' }, tokA);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const now = await call('GET', '/v1/push/settings', undefined, tokA);
    assert.equal(now.body.signature, sig);
    assert.equal(now.body.reportMode, 'failures');
    const r = await withTenant(db.app, tA, (c) => c.query<{ control: any }>('SELECT control FROM routes'));
    assert.deepEqual(r.rows[0]!.control.allowedSenders, ['972500000402'], 'other control settings are kept');

    const id = net.humanPost(CUSTOMER, ctrl, { kind: 'text', text: 'כביש 6 נפתח' });
    await drain();
    const copy = () => net.groupLog(g1).at(-1)!;
    assert.equal((copy().content as { text: string }).text, `כביש 6 נפתח\n\n${sig}`);
    net.humanEdit(CUSTOMER, ctrl, id, { kind: 'text', text: 'כביש 6 נפתח לתנועה' });
    await drain();
    assert.equal((copy().content as { text: string }).text, `כביש 6 נפתח לתנועה\n\n${sig}`, 'the edit keeps the signature');

    await call('PUT', '/v1/push/settings', { signature: '' }, tokA);
    net.humanPost(CUSTOMER, ctrl, { kind: 'text', text: 'בלי חתימה' });
    await drain();
    assert.equal((copy().content as { text: string }).text, 'בלי חתימה');
  });

  test('reads are counted once per reader and shown per copy and per distribution', async () => {
    const id = net.humanPost(CUSTOMER, ctrl, { kind: 'text', text: 'נקראה?' });
    await drain();
    const c1 = net.groupLog(g1).at(-1)!, c2 = net.groupLog(g2).at(-1)!;
    net.read(g1, c1.id, '972540000001');
    net.read(g1, c1.id, '972540000001');
    net.read(g1, c1.id, '972540000002');
    net.read(g2, c2.id, '972540000003');
    net.read(ctrl, id, '972540000009'); // a read in the control group is not a read of a copy
    const path = `/v1/distributions/wa/${acc}/${encodeURIComponent(ctrl)}/${encodeURIComponent(id)}`;
    await worker.settle();
    const detail = await call('GET', path, undefined, tokA);
    assert.deepEqual(detail.body.copies.map((c: any) => [c.target.title, c.reads]), [['יעד 1', 2], ['יעד 2', 1]]);
    const list = await call('GET', '/v1/distributions', undefined, tokA);
    assert.equal(list.body.find((d: any) => d.preview === 'נקראה?').reads, 3);
    const rows = await withTenant(db.app, tB, (c) => c.query('SELECT * FROM message_reads'));
    assert.equal(rows.rowCount, 0, 'reads are tenant-scoped');
  });

  test('the free plan matches the site: 10 groups, Telegram included', async () => {
    const r = await db.owner.query<{ limits: any }>(`SELECT limits FROM plans WHERE code = 'free'`);
    assert.equal(r.rows[0]!.limits.targets, 10);
    assert.equal(r.rows[0]!.limits.tgBots, 1);
  });

  test('linking a number: risk first, then a QR the app can draw; the list shows each number', async () => {
    const created = await call('POST', '/v1/wa/accounts', { label: 'B' }, tokB);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id as string;
    const early = await call('POST', `/v1/wa/accounts/${id}/connect`, { method: 'qr' }, tokB);
    assert.equal(early.status, 412, 'the risk explanation must be accepted first');
    assert.equal((await call('POST', '/v1/risk/accept', {}, tokB)).status, 200);
    const linking = await call('POST', `/v1/wa/accounts/${id}/connect`, { method: 'qr' }, tokB);
    assert.equal(linking.status, 200);
    await waitFor(() => !!conns.getState(id)?.qr);
    const list = await call('GET', '/v1/wa/accounts', undefined, tokB);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].status, 'linking_qr');
    assert.ok(list.body[0].qrRows.length >= 21 && list.body[0].qrRows.every((r: string) => /^[01]+$/.test(r)));

    net.scanQr('972500000777', list.body[0].qr);
    await waitFor(() => conns.getState(id)?.status === 'connected');
    const after = await call('GET', `/v1/wa/accounts/${id}`, undefined, tokB);
    assert.equal(after.body.status, 'connected');
    assert.equal(after.body.qrRows, null, 'no code once linked');
    assert.equal(after.body.phoneNumber, '972500000777');

    const mine = await call('GET', '/v1/wa/accounts', undefined, tokA);
    assert.deepEqual(mine.body.map((a: any) => a.id), [acc], 'each tenant sees only its own numbers');
    await call('DELETE', `/v1/wa/accounts/${id}`, undefined, tokB);
  });

  test('settings return the control group and its targets for the connect screen', async () => {
    const r = await call('GET', '/v1/push/settings', undefined, tokA);
    const g = r.body.controlGroups[0];
    assert.deepEqual(g.source, { platform: 'wa', accountId: acc, chatId: ctrl });
    assert.deepEqual(g.targets.map((t: any) => t.title).sort(), ['יעד 1', 'יעד 2']);
  });
});

