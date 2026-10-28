/**
 * Management API for the customer's setup: Telegram bots, routes and
 * templates (list, read, update, delete). Everything runs inside the
 * caller's tenant (RLS) and sensitive changes are audited.
 */
import type { TenantKeys } from '../../db/pgStores.js';
import { isValidBotToken } from '../../telegram/botApi.js';
import type { TelegramRuntime } from '../../telegram/runtime.js';
import { PhoneLinkError, type LinkStatus, type TelegramPhoneLinker } from '../../telegram/phoneLink.js';
import { suggestBotUsername, type TelegramBotManager } from '../../telegram/manager.js';
import { qrRows } from '../qr.js';
import type { TokenClaims as AuthClaims } from '../auth.js';
import { HttpError, type ApiServer } from '../server.js';

export interface ManageModuleOptions {
  keys: TenantKeys;
  telegram: TelegramRuntime;
  /** Called after any route/template change (e.g. to clear the worker's route cache). */
  onRoutesChanged?: () => void;
  /** Connect Telegram by scanning a QR / phone login (needs the app's api_id). Without it only bot tokens. */
  phoneLinker?: TelegramPhoneLinker;
  /** "Create a bot in one tap" through PUSH's manager bot (Telegram managed bots). */
  botManager?: TelegramBotManager;
}

interface RouteRow {
  id: string; name: string; enabled: boolean; filters: unknown; template_id: string | null;
  require_approval: boolean; delay_seconds: number; quiet_hours: unknown; updated_at: Date; control: unknown;
}

export function manageModule(opts: ManageModuleOptions) {
  return (api: ApiServer) => {
    const changed = () => opts.onRoutesChanged?.();

    // ---------------- Telegram bots
    /** Verifies a bot token with Telegram, stores it encrypted (plan limit under a lock) and starts the bot. */
    const connectBot = async (auth: AuthClaims, token: string): Promise<{ id: string; username: string | null }> => {
      if (!isValidBotToken(token)) throw new HttpError(400, 'bad_token', 'הטוקן אינו תקין. מעתיקים אותו מ־@BotFather');
      // Quick check before calling Telegram; the authoritative check runs under a lock below.
      const pre = await api.tenantTx(auth, async (c) => {
        const l = await c.query<{ limits: { tgBots?: number } }>('SELECT p.limits FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.id = $1', [auth.tenantId]);
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
      const cipher = await opts.keys.cipher(auth.tenantId);
      const id = await api.tenantTx(auth, async (c) => {
        // Count and insert under one per-tenant lock, so parallel requests can't exceed the plan.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tg-bots:${auth.tenantId}`]);
        const l = await c.query<{ limits: { tgBots?: number } }>('SELECT p.limits FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.id = $1', [auth.tenantId]);
        const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM tg_bots WHERE status <> 'deleted'`);
        if (n.rows[0]!.n >= (l.rows[0]?.limits.tgBots ?? 1)) throw new HttpError(403, 'plan_limit', 'המסלול שלך לא מאפשר בוטים נוספים');
        const r = await c.query<{ id: string }>(
          `INSERT INTO tg_bots (tenant_id, username, token_blob, bot_user_id) VALUES ($1, $2, 'pending', $3) RETURNING id`,
          [auth.tenantId, me.username ?? null, me.id]).catch((e: { code?: string }) => {
          if (e.code === '23505') throw new HttpError(409, 'bot_in_use', 'הבוט הזה כבר מחובר לחשבון');
          throw e;
        });
        const botId = r.rows[0]!.id;
        // The token's encryption is bound to the bot row id.
        await c.query('UPDATE tg_bots SET token_blob = $2 WHERE id = $1', [botId, cipher.encrypt(`tg-token:${botId}`, token)]);
        await api.audit(c, auth, 'tg_bot.added', botId, { username: me.username });
        return botId;
      });
      await opts.telegram.start(auth.tenantId, id, token);
      return { id, username: me.username ?? null };
    };

    /**
     * On the free plan PUSH also publishes its own posts in the customer's Telegram channels.
     * Connecting Telegram on that plan needs the customer's agreement (promoOk in the body,
     * recorded once); other plans pass.
     */
    const promoConsent = async (auth: AuthClaims, ok: unknown): Promise<void> => {
      await api.tenantTx(auth, async (c) => {
        const r = await c.query<{ plan_code: string; tg_promo_ok_at: Date | null }>('SELECT plan_code, tg_promo_ok_at FROM tenants WHERE id = $1', [auth.tenantId]);
        const t = r.rows[0];
        if (!t || t.plan_code !== 'free' || t.tg_promo_ok_at) return;
        if (ok !== true) throw new HttpError(403, 'promo_consent', 'במסלול החינמי PUSH מפרסמת מדי פעם הודעות משלה בערוצי הטלגרם שמחוברים. סמנו שאתם מאשרים כדי להמשיך.');
        await c.query('UPDATE tenants SET tg_promo_ok_at = now() WHERE id = $1', [auth.tenantId]);
        await api.audit(c, auth, 'tg_promo.accepted', auth.tenantId, {});
      });
    };
    api.on('POST', '/v1/tg/promo-consent', true, async ({ auth }) => {
      api.requireRole(auth!, 'owner', 'admin');
      await promoConsent(auth!, true);
      return { ok: true };
    });

    // ---------------- Create a bot in one tap (Telegram managed bots)
    const mgr = opts.botManager;
    if (mgr) {
      // Telegram created the bot the customer asked for: connect it to their account.
      mgr.onCreated = async (req, token) => {
        const claims: AuthClaims = { tenantId: req.tenantId, userId: req.userId, role: 'owner', exp: Math.floor(Date.now() / 1000) + 300 };
        const bot = await connectBot(claims, token);
        return { id: bot.id };
      };
    }
    const requestView = (row: { username: string; name: string; bot_id: string | null; error: string | null; created_at: Date } | undefined) => {
      if (!row || !mgr) return null;
      const link = mgr.createLink(row.username, row.name);
      return { username: row.username, name: row.name, link, qrRows: qrRows(link), connected: !!row.bot_id, error: row.error, createdAt: row.created_at };
    };
    api.on('GET', '/v1/tg/create', true, async ({ auth }) => {
      if (!mgr?.ready) return { available: false };
      const r = await api.tenantTx(auth!, (c) => c.query<{ username: string; name: string; bot_id: string | null; error: string | null; created_at: Date }>(
        'SELECT username, name, bot_id, error, created_at FROM tg_bot_requests'));
      return { available: true, request: requestView(r.rows[0]) };
    });
    api.on('POST', '/v1/tg/create', true, async ({ auth, body }) => {
      api.requireRole(auth!, 'owner', 'admin');
      if (!mgr?.ready) throw new HttpError(501, 'not_configured', 'יצירת בוט בלחיצה עוד לא הופעלה בשרת. אפשר לחבר עם בוט קיים.');
      await promoConsent(auth!, body.promoOk);
      const t = await api.tenantTx(auth!, async (c) => {
        const l = await c.query<{ name: string; limits: { tgBots?: number } }>('SELECT t.name, p.limits FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.id = $1', [auth!.tenantId]);
        const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM tg_bots WHERE status <> 'deleted'`);
        return { name: l.rows[0]?.name ?? '', free: n.rows[0]!.n < (l.rows[0]?.limits.tgBots ?? 1) };
      });
      if (!t.free) throw new HttpError(403, 'plan_limit', 'במסלול שלכם כבר מחובר בוט טלגרם. נתקו אותו קודם, או שדרגו מסלול.');
      const name = String(body.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 64) || t.name.slice(0, 64) || 'PUSH';
      for (let i = 0; i < 5; i++) {
        const username = suggestBotUsername(t.name);
        try {
          const r = await api.tenantTx(auth!, (c) => c.query<{ username: string; name: string; bot_id: string | null; error: string | null; created_at: Date }>(
            `INSERT INTO tg_bot_requests (tenant_id, user_id, username, name) VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id) DO UPDATE SET user_id = EXCLUDED.user_id, username = EXCLUDED.username, name = EXCLUDED.name,
               created_at = now(), bot_id = NULL, error = NULL
             RETURNING username, name, bot_id, error, created_at`, [auth!.tenantId, auth!.userId, username, name]));
          return requestView(r.rows[0]);
        } catch (e) {
          if ((e as { code?: string }).code !== '23505') throw e; // username taken: try another
        }
      }
      throw new HttpError(500, 'internal', 'לא הצלחנו להכין שם לבוט. נסו שוב.');
    });

    api.on('POST', '/v1/tg/bots', true, async ({ auth, body }) => {
      api.requireRole(auth!, 'owner', 'admin');
      await promoConsent(auth!, body.promoOk);
      return connectBot(auth!, String(body.token ?? '').trim());
    });

    // ---------------- Telegram by QR / phone: we create the bot for the customer
    const linker = opts.phoneLinker;
    const linkCall = async <T>(f: () => Promise<T>): Promise<T> => {
      if (!linker) throw new HttpError(501, 'not_configured', 'חיבור טלגרם בסריקה עוד לא הופעל בשרת. אפשר לחבר עם בוט.');
      try {
        return await f();
      } catch (e) {
        if (e instanceof PhoneLinkError) throw new HttpError(400, e.code, e.message);
        throw e;
      }
    };
    /** The status as the app draws it: a QR link also comes as rows of the QR code. */
    const view = (st: LinkStatus) => (st.step === 'qr' && st.qr ? { ...st, qrRows: qrRows(st.qr) } : st);
    api.on('GET', '/v1/tg/link', true, async ({ auth }) => (linker ? { available: true, ...view(linker.status(auth!.tenantId)) } : { available: false }));
    api.on('POST', '/v1/tg/link/qr', true, async ({ auth, body }) => {
      api.requireRole(auth!, 'owner', 'admin');
      await promoConsent(auth!, body.promoOk);
      return linkCall(async () => view(await linker!.startQr(auth!.tenantId)));
    });
    api.on('POST', '/v1/tg/link/phone', true, async ({ auth, body }) => {
      api.requireRole(auth!, 'owner', 'admin');
      await promoConsent(auth!, body.promoOk);
      return linkCall(() => linker!.start(auth!.tenantId, String(body.phone ?? '')));
    });
    api.on('POST', '/v1/tg/link/code', true, async ({ auth, body }) => linkCall(() => linker!.code(auth!.tenantId, String(body.code ?? ''))));
    api.on('POST', '/v1/tg/link/password', true, async ({ auth, body }) => linkCall(async () => view(await linker!.password(auth!.tenantId, String(body.password ?? '')))));
    api.on('POST', '/v1/tg/link/cancel', true, async ({ auth }) => { linker?.cancel(auth!.tenantId); return { ok: true }; });
    api.on('POST', '/v1/tg/link/finish', true, async ({ auth, body }) => {
      api.requireRole(auth!, 'owner', 'admin');
      const ids = Array.isArray(body.chatIds) ? body.chatIds.map(String).slice(0, 100) : [];
      const name = await api.tenantTx(auth!, async (c) => (await c.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [auth!.tenantId])).rows[0]?.name ?? '');
      // Check the plan before creating anything in the customer's Telegram.
      const free = await api.tenantTx(auth!, async (c) => {
        const l = await c.query<{ limits: { tgBots?: number } }>('SELECT p.limits FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.id = $1', [auth!.tenantId]);
        const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM tg_bots WHERE status <> 'deleted'`);
        return n.rows[0]!.n < (l.rows[0]?.limits.tgBots ?? 1);
      });
      if (!free) throw new HttpError(403, 'plan_limit', 'במסלול שלכם כבר מחובר בוט טלגרם. נתקו אותו קודם, או שדרגו מסלול.');
      await promoConsent(auth!, body.promoOk);
      const made = await linkCall(() => linker!.finish(auth!.tenantId, ids, `${name || 'PUSH'} · PUSH`));
      const bot = await connectBot(auth!, made.token);
      const chats = [];
      for (const c of made.added) {
        try {
          const info = await opts.telegram.addChat(bot.id, c.chatId);
          chats.push({ chatId: info.ref.chatId, title: info.title, type: info.type, canSend: info.canSend });
        } catch {
          chats.push({ chatId: c.chatId, title: c.title, type: c.type, canSend: true });
        }
      }
      return { bot, chats, failed: made.failed.map((f) => ({ title: f.chat.title, error: f.error })) };
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
      // Accepts @name, name, t.me/name, https://t.me/name or a numeric id.
      let chatId = String(body.chatId ?? '').trim().replace(/^https?:\/\//i, '').replace(/^(www\.)?(t|telegram)\.me\//i, '').replace(/[/?#].*$/, '');
      if (/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(chatId)) chatId = `@${chatId}`;
      if (/^\+|^joinchat/i.test(chatId)) throw new HttpError(400, 'private_link', 'זה קישור הזמנה של ערוץ פרטי. בערוץ פרטי מוסיפים את הבוט בכפתור "+ הוספה לערוץ", ואחר כך לוחצים "רענון".');
      if (!/^(@[A-Za-z0-9_]{5,32}|-?\d{5,20})$/.test(chatId)) throw new HttpError(400, 'bad_chat', 'כתבו את כתובת הערוץ, למשל @jd_news_il או t.me/jd_news_il');
      try {
        const info = await opts.telegram.addChat(params.id!, chatId);
        return { chatId: info.ref.chatId, title: info.title, type: info.type, canSend: info.canSend, isAdmin: info.isAdmin };
      } catch {
        throw new HttpError(400, 'chat_unreachable', 'הבוט לא מוצא את הערוץ. ודא שהוספת אותו כמנהל עם הרשאת פרסום');
      }
    });

    /** Asks Telegram again about every chat of the bot (e.g. after the customer gave it the right to post). */
    api.on('POST', '/v1/tg/bots/:id/refresh', true, async ({ auth, params }) => {
      api.requireRole(auth!, 'owner', 'admin');
      await api.ownAccount(auth!, params.id!, true);
      const known = await api.tenantTx(auth!, async (c) =>
        (await c.query<{ chat_id: string }>(`SELECT chat_id FROM chats WHERE platform = 'tg' AND account_id = $1`, [params.id])).rows.map((r) => r.chat_id));
      for (const chatId of known.slice(0, 200)) await opts.telegram.addChat(params.id!, chatId).catch(() => {});
      return api.tenantTx(auth!, async (c) =>
        (await c.query(`SELECT chat_id AS "chatId", title, type, can_send AS "canSend", is_admin AS "isAdmin" FROM chats WHERE platform = 'tg' AND account_id = $1 ORDER BY title`, [params.id])).rows);
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
        delaySeconds: r.delay_seconds, quietHours: r.quiet_hours, control: r.control ?? null, updatedAt: r.updated_at,
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
