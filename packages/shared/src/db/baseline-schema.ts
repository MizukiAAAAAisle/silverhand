// AUTO-GENERATED — DO NOT HAND-EDIT (#task:1213 baseline compaction).
// Source of truth: a one-shot replay of historical migrations v1..v44
// (deleted from the live plan; preserved in this commit's git history).
// Regeneration is impossible post-compaction (the chain is gone); the
// two-stage drift guard in migration-baseline.test.ts pins this artifact.
// See docs/db-migration-baseline-compaction-v1.md §5.2.

export const BASELINE_SCHEMA_VERSION = 44;

export const BASELINE_SCHEMA_SQL = `
CREATE TABLE hosts (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        kind        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      , user_id TEXT REFERENCES users(id) ON DELETE CASCADE, installation_id TEXT, last_seen_at INTEGER, revoked_at INTEGER, display_label TEXT);

CREATE TABLE app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

CREATE TABLE workspace_members (
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        joined_at     INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );

CREATE INDEX idx_workspace_members_agent ON workspace_members(agent_id);

CREATE TABLE conversations (
        id                      TEXT PRIMARY KEY,
        workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        workspace_path          TEXT NOT NULL,
        kind                    TEXT NOT NULL CHECK (kind IN ('channel', 'dm_channel', 'thread')),
        parent_conversation_id  TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        title                   TEXT NOT NULL,
        status                  TEXT NOT NULL,
        spawned_by_agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
        closed_at               INTEGER,
        close_summary           TEXT,
        pinned_at               INTEGER,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL, archived_at INTEGER, latest_message_seq INTEGER NOT NULL DEFAULT 0,
        CHECK (
          (kind = 'channel' AND parent_conversation_id IS NULL)
          OR
          (kind = 'dm_channel' AND parent_conversation_id IS NULL)
          OR
          (kind = 'thread' AND parent_conversation_id IS NOT NULL)
        )
      );

CREATE INDEX idx_conversations_workspace
        ON conversations(workspace_id, kind, updated_at DESC);

CREATE INDEX idx_conversations_parent
        ON conversations(parent_conversation_id, created_at ASC);

CREATE INDEX idx_conversations_status
        ON conversations(status);

CREATE TRIGGER conversations_thread_parent_insert
      BEFORE INSERT ON conversations
      WHEN NEW.kind = 'thread'
      BEGIN
        SELECT CASE
          WHEN COALESCE((SELECT kind FROM conversations WHERE id = NEW.parent_conversation_id), '') NOT IN ('channel', 'dm_channel')
          THEN RAISE(ABORT, 'thread parent must be a channel-like conversation')
        END;
        SELECT CASE
          WHEN COALESCE((SELECT workspace_id FROM conversations WHERE id = NEW.parent_conversation_id), '') != NEW.workspace_id
          THEN RAISE(ABORT, 'thread workspace must match parent channel')
        END;
      END;

CREATE TRIGGER conversations_thread_parent_update
      BEFORE UPDATE OF kind, parent_conversation_id, workspace_id ON conversations
      WHEN NEW.kind = 'thread'
      BEGIN
        SELECT CASE
          WHEN COALESCE((SELECT kind FROM conversations WHERE id = NEW.parent_conversation_id), '') NOT IN ('channel', 'dm_channel')
          THEN RAISE(ABORT, 'thread parent must be a channel-like conversation')
        END;
        SELECT CASE
          WHEN COALESCE((SELECT workspace_id FROM conversations WHERE id = NEW.parent_conversation_id), '') != NEW.workspace_id
          THEN RAISE(ABORT, 'thread workspace must match parent channel')
        END;
      END;

CREATE TABLE conversation_agents (
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        cli_session_id   TEXT,
        pid              INTEGER,
        status           TEXT NOT NULL,
        joined_at        INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, agent_id)
      );

CREATE INDEX idx_conversation_agents_agent
        ON conversation_agents(agent_id);

CREATE TABLE conversation_events (
        id               INTEGER PRIMARY KEY,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        agent_id         TEXT REFERENCES agents(id) ON DELETE SET NULL,
        kind             TEXT NOT NULL,
        payload          TEXT,
        created_at       INTEGER NOT NULL
      );

CREATE INDEX idx_conversation_events
        ON conversation_events(conversation_id, id);

CREATE TABLE conversation_inboxes (
        id               INTEGER PRIMARY KEY,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        delivered_at     INTEGER,
        created_at       INTEGER NOT NULL
      , in_flight_owner TEXT, in_flight_at INTEGER, failed_at INTEGER, failed_reason TEXT, delivery_kind TEXT);

CREATE INDEX idx_conversation_inbox_pending
        ON conversation_inboxes(conversation_id, agent_id, delivered_at);

CREATE TABLE saved_messages (
        id               TEXT PRIMARY KEY,
        message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        saved_at         INTEGER NOT NULL
      , user_id TEXT REFERENCES users(id) ON DELETE CASCADE);

CREATE INDEX idx_saved_messages_workspace
        ON saved_messages(workspace_id, saved_at DESC);

CREATE TABLE attachments (
        id                     TEXT PRIMARY KEY,
        channel_id             TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        filename               TEXT NOT NULL,
        size                   INTEGER NOT NULL,
        content_type           TEXT NOT NULL,
        storage                TEXT NOT NULL,
        storage_key            TEXT NOT NULL,
        created_by_kind        TEXT NOT NULL,
        created_by_id          TEXT NOT NULL,
        created_at             INTEGER NOT NULL
      );

CREATE INDEX idx_attachments_channel
        ON attachments(channel_id, created_at DESC);

CREATE INDEX idx_attachments_source_conversation
        ON attachments(source_conversation_id, created_at DESC);

CREATE TABLE workspaces (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        description        TEXT,
        workspace_kind     TEXT NOT NULL
          CHECK (workspace_kind IN ('regular', 'agent_home')),
        workspace_path     TEXT NOT NULL,
        workspace_host_id  TEXT NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
        owner_agent_id     TEXT UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
        archived_at        INTEGER,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL, pinned_at INTEGER, owner_user_id TEXT REFERENCES users(id),
        CHECK (
          (workspace_kind = 'agent_home' AND owner_agent_id IS NOT NULL)
          OR
          (workspace_kind = 'regular' AND owner_agent_id IS NULL)
        )
      );

CREATE UNIQUE INDEX workspaces_regular_name_unique
        ON workspaces(name) WHERE workspace_kind = 'regular';

CREATE TRIGGER workspace_members_no_agent_home_insert
      BEFORE INSERT ON workspace_members
      WHEN (SELECT workspace_kind FROM workspaces WHERE id = NEW.workspace_id) = 'agent_home'
      BEGIN
        SELECT RAISE(ABORT, 'workspace_members rows must reference regular workspaces only');
      END;

CREATE TRIGGER workspace_members_no_agent_home_update
      BEFORE UPDATE OF workspace_id ON workspace_members
      WHEN (SELECT workspace_kind FROM workspaces WHERE id = NEW.workspace_id) = 'agent_home'
      BEGIN
        SELECT RAISE(ABORT, 'workspace_members rows must reference regular workspaces only');
      END;

CREATE INDEX idx_conversations_archived_at
        ON conversations(workspace_id)
        WHERE archived_at IS NOT NULL;

CREATE TABLE schedules (
        id              TEXT NOT NULL PRIMARY KEY,
        owner_agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        message         TEXT NOT NULL,
        spec_json       TEXT NOT NULL,
        next_fire_at    INTEGER NOT NULL,
        status          TEXT NOT NULL
                        CHECK (status IN ('pending','firing','done','cancelled','failed')),
        fired_count     INTEGER NOT NULL DEFAULT 0,
        last_fired_at   INTEGER,
        max_occurrences INTEGER,
        until_at        INTEGER,
        failure_reason  TEXT,
        cancelled_at    INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      , title TEXT NOT NULL DEFAULT '', target_conversation_id TEXT NOT NULL DEFAULT '', last_failure_reason TEXT, last_failure_at INTEGER, consecutive_failure_count INTEGER NOT NULL DEFAULT 0);

CREATE INDEX idx_schedules_due
        ON schedules(status, next_fire_at);

CREATE INDEX idx_schedules_owner
        ON schedules(owner_agent_id, status);

CREATE INDEX idx_workspaces_pinned_at
        ON workspaces(workspace_kind, pinned_at)
        WHERE pinned_at IS NOT NULL;

CREATE UNIQUE INDEX uniq_conversation_inbox_delivery
        ON conversation_inboxes(conversation_id, agent_id, message_id);

CREATE TABLE users (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL UNIQUE,
        display_name        TEXT NOT NULL,
        avatar_storage_key  TEXT,
        avatar_content_type TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL, email TEXT,
        CHECK (
          (avatar_storage_key IS NULL AND avatar_content_type IS NULL)
          OR
          (avatar_storage_key IS NOT NULL AND avatar_content_type IS NOT NULL)
        )
      );

CREATE TABLE messages (
        id                      TEXT PRIMARY KEY,
        conversation_id         TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        from_kind               TEXT NOT NULL,
        from_agent_id           TEXT REFERENCES agents(id) ON DELETE SET NULL,
        from_user_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
        content                 TEXT NOT NULL,
        metadata                TEXT,
        seq                     INTEGER NOT NULL,
        created_at              INTEGER NOT NULL,
        task_number             INTEGER,
        task_status             TEXT,
        task_assignee_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
        task_assignee_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
        task_title              TEXT,
        task_workspace_id       TEXT REFERENCES workspaces(id) ON DELETE CASCADE
      , task_closed_at INTEGER, thread_root_id TEXT REFERENCES messages(id) ON DELETE CASCADE);

CREATE INDEX idx_messages_conversation
        ON messages(conversation_id, seq);

CREATE UNIQUE INDEX uniq_messages_task_workspace_number
        ON messages(task_workspace_id, task_number)
        WHERE task_number IS NOT NULL;

CREATE INDEX idx_messages_task_workspace
        ON messages(task_workspace_id, task_status)
        WHERE task_workspace_id IS NOT NULL;

CREATE INDEX idx_messages_conversation_from_kind
        ON messages(conversation_id, from_kind, seq);

CREATE TABLE conversation_reads (
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        last_read_seq    INTEGER NOT NULL DEFAULT 0,
        read_at          INTEGER NOT NULL,
        PRIMARY KEY (user_id, conversation_id)
      );

CREATE INDEX idx_conversation_reads_conversation
        ON conversation_reads(conversation_id);

CREATE TABLE notifications (
        id                      TEXT PRIMARY KEY,
        kind                    TEXT NOT NULL,
        user_id                 TEXT REFERENCES users(id) ON DELETE SET NULL,
        agent_id                TEXT REFERENCES agents(id) ON DELETE SET NULL,
        workspace_id            TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        conversation_id         TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        message_id              TEXT REFERENCES messages(id) ON DELETE SET NULL,
        source_workspace_id     TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        source_conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        source_message_id       TEXT REFERENCES messages(id) ON DELETE SET NULL,
        payload                 TEXT,
        read_at                 INTEGER,
        created_at              INTEGER NOT NULL
      );

CREATE INDEX idx_notifications_unread
        ON notifications(user_id, read_at, created_at DESC);

CREATE INDEX idx_notifications_conversation_unread
        ON notifications(conversation_id, read_at, created_at DESC);

CREATE INDEX idx_notifications_source_conversation
        ON notifications(source_conversation_id, created_at DESC);

CREATE TABLE workspace_users (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at    INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'admin', 'member')),
        PRIMARY KEY (workspace_id, user_id)
      );

CREATE INDEX idx_workspace_users_user
        ON workspace_users(user_id, joined_at);

CREATE TABLE conversation_users (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at       INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
      );

CREATE INDEX idx_conversation_users_user
        ON conversation_users(user_id, joined_at);

CREATE TABLE agents (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL UNIQUE,
        runtime             TEXT NOT NULL,
        model               TEXT,
        host_id             TEXT NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
        description         TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        display_name        TEXT NOT NULL DEFAULT '',
        reasoning_effort    TEXT,
        fast_mode           INTEGER,
        created_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        avatar_storage_key  TEXT,
        avatar_content_type TEXT, materialization_status TEXT NOT NULL
        DEFAULT 'active'
        CHECK (materialization_status IN (
          'pending_materialization', 'active', 'failed'
        )), materialization_failed_code TEXT, materialization_failed_at INTEGER, idempotency_key TEXT,
        CHECK (
          (avatar_storage_key IS NULL AND avatar_content_type IS NULL)
          OR
          (avatar_storage_key IS NOT NULL AND avatar_content_type IS NOT NULL)
        )
      );

CREATE TRIGGER attachments_created_by_validate_insert
      BEFORE INSERT ON attachments
      BEGIN
        SELECT CASE
          WHEN NEW.created_by_kind = 'user'
               AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by_id)
          THEN RAISE(ABORT, 'attachments.created_by_id (kind=user) must reference users(id)')
          WHEN NEW.created_by_kind = 'agent'
               AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.created_by_id)
          THEN RAISE(ABORT, 'attachments.created_by_id (kind=agent) must reference agents(id)')
        END;
      END;

CREATE TRIGGER attachments_created_by_validate_update
      BEFORE UPDATE OF created_by_kind, created_by_id ON attachments
      BEGIN
        SELECT CASE
          WHEN NEW.created_by_kind = 'user'
               AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by_id)
          THEN RAISE(ABORT, 'attachments.created_by_id (kind=user) must reference users(id)')
          WHEN NEW.created_by_kind = 'agent'
               AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.created_by_id)
          THEN RAISE(ABORT, 'attachments.created_by_id (kind=agent) must reference agents(id)')
        END;
      END;

CREATE TRIGGER users_name_unique_against_agents_insert
      BEFORE INSERT ON users
      WHEN EXISTS (SELECT 1 FROM agents WHERE name = NEW.name)
      BEGIN
        SELECT RAISE(ABORT, 'users.name collides with an existing agent name');
      END;

CREATE TRIGGER users_name_unique_against_agents_update
      BEFORE UPDATE OF name ON users
      WHEN NEW.name != OLD.name
        AND EXISTS (SELECT 1 FROM agents WHERE name = NEW.name)
      BEGIN
        SELECT RAISE(ABORT, 'users.name collides with an existing agent name');
      END;

CREATE TRIGGER agents_name_unique_against_users_insert
      BEFORE INSERT ON agents
      WHEN EXISTS (SELECT 1 FROM users WHERE name = NEW.name)
      BEGIN
        SELECT RAISE(ABORT, 'agents.name collides with an existing user name');
      END;

CREATE TRIGGER agents_name_unique_against_users_update
      BEFORE UPDATE OF name ON agents
      WHEN NEW.name != OLD.name
        AND EXISTS (SELECT 1 FROM users WHERE name = NEW.name)
      BEGIN
        SELECT RAISE(ABORT, 'agents.name collides with an existing user name');
      END;

CREATE INDEX idx_schedules_target
        ON schedules(target_conversation_id);

CREATE UNIQUE INDEX uniq_users_email_when_set
        ON users(email COLLATE NOCASE)
        WHERE email IS NOT NULL;

CREATE TABLE user_password_credentials (
        user_id               TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        password_hash         TEXT NOT NULL,
        password_hash_params  TEXT NOT NULL CHECK (json_valid(password_hash_params)),
        password_updated_at   INTEGER NOT NULL
      );

CREATE TABLE auth_sessions (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash     TEXT NOT NULL UNIQUE,
        created_at     INTEGER NOT NULL,
        last_used_at   INTEGER NOT NULL,
        revoked_at     INTEGER,
        user_agent     TEXT,
        ip_first_seen  TEXT
      );

CREATE INDEX idx_auth_sessions_user
        ON auth_sessions(user_id, revoked_at, last_used_at DESC);

CREATE INDEX idx_hosts_user
        ON hosts(user_id, revoked_at, created_at);

CREATE TABLE host_credentials (
        id           TEXT PRIMARY KEY,
        host_id      TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        token_hash   TEXT NOT NULL UNIQUE,
        kind         TEXT NOT NULL CHECK (kind IN ('long_lived', 'bootstrap')),
        expires_at   INTEGER,
        consumed_at  INTEGER,
        revoked_at   INTEGER
      );

CREATE INDEX idx_host_credentials_host
        ON host_credentials(host_id, kind, revoked_at, expires_at);

CREATE UNIQUE INDEX uniq_hosts_user_installation_when_active
        ON hosts(user_id, installation_id)
        WHERE user_id IS NOT NULL
          AND installation_id IS NOT NULL
          AND revoked_at IS NULL;

CREATE INDEX idx_conversation_inbox_replay_pending
        ON conversation_inboxes(conversation_id, agent_id, delivered_at, failed_at, in_flight_owner, id);

CREATE INDEX idx_conversation_inbox_in_flight_owner
        ON conversation_inboxes(in_flight_owner, delivered_at, failed_at);

CREATE UNIQUE INDEX idx_agents_idempotency_key_per_user
        ON agents (created_by_user_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_messages_task_workspace_closed_at
        ON messages(task_workspace_id, task_closed_at)
        WHERE task_workspace_id IS NOT NULL
          AND task_status = 'closed'
          AND task_closed_at IS NOT NULL;

CREATE UNIQUE INDEX uniq_saved_messages_user_message
        ON saved_messages(user_id, message_id)
        WHERE user_id IS NOT NULL;

CREATE INDEX idx_saved_messages_user_saved_at
        ON saved_messages(user_id, saved_at DESC)
        WHERE user_id IS NOT NULL;

CREATE TABLE workspace_agent_capabilities (
        workspace_id TEXT NOT NULL,
        agent_id     TEXT NOT NULL,
        capability   TEXT NOT NULL CHECK (capability IN (
          'read_messages',
          'send_messages',
          'read_tasks',
          'create_tasks',
          'write_tasks',
          'read_attachments',
          'upload_attachments',
          'create_threads',
          'create_channels',
          'manage_conversation_members',
          'manage_schedules'
        )),
        PRIMARY KEY (workspace_id, agent_id, capability),
        FOREIGN KEY (workspace_id, agent_id)
          REFERENCES workspace_members (workspace_id, agent_id) ON DELETE CASCADE
      );

CREATE UNIQUE INDEX uniq_messages_conversation_seq
        ON messages(conversation_id, seq);

CREATE INDEX idx_messages_thread_root
        ON messages(conversation_id, thread_root_id, seq);

CREATE TRIGGER messages_thread_root_insert
      BEFORE INSERT ON messages
      WHEN NEW.thread_root_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.thread_root_id)
          THEN RAISE(ABORT, 'thread_root_id must reference an existing message')
        END;
        SELECT CASE
          WHEN COALESCE((SELECT conversation_id FROM messages WHERE id = NEW.thread_root_id), '') != NEW.conversation_id
          THEN RAISE(ABORT, 'thread root must be in the same conversation')
        END;
        SELECT CASE
          WHEN (SELECT thread_root_id FROM messages WHERE id = NEW.thread_root_id) IS NOT NULL
          THEN RAISE(ABORT, 'thread root must not itself be a reply (no nested threads)')
        END;
      END;

CREATE TRIGGER messages_thread_root_update
      BEFORE UPDATE OF thread_root_id ON messages
      WHEN NEW.thread_root_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.thread_root_id)
          THEN RAISE(ABORT, 'thread_root_id must reference an existing message')
        END;
        SELECT CASE
          WHEN COALESCE((SELECT conversation_id FROM messages WHERE id = NEW.thread_root_id), '') != NEW.conversation_id
          THEN RAISE(ABORT, 'thread root must be in the same conversation')
        END;
        SELECT CASE
          WHEN (SELECT thread_root_id FROM messages WHERE id = NEW.thread_root_id) IS NOT NULL
          THEN RAISE(ABORT, 'thread root must not itself be a reply (no nested threads)')
        END;
        -- Turning a message that already HAS replies into a reply would
        -- orphan its children into a nested thread. The app never updates
        -- thread_root_id, but the schema must still forbid the transition.
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM messages WHERE thread_root_id = OLD.id)
          THEN RAISE(ABORT, 'cannot turn a thread root with existing replies into a reply')
        END;
      END;

CREATE TABLE thread_followers (
        thread_root_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        principal_kind   TEXT NOT NULL CHECK (principal_kind IN ('human', 'agent')),
        principal_id     TEXT NOT NULL,
        followed_at      INTEGER NOT NULL,
        source           TEXT NOT NULL CHECK (source IN ('reply', 'mention', 'manual', 'target_author')),
        PRIMARY KEY (thread_root_id, principal_kind, principal_id)
      );

CREATE INDEX idx_thread_followers_principal
        ON thread_followers(principal_kind, principal_id);

CREATE TRIGGER thread_followers_root_insert
      BEFORE INSERT ON thread_followers
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.thread_root_id)
          THEN RAISE(ABORT, 'thread_followers.thread_root_id must reference an existing message')
        END;
        SELECT CASE
          WHEN COALESCE((SELECT conversation_id FROM messages WHERE id = NEW.thread_root_id), '') != NEW.conversation_id
          THEN RAISE(ABORT, 'thread follower root must be in the same conversation')
        END;
        SELECT CASE
          WHEN (SELECT thread_root_id FROM messages WHERE id = NEW.thread_root_id) IS NOT NULL
          THEN RAISE(ABORT, 'thread follower root must not itself be a reply')
        END;
      END;

CREATE TRIGGER thread_followers_root_update
      BEFORE UPDATE OF thread_root_id, conversation_id ON thread_followers
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.thread_root_id)
          THEN RAISE(ABORT, 'thread_followers.thread_root_id must reference an existing message')
        END;
        SELECT CASE
          WHEN COALESCE((SELECT conversation_id FROM messages WHERE id = NEW.thread_root_id), '') != NEW.conversation_id
          THEN RAISE(ABORT, 'thread follower root must be in the same conversation')
        END;
        SELECT CASE
          WHEN (SELECT thread_root_id FROM messages WHERE id = NEW.thread_root_id) IS NOT NULL
          THEN RAISE(ABORT, 'thread follower root must not itself be a reply')
        END;
      END;

CREATE TABLE conversation_stream_heads (
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        thread_root_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,
        latest_seq       INTEGER NOT NULL
      );

CREATE UNIQUE INDEX uniq_stream_head_main
        ON conversation_stream_heads(conversation_id) WHERE thread_root_id IS NULL;

CREATE UNIQUE INDEX uniq_stream_head_thread
        ON conversation_stream_heads(conversation_id, thread_root_id) WHERE thread_root_id IS NOT NULL;

CREATE TRIGGER conversation_stream_heads_root_insert
      BEFORE INSERT ON conversation_stream_heads
      WHEN NEW.thread_root_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.thread_root_id)
          THEN RAISE(ABORT, 'conversation_stream_heads.thread_root_id must reference an existing message')
        END;
        SELECT CASE
          WHEN COALESCE((SELECT conversation_id FROM messages WHERE id = NEW.thread_root_id), '') != NEW.conversation_id
          THEN RAISE(ABORT, 'stream head root must be in the same conversation')
        END;
        SELECT CASE
          WHEN (SELECT thread_root_id FROM messages WHERE id = NEW.thread_root_id) IS NOT NULL
          THEN RAISE(ABORT, 'stream head root must not itself be a reply')
        END;
      END;

CREATE TRIGGER conversation_stream_heads_root_update
      BEFORE UPDATE OF thread_root_id, conversation_id ON conversation_stream_heads
      WHEN NEW.thread_root_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.thread_root_id)
          THEN RAISE(ABORT, 'conversation_stream_heads.thread_root_id must reference an existing message')
        END;
        SELECT CASE
          WHEN COALESCE((SELECT conversation_id FROM messages WHERE id = NEW.thread_root_id), '') != NEW.conversation_id
          THEN RAISE(ABORT, 'stream head root must be in the same conversation')
        END;
        SELECT CASE
          WHEN (SELECT thread_root_id FROM messages WHERE id = NEW.thread_root_id) IS NOT NULL
          THEN RAISE(ABORT, 'stream head root must not itself be a reply')
        END;
      END;
`;
