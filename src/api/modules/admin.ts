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
import { DUMMY_HASH, verifyPassword } from '../../auth/password.js';
import { verifyTotp } from '../../auth/totp.js';
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

export interface AdminModuleOptions {
  adminPool: PgPool;
  /** Different from the customer token secret. ≥32 chars. */
  adminTokenSecret: string;
  loginLimiter?: WindowLimiter;
}

export function adminModule(opts: AdminModuleOptions) {
  if (opts.adminTokenSecret.length < 32) throw new Error('adminTokenSecret must be at least 32 characters');
  const limiter = opts.loginLimiter ?? new WindowLimiter(5, 5 * 60_000);
  const sql: Sql = opts.adminPool;

  const authOf = (req: http.IncomingMessage, need?: 'superadmin'): AdminClaims => {
    const h = req.headers.authorization ?? '';
    const c = h.startsWith('Bearer ') ? verifyAdminToken(h.slice(7), opts.adminTokenSecret) : null;
    if (!c) throw new HttpError(401, 'unauthorized', 'admin login required');
    if (need === 'superadmin' && c.role !== 'superadmin') throw new HttpError(403, 'forbidden_role', 'superadmin only');
    return c;
  };
  const audit = (a: AdminClaims, action: string, target: string, tenantId: string | null, detail: Record<string, unknown> = {}) =>
    sql.query('INSERT INTO audit_log (tenant_id, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5)', [tenantId, `admin:${a.adminId}`, action, target, detail]);

  return (api: ApiServer) => {
    api.on('POST', '/admin/v1/login', false, async ({ body, ip }) => {
      if (!limiter.take(ip)) throw new HttpError(429, 'too_many', 'too many attempts');
      const r = await sql.query<{ id: string; password_hash: string; totp_secret: string; role: AdminClaims['role']; active: boolean; locked_until: Date | null }>(
        'SELECT id, password_hash, totp_secret, role, active, locked_until FROM admins WHERE lower(email) = lower($1)', [String(body.email ?? '')]);
      const a = r.rows[0];
      const bad = new HttpError(401, 'bad_credentials', 'bad credentials');
      if (!a) {
        await verifyPassword(String(body.password ?? ''), DUMMY_HASH);
        throw bad;
      }
      if (!a.active || (a.locked_until && a.locked_until.getTime() > Date.now())) throw new HttpError(423, 'locked', 'account locked');
      const ok = (await verifyPassword(String(body.password ?? ''), a.password_hash)) && verifyTotp(a.totp_secret, String(body.code ?? ''));
      await sql.query(
        ok ? 'UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1'
          : `UPDATE admins SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '30 minutes' END WHERE id = $1`,
        [a.id]);
      if (!ok) throw bad;
      return { token: signAdminToken({ adminId: a.id, role: a.role }, opts.adminTokenSecret), role: a.role };
    });

    api.on('GET', '/admin/v1/dashboard', false, async ({ req }) => {
      authOf(req);
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
        server: { rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576), uptimeS: Math.round(process.uptime()) },
      };
    });

    api.on('GET', '/admin/v1/tenants', false, async ({ req }) => {
      authOf(req);
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '';
      const r = await sql.query(
        `SELECT t.id, t.name, t.plan_code, t.status, t.created_at,
                (SELECT min(email) FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner') AS owner_email,
                (SELECT count(*)::int FROM wa_accounts a WHERE a.tenant_id = t.id AND a.status <> 'deleted') AS numbers
           FROM tenants t
          WHERE t.status <> 'deleted' AND ($1 = '' OR t.name ILIKE '%' || $1 || '%'
                OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.email ILIKE '%' || $1 || '%'))
          ORDER BY t.created_at DESC LIMIT 100`, [q.slice(0, 100)]);
      return r.rows;
    });

    api.on('GET', '/admin/v1/tenants/:id', false, async ({ req, params }) => {
      authOf(req);
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
      return { tenant: t.rows[0], users: users.rows, whatsapp: accounts.rows, telegram: bots.rows, routes: routes.rows, jobs7d: jobs.rows, safetyEvents: safety.rows, activeStops: stops.rows };
    });

    api.on('POST', '/admin/v1/tenants/:id', false, async ({ req, params, body }) => {
      const a = authOf(req, 'superadmin');
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
      const a = authOf(req, 'superadmin');
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
      const a = authOf(req, 'superadmin');
      const scope = String(body.scope ?? 'global');
      const scopeId = scope === 'global' ? '*' : String(body.id ?? '');
      const r = await sql.query<{ tenant_id: string | null }>('UPDATE kill_switches SET active = false WHERE scope = $1 AND scope_id = $2 AND active RETURNING tenant_id', [scope, scopeId]);
      if (!r.rowCount) throw new HttpError(404, 'not_found', 'no active stop');
      await audit(a, 'kill_switch.cleared', `${scope}:${scopeId}`, r.rows[0]!.tenant_id);
      return { resumed: { scope, id: scopeId } };
    });

    // Plans: prices and limits are data.
    api.on('GET', '/admin/v1/plans', false, async ({ req }) => {
      authOf(req);
      return (await sql.query('SELECT code, name, price_agorot, limits, active, updated_at FROM plans ORDER BY price_agorot')).rows;
    });
    api.on('PUT', '/admin/v1/plans/:code', false, async ({ req, params, body }) => {
      const a = authOf(req, 'superadmin');
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
      authOf(req);
      const status = new URL(req.url ?? '/', 'http://x').searchParams.get('status');
      return (await sql.query(
        `SELECT k.id, k.tenant_id, t.name AS tenant_name, k.subject, k.category, k.status, k.updated_at FROM tickets k JOIN tenants t ON t.id = k.tenant_id
          WHERE ($1::text IS NULL AND k.status <> 'closed') OR k.status = $1 ORDER BY k.updated_at LIMIT 200`, [status])).rows;
    });
    api.on('GET', '/admin/v1/tickets/:id', false, async ({ req, params }) => {
      authOf(req);
      const t = await sql.query('SELECT * FROM tickets WHERE id = $1', [params.id]);
      if (!t.rowCount) throw new HttpError(404, 'not_found', 'ticket not found');
      const m = await sql.query('SELECT author, body, created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY id', [params.id]);
      return { ...t.rows[0], messages: m.rows };
    });
    api.on('POST', '/admin/v1/tickets/:id/reply', false, async ({ req, params, body }) => {
      const a = authOf(req);
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
      const a = authOf(req, 'superadmin');
      const title = String(body.title ?? '').trim().slice(0, 120);
      const text = String(body.body ?? '').trim().slice(0, 1000);
      if (!title || !text) throw new HttpError(400, 'bad_request', 'title and body required');
      const ids = Array.isArray(body.tenantIds) ? body.tenantIds.map(String) : null;
      const r = await sql.query(
        `INSERT INTO notifications (tenant_id, kind, title, body) SELECT id, 'system', $1, $2 FROM tenants
          WHERE status = 'active' AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`, [title, text, ids ? `{${ids.join(',')}}` : null]);
      await audit(a, 'broadcast', title, null, { recipients: r.rowCount });
      return { sent: r.rowCount };
    });

    api.on('GET', '/admin/v1/audit', false, async ({ req }) => {
      authOf(req);
      const tenant = new URL(req.url ?? '/', 'http://x').searchParams.get('tenant');
      return (await sql.query(`SELECT tenant_id, actor, action, target, detail, created_at FROM audit_log WHERE ($1::uuid IS NULL OR tenant_id = $1) ORDER BY id DESC LIMIT 200`, [tenant])).rows;
    });
  };
}
