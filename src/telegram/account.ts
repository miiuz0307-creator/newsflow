/**
 * One connected Telegram bot: receives updates (long polling), keeps track of
 * the chats it was added to and whether it may post there, and sends.
 *
 * It implements ChannelSender, so the dispatcher sends to Telegram exactly as
 * it sends to WhatsApp, and emits InboundMessage, so Telegram groups and
 * channels can be route sources too (Telegram → WhatsApp).
 */
import type { ChannelSender, ChatInfo, InboundMessage, MessageContent, MessageKind, SendResult } from '../core/types.js';
import { SendError } from '../core/types.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { TelegramBotApi, TgChat, TgChatMember, TgMessage, TgUpdate } from './botApi.js';

export interface TelegramAccountOptions {
  tenantId: string;
  /** Our id for this bot (database row id). */
  accountId: string;
  api: TelegramBotApi;
  logger?: Logger;
  onMessage?: (m: InboundMessage) => void;
  onChatsChanged?: (chats: ChatInfo[]) => void;
  /** Persist the polling offset so restarts don't re-read old updates. */
  loadOffset?: () => Promise<number | undefined>;
  saveOffset?: (offset: number) => Promise<void>;
  pollTimeoutSec?: number;
}

function chatType(t: TgChat['type']): ChatInfo['type'] {
  return t === 'channel' ? 'channel' : t === 'private' ? 'private' : 'group';
}

function canPost(chat: TgChat, m: TgChatMember): boolean {
  if (m.status === 'left' || m.status === 'kicked') return false;
  if (chat.type === 'channel') return m.status === 'creator' || (m.status === 'administrator' && m.can_post_messages !== false);
  if (m.status === 'restricted') return m.can_send_messages === true;
  return true;
}

/** Converts a Telegram message to our content shape. Media bytes are fetched lazily. */
export function parseTgMessage(api: Pick<TelegramBotApi, 'downloadFile'>, m: TgMessage): MessageContent | null {
  const media = (kind: MessageKind, f: { file_id: string; mime_type?: string; file_size?: number; file_name?: string }, mime: string): MessageContent => ({
    kind,
    ...(m.caption ? { text: m.caption } : {}),
    media: { mimeType: f.mime_type ?? mime, ...(f.file_size ? { size: f.file_size } : {}), ...(f.file_name ? { fileName: f.file_name } : {}), load: () => api.downloadFile(f.file_id) },
  });
  if (typeof m.text === 'string') return { kind: 'text', text: m.text };
  if (m.photo?.length) {
    const largest = m.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    return media('image', largest, 'image/jpeg');
  }
  if (m.video) return media('video', m.video, 'video/mp4');
  if (m.audio) return media('audio', m.audio, 'audio/mpeg');
  if (m.voice) return media('audio', m.voice, 'audio/ogg');
  if (m.document) return media('document', m.document, 'application/octet-stream');
  return null;
}

export class TelegramAccount implements ChannelSender {
  readonly platform = 'tg' as const;
  private readonly chats = new Map<string, ChatInfo>();
  private offset: number | undefined;
  private running = false;
  private loop?: Promise<void>;
  private readonly log: Logger;
  private botUserId: number | undefined;

  constructor(private readonly o: TelegramAccountOptions) {
    this.log = (o.logger ?? silentLogger).child({ component: 'telegram', accountId: o.accountId });
  }

  get accountId(): string {
    return this.o.accountId;
  }

  /** Verifies the token and loads the bot identity. */
  async verify(): Promise<{ username?: string; id: number }> {
    const me = await this.o.api.getMe();
    if (!me.is_bot) throw new Error('token does not belong to a bot');
    this.botUserId = me.id;
    return { id: me.id, username: me.username };
  }

  listChats(): ChatInfo[] {
    return [...this.chats.values()];
  }

  /** Adds a chat the customer says the bot is in (e.g. a channel id), checking the bot's rights. */
  async addChat(chatId: string): Promise<ChatInfo> {
    if (this.botUserId === undefined) await this.verify();
    const chat = await this.o.api.getChat(chatId);
    const member = await this.o.api.getChatMember(chatId, this.botUserId!);
    return this.rememberChat(chat, member, chat.member_count);
  }

  async send(chatId: string, content: MessageContent): Promise<SendResult> {
    const m = content.media;
    let res: TgMessage;
    if (content.kind === 'text') {
      if (!content.text?.trim()) throw new SendError('invalid', 'empty text');
      res = await this.o.api.sendMessage(chatId, content.text);
    } else {
      const file = m?.data ?? m?.url;
      if (!file) throw new SendError('invalid', 'media missing');
      const kind = content.kind === 'image' ? 'photo' : content.kind === 'video' ? 'video' : content.kind === 'audio' ? 'audio' : 'document';
      res = await this.o.api.sendMedia(kind, chatId, file, { caption: content.text, mimeType: m?.mimeType, fileName: m?.fileName });
    }
    return { messageId: String(res.message_id), sentAt: new Date(res.date * 1000) };
  }

  /** Processes one batch of updates. Exposed for webhook use and tests. */
  async handleUpdates(updates: TgUpdate[]): Promise<void> {
    for (const u of updates) {
      this.offset = Math.max(this.offset ?? 0, u.update_id + 1);
      if (u.my_chat_member) {
        // Report the chat that changed — including one the bot was removed from (canSend false),
        // so stored permissions don't go stale.
        const info = this.rememberChat(u.my_chat_member.chat, u.my_chat_member.new_chat_member);
        this.o.onChatsChanged?.([info]);
        continue;
      }
      const m = u.message ?? u.channel_post;
      if (!m) continue;
      const content = parseTgMessage(this.o.api, m);
      if (!content) continue;
      if (!this.chats.has(String(m.chat.id)) && m.chat.type !== 'private') {
        // A message proves membership; rights are checked lazily when needed.
        this.chats.set(String(m.chat.id), {
          ref: { platform: 'tg', accountId: this.o.accountId, chatId: String(m.chat.id) },
          title: m.chat.title ?? '', type: chatType(m.chat.type), canSend: m.chat.type !== 'channel', isAdmin: false,
        });
      }
      const inbound: InboundMessage = {
        tenantId: this.o.tenantId,
        source: { platform: 'tg', accountId: this.o.accountId, chatId: String(m.chat.id) },
        messageId: String(m.message_id),
        senderId: String(m.from?.id ?? m.sender_chat?.id ?? ''),
        fromSelf: this.botUserId !== undefined && m.from?.id === this.botUserId,
        isForwarded: !!(m.forward_origin || m.forward_date),
        receivedAt: new Date(m.date * 1000),
        content,
      };
      try {
        this.o.onMessage?.(inbound);
      } catch (err) {
        this.log.error('onMessage failed', { err: String(err) });
      }
    }
    if (this.offset !== undefined) await this.o.saveOffset?.(this.offset);
  }

  /** One long-poll round. */
  async pollOnce(timeoutSec = this.o.pollTimeoutSec ?? 25): Promise<number> {
    const updates = await this.o.api.getUpdates(this.offset, timeoutSec);
    await this.handleUpdates(updates);
    return updates.length;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.verify();
    this.offset = (await this.o.loadOffset?.()) ?? this.offset;
    this.running = true;
    this.loop = (async () => {
      let backoff = 1_000;
      while (this.running) {
        try {
          await this.pollOnce();
          backoff = 1_000;
        } catch (err) {
          const e = err as SendError;
          if (e.kind === 'account_blocked') {
            this.log.error('bot token rejected, stopping');
            this.running = false;
            break;
          }
          const wait = e.kind === 'rate_limited' ? (e.retryAfterMs ?? 30_000) : backoff;
          this.log.warn('poll failed', { kind: e.kind, waitMs: wait });
          await new Promise((r) => setTimeout(r, wait));
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => {});
  }

  private rememberChat(chat: TgChat, member: TgChatMember, count?: number): ChatInfo {
    const key = String(chat.id);
    if (member.status === 'left' || member.status === 'kicked') {
      this.chats.delete(key);
      return { ref: { platform: 'tg', accountId: this.o.accountId, chatId: key }, title: chat.title ?? '', type: chatType(chat.type), canSend: false, isAdmin: false };
    }
    const info: ChatInfo = {
      ref: { platform: 'tg', accountId: this.o.accountId, chatId: key },
      title: chat.title ?? chat.username ?? '',
      type: chatType(chat.type),
      ...(count !== undefined ? { participantCount: count } : {}),
      canSend: canPost(chat, member),
      isAdmin: member.status === 'administrator' || member.status === 'creator',
    };
    this.chats.set(key, info);
    return info;
  }
}
