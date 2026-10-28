-- "Create a Telegram bot in one tap": the customer opens a link, Telegram creates a bot that
-- they own and that PUSH's manager bot controls (Telegram managed bots). The request remembers
-- which customer asked for which bot username, so the new bot is connected to the right account.
CREATE TABLE tg_bot_requests (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username    text NOT NULL,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  created_at  timestamptz NOT NULL DEFAULT now(),
  bot_id      uuid,
  error       text
);
CREATE UNIQUE INDEX tg_bot_requests_username ON tg_bot_requests (lower(username));
ALTER TABLE tg_bot_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tg_bot_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tg_bot_requests TO newsflow_app USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY worker_all ON tg_bot_requests TO newsflow_worker USING (true) WITH CHECK (true);
CREATE POLICY owner_delete_all ON tg_bot_requests FOR DELETE TO newsflow_owner USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON tg_bot_requests TO newsflow_app;
GRANT SELECT, UPDATE ON tg_bot_requests TO newsflow_worker;

-- Account deletion removes the request too.
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
  DELETE FROM users WHERE tenant_id = t;
  UPDATE tenants SET status = 'deleted', name = 'deleted', wrapped_dek = 'deleted' WHERE id = t;
  INSERT INTO audit_log (tenant_id, actor, action, target) VALUES (t, 'customer', 'tenant.deleted', t::text);
END $$;
