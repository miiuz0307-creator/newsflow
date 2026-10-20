-- Core schema for phase 1: tenants, connected accounts, encrypted sessions,
-- chats, templates, routes, the outbound job queue, safety and audit.
--
-- Every tenant-owned table carries tenant_id and is protected by Row Level
-- Security (see 002_rls.sql). Message bodies are kept only as long as needed
-- to deliver them (purged by retention job, see 003).

CREATE TABLE plans (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  price_agorot  integer NOT NULL CHECK (price_agorot >= 0),   -- monthly price before VAT, in agorot
  currency      text NOT NULL DEFAULT 'ILS',
  limits        jsonb NOT NULL,                              -- {"waAccounts":1,"targets":30,"dailySends":2000,...}
  active        boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  plan_code      text NOT NULL REFERENCES plans(code),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  -- Tenant data key, wrapped by the master key. Never stored unwrapped.
  wrapped_dek    text NOT NULL,
  master_key_id  text NOT NULL,
  risk_accepted_at timestamptz,                              -- when the customer accepted the unofficial-connection risk
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          text NOT NULL,
  password_hash  text,
  role           text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'editor')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE wa_accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label                   text NOT NULL DEFAULT '',
  phone_number            text,
  status                  text NOT NULL DEFAULT 'new',
  worker_id               text,                                -- which worker holds the session
  last_connected_at       timestamptz,
  last_disconnect_reason  text,
  last_disconnect_at      timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wa_accounts_tenant ON wa_accounts (tenant_id);

-- Encrypted Baileys auth state: one row for creds, many for signal keys.
CREATE TABLE wa_auth (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  key         text NOT NULL,
  blob        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);

CREATE TABLE tg_bots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username    text,
  token_blob  text NOT NULL,                                 -- encrypted bot token
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chats (
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform           text NOT NULL CHECK (platform IN ('wa', 'tg')),
  account_id         uuid NOT NULL,
  chat_id            text NOT NULL,
  title              text NOT NULL DEFAULT '',
  type               text NOT NULL DEFAULT 'group',
  can_send           boolean NOT NULL DEFAULT false,
  is_admin           boolean NOT NULL DEFAULT false,
  participant_count  integer,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, account_id, chat_id)
);
CREATE INDEX chats_tenant ON chats (tenant_id);

CREATE TABLE templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  body        text NOT NULL,
  vars        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE routes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              text NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  filters           jsonb NOT NULL DEFAULT '{}'::jsonb,
  template_id       uuid REFERENCES templates(id) ON DELETE SET NULL,
  require_approval  boolean NOT NULL DEFAULT false,
  delay_seconds     integer NOT NULL DEFAULT 0 CHECK (delay_seconds BETWEEN 0 AND 86400),
  quiet_hours       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX routes_tenant ON routes (tenant_id);

CREATE TABLE route_sources (
  route_id    uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  account_id  uuid NOT NULL,
  chat_id     text NOT NULL,
  PRIMARY KEY (route_id, platform, account_id, chat_id)
);
CREATE INDEX route_sources_lookup ON route_sources (platform, account_id, chat_id);

CREATE TABLE route_targets (
  route_id    uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  account_id  uuid NOT NULL,
  chat_id     text NOT NULL,
  title       text,
  PRIMARY KEY (route_id, platform, account_id, chat_id)
);

-- The outbound queue. Workers claim rows with FOR UPDATE SKIP LOCKED, so
-- several workers can run without sending the same job twice.
CREATE TABLE outbound_jobs (
  id                 bigserial PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route_id           uuid REFERENCES routes(id) ON DELETE SET NULL,
  idempotency_key    text NOT NULL UNIQUE,
  source             jsonb NOT NULL,
  source_message_id  text NOT NULL,
  target_platform    text NOT NULL,
  target_account_id  uuid NOT NULL,
  target_chat_id     text NOT NULL,
  target_title       text,
  content            jsonb,                                  -- {kind,text,media:{mimeType,size,ref}}; nulled after delivery+retention
  status             text NOT NULL CHECK (status IN ('pending_approval', 'queued', 'sending', 'sent', 'failed', 'skipped', 'cancelled')),
  not_before         timestamptz NOT NULL DEFAULT now(),
  attempts           integer NOT NULL DEFAULT 0,
  error_kind         text,
  last_error         text,
  sent_message_id    text,
  locked_by          text,
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz
);
CREATE INDEX outbound_ready ON outbound_jobs (not_before) WHERE status = 'queued';
CREATE INDEX outbound_sent_by_account ON outbound_jobs (target_account_id, sent_at) WHERE status = 'sent';
CREATE INDEX outbound_tenant_created ON outbound_jobs (tenant_id, created_at DESC);

CREATE TABLE dedup_keys (
  key         text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX dedup_expiry ON dedup_keys (expires_at);

-- Emergency stops at four levels. A row with active=true blocks sending in its scope.
CREATE TABLE kill_switches (
  scope      text NOT NULL CHECK (scope IN ('global', 'tenant', 'account', 'route')),
  scope_id   text NOT NULL,                                 -- '*' for global
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE, -- NULL only for global
  active     boolean NOT NULL DEFAULT true,
  reason     text NOT NULL,
  set_by     text NOT NULL,                                 -- 'system:auto' or a user/admin id
  set_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_id),
  CHECK ((scope = 'global') = (tenant_id IS NULL))
);

CREATE TABLE safety_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id  uuid,
  kind        text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX safety_events_tenant ON safety_events (tenant_id, created_at DESC);

CREATE TABLE connection_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL,
  status      text NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connection_events_account ON connection_events (account_id, created_at DESC);

-- Append-only audit trail of sensitive actions.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid REFERENCES tenants(id) ON DELETE SET NULL,
  actor       text NOT NULL,
  action      text NOT NULL,
  target      text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant ON audit_log (tenant_id, created_at DESC);

-- Opening plans. Prices and limits are data: change them here, not in code.
INSERT INTO plans (code, name, price_agorot, limits) VALUES
  ('free',     'חינמי',  0,     '{"waAccounts":1,"sources":1,"targets":3,"dailySends":100,"routes":1}'),
  ('trial',    'ניסיון', 0,     '{"waAccounts":1,"sources":5,"targets":30,"dailySends":2000,"routes":10,"days":14}'),
  ('premium',  'פרימיום', 25000, '{"waAccounts":1,"sources":10,"targets":30,"dailySends":2000,"routes":20}'),
  ('business', 'עסקי',   49900, '{"waAccounts":3,"sources":30,"targets":100,"dailySends":6000,"routes":100,"extraAdmins":true}');
