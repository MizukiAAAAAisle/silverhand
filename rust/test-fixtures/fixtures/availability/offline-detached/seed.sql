INSERT INTO users (id, name, display_name, created_at, updated_at)
VALUES ('u-creator', 'creator', 'Creator', 1000, 1000);

-- The host is live and unrevoked, but the transport holds no attachment for it
-- (input.attached_hosts is empty): the last reachability rule answers offline.
INSERT INTO hosts (id, name, kind, created_at)
VALUES ('h1', 'host-one', 'desktop', 1000);

INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id)
VALUES ('a1', 'agent-one', 'qoder', 'h1', 1000, 1000, 'u-creator');
