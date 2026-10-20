-- Fixes from the independent security review (2026-10-20).

-- 1. Delivery workers have no business with users (emails, password hashes).
DROP POLICY worker_all ON users;
REVOKE ALL ON users FROM newsflow_worker;

-- 2. Sign-up may only create free or trial tenants; upgrades go through billing/admin.
CREATE OR REPLACE FUNCTION provision_tenant(
  p_name text, p_plan text, p_wrapped_dek text, p_master_key_id text, p_owner_email text, p_password_hash text
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  tid uuid;
BEGIN
  IF p_plan NOT IN ('free', 'trial') THEN
    RAISE EXCEPTION 'sign-up can only create free or trial tenants (got %)', p_plan USING ERRCODE = '42501';
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

-- Plan changes and suspensions are an administrator action (run as the owner
-- role from the admin backend), always audited.
CREATE POLICY owner_admin_update ON tenants FOR UPDATE TO newsflow_owner USING (key_final) WITH CHECK (key_final);

CREATE FUNCTION admin_set_tenant(p_tenant uuid, p_plan text, p_status text, p_actor text) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE tenants SET plan_code = COALESCE(p_plan, plan_code), status = COALESCE(p_status, status) WHERE id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant not found'; END IF;
  INSERT INTO audit_log (tenant_id, actor, action, target, detail)
       VALUES (p_tenant, p_actor, 'tenant.admin_update', p_tenant::text, jsonb_build_object('plan', p_plan, 'status', p_status));
END $$;
REVOKE ALL ON FUNCTION admin_set_tenant(uuid, text, text, text) FROM PUBLIC;

-- 3. Loop guard: find messages the system itself sent, by chat and message id.
CREATE INDEX outbound_sent_message ON outbound_jobs (target_chat_id, sent_message_id) WHERE sent_message_id IS NOT NULL;
