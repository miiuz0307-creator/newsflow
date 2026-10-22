/**
 * PostgreSQL implementations of the storage interfaces.
 *
 * Two connection pools are expected:
 *  - appPool    as newsflow_app    — API requests, always inside withTenant()
 *  - workerPool as newsflow_worker — delivery workers (cross-tenant by design)
 */
import type { ChatRef, MessageContent, SendResult } from '../core/types.js';
import { MasterKey, TenantCipher } from '../crypto/keyring.js';
import type { KillScope, KillSwitch, KillSwitchStore, KillTarget } from '../delivery/killSwitch.js';
import { addToSummary, emptySummary, type ActionSummary, type JobQueue, type JobStatus, type StoredJob } from '../delivery/queue.js';
import type { SafetyEvent } from '../delivery/safety.js';
import type { RouteSource } from '../engine/pipeline.js';
import type { SourceMessageStore, SourceState } from '../engine/sync.js';
import type { DedupStore } from '../routing/dedup.js';
import { ACTION_PRIORITY, type JobAction, type PlannedJob, type Route, type RouteTarget, type Template } from '../routing/types.js';
import type { AuthStore } from '../wa/authStore.js';
import { deserialize, serialize } from '../wa/authStore.js';
import type { PgConnection, PgPool, Sql } from './pg.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs `fn` in a transaction scoped to one tenant (RLS). */
export async function withTenant<T>(pool: PgPool, tenantId: string, fn: (sql: PgConnection) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error('invalid tenant id');
  return pool.transaction(async (c) => {
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn(c);
  });
}

// ---------------------------------------------------------------- tenants

export class TenantKeys {
  private cache = new Map<string, TenantCipher>();
  constructor(private readonly master: MasterKey, private readonly workerSql: Sql) {}

  /** Creates a tenant with a fresh data key. Runs as the API role. */
  async provision(appSql: Sql, name: string, plan: string, ownerEmail: string | null, passwordHash: string | null = null): Promise<string> {
    const placeholder = '00000000-0000-0000-0000-000000000000';
    // The DEK's AAD binds it to the tenant id, which only exists after insert;
    // so: insert with a temporary wrapped key, then re-wrap and update via worker.
    const tmp = this.master.newTenantKey(placeholder);
    const r = await appSql.query<{ id: string }>('SELECT provision_tenant($1, $2, $3, $4, $5, $6) AS id', [
      name, plan, tmp.wrapped.wrapped, tmp.wrapped.masterKeyId, ownerEmail, passwordHash,
    ]);
    const id = r.rows[0]!.id;
    const real = this.master.newTenantKey(id);
    await this.workerSql.query('SELECT set_tenant_key($1, $2, $3)', [id, real.wrapped.wrapped, real.wrapped.masterKeyId]);
    this.cache.set(id, new TenantCipher(id, real.dek));
    return id;
  }

  /** Drops a tenant's key from memory (after account deletion). */
  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  async cipher(tenantId: string): Promise<TenantCipher> {
    const hit = this.cache.get(tenantId);
    if (hit) return hit;
    const r = await this.workerSql.query<{ wrapped_dek: string; master_key_id: string }>(
      'SELECT wrapped_dek, master_key_id FROM tenants WHERE id = $1', [tenantId]);
    const row = r.rows[0];
    if (!row) throw new Error(`unknown tenant ${tenantId}`);
    const dek = this.master.unwrap(tenantId, { wrapped: row.wrapped_dek, masterKeyId: row.master_key_id });
    const c = new TenantCipher(tenantId, dek);
    this.cache.set(tenantId, c);
    return c;
  }
}

// ---------------------------------------------------------------- WhatsApp auth state

export class PgAuthStore implements AuthStore {
  constructor(
    private readonly sql: Sql,
    private readonly tenantId: string,
    public readonly accountId: string,
    private readonly cipher: TenantCipher,
  ) {}

  private purpose(key: string) {
    return `wa-auth:${this.accountId}:${key}`;
  }

  async readCreds() {
    const r = await this.sql.query<{ blob: string }>('SELECT blob FROM wa_auth WHERE account_id = $1 AND key = $2', [this.accountId, 'creds']);
    const b = r.rows[0]?.blob;
    return b ? deserialize(this.cipher.decryptString(this.purpose('creds'), b)) : null;
  }

  async writeCreds(creds: unknown) {
    await this.upsert('creds', creds);
  }

  async hasCreds() {
    const r = await this.sql.query('SELECT 1 FROM wa_auth WHERE account_id = $1 AND key = $2', [this.accountId, 'creds']);
    return r.rowCount > 0;
  }

  async getKeys(type: string, ids: string[]) {
    if (!ids.length) return {};
    const keys = ids.map((id) => `key:${type}:${id}`);
    const r = await this.sql.query<{ key: string; blob: string }>(
      'SELECT key, blob FROM wa_auth WHERE account_id = $1 AND key = ANY($2::text[])',
      [this.accountId, `{${keys.map((k) => `"${k.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`],
    );
    const out: Record<string, unknown> = {};
    for (const row of r.rows) {
      const id = row.key.slice(`key:${type}:`.length);
      out[id] = deserialize(this.cipher.decryptString(this.purpose(row.key), row.blob));
    }
    return out;
  }

  async setKeys(data: Record<string, Record<string, unknown | null>>) {
    for (const [type, entries] of Object.entries(data)) {
      for (const [id, value] of Object.entries(entries)) {
        const key = `key:${type}:${id}`;
        if (value === null || value === undefined) {
          await this.sql.query('DELETE FROM wa_auth WHERE account_id = $1 AND key = $2', [this.accountId, key]);
        } else {
          await this.upsert(key, value);
        }
      }
    }
  }

  async wipe() {
    await this.sql.query('DELETE FROM wa_auth WHERE account_id = $1', [this.accountId]);
  }

  private async upsert(key: string, value: unknown) {
    const blob = this.cipher.encrypt(this.purpose(key), serialize(value));
    await this.sql.query(
      `INSERT INTO wa_auth (tenant_id, account_id, key, blob) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, key) DO UPDATE SET blob = EXCLUDED.blob, updated_at = now()`,
      [this.tenantId, this.accountId, key, blob],
    );
  }
}

// ---------------------------------------------------------------- dedup

export class PgDedupStore implements DedupStore {
  constructor(private readonly sql: Sql) {}
  async claim(tenantId: string, key: string, ttlMs: number) {
    const r = await this.sql.query(
      `INSERT INTO dedup_keys (key, tenant_id, expires_at) VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE SET expires_at = EXCLUDED.expires_at
         WHERE dedup_keys.expires_at < now()
       RETURNING key`,
      [key, tenantId, String(ttlMs)],
    );
    return r.rowCount > 0;
  }

  async claimMany(tenantId: string, keys: string[], ttlMs: number) {
    if (!keys.length) return new Set<string>();
    const r = await this.sql.query<{ key: string }>(
      `INSERT INTO dedup_keys (key, tenant_id, expires_at)
       SELECT k, $2, now() + ($3 || ' milliseconds')::interval FROM jsonb_array_elements_text($1::jsonb) AS k
       ON CONFLICT (key) DO UPDATE SET expires_at = EXCLUDED.expires_at
         WHERE dedup_keys.expires_at < now()
       RETURNING key`,
      [[...new Set(keys)], tenantId, String(ttlMs)],
    );
    return new Set(r.rows.map((x) => x.key));
  }

  async release(tenantId: string, keys: string[]) {
    if (!keys.length) return;
    await this.sql.query('DELETE FROM dedup_keys WHERE tenant_id = $1 AND key IN (SELECT jsonb_array_elements_text($2::jsonb))', [tenantId, keys]);
  }
}

// ---------------------------------------------------------------- jobs

interface JobRow {
  id: number | string;
  tenant_id: string;
  route_id: string | null;
  idempotency_key: string;
  source: ChatRef;
  source_message_id: string;
  target_platform: 'wa' | 'tg';
  target_account_id: string;
  target_chat_id: string;
  target_title: string | null;
  content: StoredJob['content'] | null;
  status: StoredJob['status'];
  not_before: Date;
  attempts: number;
  error_kind: string | null;
  last_error: string | null;
  sent_message_id: string | null;
  created_at: Date;
  sent_at: Date | null;
  action: JobAction;
  version: number;
  parent_job_id: number | string | null;
}

function toJob(r: JobRow): StoredJob {
  const target: RouteTarget = { platform: r.target_platform, accountId: r.target_account_id, chatId: r.target_chat_id, ...(r.target_title ? { title: r.target_title } : {}) };
  return {
    id: String(r.id),
    tenantId: r.tenant_id,
    routeId: r.route_id ?? '',
    source: r.source,
    sourceMessageId: r.source_message_id,
    target,
    content: r.content ?? { kind: 'text', text: '' },
    notBefore: r.not_before,
    requiresApproval: r.status === 'pending_approval',
    idempotencyKey: r.idempotency_key,
    action: r.action,
    version: r.version,
    ...(r.parent_job_id !== null && r.parent_job_id !== undefined ? { parentJobId: String(r.parent_job_id) } : {}),
    status: r.status,
    attempts: r.attempts,
    ...(r.error_kind ? { errorKind: r.error_kind } : {}),
    ...(r.last_error ? { lastError: r.last_error } : {}),
    ...(r.sent_message_id ? { sentMessageId: r.sent_message_id } : {}),
    createdAt: r.created_at,
    ...(r.sent_at ? { sentAt: r.sent_at } : {}),
  };
}

/** Strips bytes and loaders: only metadata and the media reference are stored. */
function storableContent(c: PlannedJob['content']) {
  if (!c.media) return c;
  const { data: _d, load: _l, ...media } = c.media;
  return { ...c, media };
}

export class PgJobQueue implements JobQueue {
  /**
   * @param sql worker pool for cross-tenant operations
   * @param appPool optional API pool for tenant-scoped approve/reject/list
   */
  constructor(private readonly sql: Sql, private readonly appPool?: PgPool) {}

  /** One multi-row INSERT per batch of up to 500 jobs (a news item fans out to many targets at once). */
  async enqueue(jobs: PlannedJob[]) {
    let inserted = 0;
    const COLS = 16;
    for (let i = 0; i < jobs.length; i += 500) {
      const batch = jobs.slice(i, i + 500);
      const params: unknown[] = [];
      const rows = batch.map((j, k) => {
        const action = j.action ?? 'send';
        params.push(j.tenantId, j.routeId || null, j.idempotencyKey, j.source, j.sourceMessageId, j.target.platform, j.target.accountId,
          j.target.chatId, j.target.title ?? null, storableContent(j.content), j.requiresApproval ? 'pending_approval' : 'queued', j.notBefore,
          action, ACTION_PRIORITY[action], j.parentJobId ?? null, j.version ?? 1);
        return `(${Array.from({ length: COLS }, (_, c) => `$${k * COLS + c + 1}`).join(', ')})`;
      });
      const r = await this.sql.query(
        `INSERT INTO outbound_jobs (tenant_id, route_id, idempotency_key, source, source_message_id,
           target_platform, target_account_id, target_chat_id, target_title, content, status, not_before,
           action, priority, parent_job_id, version)
         VALUES ${rows.join(', ')}
         ON CONFLICT (idempotency_key) DO NOTHING`,
        params,
      );
      inserted += r.rowCount;
    }
    return { inserted };
  }

  async claim(workerId: string, limit: number, lockMs: number, filter?: { accountIds?: string[] }) {
    const accounts = filter?.accountIds;
    if (accounts && !accounts.length) return [];
    const r = await this.sql.query<JobRow>(
      `UPDATE outbound_jobs j
          SET status = 'sending', attempts = j.attempts + 1, locked_by = $1,
              locked_until = now() + ($2 || ' milliseconds')::interval, updated_at = now()
        WHERE j.id IN (
          SELECT id FROM outbound_jobs
           WHERE status = 'queued' AND not_before <= now()
             AND ($4::uuid[] IS NULL OR target_account_id = ANY($4::uuid[]))
           ORDER BY priority, not_before, id
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING j.*`,
      [workerId, String(lockMs), limit, accounts ? `{${accounts.join(',')}}` : null],
    );
    return r.rows.map(toJob).sort((a, b) =>
      ACTION_PRIORITY[a.action] - ACTION_PRIORITY[b.action] || a.notBefore.getTime() - b.notBefore.getTime() || Number(a.id) - Number(b.id));
  }

  async complete(id: string, res: SendResult) {
    await this.sql.query(
      `UPDATE outbound_jobs SET status = 'sent', sent_message_id = $2, sent_at = $3, locked_by = NULL, locked_until = NULL,
              error_kind = NULL, last_error = NULL, updated_at = now() WHERE id = $1 AND status = 'sending'`,
      [id, res.messageId, res.sentAt],
    );
  }
  async retry(id: string, at: Date, kind: string, message: string) {
    await this.sql.query(
      `UPDATE outbound_jobs SET status = 'queued', not_before = $2, error_kind = $3, last_error = $4,
              locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1 AND status = 'sending'`,
      [id, at, kind, message.slice(0, 500)],
    );
  }
  async defer(id: string, at: Date) {
    await this.sql.query(
      `UPDATE outbound_jobs SET status = 'queued', not_before = $2, attempts = GREATEST(attempts - 1, 0),
              locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1 AND status = 'sending'`,
      [id, at],
    );
  }
  async fail(id: string, kind: string, message: string) {
    await this.sql.query(
      `UPDATE outbound_jobs SET status = 'failed', error_kind = $2, last_error = $3, locked_by = NULL, locked_until = NULL,
              updated_at = now() WHERE id = $1 AND status = 'sending'`,
      [id, kind, message.slice(0, 500)],
    );
  }
  async skip(id: string, reason: string) {
    await this.sql.query(
      `UPDATE outbound_jobs SET status = 'skipped', error_kind = $2, last_error = $2, attempts = GREATEST(attempts - 1, 0),
              locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1 AND status = 'sending'`,
      [id, reason],
    );
  }

  private tenantScoped<T>(tenantId: string, fn: (c: Sql) => Promise<T>): Promise<T> {
    if (!this.appPool) throw new Error('approve/reject/list need the API pool');
    return withTenant(this.appPool, tenantId, fn);
  }

  async approve(tenantId: string, id: string) {
    return this.tenantScoped(tenantId, async (c) => {
      const r = await c.query(
        `UPDATE outbound_jobs SET status = 'queued', not_before = GREATEST(not_before, now()), updated_at = now()
          WHERE id = $1 AND status = 'pending_approval'`, [id]);
      if (r.rowCount) await c.query(`INSERT INTO audit_log (tenant_id, actor, action, target) VALUES ($1, 'customer', 'job.approved', $2)`, [tenantId, id]);
      return r.rowCount > 0;
    });
  }
  async reject(tenantId: string, id: string) {
    return this.tenantScoped(tenantId, async (c) => {
      const r = await c.query(`UPDATE outbound_jobs SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'pending_approval'`, [id]);
      return r.rowCount > 0;
    });
  }
  async listPendingApproval(tenantId: string) {
    return this.tenantScoped(tenantId, async (c) =>
      (await c.query<JobRow>(`SELECT * FROM outbound_jobs WHERE status = 'pending_approval' ORDER BY created_at LIMIT 500`)).rows.map(toJob));
  }
  async sentCountSince(accountId: string, since: Date) {
    const r = await this.sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbound_jobs WHERE target_account_id = $1 AND status = 'sent' AND action = 'send' AND sent_at >= $2`, [accountId, since]);
    return r.rows[0]?.n ?? 0;
  }
  async reapStale() {
    const r = await this.sql.query(
      `UPDATE outbound_jobs SET status = 'queued', locked_by = NULL, locked_until = NULL, updated_at = now()
        WHERE status = 'sending' AND locked_until < now()`);
    return r.rowCount;
  }
  async get(id: string) {
    const r = await this.sql.query<JobRow>('SELECT * FROM outbound_jobs WHERE id = $1', [id]);
    return r.rows[0] ? toJob(r.rows[0]) : undefined;
  }

  async wasSentByUs(platform: string, chatId: string, messageId: string) {
    const r = await this.sql.query(
      `SELECT 1 FROM outbound_jobs WHERE target_chat_id = $1 AND sent_message_id = $2 AND target_platform = $3
          AND action IN ('send', 'report') LIMIT 1`,
      [chatId, messageId, platform]);
    return r.rowCount > 0;
  }

  // ---- PUSH Sync

  async markUnknown(id: string, message: string) {
    await this.sql.query(
      `UPDATE outbound_jobs SET status = 'unknown', error_kind = 'unknown', last_error = $2, locked_by = NULL, locked_until = NULL,
              updated_at = now() WHERE id = $1 AND status = 'sending'`,
      [id, message.slice(0, 500)],
    );
  }

  /** Matches one source message. The jsonb source is compared field by field (index on source_message_id). */
  private static readonly SAME_SOURCE = `tenant_id = $1 AND source_message_id = $2 AND source->>'platform' = $3
       AND source->>'accountId' = $4 AND source->>'chatId' = $5`;

  async copiesOf(tenantId: string, source: ChatRef, messageId: string) {
    const r = await this.sql.query<JobRow>(
      `SELECT * FROM outbound_jobs WHERE ${PgJobQueue.SAME_SOURCE} AND action = 'send' ORDER BY id`,
      [tenantId, messageId, source.platform, source.accountId, source.chatId]);
    return r.rows.map(toJob);
  }

  async replaceUnsentContent(id: string, content: MessageContent, version: number) {
    const r = await this.sql.query(
      `UPDATE outbound_jobs SET content = $2, version = $3, updated_at = now()
        WHERE id = $1 AND status IN ('queued', 'pending_approval', 'failed', 'unknown') AND version <= $3`,
      [id, storableContent(content), version]);
    return r.rowCount > 0;
  }

  async cancelUnsent(tenantId: string, source: ChatRef, messageId: string, actions: JobAction[], reason: string) {
    const r = await this.sql.query(
      `UPDATE outbound_jobs SET status = 'cancelled', error_kind = $7, last_error = $7, locked_by = NULL, locked_until = NULL, updated_at = now()
        WHERE ${PgJobQueue.SAME_SOURCE} AND action = ANY($6::text[]) AND status IN ('queued', 'pending_approval', 'failed')`,
      [tenantId, messageId, source.platform, source.accountId, source.chatId, `{${actions.join(',')}}`, reason]);
    return r.rowCount;
  }

  async cancelOlderEdits(parentJobId: string, version: number) {
    const r = await this.sql.query(
      `UPDATE outbound_jobs SET status = 'cancelled', error_kind = 'superseded', last_error = 'superseded', updated_at = now()
        WHERE parent_job_id = $1 AND action = 'edit' AND status = 'queued' AND version < $2`,
      [parentJobId, version]);
    return r.rowCount;
  }

  async summary(tenantId: string, source: ChatRef, messageId: string, action: JobAction, version?: number, routeId?: string): Promise<ActionSummary> {
    const r = await this.sql.query<{ status: JobStatus; error_kind: string | null; n: number; titles: string[] | null }>(
      `SELECT status, error_kind, count(*)::int AS n,
              (array_agg(COALESCE(target_title, target_chat_id) ORDER BY id) FILTER (WHERE status = 'failed'))[1:10] AS titles
         FROM outbound_jobs
        WHERE ${PgJobQueue.SAME_SOURCE} AND action = $6 AND ($7::int IS NULL OR version = $7) AND ($8::uuid IS NULL OR route_id = $8)
        GROUP BY status, error_kind`,
      [tenantId, messageId, source.platform, source.accountId, source.chatId, action, version ?? null, routeId || null]);
    const s = emptySummary();
    for (const row of r.rows) {
      addToSummary(s, row.status, row.error_kind ?? undefined, undefined, row.n);
      if (row.status === 'failed') for (const t of row.titles ?? []) if (s.failedTargets.length < 10) s.failedTargets.push(t);
    }
    return s;
  }

  /** Customer's manual retry; tenant-scoped through the API pool when available. */
  async requeue(tenantId: string, id: string) {
    const run = async (c: Sql) => {
      const r = await c.query(
        // A manual retry is a new decision by the customer: its age starts now (otherwise it would be skipped as stale).
        // Never for a message deleted in the control group, and never once its content was purged.
        `UPDATE outbound_jobs j SET status = 'queued', attempts = 0, not_before = now(), created_at = now(), error_kind = NULL, last_error = NULL, updated_at = now()
          WHERE j.id = $1 AND j.tenant_id = $2 AND j.status IN ('failed', 'unknown')
            AND j.content IS NOT NULL AND NOT (j.content ? 'purged')
            AND NOT EXISTS (SELECT 1 FROM source_messages sm
                             WHERE sm.platform = j.source->>'platform' AND sm.account_id::text = j.source->>'accountId'
                               AND sm.chat_id = j.source->>'chatId' AND sm.message_id = j.source_message_id AND sm.deleted_at IS NOT NULL)`,
        [id, tenantId]);
      if (r.rowCount) await c.query(`INSERT INTO audit_log (tenant_id, actor, action, target) VALUES ($1, 'customer', 'job.requeued', $2)`, [tenantId, id]);
      return r.rowCount > 0;
    };
    return this.appPool ? this.tenantScoped(tenantId, run) : run(this.sql);
  }
}

// ---------------------------------------------------------------- source messages (PUSH Sync)

export class PgSourceMessageStore implements SourceMessageStore {
  constructor(private readonly sql: Sql) {}

  async record(tenantId: string, source: ChatRef, messageId: string, text?: string) {
    const r = await this.sql.query(
      `INSERT INTO source_messages (tenant_id, platform, account_id, chat_id, message_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [tenantId, source.platform, source.accountId, source.chatId, messageId]);
    if (r.rowCount) {
      await this.sql.query(
        `INSERT INTO message_versions (tenant_id, platform, account_id, chat_id, message_id, version, text) VALUES ($1, $2, $3, $4, $5, 1, $6)
         ON CONFLICT DO NOTHING`,
        [tenantId, source.platform, source.accountId, source.chatId, messageId, text ?? null]);
    }
  }

  async bump(tenantId: string, source: ChatRef, messageId: string, text?: string) {
    const r = await this.sql.query<{ version: number }>(
      `UPDATE source_messages SET version = version + 1, updated_at = now()
        WHERE platform = $2 AND account_id = $3 AND chat_id = $4 AND message_id = $5 AND tenant_id = $1 AND deleted_at IS NULL
        RETURNING version`,
      [tenantId, source.platform, source.accountId, source.chatId, messageId]);
    const v = r.rows[0]?.version;
    if (v !== undefined) {
      await this.sql.query(
        `INSERT INTO message_versions (tenant_id, platform, account_id, chat_id, message_id, version, text) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [tenantId, source.platform, source.accountId, source.chatId, messageId, v, text ?? null]);
    }
    return v;
  }

  async markDeleted(tenantId: string, source: ChatRef, messageId: string) {
    const r = await this.sql.query(
      `UPDATE source_messages SET deleted_at = now(), updated_at = now()
        WHERE platform = $2 AND account_id = $3 AND chat_id = $4 AND message_id = $5 AND tenant_id = $1 AND deleted_at IS NULL`,
      [tenantId, source.platform, source.accountId, source.chatId, messageId]);
    return r.rowCount > 0;
  }

  async state(source: ChatRef, messageId: string): Promise<SourceState | undefined> {
    const r = await this.sql.query<{ version: number; deleted: boolean }>(
      `SELECT version, deleted_at IS NOT NULL AS deleted FROM source_messages
        WHERE platform = $1 AND account_id = $2 AND chat_id = $3 AND message_id = $4`,
      [source.platform, source.accountId, source.chatId, messageId]);
    return r.rows[0];
  }
}

// ---------------------------------------------------------------- kill switches

export class PgKillSwitchStore implements KillSwitchStore {
  constructor(private readonly sql: Sql) {}

  async set(s: Omit<KillSwitch, 'setAt'>) {
    await this.sql.query(
      `INSERT INTO kill_switches (scope, scope_id, tenant_id, active, reason, set_by) VALUES ($1, $2, $3, true, $4, $5)
       ON CONFLICT (scope, scope_id) DO UPDATE SET active = true, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()
         -- A customer's stop never replaces an active stop set by an administrator or the system.
         WHERE NOT (kill_switches.active AND kill_switches.set_by NOT LIKE 'user:%' AND EXCLUDED.set_by LIKE 'user:%')`,
      [s.scope, s.scopeId, s.tenantId, s.reason, s.setBy],
    );
    await this.sql.query(`INSERT INTO audit_log (tenant_id, actor, action, target, detail) VALUES ($1, $2, 'kill_switch.set', $3, $4)`,
      [s.tenantId, s.setBy, `${s.scope}:${s.scopeId}`, { reason: s.reason }]);
  }

  async clear(scope: KillScope, scopeId: string, by: string) {
    const r = await this.sql.query<{ tenant_id: string | null }>(
      `UPDATE kill_switches SET active = false WHERE scope = $1 AND scope_id = $2 RETURNING tenant_id`, [scope, scopeId]);
    await this.sql.query(`INSERT INTO audit_log (tenant_id, actor, action, target) VALUES ($1, $2, 'kill_switch.cleared', $3)`,
      [r.rows[0]?.tenant_id ?? null, by, `${scope}:${scopeId}`]);
  }

  /**
   * The first active switch covering the target. A tenant that is not
   * 'active' (suspended or deleted by an admin) counts as a tenant-level stop
   * that the customer cannot lift.
   */
  async find(t: KillTarget) {
    const r = await this.sql.query<{ scope: KillScope; scope_id: string; tenant_id: string | null; reason: string; set_by: string; set_at: Date }>(
      `SELECT scope, scope_id, tenant_id, reason, set_by, set_at FROM (
         SELECT scope, scope_id, tenant_id, reason, set_by, set_at,
                CASE scope WHEN 'global' THEN 0 WHEN 'tenant' THEN 2 WHEN 'account' THEN 3 ELSE 4 END AS prio
           FROM kill_switches WHERE active AND (
             (scope = 'global') OR (scope = 'tenant' AND scope_id = $1) OR (scope = 'account' AND scope_id = $2) OR (scope = 'route' AND scope_id = $3))
         UNION ALL
         SELECT 'tenant', id::text, id, 'tenant ' || status, 'admin:status', now(), 1
           FROM tenants WHERE id::text = $1 AND status <> 'active'
       ) s ORDER BY prio LIMIT 1`,
      [t.tenantId, t.accountId, t.routeId ?? ''],
    );
    const row = r.rows[0];
    return row ? { scope: row.scope, scopeId: row.scope_id, tenantId: row.tenant_id, reason: row.reason, setBy: row.set_by, setAt: row.set_at } : null;
  }

  async list(tenantId?: string) {
    const r = await this.sql.query<{ scope: KillScope; scope_id: string; tenant_id: string | null; reason: string; set_by: string; set_at: Date }>(
      `SELECT * FROM kill_switches WHERE active AND ($1::uuid IS NULL OR tenant_id = $1 OR tenant_id IS NULL)`, [tenantId ?? null]);
    return r.rows.map((row) => ({ scope: row.scope, scopeId: row.scope_id, tenantId: row.tenant_id, reason: row.reason, setBy: row.set_by, setAt: row.set_at }));
  }
}

// ---------------------------------------------------------------- routes

interface RouteRow {
  id: string; tenant_id: string; name: string; enabled: boolean; filters: Route['filters'];
  template_id: string | null; require_approval: boolean; delay_seconds: number; quiet_hours: Route['quietHours'] | null;
  control: Route['control'] | null;
}

export class PgRouteSource implements RouteSource {
  constructor(private readonly sql: Sql) {}

  async routesForSource(chat: ChatRef): Promise<Route[]> {
    const routes = await this.sql.query<RouteRow>(
      `SELECT r.* FROM routes r JOIN route_sources s ON s.route_id = r.id
        WHERE s.platform = $1 AND s.account_id = $2 AND s.chat_id = $3`,
      [chat.platform, chat.accountId, chat.chatId],
    );
    return Promise.all(routes.rows.map((r) => this.hydrate(r)));
  }

  async template(tenantId: string, id: string): Promise<Template | undefined> {
    const r = await this.sql.query<{ id: string; tenant_id: string; name: string; body: string; vars: Record<string, string> }>(
      'SELECT * FROM templates WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    const t = r.rows[0];
    return t ? { id: t.id, tenantId: t.tenant_id, name: t.name, body: t.body, vars: t.vars } : undefined;
  }

  private async hydrate(r: RouteRow): Promise<Route> {
    const [src, tgt] = await Promise.all([
      this.sql.query<{ platform: 'wa' | 'tg'; account_id: string; chat_id: string }>('SELECT * FROM route_sources WHERE route_id = $1', [r.id]),
      this.sql.query<{ platform: 'wa' | 'tg'; account_id: string; chat_id: string; title: string | null }>('SELECT * FROM route_targets WHERE route_id = $1', [r.id]),
    ]);
    return {
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      enabled: r.enabled,
      sources: src.rows.map((s) => ({ platform: s.platform, accountId: s.account_id, chatId: s.chat_id })),
      targets: tgt.rows.map((t) => ({ platform: t.platform, accountId: t.account_id, chatId: t.chat_id, ...(t.title ? { title: t.title } : {}) })),
      filters: r.filters,
      ...(r.template_id ? { templateId: r.template_id } : {}),
      requireApproval: r.require_approval,
      delaySeconds: r.delay_seconds,
      ...(r.quiet_hours ? { quietHours: r.quiet_hours } : {}),
      ...(r.control ? { control: r.control } : {}),
    };
  }
}

/** Route writes, done by the API inside withTenant() so RLS checks ownership. */
export async function saveRoute(c: Sql, tenantId: string, r: Omit<Route, 'id' | 'tenantId'> & { id?: string }): Promise<string> {
  const row = await c.query<{ id: string }>(
    `INSERT INTO routes (id, tenant_id, name, enabled, filters, template_id, require_approval, delay_seconds, quiet_hours, control)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, enabled = EXCLUDED.enabled, filters = EXCLUDED.filters,
       template_id = EXCLUDED.template_id, require_approval = EXCLUDED.require_approval,
       delay_seconds = EXCLUDED.delay_seconds, quiet_hours = EXCLUDED.quiet_hours, control = EXCLUDED.control, updated_at = now()
     RETURNING id`,
    [r.id ?? null, tenantId, r.name, r.enabled, r.filters, r.templateId ?? null, r.requireApproval, r.delaySeconds ?? 0, r.quietHours ?? null, r.control ?? null],
  );
  const id = row.rows[0]!.id;
  await c.query('DELETE FROM route_sources WHERE route_id = $1', [id]);
  await c.query('DELETE FROM route_targets WHERE route_id = $1', [id]);
  for (const s of r.sources) {
    await c.query('INSERT INTO route_sources (route_id, tenant_id, platform, account_id, chat_id) VALUES ($1, $2, $3, $4, $5)', [id, tenantId, s.platform, s.accountId, s.chatId]);
  }
  for (const t of r.targets) {
    await c.query('INSERT INTO route_targets (route_id, tenant_id, platform, account_id, chat_id, title) VALUES ($1, $2, $3, $4, $5, $6)', [id, tenantId, t.platform, t.accountId, t.chatId, t.title ?? null]);
  }
  return id;
}

// ---------------------------------------------------------------- events

export async function recordSafetyEvent(sql: Sql, e: SafetyEvent): Promise<void> {
  await sql.query('INSERT INTO safety_events (tenant_id, account_id, kind, detail) VALUES ($1, $2, $3, $4)', [
    e.tenantId, UUID.test(e.accountId) ? e.accountId : null, e.kind, { ...e.detail, stoppedAccount: e.stoppedAccount },
  ]);
}

export async function recordConnectionEvent(sql: Sql, tenantId: string, accountId: string, status: string, reason?: string): Promise<void> {
  await sql.query('INSERT INTO connection_events (tenant_id, account_id, status, reason) VALUES ($1, $2, $3, $4)', [tenantId, accountId, status, reason ?? null]);
  await sql.query(
    `UPDATE wa_accounts SET status = $2,
       last_connected_at = CASE WHEN $2 = 'connected' THEN now() ELSE last_connected_at END,
       last_disconnect_reason = COALESCE($3, last_disconnect_reason),
       last_disconnect_at = CASE WHEN $3 IS NOT NULL THEN now() ELSE last_disconnect_at END
     WHERE id = $1`,
    [accountId, status, reason ?? null],
  );
}
