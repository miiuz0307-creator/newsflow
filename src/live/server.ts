/**
 * PUSH live server: the real product (src/main.ts) with REAL WhatsApp linking.
 *
 * Before starting the app it prepares its own database on the Postgres it is
 * given (roles, database "push_live", migrations), the same way the demo does,
 * so one Railway Postgres service is enough. Nothing here touches the demo or
 * any other system.
 *
 * Environment (Railway):
 *   DATABASE_URL   superuser URL of PUSH's own Postgres service
 *   LIVE_SECRET    ≥32 chars; the database role passwords are derived from it
 *   MASTER_KEY     32 bytes base64 (encrypts each customer's WhatsApp session)
 *   TOKEN_SECRET   ≥32 chars (sign-in tokens)
 *   PORT           set by Railway
 */
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { migrate } from '../db/migrate.js';
import { PgConnection, parseDatabaseUrl } from '../db/pg.js';
import { createLogger } from '../logger.js';

const log = createLogger({ service: 'push-live', env: 'production' });
const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is required`);
  return v;
};
const secret = need('LIVE_SECRET');
if (secret.length < 32) throw new Error('LIVE_SECRET must be at least 32 characters');
const derive = (label: string) => createHmac('sha256', secret).update(`push-live:${label}`).digest('base64url').slice(0, 32);

const su = parseDatabaseUrl(need('DATABASE_URL'));
const DB = 'push_live';
const pw = { owner: derive('owner'), app: derive('app'), worker: derive('worker'), admin: derive('admin') };
const root = process.env.APP_ROOT ?? process.cwd();

const s = await PgConnection.connect(su);
try {
  await s.exec(await readFile(path.join(root, 'db', 'bootstrap-roles.sql'), 'utf8'));
  for (const [role, p] of Object.entries(pw)) await s.exec(`ALTER ROLE newsflow_${role} PASSWORD '${p}'`);
  const exists = await s.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
  if (!exists.rowCount) {
    await s.exec(`CREATE DATABASE ${DB} OWNER newsflow_owner`);
    const s2 = await PgConnection.connect({ ...su, database: DB });
    await s2.exec(`REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO newsflow_owner;
                   GRANT USAGE ON SCHEMA public TO newsflow_app, newsflow_worker, newsflow_admin;`);
    await s2.close();
  }
} finally {
  await s.close();
}
const owner = await PgConnection.connect({ ...su, user: 'newsflow_owner', password: pw.owner, database: DB });
const res = await migrate(owner, path.join(root, 'db', 'migrations'));
await owner.close();
log.info('database ready', { applied: res.applied.length });

const url = (role: keyof typeof pw) => {
  const u = new URL('postgres://x');
  u.username = `newsflow_${role}`;
  u.password = pw[role];
  u.hostname = su.host;
  u.port = String(su.port);
  u.pathname = `/${DB}`;
  if (su.ssl) u.searchParams.set('sslmode', 'require');
  return u.toString();
};

Object.assign(process.env, {
  APP_ENV: 'production',
  DATABASE_URL_APP: url('app'),
  DATABASE_URL_WORKER: url('worker'),
  WA_MODE: process.env.WA_MODE ?? 'baileys',
  ALLOW_REAL_WHATSAPP: process.env.ALLOW_REAL_WHATSAPP ?? '1',
  API_PORT: process.env.PORT ?? '8787',
  API_HOST: '0.0.0.0',
  TRUST_PROXY_HOPS: process.env.TRUST_PROXY_HOPS ?? '1',
  MASTER_KEY_ID: process.env.MASTER_KEY_ID ?? 'mk-live-1',
});
// Fail early with a clear message instead of deep inside the app.
need('MASTER_KEY');
need('TOKEN_SECRET');

await import('../main.js');

// Startup check: can this server reach WhatsApp and get a linking code? It opens a
// throwaway session in memory, waits for the first QR, logs the result and closes.
// Nothing is linked and nothing is stored. LIVE_WA_SELFCHECK=0 turns it off.
if (process.env.LIVE_WA_SELFCHECK !== '0') void (async () => {
  const started = Date.now();
  try {
    const B: any = await import('baileys' as string); // eslint-disable-line @typescript-eslint/no-explicit-any
    let version: number[] | undefined;
    try {
      const v = await B.fetchLatestWaWebVersion({});
      if (Array.isArray(v?.version)) version = v.version;
    } catch { /* bundled version */ }
    const mem: Record<string, Record<string, unknown>> = {};
    const keys = {
      get: async (type: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, mem[type]?.[id]]).filter(([, v]) => v !== undefined)),
      set: async (data: Record<string, Record<string, unknown>>) => { for (const t of Object.keys(data)) mem[t] = { ...mem[t], ...data[t] }; },
    };
    const quiet = { level: 'silent', child: () => quiet, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
    const sock = B.default({ auth: { creds: B.initAuthCreds(), keys }, printQRInTerminal: false, logger: quiet, browser: B.Browsers.ubuntu('Chrome'), ...(version ? { version } : {}) });
    const done = (ok: boolean, detail: string) => {
      log[ok ? 'info' : 'warn']('whatsapp self-check', { ok, detail, version: version?.join('.') ?? 'bundled', ms: Date.now() - started });
      try { sock.end(undefined); } catch { /* closed */ }
    };
    let finished = false;
    const timer = setTimeout(() => { if (!finished) { finished = true; done(false, 'no QR within 45s'); } }, 45_000);
    sock.ev.on('connection.update', (u: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (finished) return;
      if (u.qr) { finished = true; clearTimeout(timer); done(true, 'QR received: WhatsApp reachable and this version accepted'); }
      else if (u.connection === 'close') { finished = true; clearTimeout(timer); done(false, `closed: ${u.lastDisconnect?.error?.output?.statusCode ?? ''} ${u.lastDisconnect?.error?.message ?? ''}`.trim()); }
    });
  } catch (e) {
    log.warn('whatsapp self-check', { ok: false, detail: String(e) });
  }
})();
