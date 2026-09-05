-- Shared cross-language fixture for GET /api/workspaces/name-availability (#task:2193).
-- Executed VERBATIM against a fresh current-schema database by both the TypeScript
-- oracle (tests/workspace-name-availability-parity.test.ts) and the Rust parity test
-- (backend-server/tests/workspace_name_availability_parity.rs). Both then replay
-- cases.json and assert the real {available, reason} projection matches.
-- foreign_keys are ON, so principals precede the rows that reference them.

INSERT INTO users (id, name, display_name, created_at, updated_at)
  VALUES ('user-1', 'viewer', 'Viewer', 1, 1);
INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-1', 'Host', 'local', 1);
INSERT INTO agents (id, name, display_name, runtime, host_id, created_by_user_id, created_at, updated_at)
  VALUES ('agent-1', 'alice', 'Alice', 'claude', 'host-1', 'user-1', 1, 1);

-- A regular workspace holds the folded key 'design team'.
INSERT INTO workspaces (id, name, name_key, description, owner_agent_id, owner_user_id, archived_at, created_at, updated_at)
  VALUES ('ws-regular', 'Design Team', 'design team', NULL, NULL, 'user-1', NULL, 1, 300);
-- An agent-home workspace named "Agent Home" stores a NULL name_key, so it never
-- occupies the regular namespace: "Agent Home" is available for a regular workspace.
INSERT INTO workspaces (id, name, name_key, description, owner_agent_id, owner_user_id, archived_at, created_at, updated_at)
  VALUES ('ws-home', 'Agent Home', NULL, NULL, 'agent-1', NULL, NULL, 1, 200);
