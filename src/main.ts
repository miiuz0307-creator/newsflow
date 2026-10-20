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
  PgAuthStore, PgDedupStore, PgJobQueue, PgKillSwitchStore, PgRouteSource, TenantKeys, recordConnectionEvent, recordSafetyEvent,
} from './db/pgStores.js';
import { CachedKillSwitches } from './delivery/killSwitch.js';
import { FileMediaStore } from './delivery/mediaStore.js';
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

const worker = new Worker({
  workerId: process.env.WORKER_ID ?? `${os.hostname()}-${process.pid}`,
  connections: conns,
  queue,
  routes: new PgRouteSource(workerPool),
  dedup: new PgDedupStore(workerPool),
  killSwitches,
  media: new FileMediaStore(process.env.MEDIA_DIR ?? './.media'),
  dailyCapFor: (accountId) => caps.get(accountId) ?? 100,
  onSafetyEvent: (e) => recordSafetyEvent(workerPool, e),
  onStatus: (e) => recordConnectionEvent(workerPool, e.state.tenantId, e.state.accountId, e.state.status, e.state.lastDisconnect?.reason),
  logger: log,
});

const api = new ApiServer({
  appPool, connections: conns, queue, killSwitches, tokenSecret: req('TOKEN_SECRET'),
  devTokens: cfg.env !== 'production' && process.env.DEV_TOKENS === '1', logger: log,
});

// Retention: clear old message content and expired duplicate keys every hour.
setInterval(() => void workerPool.query('SELECT * FROM purge_expired(7)').catch((e) => log.error('purge failed', { err: String(e) })), 3_600_000).unref();

await api.listen(cfg.apiPort, process.env.API_HOST ?? '127.0.0.1');
worker.dispatcher.start();
log.info('started', { api: api.url, waMode: mode });

async function shutdown(signal: string) {
  log.info('shutting down', { signal });
  await api.close();
  await worker.shutdown();
  await Promise.all([appPool.end(), workerPool.end()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
