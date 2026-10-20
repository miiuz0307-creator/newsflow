/**
 * Phase 1 development API (node:http, no framework).
 *
 * Enough to run the feasibility test end to end: link a number (QR or
 * pairing code) and watch its status live, list its groups, save a route,
 * approve held messages, and pull emergency stops. Every request runs in a
 * tenant-scoped database transaction (RLS), and every sensitive action is
 * written to the audit log.
 *
 * Phase 3 replaces the dev token endpoint with real sign-up/login and adds
 * the rest of the product API; the handlers here are kept small so they move
 * over as they are.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PgPool, Sql } from '../db/pg.js';
import { PgError } from '../db/pg.js';
import { saveRoute, withTenant } from '../db/pgStores.js';
import type { JobQueue } from '../delivery/queue.js';
import type { KillSwitchStore } from '../delivery/killSwitch.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import { findRouteCycle, validateRoute } from '../routing/router.js';
import type { ChatRef } from '../core/types.js';
import { placeholdersOf, renderTemplate } from '../routing/template.js';
import type { Route } from '../routing/types.js';
import type { ConnectionManager, StatusEvent } from '../wa/connectionManager.js';
import { normalizePhone } from '../wa/transport.js';
import { signToken, verifyToken, type TokenClaims } from './auth.js';

export interface ApiOptions {
  appPool: PgPool;
  connections: ConnectionManager;
  queue: JobQueue;
  killSwitches: KillSwitchStore;
  tokenSecret: string;
  /** Enables POST /v1/dev/token. Never on in production. */
  devTokens?: boolean;
  logger?: Logger;
  /** Called after routes change, e.g. to clear the worker's route cache. */
  onRoutesChanged?: () => void;
  /** Feature modules that add routes (auth, telegram, support, admin…). */
  modules?: ((api: ApiServer) => void)[];
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export type Handler = (ctx: { req: http.IncomingMessage; res: http.ServerResponse; params: Record<string, string>; body: any; auth: TokenClaims | null; ip: string }) => Promise<unknown>;

interface RouteDef {
  method: string;
  pattern: RegExp;
  keys: string[];
  auth: boolean;
  handler: Handler;
}

const UUID_RE = '[0-9a-fA-F-]{36}';

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const re = path.replace(/:(\w+)/g, (_, k: string) => {
    keys.push(k);
    return k === 'id' || k.endsWith('Id') ? `(${UUID_RE}|\\d+)` : '([^/]+)';
  });
  return { pattern: new RegExp(`^${re}$`), keys };
}

async function readJson(req: http.IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'too_large', 'request body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'body is not valid JSON');
  }
}

/** Public view of an account state: never includes credentials. */
function accountView(s: StatusEvent['state'] | undefined) {
  if (!s) return null;
  return {
    id: s.accountId,
    status: s.status,
    phoneNumber: s.phoneNumber ?? null,
    lastConnectedAt: s.lastConnectedAt ?? null,
    lastDisconnect: s.lastDisconnect ?? null,
    qr: s.qr ?? null,
    pairingCode: s.pairingCode ?? null,
  };
}

export class ApiServer {
  private server?: http.Server;
  private readonly routes: RouteDef[] = [];
  private readonly sse = new Map<string, Set<http.ServerResponse>>();
  private readonly log: Logger;
  url = '';

  constructor(readonly o: ApiOptions) {
    this.log = (o.logger ?? silentLogger).child({ component: 'api' });
    if (o.tokenSecret.length < 32) throw new Error('tokenSecret must be at least 32 characters');
    this.define();
    for (const m of o.modules ?? []) m(this);
    o.connections.onStatus((e) => this.pushStatus(e));
  }

  /** Registers a route. Used by the feature modules in src/api/modules. */
  on(method: string, path: string, auth: boolean, handler: Handler) {
    this.routes.push({ method, ...compile(path), auth, handler });
  }

  tenantTx<T>(auth: TokenClaims, fn: (c: Sql) => Promise<T>): Promise<T> {
    return withTenant(this.o.appPool, auth.tenantId, fn);
  }

  async audit(c: Sql, auth: TokenClaims, action: string, target: string, detail: Record<string, unknown> = {}) {
    await c.query('INSERT INTO audit_log (tenant_id, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5)', [auth.tenantId, `user:${auth.userId}`, action, target, detail]);
  }

  /** Throws 403 unless the caller has one of the roles. */
  requireRole(auth: TokenClaims, ...roles: TokenClaims['role'][]) {
    if (!roles.includes(auth.role)) throw new HttpError(403, 'forbidden_role', 'אין לך הרשאה לפעולה הזו');
  }

  /** Confirms the account belongs to the caller's tenant (RLS returns nothing otherwise). */
  async ownAccount(auth: TokenClaims, id: string, includeTelegram = false) {
    const sql = includeTelegram ? 'SELECT id FROM wa_accounts WHERE id = $1 UNION SELECT id FROM tg_bots WHERE id = $1' : 'SELECT id FROM wa_accounts WHERE id = $1';
    const r = await this.tenantTx(auth, (c) => c.query<{ id: string }>(sql, [id]));
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'account not found');
  }

  private define() {
    const o = this.o;

    this.on('GET', '/v1/health', false, async () => ({ ok: true }));

    this.on('POST', '/v1/dev/token', false, async ({ body }) => {
      if (!o.devTokens) throw new HttpError(404, 'not_found', 'not found');
      const tenantId = String(body.tenantId ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new HttpError(400, 'bad_request', 'tenantId required');
      return { token: signToken({ tenantId, userId: String(body.userId ?? 'dev'), role: 'owner' }, o.tokenSecret, 8 * 3600) };
    });

    // --- risk acceptance (required before the first WhatsApp link)
    this.on('POST', '/v1/risk/accept', true, async ({ auth }) =>
      this.tenantTx(auth!, async (c) => {
        await c.query('UPDATE tenants SET risk_accepted_at = now() WHERE id = $1 AND risk_accepted_at IS NULL', [auth!.tenantId]);
        await this.audit(c, auth!, 'risk.accepted', auth!.tenantId);
        return { accepted: true };
      }));

    // --- WhatsApp accounts
    this.on('POST', '/v1/wa/accounts', true, async ({ auth, body }) =>
      this.tenantTx(auth!, async (c) => {
        const t = await c.query<{ limits: { waAccounts: number } }>('SELECT p.limits FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.id = $1', [auth!.tenantId]);
        const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM wa_accounts WHERE status <> 'deleted'`);
        if (n.rows[0]!.n >= (t.rows[0]?.limits.waAccounts ?? 1)) throw new HttpError(403, 'plan_limit', 'המסלול שלך לא מאפשר מספרים נוספים');
        const r = await c.query<{ id: string }>('INSERT INTO wa_accounts (tenant_id, label) VALUES ($1, $2) RETURNING id', [auth!.tenantId, String(body.label ?? '').slice(0, 60)]);
        await this.audit(c, auth!, 'wa_account.created', r.rows[0]!.id);
        return { id: r.rows[0]!.id };
      }));

    this.on('POST', '/v1/wa/accounts/:id/connect', true, async ({ auth, params, body }) => {
      await this.ownAccount(auth!, params.id!);
      const accepted = await this.tenantTx(auth!, (c) => c.query<{ risk_accepted_at: Date | null }>('SELECT risk_accepted_at FROM tenants WHERE id = $1', [auth!.tenantId]));
      if (!accepted.rows[0]?.risk_accepted_at) throw new HttpError(412, 'risk_not_accepted', 'יש לאשר את הסבר הסיכונים לפני חיבור מספר');
      const method = body.method === 'pairing_code' ? 'pairing_code' : 'qr';
      let phoneNumber: string | undefined;
      if (method === 'pairing_code') {
        try {
          phoneNumber = normalizePhone(String(body.phoneNumber ?? ''));
        } catch (e) {
          throw new HttpError(400, 'bad_phone', (e as Error).message);
        }
      }
      const state = await o.connections.connect(auth!.tenantId, params.id!, { method, ...(phoneNumber ? { phoneNumber } : {}) });
      await this.tenantTx(auth!, (c) => this.audit(c, auth!, 'wa_account.connect', params.id!, { method }));
      return accountView(state);
    });

    this.on('GET', '/v1/wa/accounts/:id', true, async ({ auth, params }) => {
      await this.ownAccount(auth!, params.id!);
      const live = o.connections.getState(params.id!);
      if (live) return accountView(live);
      const r = await this.tenantTx(auth!, (c) => c.query('SELECT id, status, phone_number, last_connected_at, last_disconnect_reason FROM wa_accounts WHERE id = $1', [params.id]));
      return r.rows[0];
    });

    this.on('GET', '/v1/wa/accounts/:id/events', true, async ({ auth, params, res }) => {
      await this.ownAccount(auth!, params.id!);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify(accountView(o.connections.getState(params.id!)))}\n\n`);
      let set = this.sse.get(params.id!);
      if (!set) this.sse.set(params.id!, (set = new Set()));
      set.add(res);
      res.on('close', () => set!.delete(res));
      return undefined; // streaming
    });

    this.on('GET', '/v1/wa/accounts/:id/chats', true, async ({ auth, params }) => {
      await this.ownAccount(auth!, params.id!);
      const chats = await o.connections.listChats(params.id!);
      // Cache in the database so route validation and the app can use it.
      await this.tenantTx(auth!, async (c) => {
        for (const ch of chats) {
          await c.query(
            `INSERT INTO chats (tenant_id, platform, account_id, chat_id, title, type, can_send, is_admin, participant_count, updated_at)
             VALUES ($1, 'wa', $2, $3, $4, $5, $6, $7, $8, now())
             ON CONFLICT (platform, account_id, chat_id) DO UPDATE SET title = EXCLUDED.title, type = EXCLUDED.type,
               can_send = EXCLUDED.can_send, is_admin = EXCLUDED.is_admin, participant_count = EXCLUDED.participant_count, updated_at = now()`,
            [auth!.tenantId, params.id, ch.ref.chatId, ch.title, ch.type, ch.canSend, ch.isAdmin, ch.participantCount ?? null],
          );
        }
      });
      return chats.map((c) => ({ chatId: c.ref.chatId, title: c.title, type: c.type, canSend: c.canSend, isAdmin: c.isAdmin, participantCount: c.participantCount ?? null }));
    });

    this.on('DELETE', '/v1/wa/accounts/:id', true, async ({ auth, params }) => {
      await this.ownAccount(auth!, params.id!);
      await o.connections.disconnectAndDelete(params.id!);
      await this.tenantTx(auth!, async (c) => {
        await c.query('DELETE FROM wa_auth WHERE account_id = $1', [params.id]);
        await c.query(`UPDATE wa_accounts SET status = 'deleted', phone_number = NULL WHERE id = $1`, [params.id]);
        // Nothing may still try to send through, or listen on, a deleted number.
        await c.query(`UPDATE outbound_jobs SET status = 'cancelled', updated_at = now() WHERE target_account_id = $1 AND status IN ('queued', 'pending_approval')`, [params.id]);
        await c.query(`UPDATE routes SET enabled = false, updated_at = now() WHERE id IN (
                         SELECT route_id FROM route_sources WHERE account_id = $1 UNION SELECT route_id FROM route_targets WHERE account_id = $1)`, [params.id]);
        await this.audit(c, auth!, 'wa_account.deleted', params.id!);
      });
      return { deleted: true };
    });

    // --- templates
    this.on('POST', '/v1/templates/preview', true, async ({ body }) => {
      const r = renderTemplate({ body: String(body.body ?? ''), vars: (body.vars ?? {}) as Record<string, string> }, {
        content: String(body.sampleContent ?? 'דוגמה לתוכן החדשות'), groupName: String(body.groupName ?? 'שם הקבוצה'),
        platform: body.platform === 'tg' ? 'tg' : 'wa', isCaption: false,
      });
      return { ...r, placeholders: placeholdersOf(String(body.body ?? '')) };
    });

    this.on('POST', '/v1/templates', true, async ({ auth, body }) =>
      this.tenantTx(auth!, async (c) => {
        const r = await c.query<{ id: string }>('INSERT INTO templates (tenant_id, name, body, vars) VALUES ($1, $2, $3, $4) RETURNING id',
          [auth!.tenantId, String(body.name ?? 'תבנית'), String(body.body ?? '{content}'), body.vars ?? {}]);
        return { id: r.rows[0]!.id };
      }));

    // --- routes
    this.on('POST', '/v1/routes', true, async ({ auth, body }) =>
      this.tenantTx(auth!, async (c) => {
        const route = body as Omit<Route, 'id' | 'tenantId'> & { id?: string };
        if (!Array.isArray(route.sources) || !Array.isArray(route.targets)) throw new HttpError(400, 'bad_request', 'sources and targets are required');
        const chats = await c.query<{ platform: string; account_id: string; chat_id: string; can_send: boolean; title: string }>('SELECT platform, account_id, chat_id, can_send, title FROM chats');
        const accounts = await c.query<{ id: string }>(`SELECT id FROM wa_accounts UNION SELECT id FROM tg_bots`);
        const limits = await c.query<{ limits: { targets: number } }>('SELECT p.limits FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.id = $1', [auth!.tenantId]);
        const problems = validateRoute(route, {
          chats: new Map(chats.rows.map((r) => [`${r.platform}:${r.account_id}:${r.chat_id}`, { canSend: r.can_send, title: r.title }])),
          ownAccounts: new Set(accounts.rows.map((r) => r.id)),
          maxTargets: limits.rows[0]?.limits.targets ?? 3,
        });
        // A cycle across this tenant's routes would bounce messages forever.
        const others = await c.query<{ route_id: string; kind: 's' | 't'; platform: 'wa' | 'tg'; account_id: string; chat_id: string }>(
          `SELECT s.route_id, 's' AS kind, s.platform, s.account_id, s.chat_id FROM route_sources s JOIN routes r ON r.id = s.route_id WHERE r.enabled
           UNION ALL
           SELECT t.route_id, 't', t.platform, t.account_id, t.chat_id FROM route_targets t JOIN routes r ON r.id = t.route_id WHERE r.enabled`);
        const graph = new Map<string, { sources: ChatRef[]; targets: ChatRef[] }>();
        for (const row of others.rows) {
          if (row.route_id === route.id) continue;
          const g = graph.get(row.route_id) ?? { sources: [], targets: [] };
          (row.kind === 's' ? g.sources : g.targets).push({ platform: row.platform, accountId: row.account_id, chatId: row.chat_id });
          graph.set(row.route_id, g);
        }
        if (route.enabled !== false) {
          const cycle = findRouteCycle([...graph.values(), route]);
          if (cycle) problems.push({ code: 'route_cycle', message: 'המסלול יוצר מעגל עם מסלול קיים: הודעות היו חוזרות בלי סוף', chat: cycle.join(' → ') });
        }
        if (problems.length) throw new HttpError(422, 'invalid_route', 'המסלול אינו תקין', problems);
        const id = await saveRoute(c, auth!.tenantId, {
          ...route, enabled: route.enabled ?? true, requireApproval: !!route.requireApproval, filters: route.filters ?? {},
        });
        await this.audit(c, auth!, 'route.saved', id);
        o.onRoutesChanged?.();
        return { id };
      }));

    this.on('POST', '/v1/routes/:id/enabled', true, async ({ auth, params, body }) =>
      this.tenantTx(auth!, async (c) => {
        const r = await c.query('UPDATE routes SET enabled = $2, updated_at = now() WHERE id = $1', [params.id, !!body.enabled]);
        if (!r.rowCount) throw new HttpError(404, 'not_found', 'route not found');
        await this.audit(c, auth!, body.enabled ? 'route.enabled' : 'route.disabled', params.id!);
        o.onRoutesChanged?.();
        return { enabled: !!body.enabled };
      }));

    // --- approvals
    this.on('GET', '/v1/approvals', true, async ({ auth }) =>
      (await o.queue.listPendingApproval(auth!.tenantId)).map((j) => ({ id: j.id, target: j.target, text: j.content.text ?? '', kind: j.content.kind, createdAt: j.createdAt })));
    this.on('POST', '/v1/approvals/:id/approve', true, async ({ auth, params }) => {
      if (!(await o.queue.approve(auth!.tenantId, params.id!))) throw new HttpError(404, 'not_found', 'nothing to approve');
      return { approved: true };
    });
    this.on('POST', '/v1/approvals/:id/reject', true, async ({ auth, params }) => {
      if (!(await o.queue.reject(auth!.tenantId, params.id!))) throw new HttpError(404, 'not_found', 'nothing to reject');
      return { rejected: true };
    });

    // --- emergency stops (tenant / account / route; global is admin-only and not exposed here)
    this.on('POST', '/v1/stop', true, async ({ auth, body }) => {
      const scope = body.scope as 'tenant' | 'account' | 'route';
      if (!['tenant', 'account', 'route'].includes(scope)) throw new HttpError(400, 'bad_scope', 'scope must be tenant, account or route');
      const scopeId = scope === 'tenant' ? auth!.tenantId : String(body.id ?? '');
      if (scope === 'account') await this.ownAccount(auth!, scopeId, true);
      if (scope === 'route') {
        const r = await this.tenantTx(auth!, (c) => c.query('SELECT 1 FROM routes WHERE id = $1', [scopeId]));
        if (!r.rowCount) throw new HttpError(404, 'not_found', 'route not found');
      }
      await o.killSwitches.set({ scope, scopeId, tenantId: auth!.tenantId, reason: String(body.reason ?? 'stopped by customer').slice(0, 200), setBy: `user:${auth!.userId}` });
      return { stopped: { scope, id: scopeId } };
    });
    this.on('POST', '/v1/resume', true, async ({ auth, body }) => {
      const scope = body.scope as 'tenant' | 'account' | 'route';
      if (!['tenant', 'account', 'route'].includes(scope)) throw new HttpError(400, 'bad_scope', 'scope must be tenant, account or route');
      const scopeId = scope === 'tenant' ? auth!.tenantId : String(body.id ?? '');
      const own = (await o.killSwitches.list(auth!.tenantId)).find((s) => s.scope === scope && s.scopeId === scopeId && s.tenantId === auth!.tenantId);
      if (!own) throw new HttpError(404, 'not_found', 'no active stop');
      // Stops set by an administrator or by the system after a ban/rate-limit warning
      // are not lifted by the customer here: system stops need the account fixed first,
      // admin stops need an admin.
      if (!own.setBy.startsWith('user:')) {
        throw new HttpError(403, 'locked_stop', own.setBy.startsWith('admin') ? 'העצירה הופעלה על ידי מנהל המערכת' : 'העצירה הופעלה אוטומטית בגלל אזהרה; יש לפנות לתמיכה');
      }
      await o.killSwitches.clear(scope, scopeId, `user:${auth!.userId}`);
      return { resumed: { scope, id: scopeId } };
    });
    this.on('GET', '/v1/stops', true, async ({ auth }) =>
      (await o.killSwitches.list(auth!.tenantId)).map((s) => ({ scope: s.scope, id: s.scopeId, reason: s.reason, setBy: s.setBy, setAt: s.setAt })));

    // --- statistics (simple, from the queue)
    this.on('GET', '/v1/stats', true, async ({ auth }) =>
      this.tenantTx(auth!, async (c) => {
        const r = await c.query<{ status: string; n: number }>(
          `SELECT status, count(*)::int AS n FROM outbound_jobs WHERE created_at > now() - interval '24 hours' GROUP BY status`);
        return { last24h: Object.fromEntries(r.rows.map((x) => [x.status, x.n])) };
      }));
  }

  private pushStatus(e: StatusEvent) {
    const subs = this.sse.get(e.state.accountId);
    if (!subs?.size) return;
    const line = `event: status\ndata: ${JSON.stringify(accountView(e.state))}\n\n`;
    for (const res of subs) res.write(line);
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    try {
      const route = this.routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) throw new HttpError(404, 'not_found', 'not found');
      const m = route.pattern.exec(url.pathname)!;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      let auth: TokenClaims | null = null;
      if (route.auth) {
        const h = req.headers.authorization ?? '';
        // A token in the URL ends up in proxy and access logs, so it is accepted only for the
        // live-status stream (browsers' EventSource cannot send headers).
        const queryToken = url.pathname.endsWith('/events') ? url.searchParams.get('token') ?? '' : '';
        const token = h.startsWith('Bearer ') ? h.slice(7) : queryToken;
        auth = verifyToken(token, this.o.tokenSecret);
        if (!auth) throw new HttpError(401, 'unauthorized', 'missing or invalid token');
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'bad_request', 'body must be a JSON object');
      const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.socket.remoteAddress ?? '').trim();
      const out = await route.handler({ req, res, params, body, auth, ip });
      if (out === undefined && res.headersSent) return;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out ?? {}));
    } catch (e) {
      const err = e instanceof HttpError ? e
        : e instanceof PgError && e.code === '42501' ? new HttpError(403, 'forbidden', 'forbidden')
          : e instanceof PgError && (e.code === '22P02' || e.code === '22003') ? new HttpError(404, 'not_found', 'not found')
          : new HttpError(500, 'internal', 'internal error');
      if (err.status === 500) this.log.error('request failed', { path: url.pathname, err: String(e) });
      if (!res.headersSent) {
        res.writeHead(err.status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }));
      }
    }
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, host, r));
    this.url = `http://${host}:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async close(): Promise<void> {
    for (const set of this.sse.values()) for (const r of set) r.end();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }
}
