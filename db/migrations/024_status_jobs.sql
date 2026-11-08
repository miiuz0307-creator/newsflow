-- "!סטטוס" copies are marked on the job itself, so the views screen can count statuses separately
-- even after the message content is erased (purge_expired clears content after 7 days).
ALTER TABLE outbound_jobs ADD COLUMN is_status boolean NOT NULL DEFAULT false;
UPDATE outbound_jobs SET is_status = true WHERE content->>'asStatus' = 'true';
