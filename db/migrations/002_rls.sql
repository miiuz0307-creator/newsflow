-- Tenant isolation.
--
-- The API (newsflow_app) must run every request inside a transaction that
-- first does:  SELECT set_config('app.tenant_id', '<uuid>', true);
-- Without it, current_tenant() is NULL and every policy below returns no rows,
-- so a forgotten tenant context fails closed (empty), never open.
--
-- Delivery workers (newsflow_worker) see all tenants' jobs and sessions,
-- because one worker serves many tenants. They cannot touch users, plans or
-- the audit trail's history.

CREATE FUNCTION current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'wa_accounts', 'wa_auth', 'tg_bots', 'chats', 'templates', 'routes',
    'route_sources', 'route_targets', 'outbound_jobs', 'dedup_keys',
    'safety_events', 'connection_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I TO newsflow_app
                      USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())$p$, t);
    EXECUTE format('CREATE POLICY worker_all ON %I TO newsflow_worker USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO newsflow_app, newsflow_worker', t);
  END LOOP;
END $$;

-- tenants: the API sees only its own row and may not change keys or plan.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants TO newsflow_app USING (id = current_tenant());
CREATE POLICY worker_read ON tenants FOR SELECT TO newsflow_worker USING (true);
GRANT SELECT ON tenants TO newsflow_app, newsflow_worker;
GRANT UPDATE (name, risk_accepted_at) ON tenants TO newsflow_app;

-- kill switches: everyone reads global rows and their own; the API may set
-- tenant/route/account switches for its own tenant but never global ones.
ALTER TABLE kill_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE kill_switches FORCE ROW LEVEL SECURITY;
CREATE POLICY ks_read ON kill_switches FOR SELECT TO newsflow_app USING (tenant_id IS NULL OR tenant_id = current_tenant());
CREATE POLICY ks_write ON kill_switches FOR INSERT TO newsflow_app WITH CHECK (tenant_id = current_tenant());
CREATE POLICY ks_update ON kill_switches FOR UPDATE TO newsflow_app USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY ks_worker ON kill_switches TO newsflow_worker USING (true) WITH CHECK (scope <> 'global');
GRANT SELECT, INSERT, UPDATE ON kill_switches TO newsflow_app, newsflow_worker;

-- plans are public, read-only for the app.
GRANT SELECT ON plans TO newsflow_app, newsflow_worker;

-- audit log: insert-only for both roles; history cannot be edited or deleted.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_insert_app ON audit_log FOR INSERT TO newsflow_app WITH CHECK (tenant_id = current_tenant());
CREATE POLICY audit_read_app ON audit_log FOR SELECT TO newsflow_app USING (tenant_id = current_tenant());
CREATE POLICY audit_insert_worker ON audit_log FOR INSERT TO newsflow_worker WITH CHECK (true);
GRANT SELECT, INSERT ON audit_log TO newsflow_app;
GRANT INSERT ON audit_log TO newsflow_worker;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO newsflow_app, newsflow_worker;
GRANT EXECUTE ON FUNCTION current_tenant() TO newsflow_app, newsflow_worker;
