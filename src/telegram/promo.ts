/**
 * PUSH's own posts in the Telegram channels and groups of free-plan customers.
 *
 * Who gets them: active customers on the free plan who agreed when connecting Telegram
 * (tenants.tg_promo_ok_at), through their own bot, to the channels and groups where the
 * bot may post. Never premium customers, and never where an emergency stop is active
 * (global, the customer, or that bot) — so "stop this customer" in the panel stops these
 * posts too.
 *
 * Copies are sent one by one in the background with a short gap, recorded per channel,
 * and can be removed from every channel again.
 */
import type { ChannelSender } from '../core/types.js';
import type { Sql } from '../db/pg.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';

export interface PromoTarget { tenantId: string; tenantName: string; botId: string; chatId: string; title: string }
export interface PromoAudience { tenants: number; channels: number; awaitingConsent: number; targets: PromoTarget[] }
export interface PromoRow {
  id: number; body: string; createdAt: Date; status: 'sending' | 'done' | 'retracted';
  targets: number; sent: number; failed: number; finishedAt: Date | null; retractedAt: Date | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TelegramPromo {
  private readonly log: Logger;
  private readonly running = new Set<number>();

  constructor(private readonly o: {
    workerSql: Sql;
    /** The running bot (undefined when it is not running on this server). */
    sender: (botId: string) => Pick<ChannelSender, 'send' | 'remove'> | undefined;
    logger?: Logger;
    /** Gap between two copies (Telegram allows ~30 messages a second per bot; we stay far below). */
    gapMs?: number;
  }) {
    this.log = (o.logger ?? silentLogger).child({ component: 'telegram-promo' });
  }

  async audience(): Promise<PromoAudience> {
    const sql = this.o.workerSql;
    const r = await sql.query<{ tenant_id: string; name: string; bot_id: string; chat_id: string; title: string }>(
      `SELECT t.id AS tenant_id, t.name, b.id AS bot_id, c.chat_id, c.title
         FROM tenants t
         JOIN tg_bots b ON b.tenant_id = t.id AND b.status = 'active'
         JOIN chats c ON c.platform = 'tg' AND c.account_id = b.id AND c.can_send AND c.type IN ('channel', 'group')
        WHERE t.status = 'active' AND t.plan_code = 'free' AND t.tg_promo_ok_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM kill_switches k WHERE k.active AND (k.scope = 'global'
                OR (k.scope = 'tenant' AND k.scope_id = t.id::text) OR (k.scope = 'account' AND k.scope_id = b.id::text)))
        ORDER BY t.created_at, c.title`);
    const waiting = await sql.query<{ n: number }>(
      `SELECT count(DISTINCT t.id)::int AS n FROM tenants t JOIN tg_bots b ON b.tenant_id = t.id AND b.status = 'active'
        WHERE t.status = 'active' AND t.plan_code = 'free' AND t.tg_promo_ok_at IS NULL`);
    const targets = r.rows.map((x) => ({ tenantId: x.tenant_id, tenantName: x.name, botId: x.bot_id, chatId: x.chat_id, title: x.title }));
    return { tenants: new Set(targets.map((t) => t.tenantId)).size, channels: targets.length, awaitingConsent: waiting.rows[0]?.n ?? 0, targets };
  }

  async list(limit = 30): Promise<PromoRow[]> {
    const r = await this.o.workerSql.query<{ id: string; body: string; created_at: Date; status: PromoRow['status']; targets: number; sent: number; failed: number; finished_at: Date | null; retracted_at: Date | null }>(
      'SELECT id, body, created_at, status, targets, sent, failed, finished_at, retracted_at FROM tg_promos ORDER BY id DESC LIMIT $1', [limit]);
    return r.rows.map((x) => ({ id: Number(x.id), body: x.body, createdAt: x.created_at, status: x.status, targets: x.targets, sent: x.sent, failed: x.failed, finishedAt: x.finished_at, retractedAt: x.retracted_at }));
  }

  /** Records the post and starts sending it in the background. */
  async send(body: string, by: string): Promise<{ id: number; targets: number }> {
    const text = body.trim();
    if (!text || text.length > 4000) throw new Error('empty or too long');
    const { targets } = await this.audience();
    if (!targets.length) return { id: 0, targets: 0 };
    const sql = this.o.workerSql;
    const r = await sql.query<{ id: string }>('INSERT INTO tg_promos (body, created_by, targets) VALUES ($1, $2, $3) RETURNING id', [text, by, targets.length]);
    const id = Number(r.rows[0]!.id);
    for (const t of targets) {
      await sql.query('INSERT INTO tg_promo_sends (promo_id, tenant_id, bot_id, chat_id, title) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [id, t.tenantId, t.botId, t.chatId, t.title]);
    }
    this.running.add(id);
    void this.deliver(id, text).catch((e) => this.log.error('promo failed', { id, err: String(e) })).finally(() => this.running.delete(id));
    return { id, targets: targets.length };
  }

  private async deliver(id: number, text: string): Promise<void> {
    const sql = this.o.workerSql;
    const rows = (await sql.query<{ bot_id: string; chat_id: string; tenant_id: string }>(
      'SELECT bot_id, chat_id, tenant_id FROM tg_promo_sends WHERE promo_id = $1 AND sent_at IS NULL AND error IS NULL', [id])).rows;
    let first = true;
    for (const row of rows) {
      if (!first) await sleep(this.o.gapMs ?? 350);
      first = false;
      // Re-checked per copy: a stop set while sending (or a removal) takes effect at once.
      const stillOk = await sql.query(
        `SELECT 1 FROM tg_promos p, tenants t WHERE p.id = $1 AND p.status = 'sending' AND t.id = $2 AND t.status = 'active' AND t.plan_code = 'free'
            AND NOT EXISTS (SELECT 1 FROM kill_switches k WHERE k.active AND (k.scope = 'global'
                  OR (k.scope = 'tenant' AND k.scope_id = $2::text) OR (k.scope = 'account' AND k.scope_id = $3::text)))`, [id, row.tenant_id, row.bot_id]);
      if (!stillOk.rowCount) {
        const p = await sql.query<{ status: string }>('SELECT status FROM tg_promos WHERE id = $1', [id]);
        if (p.rows[0]?.status !== 'sending') return;
        await this.mark(id, row, null, 'נעצר');
        continue;
      }
      const bot = this.o.sender(row.bot_id);
      if (!bot) { await this.mark(id, row, null, 'הבוט לא פעיל'); continue; }
      try {
        const res = await bot.send(row.chat_id, { kind: 'text', text });
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
    const rows = (await sql.query<{ bot_id: string; chat_id: string; message_id: string }>(
      'SELECT bot_id, chat_id, message_id FROM tg_promo_sends WHERE promo_id = $1 AND message_id IS NOT NULL', [id])).rows;
    let removed = 0;
    let failed = 0;
    for (const row of rows) {
      const bot = this.o.sender(row.bot_id);
      try {
        if (!bot?.remove) throw new Error('bot not running');
        await bot.remove(row.chat_id, row.message_id);
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
