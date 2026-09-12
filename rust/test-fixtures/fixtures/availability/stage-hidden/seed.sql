INSERT INTO users (id, name, display_name, created_at, updated_at)
VALUES ('u-creator', 'creator', 'Creator', 1000, 1000);

INSERT INTO hosts (id, name, kind, created_at)
VALUES ('h1', 'host-one', 'desktop', 1000);

-- The viewer IS the creator (inside the ACL), but the default view is active-only
-- and the row is failed: a stage the view hides collapses to the SAME 404, so the
-- surface never leaks that a non-active agent exists.
INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id, materialization_status)
VALUES ('a1', 'agent-one', 'qoder', 'h1', 1000, 1000, 'u-creator', 'failed');
