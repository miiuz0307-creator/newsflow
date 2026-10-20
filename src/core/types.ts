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
  fileName?: string;
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
}

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
  | 'invalid';

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
}
