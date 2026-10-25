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
import { DUMMY_HASH, MAX_PASSWORD_LENGTH, PasswordBusyError, checkPassword, hashPassword, verifyPassword } from '../../auth/password.js';
import type { TelegramRuntime } from '../../telegram/runtime.js';
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

async function busy<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PasswordBusyError) throw new HttpError(503, 'busy', 'השרת עמוס; נסה שוב בעוד רגע');
    throw e;
  }
}

export interface AuthModuleOptions {
  keys: TenantKeys;
  /** Needed so account deletion also stops the tenant's Telegram bots. */
  telegram?: TelegramRuntime;
  onRoutesChanged?: () => void;
  loginLimiter?: WindowLimiter;
  signupLimiter?: WindowLimiter;
  /** Called after a customer signs up on their own (for example: notify the owner). Errors are ignored. */
  onSignup?: (t: { tenantId: string; businessName: string; email: string }) => void | Promise<void>;
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
      const hash = await busy(() => hashPassword(password));
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
      if (opts.onSignup) void Promise.resolve().then(() => opts.onSignup!({ tenantId, businessName, email })).catch(() => {});
      return { tenantId, userId, ...(await issueTokens({ tenantId, userId, role: 'owner' }, req.headers['user-agent'])) };
    });

    api.on('POST', '/v1/auth/login', false, async ({ body, ip, req }) => {
      if (!loginLimiter.take(ip)) throw new HttpError(429, 'too_many', 'יותר מדי ניסיונות; נסה שוב בעוד דקה');
      const email = String(body.email ?? '').trim().toLowerCase().slice(0, 320);
      const password = String(body.password ?? '');
      const generic = new HttpError(401, 'bad_credentials', 'האימייל או הסיסמה שגויים');
      if (password.length > MAX_PASSWORD_LENGTH) throw generic;
      // The attempt is counted first, atomically; a locked or unknown account returns no row.
      // Both cases answer exactly like a wrong password, after the same amount of work.
      const r = await pool.query<{ user_id: string; tenant_id: string; password_hash: string; role: TokenClaims['role']; tenant_status: string }>(
        'SELECT * FROM auth_begin_attempt($1)', [email]);
      const u = r.rows[0];
      if (!u) {
        await busy(() => verifyPassword(password, DUMMY_HASH));
        throw generic;
      }
      const ok = await busy(() => verifyPassword(password, u.password_hash));
      if (!ok) throw generic;
      await pool.query('SELECT auth_login_succeeded($1)', [u.user_id]);
      if (u.tenant_status !== 'active') throw new HttpError(403, 'tenant_inactive', 'החשבון אינו פעיל; פנה לתמיכה');
      return { tenantId: u.tenant_id, userId: u.user_id, ...(await issueTokens({ tenantId: u.tenant_id, userId: u.user_id, role: u.role }, req.headers['user-agent'])) };
    });

    api.on('POST', '/v1/auth/refresh', false, async ({ body, req }) => {
      const token = String(body.refreshToken ?? '');
      const tenantId = token.split('.')[0] ?? '';
      const bad = new HttpError(401, 'bad_refresh', 'יש להתחבר מחדש');
      if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw bad;
      const found = await withTenant(pool, tenantId, async (c) => {
        // Revoke-and-read in one statement: of several concurrent uses, exactly one wins.
        const won = await c.query<{ user_id: string }>(
          `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING user_id`,
          [sha256(token)]);
        if (!won.rows[0]) {
          const seen = await c.query<{ user_id: string; revoked_at: Date | null }>('SELECT user_id, revoked_at FROM refresh_tokens WHERE token_hash = $1', [sha256(token)]);
          if (seen.rows[0]?.revoked_at) {
            // A used token came back: someone has a copy. End every session of this user.
            await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [seen.rows[0].user_id]);
            await c.query(`INSERT INTO audit_log (tenant_id, actor, action, target) VALUES ($1, 'system', 'auth.refresh_reuse', $2)`, [tenantId, seen.rows[0].user_id]);
          }
          return null;
        }
        const userId = won.rows[0].user_id;
        const u = await c.query<{ role: TokenClaims['role'] }>('SELECT role FROM users WHERE id = $1', [userId]);
        const t = await c.query<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [tenantId]);
        if (!u.rows[0] || t.rows[0]?.status !== 'active') return null;
        return { userId, role: u.rows[0].role };
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

    // POST (not DELETE) so the password travels in the body, never in a header that proxies may log.
    api.on('POST', '/v1/account/delete', true, async ({ auth, body }) => {
      api.requireRole(auth!, 'owner');
      const password = String(body.password ?? '');
      const hash = await api.tenantTx(auth!, (c) => c.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [auth!.userId]));
      if (!(await busy(() => verifyPassword(password, hash.rows[0]?.password_hash)))) throw new HttpError(403, 'bad_password', 'הסיסמה שגויה');
      const owned = await api.tenantTx(auth!, async (c) => ({
        wa: (await c.query<{ id: string }>('SELECT id FROM wa_accounts')).rows.map((r) => r.id),
        tg: (await c.query<{ id: string }>('SELECT id FROM tg_bots')).rows.map((r) => r.id),
      }));
      for (const id of owned.wa) await api.o.connections.disconnectAndDelete(id).catch(() => {});
      for (const id of owned.tg) await opts.telegram?.stop(id).catch(() => {});
      await api.tenantTx(auth!, (c) => c.query('SELECT delete_my_tenant()'));
      opts.keys.forget(auth!.tenantId);
      opts.onRoutesChanged?.();
      return { deleted: true };
    });
  };
}
