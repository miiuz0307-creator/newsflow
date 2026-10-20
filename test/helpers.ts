import { MasterKey, TenantCipher } from '../src/crypto/keyring.js';
import { MemoryAuthStore } from '../src/wa/authStore.js';

export const master = new MasterKey('mk-test', MasterKey.generateB64());

const ciphers = new Map<string, TenantCipher>();
export function cipherFor(tenantId: string): TenantCipher {
  let c = ciphers.get(tenantId);
  if (!c) {
    const { dek } = master.newTenantKey(tenantId);
    ciphers.set(tenantId, (c = new TenantCipher(tenantId, dek)));
  }
  return c;
}

/** Store factory that keeps one MemoryAuthStore per account across restarts, like a database would. */
export function memoryStores() {
  const stores = new Map<string, MemoryAuthStore>();
  const factory = (tenantId: string, accountId: string) => {
    let s = stores.get(accountId);
    if (!s) stores.set(accountId, (s = new MemoryAuthStore(accountId, cipherFor(tenantId))));
    return s;
  };
  return { stores, factory };
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls until `cond` is true or the timeout passes. */
export async function waitFor(cond: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
