import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionManager, type SafetySignal, type StatusEvent } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { normalizePhone } from '../src/wa/transport.js';
import type { InboundMessage } from '../src/core/types.js';
import { memoryStores, waitFor } from './helpers.js';

const PHONE = '972500000001';

function setup(timings = {}) {
  const net = new FakeWaNetwork({ qrIntervalMs: 30, maxQrCodes: 3, pairingTimeoutMs: 80, connectDelayMs: 1, ...timings });
  const { stores, factory } = memoryStores();
  const mgr = new ConnectionManager({
    transportFactory: fakeTransportFactory(net),
    storeFactory: factory,
    backoffMs: [10, 20],
    maxReconnectAttempts: 3,
  });
  const events: StatusEvent[] = [];
  const signals: SafetySignal[] = [];
  mgr.onStatus((e) => events.push(e));
  mgr.onSafetySignal((s) => signals.push(s));
  return { net, mgr, stores, events, signals };
}

describe('linking with QR', () => {
  test('QR scan links, restarts once, connects', async () => {
    const { net, mgr, events } = setup();
    await mgr.connect('t1', 'acc1', { method: 'qr' });
    await waitFor(() => !!mgr.getState('acc1')?.qr, 500, 'qr');
    net.scanQr(PHONE, mgr.getState('acc1')!.qr!);
    await waitFor(() => mgr.getState('acc1')?.status === 'connected', 500, 'connected');
    const s = mgr.getState('acc1')!;
    assert.equal(s.phoneNumber, PHONE);
    assert.ok(s.lastConnectedAt instanceof Date);
    assert.equal(s.qr, undefined, 'QR must be cleared once connected');
    assert.ok(events.some((e) => e.state.status === 'connecting'), 'went through restart');
    await mgr.shutdown();
  });

  test('QR rotates, then expires when nobody scans', async () => {
    const { mgr, events } = setup();
    await mgr.connect('t1', 'acc1', { method: 'qr' });
    await waitFor(() => mgr.getState('acc1')?.status === 'link_expired', 1000, 'expired');
    const qrs = new Set(events.filter((e) => e.state.qr).map((e) => e.state.qr));
    assert.equal(qrs.size, 3);
    await mgr.shutdown();
  });

  test('an expired QR cannot be scanned', async () => {
    const { net, mgr } = setup();
    await mgr.connect('t1', 'acc1', { method: 'qr' });
    await waitFor(() => !!mgr.getState('acc1')?.qr);
    const first = mgr.getState('acc1')!.qr!;
    await waitFor(() => mgr.getState('acc1')?.qr !== first, 500, 'rotation');
    assert.throws(() => net.scanQr(PHONE, first), /expired/);
    await mgr.shutdown();
  });
});

describe('linking with pairing code', () => {
  test('code entered on the right phone links', async () => {
    const { net, mgr } = setup();
    await mgr.connect('t1', 'acc1', { method: 'pairing_code', phoneNumber: '+972 50-000-0001' });
    await waitFor(() => !!mgr.getState('acc1')?.pairingCode);
    const code = mgr.getState('acc1')!.pairingCode!;
    assert.match(code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.throws(() => net.enterPairingCode('972500000099', code), /another number/);
    net.enterPairingCode(PHONE, code);
    await waitFor(() => mgr.getState('acc1')?.status === 'connected');
    await mgr.shutdown();
  });

  test('code expires', async () => {
    const { mgr } = setup();
    await mgr.connect('t1', 'acc1', { method: 'pairing_code', phoneNumber: PHONE });
    await waitFor(() => mgr.getState('acc1')?.status === 'link_expired', 500);
    await mgr.shutdown();
  });

  test('phone validation', () => {
    assert.equal(normalizePhone('+972-50-123-4567'), '972501234567');
    assert.throws(() => normalizePhone('0501234567'), /country code/);
    assert.throws(() => normalizePhone('12'), /8–15 digits/);
    assert.throws(() => normalizePhone('97250abc'), /digits/);
  });
});

async function linked() {
  const ctx = setup();
  await ctx.mgr.connect('t1', 'acc1', { method: 'qr' });
  await waitFor(() => !!ctx.mgr.getState('acc1')?.qr);
  ctx.net.scanQr(PHONE, ctx.mgr.getState('acc1')!.qr!);
  await waitFor(() => ctx.mgr.getState('acc1')?.status === 'connected');
  return ctx;
}

describe('after linking', () => {
  test('restart reconnects from stored session without a new QR', async () => {
    const { net, mgr, stores } = await linked();
    await mgr.shutdown();
    const mgr2 = new ConnectionManager({
      transportFactory: fakeTransportFactory(net),
      storeFactory: (_t, a) => stores.get(a)!,
    });
    await mgr2.connect('t1', 'acc1', { method: 'qr' });
    await waitFor(() => mgr2.getState('acc1')?.status === 'connected');
    assert.equal(mgr2.getState('acc1')!.qr, undefined);
    await mgr2.shutdown();
  });

  test('network drop reconnects with backoff', async () => {
    const { net, mgr, events } = await linked();
    net.dropConnections(PHONE);
    await waitFor(() => mgr.getState('acc1')?.status === 'reconnecting');
    await waitFor(() => mgr.getState('acc1')?.status === 'connected', 500, 'reconnected');
    assert.equal(mgr.getState('acc1')!.reconnectAttempts, 0);
    assert.ok(events.some((e) => e.state.lastDisconnect?.reason === 'connection_lost'));
    await mgr.shutdown();
  });

  test('ban stops the account, raises a safety signal and is not retried', async () => {
    const { net, mgr, signals } = await linked();
    net.ban(PHONE);
    await waitFor(() => mgr.getState('acc1')?.status === 'blocked');
    assert.deepEqual(signals.map((s) => s.kind), ['account_blocked']);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(mgr.getState('acc1')!.status, 'blocked', 'must not auto-retry a blocked number');
    assert.equal(net.liveDeviceCount(PHONE), 0);
    await mgr.shutdown();
  });

  test('a session taken over by another PUSH server (deploy) steps aside without stopping sending', async () => {
    const { mgr, stores, signals } = await linked();
    (mgr as any).entries.get('acc1').transport.emitPublic('close', { reason: 'replaced' });
    await waitFor(() => mgr.getState('acc1')?.status === 'stopped');
    assert.deepEqual(signals, [], 'no safety stop: only PUSH holds this session');
    assert.equal(await stores.get('acc1')!.hasCreds(), true, 'the session is kept for the other server');
    await mgr.shutdown();
  });

  test('device removed from phone wipes the session', async () => {
    const { net, mgr, stores, signals } = await linked();
    net.unlinkDevice(PHONE);
    await waitFor(() => mgr.getState('acc1')?.status === 'logged_out');
    assert.equal(await stores.get('acc1')!.hasCreds(), false);
    assert.equal(signals[0]?.kind, 'logged_out');
    await mgr.shutdown();
  });

  test('disconnect and delete removes credentials and the account', async () => {
    const { net, mgr, stores } = await linked();
    await mgr.disconnectAndDelete('acc1');
    assert.equal(await stores.get('acc1')!.hasCreds(), false);
    assert.equal(mgr.getState('acc1'), undefined);
    assert.equal(net.liveDeviceCount(PHONE), 0);
    await mgr.shutdown();
  });

  test('lists groups with send permission', async () => {
    const ctx = setup();
    const open = ctx.net.createGroup('חדשות ארצי', { members: [PHONE, '972500000002'] });
    const locked = ctx.net.createGroup('מבזקים', { members: [PHONE], adminsOnly: true });
    const mine = ctx.net.createGroup('הקבוצה שלי', { members: [PHONE], admins: [PHONE], adminsOnly: true });
    await ctx.mgr.connect('t1', 'acc1', { method: 'qr' });
    await waitFor(() => !!ctx.mgr.getState('acc1')?.qr);
    ctx.net.scanQr(PHONE, ctx.mgr.getState('acc1')!.qr!);
    await waitFor(() => ctx.mgr.getState('acc1')?.status === 'connected');
    const chats = await ctx.mgr.listChats('acc1');
    const byId = new Map(chats.map((c) => [c.ref.chatId, c]));
    assert.equal(byId.get(open)!.canSend, true);
    assert.equal(byId.get(locked)!.canSend, false);
    assert.equal(byId.get(mine)!.canSend, true);
    assert.equal(byId.get(open)!.participantCount, 2);
    await ctx.mgr.shutdown();
  });

  test('inbound messages carry tenant and source', async () => {
    const ctx = setup();
    const g = ctx.net.createGroup('מקור', { members: [PHONE, '972500000002'] });
    const got: InboundMessage[] = [];
    ctx.mgr.onMessage((m) => got.push(m));
    await ctx.mgr.connect('t1', 'acc1', { method: 'qr' });
    await waitFor(() => !!ctx.mgr.getState('acc1')?.qr);
    ctx.net.scanQr(PHONE, ctx.mgr.getState('acc1')!.qr!);
    await waitFor(() => ctx.mgr.getState('acc1')?.status === 'connected');
    ctx.net.humanPost('972500000002', g, { kind: 'text', text: 'מבזק' });
    await waitFor(() => got.length === 1);
    assert.equal(got[0]!.tenantId, 't1');
    assert.equal(got[0]!.source.chatId, g);
    assert.equal(got[0]!.fromSelf, false);
    await ctx.mgr.shutdown();
  });

  test('another tenant cannot take over an account id', async () => {
    const { mgr } = await linked();
    await assert.rejects(mgr.connect('t2', 'acc1', { method: 'qr' }), /another tenant/);
    await mgr.shutdown();
  });

  test('sender refuses when not connected', async () => {
    const { net, mgr } = await linked();
    net.ban(PHONE);
    await waitFor(() => mgr.getState('acc1')?.status === 'blocked');
    await assert.rejects(mgr.sender('acc1').send('x@g.us', { kind: 'text', text: 'hi' }), { kind: 'disconnected' });
    await mgr.shutdown();
  });
});
