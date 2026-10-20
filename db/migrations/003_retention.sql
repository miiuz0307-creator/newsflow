-- Data retention: message content is kept only while it is useful.
--  - content of finished jobs is erased after 7 days (metadata stays for statistics)
--  - expired duplicate-detection keys are deleted
-- Run purge_expired() from a scheduled job (e.g. every hour).

CREATE FUNCTION purge_expired(content_days integer DEFAULT 7) RETURNS TABLE (jobs_cleared bigint, dedup_deleted bigint)
  LANGUAGE plpgsql
  AS $$
DECLARE
  a bigint;
  b bigint;
BEGIN
  UPDATE outbound_jobs
     SET content = NULL
   WHERE content IS NOT NULL
     AND status IN ('sent', 'failed', 'skipped', 'cancelled')
     AND updated_at < now() - make_interval(days => content_days);
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM dedup_keys WHERE expires_at < now();
  GET DIAGNOSTICS b = ROW_COUNT;
  RETURN QUERY SELECT a, b;
END $$;

GRANT EXECUTE ON FUNCTION purge_expired(integer) TO newsflow_worker;
