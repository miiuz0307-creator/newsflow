/**
 * Groupush's own posts in the channels and groups of free-plan customers, on Telegram and on
 * WhatsApp. The admin writes the post, picks the customers and the platforms.
 *
 * Who can get them: active customers on the free plan who agreed, per platform:
 *  - Telegram (tenants.tg_promo_ok_at, asked when connecting Telegram): through the customer's
 *    own bot, in the channels and groups where the bot may post.
 *  - WhatsApp (tenants.wa_promo_ok_at, asked separately): through the customer's own number,
 *    only in the groups the customer distributes to (route targets). Never in a control group
 *    (a post there would be distributed as if the customer wrote it) and never in other groups
 *    the number happens to be in. WhatsApp copies keep the same send limits as the customer's
 *    own messages (they share the rate limiter).
 * Never premium customers, and never where an emergency stop is active (global, the customer,
 * or that bot or number) — so "stop this customer" in the panel stops these posts too.
 *
 * Copies are sent one by one in the background, recorded per chat, and can be removed from
 * every chat again.
 */
import { chatKey, type ChannelSender } from '../core/types.js';
import type { Sql } from '../db/pg.js';
import type { Reservation } from '../delivery/rateLimiter.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';

export type PromoPlatform = 'tg' | 'wa';
export const PROMO_PLATFORMS: readonly PromoPlatform[] = ['tg', 'wa'];

export interface PromoTarget { platform: PromoPlatform; tenantId: string; tenantName: string; botId: string; chatId: string; title: string }
/** One customer as the admin sees it when choosing who gets a post. */
export interface PromoCustomer {
  tenantId: string; name: string; plan: string; planName: string; suspended: boolean;
  tg: { consent: boolean; chats: string[] };
  wa: { consent: boolean; chats: string[] };
}
export interface PromoAudience {
  /** Customers and chats that can get a Telegram post (kept for the older screen). */
  tenants: number; channels: number; awaitingConsent: number;
  waTenants: number; waGroups: number; waAwaitingConsent: number;
  targets: PromoTarget[];
  customers: PromoCustomer[];
}
export interface PromoRow {
  id: number; body: string; createdAt: Date; status: 'sending' | 'done' | 'retracted';
  platforms: PromoPlatform[]; customers: number | null;
  targets: number; sent: number; failed: number; finishedAt: Date | null; retractedAt: Date | null;
}
export interface SendChoice { platforms?: PromoPlatform[]; tenantIds?: string[] }

type Sender = Pick<ChannelSender, 'send' | 'remove'>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NOT_STOPPED = (tenant: string, account: string) => `NOT EXISTS (SELECT 1 FROM kill_switches k WHERE k.active AND (k.scope = 'global'
  OR (k.scope = 'tenant' AND k.scope_id = ${tenant}::text) OR (k.scope = 'account' AND k.scope_id = ${account}::text)))`;

export class TelegramPromo {
  private readonly log: Logger;
  private readonly running = new Set<number>();

  constructor(private readonly o: {
    workerSql: Sql;
    /** The running bot (undefined when it is not running on this server). */
    sender: (botId: string) => Sender | undefined;
    /** The WhatsApp number, when it is connected on this server. Without it, no WhatsApp posts. */
    waSender?: (accountId: string) => Sender | undefined;
    /** The shared send limits (the worker's rate limiter), so posts never push a number past them. */
    reserve?: (platform: PromoPlatform, accountId: string, chatKey: string) => Promise<Reservation>;
    logger?: Logger;
    /** Gap between two Telegram copies (Telegram allows ~30 messages a second per bot; we stay far below). */
    gapMs?: number;
    /** Gap between two WhatsApp copies, on top of the rate limiter. */
    waGapMs?: number;
    /** Longest wait for a free send slot for one WhatsApp copy before it is given up. */
    waMaxWaitMs?: number;
  }) {
    this.log = (o.logger ?? silentLogger).child({ component: 'promo' });
  }

  get whatsappEnabled(): boolean { return !!this.o.waSender; }

  async audience(): Promise<PromoAudience> {
    const sql = this.o.workerSql;
    const tg = await sql.query<{ tenant_id: string; name: string; bot_id: string; chat_id: string; title: string }>(
      `SELECT t.id AS tenant_id, t.name, b.id AS bot_id, c.chat_id, c.title
         FROM tenants t
         JOIN tg_bots b ON b.tenant_id = t.id AND b.status = 'active'
         JOIN chats c ON c.platform = 'tg' AND c.account_id = b.id AND c.can_send AND c.type IN ('channel', 'group')
        WHERE t.status = 'active' AND t.plan_code = 'free' AND t.tg_promo_ok_at IS NOT NULL AND ${NOT_STOPPED('t.id', 'b.id')}
        ORDER BY t.created_at, c.title`);
    const wa = this.o.waSender ? await sql.query<{ tenant_id: string; name: string; account_id: string; chat_id: string; title: string }>(
      `SELECT DISTINCT ON (t.created_at, t.id, a.id, rt.chat_id) t.id AS tenant_id, t.name, a.id AS account_id, rt.chat_id,
              COALESCE(NULLIF(c.title, ''), NULLIF(rt.title, ''), rt.chat_id) AS title
         FROM tenants t
         JOIN wa_accounts a ON a.tenant_id = t.id AND a.status <> 'deleted'
         JOIN route_targets rt ON rt.tenant_id = t.id AND rt.platform = 'wa' AND rt.account_id = a.id
         JOIN routes r ON r.id = rt.route_id AND r.enabled
         LEFT JOIN chats c ON c.platform = 'wa' AND c.account_id = a.id AND c.chat_id = rt.chat_id
        WHERE t.status = 'active' AND t.plan_code = 'free' AND t.wa_promo_ok_at IS NOT NULL
          AND rt.chat_id LIKE '%@g.us'
          AND NOT EXISTS (SELECT 1 FROM route_sources rs WHERE rs.platform = 'wa' AND rs.account_id = a.id AND rs.chat_id = rt.chat_id)
          AND ${NOT_STOPPED('t.id', 'a.id')}
        ORDER BY t.created_at, t.id, a.id, rt.chat_id`) : { rows: [] };
    const targets: PromoTarget[] = [
      ...tg.rows.map((x) => ({ platform: 'tg' as const, tenantId: x.tenant_id, tenantName: x.name, botId: x.bot_id, chatId: x.chat_id, title: x.title })),
      ...wa.rows.map((x) => ({ platform: 'wa' as const, tenantId: x.tenant_id, tenantName: x.name, botId: x.account_id, chatId: x.chat_id, title: x.title })),
    ];

    const all = await sql.query<{ id: string; name: string; plan_code: string; plan_name: string; status: string; tg_ok: boolean; wa_ok: boolean; has_tg: boolean; has_wa: boolean }>(
      `SELECT t.id, t.name, t.plan_code, p.name AS plan_name, t.status, t.tg_promo_ok_at IS NOT NULL AS tg_ok, t.wa_promo_ok_at IS NOT NULL AS wa_ok,
              EXISTS (SELECT 1 FROM tg_bots b WHERE b.tenant_id = t.id AND b.status = 'active') AS has_tg,
              EXISTS (SELECT 1 FROM wa_accounts a WHERE a.tenant_id = t.id AND a.status <> 'deleted') AS has_wa
         FROM tenants t JOIN plans p ON p.code = t.plan_code
        WHERE t.status IN ('active', 'suspended')
        ORDER BY (t.plan_code = 'free') DESC, t.created_at`);
    const customers: PromoCustomer[] = all.rows.map((x) => {
      const mine = (p: PromoPlatform) => targets.filter((t) => t.platform === p && t.tenantId === x.id).map((t) => t.title || t.chatId);
      return { tenantId: x.id, name: x.name, plan: x.plan_code, planName: x.plan_name, suspended: x.status !== 'active',
        tg: { consent: x.tg_ok, chats: mine('tg') }, wa: { consent: x.wa_ok, chats: mine('wa') } };
    });
    const free = all.rows.filter((x) => x.plan_code === 'free' && x.status === 'active');
    const count = (p: PromoPlatform) => targets.filter((t) => t.platform === p);
    return {
      tenants: new Set(count('tg').map((t) => t.tenantId)).size, channels: count('tg').length,
      awaitingConsent: free.filter((x) => x.has_tg && !x.tg_ok).length,
      waTenants: new Set(count('wa').map((t) => t.tenantId)).size, waGroups: count('wa').length,
      waAwaitingConsent: this.o.waSender ? free.filter((x) => x.has_wa && !x.wa_ok).length : 0,
      targets, customers,
    };
  }

  async list(limit = 30): Promise<PromoRow[]> {
    const r = await this.o.workerSql.query<{ id: string; body: string; created_at: Date; status: PromoRow['status']; platforms: PromoPlatform[]; customers: number | null; targets: number; sent: number; failed: number; finished_at: Date | null; retracted_at: Date | null }>(
      `SELECT id, body, created_at, status, platforms, cardinality(tenant_ids) AS customers, targets, sent, failed, finished_at, retracted_at
         FROM tg_promos ORDER BY id DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ id: Number(x.id), body: x.body, createdAt: x.created_at, status: x.status, platforms: x.platforms, customers: x.customers,
      targets: x.targets, sent: x.sent, failed: x.failed, finishedAt: x.finished_at, retractedAt: x.retracted_at }));
  }

  /**
   * Records the post and starts sending it in the background. Without a choice: Telegram, every
   * customer who can get it (as before). Picked customers who cannot get it are simply left out.
   */
  async send(body: string, by: string, choice: SendChoice = {}): Promise<{ id: number; targets: number; customers: number }> {
    const text = body.trim();
    if (!text || text.length > 4000) throw new Error('empty or too long');
    const platforms = [...new Set(choice.platforms?.length ? choice.platforms : ['tg' as const])].filter((p) => PROMO_PLATFORMS.includes(p));
    if (!platforms.length) throw new Error('no platform');
    const picked = choice.tenantIds ? new Set(choice.tenantIds) : null;
    const targets = (await this.audience()).targets.filter((t) => platforms.includes(t.platform) && (!picked || picked.has(t.tenantId)));
    const customers = new Set(targets.map((t) => t.tenantId)).size;
    if (!targets.length) return { id: 0, targets: 0, customers: 0 };
    const sql = this.o.workerSql;
    const r = await sql.query<{ id: string }>('INSERT INTO tg_promos (body, created_by, targets, platforms, tenant_ids) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [text, by, targets.length, `{${platforms.join(',')}}`, picked ? `{${[...new Set(targets.map((t) => t.tenantId))].join(',')}}` : null]);
    const id = Number(r.rows[0]!.id);
    for (const t of targets) {
      await sql.query('INSERT INTO tg_promo_sends (promo_id, tenant_id, bot_id, chat_id, title, platform) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
        [id, t.tenantId, t.botId, t.chatId, t.title, t.platform]);
    }
    this.running.add(id);
    void this.deliver(id, text).catch((e) => this.log.error('promo failed', { id, err: String(e) })).finally(() => this.running.delete(id));
    return { id, targets: targets.length, customers };
  }

  private senderFor(platform: PromoPlatform, id: string): Sender | undefined {
    return platform === 'wa' ? this.o.waSender?.(id) : this.o.sender(id);
  }

  /** Waits for a free WhatsApp send slot. Returns an error text when there is none in time. */
  private async slot(accountId: string, chatId: string): Promise<string | null> {
    if (!this.o.reserve) return null;
    const end = Date.now() + (this.o.waMaxWaitMs ?? 5 * 60_000);
    for (;;) {
      const r = await this.o.reserve('wa', accountId, chatKey({ platform: 'wa', accountId, chatId }));
      if (r.ok) return null;
      if (r.reason === 'daily_cap') return 'המספר הגיע למכסת השליחה היומית';
      const wait = r.retryAt.getTime() - Date.now();
      if (Date.now() + wait > end) return r.reason === 'cooldown' ? 'המספר בהפסקת בטיחות' : 'אין כרגע מקום בקצב השליחה';
      await sleep(Math.max(50, Math.min(wait, 30_000)));
    }
  }

  private async deliver(id: number, text: string): Promise<void> {
    const sql = this.o.workerSql;
    // Telegram first (fast), then WhatsApp copies, spread across the numbers.
    const rows = (await sql.query<{ bot_id: string; chat_id: string; tenant_id: string; platform: PromoPlatform }>(
      `SELECT bot_id, chat_id, tenant_id, platform FROM tg_promo_sends WHERE promo_id = $1 AND sent_at IS NULL AND error IS NULL
        ORDER BY platform = 'wa', row_number() OVER (PARTITION BY bot_id ORDER BY chat_id), bot_id`, [id])).rows;
    let prev: PromoPlatform | null = null;
    for (const row of rows) {
      if (prev) await sleep(row.platform === 'wa' ? (this.o.waGapMs ?? 1_500) : (this.o.gapMs ?? 350));
      prev = row.platform;
      // Re-checked per copy: a stop, a plan change or a removal while sending takes effect at once.
      const stillOk = await sql.query(
        `SELECT 1 FROM tg_promos p, tenants t WHERE p.id = $1 AND p.status = 'sending' AND t.id = $2 AND t.status = 'active' AND t.plan_code = 'free'
            AND (CASE WHEN $4 = 'wa' THEN t.wa_promo_ok_at ELSE t.tg_promo_ok_at END) IS NOT NULL
            AND ${NOT_STOPPED('$2', '$3')}`, [id, row.tenant_id, row.bot_id, row.platform]);
      if (!stillOk.rowCount) {
        const p = await sql.query<{ status: string }>('SELECT status FROM tg_promos WHERE id = $1', [id]);
        if (p.rows[0]?.status !== 'sending') return;
        await this.mark(id, row, null, 'נעצר');
        continue;
      }
      const sender = this.senderFor(row.platform, row.bot_id);
      if (!sender) { await this.mark(id, row, null, row.platform === 'wa' ? 'המספר לא מחובר' : 'הבוט לא פעיל'); continue; }
      if (row.platform === 'wa') {
        const busy = await this.slot(row.bot_id, row.chat_id);
        if (busy) { await this.mark(id, row, null, busy); continue; }
      }
      try {
        const res = await sender.send(row.chat_id, { kind: 'text', text });
        await this.mark(id, row, res.messageId, null);
      } catch (e) {
        await this.mark(id, row, null, String((e as Error)?.message ?? e).slice(0, 200));
      }
    }
    await sql.query(`UPDATE tg_promos SET status = 'done', finished_at = now() WHERE id = $1 AND status = 'sending'`, [id]);
    const done = await sql.query<{ sent: number; failed: number }>('SELECT sent, failed FROM tg_promos WHERE id = $1', [id]);
    this.log.info('promo sent', { id, ...done.rows[0] });
  }

  private async mark(id: number, row: { bot_id: string; chat_id: string }, messageId: string | null, error: string | null) {
    const sql = this.o.workerSql;
    await sql.query('UPDATE tg_promo_sends SET message_id = $4, error = $5, sent_at = now() WHERE promo_id = $1 AND bot_id = $2 AND chat_id = $3',
      [id, row.bot_id, row.chat_id, messageId, error]);
    await sql.query(messageId ? 'UPDATE tg_promos SET sent = sent + 1 WHERE id = $1' : 'UPDATE tg_promos SET failed = failed + 1 WHERE id = $1', [id]);
  }

  /** Stops a post that is still going out and removes the copies already sent. */
  async retract(id: number): Promise<{ removed: number; failed: number }> {
    const sql = this.o.workerSql;
    const p = await sql.query(`UPDATE tg_promos SET status = 'retracted', retracted_at = now() WHERE id = $1 AND status <> 'retracted' RETURNING id`, [id]);
    if (!p.rowCount) throw new Error('not found or already removed');
    const rows = (await sql.query<{ bot_id: string; chat_id: string; message_id: string; platform: PromoPlatform }>(
      'SELECT bot_id, chat_id, message_id, platform FROM tg_promo_sends WHERE promo_id = $1 AND message_id IS NOT NULL', [id])).rows;
    let removed = 0;
    let failed = 0;
    for (const row of rows) {
      const sender = this.senderFor(row.platform, row.bot_id);
      try {
        if (!sender?.remove) throw new Error('not running');
        await sender.remove(row.chat_id, row.message_id);
        removed++;
      } catch {
        failed++;
      }
    }
    this.log.info('promo removed', { id, removed, failed });
    return { removed, failed };
  }

  /** After a restart: posts left half-sent are closed (their copies are not re-sent). */
  async closeInterrupted(): Promise<void> {
    await this.o.workerSql.query(`UPDATE tg_promos SET status = 'done', finished_at = now() WHERE status = 'sending'`);
  }

  get busy(): boolean { return this.running.size > 0; }
}
