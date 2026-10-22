/**
 * The contract between the connection manager and a WhatsApp client library.
 *
 * Two implementations exist:
 *  - BaileysTransport: the real linked-device client (unofficial; ban risk).
 *  - FakeTransport: an in-memory simulation used by tests and the simulator.
 *
 * Nothing above this layer knows which one is running.
 */
import type { ChatInfo, MessageContent, SendResult } from '../core/types.js';
import type { AuthStore } from './authStore.js';

export type LinkMethod = 'qr' | 'pairing_code';

export type DisconnectReason =
  /** Network dropped or server restarted. Safe to reconnect with backoff. */
  | 'connection_lost'
  /** WhatsApp asks for a restart (normal right after first link). Reconnect immediately. */
  | 'restart_required'
  /** The user removed the linked device from their phone. Credentials are dead. */
  | 'logged_out'
  /** Another client took over this session. Do not fight it. */
  | 'replaced'
  /** The number is banned or restricted by WhatsApp. Stop everything. */
  | 'account_blocked'
  /** Stored credentials are unreadable or rejected. Needs a fresh link. */
  | 'bad_session'
  /** Nobody scanned the QR / entered the code in time. */
  | 'link_timeout'
  /** We closed it on purpose. */
  | 'stopped';

/** What the manager should do after each disconnect reason. */
export const RECONNECT_POLICY: Record<DisconnectReason, 'backoff' | 'immediate' | 'never'> = {
  connection_lost: 'backoff',
  restart_required: 'immediate',
  logged_out: 'never',
  replaced: 'never',
  account_blocked: 'never',
  bad_session: 'never',
  link_timeout: 'never',
  stopped: 'never',
};

export interface RawInbound {
  chatId: string;
  messageId: string;
  senderId: string;
  fromSelf: boolean;
  isForwarded: boolean;
  timestamp: Date;
  content: MessageContent;
}

/** Someone edited a message (WhatsApp allows this for 15 minutes). */
export interface RawEdit {
  chatId: string;
  messageId: string;
  senderId: string;
  fromSelf: boolean;
  timestamp: Date;
  content: MessageContent;
}

/**
 * A "delete for everyone". "Delete for me" is a private app-state change on
 * the phone; it is never reported here and never deletes copies.
 */
export interface RawRevoke {
  chatId: string;
  messageId: string;
  /** Who deleted it (the author, or a group admin). */
  senderId: string;
  timestamp: Date;
}

export interface TransportEvents {
  qr: (qr: string) => void;
  pairing_code: (code: string) => void;
  open: (info: { phoneNumber: string }) => void;
  close: (info: { reason: DisconnectReason; detail?: string }) => void;
  message: (msg: RawInbound) => void;
  message_edited: (e: RawEdit) => void;
  message_revoked: (e: RawRevoke) => void;
  /** Group list or a group's settings changed; the manager refreshes its cache. */
  chats_changed: () => void;
}

export interface StartOptions {
  method: LinkMethod;
  /** Required for pairing_code: digits only, with country code (e.g. 972501234567). */
  phoneNumber?: string;
}

export interface WaTransport {
  readonly accountId: string;
  /** Connects. Uses stored credentials if present, otherwise starts the chosen link flow. */
  start(opts: StartOptions): Promise<void>;
  /** Closes the socket, keeps credentials. */
  stop(): Promise<void>;
  /** Unlinks the device on WhatsApp's side (when connected) and closes. */
  logout(): Promise<void>;
  listChats(): Promise<ChatInfo[]>;
  send(chatId: string, content: MessageContent): Promise<SendResult>;
  /** Edits the text / caption of a message this number sent. */
  edit(chatId: string, messageId: string, content: MessageContent): Promise<void>;
  /** Deletes for everyone a message this number sent. */
  remove(chatId: string, messageId: string): Promise<void>;
  on<E extends keyof TransportEvents>(event: E, fn: TransportEvents[E]): void;
  off<E extends keyof TransportEvents>(event: E, fn: TransportEvents[E]): void;
}

export type TransportFactory = (accountId: string, store: AuthStore) => WaTransport;

/** Validates a phone number for pairing: 8–15 digits, country code first, no plus. */
export function normalizePhone(input: string): string {
  const digits = input.replace(/[\s\-()+]/g, '');
  if (!/^\d{8,15}$/.test(digits)) {
    throw new Error('phone number must be 8–15 digits including country code (e.g. 972501234567)');
  }
  if (digits.startsWith('0')) {
    throw new Error('phone number must start with the country code, not 0 (e.g. 972 instead of 0)');
  }
  return digits;
}
