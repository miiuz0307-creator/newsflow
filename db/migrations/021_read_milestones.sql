-- "🎉 100 people read this message": which read milestones were already announced, so each is
-- announced once per message even with many workers and repeated receipts.
CREATE TABLE read_milestones (
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_key         text NOT NULL,
  source_message_id  text NOT NULL,
  threshold          integer NOT NULL CHECK (threshold > 0),
  reached_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_key, source_message_id, threshold)
);
ALTER TABLE read_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE read_milestones FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON read_milestones TO newsflow_app USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY worker_all ON read_milestones TO newsflow_worker USING (true) WITH CHECK (true);
CREATE POLICY owner_delete_all ON read_milestones FOR DELETE TO newsflow_owner USING (true);
CREATE POLICY owner_select_all ON read_milestones FOR SELECT TO newsflow_owner USING (true);
GRANT SELECT ON read_milestones TO newsflow_app;
GRANT SELECT, INSERT, DELETE ON read_milestones TO newsflow_worker;
GRANT SELECT, DELETE ON read_milestones TO newsflow_owner;

-- Account deletion removes the milestones too.
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
  DELETE FROM tenant_branding WHERE tenant_id = t;
  DELETE FROM customer_push_subscriptions WHERE tenant_id = t;
  DELETE FROM tg_promo_sends WHERE tenant_id = t;
  DELETE FROM tg_bot_requests WHERE tenant_id = t;
  DELETE FROM read_milestones WHERE tenant_id = t;
  DELETE FROM users WHERE tenant_id = t;
  UPDATE tenants SET status = 'deleted', name = 'deleted', wrapped_dek = 'deleted' WHERE id = t;
  INSERT INTO audit_log (tenant_id, actor, action, target) VALUES (t, 'customer', 'tenant.deleted', t::text);
END $$;
