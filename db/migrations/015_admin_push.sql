-- Notifications to the PUSH owner's devices (browser / installed panel), for example
-- "a new customer signed up". One row per device that allowed notifications.
-- Only the admin role reads or writes it; customers' roles have no access.

CREATE TABLE admin_push_subscriptions (
  endpoint     text PRIMARY KEY,                 -- the browser's push address
  admin_id     uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  p256dh       text NOT NULL,                    -- the device's public key (base64url)
  auth         text NOT NULL,                    -- the device's auth secret (base64url)
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_ok_at   timestamptz
);
CREATE INDEX admin_push_by_admin ON admin_push_subscriptions (admin_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_push_subscriptions TO newsflow_admin;
