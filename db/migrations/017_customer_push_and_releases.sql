-- Customers' devices that allowed notifications (the app on their phone or computer):
-- alerts about their number (disconnected, blocked...) and "what's new in PUSH".
CREATE TABLE customer_push_subscriptions (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint     text NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_ok_at   timestamptz,
  PRIMARY KEY (tenant_id, endpoint)
);
ALTER TABLE customer_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_push_subscriptions TO newsflow_app USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY worker_all ON customer_push_subscriptions TO newsflow_worker USING (true) WITH CHECK (true);
CREATE POLICY admin_read ON customer_push_subscriptions FOR SELECT TO newsflow_admin USING (true);
CREATE POLICY owner_delete_all ON customer_push_subscriptions FOR DELETE TO newsflow_owner USING (true);
CREATE POLICY owner_select_all ON customer_push_subscriptions FOR SELECT TO newsflow_owner USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_push_subscriptions TO newsflow_app;
GRANT SELECT, UPDATE, DELETE ON customer_push_subscriptions TO newsflow_worker;
GRANT SELECT ON customer_push_subscriptions TO newsflow_admin;

-- Small system facts, e.g. which release was already announced to devices.
CREATE TABLE system_meta (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON system_meta TO newsflow_worker;

-- Account deletion removes the customer's notification devices too.
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
  DELETE FROM users WHERE tenant_id = t;
  UPDATE tenants SET status = 'deleted', name = 'deleted', wrapped_dek = 'deleted' WHERE id = t;
  INSERT INTO audit_log (tenant_id, actor, action, target) VALUES (t, 'customer', 'tenant.deleted', t::text);
END $$;
