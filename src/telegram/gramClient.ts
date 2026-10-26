/**
 * TelegramUserClient on GramJS (the "telegram" package): log in with a phone number,
 * list the chats the customer manages, create a bot in @BotFather, add it as an admin,
 * log out. Needs the app's api_id / api_hash from my.telegram.org.
 */
import { Api, TelegramClient } from 'telegram';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { computeCheck } from 'telegram/Password.js';
import { StringSession } from 'telegram/sessions/index.js';
import { PhoneLinkError, randomBotUsername, tokenInReply, type AdminChat, type TelegramUserClient } from './phoneLink.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Telegram error names → what the customer should do (Hebrew). */
function explain(e: unknown): PhoneLinkError {
  const m = String((e as { errorMessage?: string })?.errorMessage ?? (e as Error)?.message ?? e);
  if (/PHONE_NUMBER_INVALID/.test(m)) return new PhoneLinkError('bad_phone', 'טלגרם לא מכיר את המספר הזה. בדקו שזה המספר של חשבון הטלגרם.');
  if (/PHONE_NUMBER_BANNED/.test(m)) return new PhoneLinkError('banned', 'טלגרם חסם את המספר הזה.');
  if (/PHONE_CODE_INVALID/.test(m)) return new PhoneLinkError('bad_code', 'הקוד שגוי. בדקו את ההודעה מטלגרם ונסו שוב.');
  if (/PHONE_CODE_EXPIRED/.test(m)) return new PhoneLinkError('code_expired', 'הקוד פג. התחילו שוב עם מספר הטלפון.');
  if (/PASSWORD_HASH_INVALID/.test(m)) return new PhoneLinkError('bad_password', 'הסיסמה שגויה (סיסמת האימות הדו-שלבי של טלגרם).');
  if (/FLOOD_WAIT_(\d+)/.test(m)) return new PhoneLinkError('flood', `טלגרם ביקש להמתין ${Math.ceil(Number(/FLOOD_WAIT_(\d+)/.exec(m)![1]) / 60)} דקות לפני ניסיון נוסף.`);
  if (/CHAT_ADMIN_REQUIRED|RIGHT_FORBIDDEN|ADMINS_TOO_MUCH/.test(m)) return new PhoneLinkError('no_rights', 'אין לכם הרשאה להוסיף מנהלים בערוץ הזה, או שיש בו יותר מדי מנהלים.');
  return e instanceof PhoneLinkError ? e : new PhoneLinkError('telegram_error', 'טלגרם החזיר שגיאה. נסו שוב בעוד רגע.');
}

export class GramUserClient implements TelegramUserClient {
  private readonly client: TelegramClient;
  private phone = '';
  private phoneCodeHash = '';
  private entities = new Map<string, Api.Channel>();

  constructor(private readonly apiId: number, private readonly apiHash: string) {
    this.client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 3,
      baseLogger: new Logger(LogLevel.NONE),
      deviceModel: 'PUSH',
      appVersion: '1.0',
    });
  }

  async startQr(onQr: (url: string) => void, askPassword: () => Promise<string>, onPasswordError: (message: string) => void): Promise<void> {
    try {
      await this.client.connect();
      await this.client.signInUserWithQrCode({ apiId: this.apiId, apiHash: this.apiHash }, {
        qrCode: async ({ token }) => { onQr(`tg://login?token=${Buffer.from(token).toString('base64url')}`); },
        password: async () => askPassword(),
        onError: async (err: Error) => {
          const m = String((err as { errorMessage?: string }).errorMessage ?? err.message);
          if (/PASSWORD_HASH_INVALID/.test(m)) { onPasswordError('הסיסמה שגויה (סיסמת האימות הדו-שלבי של טלגרם).'); return false; }
          return true; // anything else ends the login
        },
      });
    } catch (e) {
      throw explain(e);
    }
  }

  async sendCode(phone: string): Promise<void> {
    try {
      await this.client.connect();
      this.phone = phone;
      const r = await this.client.sendCode({ apiId: this.apiId, apiHash: this.apiHash }, phone);
      this.phoneCodeHash = r.phoneCodeHash;
    } catch (e) {
      throw explain(e);
    }
  }

  async signIn(code: string): Promise<'ok' | 'password'> {
    try {
      const r = await this.client.invoke(new Api.auth.SignIn({ phoneNumber: this.phone, phoneCodeHash: this.phoneCodeHash, phoneCode: code }));
      if (r instanceof Api.auth.AuthorizationSignUpRequired) throw new PhoneLinkError('no_account', 'אין חשבון טלגרם במספר הזה.');
      return 'ok';
    } catch (e) {
      if (/SESSION_PASSWORD_NEEDED/.test(String((e as { errorMessage?: string })?.errorMessage ?? e))) return 'password';
      throw explain(e);
    }
  }

  async checkPassword(password: string): Promise<void> {
    try {
      const pw = await this.client.invoke(new Api.account.GetPassword());
      await this.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pw, password) }));
    } catch (e) {
      throw explain(e);
    }
  }

  async adminChats(): Promise<AdminChat[]> {
    try {
      const out: AdminChat[] = [];
      for (const d of await this.client.getDialogs({ limit: 500 })) {
        const e = d.entity;
        if (!(e instanceof Api.Channel) || e.left) continue;
        const isAdmin = !!e.creator || !!e.adminRights;
        if (!isAdmin) continue;
        const chatId = `-100${e.id.toString()}`;
        this.entities.set(chatId, e);
        out.push({ chatId, title: e.title, type: e.broadcast ? 'channel' : 'supergroup', canAddBot: !!e.creator || !!e.adminRights?.addAdmins });
      }
      return out.sort((a, b) => a.title.localeCompare(b.title, 'he'));
    } catch (e) {
      throw explain(e);
    }
  }

  /** A short conversation with @BotFather: /newbot → name → username (retried if taken) → token. */
  async createBot(name: string): Promise<{ token: string; username: string }> {
    try {
      const bf = await this.client.getInputEntity('BotFather');
      const say = async (text: string): Promise<string> => {
        const sent = await this.client.sendMessage(bf, { message: text });
        for (let i = 0; i < 30; i++) {
          await sleep(500);
          const [m] = await this.client.getMessages(bf, { limit: 1 });
          if (m && m.id > sent.id && !m.out) return m.message ?? '';
        }
        throw new PhoneLinkError('botfather_silent', 'BotFather לא ענה. נסו שוב בעוד דקה.');
      };
      await say('/cancel').catch(() => '');
      const first = await say('/newbot');
      if (/20 bots|too many/i.test(first)) throw new PhoneLinkError('too_many_bots', 'בחשבון הטלגרם הזה כבר יש 20 בוטים, המקסימום של טלגרם. מחקו בוט ישן ב‑BotFather ונסו שוב.');
      await say(name.slice(0, 60) || 'PUSH');
      for (let i = 0; i < 4; i++) {
        const username = randomBotUsername();
        const reply = await say(username);
        const token = tokenInReply(reply);
        if (token) return { token, username };
      }
      throw new PhoneLinkError('botfather_failed', 'לא הצלחנו ליצור בוט ב‑BotFather. נסו שוב בעוד דקה.');
    } catch (e) {
      throw explain(e);
    }
  }

  async addBotAsAdmin(chatId: string, botUsername: string): Promise<void> {
    const channel = this.entities.get(chatId);
    if (!channel) throw new PhoneLinkError('unknown_chat', 'הערוץ לא נמצא ברשימה.');
    try {
      const bot = await this.client.getInputEntity(botUsername);
      const rights = channel.broadcast
        ? new Api.ChatAdminRights({ postMessages: true, editMessages: true, deleteMessages: true })
        : new Api.ChatAdminRights({ deleteMessages: true, pinMessages: false, other: true });
      await this.client.invoke(new Api.channels.EditAdmin({ channel, userId: bot, adminRights: rights, rank: 'PUSH' }));
    } catch (e) {
      throw explain(e);
    }
  }

  async logOut(): Promise<void> {
    try {
      if (this.client.connected) await this.client.invoke(new Api.auth.LogOut());
    } catch { /* not signed in yet */ }
    await this.client.disconnect().catch(() => {});
    await this.client.destroy().catch(() => {});
  }
}
