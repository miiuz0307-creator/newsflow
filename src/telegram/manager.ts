/**
 * "Create a Telegram bot in one tap" (Telegram managed bots, Bot API 9.6).
 *
 * PUSH has one manager bot (Bot Management Mode on in @BotFather). The app gives the
 * customer a link: https://t.me/newbot/<manager>/<username>?name=<business name>. Telegram
 * opens a ready creation screen, the customer confirms, and the bot exists: the customer
 * owns it, our manager bot controls it. Telegram then tells the manager bot (a `managed_bot`
 * update); we fetch the new bot's token (getManagedBotToken) and connect it to the customer
 * whose request carries that username, exactly like a bot connected by token.
 *
 * No API keys, no BotFather, no login to the customer's Telegram account.
 */
import { randomBytes } from 'node:crypto';
import type { Sql } from '../db/pg.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import { TelegramBotApi, type BotApiOptions, type TgUser } from './botApi.js';

export interface ManagedBotUpdate { user: TgUser; bot: TgUser }

export interface BotRequest { tenantId: string; userId: string; username: string; name: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A bot username for a customer: latin letters from the business name when there are some, else random. */
export function suggestBotUsername(businessName: string): string {
  const latin = businessName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16);
  const tail = randomBytes(4).toString('hex').slice(0, 5);
  const base = latin && /^[a-z]/.test(latin) ? `${latin}_${tail}` : `push_${tail}${randomBytes(2).toString('hex').slice(0, 3)}`;
  return `${base.replace(/_+/g, '_')}_bot`.slice(0, 32);
}

/** Links that add a bot as an admin with the rights PUSH needs (Telegram bot deep links). */
export function addToChannelLink(botUsername: string): string {
  return `https://t.me/${botUsername}?startchannel&admin=post_messages+edit_messages+delete_messages`;
}
export function addToGroupLink(botUsername: string): string {
  return `https://t.me/${botUsername}?startgroup&admin=delete_messages+pin_messages`;
}

export class TelegramBotManager {
  private readonly api: TelegramBotApi;
  private readonly log: Logger;
  private running = false;
  private loop?: Promise<void>;
  private me?: TgUser & { can_manage_bots?: boolean };
  /** Set by the API module: connects a new bot's token to the customer who asked for it. */
  onCreated?: (req: BotRequest, token: string, bot: TgUser) => Promise<{ id: string }>;

  constructor(private readonly o: { token: string; apiOptions: BotApiOptions; workerSql: Sql; logger?: Logger; pollTimeoutSec?: number }) {
    this.api = new TelegramBotApi(o.token, o.apiOptions);
    this.log = (o.logger ?? silentLogger).child({ component: 'telegram-manager' });
  }

  /** The manager bot's @username (for links), once started. */
  get username(): string | undefined { return this.me?.username; }
  get ready(): boolean { return !!this.me?.username && this.me.can_manage_bots !== false; }

  /** The link that opens Telegram's ready "create bot" screen for this customer. */
  createLink(username: string, name: string): string {
    return `https://t.me/newbot/${this.me?.username ?? ''}/${username}?name=${encodeURIComponent(name)}`;
  }

  /** Reads who the manager bot is (needed for links). start() calls it. */
  async init(): Promise<void> {
    this.me = await this.api.getMe() as TgUser & { can_manage_bots?: boolean };
    if (this.me.can_manage_bots === false) this.log.warn('manager bot: Bot Management Mode is off in @BotFather', { username: this.me.username });
  }

  async start(): Promise<void> {
    await this.init();
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          const n = await this.pollOnce();
          if (!n && (this.o.pollTimeoutSec ?? 25) < 1) await sleep(200);
        } catch (e) {
          this.log.warn('manager poll failed', { err: String(e) });
          await sleep(3000);
        }
      }
    })();
    this.log.info('manager bot started', { username: this.me.username, canManage: this.me.can_manage_bots ?? null });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => {});
  }

  /** One round of updates; exposed for tests. */
  async pollOnce(timeoutSec = this.o.pollTimeoutSec ?? 25): Promise<number> {
    const sql = this.o.workerSql;
    const off = await sql.query<{ value: string }>(`SELECT value FROM system_meta WHERE key = 'tg_manager_offset'`);
    const offset = off.rows[0] ? Number(off.rows[0].value) : undefined;
    const updates = await this.api.call<{ update_id: number; managed_bot?: ManagedBotUpdate }[]>(
      'getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['managed_bot'] }, (timeoutSec + 10) * 1000);
    for (const u of updates) {
      if (u.managed_bot) await this.handle(u.managed_bot).catch((e) => this.log.error('managed bot failed', { err: String(e) }));
      await sql.query(
        `INSERT INTO system_meta (key, value, updated_at) VALUES ('tg_manager_offset', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [String(u.update_id + 1)]);
    }
    return updates.length;
  }

  private async handle(m: ManagedBotUpdate): Promise<void> {
    const sql = this.o.workerSql;
    const username = String(m.bot.username ?? '');
    const r = await sql.query<{ tenant_id: string; user_id: string; username: string; name: string; bot_id: string | null }>(
      `SELECT tenant_id, user_id, username, name, bot_id FROM tg_bot_requests WHERE lower(username) = lower($1)`, [username]);
    const req = r.rows[0];
    if (!req) {
      this.log.warn('managed bot without a request', { username });
      return;
    }
    if (req.bot_id) return; // already connected (a token update, or a repeat)
    for (let i = 0; i < 50 && !this.onCreated; i++) await sleep(200); // the API module sets it at boot
    const token = await this.api.call<string>('getManagedBotToken', { user_id: m.bot.id });
    try {
      const bot = await this.onCreated!({ tenantId: req.tenant_id, userId: req.user_id, username: req.username, name: req.name }, token, m.bot);
      await sql.query('UPDATE tg_bot_requests SET bot_id = $2, error = NULL WHERE tenant_id = $1', [req.tenant_id, bot.id]);
      this.log.info('managed bot connected', { tenantId: req.tenant_id, username });
    } catch (e) {
      await sql.query('UPDATE tg_bot_requests SET error = $2 WHERE tenant_id = $1', [req.tenant_id, String((e as Error)?.message ?? e).slice(0, 200)]);
      throw e;
    }
  }
}
