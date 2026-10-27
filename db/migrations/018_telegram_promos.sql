-- Free-plan customers: PUSH publishes its own posts in the Telegram channels and groups
-- they connect (they agree to this when connecting Telegram on the free plan).
-- Premium customers get no such posts. The admin can always stop a customer.

ALTER TABLE tenants ADD COLUMN tg_promo_ok_at timestamptz;
GRANT UPDATE (tg_promo_ok_at) ON tenants TO newsflow_app;
GRANT SELECT (tg_promo_ok_at) ON tenants TO newsflow_admin;

-- One post by PUSH to the free customers' Telegram channels.
CREATE TABLE tg_promos (
  id           bigserial PRIMARY KEY,
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_by   text NOT NULL,                 -- 'admin:<id>'
  created_at   timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'done', 'retracted')),
  targets      integer NOT NULL DEFAULT 0,
  sent         integer NOT NULL DEFAULT 0,
  failed       integer NOT NULL DEFAULT 0,
  finished_at  timestamptz,
  retracted_at timestamptz
);
-- Each copy (kept so a post can be removed from every channel again).
CREATE TABLE tg_promo_sends (
  promo_id    bigint NOT NULL REFERENCES tg_promos(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL,
  chat_id     text NOT NULL,
  title       text,
  message_id  text,
  error       text,
  sent_at     timestamptz,
  PRIMARY KEY (promo_id, bot_id, chat_id)
);
CREATE INDEX tg_promo_sends_tenant ON tg_promo_sends (tenant_id);
GRANT SELECT, INSERT, UPDATE ON tg_promos TO newsflow_worker;
GRANT USAGE ON SEQUENCE tg_promos_id_seq TO newsflow_worker;
GRANT SELECT, INSERT, UPDATE ON tg_promo_sends TO newsflow_worker;
GRANT SELECT ON tg_promos, tg_promo_sends TO newsflow_admin;

-- Account deletion removes the customer's copies too.
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
  DELETE FROM users WHERE tenant_id = t;
  UPDATE tenants SET status = 'deleted', name = 'deleted', wrapped_dek = 'deleted' WHERE id = t;
  INSERT INTO audit_log (tenant_id, actor, action, target) VALUES (t, 'customer', 'tenant.deleted', t::text);
END $$;
