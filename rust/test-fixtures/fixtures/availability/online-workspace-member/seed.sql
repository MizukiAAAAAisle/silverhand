INSERT INTO users (id, name, display_name, created_at, updated_at)
VALUES ('u-creator', 'creator', 'Creator', 1000, 1000);
INSERT INTO users (id, name, display_name, created_at, updated_at)
VALUES ('u-member', 'member', 'Workspace Member', 1000, 1000);

INSERT INTO hosts (id, name, kind, created_at)
VALUES ('h1', 'host-one', 'desktop', 1000);

INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id)
VALUES ('a1', 'agent-one', 'qoder', 'h1', 1000, 1000, 'u-creator');

-- A REGULAR workspace (owner_agent_id NULL, so name_key must be present) the agent
-- is a member of, whose human member is the non-creator viewer. This exercises the
-- regular-membership branch of the adapter's workspace union.
INSERT INTO workspaces (id, name, name_key, description, owner_agent_id, archived_at, created_at, updated_at)
VALUES ('w1', 'Workspace One', 'workspace-one', NULL, NULL, NULL, 1000, 1000);
INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
VALUES ('w1', 'a1', 1000);
INSERT INTO workspace_users (workspace_id, user_id, joined_at)
VALUES ('w1', 'u-member', 1000);
