-- Phase 2: Telegram bot management, support tickets, customer notifications.

ALTER TABLE tg_bots
  ADD COLUMN bot_user_id bigint,
  ADD COLUMN update_offset bigint,
  ADD COLUMN last_error text;
CREATE UNIQUE INDEX tg_bots_bot_user ON tg_bots (bot_user_id) WHERE status <> 'deleted';

-- Telegram bots per plan.
UPDATE plans SET limits = limits || '{"tgBots":1}'::jsonb WHERE code = 'free';
UPDATE plans SET limits = limits || '{"tgBots":2}'::jsonb WHERE code IN ('trial', 'premium');
UPDATE plans SET limits = limits || '{"tgBots":5}'::jsonb WHERE code = 'business';

-- Support tickets.
CREATE TABLE tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  subject     text NOT NULL,
  category    text NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'connection', 'billing', 'bug', 'other')),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_customer', 'waiting_support', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_tenant ON tickets (tenant_id, updated_at DESC);
CREATE INDEX tickets_status ON tickets (status, updated_at);

CREATE TABLE ticket_messages (
  id          bigserial PRIMARY KEY,
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author      text NOT NULL,                 -- 'customer:<user id>' or 'staff:<admin id>'
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_messages_ticket ON ticket_messages (ticket_id, id);

-- In-app notifications (push delivery is a separate channel added with the app).
CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL,                 -- 'account_blocked', 'disconnected', 'rate_limited', 'ticket_reply', 'system'…
  title       text NOT NULL,
  body        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_tenant ON notifications (tenant_id, created_at DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tickets', 'ticket_messages', 'notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I TO newsflow_app
                      USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())$p$, t);
    EXECUTE format('CREATE POLICY worker_all ON %I TO newsflow_worker USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO newsflow_app, newsflow_worker', t);
    EXECUTE format('CREATE POLICY owner_delete_all ON %I FOR DELETE TO newsflow_owner USING (true)', t);
    EXECUTE format('CREATE POLICY owner_select_all ON %I FOR SELECT TO newsflow_owner USING (true)', t);
  END LOOP;
END $$;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO newsflow_app, newsflow_worker;

-- Account deletion also removes tickets and notifications.
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
