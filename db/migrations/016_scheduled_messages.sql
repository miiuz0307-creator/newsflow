-- Scheduled messages: a control-group message that starts with "תזמון (HH:MM)" is held
-- until that time. scheduled_at = when it was set to go out; the "too old" check counts
-- from there (not from when it was written), and edits before that time can move it.
ALTER TABLE outbound_jobs ADD COLUMN scheduled_at timestamptz;
