/**
 * Super Admin API (/admin/v1/*). Separate login (password + TOTP), separate
 * token secret and a separate database role, so a customer token can never
 * reach these routes and the admin role can never read sessions or tokens.
 *
 * Roles: superadmin (everything) and support (read, tickets, notifications).
 * Every change is written to the audit log as admin:<id>.
 */
import { createHmac } from 'node:crypto';
import type http from 'node:http';
import { randomBytes } from 'node:crypto';
import { checkPassword, DUMMY_HASH, hashPassword, verifyPassword } from '../../auth/password.js';
import { totpCipherKey, verifyTotpStep } from '../../auth/totp.js';
import { adminHtml } from '../adminPage.js';
import { TenantCipher } from '../../crypto/keyring.js';
import { safeEqual } from '../../crypto/keyring.js';
import type { PgPool, Sql } from '../../db/pg.js';
import { PgError } from '../../db/pg.js';
import { HttpError, type ApiServer } from '../server.js';
import { WindowLimiter } from './auth.js';

export interface AdminClaims {
  kind: 'admin';
  adminId: string;
  role: 'superadmin' | 'support';
  exp: number;
}

export function signAdminToken(c: Omit<AdminClaims, 'exp' | 'kind'>, secret: string, ttlS = 3600): string {
  const payload = Buffer.from(JSON.stringify({ ...c, kind: 'admin', exp: Math.floor(Date.now() / 1000) + ttlS })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

export function verifyAdminToken(token: string, secret: string): AdminClaims | null {
  const [p, s] = token.split('.');
  if (!p || !s || !safeEqual(s, createHmac('sha256', secret).update(p).digest('base64url'))) return null;
  try {
    const c = JSON.parse(Buffer.from(p, 'base64url').toString()) as AdminClaims;
    return c.kind === 'admin' && c.exp * 1000 > Date.now() ? c : null;
  } catch {
    return null;
  }
}

/** Encrypts an admin's TOTP secret for storage (used by create-admin and tests). */
export function encryptTotpSecret(masterKeyB64: string, adminEmail: string, secret: string): string {
  return new TenantCipher('admins', totpCipherKey(masterKeyB64)).encrypt(`totp:${adminEmail.toLowerCase()}`, secret);
}

export interface AdminModuleOptions {
  adminPool: PgPool;
  /** Different from the customer token secret. ≥32 chars. */
  adminTokenSecret: string;
  /** The customer token secret, only to check that the two differ. */
  customerTokenSecret?: string;
  /** Master key (base64): TOTP secrets are stored encrypted with a key derived from it. */
  masterKeyB64: string;
  loginLimiter?: WindowLimiter;
  /**
   * Operations the admin role may not do on its own (it cannot write tenants or admins);
   * the server passes them in. Without them the matching routes answer 501.
   */
  manage?: {
    /** One-time code (from the server's environment) that allows creating the first admin. */
    setupCode?: string;
    /** Inserts the first superadmin; false when an admin already exists. */
    createFirstAdmin?: (email: string, passwordHash: string, encryptedTotp: string) => Promise<boolean>;
    /** Opens a customer account (business + owner user); returns the tenant id. */
    createCustomer?: (businessName: string, email: string, passwordHash: string) => Promise<string>;
    /** Disconnects the customer's numbers and bots and deletes the account's data. */
    deleteCustomer?: (tenantId: string) => Promise<void>;
  };
}

export function adminModule(opts: AdminModuleOptions) {
  if (opts.adminTokenSecret.length < 32) throw new Error('adminTokenSecret must be at least 32 characters');
  if (opts.customerTokenSecret && opts.customerTokenSecret === opts.adminTokenSecret) throw new Error('admin and customer token secrets must differ');
  const totpCipher = new TenantCipher('admins', totpCipherKey(opts.masterKeyB64));
  const limiter = opts.loginLimiter ?? new WindowLimiter(5, 5 * 60_000);
  const sql: Sql = opts.adminPool;

  /**
   * Verifies the token AND re-reads the admin from the database on every request,
   * so deactivating an admin or changing their role takes effect immediately.
   */
  const authOf = async (req: http.IncomingMessage, need?: 'superadmin'): Promise<AdminClaims> => {
    const h = req.headers.authorization ?? '';
    const c = h.startsWith('Bearer ') ? verifyAdminToken(h.slice(7), opts.adminTokenSecret) : null;
    if (!c) throw new HttpError(401, 'unauthorized', 'admin login required');
    const r = await sql.query<{ role: AdminClaims['role'] }>('SELECT role FROM admins WHERE id = $1 AND active', [c.adminId]);
    const role = r.rows[0]?.role;
    if (!role) throw new HttpError(401, 'unauthorized', 'admin login required');
    if (need === 'superadmin' && role !== 'superadmin') throw new HttpError(403, 'forbidden_role', 'superadmin only');
    return { ...c, role };
  };
  const audit = (a: AdminClaims, action: string, target: string, tenantId: string | null, detail: Record<string, unknown> = {}) =>
    sql.query('INSERT INTO audit_log (tenant_id, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5)', [tenantId, `admin:${a.adminId}`, action, target, detail]);

  const m = opts.manage ?? {};
  const setupLimiter = new WindowLimiter(10, 15 * 60_000);

  return (api: ApiServer) => {
    // The management panel page (all data comes from /admin/v1/* after sign-in).
    api.on('GET', '/admin', false, async ({ res }) => {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex',
      });
      res.end(adminHtml(nonce));
      return undefined;
    });

    // ---- First admin: allowed once, with the setup code, while no admin exists.
    api.on('GET', '/admin/v1/setup', false, async () => {
      const r = await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM admins');
      return { needed: (r.rows[0]?.n ?? 0) === 0 && !!m.setupCode && !!m.createFirstAdmin };
    });
    api.on('POST', '/admin/v1/setup', false, async ({ body, ip }) => {
      if (!setupLimiter.take(ip)) throw new HttpError(429, 'too_many', 'יותר מדי ניסיונות; נסו שוב בעוד רבע שעה');
      if (!m.setupCode || !m.createFirstAdmin) throw new HttpError(501, 'not_configured', 'הגדרה ראשונה לא זמינה בשרת הזה');
      if (!safeEqual(String(body.code ?? ''), m.setupCode)) throw new HttpError(403, 'bad_code', 'קוד ההגדרה שגוי');
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'bad_email', 'כתובת אימייל לא תקינה');
      const password = String(body.password ?? '');
      const problem = checkPassword(password, email);
      if (problem || password.length < 12) throw new HttpError(400, 'weak_password', problem?.message ?? 'סיסמת מנהל צריכה לפחות 12 תווים');
      // No authenticator app: the owner asked for email + password only (empty secret = no second step).
      const created = await m.createFirstAdmin(email, await hashPassword(password), '');
      if (!created) throw new HttpError(409, 'done', 'כבר יש מנהל במערכת');
      return { created: true };
    });

    api.on('POST', '/admin/v1/login', false, async ({ body, ip }) => {
      if (!limiter.take(ip)) throw new HttpError(429, 'too_many', 'too many attempts');
      const email = String(body.email ?? '').slice(0, 320);
      const password = String(body.password ?? '');
      const bad = new HttpError(401, 'bad_credentials', 'bad credentials');
      // Counted first and atomically; locked, inactive and unknown accounts all look the same.
      const r = await sql.query<{ id: string; password_hash: string; totp_secret: string; role: AdminClaims['role']; last_totp_step: number }>(
        'SELECT * FROM admin_begin_attempt($1)', [email]);
      const a = r.rows[0];
      if (!a || password.length > 200) {
        await verifyPassword(password.slice(0, 200), DUMMY_HASH).catch(() => false);
        throw bad;
      }
      if (!(await verifyPassword(password, a.password_hash))) throw bad;
      if (!a.totp_secret) {
        await sql.query(`UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [a.id]);
      } else {
        let secret: string;
        try {
          secret = totpCipher.decryptString(`totp:${email.toLowerCase()}`, a.totp_secret);
        } catch {
          throw bad;
        }
        const step = verifyTotpStep(secret, String(body.code ?? ''));
        if (step === null || step <= Number(a.last_totp_step)) throw bad; // each code works once
        const won = await sql.query(
          `UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = now(), last_totp_step = $2 WHERE id = $1 AND last_totp_step < $2`,
          [a.id, step]);
        if (!won.rowCount) throw bad; // a concurrent login used the same code
      }
      return { token: signAdminToken({ adminId: a.id, role: a.role }, opts.adminTokenSecret), role: a.role };
    });

    api.on('GET', '/admin/v1/dashboard', false, async ({ req }) => {
      await authOf(req);
      const one = async <T>(q: string) => (await sql.query<T>(q)).rows;
      const [tenants, plans, accounts, bots, routes, jobs, safety, tickets, mrr] = await Promise.all([
        one<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM tenants GROUP BY status`),
        one<{ plan_code: string; n: number }>(`SELECT plan_code, count(*)::int AS n FROM tenants WHERE status = 'active' GROUP BY plan_code`),
        one<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM wa_accounts WHERE status <> 'deleted' GROUP BY status`),
        one<{ n: number }>(`SELECT count(*)::int AS n FROM tg_bots WHERE status = 'active'`),
        one<{ n: number }>(`SELECT count(*)::int AS n FROM routes WHERE enabled`),
        one<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM outbound_jobs WHERE created_at > now() - interval '24 hours' GROUP BY status`),
        one<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM safety_events WHERE created_at > now() - interval '24 hours' GROUP BY kind`),
        one<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM tickets WHERE status <> 'closed' GROUP BY status`),
        one<{ agorot: number }>(`SELECT COALESCE(sum(p.price_agorot), 0)::int AS agorot FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.status = 'active'`),
      ]);
      // The last 24 hours, hour by hour: copies delivered and reads (for the chart at the top of the panel).
      const hourly = await one<{ h: string; sent: number; reads: number }>(
        `SELECT g.h,
                (SELECT count(*)::int FROM outbound_jobs j WHERE j.status = 'sent' AND j.sent_at >= g.h AND j.sent_at < g.h + interval '1 hour') AS sent,
                (SELECT count(*)::int FROM message_reads r WHERE r.read_at >= g.h AND r.read_at < g.h + interval '1 hour') AS reads
           FROM generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') AS g(h)
          ORDER BY g.h`);
      const obj = (rows: { n: number }[], key: string) => Object.fromEntries(rows.map((r) => [(r as unknown as Record<string, string>)[key], r.n]));
      const m = process.memoryUsage();
      return {
        tenants: obj(tenants, 'status'),
        activeByPlan: obj(plans, 'plan_code'),
        whatsappNumbers: obj(accounts, 'status'),
        telegramBots: bots[0]?.n ?? 0,
        activeRoutes: routes[0]?.n ?? 0,
        jobsLast24h: obj(jobs, 'status'),
        safetyEventsLast24h: obj(safety, 'kind'),
        openTickets: obj(tickets, 'status'),
        monthlyRevenueEstimateIls: (mrr[0]?.agorot ?? 0) / 100,
        hourly,
        sentLast24h: hourly.reduce((a, r) => a + r.sent, 0),
        readsLast24h: hourly.reduce((a, r) => a + r.reads, 0),
        server: { rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576), uptimeS: Math.round(process.uptime()) },
      };
    });

    api.on('GET', '/admin/v1/tenants', false, async ({ req }) => {
      await authOf(req);
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '';
      const r = await sql.query(
        `SELECT t.id, t.name, t.plan_code, t.status, t.created_at,
                (SELECT min(email) FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner') AS owner_email,
                (SELECT count(*)::int FROM wa_accounts a WHERE a.tenant_id = t.id AND a.status <> 'deleted') AS numbers,
                (SELECT count(*)::int FROM wa_accounts a WHERE a.tenant_id = t.id AND a.status = 'connected') AS connected,
                (SELECT max(last_login_at) FROM users u WHERE u.tenant_id = t.id) AS last_login_at,
                (SELECT count(*)::int FROM outbound_jobs j WHERE j.tenant_id = t.id AND j.status = 'sent' AND j.action = 'send'
                    AND j.created_at > now() - interval '24 hours') AS sent_24h,
                (SELECT count(*)::int FROM message_reads r WHERE r.tenant_id = t.id AND r.read_at > now() - interval '24 hours') AS reads_24h,
                (SELECT string_agg(c.n::text, ',' ORDER BY d.d)
                   FROM generate_series(current_date::timestamptz - interval '6 days', current_date::timestamptz, interval '1 day') AS d(d)
                   CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM outbound_jobs j WHERE j.tenant_id = t.id AND j.status = 'sent'
                                         AND j.sent_at >= d.d AND j.sent_at < d.d + interval '1 day') AS c) AS spark_7d
           FROM tenants t
          WHERE t.status <> 'deleted' AND ($1 = '' OR t.name ILIKE '%' || $1 || '%'
                OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.email ILIKE '%' || $1 || '%'))
          ORDER BY t.created_at DESC LIMIT 100`, [q.slice(0, 100)]);
      return r.rows;
    });

    api.on('GET', '/admin/v1/tenants/:id', false, async ({ req, params }) => {
      await authOf(req);
      const t = await sql.query('SELECT id, name, plan_code, status, risk_accepted_at, created_at FROM tenants WHERE id = $1', [params.id]);
      if (!t.rowCount) throw new HttpError(404, 'not_found', 'tenant not found');
      const [users, accounts, bots, routes, jobs, safety, stops] = await Promise.all([
        sql.query('SELECT id, email, role, last_login_at FROM users WHERE tenant_id = $1', [params.id]),
        sql.query('SELECT id, status, phone_number, last_connected_at, last_disconnect_reason FROM wa_accounts WHERE tenant_id = $1', [params.id]),
        sql.query('SELECT id, username, status, last_error FROM tg_bots WHERE tenant_id = $1', [params.id]),
        sql.query('SELECT id, name, enabled FROM routes WHERE tenant_id = $1', [params.id]),
        sql.query(`SELECT status, count(*)::int AS n FROM outbound_jobs WHERE tenant_id = $1 AND created_at > now() - interval '7 days' GROUP BY status`, [params.id]),
        sql.query('SELECT kind, detail, created_at FROM safety_events WHERE tenant_id = $1 ORDER BY id DESC LIMIT 20', [params.id]),
        sql.query('SELECT scope, scope_id, reason, set_by, set_at FROM kill_switches WHERE tenant_id = $1 AND active', [params.id]),
      ]);
      const daily = await sql.query<{ d: string; sent: number; reads: number }>(
        `SELECT d.d,
                (SELECT count(*)::int FROM outbound_jobs j WHERE j.tenant_id = $1 AND j.status = 'sent' AND j.sent_at >= d.d AND j.sent_at < d.d + interval '1 day') AS sent,
                (SELECT count(*)::int FROM message_reads r WHERE r.tenant_id = $1 AND r.read_at >= d.d AND r.read_at < d.d + interval '1 day') AS reads
           FROM generate_series(current_date::timestamptz - interval '13 days', current_date::timestamptz, interval '1 day') AS d(d)
          ORDER BY d.d`, [params.id]);
      return { tenant: t.rows[0], users: users.rows, whatsapp: accounts.rows, telegram: bots.rows, routes: routes.rows, jobs7d: jobs.rows, safetyEvents: safety.rows, activeStops: stops.rows, daily: daily.rows };
    });

    // ---- Add a customer by hand: the owner gets a temporary password, shown here once.
    api.on('POST', '/admin/v1/tenants', false, async ({ req, body }) => {
      const a = await authOf(req, 'superadmin');
      if (!m.createCustomer) throw new HttpError(501, 'not_configured', 'not available on this server');
      const name = String(body.businessName ?? '').trim().slice(0, 100);
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!name) throw new HttpError(400, 'bad_name', 'חסר שם עסק');
      if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'bad_email', 'כתובת אימייל לא תקינה');
      const exists = await sql.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
      if (exists.rowCount) throw new HttpError(409, 'email_taken', 'כבר יש משתמש עם האימייל הזה');
      const temp = `Push-${randomBytes(6).toString('base64url')}-${randomBytes(2).readUInt16BE(0) % 9000 + 1000}`;
      const tenantId = await m.createCustomer(name, email, await hashPassword(temp));
      if (body.plan) await sql.query('SELECT admin_set_tenant($1, $2, NULL, $3)', [tenantId, String(body.plan), `admin:${a.adminId}`]);
      await audit(a, 'tenant.created_by_admin', tenantId, tenantId, { email });
      return { tenantId, email, temporaryPassword: temp };
    });

    // ---- Remove a customer from the system: numbers disconnected, data deleted.
    api.on('DELETE', '/admin/v1/tenants/:id', false, async ({ req, params }) => {
      const a = await authOf(req, 'superadmin');
      if (!m.deleteCustomer) throw new HttpError(501, 'not_configured', 'not available on this server');
      const t = await sql.query('SELECT id FROM tenants WHERE id = $1 AND status <> \'deleted\'', [params.id]);
      if (!t.rowCount) throw new HttpError(404, 'not_found', 'tenant not found');
      await audit(a, 'tenant.deleted_by_admin', String(params.id), String(params.id));
      await m.deleteCustomer(String(params.id));
      return { deleted: true };
    });

    api.on('POST', '/admin/v1/tenants/:id', false, async ({ req, params, body }) => {
      const a = await authOf(req, 'superadmin');
      try {
        await sql.query('SELECT admin_set_tenant($1, $2, $3, $4)', [params.id, body.plan ?? null, body.status ?? null, `admin:${a.adminId}`]);
      } catch (e) {
        if (e instanceof PgError && e.code === 'P0002') throw new HttpError(404, 'not_found', 'tenant not found');
        if (e instanceof PgError) throw new HttpError(400, 'bad_request', e.message);
        throw e;
      }
      return { updated: true };
    });

    // Emergency stops: global (superadmin) and clearing stops the system set automatically.
    api.on('POST', '/admin/v1/stop', false, async ({ req, body }) => {
      const a = await authOf(req, 'superadmin');
      const scope = String(body.scope ?? 'global');
      if (!['global', 'tenant', 'account', 'route'].includes(scope)) throw new HttpError(400, 'bad_scope', 'bad scope');
      const scopeId = scope === 'global' ? '*' : String(body.id ?? '');
      const tenantId = scope === 'global' ? null : String(body.tenantId ?? '');
      await sql.query(
        `INSERT INTO kill_switches (scope, scope_id, tenant_id, active, reason, set_by) VALUES ($1, $2, $3, true, $4, $5)
         ON CONFLICT (scope, scope_id) DO UPDATE SET active = true, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()`,
        [scope, scopeId, tenantId, String(body.reason ?? 'admin stop').slice(0, 200), `admin:${a.adminId}`]);
      await audit(a, 'kill_switch.set', `${scope}:${scopeId}`, tenantId);
      return { stopped: { scope, id: scopeId } };
    });
    api.on('POST', '/admin/v1/resume', false, async ({ req, body }) => {
      const a = await authOf(req, 'superadmin');
      const scope = String(body.scope ?? 'global');
      const scopeId = scope === 'global' ? '*' : String(body.id ?? '');
      const r = await sql.query<{ tenant_id: string | null }>('UPDATE kill_switches SET active = false WHERE scope = $1 AND scope_id = $2 AND active RETURNING tenant_id', [scope, scopeId]);
      if (!r.rowCount) throw new HttpError(404, 'not_found', 'no active stop');
      await audit(a, 'kill_switch.cleared', `${scope}:${scopeId}`, r.rows[0]!.tenant_id);
      return { resumed: { scope, id: scopeId } };
    });

    // Plans: prices and limits are data.
    api.on('GET', '/admin/v1/plans', false, async ({ req }) => {
      await authOf(req);
      return (await sql.query('SELECT code, name, price_agorot, limits, active, updated_at FROM plans ORDER BY price_agorot')).rows;
    });
    api.on('PUT', '/admin/v1/plans/:code', false, async ({ req, params, body }) => {
      const a = await authOf(req, 'superadmin');
      if (body.priceAgorot !== undefined && (!Number.isInteger(body.priceAgorot) || body.priceAgorot < 0)) throw new HttpError(400, 'bad_price', 'price must be whole agorot ≥ 0');
      if (body.limits !== undefined && (typeof body.limits !== 'object' || Array.isArray(body.limits))) throw new HttpError(400, 'bad_limits', 'limits must be an object');
      const r = await sql.query(
        `UPDATE plans SET name = COALESCE($2, name), price_agorot = COALESCE($3, price_agorot), limits = COALESCE($4, limits),
                active = COALESCE($5, active), updated_at = now() WHERE code = $1`,
        [params.code, body.name ?? null, body.priceAgorot ?? null, body.limits ?? null, body.active ?? null]);
      if (!r.rowCount) throw new HttpError(404, 'not_found', 'plan not found');
      await audit(a, 'plan.updated', String(params.code), null, { priceAgorot: body.priceAgorot, limits: body.limits, active: body.active });
      return { updated: true };
    });

    // Tickets (staff side).
    api.on('GET', '/admin/v1/tickets', false, async ({ req }) => {
      await authOf(req);
      const status = new URL(req.url ?? '/', 'http://x').searchParams.get('status');
      return (await sql.query(
        `SELECT k.id, k.tenant_id, t.name AS tenant_name, k.subject, k.category, k.status, k.updated_at FROM tickets k JOIN tenants t ON t.id = k.tenant_id
          WHERE ($1::text IS NULL AND k.status <> 'closed') OR k.status = $1 ORDER BY k.updated_at LIMIT 200`, [status])).rows;
    });
    api.on('GET', '/admin/v1/tickets/:id', false, async ({ req, params }) => {
      await authOf(req);
      const t = await sql.query('SELECT * FROM tickets WHERE id = $1', [params.id]);
      if (!t.rowCount) throw new HttpError(404, 'not_found', 'ticket not found');
      const m = await sql.query('SELECT author, body, created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY id', [params.id]);
      return { ...t.rows[0], messages: m.rows };
    });
    api.on('POST', '/admin/v1/tickets/:id/reply', false, async ({ req, params, body }) => {
      const a = await authOf(req);
      const text = String(body.body ?? '').trim();
      if (!text || text.length > 5000) throw new HttpError(400, 'bad_request', 'empty or too long');
      const t = await sql.query<{ tenant_id: string; subject: string }>('SELECT tenant_id, subject FROM tickets WHERE id = $1', [params.id]);
      const ticket = t.rows[0];
      if (!ticket) throw new HttpError(404, 'not_found', 'ticket not found');
      await sql.query('INSERT INTO ticket_messages (ticket_id, tenant_id, author, body) VALUES ($1, $2, $3, $4)', [params.id, ticket.tenant_id, `staff:${a.adminId}`, text]);
      await sql.query(`UPDATE tickets SET status = $2, updated_at = now() WHERE id = $1`, [params.id, body.close ? 'closed' : 'waiting_customer']);
      await sql.query('INSERT INTO notifications (tenant_id, kind, title, body, data) VALUES ($1, $2, $3, $4, $5)',
        [ticket.tenant_id, 'ticket_reply', 'התקבלה תשובה מהתמיכה', ticket.subject, { ticketId: params.id }]);
      return { replied: true };
    });

    // System message to customers (all active tenants, or a list).
    api.on('POST', '/admin/v1/broadcast', false, async ({ req, body }) => {
      const a = await authOf(req, 'superadmin');
      const title = String(body.title ?? '').trim().slice(0, 120);
      const text = String(body.body ?? '').trim().slice(0, 1000);
      if (!title || !text) throw new HttpError(400, 'bad_request', 'title and body required');
      const ids = Array.isArray(body.tenantIds) ? body.tenantIds.map(String) : null;
      if (ids && (ids.length > 10_000 || !ids.every((x: string) => /^[0-9a-f-]{36}$/i.test(x)))) throw new HttpError(400, 'bad_ids', 'tenantIds must be UUIDs');
      const r = await sql.query(
        `INSERT INTO notifications (tenant_id, kind, title, body) SELECT id, 'system', $1, $2 FROM tenants
          WHERE status = 'active' AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`, [title, text, ids ? `{${ids.join(',')}}` : null]);
      await audit(a, 'broadcast', title, null, { recipients: r.rowCount });
      return { sent: r.rowCount };
    });

    api.on('GET', '/admin/v1/audit', false, async ({ req }) => {
      await authOf(req);
      const tenant = new URL(req.url ?? '/', 'http://x').searchParams.get('tenant');
      return (await sql.query(`SELECT tenant_id, actor, action, target, detail, created_at FROM audit_log WHERE ($1::uuid IS NULL OR tenant_id = $1) ORDER BY id DESC LIMIT 200`, [tenant])).rows;
    });
  };
}
