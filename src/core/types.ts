/**
 * Platform-neutral domain types shared by WhatsApp, Telegram and the router.
 */

export type Platform = 'wa' | 'tg';

/** Identifies one chat (group, channel) as seen by one connected account. */
export interface ChatRef {
  platform: Platform;
  /** Our id for the connected WhatsApp number or Telegram bot. */
  accountId: string;
  /** The platform's chat id (WhatsApp JID like 1203...@g.us, Telegram numeric id). */
  chatId: string;
}

export function chatKey(c: ChatRef): string {
  return `${c.platform}:${c.accountId}:${c.chatId}`;
}

export type MessageKind = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';

export interface MediaRef {
  mimeType: string;
  /** Size in bytes, when known. */
  size?: number;
  /** Where the bytes are. Phase 1 keeps media in memory or a temp URL. */
  data?: Buffer;
  url?: string;
  /** Reference into the MediaStore, used once the bytes are stored (jobs keep only this). */
  ref?: string;
  fileName?: string;
  /** Lazy loader supplied by a transport (e.g. WhatsApp media download). */
  load?: () => Promise<Buffer>;
}

export interface MessageContent {
  kind: MessageKind;
  /** Body text for text messages, caption for media. */
  text?: string;
  media?: MediaRef;
}

/** A message received in a chat the account can see. */
export interface InboundMessage {
  tenantId: string;
  source: ChatRef;
  /** Platform message id, unique within the source chat. */
  messageId: string;
  senderId: string;
  /** True when the connected account itself sent the message. */
  fromSelf: boolean;
  /** Forwarded from somewhere else (WhatsApp shows "Forwarded"). */
  isForwarded: boolean;
  receivedAt: Date;
  content: MessageContent;
  /** The message this one replies to, when the platform says so (used for the Telegram delete command). */
  replyToMessageId?: string;
}

/** A group member read a message this system sent (WhatsApp read receipt). */
export interface ReadReceipt {
  platform: Platform;
  accountId: string;
  chatId: string;
  messageId: string;
  /** Who read it (phone or LID); counted once per copy. */
  readerId: string;
  at: Date;
}

/**
 * A change to a message that was already received: an edit, or a
 * "delete for everyone". "Delete for me" never reaches us and is never an event.
 */
export type SyncEvent =
  | { type: 'edit'; tenantId: string; source: ChatRef; messageId: string; senderId: string; fromSelf?: boolean; content: MessageContent; at: Date }
  | { type: 'delete'; tenantId: string; source: ChatRef; messageId: string; senderId: string; fromSelf?: boolean; at: Date };

export type ChatType = 'group' | 'channel' | 'private' | 'community';

/** A chat the account can see, with what it may do there. */
export interface ChatInfo {
  ref: ChatRef;
  title: string;
  type: ChatType;
  participantCount?: number;
  /** Whether the account may post. False for "only admins can send" groups the account doesn't admin. */
  canSend: boolean;
  isAdmin: boolean;
}

export type SendErrorKind =
  /** Retrying later may work (network blip, timeout). */
  | 'transient'
  /** The platform said to slow down. Treated as a safety signal. */
  | 'rate_limited'
  /** The account is not allowed to post there (left, removed, admins-only). */
  | 'forbidden'
  /** The chat no longer exists or is not visible. */
  | 'not_found'
  /** The account is logged out, banned or restricted. Stops the account. */
  | 'account_blocked'
  /** Not connected right now. */
  | 'disconnected'
  /** Bad input (empty text, unsupported media). */
  | 'invalid'
  /** The platform's time limit for editing or deleting this message has passed. */
  | 'window_closed'
  /**
   * The request may or may not have reached the platform (e.g. a timeout after
   * sending). A send in this state is never repeated automatically.
   */
  | 'unknown';

export class SendError extends Error {
  constructor(public readonly kind: SendErrorKind, message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'SendError';
  }
}

export interface SendResult {
  messageId: string;
  sentAt: Date;
}

/**
 * What every connected account (WhatsApp number or Telegram bot) exposes to
 * the delivery engine. Implementations: Baileys, Telegram Bot API, fakes.
 */
export interface ChannelSender {
  readonly platform: Platform;
  readonly accountId: string;
  send(chatId: string, content: MessageContent): Promise<SendResult>;
  /** Changes the text (or caption) of a message this account sent. */
  edit?(chatId: string, messageId: string, content: MessageContent): Promise<void>;
  /** Deletes, for everyone, a message this account sent. */
  remove?(chatId: string, messageId: string): Promise<void>;
}

/**
 * What a connector can do. The engine checks this before planning an edit or
 * delete, and shows the customer "not supported" instead of trying.
 *
 * 'verified'   — tested against the real platform.
 * 'documented' — the platform documents it; not yet run against the real service here.
 * 'untested'   — written, but whether the platform accepts it is not yet known.
 * false        — the platform does not offer it.
 */
export type CapabilityLevel = 'verified' | 'documented' | 'untested' | false;

export interface Capabilities {
  send: CapabilityLevel;
  edit: CapabilityLevel;
  /** Editing the caption of a photo, video or document. */
  editCaption: CapabilityLevel;
  delete: CapabilityLevel;
  receive: CapabilityLevel;
  receiveEdits: CapabilityLevel;
  receiveDeletes: CapabilityLevel;
  media: CapabilityLevel;
  groupDiscovery: CapabilityLevel;
  deliveryStatus: CapabilityLevel;
  /** Who read a sent message (only members who keep read receipts on). */
  reads: CapabilityLevel;
  /** After this long a sent message can no longer be edited. Undefined = no limit. */
  editWindowMs?: number;
  /** After this long a sent message can no longer be deleted for everyone. */
  deleteWindowMs?: number;
}

/**
 * The capabilities as of October 2026. Nothing here has been run against the
 * real services yet (phase 1b needs the owner's approval), so the best level
 * is 'documented'.
 *  - WhatsApp: edit within 15 minutes; delete for everyone within about 2.5 days.
 *  - Telegram Bot API: a bot edits its own messages; delete within 48 hours;
 *    the Bot API does not tell bots that a message was deleted.
 */
export const CAPABILITIES: Record<Platform, Capabilities> = {
  wa: {
    send: 'documented',
    edit: 'documented',
    editCaption: 'untested',
    delete: 'documented',
    receive: 'documented',
    receiveEdits: 'documented',
    receiveDeletes: 'documented',
    media: 'documented',
    groupDiscovery: 'documented',
    deliveryStatus: 'untested',
    reads: 'untested',
    editWindowMs: 15 * 60_000,
    deleteWindowMs: 60 * 60 * 60_000,
  },
  tg: {
    send: 'documented',
    edit: 'documented',
    editCaption: 'documented',
    delete: 'documented',
    receive: 'documented',
    receiveEdits: 'documented',
    receiveDeletes: false,
    media: 'documented',
    groupDiscovery: false,
    deliveryStatus: false,
    reads: false,
    deleteWindowMs: 48 * 60 * 60_000,
  },
};
