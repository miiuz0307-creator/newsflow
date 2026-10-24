/**
 * Process entry point: API + one delivery worker in one process (phase 1/2).
 * Later phases split API and workers into separate deployments.
 *
 * Environment:
 *   APP_ENV                development | staging | production
 *   DATABASE_URL_APP       postgres://newsflow_app:...@host/db
 *   DATABASE_URL_WORKER    postgres://newsflow_worker:...@host/db
 *   MASTER_KEY             32 bytes base64 (from a secrets manager)
 *   MASTER_KEY_ID          e.g. mk-2026-10
 *   TOKEN_SECRET           ≥32 chars
 *   WA_MODE                fake | baileys   (baileys also needs ALLOW_REAL_WHATSAPP=1)
 *   MEDIA_DIR              where media waits before sending (dev); object storage later
 *   API_PORT               default 8787
 *   DEV_TOKENS             1 to enable /v1/dev/token (never in production)
 */
import os from 'node:os';
import { ApiServer } from './api/server.js';
import { loadConfig } from './config.js';
import { MasterKey } from './crypto/keyring.js';
import { PgPool } from './db/pg.js';
import {
  PgAuthStore, PgDedupStore, PgJobQueue, PgKillSwitchStore, PgRouteSource, PgSourceMessageStore, TenantKeys, linkedAccounts, recordConnectionEvent, recordSafetyEvent,
} from './db/pgStores.js';
import { CachedKillSwitches } from './delivery/killSwitch.js';
import { FileMediaStore } from './delivery/mediaStore.js';
import { adminModule } from './api/modules/admin.js';
import { authModule } from './api/modules/auth.js';
import { manageModule } from './api/modules/manage.js';
import { supportModule } from './api/modules/support.js';
import { pushModule } from './api/modules/push.js';
import { fontsModule } from './api/fonts.js';
import { NotificationService, noticeForSafety, noticeForStatus } from './notify/notifications.js';
import { TelegramRuntime } from './telegram/runtime.js';
import { CachedRouteSource } from './engine/routeCache.js';
import { Worker } from './engine/worker.js';
import { createLogger } from './logger.js';
import { baileysTransportFactory } from './wa/baileysTransport.js';
import { ConnectionManager } from './wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from './wa/fakeNetwork.js';

const cfg = loadConfig();
const log = createLogger({ service: 'newsflow', env: cfg.env });
const req = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const appPool = PgPool.fromUrl(req('DATABASE_URL_APP'), 10);
const workerPool = PgPool.fromUrl(req('DATABASE_URL_WORKER'), 10);
const keys = new TenantKeys(new MasterKey(cfg.masterKeyId, req('MASTER_KEY')), workerPool);

const mode = process.env.WA_MODE ?? 'fake';
if (mode === 'baileys' && cfg.env === 'production' && !cfg.allowRealWhatsApp) {
  throw new Error('WA_MODE=baileys needs ALLOW_REAL_WHATSAPP=1');
}
const transportFactory = mode === 'baileys'
  ? baileysTransportFactory({ allowReal: cfg.allowRealWhatsApp, logger: log })
  : fakeTransportFactory(new FakeWaNetwork());

const conns = new ConnectionManager({
  transportFactory,
  storeFactory: async (tenantId, accountId) => new PgAuthStore(workerPool, tenantId, accountId, await keys.cipher(tenantId)),
  logger: log,
});

const killSwitches = new CachedKillSwitches(new PgKillSwitchStore(workerPool));
const queue = new PgJobQueue(workerPool, appPool);

// Daily caps come from each tenant's plan; refreshed every few minutes.
let caps = new Map<string, number>();
async function refreshCaps() {
  const r = await workerPool.query<{ id: string; cap: number }>(
    `SELECT a.id, (p.limits->>'dailySends')::int AS cap FROM wa_accounts a JOIN tenants t ON t.id = a.tenant_id JOIN plans p ON p.code = t.plan_code
     UNION ALL SELECT b.id, (p.limits->>'dailySends')::int FROM tg_bots b JOIN tenants t ON t.id = b.tenant_id JOIN plans p ON p.code = t.plan_code`);
  caps = new Map(r.rows.map((x) => [x.id, x.cap]));
}
await refreshCaps();
setInterval(() => void refreshCaps().catch((e) => log.error('caps refresh failed', { err: String(e) })), 5 * 60_000).unref();

const notifications = new NotificationService(workerPool);
const routeSource = new CachedRouteSource(new PgRouteSource(workerPool));

const worker = new Worker({
  workerId: process.env.WORKER_ID ?? `${os.hostname()}-${process.pid}`,
  connections: conns,
  queue,
  routes: routeSource,
  dedup: new PgDedupStore(workerPool),
  killSwitches,
  media: new FileMediaStore(process.env.MEDIA_DIR ?? './.media'),
  sources: new PgSourceMessageStore(workerPool),
  dailyCapFor: (accountId) => caps.get(accountId) ?? 100,
  onSafetyEvent: async (e) => {
    await recordSafetyEvent(workerPool, e);
    await notifications.notify(noticeForSafety(e));
  },
  onStatus: async (e) => {
    await recordConnectionEvent(workerPool, e.state.tenantId, e.state.accountId, e.state.status, e.state.lastDisconnect?.reason, e.state.phoneNumber);
    await notifications.notify(noticeForStatus(e));
  },
  logger: log,
});

const telegram = new TelegramRuntime({
  workerSql: workerPool,
  keys,
  apiOptions: { apiBase: cfg.telegramApiBase, allowReal: cfg.allowRealTelegram },
  onMessage: (m) => worker.handleTelegram(m),
  onSync: (e) => worker.handleTelegramSync(e),
  onStarted: (acc) => worker.addTelegram(acc),
  onStopped: (id) => worker.removeTelegram(id),
  logger: log,
});
if (cfg.allowRealTelegram || !cfg.telegramApiBase.includes('api.telegram.org')) {
  log.info('telegram bots started', { count: await telegram.loadAll() });
}

// The Super Admin API runs only where its database role and secret are configured.
const adminModules = process.env.DATABASE_URL_ADMIN && process.env.ADMIN_TOKEN_SECRET
  ? [adminModule({ adminPool: PgPool.fromUrl(process.env.DATABASE_URL_ADMIN, 4), adminTokenSecret: process.env.ADMIN_TOKEN_SECRET, customerTokenSecret: req('TOKEN_SECRET'), masterKeyB64: req('MASTER_KEY') })]
  : [];

const api = new ApiServer({
  appPool, connections: conns, queue, killSwitches, tokenSecret: req('TOKEN_SECRET'),
  onRoutesChanged: () => routeSource.invalidate(),
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0),
  modules: [
    authModule({ keys, telegram, onRoutesChanged: () => routeSource.invalidate() }),
    manageModule({ keys, telegram, onRoutesChanged: () => routeSource.invalidate() }),
    supportModule(),
    pushModule({ onRoutesChanged: () => routeSource.invalidate() }),
    fontsModule(),
    ...adminModules,
  ],
  devTokens: cfg.env === 'development' && process.env.DEV_TOKENS === '1', logger: log,
});

// Media is only needed until its jobs are sent or skipped as stale (2 hours); keep 6 hours, then delete.
setInterval(() => void worker.media.sweep(6 * 3_600_000).catch((e) => log.error('media sweep failed', { err: String(e) })), 3_600_000).unref();

// Retention: clear old message content and expired duplicate keys every hour.
setInterval(() => void workerPool.query('SELECT * FROM purge_expired(7)').catch((e) => log.error('purge failed', { err: String(e) })), 3_600_000).unref();

await api.listen(cfg.apiPort, process.env.API_HOST ?? '127.0.0.1');
worker.dispatcher.start();
log.info('started', { api: api.url, waMode: mode });

// Earlier versions stopped sending on a number when a deploy briefly ran two servers on the
// same session ("replaced"). That was never a warning about the number: lift those stops.
{
  const r = await workerPool.query(
    `UPDATE kill_switches SET active = false WHERE active AND scope = 'account' AND set_by = 'system:auto' AND reason = 'connection: replaced'`);
  if (r.rowCount) log.info('lifted stops left by a deploy', { count: r.rowCount });
}

{
  const r = await workerPool.query<{ reads: number; copies: number }>(
    `SELECT (SELECT count(*)::int FROM message_reads WHERE read_at > now() - interval '24 hours') AS reads,
            (SELECT count(*)::int FROM outbound_jobs WHERE status = 'sent' AND sent_at > now() - interval '24 hours') AS copies`);
  log.info('last 24 hours', r.rows[0] ?? {});
}

// Reconnect the numbers that were linked before this restart (a deploy, a crash).
// During a deploy the previous server is still holding the WhatsApp session for a few
// seconds; waiting lets it close cleanly instead of the two replacing each other.
// Messages written in the meantime arrive as offline messages and are still distributed.
await new Promise((r) => setTimeout(r, Number(process.env.BOOT_RECONNECT_DELAY_MS ?? 8000)));
for (const a of await linkedAccounts(workerPool)) {
  try {
    await conns.connect(a.tenant_id, a.id, { method: 'qr' });
  } catch (e) {
    log.warn('could not reconnect a linked number', { accountId: a.id, err: String(e) });
  }
}

async function shutdown(signal: string) {
  log.info('shutting down', { signal });
  await api.close();
  await telegram.shutdown();
  await worker.shutdown();
  await Promise.all([appPool.end(), workerPool.end()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
