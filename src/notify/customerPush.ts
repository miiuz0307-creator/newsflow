/**
 * Notifications to customers' devices (the PUSH app on their phone or computer):
 * alerts about their WhatsApp number and "what's new in PUSH". Devices are in
 * customer_push_subscriptions; the worker role reads them across tenants to send.
 */
import type { Sql } from '../db/pg.js';
import type { AdminNotice } from './adminPush.js';
import type { Notice, PushSender } from './notifications.js';
import { sendWebPush, type VapidKeys } from './webPush.js';

interface Log { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void }
type Row = { tenant_id: string; endpoint: string; p256dh: string; auth: string };

export class CustomerPush implements PushSender {
  constructor(
    private readonly sql: Sql,
    readonly keys: VapidKeys,
    private readonly subject: string,
    private readonly opts: { log?: Log; fetchImpl?: typeof fetch } = {},
  ) {}

  get publicKey(): string { return this.keys.publicKey; }

  /** NotificationService hook: connection and safety alerts for one customer. */
  async send(tenantId: string, n: Notice): Promise<void> {
    await this.sendToTenant(tenantId, { title: n.title, body: n.body, url: '/app', tag: n.kind });
  }

  async sendToTenant(tenantId: string, n: AdminNotice): Promise<{ sent: number; failed: number }> {
    const r = await this.sql.query<Row>('SELECT tenant_id, endpoint, p256dh, auth FROM customer_push_subscriptions WHERE tenant_id = $1', [tenantId]);
    return this.deliver(r.rows, n);
  }

  /** Every customer device of every active customer (for "what's new"). */
  async sendToAll(n: AdminNotice): Promise<{ sent: number; failed: number }> {
    const r = await this.sql.query<Row>(
      `SELECT s.tenant_id, s.endpoint, s.p256dh, s.auth FROM customer_push_subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE t.status = 'active'`);
    return this.deliver(r.rows, n);
  }

  private async deliver(rows: Row[], n: AdminNotice): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    // A few at a time: a release note can go to many devices.
    for (let i = 0; i < rows.length; i += 20) {
      await Promise.all(rows.slice(i, i + 20).map(async (row) => {
        try {
          const res = await sendWebPush({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, n, this.keys, this.subject, { fetchImpl: this.opts.fetchImpl });
          if (res.status >= 200 && res.status < 300) {
            sent++;
            await this.sql.query('UPDATE customer_push_subscriptions SET last_ok_at = now() WHERE tenant_id = $1 AND endpoint = $2', [row.tenant_id, row.endpoint]).catch(() => {});
          } else {
            failed++;
            if (res.gone) await this.sql.query('DELETE FROM customer_push_subscriptions WHERE tenant_id = $1 AND endpoint = $2', [row.tenant_id, row.endpoint]).catch(() => {});
            this.opts.log?.warn('customer push rejected', { host: new URL(row.endpoint).hostname, status: res.status, gone: res.gone });
          }
        } catch (e) {
          failed++;
          this.opts.log?.warn('customer push failed', { err: String(e).slice(0, 200) });
        }
      }));
    }
    if (rows.length) this.opts.log?.info('customer push', { title: n.title, sent, failed });
    return { sent, failed };
  }
}
