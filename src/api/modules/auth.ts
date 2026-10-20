/**
 * Sign-up, login, token refresh, logout, profile and account deletion.
 *
 * - Passwords: scrypt; minimal NIST-style policy (length + deny-list).
 * - Login: same response and timing whether or not the email exists; account
 *   lock after 5 failures (database), plus a per-IP limit (in memory).
 * - Tokens: short access token (15 min) + refresh token (30 days) stored as a
 *   hash and rotated on every use. Re-use of a rotated refresh token revokes
 *   all of that user's sessions (stolen-token detection).
 * - Account deletion: required by Google Play; removes the tenant's data and
 *   unlinks its WhatsApp numbers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { PgError } from '../../db/pg.js';
import { withTenant, type TenantKeys } from '../../db/pgStores.js';
import { DUMMY_HASH, checkPassword, hashPassword, verifyPassword } from '../../auth/password.js';
import { signToken, type TokenClaims } from '../auth.js';
import { HttpError, type ApiServer } from '../server.js';

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3_600_000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** Sliding-window counter per key (IP address). */
export class WindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  /** Returns false when the key is over the limit (and does not count the hit). */
  take(key: string): boolean {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface AuthModuleOptions {
  keys: TenantKeys;
  loginLimiter?: WindowLimiter;
  signupLimiter?: WindowLimiter;
}

export function authModule(opts: AuthModuleOptions) {
  const loginLimiter = opts.loginLimiter ?? new WindowLimiter(10, 60_000);
  const signupLimiter = opts.signupLimiter ?? new WindowLimiter(5, 3_600_000);

  return (api: ApiServer) => {
    const pool = api.o.appPool;
    const secret = api.o.tokenSecret;

    async function issueTokens(claims: Omit<TokenClaims, 'exp'>, userAgent: string | undefined) {
      const raw = randomBytes(32).toString('base64url');
      const refreshToken = `${claims.tenantId}.${raw}`;
      await withTenant(pool, claims.tenantId, (c) =>
        c.query('INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4, $5)', [
          claims.tenantId, claims.userId, sha256(refreshToken), new Date(Date.now() + REFRESH_TTL_MS), userAgent?.slice(0, 200) ?? null,
        ]));
      return { accessToken: signToken(claims, secret, ACCESS_TTL_S), refreshToken, expiresIn: ACCESS_TTL_S };
    }

    api.on('POST', '/v1/auth/signup', false, async ({ body, ip, req }) => {
      if (!signupLimiter.take(ip)) throw new HttpError(429, 'too_many', 'יותר מדי הרשמות מהכתובת הזו; נסה שוב מאוחר יותר');
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      const businessName = String(body.businessName ?? '').trim().slice(0, 100);
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'bad_email', 'כתובת האימייל אינה תקינה');
      if (!businessName) throw new HttpError(400, 'bad_name', 'יש להזין שם עסק או קבוצה');
      const problem = checkPassword(password, email);
      if (problem) throw new HttpError(400, problem.code, problem.message);
      if (body.acceptTerms !== true) throw new HttpError(400, 'terms_required', 'יש לאשר את תנאי השימוש ומדיניות הפרטיות');
      const hash = await hashPassword(password);
      let tenantId: string;
      try {
        tenantId = await opts.keys.provision(pool, businessName, 'trial', email, hash);
      } catch (e) {
        if (e instanceof PgError && e.code === '23505') throw new HttpError(409, 'email_taken', 'כבר קיים חשבון עם האימייל הזה');
        throw e;
      }
      const user = await withTenant(pool, tenantId, (c) => c.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email]));
      const userId = user.rows[0]!.id;
      if (body.displayName) {
        await withTenant(pool, tenantId, (c) => c.query('UPDATE users SET display_name = $2 WHERE id = $1', [userId, String(body.displayName).slice(0, 80)]));
      }
      return { tenantId, userId, ...(await issueTokens({ tenantId, userId, role: 'owner' }, req.headers['user-agent'])) };
    });

    api.on('POST', '/v1/auth/login', false, async ({ body, ip, req }) => {
      if (!loginLimiter.take(ip)) throw new HttpError(429, 'too_many', 'יותר מדי ניסיונות; נסה שוב בעוד דקה');
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      const r = await pool.query<{ user_id: string; tenant_id: string; password_hash: string; role: TokenClaims['role']; failed_logins: number; locked_until: Date | null; tenant_status: string }>(
        'SELECT * FROM auth_lookup($1)', [email]);
      const u = r.rows[0];
      const generic = new HttpError(401, 'bad_credentials', 'האימייל או הסיסמה שגויים');
      if (!u) {
        await verifyPassword(password, DUMMY_HASH); // same time as a real check
        throw generic;
      }
      if (u.locked_until && u.locked_until.getTime() > Date.now()) {
        throw new HttpError(429, 'locked', 'החשבון ננעל זמנית בגלל ניסיונות כושלים; נסה שוב מאוחר יותר', { until: u.locked_until });
      }
      const ok = await verifyPassword(password, u.password_hash);
      await pool.query('SELECT auth_record_attempt($1, $2)', [u.user_id, ok]);
      if (!ok) throw generic;
      if (u.tenant_status !== 'active') throw new HttpError(403, 'tenant_inactive', 'החשבון אינו פעיל; פנה לתמיכה');
      return { tenantId: u.tenant_id, userId: u.user_id, ...(await issueTokens({ tenantId: u.tenant_id, userId: u.user_id, role: u.role }, req.headers['user-agent'])) };
    });

    api.on('POST', '/v1/auth/refresh', false, async ({ body, req }) => {
      const token = String(body.refreshToken ?? '');
      const tenantId = token.split('.')[0] ?? '';
      const bad = new HttpError(401, 'bad_refresh', 'יש להתחבר מחדש');
      if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw bad;
      const found = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query<{ id: string; user_id: string; expires_at: Date; revoked_at: Date | null }>(
          'SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1', [sha256(token)]);
        const row = r.rows[0];
        if (!row) return null;
        if (row.revoked_at) {
          // A rotated token was used again: someone has a copy. End every session of this user.
          await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
          await c.query(`INSERT INTO audit_log (tenant_id, actor, action, target) VALUES ($1, 'system', 'auth.refresh_reuse', $2)`, [tenantId, row.user_id]);
          return null;
        }
        if (row.expires_at.getTime() < Date.now()) return null;
        await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
        const u = await c.query<{ role: TokenClaims['role'] }>('SELECT role FROM users WHERE id = $1', [row.user_id]);
        const t = await c.query<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [tenantId]);
        if (!u.rows[0] || t.rows[0]?.status !== 'active') return null;
        return { userId: row.user_id, role: u.rows[0].role };
      });
      if (!found) throw bad;
      return issueTokens({ tenantId, userId: found.userId, role: found.role }, req.headers['user-agent']);
    });

    api.on('POST', '/v1/auth/logout', true, async ({ auth, body }) => {
      const token = String(body.refreshToken ?? '');
      await api.tenantTx(auth!, (c) =>
        body.everywhere
          ? c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [auth!.userId])
          : c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND user_id = $2', [sha256(token), auth!.userId]));
      return { loggedOut: true };
    });

    api.on('GET', '/v1/me', true, async ({ auth }) =>
      api.tenantTx(auth!, async (c) => {
        const r = await c.query<{ email: string; display_name: string | null; role: string; name: string; plan_code: string; plan_name: string; limits: unknown; risk_accepted_at: Date | null }>(
          `SELECT u.email, u.display_name, u.role, t.name, t.plan_code, p.name AS plan_name, p.limits, t.risk_accepted_at
             FROM users u JOIN tenants t ON t.id = u.tenant_id JOIN plans p ON p.code = t.plan_code WHERE u.id = $1`, [auth!.userId]);
        const row = r.rows[0];
        if (!row) throw new HttpError(404, 'not_found', 'user not found');
        return {
          user: { id: auth!.userId, email: row.email, displayName: row.display_name, role: row.role },
          tenant: { id: auth!.tenantId, name: row.name, plan: { code: row.plan_code, name: row.plan_name, limits: row.limits }, riskAccepted: !!row.risk_accepted_at },
        };
      }));

    api.on('DELETE', '/v1/account', true, async ({ auth, req }) => {
      api.requireRole(auth!, 'owner');
      // DELETE carries no body in our router; the password comes in a header.
      const password = String(req.headers['x-confirm-password'] ?? '');
      const hash = await api.tenantTx(auth!, (c) => c.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [auth!.userId]));
      if (!(await verifyPassword(password, hash.rows[0]?.password_hash))) throw new HttpError(403, 'bad_password', 'הסיסמה שגויה');
      const accounts = await api.tenantTx(auth!, (c) => c.query<{ id: string }>('SELECT id FROM wa_accounts'));
      for (const a of accounts.rows) await api.o.connections.disconnectAndDelete(a.id).catch(() => {});
      await api.tenantTx(auth!, (c) => c.query('SELECT delete_my_tenant()'));
      return { deleted: true };
    });
  };
}
