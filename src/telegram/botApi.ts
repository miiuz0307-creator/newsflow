/**
 * Telegram Bot API client (official API, no extra dependencies).
 *
 * Covers what the product needs: identify the bot, receive updates (long
 * polling for now; webhooks later), learn which chats the bot was added to
 * and whether it may post, send text and media, and download media.
 *
 * Errors are mapped onto the same SendError kinds as WhatsApp so the
 * delivery engine treats both platforms alike. Telegram's 429 responses
 * include retry_after, which is passed through.
 */
import { SendError } from '../core/types.js';

export interface TgUser { id: number; is_bot: boolean; first_name: string; username?: string }
export interface TgChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string }
export interface TgPhotoSize { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }
export interface TgFileRef { file_id: string; file_unique_id: string; mime_type?: string; file_size?: number; file_name?: string }

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  sender_chat?: TgChat;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  video?: TgFileRef;
  audio?: TgFileRef;
  voice?: TgFileRef;
  document?: TgFileRef;
  sticker?: TgFileRef;
  forward_origin?: unknown;
  forward_date?: number;
  reply_to_message?: TgMessage;
  edit_date?: number;
}

export interface TgChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  user: TgUser;
  can_post_messages?: boolean;
  can_send_messages?: boolean;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  edited_message?: TgMessage;
  edited_channel_post?: TgMessage;
  my_chat_member?: { chat: TgChat; from: TgUser; date: number; old_chat_member: TgChatMember; new_chat_member: TgChatMember };
}

export interface BotApiOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Calls to the real api.telegram.org are refused unless this is true. */
  allowReal?: boolean;
  timeoutMs?: number;
}

const REAL_HOST = 'api.telegram.org';

/** Bot tokens look like 123456789:AA... — validated before anything is stored. */
export function isValidBotToken(token: string): boolean {
  return /^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(token);
}

export class TelegramBotApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly token: string, private readonly o: BotApiOptions = {}) {
    if (!isValidBotToken(token)) throw new Error('invalid bot token format');
    this.base = (o.apiBase ?? `https://${REAL_HOST}`).replace(/\/$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
    if (new URL(this.base).hostname === REAL_HOST && !o.allowReal) {
      throw new Error('Real Telegram calls are disabled (ALLOW_REAL_TELEGRAM is off). Owner approval required.');
    }
  }

  /** The numeric bot id is the part of the token before the colon. */
  get botId(): string {
    return this.token.split(':')[0]!;
  }

  async call<T>(method: string, params: Record<string, unknown> | FormData = {}, timeoutMs?: number): Promise<T> {
    const url = `${this.base}/bot${this.token}/${method}`;
    const isForm = typeof FormData !== 'undefined' && params instanceof FormData;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        ...(isForm ? { body: params } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
        signal: AbortSignal.timeout(timeoutMs ?? this.o.timeoutMs ?? 30_000),
      });
    } catch (err) {
      // A timeout means the request may have reached Telegram: the outcome is unknown, not failed.
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new SendError('unknown', `telegram ${method}: no answer in time`);
      throw new SendError('transient', `telegram ${method}: ${(err as Error).message}`);
    }
    let body: { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number; migrate_to_chat_id?: number } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new SendError(res.status >= 500 ? 'transient' : 'invalid', `telegram ${method}: HTTP ${res.status}`);
    }
    if (body.ok) return body.result as T;
    throw mapTelegramError(method, body.error_code ?? res.status, body.description ?? '', body.parameters);
  }

  getMe() {
    return this.call<TgUser>('getMe');
  }

  getUpdates(offset: number | undefined, timeoutSec = 25) {
    return this.call<TgUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message', 'channel_post', 'edited_message', 'edited_channel_post', 'my_chat_member'] },
      (timeoutSec + 10) * 1000,
    );
  }

  getChat(chatId: string | number) {
    return this.call<TgChat & { member_count?: number }>('getChat', { chat_id: chatId });
  }

  getChatMember(chatId: string | number, userId: string | number) {
    return this.call<TgChatMember>('getChatMember', { chat_id: chatId, user_id: Number(userId) });
  }

  getChatMemberCount(chatId: string | number) {
    return this.call<number>('getChatMemberCount', { chat_id: chatId });
  }

  sendMessage(chatId: string | number, text: string) {
    return this.call<TgMessage>('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: false } });
  }

  /** Sends photo/video/audio/document either by uploading bytes or by file_id/URL. */
  sendMedia(kind: 'photo' | 'video' | 'audio' | 'document', chatId: string | number, file: Buffer | string, opts: { caption?: string; mimeType?: string; fileName?: string } = {}) {
    const method = { photo: 'sendPhoto', video: 'sendVideo', audio: 'sendAudio', document: 'sendDocument' }[kind];
    if (typeof file === 'string') {
      return this.call<TgMessage>(method, { chat_id: chatId, [kind]: file, ...(opts.caption ? { caption: opts.caption } : {}) });
    }
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (opts.caption) form.set('caption', opts.caption);
    form.set(kind, new Blob([new Uint8Array(file)], { type: opts.mimeType ?? 'application/octet-stream' }), opts.fileName ?? `${kind}.bin`);
    return this.call<TgMessage>(method, form, 120_000);
  }

  /** Changes the text of a text message the bot sent. "Not modified" counts as done. */
  async editMessageText(chatId: string | number, messageId: string | number, text: string): Promise<void> {
    await this.notModifiedIsOk(() => this.call('editMessageText', { chat_id: chatId, message_id: Number(messageId), text }));
  }

  /** Changes the caption of a photo / video / audio / document the bot sent. */
  async editMessageCaption(chatId: string | number, messageId: string | number, caption: string): Promise<void> {
    await this.notModifiedIsOk(() => this.call('editMessageCaption', { chat_id: chatId, message_id: Number(messageId), caption }));
  }

  /** Deletes a message for everyone. Telegram allows this within 48 hours (any age for admins with delete rights). */
  async deleteMessage(chatId: string | number, messageId: string | number): Promise<void> {
    await this.call('deleteMessage', { chat_id: chatId, message_id: Number(messageId) });
  }

  private async notModifiedIsOk(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      if (e instanceof SendError && /message is not modified/i.test(e.message)) return;
      throw e;
    }
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const f = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!f.file_path) throw new SendError('not_found', 'file not available');
    const res = await this.fetchImpl(`${this.base}/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new SendError('transient', `download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

export function mapTelegramError(method: string, code: number, description: string, params?: { retry_after?: number }): SendError {
  const msg = `telegram ${method}: ${code} ${description}`;
  if (code === 429) return new SendError('rate_limited', msg, (params?.retry_after ?? 30) * 1000);
  if (code === 401) return new SendError('account_blocked', msg); // token revoked or wrong
  if (code === 403) return new SendError('forbidden', msg); // kicked, not admin in channel, blocked by user
  if (code === 400 && /chat not found|chat_id is empty|group chat was upgraded/i.test(description)) return new SendError('not_found', msg);
  if (code === 400 && /message to (edit|delete) not found|message_id_invalid/i.test(description)) return new SendError('not_found', msg);
  if (code === 400 && /message can't be (deleted|edited)/i.test(description)) return new SendError('window_closed', msg);
  if (code === 400 && /not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|need administrator/i.test(description)) return new SendError('forbidden', msg);
  if (code === 400) return new SendError('invalid', msg);
  if (code >= 500) return new SendError('transient', msg);
  return new SendError('invalid', msg);
}
