/**
 * An in-memory imitation of WhatsApp, for tests and the simulator.
 *
 * It reproduces the behaviours the product must handle — QR and pairing-code
 * linking, credentials surviving restarts, group membership and
 * "admins only" groups, rate limiting, logouts, bans and dropped
 * connections — without touching a real number. Failure injection methods
 * (ban, unlinkDevice, dropConnections, setRateLimit, removeMember) let tests
 * drive every error path on purpose.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { ChatInfo, MessageContent, SendResult } from '../core/types.js';
import { SendError } from '../core/types.js';
import type { AuthStore } from './authStore.js';
import type { DisconnectReason, RawInbound, StartOptions, TransportEvents, WaTransport } from './transport.js';
import { normalizePhone } from './transport.js';

interface FakePhone {
  phone: string;
  banned: boolean;
  rateLimit?: { max: number; windowMs: number };
  sendTimes: number[];
  /** The next send is delivered but the sender gets no answer (outcome unknown). */
  loseNextAck?: boolean;
}

/** WhatsApp's limits for changing a sent message. */
export const WA_EDIT_WINDOW_MS = 15 * 60_000;
export const WA_DELETE_WINDOW_MS = 60 * 60 * 60_000;

export interface FakeLogEntry {
  id: string;
  from: string;
  content: MessageContent;
  at: Date;
  editedAt?: Date;
  /** Deleted for everyone ("This message was deleted"). */
  deleted?: boolean;
  /** Phones that deleted it only for themselves. */
  hiddenFor?: Set<string>;
}

interface FakeGroup {
  jid: string;
  title: string;
  members: Set<string>;
  admins: Set<string>;
  adminsOnly: boolean;
  log: FakeLogEntry[];
}

interface FakeCreds {
  registered: true;
  me: { id: string };
  deviceId: string;
}

export interface FakeTimings {
  /** How long each QR is valid before a new one is shown. */
  qrIntervalMs: number;
  /** How many QRs are shown before giving up (link_timeout). */
  maxQrCodes: number;
  /** How long a pairing code waits for the user. */
  pairingTimeoutMs: number;
  /** Simulated connect latency. */
  connectDelayMs: number;
}

const DEFAULT_TIMINGS: FakeTimings = { qrIntervalMs: 20_000, maxQrCodes: 5, pairingTimeoutMs: 120_000, connectDelayMs: 5 };

export class FakeWaNetwork {
  private readonly phones = new Map<string, FakePhone>();
  private readonly groups = new Map<string, FakeGroup>();
  private readonly live = new Map<string, Set<FakeTransport>>();
  private readonly pendingQr = new Map<string, FakeTransport>();
  private readonly pendingPair = new Map<string, { t: FakeTransport; phone: string }>();
  readonly timings: FakeTimings;
  /** The network's clock (tests move it forward to pass edit / delete windows). */
  clock: () => number = Date.now;

  constructor(timings: Partial<FakeTimings> = {}) {
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
  }

  // ---------- world setup ----------

  addPhone(phone: string): void {
    if (!this.phones.has(phone)) this.phones.set(phone, { phone, banned: false, sendTimes: [] });
  }

  createGroup(title: string, opts: { members: string[]; admins?: string[]; adminsOnly?: boolean; jid?: string }): string {
    const jid = opts.jid ?? `1203${randomBytes(6).readUIntBE(0, 6)}@g.us`;
    for (const p of opts.members) this.addPhone(p);
    this.groups.set(jid, {
      jid,
      title,
      members: new Set(opts.members),
      admins: new Set(opts.admins ?? []),
      adminsOnly: opts.adminsOnly ?? false,
      log: [],
    });
    return jid;
  }

  // ---------- user actions on the phone ----------

  /** The user scans a QR shown by our app with their phone. */
  scanQr(phone: string, qr: string): void {
    const t = this.pendingQr.get(qr);
    if (!t) throw new Error('QR expired or unknown');
    this.pendingQr.delete(qr);
    this.addPhone(phone);
    t.completeLink(phone);
  }

  /** The user types the pairing code into WhatsApp > Linked devices. */
  enterPairingCode(phone: string, code: string): void {
    const p = this.pendingPair.get(code);
    if (!p) throw new Error('pairing code expired or unknown');
    if (p.phone !== phone) throw new Error('pairing code belongs to another number');
    this.pendingPair.delete(code);
    this.addPhone(phone);
    p.t.completeLink(phone);
  }

  /** A human (not our system) posts in a group, e.g. a news editor in a source group. */
  humanPost(phone: string, jid: string, content: MessageContent): string {
    const g = this.mustGroup(jid);
    if (!g.members.has(phone)) throw new Error(`${phone} is not in ${g.title}`);
    return this.deliver(g, phone, content);
  }

  /** A human edits their own message (allowed for 15 minutes); members' devices see the edit. */
  humanEdit(phone: string, jid: string, messageId: string, content: MessageContent): void {
    this.editFrom(phone, jid, messageId, content);
  }

  /** "Delete for everyone" by the author or a group admin; members' devices are told. */
  humanDeleteForEveryone(phone: string, jid: string, messageId: string): void {
    this.removeFrom(phone, jid, messageId);
  }

  /** "Delete for me": only that person's phone hides it. Nobody else is told — like WhatsApp. */
  humanDeleteForMe(phone: string, jid: string, messageId: string): void {
    const e = this.mustEntry(this.mustGroup(jid), messageId);
    (e.hiddenFor ??= new Set()).add(phone);
  }

  // ---------- failure injection ----------

  /** The next message this phone sends reaches the group, but the sender never gets the answer. */
  loseNextAck(phone: string): void {
    this.mustPhone(phone).loseNextAck = true;
  }

  ban(phone: string): void {
    this.mustPhone(phone).banned = true;
    this.closeAll(phone, 'account_blocked');
  }

  unlinkDevice(phone: string): void {
    this.closeAll(phone, 'logged_out');
  }

  dropConnections(phone: string): void {
    this.closeAll(phone, 'connection_lost');
  }

  setRateLimit(phone: string, max: number, windowMs: number): void {
    this.mustPhone(phone).rateLimit = { max, windowMs };
  }

  removeMember(jid: string, phone: string): void {
    this.mustGroup(jid).members.delete(phone);
    for (const t of this.live.get(phone) ?? []) t.emitPublic('chats_changed');
  }

  setAdminsOnly(jid: string, adminsOnly: boolean): void {
    const g = this.mustGroup(jid);
    g.adminsOnly = adminsOnly;
    for (const m of g.members) for (const t of this.live.get(m) ?? []) t.emitPublic('chats_changed');
  }

  // ---------- inspection for tests ----------

  groupLog(jid: string) {
    return this.mustGroup(jid).log;
  }

  liveDeviceCount(phone: string): number {
    return this.live.get(phone)?.size ?? 0;
  }

  // ---------- used by FakeTransport ----------

  /** @internal */ registerQr(qr: string, t: FakeTransport) { this.pendingQr.set(qr, t); }
  /** @internal */ unregisterQr(qr: string) { this.pendingQr.delete(qr); }
  /** @internal */ registerPairing(code: string, t: FakeTransport, phone: string) { this.pendingPair.set(code, { t, phone }); }
  /** @internal */ unregisterPairing(code: string) { this.pendingPair.delete(code); }

  /** @internal */ attach(phone: string, t: FakeTransport): DisconnectReason | null {
    const p = this.phones.get(phone);
    if (!p) return 'bad_session';
    if (p.banned) return 'account_blocked';
    let set = this.live.get(phone);
    if (!set) this.live.set(phone, (set = new Set()));
    set.add(t);
    return null;
  }

  /** @internal */ detach(phone: string, t: FakeTransport) {
    this.live.get(phone)?.delete(t);
  }

  /** @internal */ chatsFor(phone: string, accountId: string): ChatInfo[] {
    const out: ChatInfo[] = [];
    for (const g of this.groups.values()) {
      if (!g.members.has(phone)) continue;
      const isAdmin = g.admins.has(phone);
      out.push({
        ref: { platform: 'wa', accountId, chatId: g.jid },
        title: g.title,
        type: 'group',
        participantCount: g.members.size,
        canSend: !g.adminsOnly || isAdmin,
        isAdmin,
      });
    }
    return out;
  }

  /** @internal */ sendFrom(phone: string, jid: string, content: MessageContent): SendResult {
    const p = this.mustPhone(phone);
    if (p.banned) throw new SendError('account_blocked', 'number is banned');
    const g = this.groups.get(jid);
    if (!g) throw new SendError('not_found', 'group not found');
    if (!g.members.has(phone)) throw new SendError('forbidden', 'not a member of the group');
    if (g.adminsOnly && !g.admins.has(phone)) throw new SendError('forbidden', 'only admins can send');
    if (p.rateLimit) {
      const now = Date.now();
      p.sendTimes = p.sendTimes.filter((t) => now - t < p.rateLimit!.windowMs);
      if (p.sendTimes.length >= p.rateLimit.max) throw new SendError('rate_limited', 'rate-overlimit', p.rateLimit.windowMs);
      p.sendTimes.push(now);
    }
    const id = this.deliver(g, phone, content);
    if (p.loseNextAck) {
      p.loseNextAck = false;
      throw new SendError('unknown', 'no answer from WhatsApp after sending');
    }
    return { messageId: id, sentAt: new Date(this.clock()) };
  }

  /** @internal */ editFrom(phone: string, jid: string, messageId: string, content: MessageContent): void {
    const p = this.mustPhone(phone);
    if (p.banned) throw new SendError('account_blocked', 'number is banned');
    const g = this.groups.get(jid);
    if (!g) throw new SendError('not_found', 'group not found');
    const e = g.log.find((x) => x.id === messageId);
    if (!e || e.deleted) throw new SendError('not_found', 'message not found');
    if (e.from !== phone) throw new SendError('forbidden', 'only the author can edit');
    if (this.clock() - e.at.getTime() > WA_EDIT_WINDOW_MS) throw new SendError('window_closed', 'edit window (15 minutes) has passed');
    this.checkRate(p);
    e.content = { ...e.content, text: content.text };
    e.editedAt = new Date(this.clock());
    for (const member of g.members) {
      for (const t of this.live.get(member) ?? []) {
        t.emitPublic('message_edited', { chatId: jid, messageId, senderId: `${phone}@s.whatsapp.net`, fromSelf: member === phone, timestamp: e.editedAt, content: e.content });
      }
    }
  }

  /** @internal */ removeFrom(phone: string, jid: string, messageId: string): void {
    const p = this.mustPhone(phone);
    if (p.banned) throw new SendError('account_blocked', 'number is banned');
    const g = this.groups.get(jid);
    if (!g) throw new SendError('not_found', 'group not found');
    const e = g.log.find((x) => x.id === messageId);
    if (!e) throw new SendError('not_found', 'message not found');
    if (e.deleted) return; // deleting twice is harmless
    if (e.from !== phone && !g.admins.has(phone)) throw new SendError('forbidden', 'only the author or an admin can delete for everyone');
    if (this.clock() - e.at.getTime() > WA_DELETE_WINDOW_MS) throw new SendError('window_closed', 'delete-for-everyone window has passed');
    this.checkRate(p);
    e.deleted = true;
    for (const member of g.members) {
      for (const t of this.live.get(member) ?? []) {
        t.emitPublic('message_revoked', { chatId: jid, messageId, senderId: `${phone}@s.whatsapp.net`, fromSelf: member === phone, timestamp: new Date(this.clock()) });
      }
    }
  }

  private checkRate(p: FakePhone) {
    if (!p.rateLimit) return;
    const now = Date.now();
    p.sendTimes = p.sendTimes.filter((t) => now - t < p.rateLimit!.windowMs);
    if (p.sendTimes.length >= p.rateLimit.max) throw new SendError('rate_limited', 'rate-overlimit', p.rateLimit.windowMs);
    p.sendTimes.push(now);
  }

  private mustEntry(g: FakeGroup, id: string): FakeLogEntry {
    const e = g.log.find((x) => x.id === id);
    if (!e) throw new Error(`no message ${id} in ${g.title}`);
    return e;
  }

  private deliver(g: FakeGroup, from: string, content: MessageContent): string {
    const id = `FAKE${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    const at = new Date(this.clock());
    g.log.push({ id, from, content, at });
    for (const member of g.members) {
      for (const t of this.live.get(member) ?? []) {
        t.emitPublic('message', {
          chatId: g.jid,
          messageId: id,
          senderId: `${from}@s.whatsapp.net`,
          fromSelf: member === from,
          isForwarded: false,
          timestamp: at,
          content,
        });
      }
    }
    return id;
  }

  private closeAll(phone: string, reason: DisconnectReason) {
    for (const t of [...(this.live.get(phone) ?? [])]) t.forceClose(reason);
  }

  private mustPhone(phone: string): FakePhone {
    const p = this.phones.get(phone);
    if (!p) throw new Error(`unknown phone ${phone}`);
    return p;
  }

  private mustGroup(jid: string): FakeGroup {
    const g = this.groups.get(jid);
    if (!g) throw new Error(`unknown group ${jid}`);
    return g;
  }
}

type Listener = (...args: unknown[]) => void;

export class FakeTransport implements WaTransport {
  private listeners = new Map<string, Set<Listener>>();
  private phone: string | null = null;
  private connected = false;
  private timers: NodeJS.Timeout[] = [];
  private pendingCodes: { qr: string[]; pair: string[] } = { qr: [], pair: [] };

  constructor(public readonly accountId: string, private readonly store: AuthStore, private readonly net: FakeWaNetwork) {}

  on<E extends keyof TransportEvents>(event: E, fn: TransportEvents[E]) {
    let s = this.listeners.get(event);
    if (!s) this.listeners.set(event, (s = new Set()));
    s.add(fn as Listener);
  }
  off<E extends keyof TransportEvents>(event: E, fn: TransportEvents[E]) {
    this.listeners.get(event)?.delete(fn as Listener);
  }
  /** @internal */ emitPublic(event: keyof TransportEvents, ...args: unknown[]) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
  }

  async start(opts: StartOptions): Promise<void> {
    const creds = (await this.store.readCreds()) as FakeCreds | null;
    if (creds?.registered) {
      this.phone = creds.me.id;
      this.later(this.net.timings.connectDelayMs, () => {
        const err = this.net.attach(this.phone!, this);
        if (err) return this.emitClose(err);
        this.connected = true;
        this.emitPublic('open', { phoneNumber: this.phone });
      });
      return;
    }
    if (opts.method === 'pairing_code') {
      if (!opts.phoneNumber) throw new Error('phoneNumber is required for pairing_code');
      const phone = normalizePhone(opts.phoneNumber);
      const raw = randomBytes(4).toString('hex').toUpperCase();
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      this.pendingCodes.pair.push(code);
      this.net.registerPairing(code, this, phone);
      this.emitPublic('pairing_code', code);
      this.later(this.net.timings.pairingTimeoutMs, () => {
        if (this.phone) return;
        this.clearPending();
        this.emitClose('link_timeout');
      });
      return;
    }
    let shown = 0;
    const showQr = () => {
      if (this.phone) return;
      for (const q of this.pendingCodes.qr) this.net.unregisterQr(q);
      this.pendingCodes.qr = [];
      if (shown >= this.net.timings.maxQrCodes) {
        this.emitClose('link_timeout');
        return;
      }
      shown++;
      const qr = `2@${randomBytes(24).toString('base64')},${randomBytes(16).toString('base64')}`;
      this.pendingCodes.qr.push(qr);
      this.net.registerQr(qr, this);
      this.emitPublic('qr', qr);
      this.later(this.net.timings.qrIntervalMs, showQr);
    };
    showQr();
  }

  /** @internal Called by the network when the user scanned the QR or entered the code. */
  completeLink(phone: string) {
    this.clearPending();
    this.phone = phone;
    const creds: FakeCreds = { registered: true, me: { id: phone }, deviceId: randomUUID() };
    void this.store.writeCreds(creds).then(() => {
      // Real WhatsApp closes the socket after a successful link and expects a restart.
      this.emitClose('restart_required');
    });
  }

  async stop() {
    this.clearTimers();
    this.clearPending();
    if (this.phone) this.net.detach(this.phone, this);
    const was = this.connected;
    this.connected = false;
    if (was) this.emitPublic('close', { reason: 'stopped' });
  }

  async logout() {
    if (this.phone) this.net.detach(this.phone, this);
    this.clearTimers();
    this.clearPending();
    this.connected = false;
    await this.store.wipe();
    this.emitPublic('close', { reason: 'logged_out', detail: 'logout requested' });
  }

  async listChats(): Promise<ChatInfo[]> {
    if (!this.connected || !this.phone) throw new SendError('disconnected', 'not connected');
    return this.net.chatsFor(this.phone, this.accountId);
  }

  async send(chatId: string, content: MessageContent): Promise<SendResult> {
    if (!this.connected || !this.phone) throw new SendError('disconnected', 'not connected');
    if (content.kind === 'text' && !content.text?.trim()) throw new SendError('invalid', 'empty text');
    if (content.kind !== 'text' && !content.media) throw new SendError('invalid', 'media missing');
    return this.net.sendFrom(this.phone, chatId, content);
  }

  async edit(chatId: string, messageId: string, content: MessageContent): Promise<void> {
    if (!this.connected || !this.phone) throw new SendError('disconnected', 'not connected');
    if (!content.text?.trim() && content.kind === 'text') throw new SendError('invalid', 'empty text');
    this.net.editFrom(this.phone, chatId, messageId, content);
  }

  async remove(chatId: string, messageId: string): Promise<void> {
    if (!this.connected || !this.phone) throw new SendError('disconnected', 'not connected');
    this.net.removeFrom(this.phone, chatId, messageId);
  }

  /** @internal */ forceClose(reason: DisconnectReason) {
    if (this.phone) this.net.detach(this.phone, this);
    this.connected = false;
    this.clearTimers();
    this.emitClose(reason);
  }

  private emitClose(reason: DisconnectReason) {
    this.connected = false;
    this.emitPublic('close', { reason });
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    this.timers.push(t);
  }
  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
  private clearPending() {
    for (const q of this.pendingCodes.qr) this.net.unregisterQr(q);
    for (const c of this.pendingCodes.pair) this.net.unregisterPairing(c);
    this.pendingCodes = { qr: [], pair: [] };
  }
}

export function fakeTransportFactory(net: FakeWaNetwork) {
  return (accountId: string, store: AuthStore): WaTransport => new FakeTransport(accountId, store, net);
}

export type { RawInbound };
