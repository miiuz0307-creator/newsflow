-- When (and which version of) the terms of use and privacy policy a customer accepted at signup.
-- Kept as evidence of consent; the signup refuses to proceed without it.
ALTER TABLE tenants ADD COLUMN terms_accepted_at timestamptz;
ALTER TABLE tenants ADD COLUMN terms_version text CHECK (terms_version IS NULL OR length(terms_version) <= 20);
GRANT UPDATE (terms_accepted_at, terms_version) ON tenants TO newsflow_app;
GRANT SELECT (terms_accepted_at, terms_version) ON tenants TO newsflow_admin;
