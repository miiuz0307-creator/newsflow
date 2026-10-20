/**
 * Load simulation for the delivery engine.
 *
 *   tsx scripts/loadtest.ts [--tenants 100] [--targets 15] [--messages 20] [--pg postgres://...]
 *
 * Simulates N tenants, each with one linked (simulated) WhatsApp number, one
 * source group and T target groups, then posts M news items into every
 * source and measures how long planning and delivery take.
 *
 * What it measures: the engine's own CPU/memory cost and the queue's
 * throughput (in memory, or in PostgreSQL with --pg).
 * What it does NOT measure: real Baileys memory per session or WhatsApp's
 * own limits — those come from the feasibility test with real test numbers.
 * Rate limits are set to zero here on purpose; production spacing makes real
 * delivery slower by design.
 */
import { MasterKey } from '../src/crypto/keyring.js';
import { PgPool } from '../src/db/pg.js';
import { PgDedupStore, PgJobQueue } from '../src/db/pgStores.js';
import { MemoryKillSwitchStore } from '../src/delivery/killSwitch.js';
import { MemoryMediaStore } from '../src/delivery/mediaStore.js';
import { MemoryJobQueue, type JobQueue } from '../src/delivery/queue.js';
import { MemoryRouteSource } from '../src/engine/pipeline.js';
import { Worker } from '../src/engine/worker.js';
import { MemoryDedupStore, type DedupStore } from '../src/routing/dedup.js';
import { MemoryAuthStore } from '../src/wa/authStore.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { TenantCipher } from '../src/crypto/keyring.js';

function arg(name: string, def: number): number;
function arg(name: string, def: string): string;
function arg(name: string, def: number | string) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1]!;
  return typeof def === 'number' ? Number(v) : v;
}

const TENANTS = arg('tenants', 100);
const TARGETS = arg('targets', 15);
const MESSAGES = arg('messages', 20);
const PG = arg('pg', '');

const gc = (globalThis as { gc?: () => void }).gc;
const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const heapMb = () => {
  gc?.();
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
};
const t0 = Date.now();
const rss0 = mb();
const heap0 = heapMb();

const net = new FakeWaNetwork({ connectDelayMs: 0 });
const master = new MasterKey('mk-load', MasterKey.generateB64());
const routes = new MemoryRouteSource();
const editors: { phone: string; source: string }[] = [];

let queue: JobQueue;
let dedup: DedupStore;
let pool: PgPool | undefined;
let tenantIds: string[] = [];
let accountIds: string[] = [];

if (PG) {
  pool = PgPool.fromUrl(PG, 20);
  await pool.query(`DELETE FROM outbound_jobs; DELETE FROM dedup_keys;`.split(';')[0]!);
  await pool.query('DELETE FROM dedup_keys');
  queue = new PgJobQueue(pool);
  dedup = new PgDedupStore(pool);
  const t = await pool.query<{ id: string }>('SELECT id FROM tenants ORDER BY created_at, id LIMIT $1', [TENANTS]);
  if (t.rowCount < TENANTS) throw new Error(`--pg needs ${TENANTS} tenants with one wa_account each (found ${t.rowCount}); run scripts/seed-load.ts first`);
  tenantIds = t.rows.map((r) => r.id);
  const a = await pool.query<{ id: string; tenant_id: string }>('SELECT DISTINCT ON (tenant_id) id, tenant_id FROM wa_accounts WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id, created_at', [`{${tenantIds.join(',')}}`]);
  const byTenant = new Map(a.rows.map((r) => [r.tenant_id, r.id]));
  accountIds = tenantIds.map((id) => byTenant.get(id)!);
} else {
  queue = new MemoryJobQueue();
  dedup = new MemoryDedupStore();
  tenantIds = Array.from({ length: TENANTS }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  accountIds = tenantIds.map((_, i) => `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`);
}

const ciphers = new Map(tenantIds.map((id) => [id, new TenantCipher(id, master.newTenantKey(id).dek)]));
const conns = new ConnectionManager({
  transportFactory: fakeTransportFactory(net),
  storeFactory: (tenantId, accountId) => new MemoryAuthStore(accountId, ciphers.get(tenantId)!),
});
const worker = new Worker({
  workerId: 'load',
  connections: conns,
  queue,
  routes,
  dedup,
  killSwitches: new MemoryKillSwitchStore(),
  media: new MemoryMediaStore(),
  dailyCapFor: () => 1_000_000,
  rulesOverride: { wa: { accountMinGapMs: 0, chatMinGapMs: 0, accountPerMinute: 1_000_000 } },
  dispatcherOverrides: { batchSize: 500 },
});

// --- world + linking
for (let i = 0; i < TENANTS; i++) {
  const phone = `97250${String(1_000_000 + i)}`;
  const editor = `97251${String(1_000_000 + i)}`;
  const source = net.createGroup(`מקור ${i}`, { members: [phone, editor] });
  const targets = Array.from({ length: TARGETS }, (_, k) => net.createGroup(`יעד ${i}-${k}`, { members: [phone] }));
  routes.upsertRoute({
    id: `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`, tenantId: tenantIds[i]!, name: 'r', enabled: true, filters: {}, requireApproval: false,
    sources: [{ platform: 'wa', accountId: accountIds[i]!, chatId: source }],
    targets: targets.map((chatId) => ({ platform: 'wa' as const, accountId: accountIds[i]!, chatId })),
  });
  editors.push({ phone: editor, source });
  await conns.connect(tenantIds[i]!, accountIds[i]!, { method: 'qr' });
  net.scanQr(phone, conns.getState(accountIds[i]!)!.qr!);
}
while (conns.listStates().filter((s) => s.status === 'connected').length < TENANTS) await new Promise((r) => setTimeout(r, 5));
const tLinked = Date.now();
const rssLinked = mb();
const heapLinked = heapMb();

// --- traffic
for (let m = 0; m < MESSAGES; m++) {
  for (const e of editors) net.humanPost(e.phone, e.source, { kind: 'text', text: `מבזק מספר ${m} מהמקור ${e.source.slice(-6)}` });
}
await worker.settle();
const tPlanned = Date.now();
const rssPlanned = mb();
const heapTotalPlanned = Math.round(process.memoryUsage().heapTotal / 1048576);

let sent = 0;
for (;;) {
  const s = await worker.dispatcher.tick();
  sent += s.sent;
  if (!s.claimed) break;
}
const tDone = Date.now();
const expected = TENANTS * TARGETS * MESSAGES;

console.log(JSON.stringify({
  setup: { tenants: TENANTS, targetsPerTenant: TARGETS, messagesPerSource: MESSAGES, queue: PG ? 'postgres' : 'memory' },
  results: {
    expectedSends: expected,
    sent,
    linkSeconds: (tLinked - t0) / 1000,
    planSeconds: (tPlanned - tLinked) / 1000,
    deliverSeconds: (tDone - tPlanned) / 1000,
    sendsPerSecond: Math.round(sent / Math.max(0.001, (tDone - tPlanned) / 1000)),
    rssStartMb: rss0,
    rssAfterLinkMb: rssLinked,
    rssAfterPlanMb: rssPlanned,
    heapTotalAfterPlanMb: heapTotalPlanned,
    rssEndMb: mb(),
    heapTotalEndMb: Math.round(process.memoryUsage().heapTotal / 1048576),
    heapStartMb: heap0,
    heapAfterLinkMb: heapLinked,
    heapEndMb: heapMb(),
    heapMeasured: gc ? 'after gc' : 'without gc (run with TSX_NODE_OPTIONS / --expose-gc for exact numbers)',
    engineErrors: worker.errors.length,
    firstError: worker.errors[0] ? String(worker.errors[0]) : undefined,
  },
}, null, 2));

await worker.shutdown();
await pool?.end();
if (sent !== expected) process.exit(1);
