export interface Migration {
  version: number;
  name: string;
  up: string;
  foreignKeyEscape?: true;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      PRAGMA journal_mode = WAL;

      CREATE TABLE hosts (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        kind        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE agents (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        runtime         TEXT NOT NULL,
        model           TEXT,
        host_id         TEXT NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
        description     TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE channels (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL UNIQUE,
        description        TEXT,
        kind               TEXT NOT NULL DEFAULT 'regular',
        workspace_path     TEXT NOT NULL,
        workspace_host_id  TEXT NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
        dm_agent_id        TEXT REFERENCES agents(id) ON DELETE CASCADE,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );

      CREATE TABLE channel_members (
        channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        joined_at   INTEGER NOT NULL,
        PRIMARY KEY (channel_id, agent_id)
      );

      CREATE INDEX idx_channel_members_agent ON channel_members(agent_id);

      CREATE TABLE sessions (
        id                    TEXT PRIMARY KEY,
        channel_id            TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        title                 TEXT NOT NULL,
        status                TEXT NOT NULL,
        parent_session_id     TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        spawned_by_agent_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
        closed_at             INTEGER,
        close_summary         TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );

      CREATE INDEX idx_sessions_channel ON sessions(channel_id, updated_at DESC);
      CREATE INDEX idx_sessions_parent  ON sessions(parent_session_id);
      CREATE INDEX idx_sessions_status  ON sessions(status);

      CREATE TABLE session_agents (
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        cli_session_id  TEXT,
        pid             INTEGER,
        status          TEXT NOT NULL,
        joined_at       INTEGER NOT NULL,
        PRIMARY KEY (session_id, agent_id)
      );

      CREATE INDEX idx_session_agents_agent ON session_agents(agent_id);

      CREATE TABLE messages (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        from_kind       TEXT NOT NULL,
        from_agent_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
        from_user_id    TEXT,
        content         TEXT NOT NULL,
        metadata        TEXT,
        seq             INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX idx_messages_session ON messages(session_id, seq);

      CREATE TABLE agent_inboxes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        delivered_at  INTEGER,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX idx_inbox_pending ON agent_inboxes(session_id, agent_id, delivered_at);

      CREATE TABLE session_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
        kind        TEXT NOT NULL,
        payload     TEXT,
        created_at  INTEGER NOT NULL
      );

      CREATE INDEX idx_events_session ON session_events(session_id, id);
    `,
  },
  {
    version: 2,
    name: 'saved_messages',
    up: `
      CREATE TABLE saved_messages (
        id          TEXT PRIMARY KEY,
        message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        saved_at    INTEGER NOT NULL,
        UNIQUE(message_id)
      );

      CREATE INDEX idx_saved_messages_saved_at ON saved_messages(saved_at DESC);
      CREATE INDEX idx_saved_messages_channel  ON saved_messages(channel_id, saved_at DESC);
    `,
  },
  {
    version: 3,
    name: 'rename_reply_quote_to_thread_anchor',
    up: `
      UPDATE messages
      SET metadata = json_set(metadata, '$.subtype', 'thread_anchor')
      WHERE from_kind = 'system'
        AND json_extract(metadata, '$.subtype') = 'reply_quote';
    `,
  },
  {
    version: 4,
    name: 'app_settings',
    up: `
      CREATE TABLE app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: 'agent_display_name_and_reasoning_effort',
    // display_name = human label; `name` stays as the immutable handle
    // used in @mentions, dm-<name> channel naming, and L2 file
    // references. reasoning_effort applies to codex driver only; NULL
    // means "use codex config.toml default".
    up: `
      ALTER TABLE agents ADD COLUMN display_name      TEXT NOT NULL DEFAULT '';
      ALTER TABLE agents ADD COLUMN reasoning_effort  TEXT;
      UPDATE agents SET display_name = name WHERE display_name = '';
    `,
  },
  {
    version: 6,
    name: 'notifications',
    // Narrow notification table — v1 only writes `kind = 'mention_external'`
    // (a user @ed an agent who isn't a member of the originating session;
    // the message was CC'd to that agent's DM channel). Schema is
    // open-ended so future kinds (saved-reply, sub-session-closed,
    // crash, etc.) reuse the same table without another migration.
    //
    // user_id is nullable for v1 — the app is single-user, so writes
    // pass NULL and reads ignore the column. Indexed so the future
    // multi-user migration can backfill 'local' and start filtering
    // without a table scan. The (user_id, read_at) composite is the
    // only hot path: "unread count for this user".
    //
    // ON DELETE: notifications cascade with the channel that scopes
    // them (deleting an agent's DM channel takes its notifications
    // with it). The source pointers (session_id, message_id, source_*)
    // SET NULL so a notification stays in the inbox even if the
    // originating context is gone — clicking it just won't jump.
    up: `
      CREATE TABLE notifications (
        id                  TEXT PRIMARY KEY,
        kind                TEXT NOT NULL,
        user_id             TEXT,
        agent_id            TEXT REFERENCES agents(id) ON DELETE CASCADE,
        channel_id          TEXT REFERENCES channels(id) ON DELETE CASCADE,
        session_id          TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        message_id          TEXT REFERENCES messages(id) ON DELETE SET NULL,
        source_channel_id   TEXT REFERENCES channels(id) ON DELETE SET NULL,
        source_session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        source_message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
        payload             TEXT,
        read_at             INTEGER,
        created_at          INTEGER NOT NULL
      );

      CREATE INDEX idx_notifications_user_unread
        ON notifications(user_id, read_at, created_at DESC);
      CREATE INDEX idx_notifications_channel
        ON notifications(channel_id, read_at, created_at DESC);
      CREATE INDEX idx_notifications_created
        ON notifications(created_at DESC);
    `,
  },
  {
    version: 7,
    name: 'tasks',
    // Tasks are message metadata, not a separate table — see
    // docs/tasks-design.md §3. A message "is a task" iff
    // task_number IS NOT NULL. Per-channel numbering space; per-session
    // operational scope (the session that owns the message owns the
    // task). `task_channel_id` is a denormalized pointer to
    // sessions.channel_id so the partial unique index below can be a
    // plain (col, col) index — SQLite doesn't do JOIN-based indexes.
    // Backend is the single writer and fills it in the same transaction
    // as any task mutation.
    up: `
      ALTER TABLE messages ADD COLUMN task_number             INTEGER;
      ALTER TABLE messages ADD COLUMN task_status             TEXT;
      ALTER TABLE messages ADD COLUMN task_assignee_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL;
      ALTER TABLE messages ADD COLUMN task_assignee_user_id   TEXT;
      ALTER TABLE messages ADD COLUMN task_title              TEXT;
      ALTER TABLE messages ADD COLUMN task_channel_id         TEXT REFERENCES channels(id) ON DELETE CASCADE;

      CREATE UNIQUE INDEX uniq_messages_task_number
        ON messages(task_channel_id, task_number)
        WHERE task_number IS NOT NULL;

      CREATE INDEX idx_messages_task_channel
        ON messages(task_channel_id, task_status)
        WHERE task_channel_id IS NOT NULL;
    `,
  },
  {
    version: 8,
    name: 'channel_archive',
    // Soft-archive a channel: it stays in the DB (sessions, members,
    // messages all reachable for read), but the renderer hides it
    // behind an "Archived" group and the composer/auto-spawn paths
    // refuse new activity. Reversible — `archived_at = NULL` puts it
    // back in active rotation. Partial index keeps the active-channel
    // listing path cheap (the common query).
    up: `
      ALTER TABLE channels ADD COLUMN archived_at INTEGER;
      CREATE INDEX idx_channels_active
        ON channels(updated_at DESC)
        WHERE archived_at IS NULL;
    `,
  },
  {
    version: 9,
    name: 'session_pin',
    // Per-session pin: pinned sessions float to the top of the sidebar.
    // NULL means unpinned; non-NULL is the timestamp the pin was set
    // (used for stable ordering when multiple sessions are pinned).
    up: `
      ALTER TABLE sessions ADD COLUMN pinned_at INTEGER;
    `,
  },
  {
    version: 10,
    name: 'session_reads',
    // Per-viewer message read cursors. This is intentionally separate
    // from notifications: notifications are reminder rows; session_reads
    // is the IM-style unread model for every session/DM.
    up: `
      CREATE TABLE session_reads (
        user_id        TEXT NOT NULL,
        session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        last_read_seq  INTEGER NOT NULL DEFAULT 0,
        read_at        INTEGER NOT NULL,
        PRIMARY KEY (user_id, session_id)
      );

      CREATE INDEX idx_session_reads_session
        ON session_reads(session_id);

      -- Existing v1 history predates the unread cursor feature. Treat those
      -- rows as already read for the single local viewer so upgrade does not
      -- light up every old channel. Runtime code remains parameterized by
      -- viewerUserId and does not depend on this literal.
      INSERT INTO session_reads (user_id, session_id, last_read_seq, read_at)
      SELECT 'local',
             s.id,
             COALESCE(MAX(m.seq), 0),
             CAST(strftime('%s', 'now') AS INTEGER) * 1000
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
       GROUP BY s.id;
    `,
  },
  {
    version: 11,
    name: 'workspace_conversation_shadow_schema',
    // Add the new workspace/conversation model alongside the legacy
    // channels/sessions schema. This is intentionally a shadow schema:
    // old tables remain in place until the frontend/backend rename can
    // switch atomically. The triggers keep new writes through legacy
    // routes mirrored well enough for transition testing, but live app
    // cutover still requires the documented stop + backup + restart flow.
    up: `
      CREATE TABLE workspaces (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL UNIQUE,
        description        TEXT,
        workspace_kind     TEXT NOT NULL DEFAULT 'regular'
          CHECK (workspace_kind IN ('regular', 'system_dm')),
        workspace_path     TEXT NOT NULL,
        workspace_host_id  TEXT NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
        archived_at        INTEGER,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
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
        updated_at              INTEGER NOT NULL,
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

      CREATE TABLE conversation_reads (
        user_id          TEXT NOT NULL,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        last_read_seq    INTEGER NOT NULL DEFAULT 0,
        read_at          INTEGER NOT NULL,
        PRIMARY KEY (user_id, conversation_id)
      );

      CREATE INDEX idx_conversation_reads_conversation
        ON conversation_reads(conversation_id);

      CREATE TABLE conversation_inboxes (
        id               INTEGER PRIMARY KEY,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        delivered_at     INTEGER,
        created_at       INTEGER NOT NULL
      );

      CREATE INDEX idx_conversation_inbox_pending
        ON conversation_inboxes(conversation_id, agent_id, delivered_at);

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

      INSERT INTO workspaces
        (id, name, description, workspace_kind, workspace_path, workspace_host_id,
         archived_at, created_at, updated_at)
      SELECT id, name, description, 'regular', workspace_path, workspace_host_id,
             archived_at, created_at, updated_at
        FROM channels
       WHERE kind != 'dm';

      INSERT OR IGNORE INTO workspaces
        (id, name, description, workspace_kind, workspace_path, workspace_host_id,
         archived_at, created_at, updated_at)
      SELECT '__system_dm_workspace__',
             'Direct Messages',
             'Hidden workspace for direct message conversations',
             'system_dm',
             (SELECT workspace_path FROM channels WHERE kind = 'dm' ORDER BY created_at ASC LIMIT 1),
             (SELECT workspace_host_id FROM channels WHERE kind = 'dm' ORDER BY created_at ASC LIMIT 1),
             NULL,
             COALESCE((SELECT MIN(created_at) FROM channels WHERE kind = 'dm'), CAST(strftime('%s', 'now') AS INTEGER) * 1000),
             COALESCE((SELECT MAX(updated_at) FROM channels WHERE kind = 'dm'), CAST(strftime('%s', 'now') AS INTEGER) * 1000)
       WHERE EXISTS (SELECT 1 FROM channels WHERE kind = 'dm');

      INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
      SELECT cm.channel_id, cm.agent_id, cm.joined_at
        FROM channel_members cm
        JOIN channels c ON c.id = cm.channel_id
       WHERE c.kind != 'dm';

      INSERT INTO conversations
        (id, workspace_id, workspace_path, kind, parent_conversation_id,
         title, status, spawned_by_agent_id, closed_at, close_summary,
         pinned_at, created_at, updated_at)
      SELECT s.id,
             CASE WHEN c.kind = 'dm' THEN '__system_dm_workspace__' ELSE s.channel_id END,
             c.workspace_path,
             CASE WHEN c.kind = 'dm' THEN 'dm_channel' ELSE 'channel' END,
             NULL,
             s.title,
             s.status,
             s.spawned_by_agent_id,
             s.closed_at,
             s.close_summary,
             s.pinned_at,
             s.created_at,
             s.updated_at
        FROM sessions s
        JOIN channels c ON c.id = s.channel_id
       WHERE s.parent_session_id IS NULL;

      INSERT INTO conversations
        (id, workspace_id, workspace_path, kind, parent_conversation_id,
         title, status, spawned_by_agent_id, closed_at, close_summary,
         pinned_at, created_at, updated_at)
      SELECT s.id,
             p.workspace_id,
             p.workspace_path,
             'thread',
             s.parent_session_id,
             s.title,
             s.status,
             s.spawned_by_agent_id,
             s.closed_at,
             s.close_summary,
             s.pinned_at,
             s.created_at,
             s.updated_at
        FROM sessions s
        JOIN conversations p ON p.id = s.parent_session_id
       WHERE s.parent_session_id IS NOT NULL;

      INSERT INTO conversation_agents
        (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
      SELECT session_id, agent_id, cli_session_id, pid, status, joined_at
        FROM session_agents;

      INSERT INTO conversation_reads
        (user_id, conversation_id, last_read_seq, read_at)
      SELECT user_id, session_id, last_read_seq, read_at
        FROM session_reads;

      INSERT INTO conversation_inboxes
        (id, conversation_id, agent_id, message_id, delivered_at, created_at)
      SELECT id, session_id, agent_id, message_id, delivered_at, created_at
        FROM agent_inboxes;

      INSERT INTO conversation_events
        (id, conversation_id, agent_id, kind, payload, created_at)
      SELECT id, session_id, agent_id, kind, payload, created_at
        FROM session_events;

      ALTER TABLE messages ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;
      ALTER TABLE messages ADD COLUMN task_workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

      UPDATE messages
         SET conversation_id = session_id;

      UPDATE messages
         SET task_workspace_id = (
           SELECT workspace_id FROM conversations c WHERE c.id = messages.session_id
         )
       WHERE task_number IS NOT NULL;

      CREATE INDEX idx_messages_conversation
        ON messages(conversation_id, seq);

      CREATE UNIQUE INDEX uniq_messages_task_workspace_number
        ON messages(task_workspace_id, task_number)
        WHERE task_number IS NOT NULL;

      CREATE INDEX idx_messages_task_workspace
        ON messages(task_workspace_id, task_status)
        WHERE task_workspace_id IS NOT NULL;

      ALTER TABLE agent_inboxes ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;
      UPDATE agent_inboxes SET conversation_id = session_id;
      CREATE INDEX idx_inbox_conversation_pending
        ON agent_inboxes(conversation_id, agent_id, delivered_at);

      ALTER TABLE session_events ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;
      UPDATE session_events SET conversation_id = session_id;
      CREATE INDEX idx_events_conversation
        ON session_events(conversation_id, id);

      ALTER TABLE saved_messages ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;
      ALTER TABLE saved_messages ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
      UPDATE saved_messages
         SET conversation_id = session_id,
             workspace_id = (
               SELECT workspace_id FROM conversations c WHERE c.id = saved_messages.session_id
             );
      CREATE INDEX idx_saved_messages_workspace
        ON saved_messages(workspace_id, saved_at DESC);

      CREATE TRIGGER legacy_channels_to_workspaces_insert
      AFTER INSERT ON channels
      BEGIN
        INSERT INTO workspaces
          (id, name, description, workspace_kind, workspace_path, workspace_host_id,
           archived_at, created_at, updated_at)
        SELECT NEW.id, NEW.name, NEW.description, 'regular', NEW.workspace_path,
               NEW.workspace_host_id, NEW.archived_at, NEW.created_at, NEW.updated_at
         WHERE NEW.kind != 'dm';

        INSERT OR IGNORE INTO workspaces
          (id, name, description, workspace_kind, workspace_path, workspace_host_id,
           archived_at, created_at, updated_at)
        SELECT '__system_dm_workspace__',
               'Direct Messages',
               'Hidden workspace for direct message conversations',
               'system_dm',
               NEW.workspace_path,
               NEW.workspace_host_id,
               NULL,
               NEW.created_at,
               NEW.updated_at
         WHERE NEW.kind = 'dm';
      END;

      CREATE TRIGGER legacy_channels_to_workspaces_update
      AFTER UPDATE OF name, description, archived_at, updated_at ON channels
      WHEN NEW.kind != 'dm'
      BEGIN
        UPDATE workspaces
           SET name = NEW.name,
               description = NEW.description,
               archived_at = NEW.archived_at,
               updated_at = NEW.updated_at
         WHERE id = NEW.id;
      END;

      CREATE TRIGGER legacy_channels_to_workspaces_delete
      AFTER DELETE ON channels
      WHEN OLD.kind != 'dm'
      BEGIN
        DELETE FROM workspaces WHERE id = OLD.id;
      END;

      CREATE TRIGGER legacy_channel_members_to_workspace_members_insert
      AFTER INSERT ON channel_members
      WHEN EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND kind != 'dm')
      BEGIN
        INSERT OR IGNORE INTO workspace_members (workspace_id, agent_id, joined_at)
        VALUES (NEW.channel_id, NEW.agent_id, NEW.joined_at);
      END;

      CREATE TRIGGER legacy_channel_members_to_workspace_members_delete
      AFTER DELETE ON channel_members
      BEGIN
        DELETE FROM workspace_members
         WHERE workspace_id = OLD.channel_id AND agent_id = OLD.agent_id;
      END;

      CREATE TRIGGER legacy_sessions_to_conversations_insert
      AFTER INSERT ON sessions
      BEGIN
        INSERT INTO conversations
          (id, workspace_id, workspace_path, kind, parent_conversation_id,
           title, status, spawned_by_agent_id, closed_at, close_summary,
           pinned_at, created_at, updated_at)
        SELECT NEW.id,
               CASE
                 WHEN NEW.parent_session_id IS NOT NULL THEN p.workspace_id
                 WHEN c.kind = 'dm' THEN '__system_dm_workspace__'
                 ELSE NEW.channel_id
               END,
               CASE
                 WHEN NEW.parent_session_id IS NOT NULL THEN p.workspace_path
                 ELSE c.workspace_path
               END,
               CASE
                 WHEN NEW.parent_session_id IS NOT NULL THEN 'thread'
                 WHEN c.kind = 'dm' THEN 'dm_channel'
                 ELSE 'channel'
               END,
               NEW.parent_session_id,
               NEW.title,
               NEW.status,
               NEW.spawned_by_agent_id,
               NEW.closed_at,
               NEW.close_summary,
               NEW.pinned_at,
               NEW.created_at,
               NEW.updated_at
          FROM channels c
          LEFT JOIN conversations p ON p.id = NEW.parent_session_id
         WHERE c.id = NEW.channel_id;
      END;

      CREATE TRIGGER legacy_sessions_to_conversations_update
      AFTER UPDATE OF title, status, closed_at, close_summary, pinned_at, updated_at ON sessions
      BEGIN
        UPDATE conversations
           SET title = NEW.title,
               status = NEW.status,
               closed_at = NEW.closed_at,
               close_summary = NEW.close_summary,
               pinned_at = NEW.pinned_at,
               updated_at = NEW.updated_at
         WHERE id = NEW.id;
      END;

      CREATE TRIGGER legacy_sessions_to_conversations_delete
      AFTER DELETE ON sessions
      BEGIN
        DELETE FROM conversations WHERE id = OLD.id;
      END;

      CREATE TRIGGER legacy_session_agents_to_conversation_agents_insert
      AFTER INSERT ON session_agents
      BEGIN
        INSERT OR IGNORE INTO conversation_agents
          (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
        VALUES (NEW.session_id, NEW.agent_id, NEW.cli_session_id, NEW.pid, NEW.status, NEW.joined_at);
      END;

      CREATE TRIGGER legacy_session_agents_to_conversation_agents_update
      AFTER UPDATE OF cli_session_id, pid, status ON session_agents
      BEGIN
        UPDATE conversation_agents
           SET cli_session_id = NEW.cli_session_id,
               pid = NEW.pid,
               status = NEW.status
         WHERE conversation_id = NEW.session_id AND agent_id = NEW.agent_id;
      END;

      CREATE TRIGGER legacy_session_agents_to_conversation_agents_delete
      AFTER DELETE ON session_agents
      BEGIN
        DELETE FROM conversation_agents
         WHERE conversation_id = OLD.session_id AND agent_id = OLD.agent_id;
      END;

      CREATE TRIGGER legacy_messages_conversation_insert
      AFTER INSERT ON messages
      BEGIN
        UPDATE messages
           SET conversation_id = NEW.session_id,
               task_workspace_id = CASE
                 WHEN NEW.task_number IS NULL THEN NULL
                 ELSE (SELECT workspace_id FROM conversations WHERE id = NEW.session_id)
               END
         WHERE id = NEW.id;
      END;

      CREATE TRIGGER legacy_messages_task_workspace_update
      AFTER UPDATE OF task_number, task_channel_id ON messages
      BEGIN
        UPDATE messages
           SET task_workspace_id = CASE
             WHEN NEW.task_number IS NULL THEN NULL
             ELSE (SELECT workspace_id FROM conversations WHERE id = NEW.session_id)
           END
         WHERE id = NEW.id;
      END;

      CREATE TRIGGER legacy_session_reads_to_conversation_reads_insert
      AFTER INSERT ON session_reads
      BEGIN
        INSERT OR REPLACE INTO conversation_reads
          (user_id, conversation_id, last_read_seq, read_at)
        VALUES (NEW.user_id, NEW.session_id, NEW.last_read_seq, NEW.read_at);
      END;

      CREATE TRIGGER legacy_session_reads_to_conversation_reads_update
      AFTER UPDATE OF last_read_seq, read_at ON session_reads
      BEGIN
        UPDATE conversation_reads
           SET last_read_seq = NEW.last_read_seq,
               read_at = NEW.read_at
         WHERE user_id = NEW.user_id AND conversation_id = NEW.session_id;
      END;

      CREATE TRIGGER legacy_session_reads_to_conversation_reads_delete
      AFTER DELETE ON session_reads
      BEGIN
        DELETE FROM conversation_reads
         WHERE user_id = OLD.user_id AND conversation_id = OLD.session_id;
      END;
    `,
  },
  {
    version: 12,
    name: 'workspace_conversation_hard_cutover',
    up: `
      CREATE TEMP TABLE _v12_zero_check (
        name TEXT NOT NULL,
        count INTEGER NOT NULL CHECK (count = 0)
      );

      INSERT INTO _v12_zero_check
      SELECT 'missing_conversations', COUNT(*)
        FROM sessions
       WHERE id NOT IN (SELECT id FROM conversations);

      INSERT INTO _v12_zero_check
      SELECT 'missing_message_conversation', COUNT(*)
        FROM messages
       WHERE conversation_id IS NULL
          OR conversation_id != session_id;

      INSERT INTO _v12_zero_check
      SELECT 'missing_task_workspace', COUNT(*)
        FROM messages
       WHERE task_number IS NOT NULL
         AND task_workspace_id IS NULL;

      INSERT INTO _v12_zero_check
      SELECT 'nested_threads', COUNT(*)
        FROM conversations child
        JOIN conversations parent ON parent.id = child.parent_conversation_id
       WHERE child.kind = 'thread'
         AND parent.kind = 'thread';

      INSERT INTO _v12_zero_check
      SELECT 'thread_workspace_mismatch', COUNT(*)
        FROM conversations child
        JOIN conversations parent ON parent.id = child.parent_conversation_id
       WHERE child.kind = 'thread'
         AND child.workspace_id != parent.workspace_id;

      DROP TABLE _v12_zero_check;

      DROP TRIGGER IF EXISTS legacy_channels_to_workspaces_insert;
      DROP TRIGGER IF EXISTS legacy_channels_to_workspaces_update;
      DROP TRIGGER IF EXISTS legacy_channels_to_workspaces_delete;
      DROP TRIGGER IF EXISTS legacy_channel_members_to_workspace_members_insert;
      DROP TRIGGER IF EXISTS legacy_channel_members_to_workspace_members_delete;
      DROP TRIGGER IF EXISTS legacy_sessions_to_conversations_insert;
      DROP TRIGGER IF EXISTS legacy_sessions_to_conversations_update;
      DROP TRIGGER IF EXISTS legacy_sessions_to_conversations_delete;
      DROP TRIGGER IF EXISTS legacy_session_agents_to_conversation_agents_insert;
      DROP TRIGGER IF EXISTS legacy_session_agents_to_conversation_agents_update;
      DROP TRIGGER IF EXISTS legacy_session_agents_to_conversation_agents_delete;
      DROP TRIGGER IF EXISTS legacy_messages_conversation_insert;
      DROP TRIGGER IF EXISTS legacy_messages_task_workspace_update;
      DROP TRIGGER IF EXISTS legacy_session_reads_to_conversation_reads_insert;
      DROP TRIGGER IF EXISTS legacy_session_reads_to_conversation_reads_update;
      DROP TRIGGER IF EXISTS legacy_session_reads_to_conversation_reads_delete;

      ALTER TABLE conversation_inboxes RENAME TO conversation_inboxes_legacy_v12;
      ALTER TABLE messages RENAME TO messages_legacy_v12;

      CREATE TABLE messages (
        id                      TEXT PRIMARY KEY,
        conversation_id         TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        from_kind               TEXT NOT NULL,
        from_agent_id           TEXT REFERENCES agents(id) ON DELETE SET NULL,
        from_user_id            TEXT,
        content                 TEXT NOT NULL,
        metadata                TEXT,
        seq                     INTEGER NOT NULL,
        created_at              INTEGER NOT NULL,
        task_number             INTEGER,
        task_status             TEXT,
        task_assignee_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
        task_assignee_user_id   TEXT,
        task_title              TEXT,
        task_workspace_id       TEXT REFERENCES workspaces(id) ON DELETE CASCADE
      );

      INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at, task_number, task_status,
         task_assignee_agent_id, task_assignee_user_id, task_title,
         task_workspace_id)
      SELECT id, conversation_id, from_kind, from_agent_id, from_user_id,
             content, metadata, seq, created_at, task_number, task_status,
             task_assignee_agent_id, task_assignee_user_id, task_title,
             task_workspace_id
        FROM messages_legacy_v12;

      DROP TABLE messages_legacy_v12;

      CREATE INDEX idx_messages_conversation
        ON messages(conversation_id, seq);
      CREATE UNIQUE INDEX uniq_messages_task_workspace_number
        ON messages(task_workspace_id, task_number)
        WHERE task_number IS NOT NULL;
      CREATE INDEX idx_messages_task_workspace
        ON messages(task_workspace_id, task_status)
        WHERE task_workspace_id IS NOT NULL;

      CREATE TABLE conversation_inboxes (
        id               INTEGER PRIMARY KEY,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        delivered_at     INTEGER,
        created_at       INTEGER NOT NULL
      );

      INSERT INTO conversation_inboxes
        (id, conversation_id, agent_id, message_id, delivered_at, created_at)
      SELECT id, conversation_id, agent_id, message_id, delivered_at, created_at
        FROM conversation_inboxes_legacy_v12;

      DROP TABLE conversation_inboxes_legacy_v12;

      CREATE INDEX idx_conversation_inbox_pending
        ON conversation_inboxes(conversation_id, agent_id, delivered_at);

      ALTER TABLE saved_messages RENAME TO saved_messages_legacy_v12;

      CREATE TABLE saved_messages (
        id               TEXT PRIMARY KEY,
        message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        saved_at         INTEGER NOT NULL
      );

      INSERT INTO saved_messages
        (id, message_id, conversation_id, workspace_id, saved_at)
      SELECT id, message_id, conversation_id, workspace_id, saved_at
        FROM saved_messages_legacy_v12;

      DROP TABLE saved_messages_legacy_v12;

      CREATE UNIQUE INDEX uniq_saved_messages_message
        ON saved_messages(message_id);
      CREATE INDEX idx_saved_messages_workspace
        ON saved_messages(workspace_id, saved_at DESC);

      ALTER TABLE notifications RENAME TO notifications_legacy_v12;

      CREATE TABLE notifications (
        id                      TEXT PRIMARY KEY,
        kind                    TEXT NOT NULL,
        user_id                 TEXT,
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

      INSERT INTO notifications
        (id, kind, user_id, agent_id, workspace_id, conversation_id, message_id,
         source_workspace_id, source_conversation_id, source_message_id,
         payload, read_at, created_at)
      SELECT n.id,
             n.kind,
             n.user_id,
             n.agent_id,
             CASE
               WHEN n.session_id IS NOT NULL
                 THEN (SELECT workspace_id FROM conversations WHERE id = n.session_id)
               WHEN n.channel_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM conversations WHERE id = n.channel_id)
                 THEN (SELECT workspace_id FROM conversations WHERE id = n.channel_id)
               WHEN n.channel_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM workspaces WHERE id = n.channel_id)
                 THEN n.channel_id
               ELSE NULL
             END AS workspace_id,
             CASE
               WHEN n.session_id IS NOT NULL
                 THEN n.session_id
               WHEN n.channel_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM conversations WHERE id = n.channel_id)
                 THEN n.channel_id
               ELSE NULL
             END AS conversation_id,
             n.message_id,
             CASE
               WHEN n.source_session_id IS NOT NULL
                 THEN (SELECT workspace_id FROM conversations WHERE id = n.source_session_id)
               WHEN n.source_channel_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM conversations WHERE id = n.source_channel_id)
                 THEN (SELECT workspace_id FROM conversations WHERE id = n.source_channel_id)
               WHEN n.source_channel_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM workspaces WHERE id = n.source_channel_id)
                 THEN n.source_channel_id
               ELSE NULL
             END AS source_workspace_id,
             CASE
               WHEN n.source_session_id IS NOT NULL
                 THEN n.source_session_id
               WHEN n.source_channel_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM conversations WHERE id = n.source_channel_id)
                 THEN n.source_channel_id
               ELSE NULL
             END AS source_conversation_id,
             n.source_message_id,
             n.payload,
             n.read_at,
             n.created_at
        FROM notifications_legacy_v12 n;

      DROP TABLE notifications_legacy_v12;

      CREATE INDEX idx_notifications_unread
        ON notifications(user_id, read_at, created_at DESC);
      CREATE INDEX idx_notifications_conversation_unread
        ON notifications(conversation_id, read_at, created_at DESC);
      CREATE INDEX idx_notifications_source_conversation
        ON notifications(source_conversation_id, created_at DESC);

      DROP TABLE IF EXISTS agent_inboxes;
      DROP TABLE IF EXISTS session_events;
      DROP TABLE IF EXISTS session_reads;
      DROP TABLE IF EXISTS session_agents;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS channel_members;
      DROP TABLE IF EXISTS channels;

      CREATE TEMP TABLE _v12_fk_check (
        table_name TEXT CHECK (table_name IS NULL),
        rowid INTEGER,
        parent TEXT,
        fkid INTEGER
      );
      INSERT INTO _v12_fk_check SELECT * FROM pragma_foreign_key_check;
      DROP TABLE _v12_fk_check;
    `,
  },
  {
    version: 13,
    name: 'messages_conversation_from_kind_index',
    up: `
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_from_kind
        ON messages(conversation_id, from_kind, seq);
    `,
  },
  {
    version: 14,
    name: 'agent_fast_mode',
    // Tri-state codex feature toggle: NULL = use codex's own default
    // (the catalog currently ships it as `stable / true`), 1 = pass
    // `--enable fast_mode` at spawn, 0 = pass `--disable fast_mode`.
    // Other runtimes ignore the column.
    up: `
      ALTER TABLE agents ADD COLUMN fast_mode INTEGER;
    `,
  },
  {
    version: 15,
    name: 'attachments',
    // Attachment application schema. Backed by the blob/file storage infra
    // (`packages/backend/src/storage/blob-file-storage.ts`).
    //
    // Boundaries (see docs/attachments-design.md §3):
    //   - channel_id   = access boundary. Must reference a channel-like
    //                    conversation (`kind IN ('channel','dm_channel')`);
    //                    enforced at the application layer (no SQLite
    //                    partial-FK syntax). ON DELETE CASCADE so dropping
    //                    a channel sweeps its attachments too.
    //   - source_conversation_id = lineage tag. May be the channel itself
    //                    or a thread under it. ON DELETE SET NULL so
    //                    closing a thread keeps the blob.
    //   - No hash, no UNIQUE: every upload creates a new row + new blob,
    //                    so filename/source/creator never get clobbered.
    up: `
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
    `,
  },
  {
    version: 16,
    name: 'agent_home_workspaces',
    foreignKeyEscape: true,
    up: `
      ALTER TABLE workspaces RENAME TO workspaces_legacy_v16;

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
        updated_at         INTEGER NOT NULL,
        CHECK (
          (workspace_kind = 'agent_home' AND owner_agent_id IS NOT NULL)
          OR
          (workspace_kind = 'regular' AND owner_agent_id IS NULL)
        )
      );

      CREATE UNIQUE INDEX workspaces_regular_name_unique
        ON workspaces(name) WHERE workspace_kind = 'regular';

      INSERT INTO workspaces
        (id, name, description, workspace_kind, workspace_path, workspace_host_id,
         owner_agent_id, archived_at, created_at, updated_at)
      SELECT id, name, description, 'regular', workspace_path, workspace_host_id,
             NULL, archived_at, created_at, updated_at
        FROM workspaces_legacy_v16
       WHERE workspace_kind = 'regular';

      INSERT INTO workspaces
        (id, name, description, workspace_kind, workspace_path, workspace_host_id,
         owner_agent_id, archived_at, created_at, updated_at)
      SELECT 'wsah_' || a.id,
             a.name,
             'Personal home workspace for ' || a.name,
             'agent_home',
             (
               SELECT c.workspace_path
                 FROM conversations c
                 JOIN conversation_agents ca ON ca.conversation_id = c.id
                WHERE c.kind = 'dm_channel'
                  AND c.workspace_id = '__system_dm_workspace__'
                  AND ca.agent_id = a.id
                ORDER BY CASE
                           WHEN c.title = 'dm-' || (SELECT name FROM agents WHERE id = ca.agent_id)
                             THEN 0
                           ELSE 1
                         END,
                         c.created_at ASC
                LIMIT 1
             ),
             a.host_id,
             a.id,
             NULL,
             (
               SELECT c.created_at
                 FROM conversations c
                 JOIN conversation_agents ca ON ca.conversation_id = c.id
                WHERE c.kind = 'dm_channel'
                  AND c.workspace_id = '__system_dm_workspace__'
                  AND ca.agent_id = a.id
                ORDER BY CASE
                           WHEN c.title = 'dm-' || (SELECT name FROM agents WHERE id = ca.agent_id)
                             THEN 0
                           ELSE 1
                         END,
                         c.created_at ASC
                LIMIT 1
             ),
             (
               SELECT c.updated_at
                 FROM conversations c
                 JOIN conversation_agents ca ON ca.conversation_id = c.id
                WHERE c.kind = 'dm_channel'
                  AND c.workspace_id = '__system_dm_workspace__'
                  AND ca.agent_id = a.id
                ORDER BY CASE
                           WHEN c.title = 'dm-' || (SELECT name FROM agents WHERE id = ca.agent_id)
                             THEN 0
                           ELSE 1
                         END,
                         c.created_at ASC
                LIMIT 1
             )
        FROM agents a
       WHERE EXISTS (
             SELECT 1
               FROM conversations c
               JOIN conversation_agents ca ON ca.conversation_id = c.id
              WHERE c.kind = 'dm_channel'
                AND c.workspace_id = '__system_dm_workspace__'
                AND ca.agent_id = a.id
       );

      UPDATE conversations
         SET workspace_id =
           'wsah_' || (
             SELECT ca.agent_id
               FROM conversation_agents ca
              WHERE ca.conversation_id = conversations.id
              LIMIT 1
           )
       WHERE kind = 'dm_channel'
         AND workspace_id = '__system_dm_workspace__';

      UPDATE conversations
         SET workspace_id = (
           SELECT root.workspace_id
             FROM conversations root
            WHERE root.id = conversations.parent_conversation_id
         )
       WHERE kind = 'thread'
         AND workspace_id = '__system_dm_workspace__';

      UPDATE messages
         SET task_workspace_id = (
           SELECT c.workspace_id
             FROM conversations c
            WHERE c.id = messages.conversation_id
         )
       WHERE task_workspace_id = '__system_dm_workspace__';

      UPDATE saved_messages
         SET workspace_id = (
           SELECT c.workspace_id
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
            WHERE m.id = saved_messages.message_id
         )
       WHERE workspace_id = '__system_dm_workspace__';

      UPDATE notifications
         SET workspace_id = (
           SELECT c.workspace_id
             FROM conversations c
            WHERE c.id = notifications.conversation_id
         )
       WHERE workspace_id = '__system_dm_workspace__';

      UPDATE notifications
         SET source_workspace_id = (
           SELECT c.workspace_id
             FROM conversations c
            WHERE c.id = notifications.source_conversation_id
         )
       WHERE source_workspace_id = '__system_dm_workspace__';

      DROP TABLE workspaces_legacy_v16;

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
    `,
  },
  {
    version: 17,
    name: 'conversation_archive',
    // Soft archive flag for top-level channels. Independent of `closed_at`
    // / `status` — archive is purely organizational (sidebar grouping) and
    // does not stop agents or block delivery. Application layer enforces
    // that only `kind = 'channel'` rows get this set.
    up: `
      ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
      CREATE INDEX idx_conversations_archived_at
        ON conversations(workspace_id)
        WHERE archived_at IS NOT NULL;
    `,
  },
  {
    version: 18,
    name: 'schedules',
    // Agent-owned cron-like scheduler. Schedules are private to the owning
    // agent (no cross-agent visibility), have ZERO coupling to channels /
    // tasks / messages — context, if any, lives inside the free-text
    // `message` field. Wake fires by enqueuing a `from_kind='system'`
    // message into the owner agent's agent_home primary dm_channel and
    // delivering only to the owner.
    //
    // `spec_json` holds a discriminated union:
    //   { kind: 'once', fire_at }                              // one-shot
    //   { kind: 'interval', every_seconds, start_at? }         // fixed interval
    //   { kind: 'cron', expression, timezone }                 // 5-field UNIX cron
    // `next_fire_at` is a denormalized epoch-ms cache of the spec's next
    // due time — service is responsible for keeping it in sync after
    // every fire (always advanced from `actual_fire_at`, NOT from old
    // `next_fire_at`).
    //
    // Status lifecycle:
    //   pending → firing (CAS lease at scheduler tick)
    //   firing → pending (repeat: advance next_fire_at)
    //   firing → done    (one-shot terminal | repeat hit max_occurrences/until_at)
    //   firing → failed  (enqueue/wake failure; terminal for v1)
    //   pending|firing → cancelled (agent cancelled; terminal)
    // App startup resets stale `firing` rows back to `pending` so a
    // crash mid-fire doesn't lose the schedule.
    up: `
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
      );

      -- Scheduler tick scans due rows: WHERE status='pending' AND next_fire_at<=now
      CREATE INDEX idx_schedules_due
        ON schedules(status, next_fire_at);

      -- list_schedules / quota counts: WHERE owner_agent_id=? AND status IN (...)
      CREATE INDEX idx_schedules_owner
        ON schedules(owner_agent_id, status);
    `,
  },
  {
    version: 19,
    name: 'workspace_pin',
    // Per-workspace pin: pinned regular workspaces float above unpinned
    // regular workspaces in the sidebar. NULL means unpinned; non-NULL
    // is the pin timestamp and gives stable ordering across multiple
    // pinned workspaces.
    up: `
      ALTER TABLE workspaces ADD COLUMN pinned_at INTEGER;
      CREATE INDEX idx_workspaces_pinned_at
        ON workspaces(workspace_kind, pinned_at)
        WHERE pinned_at IS NOT NULL;
    `,
  },
  {
    version: 20,
    name: 'unique_conversation_inbox_deliveries',
    // `conversation_inboxes` is the durable delivery queue for
    // (conversation, agent, message). A message should be delivered to a
    // given agent at most once; pending rows survive stop/restart/clear and
    // are marked delivered only after the runtime accepts the input.
    up: `
      DELETE FROM conversation_inboxes
       WHERE id NOT IN (
         SELECT CASE
                  WHEN SUM(CASE WHEN delivered_at IS NULL THEN 1 ELSE 0 END) > 0
                    THEN MIN(CASE WHEN delivered_at IS NULL THEN id END)
                  ELSE MIN(id)
                END
           FROM conversation_inboxes
          GROUP BY conversation_id, agent_id, message_id
       );

      CREATE UNIQUE INDEX uniq_conversation_inbox_delivery
        ON conversation_inboxes(conversation_id, agent_id, message_id);
    `,
  },
];
