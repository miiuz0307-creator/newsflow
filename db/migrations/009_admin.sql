-- Phase 2: Super Admin.
-- The admin API connects as newsflow_admin: it can read across tenants for
-- support and monitoring, and changes things only through explicit grants and
-- audited functions. It cannot read WhatsApp sessions or Telegram tokens.

GRANT USAGE ON SCHEMA public TO newsflow_admin;

CREATE TABLE admins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  totp_secret    text NOT NULL,                -- base32; required second factor
  role           text NOT NULL DEFAULT 'support' CHECK (role IN ('superadmin', 'support')),
  active         boolean NOT NULL DEFAULT true,
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admins_email_uq ON admins (lower(email));
GRANT SELECT, UPDATE (failed_logins, locked_until, last_login_at) ON admins TO newsflow_admin;

-- Read access across tenants (not wa_auth, not tg_bots.token_blob, not password hashes).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'wa_accounts', 'chats', 'templates', 'routes', 'route_sources', 'route_targets', 'outbound_jobs',
    'safety_events', 'connection_events', 'tickets', 'ticket_messages', 'notifications'
  ] LOOP
    EXECUTE format('CREATE POLICY admin_read ON %I FOR SELECT TO newsflow_admin USING (true)', t);
    EXECUTE format('GRANT SELECT ON %I TO newsflow_admin', t);
  END LOOP;
END $$;
CREATE POLICY admin_read ON tenants FOR SELECT TO newsflow_admin USING (true);
GRANT SELECT (id, name, plan_code, status, risk_accepted_at, created_at) ON tenants TO newsflow_admin;
CREATE POLICY admin_read ON users FOR SELECT TO newsflow_admin USING (true);
GRANT SELECT (id, tenant_id, email, display_name, role, last_login_at, created_at) ON users TO newsflow_admin;
CREATE POLICY admin_read ON tg_bots FOR SELECT TO newsflow_admin USING (true);
GRANT SELECT (id, tenant_id, username, status, last_error, created_at) ON tg_bots TO newsflow_admin;
CREATE POLICY admin_read ON audit_log FOR SELECT TO newsflow_admin USING (true);
GRANT SELECT ON audit_log TO newsflow_admin;
CREATE POLICY admin_insert ON audit_log FOR INSERT TO newsflow_admin WITH CHECK (actor LIKE 'admin:%');
GRANT INSERT ON audit_log TO newsflow_admin;

-- Support work: reply to tickets, set status, notify customers.
CREATE POLICY admin_update ON tickets FOR UPDATE TO newsflow_admin USING (true) WITH CHECK (true);
GRANT UPDATE (status, updated_at) ON tickets TO newsflow_admin;
CREATE POLICY admin_insert ON ticket_messages FOR INSERT TO newsflow_admin WITH CHECK (author LIKE 'staff:%');
GRANT INSERT ON ticket_messages TO newsflow_admin;
CREATE POLICY admin_insert ON notifications FOR INSERT TO newsflow_admin WITH CHECK (true);
GRANT INSERT ON notifications TO newsflow_admin;

-- Emergency stops at every level, including global.
CREATE POLICY admin_all ON kill_switches TO newsflow_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON kill_switches TO newsflow_admin;

-- Prices and limits: data, editable without code.
GRANT SELECT, UPDATE (name, price_agorot, limits, active, updated_at) ON plans TO newsflow_admin;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO newsflow_admin;

-- Plan/status changes run as the owner (it may update tenants) and are always audited.
CREATE OR REPLACE FUNCTION admin_set_tenant(p_tenant uuid, p_plan text, p_status text, p_actor text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_actor IS NULL OR p_actor NOT LIKE 'admin:%' THEN RAISE EXCEPTION 'actor required' USING ERRCODE = '42501'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'suspended') THEN RAISE EXCEPTION 'bad status %', p_status; END IF;
  IF p_plan IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plans WHERE code = p_plan) THEN RAISE EXCEPTION 'unknown plan %', p_plan; END IF;
  UPDATE tenants SET plan_code = COALESCE(p_plan, plan_code), status = COALESCE(p_status, status) WHERE id = p_tenant AND status <> 'deleted';
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO audit_log (tenant_id, actor, action, target, detail)
       VALUES (p_tenant, p_actor, 'tenant.admin_update', p_tenant::text, jsonb_build_object('plan', p_plan, 'status', p_status));
END $$;
REVOKE ALL ON FUNCTION admin_set_tenant(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_set_tenant(uuid, text, text, text) TO newsflow_admin, newsflow_owner;
