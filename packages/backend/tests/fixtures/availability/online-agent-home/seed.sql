INSERT INTO users (id, name, display_name, created_at, updated_at)
VALUES ('u-creator', 'creator', 'Creator', 1000, 1000);
INSERT INTO users (id, name, display_name, created_at, updated_at)
VALUES ('u-home', 'home', 'Agent-Home Member', 1000, 1000);

INSERT INTO hosts (id, name, kind, created_at)
VALUES ('h1', 'host-one', 'desktop', 1000);

INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id)
VALUES ('a1', 'agent-one', 'qoder', 'h1', 1000, 1000, 'u-creator');

-- The agent's OWN agent-home workspace (owner_agent_id = agent, so name_key must be
-- NULL). Its human member is admitted only through the agent-home branch of the
-- adapter's workspace union (`owner_agent_id = agent`), a distinct SQL path from the
-- regular-membership branch.
INSERT INTO workspaces (id, name, name_key, description, owner_agent_id, archived_at, created_at, updated_at)
VALUES ('wh1', 'Home One', NULL, NULL, 'a1', NULL, 1000, 1000);
INSERT INTO workspace_users (workspace_id, user_id, joined_at)
VALUES ('wh1', 'u-home', 1000);
