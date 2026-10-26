/**
 * Connecting Telegram like WhatsApp, without the customer touching BotFather.
 *
 *   1. the customer scans a QR code from their Telegram app (Settings → Devices →
 *      Link Desktop Device), or types their phone number and the code Telegram sends;
 *      and the 2-step password if the account has one
 *   2. we list the channels and supergroups where the customer may add admins
 *   3. for the ones they pick: we create a bot for them in @BotFather, add it as an
 *      admin with rights to post, edit and delete, and then LOG OUT of their account.
 *
 * The customer's own session lives only in memory for the few minutes of this flow and
 * is never stored. Messages are then sent by the bot, like a bot connected by token.
 *
 * TelegramUserClient is the small surface we need from a Telegram user client; GramJS
 * implements it in production, a fake implements it in tests.
 */
import { randomBytes } from 'node:crypto';

export interface AdminChat {
  /** Bot API id ("-100…"). */
  chatId: string;
  title: string;
  type: 'channel' | 'supergroup';
  /** The customer may add admins there (creator, or has the right). */
  canAddBot: boolean;
}

export interface TelegramUserClient {
  /**
   * QR login: calls onQr with a fresh tg://login link (about every 30 s) until the code is
   * scanned; resolves once signed in. askPassword is called when the account has 2-step
   * verification (again after a wrong one, with onPasswordError first).
   */
  startQr(onQr: (url: string) => void, askPassword: () => Promise<string>, onPasswordError: (message: string) => void): Promise<void>;
  sendCode(phone: string): Promise<void>;
  /** 'ok' when signed in; 'password' when the account has 2-step verification. */
  signIn(code: string): Promise<'ok' | 'password'>;
  checkPassword(password: string): Promise<void>;
  adminChats(): Promise<AdminChat[]>;
  /** Creates a bot in @BotFather; returns its token and @username. */
  createBot(name: string): Promise<{ token: string; username: string }>;
  addBotAsAdmin(chatId: string, botUsername: string): Promise<void>;
  logOut(): Promise<void>;
}

export class PhoneLinkError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

type Step = 'qr' | 'code' | 'password' | 'chats' | 'error';
type Pending = {
  client: TelegramUserClient; phone: string; step: Step; via: 'qr' | 'phone'; chats?: AdminChat[]; timer: NodeJS.Timeout;
  qr?: string; error?: string; passwordWaiter?: (pw: string) => void;
};
export type LinkStatus =
  | { step: 'none' }
  | { step: 'qr'; qr: string | null }
  | { step: 'code' }
  | { step: 'password'; error?: string }
  | { step: 'chats'; chats: AdminChat[] }
  | { step: 'error'; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TelegramPhoneLinker {
  private readonly pending = new Map<string, Pending>();
  private readonly starts = new Map<string, number[]>();

  constructor(private readonly o: { clientFactory: () => TelegramUserClient; ttlMs?: number; startsPerHour?: number }) {}

  private drop(tenantId: string, logOut: boolean) {
    const p = this.pending.get(tenantId);
    if (!p) return;
    this.pending.delete(tenantId);
    clearTimeout(p.timer);
    if (logOut) void p.client.logOut().catch(() => {});
  }

  private need(tenantId: string, step: Pending['step']): Pending {
    const p = this.pending.get(tenantId);
    if (!p) throw new PhoneLinkError('expired', 'החיבור פג. התחילו שוב עם מספר הטלפון.');
    if (p.step !== step) throw new PhoneLinkError('wrong_step', 'השלב הזה כבר עבר. רעננו את המסך והמשיכו.');
    return p;
  }

  status(tenantId: string): LinkStatus {
    const p = this.pending.get(tenantId);
    if (!p) return { step: 'none' };
    switch (p.step) {
      case 'qr': return { step: 'qr', qr: p.qr ?? null };
      case 'code': return { step: 'code' };
      case 'password': return { step: 'password', ...(p.error ? { error: p.error } : {}) };
      case 'chats': return { step: 'chats', chats: p.chats ?? [] };
      default: return { step: 'error', error: p.error ?? 'החיבור נכשל. נסו שוב.' };
    }
  }

  /** Step 1 (QR): a code to scan from the Telegram app; the page polls status() until it is scanned. */
  async startQr(tenantId: string): Promise<LinkStatus> {
    this.countStart(tenantId);
    this.drop(tenantId, true);
    const client = this.o.clientFactory();
    const timer = setTimeout(() => this.drop(tenantId, true), this.o.ttlMs ?? 10 * 60_000);
    timer.unref?.();
    const p: Pending = { client, phone: '', step: 'qr', via: 'qr', timer };
    this.pending.set(tenantId, p);
    void client.startQr(
      (url) => { p.qr = url; },
      () => new Promise<string>((resolve) => { p.step = 'password'; p.passwordWaiter = resolve; }),
      (message) => { p.error = message; },
    ).then(async () => {
      if (this.pending.get(tenantId) !== p) return;
      p.chats = await client.adminChats();
      p.step = 'chats';
    }).catch((e) => {
      if (this.pending.get(tenantId) !== p) return;
      p.step = 'error';
      p.error = e instanceof PhoneLinkError ? e.message : 'החיבור לטלגרם נכשל. נסו שוב.';
    });
    for (let i = 0; i < 60 && !p.qr && p.step === 'qr'; i++) await sleep(250);
    return this.status(tenantId);
  }

  private countStart(tenantId: string) {
    const now = Date.now();
    const recent = (this.starts.get(tenantId) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= (this.o.startsPerHour ?? 5)) throw new PhoneLinkError('too_many', 'יותר מדי ניסיונות בשעה האחרונה. נסו שוב מאוחר יותר.');
    this.starts.set(tenantId, [...recent, now]);
  }

  /** Step 1 (phone): Telegram sends a login code to the customer's Telegram app. */
  async start(tenantId: string, phone: string): Promise<{ step: 'code' }> {
    const digits = phone.replace(/[^\d+]/g, '');
    if (!/^\+?\d{8,15}$/.test(digits)) throw new PhoneLinkError('bad_phone', 'מספר הטלפון לא תקין. כתבו אותו כמו 050-1234567 או ‎+972501234567');
    this.countStart(tenantId);
    this.drop(tenantId, true);
    const intl = digits.startsWith('+') ? digits : /^0\d{8,9}$/.test(digits) ? `+972${digits.slice(1)}` : `+${digits}`;
    const client = this.o.clientFactory();
    try {
      await client.sendCode(intl);
    } catch (e) {
      void client.logOut().catch(() => {});
      throw e instanceof PhoneLinkError ? e : new PhoneLinkError('send_code_failed', 'טלגרם לא שלח קוד למספר הזה. בדקו שזה המספר של חשבון הטלגרם.');
    }
    const timer = setTimeout(() => this.drop(tenantId, true), this.o.ttlMs ?? 10 * 60_000);
    timer.unref?.();
    this.pending.set(tenantId, { client, phone: intl, step: 'code', via: 'phone', timer });
    return { step: 'code' };
  }

  /** Step 2: the code from Telegram (then the 2-step password, if the account has one). */
  async code(tenantId: string, code: string): Promise<{ step: 'password' } | { step: 'chats'; chats: AdminChat[] }> {
    const p = this.need(tenantId, 'code');
    const r = await p.client.signIn(code.replace(/\D/g, ''));
    if (r === 'password') {
      p.step = 'password';
      return { step: 'password' };
    }
    return this.toChats(p);
  }

  async password(tenantId: string, password: string): Promise<LinkStatus> {
    const p = this.need(tenantId, 'password');
    if (p.via === 'phone') {
      await p.client.checkPassword(password);
      return this.toChats(p);
    }
    // QR: hand the password to the waiting login, then wait for its outcome.
    p.error = undefined;
    const give = p.passwordWaiter;
    p.passwordWaiter = undefined;
    give?.(password);
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      if (p.step !== 'password' || p.error || p.passwordWaiter) break;
    }
    if (p.error && p.step === 'password') throw new PhoneLinkError('bad_password', p.error);
    return this.status(tenantId);
  }

  private async toChats(p: Pending): Promise<{ step: 'chats'; chats: AdminChat[] }> {
    p.chats = await p.client.adminChats();
    p.step = 'chats';
    return { step: 'chats', chats: p.chats };
  }

  /**
   * Step 3: creates the bot, adds it to the chosen chats, logs out of the customer's
   * account (always, also on failure), and hands back the token for the caller to
   * connect like any bot.
   */
  async finish(tenantId: string, chatIds: string[], botName: string): Promise<{ token: string; username: string; added: AdminChat[]; failed: { chat: AdminChat; error: string }[] }> {
    const p = this.need(tenantId, 'chats');
    const chosen = (p.chats ?? []).filter((c) => chatIds.includes(c.chatId) && c.canAddBot);
    if (!chosen.length) throw new PhoneLinkError('no_chats', 'בחרו לפחות ערוץ אחד שאתם מנהלים בו.');
    try {
      const bot = await p.client.createBot(botName);
      const added: AdminChat[] = [];
      const failed: { chat: AdminChat; error: string }[] = [];
      for (const c of chosen) {
        try {
          await p.client.addBotAsAdmin(c.chatId, bot.username);
          added.push(c);
        } catch (e) {
          failed.push({ chat: c, error: String((e as Error)?.message ?? e).slice(0, 120) });
        }
      }
      return { ...bot, added, failed };
    } finally {
      this.drop(tenantId, true);
    }
  }

  cancel(tenantId: string): void {
    this.drop(tenantId, true);
  }
}

/** A bot @username nobody has: push_<8 random letters/digits>_bot. */
export function randomBotUsername(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (const b of randomBytes(8)) s += a[b % a.length];
  return `push_${s}_bot`;
}

/** The token in a @BotFather reply. */
export function tokenInReply(text: string): string | null {
  return /(\d{6,12}:[A-Za-z0-9_-]{30,50})/.exec(text)?.[1] ?? null;
}
