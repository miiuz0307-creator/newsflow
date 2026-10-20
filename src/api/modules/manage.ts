/**
 * Management API for the customer's setup: Telegram bots, routes and
 * templates (list, read, update, delete). Everything runs inside the
 * caller's tenant (RLS) and sensitive changes are audited.
 */
import type { TenantKeys } from '../../db/pgStores.js';
import { isValidBotToken } from '../../telegram/botApi.js';
import type { TelegramRuntime } from '../../telegram/runtime.js';
import { HttpError, type ApiServer } from '../server.js';

export interface ManageModuleOptions {
  keys: TenantKeys;
  telegram: TelegramRuntime;
  /** Called after any route/template change (e.g. to clear the worker's route cache). */
  onRoutesChanged?: () => void;
}

interface RouteRow {
  id: string; name: string; enabled: boolean; filters: unknown; template_id: string | null;
  require_approval: boolean; delay_seconds: number; quiet_hours: unknown; updated_at: Date;
}

export function manageModule(opts: ManageModuleOptions) {
  return (api: ApiServer) => {
    const changed = () => opts.onRoutesChanged?.();

    // ---------------- Telegram bots
    api.on('POST', '/v1/tg/bots', true, async ({ auth, body }) => {
      api.requireRole(auth!, 'owner', 'admin');
      const token = String(body.token ?? '').trim();
      if (!isValidBotToken(token)) throw new HttpError(400, 'bad_token', 'הטוקן אינו תקין. מעתיקים אותו מ־@BotFather');
      // Quick check before calling Telegram; the authoritative check runs under a lock below.
      const pre = await api.tenantTx(auth!, async (c) => {
        const l = await c.query<{ limits: { tgBots?: number } }>('SELECT p.limits FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.id = $1', [auth!.tenantId]);
        const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM tg_bots WHERE status <> 'deleted'`);
        return n.rows[0]!.n < (l.rows[0]?.limits.tgBots ?? 1);
      });
      if (!pre) throw new HttpError(403, 'plan_limit', 'המסלול שלך לא מאפשר בוטים נוספים');
      let me: { id: number; username?: string };
      try {
        me = await opts.telegram.verifyToken(token);
      } catch {
        throw new HttpError(400, 'token_rejected', 'Telegram לא אישר את הטוקן. בדוק שהעתקת אותו במלואו');
      }
      const cipher = await opts.keys.cipher(auth!.tenantId);
      const id = await api.tenantTx(auth!, async (c) => {
        // Count and insert under one per-tenant lock, so parallel requests can't exceed the plan.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tg-bots:${auth!.tenantId}`]);
        const l = await c.query<{ limits: { tgBots?: number } }>('SELECT p.limits FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.id = $1', [auth!.tenantId]);
        const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM tg_bots WHERE status <> 'deleted'`);
        if (n.rows[0]!.n >= (l.rows[0]?.limits.tgBots ?? 1)) throw new HttpError(403, 'plan_limit', 'המסלול שלך לא מאפשר בוטים נוספים');
        const r = await c.query<{ id: string }>(
          `INSERT INTO tg_bots (tenant_id, username, token_blob, bot_user_id) VALUES ($1, $2, 'pending', $3) RETURNING id`,
          [auth!.tenantId, me.username ?? null, me.id]).catch((e: { code?: string }) => {
          if (e.code === '23505') throw new HttpError(409, 'bot_in_use', 'הבוט הזה כבר מחובר לחשבון');
          throw e;
        });
        const botId = r.rows[0]!.id;
        // The token's encryption is bound to the bot row id.
        await c.query('UPDATE tg_bots SET token_blob = $2 WHERE id = $1', [botId, cipher.encrypt(`tg-token:${botId}`, token)]);
        await api.audit(c, auth!, 'tg_bot.added', botId, { username: me.username });
        return botId;
      });
      await opts.telegram.start(auth!.tenantId, id, token);
      return { id, username: me.username ?? null };
    });

    api.on('GET', '/v1/tg/bots', true, async ({ auth }) =>
      api.tenantTx(auth!, async (c) =>
        (await c.query(`SELECT id, username, status, last_error, created_at FROM tg_bots WHERE status <> 'deleted' ORDER BY created_at`)).rows
          .map((b) => ({ ...b, running: !!opts.telegram.get(String(b.id)) }))));

    api.on('GET', '/v1/tg/bots/:id/chats', true, async ({ auth, params }) => {
      await api.ownAccount(auth!, params.id!, true);
      return api.tenantTx(auth!, async (c) =>
        (await c.query(`SELECT chat_id AS "chatId", title, type, can_send AS "canSend", is_admin AS "isAdmin" FROM chats WHERE platform = 'tg' AND account_id = $1 ORDER BY title`, [params.id])).rows);
    });

    /** Channels don't announce the bot; the customer adds them by @username or id. */
    api.on('POST', '/v1/tg/bots/:id/chats', true, async ({ auth, params, body }) => {
      api.requireRole(auth!, 'owner', 'admin');
      await api.ownAccount(auth!, params.id!, true);
      const chatId = String(body.chatId ?? '').trim();
      if (!/^(@[A-Za-z0-9_]{5,32}|-?\d{5,20})$/.test(chatId)) throw new HttpError(400, 'bad_chat', 'יש להזין @שם_ערוץ או מזהה מספרי');
      try {
        const info = await opts.telegram.addChat(params.id!, chatId);
        return { chatId: info.ref.chatId, title: info.title, type: info.type, canSend: info.canSend, isAdmin: info.isAdmin };
      } catch {
        throw new HttpError(400, 'chat_unreachable', 'הבוט לא מוצא את הערוץ. ודא שהוספת אותו כמנהל עם הרשאת פרסום');
      }
    });

    api.on('DELETE', '/v1/tg/bots/:id', true, async ({ auth, params }) => {
      api.requireRole(auth!, 'owner', 'admin');
      await api.ownAccount(auth!, params.id!, true);
      await opts.telegram.stop(params.id!);
      await api.tenantTx(auth!, async (c) => {
        await c.query(`UPDATE tg_bots SET status = 'deleted', token_blob = 'deleted', bot_user_id = NULL WHERE id = $1`, [params.id]);
        await c.query(`UPDATE outbound_jobs SET status = 'cancelled', updated_at = now() WHERE target_account_id = $1 AND status IN ('queued', 'pending_approval')`, [params.id]);
        await c.query(`UPDATE routes SET enabled = false, updated_at = now() WHERE id IN (
                         SELECT route_id FROM route_sources WHERE account_id = $1 UNION SELECT route_id FROM route_targets WHERE account_id = $1)`, [params.id]);
        await c.query(`DELETE FROM chats WHERE platform = 'tg' AND account_id = $1`, [params.id]);
        await api.audit(c, auth!, 'tg_bot.deleted', params.id!);
      });
      changed();
      return { deleted: true };
    });

    // ---------------- Routes
    const hydrate = async (c: Parameters<Parameters<typeof api.tenantTx>[1]>[0], rows: RouteRow[]) => {
      if (!rows.length) return [];
      const ids = rows.map((r) => r.id);
      const ends = await c.query<{ route_id: string; kind: 's' | 't'; platform: string; account_id: string; chat_id: string; title: string | null }>(
        `SELECT route_id, 's' AS kind, platform, account_id, chat_id, NULL::text AS title FROM route_sources WHERE route_id = ANY($1::uuid[])
         UNION ALL SELECT route_id, 't', platform, account_id, chat_id, title FROM route_targets WHERE route_id = ANY($1::uuid[])`, [`{${ids.join(',')}}`]);
      return rows.map((r) => ({
        id: r.id, name: r.name, enabled: r.enabled, filters: r.filters, templateId: r.template_id, requireApproval: r.require_approval,
        delaySeconds: r.delay_seconds, quietHours: r.quiet_hours, updatedAt: r.updated_at,
        sources: ends.rows.filter((e) => e.route_id === r.id && e.kind === 's').map((e) => ({ platform: e.platform, accountId: e.account_id, chatId: e.chat_id })),
        targets: ends.rows.filter((e) => e.route_id === r.id && e.kind === 't').map((e) => ({ platform: e.platform, accountId: e.account_id, chatId: e.chat_id, title: e.title })),
      }));
    };

    api.on('GET', '/v1/routes', true, async ({ auth }) =>
      api.tenantTx(auth!, async (c) => hydrate(c, (await c.query<RouteRow>('SELECT * FROM routes ORDER BY created_at')).rows)));

    api.on('GET', '/v1/routes/:id', true, async ({ auth, params }) =>
      api.tenantTx(auth!, async (c) => {
        const [r] = await hydrate(c, (await c.query<RouteRow>('SELECT * FROM routes WHERE id = $1', [params.id])).rows);
        if (!r) throw new HttpError(404, 'not_found', 'route not found');
        return r;
      }));

    api.on('DELETE', '/v1/routes/:id', true, async ({ auth, params }) => {
      api.requireRole(auth!, 'owner', 'admin');
      await api.tenantTx(auth!, async (c) => {
        await c.query(`UPDATE outbound_jobs SET status = 'cancelled', updated_at = now() WHERE route_id = $1 AND status IN ('queued', 'pending_approval')`, [params.id]);
        const r = await c.query('DELETE FROM routes WHERE id = $1', [params.id]);
        if (!r.rowCount) throw new HttpError(404, 'not_found', 'route not found');
        await api.audit(c, auth!, 'route.deleted', params.id!);
      });
      changed();
      return { deleted: true };
    });

    // ---------------- Templates
    api.on('GET', '/v1/templates', true, async ({ auth }) =>
      api.tenantTx(auth!, async (c) => (await c.query('SELECT id, name, body, vars, updated_at FROM templates ORDER BY created_at')).rows));

    api.on('PUT', '/v1/templates/:id', true, async ({ auth, params, body }) =>
      api.tenantTx(auth!, async (c) => {
        api.requireRole(auth!, 'owner', 'admin');
        const r = await c.query('UPDATE templates SET name = COALESCE($2, name), body = COALESCE($3, body), vars = COALESCE($4, vars), updated_at = now() WHERE id = $1',
          [params.id, body.name ?? null, body.body ?? null, body.vars ?? null]);
        if (!r.rowCount) throw new HttpError(404, 'not_found', 'template not found');
        changed();
        return { updated: true };
      }));

    api.on('DELETE', '/v1/templates/:id', true, async ({ auth, params }) =>
      api.tenantTx(auth!, async (c) => {
        api.requireRole(auth!, 'owner', 'admin');
        const r = await c.query('DELETE FROM templates WHERE id = $1', [params.id]);
        if (!r.rowCount) throw new HttpError(404, 'not_found', 'template not found');
        changed();
        return { deleted: true };
      }));
  };
}
