-- Lets a worker store a tenant's wrapped data key right after provisioning
-- (the key's encryption is bound to the tenant id, which exists only after
-- the insert). Only allowed once: a key that is already final cannot be
-- replaced through this function — key rotation will get its own procedure.

ALTER TABLE tenants ADD COLUMN key_final boolean NOT NULL DEFAULT false;

CREATE POLICY owner_set_key ON tenants FOR UPDATE TO newsflow_owner USING (NOT key_final) WITH CHECK (true);
CREATE POLICY owner_read ON tenants FOR SELECT TO newsflow_owner USING (true);

CREATE FUNCTION set_tenant_key(p_tenant uuid, p_wrapped text, p_master_key_id text) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  UPDATE tenants SET wrapped_dek = p_wrapped, master_key_id = p_master_key_id, key_final = true
   WHERE id = p_tenant AND NOT key_final;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant key already set or tenant missing' USING ERRCODE = '42501';
  END IF;
END $$;

REVOKE ALL ON FUNCTION set_tenant_key(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_tenant_key(uuid, text, text) TO newsflow_worker;
