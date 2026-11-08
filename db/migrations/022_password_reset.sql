-- "Forgot password": a 6-digit code sent by email, valid 15 minutes, 5 tries.
-- Only a hash of the code is stored. The functions run as the owner (SECURITY DEFINER) because
-- the customer is not signed in, and return nothing that tells whether an email exists.
CREATE TABLE password_resets (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_all ON password_resets TO newsflow_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_reset_tokens_read ON refresh_tokens FOR SELECT TO newsflow_owner USING (true);
CREATE POLICY owner_reset_tokens_revoke ON refresh_tokens FOR UPDATE TO newsflow_owner USING (true) WITH CHECK (true);

-- Starts a reset: returns the user id when the email belongs to an active account (the API
-- answers the same either way). A new request replaces an older code.
CREATE FUNCTION auth_reset_request(p_email text, p_code_hash text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  u record;
BEGIN
  SELECT us.id, us.tenant_id INTO u FROM users us JOIN tenants t ON t.id = us.tenant_id
   WHERE lower(us.email) = lower(p_email) AND t.status = 'active' LIMIT 1;
  IF u.id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO password_resets (user_id, tenant_id, code_hash, expires_at, attempts, created_at)
  VALUES (u.id, u.tenant_id, p_code_hash, now() + interval '15 minutes', 0, now())
  ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now();
  RETURN u.id;
END $$;

-- Finishes a reset: 'ok' (password set, lockout lifted, every session signed out),
-- 'bad_code' (one try used) or 'expired' (no code, too old, or 5 wrong tries).
CREATE FUNCTION auth_reset_finish(p_email text, p_code_hash text, p_password_hash text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  r record;
BEGIN
  SELECT pr.* INTO r FROM password_resets pr JOIN users us ON us.id = pr.user_id
   WHERE lower(us.email) = lower(p_email) LIMIT 1;
  IF r.user_id IS NULL OR r.expires_at < now() OR r.attempts >= 5 THEN
    IF r.user_id IS NOT NULL THEN DELETE FROM password_resets WHERE user_id = r.user_id; END IF;
    RETURN 'expired';
  END IF;
  IF r.code_hash <> p_code_hash THEN
    UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = r.user_id;
    RETURN 'bad_code';
  END IF;
  UPDATE users SET password_hash = p_password_hash, failed_logins = 0, locked_until = NULL WHERE id = r.user_id;
  UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = r.user_id AND revoked_at IS NULL;
  DELETE FROM password_resets WHERE user_id = r.user_id;
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION auth_reset_request(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_reset_finish(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_reset_request(text, text), auth_reset_finish(text, text, text) TO newsflow_app;
