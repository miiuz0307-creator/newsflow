/**
 * Real WhatsApp linked-device client, built on Baileys (unofficial).
 *
 * STATUS: written against the Baileys public API. The edit / revoke handling
 * was checked against the source of baileys 7.0.0-rc14 (October 2026), but
 * nothing here has run against a real number yet. It loads Baileys with a
 * dynamic import, so the rest of the project builds and tests without it.
 * Before first use:
 *   1. npm install baileys@7.0.0-rc14 --save-exact (verify the package name and
 *      integrity — a malicious Baileys fork once stole credentials)
 *   2. run the feasibility script manually with a TEST number, with the owner's
 *      approval and ALLOW_REAL_WHATSAPP=1.
 *
 * Using this client is against WhatsApp's terms. It identifies itself
 * honestly, does not spoof devices and does not retry after a ban.
 */
import { createDecipheriv, hkdfSync } from 'node:crypto';
import type { ChatInfo, MessageContent, MessageKind, SendResult } from '../core/types.js';
import { SendError } from '../core/types.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { AuthStore } from './authStore.js';
import { BufferJSON } from './authStore.js';
import type { DisconnectReason, RawEdit, RawInbound, RawReceipt, RawRevoke, StartOptions, TransportEvents, TransportFactory, WaTransport } from './transport.js';
import { normalizePhone } from './transport.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Baileys = any;

const BAILEYS_MODULE = 'baileys';

/** Maps Baileys/WhatsApp close status codes to our reasons. */
export function mapDisconnect(statusCode: number | undefined): DisconnectReason {
  switch (statusCode) {
    case 401: return 'logged_out'; // DisconnectReason.loggedOut
    case 403: return 'account_blocked'; // forbidden — number restricted
    case 440: return 'replaced'; // connectionReplaced
    case 500: return 'bad_session'; // badSession
    case 411: return 'bad_session'; // multideviceMismatch
    case 515: return 'restart_required'; // restartRequired
    case 408: // connectionLost / timedOut
    case 428: // connectionClosed
    case 503: // unavailableService
    default:
      return 'connection_lost';
  }
}

/** Extracts our content shape from a Baileys WAMessage. Media bytes are fetched lazily by the caller. */
export function extractContent(message: any): { content: MessageContent; isForwarded: boolean } | null {
  if (!message) return null;
  // Disappearing, view-once, captioned-document and similar wrappers hold the real message inside.
  // Edits are not unwrapped here: they arrive separately (see parseMessageUpdate).
  let m = message;
  for (let i = 0; i < 5; i++) {
    const inner = m.ephemeralMessage ?? m.viewOnceMessage ?? m.viewOnceMessageV2 ?? m.viewOnceMessageV2Extension
      ?? m.documentWithCaptionMessage ?? m.deviceSentMessage ?? m.associatedChildMessage;
    if (!inner?.message) break;
    m = inner.message;
  }
  const pick = (kind: MessageKind, node: any): { content: MessageContent; isForwarded: boolean } => ({
    content: {
      kind,
      ...(node.caption || node.text ? { text: node.caption ?? node.text } : {}),
      ...(kind !== 'text'
        ? { media: { mimeType: node.mimetype ?? 'application/octet-stream', size: Number(node.fileLength ?? 0) || undefined, fileName: node.fileName } }
        : {}),
    },
    isForwarded: !!node.contextInfo?.isForwarded,
  });
  if (typeof m.conversation === 'string') return { content: { kind: 'text', text: m.conversation }, isForwarded: false };
  if (m.extendedTextMessage) return pick('text', m.extendedTextMessage);
  if (m.imageMessage) return pick('image', m.imageMessage);
  if (m.videoMessage) return pick('video', m.videoMessage);
  if (m.audioMessage) return pick('audio', m.audioMessage);
  if (m.documentMessage) return pick('document', m.documentMessage);
  if (m.stickerMessage) return pick('sticker', m.stickerMessage);
  return null; // reactions, protocol messages, polls etc. are ignored in phase 1
}

/** The user part of a WhatsApp id: "9725…:7@s.whatsapp.net" → "9725…", "1234@lid" → "1234". */
export function idUser(id: unknown): string {
  return typeof id === 'string' ? id.split('@')[0]!.split(':')[0]! : '';
}

/** A group message's sender, preferring the phone-number id over the private LID when WhatsApp gives both. */
export function senderOf(key: any): string | undefined {
  const ids = [key?.participant, key?.participantAlt, key?.participantPn].filter((x): x is string => typeof x === 'string' && !!x);
  return ids.find((x) => x.endsWith('@s.whatsapp.net')) ?? ids[0];
}

/** WAMessageStubType.REVOKE in Baileys. */
const STUB_REVOKE = 1;
/** WAMessageStubType.CIPHERTEXT: a message that could not be decrypted (yet). */
const STUB_CIPHERTEXT = 2;
/** Messages received while offline are distributed if they are at most this old. */
const OFFLINE_CATCHUP_MS = 15 * 60_000;
/** Message types that are routine and not worth a log line when we skip them. */
const QUIET_TYPES = new Set(['messageContextInfo', 'senderKeyDistributionMessage', 'reactionMessage', 'pollUpdateMessage', 'keepInChatMessage', 'pinInChatMessage']);

/** "1234:7@s.whatsapp.net" → "1234@s.whatsapp.net" (the id without the device part). */
function withoutDevice(jid: string): string {
  const [user = '', server = ''] = jid.split('@');
  return `${user.split(':')[0]}@${server}`;
}

/**
 * Opens an edit that WhatsApp sent encrypted (secretEncryptedMessage, type MESSAGE_EDIT).
 * Newer WhatsApp phones send edits this way; Baileys does not open them. The key comes from
 * the original message's messageSecret (as in whatsmeow, msgsecret.go):
 *   key = HKDF-SHA256(secret, no salt, origId + origSender + editSender + "Message Edit", 32)
 *   payload = AES-256-GCM(key, encIv), no additional data.
 * WhatsApp is moving ids from phone numbers to LIDs, so every likely sender id is tried.
 * Returns the decrypted protobuf bytes, or null when no combination opens it.
 */
export function decryptMessageEdit(enc: { encPayload: Uint8Array; encIv: Uint8Array }, secret: Uint8Array, origId: string,
  origSenders: (string | undefined)[], editSenders: (string | undefined)[]): Buffer | null {
  const ids = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x && x.includes('@')).map(withoutDevice))];
  const payload = Buffer.from(enc.encPayload);
  if (payload.length < 17 || !enc.encIv?.length) return null;
  const body = payload.subarray(0, -16);
  const tag = payload.subarray(-16);
  for (const o of ids(origSenders)) {
    for (const m of ids(editSenders)) {
      const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from(origId + o + m + 'Message Edit'), 32));
      try {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.encIv));
        d.setAuthTag(tag);
        return Buffer.concat([d.update(body), d.final()]);
      } catch { /* wrong id pair: try the next */ }
    }
  }
  return null;
}

/** The edited content inside a decrypted edit, whichever wrapper WhatsApp used. */
export function editedContentOf(decoded: any): any {
  return decoded?.protocolMessage?.editedMessage
    ?? decoded?.editedMessage?.message?.protocolMessage?.editedMessage
    ?? decoded?.editedMessage?.message
    ?? decoded;
}

/**
 * Reads one entry of Baileys' 'messages.update' event (checked against
 * Baileys 7.0.0-rc14, Utils/process-message.js):
 *  - an edit arrives as update.message.editedMessage.message
 *  - a "delete for everyone" arrives as update.message === null with
 *    messageStubType REVOKE; update.key is the deleter's protocol message
 * "Delete for me" is an app-state change ('messages.delete'), never this event.
 * Everything else in 'messages.update' (receipts, reactions, polls) returns null.
 */
export function parseMessageUpdate(u: any, now = Date.now()): { edit?: RawEdit; revoke?: RawRevoke } | null {
  const key = u?.key;
  const jid: string | undefined = key?.remoteJid;
  if (!jid || jid === 'status@broadcast' || !key.id) return null;
  const update = u.update ?? {};
  const edited = update.message?.editedMessage?.message;
  if (edited) {
    const parsed = extractContent(edited);
    if (!parsed) return null;
    const ts = Number(update.messageTimestamp ?? 0);
    return {
      edit: {
        chatId: jid,
        messageId: key.id,
        senderId: senderOf(key) ?? jid,
        fromSelf: !!key.fromMe,
        timestamp: new Date(ts ? ts * 1000 : now),
        content: parsed.content,
      },
    };
  }
  if ('message' in update && update.message === null && update.messageStubType === STUB_REVOKE) {
    return {
      revoke: {
        chatId: jid,
        messageId: key.id,
        senderId: senderOf(update.key) ?? senderOf(key) ?? jid,
        fromSelf: !!(update.key?.fromMe ?? key.fromMe),
        timestamp: new Date(now),
      },
    };
  }
  return null;
}

/**
 * Reads one entry of Baileys' 'message-receipt.update' (group messages this
 * number sent): { key, receipt: { userJid, readTimestamp, receiptTimestamp } }.
 * Only reads count; delivery receipts are ignored. NOT yet run on a real number.
 */
export function parseReceipt(u: any): RawReceipt | null {
  const key = u?.key;
  const r = u?.receipt;
  if (!key?.remoteJid || !key.id || !key.fromMe || !r?.userJid || !r.readTimestamp) return null;
  return { chatId: key.remoteJid, messageId: key.id, readerId: String(r.userJid), timestamp: new Date(Number(r.readTimestamp) * 1000) };
}

/** Maps a Baileys send/edit/delete error onto our error kinds. */
export function mapSendError(err: any): SendError {
  const status = err?.output?.statusCode ?? err?.data?.statusCode;
  const msg = String(err?.message ?? err);
  if (/rate-overlimit/i.test(msg) || status === 429) return new SendError('rate_limited', msg);
  if (status === 403 || /not-authorized|forbidden/i.test(msg)) return new SendError('forbidden', msg);
  if (status === 404 || /item-not-found/i.test(msg)) return new SendError('not_found', msg);
  if (status === 401) return new SendError('account_blocked', msg);
  // No answer in time: WhatsApp may have taken the message. Not resent automatically.
  if (status === 408 || /timed out/i.test(msg)) return new SendError('unknown', msg);
  return new SendError('transient', msg);
}

/** Builds the Baileys sendMessage payload for our content. */
export function toBaileysPayload(content: MessageContent): Record<string, unknown> {
  const media = content.media;
  const source = media?.data ?? (media?.url ? { url: media.url } : undefined);
  switch (content.kind) {
    case 'text':
      if (!content.text?.trim()) throw new SendError('invalid', 'empty text');
      return { text: content.text };
    case 'image':
    case 'video':
    case 'sticker':
      if (!source) throw new SendError('invalid', 'media missing');
      return { [content.kind]: source, ...(content.text ? { caption: content.text } : {}), mimetype: media!.mimeType };
    case 'audio':
      if (!source) throw new SendError('invalid', 'media missing');
      return { audio: source, mimetype: media!.mimeType };
    case 'document':
      if (!source) throw new SendError('invalid', 'media missing');
      return { document: source, mimetype: media!.mimeType, fileName: media!.fileName ?? 'file', ...(content.text ? { caption: content.text } : {}) };
    default:
      throw new SendError('invalid', `unsupported kind ${content.kind}`);
  }
}

export class BaileysTransport implements WaTransport {
  private sock: any = null;
  /** Recently sent messages by id, for re-sends WhatsApp asks for (bounded). */
  private sentCache = new Map<string, unknown>();
  /** Group metadata by group id, filled by listChats and cleared on group changes. */
  private groupCache = new Map<string, any>();
  /** Message ids already handed on, so a message delivered twice (online, then offline catch-up) is processed once. */
  private seen = new Set<string>();
  /** The original keys of recent inbound group messages, so PUSH can react to them (bounded). */
  private inboundKeys = new Map<string, any>();
  /** messageSecret of recent group messages: needed to open edits sent encrypted. */
  private secrets = new Map<string, { secret: Uint8Array; senders: string[] }>();
  private listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  private connected = false;
  private pairingRequested = false;
  private stopped = false;
  private pairingTimer?: NodeJS.Timeout;
  /** How long a pairing code is shown before a new attempt starts. */
  pairingCodeTtlMs = 90_000;

  constructor(
    public readonly accountId: string,
    private readonly store: AuthStore,
    private readonly loadBaileys: () => Promise<Baileys>,
    private readonly log: Logger = silentLogger,
  ) {}

  on<E extends keyof TransportEvents>(event: E, fn: TransportEvents[E]) {
    let s = this.listeners.get(event);
    if (!s) this.listeners.set(event, (s = new Set()));
    s.add(fn as (...a: unknown[]) => void);
  }
  off<E extends keyof TransportEvents>(event: E, fn: TransportEvents[E]) {
    this.listeners.get(event)?.delete(fn as (...a: unknown[]) => void);
  }
  private emit(event: keyof TransportEvents, ...args: unknown[]) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
  }

  async start(opts: StartOptions): Promise<void> {
    const B = await this.loadBaileys();
    const makeWASocket = B.default ?? B.makeWASocket;
    const phone = opts.method === 'pairing_code' ? normalizePhone(opts.phoneNumber ?? '') : undefined;

    const storedCreds = await this.store.readCreds();
    // Round-trip through Baileys' own BufferJSON so its internal Buffer shapes are exact.
    const creds = storedCreds ? JSON.parse(JSON.stringify(storedCreds, BufferJSON.replacer), B.BufferJSON?.reviver ?? BufferJSON.reviver) : B.initAuthCreds();

    const keys = {
      get: async (type: string, ids: string[]) => {
        const found = await this.store.getKeys(type, ids);
        if (type === 'app-state-sync-key' && B.proto?.Message?.AppStateSyncKeyData) {
          for (const id of Object.keys(found)) found[id] = B.proto.Message.AppStateSyncKeyData.fromObject(found[id]);
        }
        return found;
      },
      set: async (data: Record<string, Record<string, unknown | null>>) => this.store.setKeys(data),
    };

    // The WhatsApp Web version bundled with a Baileys release goes stale; WhatsApp then refuses
    // the connection. Ask for the current one, and fall back to the bundled one if that fails.
    let version: number[] | undefined;
    try {
      const latest = B.fetchLatestWaWebVersion ? await B.fetchLatestWaWebVersion({}) : B.fetchLatestBaileysVersion ? await B.fetchLatestBaileysVersion() : undefined;
      if (Array.isArray(latest?.version)) version = latest.version;
    } catch (err) {
      this.log.warn('could not fetch the current WhatsApp Web version; using the bundled one', { err: String(err) });
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      // When a group member's phone can't decrypt one of our messages it asks for it again;
      // Baileys answers from its own recent cache, and from ours as a fallback.
      getMessage: async (key: any) => this.sentCache.get(key?.id ?? ''),
      // Group member lists are needed on every send; caching them avoids a lookup per message.
      cachedGroupMetadata: async (jid: string) => this.groupCache.get(jid),
      auth: { creds, keys: B.makeCacheableSignalKeyStore ? B.makeCacheableSignalKeyStore(keys) : keys },
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // A standard browser identity: WhatsApp rejects pairing codes from clients whose
      // platform it doesn't recognise. Nothing here imitates a phone or a specific device.
      browser: B.Browsers?.ubuntu ? B.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4'],
    });
    this.sock = sock;

    sock.ev.on('creds.update', async () => {
      await this.store.writeCreds(sock.authState.creds);
    });

    sock.ev.on('connection.update', async (u: any) => {
      if (u.qr) {
        if (phone && !this.pairingRequested && !sock.authState.creds.registered) {
          this.pairingRequested = true;
          try {
            const code: string = await sock.requestPairingCode(phone);
            this.emit('pairing_code', code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);
            // A code is valid for a short time. If it isn't used, end this attempt so the
            // manager reports link_expired and a fresh attempt (with a new code) can start.
            this.pairingTimer = setTimeout(() => {
              if (!sock.authState.creds.registered && !this.connected) {
                this.stopped = true;
                try { sock.end(undefined); } catch { /* already closed */ }
                this.emit('close', { reason: 'link_timeout', detail: 'pairing code not used in time' });
              }
            }, this.pairingCodeTtlMs);
            this.pairingTimer.unref?.();
          } catch (err) {
            this.log.error('pairing code request failed', { accountId: this.accountId, err: String(err) });
            this.emit('close', { reason: 'link_timeout', detail: 'pairing request failed' });
          }
        } else if (!phone) {
          this.emit('qr', u.qr);
        }
      }
      if (u.connection === 'open') {
        this.connected = true;
        if (this.pairingTimer) clearTimeout(this.pairingTimer);
        const me: string = sock.user?.id ?? '';
        this.emit('open', { phoneNumber: me.split(':')[0]?.split('@')[0] ?? '' });
      }
      if (u.connection === 'close') {
        this.connected = false;
        const status = u.lastDisconnect?.error?.output?.statusCode as number | undefined;
        const reason = this.stopped ? 'stopped' : mapDisconnect(status);
        this.emit('close', { reason, detail: status ? `status ${status}` : undefined });
      }
    });

    sock.ev.on('messages.upsert', (ev: any) => {
      // 'notify' = arrived live. 'append' = arrived while this server was offline (a restart or
      // update) or was synced from history: only recent ones are taken, so a restart never
      // loses a message but old history is not distributed again.
      if (ev.type !== 'notify' && ev.type !== 'append') return;
      for (const msg of ev.messages ?? []) {
        const jid: string | undefined = msg.key?.remoteJid;
        if (!jid || jid === 'status@broadcast' || !msg.key?.id) continue;
        const ts = Number(msg.messageTimestamp ?? 0) * 1000;
        if (ev.type === 'append' && (!ts || Date.now() - ts > OFFLINE_CATCHUP_MS)) continue;
        const secret = msg.message?.messageContextInfo?.messageSecret;
        if (secret?.length && jid.endsWith('@g.us')) {
          this.secrets.set(`${jid}|${msg.key.id}`, { secret, senders: [msg.key.participant, msg.key.participantAlt, msg.key.participantPn].filter(Boolean) });
          if (this.secrets.size > 5000) this.secrets.delete(this.secrets.keys().next().value as string);
        }
        const enc = msg.message?.secretEncryptedMessage;
        if (enc && jid.endsWith('@g.us')) {
          this.openEncryptedEdit(B, jid, msg, enc);
          continue;
        }
        const parsed = extractContent(msg.message);
        if (!parsed) {
          // A message WhatsApp couldn't decrypt yet comes back once the sender's phone re-sends it.
          if (msg.messageStubType === STUB_CIPHERTEXT && jid.endsWith('@g.us')) this.log.info('inbound not decrypted yet', { accountId: this.accountId, chatId: jid, id: msg.key.id });
          else if (jid.endsWith('@g.us')) {
            // Only the shape (no content): shows edits or other changes that arrive in a form we do not read yet.
            const types = Object.keys(msg.message ?? {}).filter((k) => !QUIET_TYPES.has(k));
            if (types.length) this.log.info('inbound not read', { accountId: this.accountId, chatId: jid, id: msg.key.id, fromSelf: !!msg.key.fromMe, types: types.join(','),
              protocolType: msg.message?.protocolMessage?.type ?? null });
          }
          continue;
        }
        const seenKey = `${jid}|${msg.key.id}`;
        this.inboundKeys.set(seenKey, { remoteJid: jid, id: msg.key.id, fromMe: !!msg.key.fromMe, ...(msg.key.participant ? { participant: msg.key.participant } : {}) });
        if (this.inboundKeys.size > 3000) this.inboundKeys.delete(this.inboundKeys.keys().next().value as string);
        if (this.seen.has(seenKey)) continue;
        this.seen.add(seenKey);
        if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
        if (jid.endsWith('@g.us')) this.log.info('inbound', { accountId: this.accountId, chatId: jid, id: msg.key.id, kind: parsed.content.kind, fromSelf: !!msg.key.fromMe, offline: ev.type === 'append' });
        const raw: RawInbound = {
          chatId: jid,
          messageId: msg.key.id,
          senderId: senderOf(msg.key) ?? jid,
          fromSelf: !!msg.key.fromMe,
          isForwarded: parsed.isForwarded,
          timestamp: new Date(Number(msg.messageTimestamp ?? Date.now() / 1000) * 1000),
          content: parsed.content,
        };
        if (raw.content.media && B.downloadMediaMessage) {
          // Media is fetched on demand so text routing isn't delayed by downloads.
          (raw.content.media as { load?: () => Promise<Buffer> }).load = () => B.downloadMediaMessage(msg, 'buffer', {});
        }
        this.emit('message', raw);
      }
    });

    sock.ev.on('messages.update', (updates: any[]) => {
      for (const u of updates ?? []) {
        const parsed = parseMessageUpdate(u);
        if (parsed?.edit) this.log.info('edit received', { accountId: this.accountId, chatId: parsed.edit.chatId, id: parsed.edit.messageId, fromSelf: parsed.edit.fromSelf, kind: parsed.edit.content.kind });
        else if (u?.update?.message?.editedMessage) this.log.warn('edit not read', { accountId: this.accountId, chatId: u?.key?.remoteJid, id: u?.key?.id, types: Object.keys(u.update.message.editedMessage.message ?? {}).join(',') });
        if (parsed?.edit) this.emit('message_edited', parsed.edit);
        // WhatsApp answered one of our own messages with an error (e.g. 479): it may not have arrived.
        if (u?.key?.fromMe && u?.update?.status === 0 && Array.isArray(u.update.messageStubParameters)) {
          this.log.warn('send rejected by WhatsApp', { accountId: this.accountId, chatId: u.key.remoteJid, id: u.key.id, code: String(u.update.messageStubParameters[0] ?? '') });
        }
        if (parsed?.revoke) this.emit('message_revoked', parsed.revoke);
      }
    });

    sock.ev.on('message-receipt.update', (updates: any[]) => {
      for (const u of updates ?? []) {
        const r = parseReceipt(u);
        if (r) this.emit('receipt', r);
      }
    });

    const changed = (ev?: any) => {
      for (const g of Array.isArray(ev) ? ev : []) if (g?.id) this.groupCache.delete(g.id);
      if (ev?.id) this.groupCache.delete(ev.id);
      this.emit('chats_changed');
    };
    sock.ev.on('groups.update', changed);
    sock.ev.on('group-participants.update', changed);
    sock.ev.on('groups.upsert', changed);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.connected = false;
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* already closed */
    }
    this.sock = null;
  }

  async logout(): Promise<void> {
    this.stopped = true;
    try {
      if (this.connected) await this.sock?.logout?.();
    } finally {
      await this.store.wipe();
      await this.stop();
      this.emit('close', { reason: 'logged_out', detail: 'logout requested' });
    }
  }

  async listChats(): Promise<ChatInfo[]> {
    if (!this.connected || !this.sock) throw new SendError('disconnected', 'not connected');
    const groups: Record<string, any> = await this.sock.groupFetchAllParticipating();
    for (const g of Object.values(groups)) if (g?.id) this.groupCache.set(g.id, g);
    this.log.info('groups listed', { accountId: this.accountId, count: Object.keys(groups).length });
    // WhatsApp lists group members by phone number in some groups and by a private
    // "LID" in others (most groups now). Recognise this number by either one.
    const mine = new Set([this.sock.user?.id, this.sock.user?.lid, this.sock.authState?.creds?.me?.id, this.sock.authState?.creds?.me?.lid]
      .map(idUser).filter(Boolean));
    return Object.values(groups).map((g: any) => {
      const me = (g.participants ?? []).find((p: any) => [p.id, p.lid, p.phoneNumber, p.jid].some((x) => mine.has(idUser(x))));
      const isAdmin = !!me && (me.admin === 'admin' || me.admin === 'superadmin' || me.isAdmin === true || me.isSuperAdmin === true);
      return {
        ref: { platform: 'wa', accountId: this.accountId, chatId: g.id },
        title: g.subject ?? '',
        type: g.isCommunity ? 'community' : 'group',
        participantCount: g.size ?? g.participants?.length,
        // `announce` = only admins can send. If this number can't be found in the member
        // list at all, don't block the group: a failed send is reported clearly anyway.
        canSend: !g.announce || isAdmin || !me,
        isAdmin,
      } satisfies ChatInfo;
    });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.connected || !this.sock) throw new SendError('disconnected', 'not connected');
    const key = this.inboundKeys.get(`${chatId}|${messageId}`);
    if (!key) return; // a message from before a restart: no reaction rather than a wrong one
    try {
      await this.sock.sendMessage(chatId, { react: { text: emoji, key } });
    } catch (err: any) {
      throw mapSendError(err);
    }
  }

  async send(chatId: string, content: MessageContent): Promise<SendResult> {
    if (!this.connected || !this.sock) throw new SendError('disconnected', 'not connected');
    const payload = toBaileysPayload(content);
    try {
      const started = Date.now();
      const res = await this.sock.sendMessage(chatId, payload);
      const ms = Date.now() - started;
      if (ms > 1500) this.log.info('slow send', { accountId: this.accountId, chatId, ms, members: this.groupCache.get(chatId)?.participants?.length ?? null });
      if (res?.key?.id && res.message) {
        this.sentCache.set(res.key.id, res.message);
        if (this.sentCache.size > 2000) this.sentCache.delete(this.sentCache.keys().next().value as string);
      }
      return { messageId: res?.key?.id ?? '', sentAt: new Date() };
    } catch (err: any) {
      throw mapSendError(err);
    }
  }

  /** An edit that arrived encrypted: opened with the original message's secret, then handled like any edit. */
  private openEncryptedEdit(B: Baileys, jid: string, msg: any, enc: any) {
    const target = enc.targetMessageKey ?? {};
    const info = { accountId: this.accountId, chatId: jid, id: target.id, type: enc.secretEncType ?? null };
    if (enc.secretEncType !== 2 || !target.id) { this.log.info('encrypted change skipped', info); return; } // 2 = MESSAGE_EDIT
    const seenKey = `${jid}|${msg.key.id}`;
    if (this.seen.has(seenKey)) return;
    this.seen.add(seenKey);
    const orig = this.secrets.get(`${jid}|${target.id}`);
    if (!orig) { this.log.warn('edit not opened: original message unknown here', info); return; }
    const user = this.sock?.user ?? {};
    const me = [user.id, user.lid, this.sock?.authState?.creds?.me?.id, this.sock?.authState?.creds?.me?.lid];
    const editor = [msg.key.participant, msg.key.participantAlt, msg.key.participantPn, ...(msg.key.fromMe ? me : [])];
    const origSenders = [...orig.senders, target.participant, ...(target.fromMe || msg.key.fromMe ? me : []), ...editor];
    const plain = decryptMessageEdit(enc, orig.secret, target.id, origSenders, editor);
    if (!plain) { this.log.warn('edit not opened: could not decrypt', info); return; }
    let decoded: any;
    try { decoded = B.proto.Message.decode(plain); } catch (e) { this.log.warn('edit not opened: bad content', { ...info, err: String(e) }); return; }
    const parsed = extractContent(editedContentOf(decoded));
    if (!parsed) { this.log.warn('edit not opened: unknown content', { ...info, types: Object.keys(editedContentOf(decoded) ?? {}).join(',') }); return; }
    const ts = Number(msg.messageTimestamp ?? 0);
    const edit: RawEdit = {
      chatId: jid, messageId: target.id, senderId: senderOf(msg.key) ?? jid, fromSelf: !!msg.key.fromMe,
      timestamp: new Date(ts ? ts * 1000 : Date.now()), content: parsed.content,
    };
    this.log.info('edit received', { accountId: this.accountId, chatId: jid, id: target.id, fromSelf: edit.fromSelf, kind: edit.content.kind, encrypted: true });
    this.emit('message_edited', edit);
  }

  /**
   * Edits a message this number sent. Baileys wraps { text, edit: key } into a
   * MESSAGE_EDIT protocol message. WhatsApp accepts edits for 15 minutes.
   * Editing a photo/video caption this way is NOT yet verified on a real number.
   */
  async edit(chatId: string, messageId: string, content: MessageContent): Promise<void> {
    if (!this.connected || !this.sock) throw new SendError('disconnected', 'not connected');
    const text = content.text ?? '';
    if (!text.trim()) throw new SendError('invalid', 'empty text');
    try {
      await this.sock.sendMessage(chatId, { text, edit: { remoteJid: chatId, fromMe: true, id: messageId } });
    } catch (err: any) {
      throw mapSendError(err);
    }
  }

  /** "Delete for everyone" of a message this number sent (Baileys REVOKE). */
  async remove(chatId: string, messageId: string): Promise<void> {
    if (!this.connected || !this.sock) throw new SendError('disconnected', 'not connected');
    try {
      await this.sock.sendMessage(chatId, { delete: { remoteJid: chatId, fromMe: true, id: messageId } });
    } catch (err: any) {
      throw mapSendError(err);
    }
  }
}

/**
 * Factory with the safety guard. Without explicit approval (allowReal), it
 * refuses to build a real client at all.
 */
export function baileysTransportFactory(opts: { allowReal: boolean; logger?: Logger; load?: () => Promise<Baileys> }): TransportFactory {
  return (accountId, store) => {
    if (!opts.allowReal) {
      throw new Error('Real WhatsApp connections are disabled (ALLOW_REAL_WHATSAPP is off). Owner approval required.');
    }
    const load = opts.load ?? (() => import(BAILEYS_MODULE as string));
    return new BaileysTransport(accountId, store, load, opts.logger);
  };
}
