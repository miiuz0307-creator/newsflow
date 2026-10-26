/**
 * Notifications to the PUSH owner's own devices (the management panel), for example
 * "a new customer signed up". Devices are stored in admin_push_subscriptions.
 */
import type { Sql } from '../db/pg.js';
import { sendWebPush, type PushSubscriptionJson, type VapidKeys } from './webPush.js';

export interface AdminNotice {
  title: string;
  body: string;
  /** Opened when the notification is tapped (same site). */
  url?: string;
  /** Notifications with the same tag replace each other on the device. */
  tag?: string;
}

interface Log { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void }

/** Push services of the major browsers. Endpoints elsewhere are refused (the server POSTs to them). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

/** Checks a browser subscription before it is stored; returns an error message (Hebrew) or null. */
export function checkPushSubscription(sub: unknown, allowLocal = false): string | null {
  const s = sub as Partial<PushSubscriptionJson> | null;
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1000 || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return 'פרטי המכשיר חסרים';
  let u: URL;
  try { u = new URL(s.endpoint); } catch { return 'כתובת ההתראות של המכשיר לא תקינה'; }
  const local = allowLocal && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if (!local && (u.protocol !== 'https:' || !PUSH_HOSTS.some((r) => r.test(u.hostname)))) return 'שירות ההתראות של הדפדפן הזה לא נתמך';
  if (Buffer.from(s.keys.p256dh, 'base64url').length !== 65 || Buffer.from(s.keys.auth, 'base64url').length < 16) return 'מפתחות המכשיר לא תקינים';
  return null;
}

export class AdminPush {
  constructor(
    private readonly sql: Sql,
    readonly keys: VapidKeys,
    private readonly subject: string,
    private readonly opts: { log?: Log; fetchImpl?: typeof fetch; allowLocalEndpoints?: boolean } = {},
  ) {}

  get publicKey(): string { return this.keys.publicKey; }

  /** Checks a subscription sent by the panel; returns an error message (Hebrew) or null. */
  check(sub: unknown): string | null {
    return checkPushSubscription(sub, !!this.opts.allowLocalEndpoints);
  }

  async save(adminId: string, sub: PushSubscriptionJson, userAgent?: string): Promise<void> {
    await this.sql.query(
      `INSERT INTO admin_push_subscriptions (endpoint, admin_id, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET admin_id = EXCLUDED.admin_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [sub.endpoint, adminId, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 200) ?? null]);
  }

  async remove(adminId: string, endpoint: string): Promise<void> {
    await this.sql.query('DELETE FROM admin_push_subscriptions WHERE endpoint = $1 AND admin_id = $2', [endpoint, adminId]);
  }

  async devices(adminId: string): Promise<number> {
    const r = await this.sql.query<{ n: number }>('SELECT count(*)::int AS n FROM admin_push_subscriptions WHERE admin_id = $1', [adminId]);
    return r.rows[0]?.n ?? 0;
  }

  /** Sends to every device of active admins (or of one admin). Never throws. */
  async send(n: AdminNotice, adminId?: string): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    try {
      const r = await this.sql.query<{ endpoint: string; p256dh: string; auth: string }>(
        `SELECT s.endpoint, s.p256dh, s.auth FROM admin_push_subscriptions s JOIN admins a ON a.id = s.admin_id
          WHERE a.active AND ($1::uuid IS NULL OR s.admin_id = $1::uuid)`, [adminId ?? null]);
      await Promise.all(r.rows.map(async (row) => {
        try {
          const res = await sendWebPush({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, n, this.keys, this.subject, { fetchImpl: this.opts.fetchImpl });
          if (res.status >= 200 && res.status < 300) {
            sent++;
            await this.sql.query('UPDATE admin_push_subscriptions SET last_ok_at = now() WHERE endpoint = $1', [row.endpoint]);
          } else {
            failed++;
            if (res.gone) await this.sql.query('DELETE FROM admin_push_subscriptions WHERE endpoint = $1', [row.endpoint]);
            this.opts.log?.warn('admin push rejected', { host: new URL(row.endpoint).hostname, status: res.status, gone: res.gone, detail: res.detail });
          }
        } catch (e) {
          failed++;
          this.opts.log?.warn('admin push failed', { host: new URL(row.endpoint).hostname, err: String(e) });
        }
      }));
    } catch (e) {
      this.opts.log?.warn('admin push failed', { err: String(e) });
    }
    this.opts.log?.info('admin push', { title: n.title, sent, failed });
    return { sent, failed };
  }
}
