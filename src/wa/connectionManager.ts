/**
 * Owns the lifecycle of every WhatsApp number linked by every tenant in this
 * worker process: linking (QR or pairing code), reconnecting after network
 * drops, and stopping for good when WhatsApp logs the device out or blocks
 * the number.
 *
 * Reconnect rules are deliberately conservative. Network drops get a capped
 * exponential backoff; anything that means "WhatsApp doesn't want this
 * session" (logged out, replaced, blocked) is never retried automatically —
 * the customer is told and decides. There is no number switching, no
 * fingerprint changing and no other attempt to get around a restriction.
 */
import type { ChannelSender, ChatInfo, InboundMessage, MessageContent, SendResult, SyncEvent } from '../core/types.js';
import { SendError } from '../core/types.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { AuthStore } from './authStore.js';
import type { DisconnectReason, StartOptions, TransportFactory, WaTransport } from './transport.js';
import { RECONNECT_POLICY } from './transport.js';

export type AccountStatus =
  | 'linking_qr'
  | 'linking_code'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'logged_out'
  | 'blocked'
  | 'link_expired'
  | 'needs_relink'
  | 'stopped';

export interface AccountState {
  tenantId: string;
  accountId: string;
  status: AccountStatus;
  phoneNumber?: string;
  lastConnectedAt?: Date;
  lastDisconnect?: { reason: DisconnectReason; at: Date; detail?: string };
  reconnectAttempts: number;
  /** Present only while linking. Shown to the customer, never logged or stored. */
  qr?: string;
  pairingCode?: string;
}

export interface StatusEvent {
  state: Readonly<AccountState>;
  previous: AccountStatus | null;
}

/** Signals that should make the delivery engine stop sending from an account. */
export interface SafetySignal {
  tenantId: string;
  accountId: string;
  kind: 'account_blocked' | 'logged_out' | 'replaced' | 'reconnect_exhausted';
  at: Date;
}

export interface ConnectionManagerOptions {
  transportFactory: TransportFactory;
  storeFactory: (tenantId: string, accountId: string) => AuthStore | Promise<AuthStore>;
  logger?: Logger;
  /** Backoff schedule for network drops, in ms. The last value repeats until maxReconnectAttempts. */
  backoffMs?: number[];
  maxReconnectAttempts?: number;
}

const DEFAULT_BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

interface Entry {
  state: AccountState;
  transport: WaTransport;
  store: AuthStore;
  startOpts: StartOptions;
  reconnectTimer?: NodeJS.Timeout;
  chatsCache?: { at: number; chats: ChatInfo[] };
  stopping: boolean;
}

export class ConnectionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly statusListeners = new Set<(e: StatusEvent) => void>();
  private readonly messageListeners = new Set<(m: InboundMessage) => void>();
  private readonly syncListeners = new Set<(e: SyncEvent) => void>();
  private readonly safetyListeners = new Set<(s: SafetySignal) => void>();
  private readonly log: Logger;
  private readonly backoff: number[];
  private readonly maxAttempts: number;

  constructor(private readonly opts: ConnectionManagerOptions) {
    this.log = (opts.logger ?? silentLogger).child({ component: 'wa-connections' });
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.maxAttempts = opts.maxReconnectAttempts ?? 8;
  }

  onStatus(fn: (e: StatusEvent) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  onMessage(fn: (m: InboundMessage) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }
  /** Edits and "delete for everyone" seen by any connected account. */
  onSync(fn: (e: SyncEvent) => void): () => void {
    this.syncListeners.add(fn);
    return () => this.syncListeners.delete(fn);
  }
  onSafetySignal(fn: (s: SafetySignal) => void): () => void {
    this.safetyListeners.add(fn);
    return () => this.safetyListeners.delete(fn);
  }

  getState(accountId: string): Readonly<AccountState> | undefined {
    return this.entries.get(accountId)?.state;
  }

  listStates(tenantId?: string): Readonly<AccountState>[] {
    return [...this.entries.values()].map((e) => e.state).filter((s) => !tenantId || s.tenantId === tenantId);
  }

  /**
   * Starts (or restarts) an account. If credentials exist it reconnects
   * silently; otherwise the chosen link flow begins and the QR / code arrives
   * through onStatus.
   */
  async connect(tenantId: string, accountId: string, startOpts: StartOptions): Promise<Readonly<AccountState>> {
    const existing = this.entries.get(accountId);
    if (existing) {
      if (existing.state.tenantId !== tenantId) throw new Error('account belongs to another tenant');
      if (existing.state.status === 'connected') return existing.state;
      await this.teardown(existing, false);
    }
    const store = await this.opts.storeFactory(tenantId, accountId);
    const transport = this.opts.transportFactory(accountId, store);
    const hasCreds = await store.hasCreds();
    const entry: Entry = {
      state: {
        tenantId,
        accountId,
        status: hasCreds ? 'connecting' : startOpts.method === 'qr' ? 'linking_qr' : 'linking_code',
        reconnectAttempts: 0,
        ...(existing?.state.lastConnectedAt ? { lastConnectedAt: existing.state.lastConnectedAt } : {}),
      },
      transport,
      store,
      startOpts,
      stopping: false,
    };
    this.entries.set(accountId, entry);
    this.wire(entry);
    this.emitStatus(entry, existing?.state.status ?? null);
    await transport.start(startOpts);
    return entry.state;
  }

  /** Closes the socket but keeps credentials (e.g. worker shutdown, customer pause). */
  async stop(accountId: string): Promise<void> {
    const e = this.entries.get(accountId);
    if (!e) return;
    await this.teardown(e, false);
    this.setStatus(e, 'stopped');
  }

  /** "Disconnect and delete": unlinks the device and deletes all stored credentials. */
  async disconnectAndDelete(accountId: string): Promise<void> {
    const e = this.entries.get(accountId);
    if (!e) return;
    e.stopping = true;
    this.clearReconnect(e);
    try {
      await e.transport.logout();
    } catch (err) {
      this.log.warn('logout failed, wiping locally', { accountId, err: String(err) });
    }
    await e.store.wipe();
    this.entries.delete(accountId);
    this.setStatus(e, 'logged_out');
  }

  async listChats(accountId: string, maxAgeMs = 60_000): Promise<ChatInfo[]> {
    const e = this.mustEntry(accountId);
    if (e.chatsCache && Date.now() - e.chatsCache.at < maxAgeMs) return e.chatsCache.chats;
    const chats = await e.transport.listChats();
    e.chatsCache = { at: Date.now(), chats };
    return chats;
  }

  /** A sender bound to one account, for the delivery engine. */
  sender(accountId: string): ChannelSender {
    return {
      platform: 'wa',
      accountId,
      send: (chatId: string, content: MessageContent): Promise<SendResult> => this.connected(accountId).then((t) => t.send(chatId, content)),
      edit: (chatId: string, messageId: string, content: MessageContent) => this.connected(accountId).then((t) => t.edit(chatId, messageId, content)),
      remove: (chatId: string, messageId: string) => this.connected(accountId).then((t) => t.remove(chatId, messageId)),
    };
  }

  private async connected(accountId: string) {
    const e = this.entries.get(accountId);
    if (!e || e.state.status !== 'connected') throw new SendError('disconnected', `account ${accountId} is ${e?.state.status ?? 'unknown'}`);
    return e.transport;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => this.teardown(e, false)));
    this.entries.clear();
  }

  // ---------------------------------------------------------------------

  private wire(e: Entry) {
    const t = e.transport;
    t.on('qr', (qr) => {
      e.state.qr = qr;
      this.setStatus(e, 'linking_qr', true);
    });
    t.on('pairing_code', (code) => {
      e.state.pairingCode = code;
      this.setStatus(e, 'linking_code', true);
    });
    t.on('open', ({ phoneNumber }) => {
      delete e.state.qr;
      delete e.state.pairingCode;
      e.state.phoneNumber = phoneNumber;
      e.state.lastConnectedAt = new Date();
      e.state.reconnectAttempts = 0;
      e.chatsCache = undefined;
      this.setStatus(e, 'connected');
      this.log.info('connected', { accountId: e.state.accountId, tenantId: e.state.tenantId });
    });
    t.on('chats_changed', () => {
      e.chatsCache = undefined;
    });
    t.on('message', (raw) => {
      const msg: InboundMessage = {
        tenantId: e.state.tenantId,
        source: { platform: 'wa', accountId: e.state.accountId, chatId: raw.chatId },
        messageId: raw.messageId,
        senderId: raw.senderId,
        fromSelf: raw.fromSelf,
        isForwarded: raw.isForwarded,
        receivedAt: raw.timestamp,
        content: raw.content,
      };
      for (const fn of this.messageListeners) {
        try {
          fn(msg);
        } catch (err) {
          this.log.error('message listener failed', { err: String(err) });
        }
      }
    });
    const sync = (ev: SyncEvent) => {
      for (const fn of this.syncListeners) {
        try {
          fn(ev);
        } catch (err) {
          this.log.error('sync listener failed', { err: String(err) });
        }
      }
    };
    t.on('message_edited', (raw) => sync({
      type: 'edit', tenantId: e.state.tenantId, source: { platform: 'wa', accountId: e.state.accountId, chatId: raw.chatId },
      messageId: raw.messageId, senderId: raw.senderId, content: raw.content, at: raw.timestamp,
    }));
    t.on('message_revoked', (raw) => sync({
      type: 'delete', tenantId: e.state.tenantId, source: { platform: 'wa', accountId: e.state.accountId, chatId: raw.chatId },
      messageId: raw.messageId, senderId: raw.senderId, at: raw.timestamp,
    }));
    t.on('close', ({ reason, detail }) => void this.handleClose(e, reason, detail));
  }

  private async handleClose(e: Entry, reason: DisconnectReason, detail?: string) {
    if (this.entries.get(e.state.accountId) !== e) return; // stale transport
    e.state.lastDisconnect = { reason, at: new Date(), ...(detail ? { detail } : {}) };
    delete e.state.qr;
    delete e.state.pairingCode;
    this.log.warn('disconnected', { accountId: e.state.accountId, reason });
    if (e.stopping || reason === 'stopped') return;

    const policy = RECONNECT_POLICY[reason];
    if (policy === 'immediate') {
      this.setStatus(e, 'connecting');
      await this.restartTransport(e);
      return;
    }
    if (policy === 'backoff') {
      if (e.state.reconnectAttempts >= this.maxAttempts) {
        this.setStatus(e, 'disconnected');
        this.signal(e, 'reconnect_exhausted');
        return;
      }
      const delay = this.backoff[Math.min(e.state.reconnectAttempts, this.backoff.length - 1)]!;
      e.state.reconnectAttempts++;
      this.setStatus(e, 'reconnecting');
      e.reconnectTimer = setTimeout(() => void this.restartTransport(e), delay);
      e.reconnectTimer.unref?.();
      return;
    }
    switch (reason) {
      case 'account_blocked':
        this.setStatus(e, 'blocked');
        this.signal(e, 'account_blocked');
        break;
      case 'logged_out':
        await e.store.wipe();
        this.setStatus(e, 'logged_out');
        this.signal(e, 'logged_out');
        break;
      case 'replaced':
        this.setStatus(e, 'disconnected');
        this.signal(e, 'replaced');
        break;
      case 'bad_session':
        await e.store.wipe();
        this.setStatus(e, 'needs_relink');
        break;
      case 'link_timeout':
        this.setStatus(e, 'link_expired');
        break;
      default:
        this.setStatus(e, 'disconnected');
    }
  }

  private async restartTransport(e: Entry) {
    if (this.entries.get(e.state.accountId) !== e || e.stopping) return;
    const fresh = this.opts.transportFactory(e.state.accountId, e.store);
    await e.transport.stop().catch(() => {});
    e.transport = fresh;
    this.wire(e);
    try {
      await fresh.start(e.startOpts);
    } catch (err) {
      this.log.error('restart failed', { accountId: e.state.accountId, err: String(err) });
      await this.handleClose(e, 'connection_lost', String(err));
    }
  }

  private async teardown(e: Entry, wipe: boolean) {
    e.stopping = true;
    this.clearReconnect(e);
    await e.transport.stop().catch(() => {});
    if (wipe) await e.store.wipe();
  }

  private clearReconnect(e: Entry) {
    if (e.reconnectTimer) clearTimeout(e.reconnectTimer);
    e.reconnectTimer = undefined;
  }

  private setStatus(e: Entry, status: AccountStatus, force = false) {
    const prev = e.state.status;
    if (prev === status && !force) return;
    e.state.status = status;
    this.emitStatus(e, prev);
  }

  private emitStatus(e: Entry, previous: AccountStatus | null) {
    const snapshot = { ...e.state };
    for (const fn of this.statusListeners) {
      try {
        fn({ state: snapshot, previous });
      } catch (err) {
        this.log.error('status listener failed', { err: String(err) });
      }
    }
  }

  private signal(e: Entry, kind: SafetySignal['kind']) {
    const s: SafetySignal = { tenantId: e.state.tenantId, accountId: e.state.accountId, kind, at: new Date() };
    for (const fn of this.safetyListeners) fn(s);
  }

  private mustEntry(accountId: string): Entry {
    const e = this.entries.get(accountId);
    if (!e) throw new Error(`unknown account ${accountId}`);
    return e;
  }
}
