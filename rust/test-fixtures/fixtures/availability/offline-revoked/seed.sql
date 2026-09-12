INSERT INTO users (id, name, display_name, created_at, updated_at)
VALUES ('u-creator', 'creator', 'Creator', 1000, 1000);

-- The host's authority is revoked. Revocation beats a lingering attachment: the
-- input still marks h1 attached, yet the answer is offline.
INSERT INTO hosts (id, name, kind, created_at, revoked_at)
VALUES ('h1', 'host-one', 'desktop', 1000, 2000);

INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id)
VALUES ('a1', 'agent-one', 'qoder', 'h1', 1000, 1000, 'u-creator');
