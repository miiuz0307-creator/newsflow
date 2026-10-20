/**
 * Real WhatsApp linked-device client, built on Baileys (unofficial).
 *
 * STATUS: written against the Baileys public API but NOT yet compiled or run
 * against the real library — the npm registry was unreachable when this was
 * written. It loads Baileys with a dynamic import, so the rest of the project
 * builds and tests without it. Before first use:
 *   1. npm install baileys  (pin an exact version; verify the package name and
 *      integrity — a malicious Baileys fork once stole credentials)
 *   2. run test/baileys.smoke.ts manually with a TEST number, with the owner's
 *      approval and ALLOW_REAL_WHATSAPP=1.
 *
 * Using this client is against WhatsApp's terms. It identifies itself
 * honestly, does not spoof devices and does not retry after a ban.
 */
import type { ChatInfo, MessageContent, MessageKind, SendResult } from '../core/types.js';
import { SendError } from '../core/types.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { AuthStore } from './authStore.js';
import { BufferJSON } from './authStore.js';
import type { DisconnectReason, RawInbound, StartOptions, TransportEvents, TransportFactory, WaTransport } from './transport.js';
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
  const m = message.ephemeralMessage?.message ?? message.viewOnceMessageV2?.message ?? message;
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
  private listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  private connected = false;
  private pairingRequested = false;
  private stopped = false;

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

    const sock = makeWASocket({
      auth: { creds, keys: B.makeCacheableSignalKeyStore ? B.makeCacheableSignalKeyStore(keys) : keys },
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // Honest identity: shown to the customer under WhatsApp > Linked devices.
      browser: ['NewsFlow', 'Chrome', '1.0'],
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
      if (ev.type !== 'notify') return;
      for (const msg of ev.messages ?? []) {
        const jid: string | undefined = msg.key?.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;
        const parsed = extractContent(msg.message);
        if (!parsed) continue;
        const raw: RawInbound = {
          chatId: jid,
          messageId: msg.key.id,
          senderId: msg.key.participant ?? jid,
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

    const changed = () => this.emit('chats_changed');
    sock.ev.on('groups.update', changed);
    sock.ev.on('group-participants.update', changed);
    sock.ev.on('groups.upsert', changed);
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
    const myJid: string = this.sock.user?.id ?? '';
    const myNum = myJid.split(':')[0]?.split('@')[0];
    return Object.values(groups).map((g: any) => {
      const me = (g.participants ?? []).find((p: any) => String(p.id).split('@')[0]?.split(':')[0] === myNum);
      const isAdmin = me?.admin === 'admin' || me?.admin === 'superadmin';
      return {
        ref: { platform: 'wa', accountId: this.accountId, chatId: g.id },
        title: g.subject ?? '',
        type: g.isCommunity ? 'community' : 'group',
        participantCount: g.size ?? g.participants?.length,
        // `announce` = only admins can send.
        canSend: !g.announce || isAdmin,
        isAdmin,
      } satisfies ChatInfo;
    });
  }

  async send(chatId: string, content: MessageContent): Promise<SendResult> {
    if (!this.connected || !this.sock) throw new SendError('disconnected', 'not connected');
    const payload = toBaileysPayload(content);
    try {
      const res = await this.sock.sendMessage(chatId, payload);
      return { messageId: res?.key?.id ?? '', sentAt: new Date() };
    } catch (err: any) {
      const status = err?.output?.statusCode ?? err?.data?.statusCode;
      const msg = String(err?.message ?? err);
      if (/rate-overlimit/i.test(msg) || status === 429) throw new SendError('rate_limited', msg);
      if (status === 403 || /not-authorized|forbidden/i.test(msg)) throw new SendError('forbidden', msg);
      if (status === 404 || /item-not-found/i.test(msg)) throw new SendError('not_found', msg);
      if (status === 401) throw new SendError('account_blocked', msg);
      throw new SendError('transient', msg);
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
