/**
 * Real-number feasibility test. Runs ONLY with the owner's approval
 * (approved 2026-10-20 for one test number) and two locks:
 * ALLOW_REAL_WHATSAPP=1 and FEAS_OWNER_APPROVAL=yes (or --i-have-owner-approval).
 *
 * Configuration (environment, so it runs unchanged on a server):
 *   FEAS_PHONES        comma separated, with country code (972...)
 *   FEAS_MASTER_KEY    32 bytes base64 — keeps the encrypted session readable across restarts
 *   FEAS_DATA_DIR      persistent directory (a mounted volume), default ./feasibility-data
 *   FEAS_HOURS         test length, default 72 (counted from the first start, survives restarts)
 *   FEAS_TEST_GROUP    optional: a PRIVATE group JID with only the owner's test numbers;
 *                      if set, one short test text is sent there every FEAS_SEND_EVERY_MIN (default 60)
 *
 * What it does:
 *  - links each phone by pairing code (logged as ">>> PAIRING CODE"); a new code is
 *    requested when one expires, up to 10 times
 *  - keeps sessions up, logging every status change
 *  - logs memory every 15 minutes and writes a CSV every minute
 *  - every 6 hours restarts a session to prove reconnect works without re-linking
 *  - lists how many groups the number is in and where it may send (counts only, no names)
 *
 * It never sends anywhere except FEAS_TEST_GROUP, and stops a number at once on
 * logged_out / account_blocked. It never tries to get around a restriction.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { TenantCipher } from '../src/crypto/keyring.js';
import { createLogger } from '../src/logger.js';
import { baileysTransportFactory } from '../src/wa/baileysTransport.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FileAuthStore } from '../src/wa/fileAuthStore.js';
import { normalizePhone } from '../src/wa/transport.js';

const env = process.env;
const approved = env.FEAS_OWNER_APPROVAL === 'yes' || process.argv.includes('--i-have-owner-approval');
if (env.ALLOW_REAL_WHATSAPP !== '1' || !approved) {
  console.error('Refusing to run: this links REAL WhatsApp numbers. Needs ALLOW_REAL_WHATSAPP=1 and owner approval.');
  process.exit(2);
}
const phones = (env.FEAS_PHONES ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(normalizePhone);
if (!phones.length) {
  console.error('FEAS_PHONES is required (comma separated, with country code)');
  process.exit(2);
}
const masterB64 = env.FEAS_MASTER_KEY ?? '';
if (Buffer.from(masterB64, 'base64').length !== 32) {
  console.error('FEAS_MASTER_KEY must be 32 bytes base64');
  process.exit(2);
}
const dataDir = env.FEAS_DATA_DIR ?? './feasibility-data';
const hours = Number(env.FEAS_HOURS ?? 72);
const testGroup = env.FEAS_TEST_GROUP || undefined;
const sendEveryMin = Number(env.FEAS_SEND_EVERY_MIN ?? 60);
mkdirSync(dataDir, { recursive: true });

// The test length is counted from the very first start, so restarts don't extend it.
const startFile = path.join(dataDir, 'started-at');
if (!existsSync(startFile)) writeFileSync(startFile, new Date().toISOString());
const startedAt = new Date(readFileSync(startFile, 'utf8').trim());
const endsAt = startedAt.getTime() + hours * 3_600_000;
const out = (s: string) => console.log(`[feasibility] ${new Date().toISOString()} ${s}`);
out(`run ${startedAt.toISOString()} → ${new Date(endsAt).toISOString()}, ${phones.length} number(s), test group: ${testGroup ? 'yes' : 'no'}`);

const log = createLogger({ run: 'feasibility' }, 'warn');
const tenant = '00000000-0000-4000-8000-00000000f00d';
// Deterministic tenant key derived from the master key, so stored sessions decrypt after a restart.
const dek = createHmac('sha256', Buffer.from(masterB64, 'base64')).update(`tenant-dek:${tenant}`).digest();
const cipher = new TenantCipher(tenant, dek);

const conns = new ConnectionManager({
  transportFactory: baileysTransportFactory({ allowReal: true, logger: log }),
  storeFactory: (_t, acc) => new FileAuthStore(path.join(dataDir, 'sessions'), acc, cipher),
  logger: log,
});

const masked = (acc: string) => acc.replace(/(\d{5})\d+(\d{3})$/, '$1****$2');
const relinks = new Map<string, number>();

conns.onStatus(({ state }) => {
  out(`status ${masked(state.accountId)} ${state.status}${state.lastDisconnect ? ` (last: ${state.lastDisconnect.reason})` : ''}`);
  appendFileSync(path.join(dataDir, 'events.log'), `${new Date().toISOString()} ${state.accountId} ${state.status} ${state.lastDisconnect?.reason ?? ''}\n`);
  if (state.status === 'linking_code' && state.pairingCode) {
    out(`>>> PAIRING CODE ${masked(state.accountId)}: ${state.pairingCode}   (WhatsApp > Linked devices > Link a device > Link with phone number instead)`);
  }
  if (state.status === 'link_expired') {
    const n = (relinks.get(state.accountId) ?? 0) + 1;
    relinks.set(state.accountId, n);
    if (n <= 10) {
      out(`code expired, requesting a new one (${n}/10)`);
      setTimeout(() => void conns.connect(tenant, state.accountId, { method: 'pairing_code', phoneNumber: state.accountId.slice(4) }), 3_000);
    } else {
      out('giving up on linking after 10 codes; restart the service to try again');
    }
  }
  if (state.status === 'blocked' || state.status === 'logged_out') {
    out(`!!! number ${masked(state.accountId)} is ${state.status}; no automatic retry`);
  }
});
conns.onSafetySignal((s) => out(`safety signal: ${s.kind} on ${masked(s.accountId)}`));

for (const p of phones) await conns.connect(tenant, `acc-${p}`, { method: 'pairing_code', phoneNumber: p });

const csv = path.join(dataDir, 'memory.csv');
if (!existsSync(csv)) writeFileSync(csv, 'time,connected,rss_mb,heap_mb\n');
let minute = 0;
setInterval(() => {
  const m = process.memoryUsage();
  const connected = conns.listStates().filter((s) => s.status === 'connected').length;
  const rss = Math.round(m.rss / 1048576);
  const heap = Math.round(m.heapUsed / 1048576);
  appendFileSync(csv, `${new Date().toISOString()},${connected},${rss},${heap}\n`);
  if (++minute % 15 === 0) out(`memory: rss ${rss}MB heap ${heap}MB, connected ${connected}/${phones.length}`);
}, 60_000);

const listed = new Set<string>();
setInterval(async () => {
  for (const s of conns.listStates()) {
    if (s.status !== 'connected' || listed.has(s.accountId)) continue;
    try {
      const chats = await conns.listChats(s.accountId);
      listed.add(s.accountId);
      out(`groups for ${masked(s.accountId)}: ${chats.length} total, ${chats.filter((c) => c.canSend).length} with send permission, ${chats.filter((c) => c.isAdmin).length} as admin`);
    } catch (e) {
      out(`listing groups failed: ${(e as Error).message}`);
    }
  }
}, 15_000);

// Reconnect check: every 6 hours restart one session from its stored credentials.
setInterval(async () => {
  const first = conns.listStates().find((s) => s.status === 'connected');
  if (!first) return;
  out(`restart check on ${masked(first.accountId)} (must reconnect without a new code)`);
  await conns.stop(first.accountId);
  await conns.connect(tenant, first.accountId, { method: 'pairing_code', phoneNumber: first.accountId.slice(4) });
}, 6 * 3_600_000);

if (testGroup) {
  setInterval(async () => {
    for (const s of conns.listStates()) {
      if (s.status !== 'connected') continue;
      try {
        await conns.sender(s.accountId).send(testGroup, { kind: 'text', text: `בדיקת יציבות ${new Date().toISOString()}` });
        out(`test message sent from ${masked(s.accountId)}`);
      } catch (e) {
        out(`test send from ${masked(s.accountId)} failed: ${(e as Error).message}`);
      }
    }
  }, sendEveryMin * 60_000);
}

const finish = async () => {
  out('test period over; closing sessions (credentials kept, so the number stays linked)');
  await conns.shutdown();
  process.exit(0);
};
setTimeout(() => void finish(), Math.max(0, endsAt - Date.now()));
process.on('SIGTERM', () => void conns.shutdown().then(() => process.exit(0)));
