-- Phase 2: sign-up, login, refresh tokens, account deletion.

ALTER TABLE users
  ADD COLUMN failed_logins integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until  timestamptz,
  ADD COLUMN last_login_at timestamptz,
  ADD COLUMN display_name  text;

-- Login happens before we know the tenant, so the lookup is a narrow
-- SECURITY DEFINER function: it returns one user by email and nothing else.
CREATE FUNCTION auth_lookup(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, role text, failed_logins integer, locked_until timestamptz, tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.tenant_id, u.password_hash, u.role, u.failed_logins, u.locked_until, t.status
      FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE lower(u.email) = lower(p_email)
  $$;

-- Records a login attempt: resets the counter on success; after 5 failures the
-- account is locked for 15 minutes (doubling up to 24 hours on repeat).
CREATE FUNCTION auth_record_attempt(p_user uuid, p_success boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_success THEN
    UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = p_user;
  ELSE
    UPDATE users
       SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= 5
                               THEN now() + LEAST(interval '24 hours', interval '15 minutes' * power(2, failed_logins + 1 - 5))
                               ELSE locked_until END
     WHERE id = p_user;
  END IF;
END $$;

-- The owner role needs to read/update users inside these SECURITY DEFINER functions.
CREATE POLICY owner_auth_read ON users FOR SELECT TO newsflow_owner USING (true);
CREATE POLICY owner_auth_update ON users FOR UPDATE TO newsflow_owner USING (true) WITH CHECK (true);

REVOKE ALL ON FUNCTION auth_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_record_attempt(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup(text), auth_record_attempt(uuid, boolean) TO newsflow_app;

-- Refresh tokens: stored only as SHA-256 hashes; rotated on every use.
-- The token presented by the client is "<tenant id>.<random>", so the API can
-- set the tenant context before looking it up (RLS stays in force).
CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refresh_tokens TO newsflow_app USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO newsflow_app;

-- Account deletion (Google Play requirement): the customer's own data goes;
-- the audit trail stays (legal retention), with the user's email removed.
CREATE FUNCTION delete_my_tenant() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  t uuid := current_tenant();
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501'; END IF;
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

-- Inside delete_my_tenant() (running as the owner role), DELETE ... WHERE needs both
-- SELECT and DELETE visibility. The function itself restricts everything to current_tenant().
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbound_jobs','dedup_keys','route_sources','route_targets','routes','templates','chats',
                           'wa_auth','wa_accounts','tg_bots','connection_events','safety_events','refresh_tokens','kill_switches','users'] LOOP
    EXECUTE format('CREATE POLICY owner_delete_all ON %I FOR DELETE TO newsflow_owner USING (true)', t);
    IF t NOT IN ('users', 'kill_switches') THEN
      EXECUTE format('CREATE POLICY owner_select_all ON %I FOR SELECT TO newsflow_owner USING (true)', t);
    END IF;
  END LOOP;
END $$;
CREATE POLICY owner_select_all ON kill_switches FOR SELECT TO newsflow_owner USING (true);

REVOKE ALL ON FUNCTION delete_my_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_my_tenant() TO newsflow_app;
