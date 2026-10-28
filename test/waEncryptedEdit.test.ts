/**
 * Newer WhatsApp phones send an edit encrypted (secretEncryptedMessage, MESSAGE_EDIT) instead of
 * a plain protocol message, and Baileys does not open it. We open it with the original message's
 * messageSecret. The vector below was made independently in Go (standard library HKDF and
 * AES-GCM, nil salt), following whatsmeow's generateMsgSecretKey for "Message Edit".
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { proto } from 'baileys';
import { BaileysTransport, decryptMessageEdit, editedContentOf, extractContent } from '../src/wa/baileysTransport.js';
import { MemoryAuthStore } from '../src/wa/authStore.js';
import { cipherFor } from './helpers.js';

const SECRET = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const ORIG_ID = '3EB0ABCDEF0123456789';
const IV = Buffer.from('0a0b0c0d0e0f101112131415', 'hex');
const PAYLOAD = Buffer.from('8baa6f2066ef5aa138485eb0957a00a138f0bd1b257d2c5eb5932789990bcb706f4d32595dcbcfb5afc208', 'hex');
const LID = '111222333444555@lid';

describe('encrypted WhatsApp edits', () => {
  test('opens the Go vector, trying the phone-number id first and the LID after', () => {
    const plain = decryptMessageEdit({ encPayload: PAYLOAD, encIv: IV }, SECRET, ORIG_ID,
      ['972500000001:7@s.whatsapp.net', '111222333444555:7@lid'], ['972500000001@s.whatsapp.net', LID]);
    assert.ok(plain, 'decrypted');
    const content = extractContent(editedContentOf(proto.Message.decode(plain)));
    assert.deepEqual(content?.content, { kind: 'text', text: 'שלום מתוקן' });
  });

  test('a wrong secret or a wrong message id does not open', () => {
    assert.equal(decryptMessageEdit({ encPayload: PAYLOAD, encIv: IV }, Buffer.alloc(32, 7), ORIG_ID, [LID], [LID]), null);
    assert.equal(decryptMessageEdit({ encPayload: PAYLOAD, encIv: IV }, SECRET, 'OTHER', [LID], [LID]), null);
  });

  test('the transport turns an encrypted edit of a control-group message into a normal edit', async () => {
    const sockets: any[] = [];
    const mod = {
      proto,
      initAuthCreds: () => ({ registered: false, me: undefined }),
      makeWASocket: (cfg: any) => {
        const sock: any = { cfg, ev: new EventEmitter(), authState: { creds: cfg.auth.creds }, user: { id: '972500000001:7@s.whatsapp.net', lid: '111222333444555:7@lid' }, end: () => {} };
        sockets.push(sock);
        return sock;
      },
    };
    const t = new BaileysTransport('acc', new MemoryAuthStore('acc', cipherFor('t')), async () => mod);
    const edits: any[] = [];
    const messages: any[] = [];
    t.on('message_edited', (e) => edits.push(e));
    t.on('message', (m) => messages.push(m));
    await t.start({ method: 'qr' });
    const sock = sockets[0];
    const now = Math.floor(Date.now() / 1000);
    // The original, sent from the customer's own phone: it carries the secret.
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [{
      key: { remoteJid: 'ctrl@g.us', id: ORIG_ID, fromMe: true, participant: LID },
      message: { conversation: 'שלום', messageContextInfo: { messageSecret: SECRET } }, messageTimestamp: now }] });
    // The edit, encrypted.
    const editMsg = { key: { remoteJid: 'ctrl@g.us', id: 'EDIT1', fromMe: true, participant: LID },
      message: { secretEncryptedMessage: { targetMessageKey: { remoteJid: 'ctrl@g.us', id: ORIG_ID, fromMe: true }, encPayload: PAYLOAD, encIv: IV, secretEncType: 2 } },
      messageTimestamp: now };
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [editMsg] });
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [editMsg] }); // repeated by WhatsApp: once only
    assert.equal(messages.length, 1, 'the edit is not distributed as a new message');
    assert.equal(edits.length, 1);
    assert.equal(edits[0].messageId, ORIG_ID);
    assert.equal(edits[0].chatId, 'ctrl@g.us');
    assert.equal(edits[0].fromSelf, true);
    assert.deepEqual(edits[0].content, { kind: 'text', text: 'שלום מתוקן' });

    // An edit of a message this server never saw (e.g. sent before a restart) is skipped quietly.
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ ...editMsg, key: { ...editMsg.key, id: 'EDIT2' },
      message: { secretEncryptedMessage: { ...editMsg.message.secretEncryptedMessage, targetMessageKey: { remoteJid: 'ctrl@g.us', id: 'UNKNOWN', fromMe: true } } } }] });
    assert.equal(edits.length, 1);
  });
});
