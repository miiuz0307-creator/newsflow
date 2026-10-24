-- Logo ("watermark") burned into the videos, and optionally the photos, that a
-- customer distributes. One row per tenant. The logo is stored as base64 text
-- (max ~1 MB image), with where it sits, how big it is and how see-through.

CREATE TABLE tenant_branding (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  logo_b64     text NOT NULL,
  logo_mime    text NOT NULL CHECK (logo_mime IN ('image/png', 'image/jpeg', 'image/webp')),
  position     text NOT NULL DEFAULT 'bottom-left' CHECK (position IN ('top-right', 'top-left', 'bottom-right', 'bottom-left', 'center')),
  size_pct     integer NOT NULL DEFAULT 18 CHECK (size_pct BETWEEN 5 AND 40),
  opacity_pct  integer NOT NULL DEFAULT 85 CHECK (opacity_pct BETWEEN 20 AND 100),
  apply_video  boolean NOT NULL DEFAULT true,
  apply_image  boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (length(logo_b64) <= 1400000)
);

ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_branding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_branding TO newsflow_app USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY worker_read ON tenant_branding FOR SELECT TO newsflow_worker USING (true);
CREATE POLICY owner_delete_all ON tenant_branding FOR DELETE TO newsflow_owner USING (true);
CREATE POLICY owner_select_all ON tenant_branding FOR SELECT TO newsflow_owner USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_branding TO newsflow_app;
GRANT SELECT ON tenant_branding TO newsflow_worker;

-- Account deletion removes the logo too.
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
  DELETE FROM users WHERE tenant_id = t;
  UPDATE tenants SET status = 'deleted', name = 'deleted', wrapped_dek = 'deleted' WHERE id = t;
  INSERT INTO audit_log (tenant_id, actor, action, target) VALUES (t, 'customer', 'tenant.deleted', t::text);
END $$;
