/**
 * Tests the Baileys adapter's pure logic and its wiring against a stub of the
 * library. The real library is never loaded here.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BaileysTransport, baileysTransportFactory, extractContent, mapDisconnect, toBaileysPayload } from '../src/wa/baileysTransport.js';
import { MemoryAuthStore } from '../src/wa/authStore.js';
import { cipherFor, waitFor } from './helpers.js';

describe('Baileys adapter — pure mapping', () => {
  test('disconnect codes', () => {
    assert.equal(mapDisconnect(401), 'logged_out');
    assert.equal(mapDisconnect(403), 'account_blocked');
    assert.equal(mapDisconnect(440), 'replaced');
    assert.equal(mapDisconnect(515), 'restart_required');
    assert.equal(mapDisconnect(428), 'connection_lost');
    assert.equal(mapDisconnect(undefined), 'connection_lost');
  });

  test('extracts text, captions, media and forwarded flag', () => {
    assert.deepEqual(extractContent({ conversation: 'שלום' })?.content, { kind: 'text', text: 'שלום' });
    const ext = extractContent({ extendedTextMessage: { text: 'link', contextInfo: { isForwarded: true } } });
    assert.equal(ext?.isForwarded, true);
    const img = extractContent({ imageMessage: { caption: 'cap', mimetype: 'image/jpeg', fileLength: '1234' } });
    assert.equal(img?.content.kind, 'image');
    assert.equal(img?.content.text, 'cap');
    assert.equal(img?.content.media?.size, 1234);
    const eph = extractContent({ ephemeralMessage: { message: { conversation: 'x' } } });
    assert.equal(eph?.content.text, 'x');
    assert.equal(extractContent({ reactionMessage: {} }), null);
  });

  test('builds send payloads and rejects invalid content', () => {
    assert.deepEqual(toBaileysPayload({ kind: 'text', text: 'hi' }), { text: 'hi' });
    const p = toBaileysPayload({ kind: 'image', text: 'c', media: { mimeType: 'image/png', data: Buffer.from('x') } });
    assert.ok(Buffer.isBuffer(p.image));
    assert.equal(p.caption, 'c');
    assert.throws(() => toBaileysPayload({ kind: 'text', text: '  ' }), /empty/);
    assert.throws(() => toBaileysPayload({ kind: 'video' }), /media missing/);
  });
});

describe('Baileys adapter — guard', () => {
  test('refuses to build a real client without approval', () => {
    const f = baileysTransportFactory({ allowReal: false });
    assert.throws(() => f('acc', new MemoryAuthStore('acc', cipherFor('t'))), /disabled/);
  });
});

/** Minimal stand-in for the Baileys module surface the adapter uses. */
function stubBaileys() {
  const sockets: any[] = [];
  const mod = {
    initAuthCreds: () => ({ registered: false, me: undefined }),
    makeWASocket: (cfg: any) => {
      const ev = new EventEmitter();
      const sock: any = {
        cfg,
        ev,
        authState: { creds: cfg.auth.creds },
        user: { id: '972500000001:7@s.whatsapp.net', lid: '88001122334455:7@lid' },
        sent: [] as any[],
        requestPairingCode: async () => 'ABCD1234',
        groupFetchAllParticipating: async () => ({
          'g1@g.us': { id: 'g1@g.us', subject: 'Open', announce: false, participants: [{ id: '972500000001@s.whatsapp.net', admin: null }] },
          'g2@g.us': { id: 'g2@g.us', subject: 'Locked', announce: true, participants: [{ id: '972500000001@s.whatsapp.net', admin: null }] },
          'g3@g.us': { id: 'g3@g.us', subject: 'Mine', announce: true, participants: [{ id: '972500000001@s.whatsapp.net', admin: 'admin' }] },
          // Most groups now list members by LID; this number is admin in one and not in the other.
          'g4@g.us': { id: 'g4@g.us', subject: 'LidAdmin', announce: true, addressingMode: 'lid', participants: [{ id: '88001122334455@lid', phoneNumber: '972500000001@s.whatsapp.net', admin: 'superadmin' }] },
          'g5@g.us': { id: 'g5@g.us', subject: 'LidMember', announce: true, addressingMode: 'lid', participants: [{ id: '88001122334455@lid', admin: null }, { id: '1@lid', admin: 'admin' }] },
          'g6@g.us': { id: 'g6@g.us', subject: 'LidOnlyAdmin', announce: true, addressingMode: 'lid', participants: [{ id: '88001122334455@lid', admin: 'admin' }] },
        }),
        sendMessage: async (jid: string, payload: any) => {
          if (jid === 'limited@g.us') throw new Error('rate-overlimit');
          sock.sent.push({ jid, payload });
          return { key: { id: 'MSG1' }, message: { conversation: payload.text ?? '' } };
        },
        end: () => {},
        logout: async () => {},
      };
      sockets.push(sock);
      return sock;
    },
  };
  return { mod, sockets };
}

describe('Baileys adapter — wiring against a stub', () => {
  test('QR, open, groups, inbound, send, creds saved', async () => {
    const { mod, sockets } = stubBaileys();
    const store = new MemoryAuthStore('acc', cipherFor('t'));
    const t = new BaileysTransport('acc', store, async () => mod);
    const seen: Record<string, unknown[]> = { qr: [], open: [], message: [], close: [] };
    for (const k of Object.keys(seen)) t.on(k as any, (x: unknown) => seen[k]!.push(x));

    await t.start({ method: 'qr' });
    const sock = sockets[0];
    assert.equal(sock.cfg.printQRInTerminal, false);
    assert.equal(sock.cfg.browser[0], 'Ubuntu');

    sock.ev.emit('connection.update', { qr: 'QRDATA' });
    assert.deepEqual(seen.qr, ['QRDATA']);

    sock.authState.creds.registered = true;
    sock.ev.emit('creds.update', {});
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await store.hasCreds(), true);

    sock.ev.emit('connection.update', { connection: 'open' });
    assert.deepEqual(seen.open, [{ phoneNumber: '972500000001' }]);

    const chats = await t.listChats();
    const can = Object.fromEntries(chats.map((c) => [c.title, c.canSend]));
    assert.deepEqual(can, { Open: true, Locked: false, Mine: true, LidAdmin: true, LidMember: false, LidOnlyAdmin: true });

    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { remoteJid: 'g1@g.us', id: 'IN1', participant: '555@lid', participantAlt: 'x@s.whatsapp.net', fromMe: false }, message: { conversation: 'news' }, messageTimestamp: 1700000000 },
        { key: { remoteJid: 'status@broadcast', id: 'S' }, message: { conversation: 'ignored' } },
      ],
    });
    assert.equal(seen.message!.length, 1);
    assert.equal((seen.message![0] as any).senderId, 'x@s.whatsapp.net', 'the phone-number id is preferred over the LID');

    const r = await t.send('g1@g.us', { kind: 'text', text: 'hi' });
    assert.equal(r.messageId, 'MSG1');
    await assert.rejects(t.send('limited@g.us', { kind: 'text', text: 'hi' }), { kind: 'rate_limited' });

    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 403 } } } });
    assert.deepEqual((seen.close![0] as any).reason, 'account_blocked');
  });

  test('pairing code is requested instead of showing QR', async () => {
    const { mod, sockets } = stubBaileys();
    const t = new BaileysTransport('acc', new MemoryAuthStore('acc', cipherFor('t')), async () => mod);
    const codes: string[] = [];
    const qrs: string[] = [];
    t.on('pairing_code', (c) => codes.push(c));
    t.on('qr', (q) => qrs.push(q));
    await t.start({ method: 'pairing_code', phoneNumber: '972500000001' });
    sockets[0].ev.emit('connection.update', { qr: 'IGNORED' });
    await waitFor(() => codes.length === 1);
    assert.deepEqual(codes, ['ABCD-1234']);
    assert.deepEqual(qrs, []);
  });

  test('messages that arrive while the server was restarting are still distributed, once', async () => {
    const { mod, sockets } = stubBaileys();
    const t = new BaileysTransport('acc', new MemoryAuthStore('acc', cipherFor('t')), async () => mod);
    const got: any[] = [];
    t.on('message', (m) => got.push(m));
    await t.start({ method: 'qr' });
    const sock = sockets[0];
    const now = Math.floor(Date.now() / 1000);
    const msg = (id: string, ts: number, extra: any = {}) => ({ key: { remoteJid: 'g1@g.us', id, participant: 'p@s.whatsapp.net' }, message: { conversation: id }, messageTimestamp: ts, ...extra });
    sock.ev.emit('messages.upsert', { type: 'append', messages: [msg('OFF1', now - 120), msg('OLD', now - 3 * 3600)] });
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [msg('OFF1', now - 120), msg('LIVE', now)] });
    // Not decrypted yet: nothing is distributed until WhatsApp delivers it again.
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: 'g1@g.us', id: 'CT' }, messageStubType: 2, messageTimestamp: now }] });
    assert.deepEqual(got.map((m) => m.messageId), ['OFF1', 'LIVE'], 'recent offline message once, old history skipped');
  });

  test('wrapped messages (captioned document, view once, sent from own phone) are read', () => {
    assert.equal(extractContent({ documentWithCaptionMessage: { message: { documentMessage: { caption: 'דוח', mimetype: 'application/pdf' } } } })?.content.text, 'דוח');
    assert.equal(extractContent({ viewOnceMessageV2Extension: { message: { imageMessage: { caption: 'v' } } } })?.content.kind, 'image');
    assert.equal(extractContent({ deviceSentMessage: { message: { extendedTextMessage: { text: 'from phone' } } } })?.content.text, 'from phone');
  });

  test('a message we sent can be handed back when a member\'s phone asks for it again', async () => {
    const { mod, sockets } = stubBaileys();
    const t = new BaileysTransport('acc', new MemoryAuthStore('acc', cipherFor('t')), async () => mod);
    await t.start({ method: 'qr' });
    const sock = sockets[0];
    sock.ev.emit('connection.update', { connection: 'open' });
    await t.send('g1@g.us', { kind: 'text', text: 'שלום' });
    assert.deepEqual(await sock.cfg.getMessage({ id: 'MSG1' }), { conversation: 'שלום' });
    await t.listChats();
    assert.equal((await sock.cfg.cachedGroupMetadata('g1@g.us'))?.subject, 'Open', 'group details are cached for sending');
  });
});
