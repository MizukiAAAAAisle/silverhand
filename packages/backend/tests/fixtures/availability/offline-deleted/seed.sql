INSERT INTO users (id, name, display_name, created_at, updated_at)
VALUES ('u-creator', 'creator', 'Creator', 1000, 1000);

INSERT INTO hosts (id, name, kind, created_at)
VALUES ('h1', 'host-one', 'desktop', 1000);

-- The agent is mid hard-delete: reachability's first rule answers offline before
-- any host fact is consulted, even though the host is live and attached.
INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id, deletion_started_at)
VALUES ('a1', 'agent-one', 'qoder', 'h1', 1000, 1000, 'u-creator', 2000);
