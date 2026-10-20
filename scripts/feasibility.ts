/**
 * Real-number feasibility test — PREPARED, NOT RUN.
 *
 * Running this links real WhatsApp TEST numbers to Baileys. It must only be
 * run with the owner's explicit approval, on test SIM cards (never on
 * business numbers), with Baileys installed and pinned.
 *
 *   npm install baileys@<pinned-version>
 *   ALLOW_REAL_WHATSAPP=1 tsx scripts/feasibility.ts --i-have-owner-approval \
 *     --phones 972500000001,972500000002 [--hours 72] [--test-group <jid> --send-every-min 60]
 *
 * What it does:
 *  - links each phone by pairing code (printed to the console)
 *  - keeps the sessions up for --hours, logging every status change
 *  - samples process memory every minute → feasibility-<date>.csv
 *  - restarts one session every 6 hours to verify reconnect without re-linking
 *  - lists groups and their send permission once connected
 *  - ONLY if --test-group is given: sends one short test text to that group
 *    every --send-every-min minutes (use a private group with only your own
 *    test numbers in it)
 *
 * It never sends anywhere else and stops a number immediately on
 * logged_out / account_blocked.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { MasterKey, TenantCipher } from '../src/crypto/keyring.js';
import { createLogger } from '../src/logger.js';
import { MemoryAuthStore } from '../src/wa/authStore.js';
import { baileysTransportFactory } from '../src/wa/baileysTransport.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { normalizePhone } from '../src/wa/transport.js';

const argv = process.argv;
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};

if (process.env.ALLOW_REAL_WHATSAPP !== '1' || !flag('i-have-owner-approval')) {
  console.error('Refusing to run: this links REAL WhatsApp numbers. Needs ALLOW_REAL_WHATSAPP=1 and --i-have-owner-approval.');
  process.exit(2);
}
const phones = (opt('phones') ?? '').split(',').filter(Boolean).map(normalizePhone);
if (!phones.length) {
  console.error('--phones is required (comma separated, with country code)');
  process.exit(2);
}
const hours = Number(opt('hours') ?? 72);
const testGroup = opt('test-group');
const sendEveryMin = Number(opt('send-every-min') ?? 60);

const log = createLogger({ run: 'feasibility' });
const tenant = '00000000-0000-4000-8000-00000000f00d';
const cipher = new TenantCipher(tenant, new MasterKey('mk-feas', MasterKey.generateB64()).newTenantKey(tenant).dek);
const stores = new Map<string, MemoryAuthStore>();
const conns = new ConnectionManager({
  transportFactory: baileysTransportFactory({ allowReal: true, logger: log }),
  storeFactory: (_t, acc) => {
    let s = stores.get(acc);
    if (!s) stores.set(acc, (s = new MemoryAuthStore(acc, cipher)));
    return s;
  },
  logger: log,
});

const csv = `feasibility-${new Date().toISOString().slice(0, 10)}.csv`;
writeFileSync(csv, 'time,connected,rss_mb,heap_mb\n');
const events: string[] = [];

conns.onStatus(({ state }) => {
  const line = `${new Date().toISOString()} ${state.accountId} ${state.status}${state.lastDisconnect ? ` (${state.lastDisconnect.reason})` : ''}`;
  events.push(line);
  console.log(line);
  if (state.pairingCode) console.log(`  >>> pairing code for ${state.accountId}: ${state.pairingCode}  (WhatsApp > Linked devices > Link with phone number)`);
});

for (const p of phones) await conns.connect(tenant, `acc-${p}`, { method: 'pairing_code', phoneNumber: p });

setInterval(() => {
  const m = process.memoryUsage();
  const connected = conns.listStates().filter((s) => s.status === 'connected').length;
  appendFileSync(csv, `${new Date().toISOString()},${connected},${Math.round(m.rss / 1048576)},${Math.round(m.heapUsed / 1048576)}\n`);
}, 60_000);

const listed = new Set<string>();
setInterval(async () => {
  for (const s of conns.listStates()) {
    if (s.status !== 'connected' || listed.has(s.accountId)) continue;
    listed.add(s.accountId);
    const chats = await conns.listChats(s.accountId);
    console.log(`${s.accountId}: ${chats.length} groups, ${chats.filter((c) => c.canSend).length} with send permission`);
  }
}, 10_000);

// Reconnect check: restart the first session every 6 hours.
setInterval(async () => {
  const first = conns.listStates().find((s) => s.status === 'connected');
  if (!first) return;
  console.log(`restart check: ${first.accountId}`);
  await conns.stop(first.accountId);
  await conns.connect(tenant, first.accountId, { method: 'pairing_code', phoneNumber: first.accountId.slice(4) });
}, 6 * 3_600_000);

if (testGroup) {
  setInterval(async () => {
    for (const s of conns.listStates()) {
      if (s.status !== 'connected') continue;
      try {
        await conns.sender(s.accountId).send(testGroup, { kind: 'text', text: `feasibility ping ${new Date().toISOString()}` });
      } catch (e) {
        console.log(`send from ${s.accountId} failed: ${(e as Error).message}`);
      }
    }
  }, sendEveryMin * 60_000);
}

setTimeout(async () => {
  writeFileSync(`feasibility-events-${Date.now()}.log`, events.join('\n'));
  await conns.shutdown();
  console.log('done');
  process.exit(0);
}, hours * 3_600_000);
