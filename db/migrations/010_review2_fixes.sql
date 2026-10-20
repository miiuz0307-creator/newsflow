-- Fixes from the second security review (phase 2).

-- M2 + M3: a login attempt is counted atomically BEFORE the password is checked,
-- so parallel guesses can't slip past the lock; a locked or unknown account looks
-- the same to the caller. The lock is capped at 1 hour so nobody can keep a real
-- user out for a day.
CREATE OR REPLACE FUNCTION auth_begin_attempt(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, role text, tenant_status text)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE users u
       SET failed_logins = u.failed_logins + 1,
           locked_until = CASE WHEN u.failed_logins + 1 >= 5
                               THEN now() + LEAST(interval '1 hour', interval '15 minutes' * power(2, u.failed_logins + 1 - 5))
                               ELSE NULL END
      FROM tenants t
     WHERE t.id = u.tenant_id AND lower(u.email) = lower(p_email)
       AND (u.locked_until IS NULL OR u.locked_until < now())
    RETURNING u.id, u.tenant_id, u.password_hash, u.role, t.status
  $$;

CREATE OR REPLACE FUNCTION auth_login_succeeded(p_user uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = p_user $$;

REVOKE ALL ON FUNCTION auth_begin_attempt(text), auth_login_succeeded(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_begin_attempt(text), auth_login_succeeded(uuid) TO newsflow_app;
-- The old two-step functions are no longer used.
REVOKE EXECUTE ON FUNCTION auth_lookup(text), auth_record_attempt(uuid, boolean) FROM newsflow_app;
CREATE POLICY owner_tenants_read ON tenants FOR SELECT TO newsflow_owner USING (true);

-- M6: an admin TOTP code may be used once (store the last accepted time step).
-- M7: TOTP secrets are now stored encrypted (application side).
ALTER TABLE admins ADD COLUMN last_totp_step bigint NOT NULL DEFAULT 0;
GRANT UPDATE (last_totp_step) ON admins TO newsflow_admin;

-- M2 for admins: atomic attempt counting, same pattern.
CREATE OR REPLACE FUNCTION admin_begin_attempt(p_email text)
RETURNS TABLE (id uuid, password_hash text, totp_secret text, role text, last_totp_step bigint)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE admins a
       SET failed_logins = a.failed_logins + 1,
           locked_until = CASE WHEN a.failed_logins + 1 >= 5 THEN now() + interval '30 minutes' ELSE NULL END
     WHERE lower(a.email) = lower(p_email) AND a.active
       AND (a.locked_until IS NULL OR a.locked_until < now())
    RETURNING a.id, a.password_hash, a.totp_secret, a.role, a.last_totp_step
  $$;
REVOKE ALL ON FUNCTION admin_begin_attempt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_begin_attempt(text) TO newsflow_admin;
GRANT SELECT, UPDATE ON admins TO newsflow_owner;

-- M5: a customer can never overwrite a stop set by an administrator or by the system.
-- (Enforced in the application's upsert; this trigger is the backstop.)
CREATE FUNCTION kill_switch_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.active AND OLD.set_by NOT LIKE 'user:%' AND NEW.set_by LIKE 'user:%' THEN
    RAISE EXCEPTION 'stop set by % cannot be changed by a customer', OLD.set_by USING ERRCODE = '42501';
  END IF;
  IF OLD.active AND NOT NEW.active AND OLD.set_by NOT LIKE 'user:%' AND current_user = 'newsflow_app' THEN
    RAISE EXCEPTION 'stop set by % cannot be lifted by a customer', OLD.set_by USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kill_switch_guard BEFORE UPDATE ON kill_switches FOR EACH ROW EXECUTE FUNCTION kill_switch_guard();
