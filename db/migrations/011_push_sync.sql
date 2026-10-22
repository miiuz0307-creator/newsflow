-- PUSH Sync: edits and deletes in the control group follow every copy.
--
-- outbound_jobs now carries four kinds of action:
--   send   — a copy of a source message to one target (as before)
--   edit   — change a copy that was already sent (parent_job_id → the send job)
--   delete — delete a copy that was already sent (parent_job_id → the send job)
--   report — a status message posted back into the control group
-- Deletes run first (priority 0), then edits (1), sends (2) and reports (3).
--
-- A job whose outcome is not known (the request may or may not have reached
-- the platform) ends in status 'unknown' — "ממתין לאימות" — and is never
-- resent automatically.

ALTER TABLE outbound_jobs
  ADD COLUMN action        text     NOT NULL DEFAULT 'send' CHECK (action IN ('send', 'edit', 'delete', 'report')),
  ADD COLUMN priority      smallint NOT NULL DEFAULT 2,
  ADD COLUMN parent_job_id bigint   REFERENCES outbound_jobs(id) ON DELETE CASCADE,
  ADD COLUMN version       integer  NOT NULL DEFAULT 1 CHECK (version >= 1);

ALTER TABLE outbound_jobs ADD CONSTRAINT outbound_parent_needed
  CHECK ((action IN ('edit', 'delete')) = (parent_job_id IS NOT NULL));

ALTER TABLE outbound_jobs DROP CONSTRAINT outbound_jobs_status_check;
ALTER TABLE outbound_jobs ADD CONSTRAINT outbound_jobs_status_check
  CHECK (status IN ('pending_approval', 'queued', 'sending', 'sent', 'failed', 'skipped', 'cancelled', 'unknown'));

DROP INDEX outbound_ready;
CREATE INDEX outbound_ready ON outbound_jobs (priority, not_before, id) WHERE status = 'queued';
CREATE INDEX outbound_by_source_msg ON outbound_jobs (source_message_id, tenant_id);
CREATE INDEX outbound_parent ON outbound_jobs (parent_job_id) WHERE parent_job_id IS NOT NULL;

-- Control-group settings live on the route (null = an ordinary route):
--   {"syncEdits":true,"syncDeletes":true,"reportMode":"summary","allowedSenders":["9725..."]}
ALTER TABLE routes ADD COLUMN control jsonb;

-- One row per message that was distributed from a source chat: its current
-- version and whether it was deleted. Edits bump the version; a job carrying
-- an older version is skipped, so an old edit never overwrites a newer one.
CREATE TABLE source_messages (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform    text NOT NULL CHECK (platform IN ('wa', 'tg')),
  account_id  uuid NOT NULL,
  chat_id     text NOT NULL,
  message_id  text NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, account_id, chat_id, message_id)
);
CREATE INDEX source_messages_tenant ON source_messages (tenant_id, created_at DESC);

-- Text of each version, for the customer's history. Purged with job content.
CREATE TABLE message_versions (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  account_id  uuid NOT NULL,
  chat_id     text NOT NULL,
  message_id  text NOT NULL,
  version     integer NOT NULL,
  text        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, account_id, chat_id, message_id, version),
  FOREIGN KEY (platform, account_id, chat_id, message_id)
    REFERENCES source_messages (platform, account_id, chat_id, message_id) ON DELETE CASCADE
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['source_messages', 'message_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I TO newsflow_app
                      USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())$p$, t);
    EXECUTE format('CREATE POLICY worker_all ON %I TO newsflow_worker USING (true) WITH CHECK (true)', t);
    EXECUTE format('CREATE POLICY admin_read ON %I FOR SELECT TO newsflow_admin USING (true)', t);
    EXECUTE format('GRANT SELECT ON %I TO newsflow_app, newsflow_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO newsflow_worker', t);
  END LOOP;
END $$;

-- Retention: also clear old version texts, and treat 'unknown' as finished. The kind of
-- message (text / image …) is kept, so a late Telegram edit still uses the right method;
-- a purged job is marked and can no longer be retried.
CREATE OR REPLACE FUNCTION purge_expired(content_days integer DEFAULT 7) RETURNS TABLE (jobs_cleared bigint, dedup_deleted bigint)
  LANGUAGE plpgsql
  AS $$
DECLARE
  a bigint;
  b bigint;
BEGIN
  UPDATE outbound_jobs
     SET content = jsonb_build_object('kind', content->>'kind', 'purged', true)
   WHERE content IS NOT NULL AND NOT (content ? 'purged')
     AND status IN ('sent', 'failed', 'skipped', 'cancelled', 'unknown')
     AND updated_at < now() - make_interval(days => content_days);
  GET DIAGNOSTICS a = ROW_COUNT;
  UPDATE message_versions SET text = NULL
   WHERE text IS NOT NULL AND created_at < now() - make_interval(days => content_days);
  DELETE FROM dedup_keys WHERE expires_at < now();
  GET DIAGNOSTICS b = ROW_COUNT;
  RETURN QUERY SELECT a, b;
END $$;

-- Account deletion removes the new tables too.
CREATE OR REPLACE FUNCTION delete_my_tenant() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  t uuid := current_tenant();
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501'; END IF;
  DELETE FROM ticket_messages WHERE tenant_id = t;
  DELETE FROM tickets WHERE tenant_id = t;
  DELETE FROM notifications WHERE tenant_id = t;
  DELETE FROM message_versions WHERE tenant_id = t;
  DELETE FROM source_messages WHERE tenant_id = t;
  DELETE FROM outbound_jobs WHERE tenant_id = t;
  DELETE FROM dedup_keys WHERE tenant_id = t;
  DELETE FROM route_sources WHERE tenant_id = t;
  DELETE FROM route_targets WHERE tenant_id = t;
  DELETE FROM routes WHERE tenant_id = t;
  DELETE FROM templates WHERE tenant_id = t;
  DELETE FROM chats WHERE tenant_id = t;
  DELETE FROM wa_auth WHERE tenant_id = t;
  DELETE FROM wa_accounts WHERE tenant_id = t;
  DELETE FROM tg_bots WHERE tenant_id = t;
  DELETE FROM connection_events WHERE tenant_id = t;
  DELETE FROM safety_events WHERE tenant_id = t;
  DELETE FROM refresh_tokens WHERE tenant_id = t;
  DELETE FROM kill_switches WHERE tenant_id = t;
  DELETE FROM users WHERE tenant_id = t;
  UPDATE tenants SET status = 'deleted', name = 'deleted', wrapped_dek = 'deleted' WHERE id = t;
  INSERT INTO audit_log (tenant_id, actor, action, target) VALUES (t, 'customer', 'tenant.deleted', t::text);
END $$;

-- The owner role deletes tenant rows during account deletion (same as the other tables).
CREATE POLICY owner_delete_all ON source_messages FOR DELETE TO newsflow_owner USING (true);
CREATE POLICY owner_select_all ON source_messages FOR SELECT TO newsflow_owner USING (true);
CREATE POLICY owner_delete_all ON message_versions FOR DELETE TO newsflow_owner USING (true);
CREATE POLICY owner_select_all ON message_versions FOR SELECT TO newsflow_owner USING (true);

-- Target price from the PUSH spec: Premium at 300 ₪ a month (before VAT). Prices are data.
UPDATE plans SET price_agorot = 30000, updated_at = now() WHERE code = 'premium';
