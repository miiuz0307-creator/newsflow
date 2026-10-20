-- Run once per database server, as a superuser (or via the managed DB console).
-- Creates the three roles the system uses. Passwords are set separately, never in git.
--
--   newsflow_owner  : owns the schema, runs migrations. Never used by the running app.
--   newsflow_app    : the API. Row Level Security limits it to one tenant per transaction.
--   newsflow_worker : delivery workers. Sees all tenants' jobs, cannot change schema.
--   newsflow_admin  : the Super Admin API. Reads across tenants; changes only through
--                     audited functions and a few explicit grants.
--
-- None of these roles has BYPASSRLS or SUPERUSER.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'newsflow_owner') THEN
    CREATE ROLE newsflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'newsflow_app') THEN
    CREATE ROLE newsflow_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'newsflow_worker') THEN
    CREATE ROLE newsflow_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'newsflow_admin') THEN
    CREATE ROLE newsflow_admin LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOINHERIT;
  END IF;
END $$;
