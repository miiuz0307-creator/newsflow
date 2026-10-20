-- Signing up creates a tenant and its owner user. The API role may not
-- insert tenants directly (it would have to see other tenants' rows to
-- check uniqueness), so it calls this function, which runs as the schema
-- owner with a narrowly scoped INSERT policy.

CREATE POLICY owner_provision ON tenants FOR INSERT TO newsflow_owner WITH CHECK (true);
CREATE POLICY owner_provision ON users FOR INSERT TO newsflow_owner WITH CHECK (true);

CREATE FUNCTION provision_tenant(
  p_name text, p_plan text, p_wrapped_dek text, p_master_key_id text, p_owner_email text, p_password_hash text
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  tid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plans WHERE code = p_plan AND active) THEN
    RAISE EXCEPTION 'unknown plan %', p_plan USING ERRCODE = '22023';
  END IF;
  INSERT INTO tenants (name, plan_code, wrapped_dek, master_key_id)
       VALUES (p_name, p_plan, p_wrapped_dek, p_master_key_id)
    RETURNING id INTO tid;
  IF p_owner_email IS NOT NULL THEN
    INSERT INTO users (tenant_id, email, password_hash, role) VALUES (tid, p_owner_email, p_password_hash, 'owner');
  END IF;
  INSERT INTO audit_log (tenant_id, actor, action, target) VALUES (tid, 'system', 'tenant.created', tid::text);
  RETURN tid;
END $$;

CREATE POLICY owner_provision ON audit_log FOR INSERT TO newsflow_owner WITH CHECK (true);

REVOKE ALL ON FUNCTION provision_tenant(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_tenant(text, text, text, text, text, text) TO newsflow_app;
