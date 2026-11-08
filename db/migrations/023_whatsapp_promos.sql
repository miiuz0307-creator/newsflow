-- Groupush's own posts, now also in the WhatsApp groups of free-plan customers.
--
-- WhatsApp posts go out through the customer's own number, so they need their own agreement
-- (tenants.wa_promo_ok_at), separate from the Telegram one. They go only to the groups the
-- customer distributes to (route targets), never to a control group and never to other groups
-- the number happens to be in.
--
-- The admin now also picks which customers get a post and on which platforms.

ALTER TABLE tenants ADD COLUMN wa_promo_ok_at timestamptz;
GRANT UPDATE (wa_promo_ok_at) ON tenants TO newsflow_app;
GRANT SELECT (wa_promo_ok_at) ON tenants TO newsflow_admin;

ALTER TABLE tg_promos ADD COLUMN platforms text[] NOT NULL DEFAULT '{tg}';
ALTER TABLE tg_promos ADD COLUMN tenant_ids uuid[];          -- who was picked (NULL: everyone, as before)

-- bot_id now holds the WhatsApp number's account id for WhatsApp copies.
ALTER TABLE tg_promo_sends ADD COLUMN platform text NOT NULL DEFAULT 'tg' CHECK (platform IN ('tg', 'wa'));
