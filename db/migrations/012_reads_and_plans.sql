-- Reads ("נקראה על ידי") and the free plan from the PUSH site.
--
-- WhatsApp tells the sending number when a group member reads a message
-- (only members who did not turn read receipts off). Each read is stored once
-- per reader and copy; outbound_jobs.read_count is the running total, so the
-- dashboard never has to count rows. Telegram does not report reads to bots.

CREATE TABLE message_reads (
  job_id     bigint NOT NULL REFERENCES outbound_jobs(id) ON DELETE CASCADE,
  tenant_id  uuid   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reader     text   NOT NULL,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, reader)
);
CREATE INDEX message_reads_tenant ON message_reads (tenant_id, read_at DESC);

ALTER TABLE outbound_jobs ADD COLUMN read_count integer NOT NULL DEFAULT 0;

ALTER TABLE message_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_reads TO newsflow_app USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY worker_all ON message_reads TO newsflow_worker USING (true) WITH CHECK (true);
CREATE POLICY admin_read ON message_reads FOR SELECT TO newsflow_admin USING (true);
CREATE POLICY owner_delete_all ON message_reads FOR DELETE TO newsflow_owner USING (true);
CREATE POLICY owner_select_all ON message_reads FOR SELECT TO newsflow_owner USING (true);
GRANT SELECT ON message_reads TO newsflow_app, newsflow_admin;
GRANT SELECT, INSERT ON message_reads TO newsflow_worker;

-- Free plan, as on the site: up to 10 target groups, Telegram included.
UPDATE plans
   SET limits = limits || '{"targets":10,"tgBots":1,"dailySends":500}'::jsonb, updated_at = now()
 WHERE code = 'free';
