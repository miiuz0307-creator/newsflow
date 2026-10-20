/**
 * Customer support and notifications (customer side). Staff handle tickets
 * through the admin API.
 */
import { HttpError, type ApiServer } from '../server.js';

const CATEGORIES = ['general', 'connection', 'billing', 'bug', 'other'];

export function supportModule(opts: { onNewTicket?: (tenantId: string, ticketId: string) => void } = {}) {
  return (api: ApiServer) => {
    api.on('POST', '/v1/tickets', true, async ({ auth, body }) => {
      const subject = String(body.subject ?? '').trim().slice(0, 150);
      const text = String(body.body ?? '').trim();
      if (!subject || !text) throw new HttpError(400, 'bad_request', 'יש למלא נושא ותיאור');
      if (text.length > 5000) throw new HttpError(400, 'too_long', 'התיאור ארוך מדי');
      const category = CATEGORIES.includes(body.category) ? body.category : 'general';
      const id = await api.tenantTx(auth!, async (c) => {
        const open = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM tickets WHERE status <> 'closed'`);
        if (open.rows[0]!.n >= 20) throw new HttpError(429, 'too_many_open', 'יש יותר מדי פניות פתוחות');
        const r = await c.query<{ id: string }>(`INSERT INTO tickets (tenant_id, user_id, subject, category, status) VALUES ($1, $2, $3, $4, 'waiting_support') RETURNING id`,
          [auth!.tenantId, auth!.userId, subject, category]);
        await c.query('INSERT INTO ticket_messages (ticket_id, tenant_id, author, body) VALUES ($1, $2, $3, $4)', [r.rows[0]!.id, auth!.tenantId, `customer:${auth!.userId}`, text]);
        return r.rows[0]!.id;
      });
      opts.onNewTicket?.(auth!.tenantId, id);
      return { id };
    });

    api.on('GET', '/v1/tickets', true, async ({ auth }) =>
      api.tenantTx(auth!, async (c) => (await c.query('SELECT id, subject, category, status, created_at, updated_at FROM tickets ORDER BY updated_at DESC LIMIT 100')).rows));

    api.on('GET', '/v1/tickets/:id', true, async ({ auth, params }) =>
      api.tenantTx(auth!, async (c) => {
        const t = await c.query('SELECT id, subject, category, status, created_at, updated_at FROM tickets WHERE id = $1', [params.id]);
        if (!t.rowCount) throw new HttpError(404, 'not_found', 'ticket not found');
        const m = await c.query<{ author: string; body: string; created_at: Date }>('SELECT author, body, created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY id', [params.id]);
        // Staff identities stay internal; the customer sees "support".
        return { ...t.rows[0], messages: m.rows.map((x) => ({ from: x.author.startsWith('staff:') ? 'support' : 'me', body: x.body, at: x.created_at })) };
      }));

    api.on('POST', '/v1/tickets/:id/messages', true, async ({ auth, params, body }) =>
      api.tenantTx(auth!, async (c) => {
        const text = String(body.body ?? '').trim();
        if (!text || text.length > 5000) throw new HttpError(400, 'bad_request', 'הודעה ריקה או ארוכה מדי');
        const t = await c.query<{ status: string }>('SELECT status FROM tickets WHERE id = $1', [params.id]);
        if (!t.rowCount) throw new HttpError(404, 'not_found', 'ticket not found');
        await c.query('INSERT INTO ticket_messages (ticket_id, tenant_id, author, body) VALUES ($1, $2, $3, $4)', [params.id, auth!.tenantId, `customer:${auth!.userId}`, text]);
        await c.query(`UPDATE tickets SET status = 'waiting_support', updated_at = now() WHERE id = $1`, [params.id]);
        return { sent: true };
      }));

    api.on('POST', '/v1/tickets/:id/close', true, async ({ auth, params }) =>
      api.tenantTx(auth!, async (c) => {
        const r = await c.query(`UPDATE tickets SET status = 'closed', updated_at = now() WHERE id = $1`, [params.id]);
        if (!r.rowCount) throw new HttpError(404, 'not_found', 'ticket not found');
        return { closed: true };
      }));

    // ---------------- notifications
    api.on('GET', '/v1/notifications', true, async ({ auth, req }) => {
      const unread = new URL(req.url ?? '/', 'http://x').searchParams.get('unread') === '1';
      return api.tenantTx(auth!, async (c) =>
        (await c.query(`SELECT id, kind, title, body, data, read_at, created_at FROM notifications ${unread ? 'WHERE read_at IS NULL' : ''} ORDER BY id DESC LIMIT 100`)).rows);
    });
    api.on('POST', '/v1/notifications/:id/read', true, async ({ auth, params }) =>
      api.tenantTx(auth!, async (c) => {
        await c.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL', [params.id]);
        return { read: true };
      }));
    api.on('POST', '/v1/notifications/read-all', true, async ({ auth }) =>
      api.tenantTx(auth!, async (c) => {
        const r = await c.query('UPDATE notifications SET read_at = now() WHERE read_at IS NULL');
        return { read: r.rowCount };
      }));
  };
}
