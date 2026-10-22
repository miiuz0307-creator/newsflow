/**
 * A local HTTP server that imitates the parts of the Telegram Bot API the
 * product uses. Tests and the simulator point TelegramBotApi at it, so the
 * real Telegram is never contacted.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TgChat, TgChatMember, TgMessage, TgUpdate } from './botApi.js';

interface FakeChat {
  chat: TgChat;
  members: Map<number, TgChatMember>;
  posts: TgMessage[];
  rate?: { max: number; windowMs: number; times: number[] };
}

export class FakeTelegramServer {
  private server?: http.Server;
  private readonly chats = new Map<number, FakeChat>();
  private readonly updates: TgUpdate[] = [];
  private readonly files = new Map<string, Buffer>();
  private updateSeq = 1000;
  private msgSeq = 1;
  private revoked = new Set<string>();
  /** Delay before every answer (simulates a slow or stuck Telegram). */
  responseDelayMs = 0;
  readonly botId: number;
  readonly token: string;
  url = '';

  constructor(public readonly botUsername = 'news_test_bot') {
    this.botId = 7_000_000_000 + Math.floor(Math.random() * 1_000_000);
    this.token = `${this.botId}:${randomBytes(24).toString('base64url').slice(0, 35)}`;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  // ---------- world setup ----------

  createChat(title: string, type: TgChat['type'] = 'supergroup'): number {
    const id = -100_0000_000_000 - this.chats.size - 1;
    this.chats.set(id, { chat: { id, type, title }, members: new Map(), posts: [] });
    return id;
  }

  /** The customer adds the bot to a chat; Telegram notifies the bot. */
  addBot(chatId: number, status: TgChatMember['status'] = 'member', rights: Partial<TgChatMember> = {}) {
    const c = this.mustChat(chatId);
    const bot = { id: this.botId, is_bot: true, first_name: 'Bot', username: this.botUsername };
    const old = c.members.get(this.botId) ?? { status: 'left' as const, user: bot };
    const now: TgChatMember = { status, user: bot, ...rights };
    c.members.set(this.botId, now);
    this.push({ my_chat_member: { chat: c.chat, from: { id: 1, is_bot: false, first_name: 'Admin' }, date: this.ts(), old_chat_member: old, new_chat_member: now } });
  }

  removeBot(chatId: number) {
    this.addBot(chatId, 'kicked');
  }

  /** Someone posts in a chat; the bot receives it if it's a member. */
  userPost(chatId: number, content: { text?: string; photo?: Buffer; caption?: string; replyTo?: number }): number {
    const c = this.mustChat(chatId);
    const m: TgMessage = { message_id: this.msgSeq++, date: this.ts(), chat: c.chat, from: { id: 42, is_bot: false, first_name: 'Editor' } };
    if (content.replyTo !== undefined) {
      const orig = c.posts.find((p) => p.message_id === content.replyTo);
      if (orig) m.reply_to_message = orig;
    }
    if (content.text) m.text = content.text;
    if (content.photo) {
      const fid = `F${randomBytes(6).toString('hex')}`;
      this.files.set(fid, content.photo);
      m.photo = [{ file_id: fid, file_unique_id: fid, width: 800, height: 600, file_size: content.photo.length }];
      if (content.caption) m.caption = content.caption;
    }
    c.posts.push(m);
    if (this.botIn(c)) this.push(c.chat.type === 'channel' ? { channel_post: m } : { message: m });
    return m.message_id;
  }

  /** The editor edits their own post; the bot receives edited_message. */
  userEdit(chatId: number, messageId: number, text: string): void {
    const c = this.mustChat(chatId);
    const m = c.posts.find((p) => p.message_id === messageId);
    if (!m) throw new Error(`no message ${messageId}`);
    if (m.photo || m.video || m.document || m.audio) m.caption = text;
    else m.text = text;
    m.edit_date = this.ts();
    if (this.botIn(c)) this.push(c.chat.type === 'channel' ? { edited_channel_post: { ...m } } : { edited_message: { ...m } });
  }

  /** Makes a message look older (to test Telegram's 48-hour delete limit). */
  ageMessage(chatId: number, messageId: number, seconds: number): void {
    const m = this.mustChat(chatId).posts.find((p) => p.message_id === messageId);
    if (m) m.date -= seconds;
  }

  setRateLimit(chatId: number, max: number, windowMs: number) {
    this.mustChat(chatId).rate = { max, windowMs, times: [] };
  }

  revokeToken() {
    this.revoked.add(this.token);
  }

  /** Messages currently visible in the chat (deleted ones are gone, as in Telegram). */
  posts(chatId: number): TgMessage[] {
    return this.mustChat(chatId).posts;
  }

  // ---------- HTTP ----------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', this.url);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const fileMatch = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname);
    if (fileMatch) {
      const b = this.files.get(fileMatch[2]!);
      if (!b) return send(404, { ok: false });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(b);
    }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!m) return send(404, { ok: false, error_code: 404, description: 'Not Found' });
    const [, token, method] = m;
    if (token !== this.token || this.revoked.has(token)) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });

    let params: Record<string, unknown> = {};
    const files: Record<string, Buffer> = {};
    const ctype = req.headers['content-type'] ?? '';
    if (ctype.includes('application/json') && raw.length) params = JSON.parse(raw.toString());
    else if (ctype.includes('multipart/form-data')) {
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': ctype }, body: raw }).formData();
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') params[k] = v;
        else files[k] = Buffer.from(await (v as Blob).arrayBuffer());
      }
    }
    if (this.responseDelayMs) await new Promise((r) => setTimeout(r, this.responseDelayMs));
    try {
      send(200, { ok: true, result: await this.dispatch(method!, params, files) });
    } catch (e) {
      const err = e as { code: number; description: string; retry_after?: number };
      send(err.code ?? 500, { ok: false, error_code: err.code ?? 500, description: err.description ?? String(e), ...(err.retry_after ? { parameters: { retry_after: err.retry_after } } : {}) });
    }
  }

  private async dispatch(method: string, p: Record<string, unknown>, files: Record<string, Buffer>): Promise<unknown> {
    switch (method) {
      case 'getMe':
        return { id: this.botId, is_bot: true, first_name: 'Bot', username: this.botUsername };
      case 'getUpdates': {
        const offset = Number(p.offset ?? 0);
        const wait = Math.min(Number(p.timeout ?? 0) * 1000, 50);
        const ready = () => this.updates.filter((u) => u.update_id >= offset);
        if (!ready().length && wait) await new Promise((r) => setTimeout(r, wait));
        return ready();
      }
      case 'getChat': {
        const c = this.chatFor(p.chat_id);
        return { ...c.chat, member_count: c.members.size };
      }
      case 'getChatMember': {
        const c = this.chatFor(p.chat_id);
        const mem = c.members.get(Number(p.user_id));
        if (!mem) throw { code: 400, description: 'Bad Request: user not found' };
        return mem;
      }
      case 'getChatMemberCount':
        return this.chatFor(p.chat_id).members.size;
      case 'getFile': {
        const id = String(p.file_id);
        if (!this.files.has(id)) throw { code: 400, description: 'Bad Request: invalid file_id' };
        return { file_id: id, file_path: id, file_size: this.files.get(id)!.length };
      }
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendVideo':
      case 'sendAudio':
      case 'sendDocument': {
        const c = this.chatFor(p.chat_id);
        if (!this.botIn(c)) throw { code: 403, description: 'Forbidden: bot is not a member of the chat' };
        const me = c.members.get(this.botId)!;
        if (c.chat.type === 'channel' && !(me.status === 'creator' || (me.status === 'administrator' && me.can_post_messages !== false))) {
          throw { code: 400, description: 'Bad Request: need administrator rights in the channel chat' };
        }
        if (c.rate) {
          const t = Date.now();
          c.rate.times = c.rate.times.filter((x) => t - x < c.rate!.windowMs);
          if (c.rate.times.length >= c.rate.max) throw { code: 429, description: 'Too Many Requests: retry after 7', retry_after: 7 };
          c.rate.times.push(t);
        }
        if (method === 'sendMessage' && !String(p.text ?? '').trim()) throw { code: 400, description: 'Bad Request: message text is empty' };
        const msg: TgMessage = { message_id: this.msgSeq++, date: this.ts(), chat: c.chat, from: { id: this.botId, is_bot: true, first_name: 'Bot' } };
        if (method === 'sendMessage') msg.text = String(p.text);
        else {
          const field = method.slice(4).toLowerCase();
          const data = files[field] ?? (typeof p[field] === 'string' ? Buffer.from(String(p[field])) : undefined);
          if (!data) throw { code: 400, description: 'Bad Request: there is no file in the request' };
          const fid = `F${randomBytes(6).toString('hex')}`;
          this.files.set(fid, data);
          if (field === 'photo') msg.photo = [{ file_id: fid, file_unique_id: fid, width: 1, height: 1, file_size: data.length }];
          else (msg as unknown as Record<string, unknown>)[field] = { file_id: fid, file_unique_id: fid, file_size: data.length };
          if (p.caption) msg.caption = String(p.caption);
        }
        c.posts.push(msg);
        return msg;
      }
      case 'editMessageText':
      case 'editMessageCaption': {
        const c = this.chatFor(p.chat_id);
        const msg = c.posts.find((x) => x.message_id === Number(p.message_id));
        if (!msg) throw { code: 400, description: 'Bad Request: message to edit not found' };
        if (msg.from?.id !== this.botId) throw { code: 400, description: "Bad Request: message can't be edited" };
        const field = method === 'editMessageText' ? 'text' : 'caption';
        if (method === 'editMessageText' && msg.text === undefined) throw { code: 400, description: 'Bad Request: there is no text in the message to edit' };
        const value = String(p[field] ?? '');
        if (msg[field] === value) throw { code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' };
        msg[field] = value;
        msg.edit_date = this.ts();
        return msg;
      }
      case 'deleteMessage': {
        const c = this.chatFor(p.chat_id);
        const i = c.posts.findIndex((x) => x.message_id === Number(p.message_id));
        if (i < 0) throw { code: 400, description: 'Bad Request: message to delete not found' };
        const msg = c.posts[i]!;
        const me = c.members.get(this.botId);
        const isAdmin = me?.status === 'administrator' || me?.status === 'creator';
        if (msg.from?.id !== this.botId && !isAdmin) throw { code: 400, description: "Bad Request: message can't be deleted" };
        // The Bot API documents the 48-hour limit first; we apply it to everyone (conservative).
        if (this.ts() - msg.date > 48 * 3600) throw { code: 400, description: "Bad Request: message can't be deleted for everyone" };
        c.posts.splice(i, 1);
        return true;
      }
      default:
        throw { code: 404, description: `Not Found: method ${method}` };
    }
  }

  private botIn(c: FakeChat): boolean {
    const s = c.members.get(this.botId)?.status;
    return !!s && s !== 'left' && s !== 'kicked';
  }

  private chatFor(id: unknown): FakeChat {
    const c = this.chats.get(Number(id));
    if (!c) throw { code: 400, description: 'Bad Request: chat not found' };
    return c;
  }

  private mustChat(id: number): FakeChat {
    const c = this.chats.get(id);
    if (!c) throw new Error(`unknown chat ${id}`);
    return c;
  }

  private push(u: Omit<TgUpdate, 'update_id'>) {
    this.updates.push({ update_id: this.updateSeq++, ...u });
  }

  private ts() {
    return Math.floor(Date.now() / 1000);
  }
}
