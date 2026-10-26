/**
 * Customer notifications in the app (/v1/notify/*), "what's new" and the running version.
 */
import { checkPushSubscription } from '../../notify/adminPush.js';
import type { CustomerPush } from '../../notify/customerPush.js';
import { RELEASES } from '../../releases.js';
import { HttpError, type ApiServer } from '../server.js';

export function notifyPushModule(opts: { push?: CustomerPush; version: string; allowLocalEndpoints?: boolean }) {
  return (api: ApiServer) => {
    const push = opts.push;

    api.on('GET', '/v1/version', false, async () => ({ version: opts.version }));
    api.on('GET', '/v1/releases', false, async () => RELEASES.slice(0, 10));

    api.on('GET', '/v1/notify/push', true, async ({ auth }) => {
      if (!push) return { available: false };
      const n = await api.tenantTx(auth!, (c) => c.query<{ n: number }>('SELECT count(*)::int AS n FROM customer_push_subscriptions'));
      return { available: true, publicKey: push.publicKey, devices: n.rows[0]?.n ?? 0 };
    });

    api.on('POST', '/v1/notify/push/subscribe', true, async ({ auth, body, req }) => {
      if (!push) throw new HttpError(501, 'not_configured', 'התראות לא זמינות כרגע');
      const problem = checkPushSubscription(body.subscription, !!opts.allowLocalEndpoints);
      if (problem) throw new HttpError(400, 'bad_subscription', problem);
      const sub = body.subscription as { endpoint: string; keys: { p256dh: string; auth: string } };
      return api.tenantTx(auth!, async (c) => {
        await c.query(
          `INSERT INTO customer_push_subscriptions (tenant_id, endpoint, user_id, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
          [auth!.tenantId, sub.endpoint, auth!.userId, sub.keys.p256dh, sub.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 200) || null]);
        const n = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM customer_push_subscriptions');
        return { ok: true, devices: n.rows[0]?.n ?? 0 };
      });
    });

    api.on('POST', '/v1/notify/push/unsubscribe', true, async ({ auth, body }) =>
      api.tenantTx(auth!, async (c) => {
        if (typeof body.endpoint === 'string') await c.query('DELETE FROM customer_push_subscriptions WHERE endpoint = $1', [body.endpoint]);
        const n = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM customer_push_subscriptions');
        return { ok: true, devices: n.rows[0]?.n ?? 0 };
      }));

    api.on('POST', '/v1/notify/push/test', true, async ({ auth }) => {
      if (!push) throw new HttpError(501, 'not_configured', 'התראות לא זמינות כרגע');
      const r = await push.sendToTenant(auth!.tenantId, { title: 'התראת בדיקה מ‑PUSH', body: 'ההתראות עובדות. כך תדעו כשהמספר מתנתק או כשיש עדכון.', url: '/app', tag: 'test' });
      if (!r.sent) throw new HttpError(502, 'push_failed', r.failed ? 'שירות ההתראות של הדפדפן לא קיבל את ההודעה. נסו לכבות ולהפעיל מחדש.' : 'אין מכשיר רשום להתראות');
      return r;
    });
  };
}
