/**
 * Backend-injected db handle type. We keep `precondition` typed as
 * `unknown` here in the shared package so this module stays free of a
 * runtime dependency on `better-sqlite3` (only the backend imports
 * that). The migration runner in `packages/backend/src/db.ts` casts
 * to its `Database` instance before invoking.
 */
export type MigrationDb = unknown;

export interface Migration {
  version: number;
  name: string;
  up: string;
  foreignKeyEscape?: true;
  /**
   * Optional code-level precondition. Runs INSIDE the migration's
   * transaction, BEFORE `up` is exec'd. Throwing aborts the
   * transaction — no rows are written to `_migrations`, so the
   * migration is retried on next boot.
   *
   * Use cases:
   *   - asserting a prior bridge has been consumed (Mode B cleanup
   *     v23 fails if `legacy_*_v21` staging tables still exist);
   *   - inspecting `PRAGMA foreign_key_check` results before applying
   *     destructive DDL;
   *   - any guard whose error message must be clearer than what a SQL
   *     CHECK / UNIQUE violation would produce.
   *
   * SQL-only `RAISE(ABORT, ...)` cannot be used in standalone
   * statements (SQLite restricts it to trigger programs), so this
   * hook is the canonical way to fail-fast a migration with a
   * developer-readable error.
   */
  precondition?: (db: MigrationDb) => void;
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
  {
    version: 21,
    name: 'users_registry',
    foreignKeyEscape: true,
    // Establishes a real `users` table to back the principal abstraction.
    //
    // INVARIANT: a row in `users` represents a *registered* identity.
    // Pre-registration there is NO user row — `app_settings.viewer_user_id`
    // is simply absent. `POST /api/register` is the sole creator of user
    // rows: it INSERTs a new `users` row and writes `viewer_user_id` in
    // a single transaction. The principal middleware reads
    // `viewer_user_id`; when absent, no user principal is set, and the
    // pre-register gate refuses every public route except the
    // registration whitelist (`GET /api/me`, `POST /api/register`,
    // `GET /api/health`).
    //
    // V2 multi-user only swaps the principal *source* (token claims
    // instead of `app_settings.viewer_user_id`) and adds auth identity /
    // session tables; this schema does not change. Future invitation
    // flows use a separate `pending_invites` table — they do NOT
    // pre-insert into `users`.
    //
    // DEFERRED ADOPTION (replaces the earlier "wipe contract"): pre-v21
    // dev DBs hold legacy user-id literals (`'local'`, `'desktop-user-42'`,
    // etc.) in user-owned columns. Rather than DELETE/NULL those rows
    // and force `rm -rf ~/.silverhand` on every developer, v21 stages
    // the legacy facts into four `legacy_*_v21` holding tables and
    // leaves the new main schema empty/clean. `POST /api/register`
    // (in `UserService.register()`) is the sole adopter: in the same
    // transaction that creates the first `users` row, it consumes the
    // staging tables and rewrites the legacy ids to the new viewer.
    // After successful registration the staging tables are dropped and
    // an audit row is written to `app_settings`. See
    // `docs/remote-backend-architecture-notes.md §1` for the long-term
    // plan to retire the bridge.
    //
    // What this migration does (NON-DESTRUCTIVE):
    //   1. CREATE TABLE `users` with `name UNIQUE` and avatar pair-CHECK.
    //   2. Capture pre-v21 user-owned references into staging tables:
    //        - `legacy_message_from_user_v21(message_id PK)` — message
    //          ids whose old `from_kind='user' AND from_user_id IS NOT NULL`.
    //        - `legacy_message_task_assignee_user_v21(message_id PK)` —
    //          message ids whose old `task_number IS NOT NULL AND
    //          task_assignee_user_id IS NOT NULL`.
    //        - `legacy_conversation_reads_v21(...full row + original_user_id)`
    //          — every old conversation_reads row, intact.
    //        - `legacy_user_attachments_v21(...full attachments columns)`
    //          — every old `attachments(created_by_kind='user')` row, intact.
    //   3. Move kind=user attachments out of the main `attachments`
    //      table BEFORE installing the dispatch trigger so the trigger
    //      never sees a row with a created_by_id that isn't yet a
    //      legitimate user — the staging table is the temporary home
    //      for those rows until registration adopts them.
    //   4. Rebuild messages / conversation_reads / notifications with
    //      FK to `users(id)` (v12 ALTER RENAME pattern). user-id columns
    //      are INSERT-SELECTed as NULL (legacy values are already preserved
    //      via staging on the message ids that need them; conversation_reads
    //      starts empty because the staging table holds the full rows).
    //      `notifications.user_id` is intentionally NOT staged — the
    //      majority of pre-v21 notifications were system-kind with no
    //      user_id, and bulk-adopting them at register would over-claim.
    //   5. Install `attachments.created_by_id` polymorphic dispatch
    //      trigger (kind=user → users; kind=agent → agents). Safe now
    //      that user-kind rows are in staging.
    //   6. Install cross-namespace uniqueness triggers between
    //      `users.name` and `agents.name` so `@<name>` mentions resolve
    //      unambiguously.
    //   7. Final `pragma_foreign_key_check` to refuse an inconsistent
    //      commit.
    //
    // FRESH-DB CASE: source rows are zero, staging tables are created
    // empty, register's adoption step is a no-op, audit counts are all
    // zero. Same code path, same final state.
    //
    // PRE-V21 BACKUP CASE: source rows non-empty, staging captures them,
    // register's adoption step rewrites legacy ids to the new viewer
    // and drops the staging tables.
    up: `
      CREATE TABLE users (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL UNIQUE,
        display_name        TEXT NOT NULL,
        avatar_storage_key  TEXT,
        avatar_content_type TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        CHECK (
          (avatar_storage_key IS NULL AND avatar_content_type IS NULL)
          OR
          (avatar_storage_key IS NOT NULL AND avatar_content_type IS NOT NULL)
        )
      );

      -- Staging tables for legacy user-owned facts. Built with explicit
      -- DDL (not CREATE TABLE AS SELECT) so PK / column types are exact;
      -- INSERT SELECT then captures the source rows. Empty source =
      -- empty staging, register adoption is a no-op.

      CREATE TABLE legacy_message_from_user_v21 (
        message_id TEXT PRIMARY KEY
      );
      INSERT INTO legacy_message_from_user_v21 (message_id)
      SELECT id
        FROM messages
       WHERE from_kind = 'user'
         AND from_user_id IS NOT NULL;

      CREATE TABLE legacy_message_task_assignee_user_v21 (
        message_id TEXT PRIMARY KEY
      );
      INSERT INTO legacy_message_task_assignee_user_v21 (message_id)
      SELECT id
        FROM messages
       WHERE task_number IS NOT NULL
         AND task_assignee_user_id IS NOT NULL;

      CREATE TABLE legacy_conversation_reads_v21 (
        original_user_id TEXT NOT NULL,
        conversation_id  TEXT NOT NULL,
        last_read_seq    INTEGER NOT NULL,
        read_at          INTEGER NOT NULL,
        PRIMARY KEY (original_user_id, conversation_id)
      );
      INSERT INTO legacy_conversation_reads_v21
        (original_user_id, conversation_id, last_read_seq, read_at)
      SELECT user_id, conversation_id, last_read_seq, read_at
        FROM conversation_reads;

      -- attachments staging mirrors the v15 column shape exactly so
      -- adoption can re-INSERT into the live attachments table without
      -- column drift. No FK declared here (staging is a parking lot).
      CREATE TABLE legacy_user_attachments_v21 (
        id                     TEXT PRIMARY KEY,
        channel_id             TEXT NOT NULL,
        source_conversation_id TEXT,
        filename               TEXT NOT NULL,
        size                   INTEGER NOT NULL,
        content_type           TEXT NOT NULL,
        storage                TEXT NOT NULL,
        storage_key            TEXT NOT NULL,
        created_by_kind        TEXT NOT NULL,
        created_by_id          TEXT NOT NULL,
        created_at             INTEGER NOT NULL
      );
      INSERT INTO legacy_user_attachments_v21
        (id, channel_id, source_conversation_id, filename, size, content_type,
         storage, storage_key, created_by_kind, created_by_id, created_at)
      SELECT id, channel_id, source_conversation_id, filename, size, content_type,
             storage, storage_key, created_by_kind, created_by_id, created_at
        FROM attachments
       WHERE created_by_kind = 'user';

      -- Now that user-kind attachments are safely in staging, evict
      -- them from the main table. Remaining rows are kind='agent' and
      -- already FK-valid, so the trigger we install in step 5 won't
      -- block any existing data.
      DELETE FROM attachments
       WHERE created_by_kind = 'user';

      -- Rebuild messages with FK on from_user_id and task_assignee_user_id.
      -- user-id columns are NULL'd; legacy attribution lives in
      -- legacy_message_*_v21 staging and is restored at register time.
      ALTER TABLE messages RENAME TO messages_legacy_v21;

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
      );

      INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at, task_number, task_status,
         task_assignee_agent_id, task_assignee_user_id, task_title,
         task_workspace_id)
      SELECT id, conversation_id, from_kind, from_agent_id, NULL,
             content, metadata, seq, created_at, task_number, task_status,
             task_assignee_agent_id, NULL, task_title,
             task_workspace_id
        FROM messages_legacy_v21;

      DROP TABLE messages_legacy_v21;

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

      -- Rebuild conversation_reads with FK on user_id (NOT NULL by domain).
      ALTER TABLE conversation_reads RENAME TO conversation_reads_legacy_v21;

      CREATE TABLE conversation_reads (
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        last_read_seq    INTEGER NOT NULL DEFAULT 0,
        read_at          INTEGER NOT NULL,
        PRIMARY KEY (user_id, conversation_id)
      );

      -- Pre-v21 rows were already copied to legacy_conversation_reads_v21
      -- staging above; do not copy them into the live table here —
      -- adoption at POST /api/register time will rewrite legacy ids to
      -- the freshly registered viewer.
      DROP TABLE conversation_reads_legacy_v21;

      CREATE INDEX idx_conversation_reads_conversation
        ON conversation_reads(conversation_id);

      -- Rebuild notifications with FK on user_id (nullable; SET NULL on
      -- delete so notification rows stay readable when the user goes
      -- away in the future). user_id values are NULL'd because the
      -- pre-v21 majority were system-kind notifications anyway; we
      -- intentionally do NOT stage them — bulk-adopting at register
      -- would over-claim system-authored notifications to the viewer.
      ALTER TABLE notifications RENAME TO notifications_legacy_v21;

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

      INSERT INTO notifications
        (id, kind, user_id, agent_id, workspace_id, conversation_id, message_id,
         source_workspace_id, source_conversation_id, source_message_id,
         payload, read_at, created_at)
      SELECT id, kind, NULL, agent_id, workspace_id, conversation_id, message_id,
             source_workspace_id, source_conversation_id, source_message_id,
             payload, read_at, created_at
        FROM notifications_legacy_v21;

      DROP TABLE notifications_legacy_v21;

      CREATE INDEX idx_notifications_unread
        ON notifications(user_id, read_at, created_at DESC);
      CREATE INDEX idx_notifications_conversation_unread
        ON notifications(conversation_id, read_at, created_at DESC);
      CREATE INDEX idx_notifications_source_conversation
        ON notifications(source_conversation_id, created_at DESC);

      -- attachments.created_by_id is polymorphic (kind ∈ {user, agent}).
      -- SQLite has no conditional FK syntax, so a trigger validates by
      -- kind. Honest about what it is, instead of pretending to be FK.
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

      -- Mention resolution treats users.name ⊕ agents.name as a single
      -- namespace; otherwise @local could be ambiguous if a user named
      -- 'local' coexists with an agent named 'local'. Reject any insert
      -- or rename that would produce a collision.
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

      -- Final FK integrity check (mirrors v12). Any orphan reference
      -- aborts the migration so we never commit a broken state.
      CREATE TEMP TABLE _v21_fk_check (
        table_name TEXT CHECK (table_name IS NULL),
        rowid      INTEGER,
        parent     TEXT,
        fkid       INTEGER
      );
      INSERT INTO _v21_fk_check SELECT * FROM pragma_foreign_key_check;
      DROP TABLE _v21_fk_check;
    `,
  },
  {
    version: 22,
    name: 'identity_model_rewritten_pre_ship',
    // No-op. The original v22 renamed `users.handle` → `users.name`;
    // the rewritten v21 (above) creates the column as `name` directly,
    // so this version exists only to keep the version sequence stable
    // for dev DBs that already advanced to v22 under the prior model.
    // No data or schema changes.
    //
    // See v21 header for the Deferred Adoption contract — pre-v21
    // user-owned facts are staged into `legacy_*_v21` and adopted at
    // first `POST /api/register`. Future identity-model changes
    // should land in a new migration version, not by mutating either
    // of these.
    up: `-- intentionally empty`,
  },
  {
    version: 23,
    name: 'remove_v21_adoption_bridge',
    // Mode B cleanup: this build no longer supports automatic
    // adoption of pre-v21 backups. The v21 staging-creation contract
    // is preserved in git history (and v21's body must NOT be
    // edited — once applied to any DB, mutating it would create a
    // schema drift between DBs that share the same `_migrations`
    // version), but the register-time adoption helper has been
    // removed in this commit alongside this migration.
    //
    // The precondition guards against a half-migrated DB: if any of
    // the four `legacy_*_v21` staging tables still hold rows, they
    // contain unadopted user-owned data that this build can no longer
    // import. Aborting forces the operator to either (a) drop the
    // backup or (b) migrate it on a build that still has Deferred
    // Adoption (any commit before this one).
    //
    // EMPTY staging tables (created by v21, then never written to
    // because the source tables were already empty — i.e. fresh
    // install) are dropped by the `up` body. This is safe by
    // construction: zero rows, zero data loss. The two-step shape
    // (precondition assert non-empty → up drops empty) is the
    // canonical Mode B pattern; v23 NEVER drops a non-empty staging
    // table.
    //
    // It also runs `PRAGMA foreign_key_check` and aborts on any
    // violation — better to fail fast than ship a v23 row over a
    // broken state.
    precondition: db => {
      // Cast: shared package keeps `MigrationDb = unknown` to avoid a
      // runtime dependency on better-sqlite3. The runner injects the
      // real Database instance.
      const sqliteDb = db as {
        prepare: (sql: string) => {
          all: (...args: unknown[]) => unknown[];
          get: (...args: unknown[]) => unknown;
        };
        pragma: (cmd: string) => unknown;
      };

      const stagingNames = [
        'legacy_message_from_user_v21',
        'legacy_message_task_assignee_user_v21',
        'legacy_conversation_reads_v21',
        'legacy_user_attachments_v21',
      ];

      const present = sqliteDb
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table'
              AND name IN (${stagingNames.map(() => '?').join(',')})`,
        )
        .all(...stagingNames) as Array<{ name: string }>;

      // Inspect each staging table that still exists. Drop is safe
      // only when COUNT(*) = 0; any non-zero count blocks v23.
      const nonEmpty: Array<{ name: string; rows: number }> = [];
      for (const { name } of present) {
        // Identifier is from a fixed allow-list above, not user input,
        // so direct interpolation is safe here.
        const row = sqliteDb
          .prepare(`SELECT COUNT(*) AS n FROM ${name}`)
          .get() as { n: number };
        if (row.n > 0) nonEmpty.push({ name, rows: row.n });
      }

      if (nonEmpty.length > 0) {
        const summary = nonEmpty.map(s => `${s.name}(${s.rows})`).join(', ');
        throw new Error(
          `v23 cleanup: legacy_*_v21 staging tables still hold unadopted `
            + `rows (${summary}). This build no longer supports auto-adoption `
            + `of pre-v21 backups. To recover this DB, register first on a `
            + `build that still has Deferred Adoption (any commit before `
            + `this one), then upgrade.`,
        );
      }

      // PRAGMA foreign_key_check returns rows for violations and does
      // NOT raise — caller must inspect.
      const fkRows = sqliteDb.pragma('foreign_key_check') as unknown[];
      if (fkRows.length > 0) {
        const sample = JSON.stringify(fkRows.slice(0, 5));
        throw new Error(
          `v23 cleanup: foreign_key_check found ${fkRows.length} `
            + `violation(s); refusing to apply. Sample: ${sample}`,
        );
      }
    },
    // Drop staging tables IF they exist and are empty (precondition
    // guarantees emptiness). Idempotent — safe on post-adoption DBs
    // where register-time adoption already DROPped them.
    up: `
      DROP TABLE IF EXISTS legacy_message_from_user_v21;
      DROP TABLE IF EXISTS legacy_message_task_assignee_user_v21;
      DROP TABLE IF EXISTS legacy_conversation_reads_v21;
      DROP TABLE IF EXISTS legacy_user_attachments_v21;
    `,
  },
  {
    version: 24,
    name: 'remove_legacy_v21_adoption_audit_settings',
    // The Mode B cleanup removed the Deferred Adoption runtime and v23
    // removed the staging tables. These two app_settings rows were the
    // last per-DB evidence written by the old register-time bridge; once
    // the bridge is retired they are no longer read or written.
    //
    // Keep this as its own migration instead of asking operators to edit
    // app_settings by hand, so every DB reaches the same steady state.
    up: `
      DELETE FROM app_settings
       WHERE key IN (
         'legacy_v21_adoption_completed_at',
         'legacy_v21_adoption_counts'
       );
    `,
  },
  {
    version: 25,
    name: 'human_workspace_and_conversation_membership',
    // Real human membership tables — until now humans have been
    // implicit (the registered viewer in `app_settings.viewer_user_id`
    // could view everything by existence-check alone). PR-A of the
    // multi-human prep adds explicit `workspace_users` /
    // `conversation_users` rows, mirroring the agent membership tables
    // (`workspace_members` / `conversation_agents`) but without the
    // process-lifecycle columns (cli_session_id / pid / status) that
    // are agent-only.
    //
    // Naming asymmetry note: the existing agent table is
    // `workspace_members` (historical). We add `workspace_users`
    // alongside it instead of renaming, to keep this migration small
    // and to avoid touching the dozens of repo/service/route call
    // sites that already reference `workspace_members`. Future cleanup
    // may unify the names — out of scope here.
    //
    // Workspace kind scope: unlike `workspace_members` (v17 trigger
    // forbids agent_home rows because agent access is owner-driven),
    // `workspace_users` allows ALL workspace kinds — humans have no
    // owner column equivalent, and agent_home / DM workspaces still
    // need the human as a member so the chat UI and prompt context
    // can list them.
    //
    // Backfill (idempotent): if `app_settings.viewer_user_id` is
    // already set (i.e. this DB has been registered against a build
    // with Deferred Adoption removed but no membership tables yet —
    // shiki's case), insert the viewer into every existing
    // `workspaces` row's `workspace_users` and every existing
    // `conversations` row's `conversation_users`. Pre-registration
    // DBs (no `viewer_user_id`) are no-ops here; `UserService.register()`
    // performs the equivalent membership write inside its own
    // single-tx registration flow when a human first registers.
    //
    // INSERT-only contract: per @shiki greenlight, this migration
    // does not DELETE or UPDATE any existing rows. It only writes new
    // membership edges; tables that did not exist before this
    // migration come up empty. Idempotent with INSERT OR IGNORE on
    // the backfill (in case a future rerun-shaped scenario sees both
    // the row already there and the migration ledger missing).
    up: `
      CREATE TABLE workspace_users (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at    INTEGER NOT NULL,
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

      -- Backfill: if a viewer is already registered, give them
      -- membership edges to every existing workspace and conversation.
      -- The SELECT viewer_user_id subquery returns NULL on
      -- pre-registration DBs, and the INSERT ... SELECT silently
      -- inserts zero rows in that case — so this is safe on every DB
      -- shape. INSERT OR IGNORE protects against rare reapply paths.
      INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, joined_at)
        SELECT w.id,
               (SELECT value FROM app_settings WHERE key = 'viewer_user_id'),
               COALESCE(w.created_at, strftime('%s','now') * 1000)
          FROM workspaces w
         WHERE (SELECT value FROM app_settings WHERE key = 'viewer_user_id') IS NOT NULL;

      INSERT OR IGNORE INTO conversation_users (conversation_id, user_id, joined_at)
        SELECT c.id,
               (SELECT value FROM app_settings WHERE key = 'viewer_user_id'),
               COALESCE(c.created_at, strftime('%s','now') * 1000)
          FROM conversations c
         WHERE (SELECT value FROM app_settings WHERE key = 'viewer_user_id') IS NOT NULL;
    `,
  },
  {
    version: 26,
    name: 'agent_creator_and_avatar',
    foreignKeyEscape: true,
    // Agent profile feature: persist the creator (a `users.id`) on every
    // agent row, and add the avatar storage pair (mirrors `users` v21).
    // The creator is the source of truth for `canEditAgent`: only the
    // creator (user) and the agent itself (via internal route, future
    // PR) may PATCH the agent's profile or replace its avatar.
    //
    // Why a full table rebuild: SQLite cannot retro-actively add a
    // `NOT NULL` column without a constant DEFAULT, and the FK to
    // `users(id)` cannot be a string literal default. Rebuild + INSERT
    // SELECT is the only way to make `created_by_user_id` non-null on
    // existing rows. We pair it with the avatar columns + CHECK in the
    // same rebuild to avoid a second rebuild later.
    //
    // ON DELETE RESTRICT for `created_by_user_id`: the creator is a
    // permission-granting reference, not metadata. Cascading delete
    // (CASCADE) would silently destroy agents whose creator went away;
    // nulling it (SET NULL) would leave agents permanently human-
    // unmanageable. RESTRICT forces the v2 multi-human path to make an
    // explicit decision (reassign / archive / hard-delete) before
    // removing a user. v1 has no user-delete surface so this is never
    // exercised in production today.
    //
    // Trigger handling (legacy_alter_table = ON, set by `foreignKeyEscape`):
    // body references to `agents` in v21's six triggers are NOT
    // automatically rewritten when the table is renamed. We explicitly
    // DROP all six before the rebuild and recreate them verbatim after
    // the new `agents` table is in place.
    //
    // Backfill: existing rows take `created_by_user_id` from
    // `app_settings.viewer_user_id`. v1 single-human installs have one
    // viewer who created every existing agent — this is the true
    // attribution. Pre-registration DBs with zero agent rows produce
    // zero INSERTs (the SELECT-from-empty-source short-circuit) so the
    // migration succeeds without a viewer pointer. Pre-registration
    // DBs WITH agent rows trigger a `NOT NULL constraint failed` (the
    // SELECT subquery returns NULL); this state is impossible in
    // production (the create route is user-gated) and the loud abort
    // is the honest answer for a corrupt DB.
    //
    // Avatar columns: nullable pair coupled by CHECK, matching `users`
    // v21. The PR-2 service layer writes both at once; the public
    // `GET /api/agents/:id/avatar` route serves the blob.
    up: `
      -- 1. Drop triggers that reference \`agents\` (either ON agents or
      --    in body). legacy_alter_table=ON means we own this; modern
      --    SQLite would otherwise update body refs automatically.
      DROP TRIGGER IF EXISTS attachments_created_by_validate_insert;
      DROP TRIGGER IF EXISTS attachments_created_by_validate_update;
      DROP TRIGGER IF EXISTS users_name_unique_against_agents_insert;
      DROP TRIGGER IF EXISTS users_name_unique_against_agents_update;
      DROP TRIGGER IF EXISTS agents_name_unique_against_users_insert;
      DROP TRIGGER IF EXISTS agents_name_unique_against_users_update;

      -- 2. Rebuild agents with new columns. The full final shape:
      --    v1 (id, name, runtime, model, host_id, description,
      --        created_at, updated_at)
      --    v5 + display_name, reasoning_effort
      --    v17 + fast_mode
      --    v26 + created_by_user_id (NOT NULL, FK RESTRICT),
      --        + avatar_storage_key (nullable), avatar_content_type
      --          (nullable), CHECK pair.
      ALTER TABLE agents RENAME TO agents_legacy_v26;

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
        avatar_content_type TEXT,
        CHECK (
          (avatar_storage_key IS NULL AND avatar_content_type IS NULL)
          OR
          (avatar_storage_key IS NOT NULL AND avatar_content_type IS NOT NULL)
        )
      );

      INSERT INTO agents (
        id, name, runtime, model, host_id, description,
        created_at, updated_at, display_name, reasoning_effort, fast_mode,
        created_by_user_id, avatar_storage_key, avatar_content_type
      )
      SELECT
        id, name, runtime, model, host_id, description,
        created_at, updated_at, display_name, reasoning_effort, fast_mode,
        (SELECT value FROM app_settings WHERE key = 'viewer_user_id'),
        NULL, NULL
      FROM agents_legacy_v26;

      DROP TABLE agents_legacy_v26;

      -- 3. Recreate the six triggers verbatim from v21. Bodies are
      --    identical; the new \`agents\` table satisfies them.
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

      -- 4. Final FK integrity check (mirrors v21). The runner already
      --    re-runs foreign_key_check after every \`foreignKeyEscape\`
      --    migration, but we keep the explicit pattern for clarity and
      --    to abort with a useful error message if anything regresses.
      CREATE TEMP TABLE _v26_fk_check (
        table_name TEXT CHECK (table_name IS NULL),
        rowid      INTEGER,
        parent     TEXT,
        fkid       INTEGER
      );
      INSERT INTO _v26_fk_check SELECT * FROM pragma_foreign_key_check;
      DROP TABLE _v26_fk_check;
    `,
  },
  {
    version: 27,
    name: 'schedule_titles',
    // Split the short UI label (`title`) from the actual wake instruction
    // (`message`). Existing rows are intentionally left with an empty title:
    // this dev DB has one operator, so meaningful historical titles are
    // patched explicitly instead of manufacturing pseudo-titles from message.
    up: `
      ALTER TABLE schedules ADD COLUMN title TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 28,
    name: 'schedule_target_conversation',
    // Decouple where a schedule fires from the implicit "owner's agent_home
    // DM". Every schedule now carries an explicit `target_conversation_id`
    // = the conversation whose `(conversation, owner_agent)` runtime is
    // woken up when the schedule fires; that runtime also produces and
    // posts the result there. This is the "agent as subject" invariant —
    // the session that posts is the one that did the work, so follow-up
    // questions in that conversation can be answered from its own context.
    //
    // Backfill: existing rows preserved their old behavior — fire into
    // owner's agent_home DM. We backfill `target_conversation_id` from
    // `workspaces.dm_channel_id WHERE owner_agent_id = schedules.owner_agent_id`.
    // After this migration the column is the single source of truth and the
    // service no longer reads `workspaces.dm_channel_id` at fire time.
    //
    // No FK: a hard-deleted target conversation should fail loudly at fire
    // time (-> markFailed with `target_conversation_unavailable`) rather
    // than silently CASCADE the schedule away. Application validates at
    // create + at fire.
    up: `
      ALTER TABLE schedules ADD COLUMN target_conversation_id TEXT NOT NULL DEFAULT '';
      UPDATE schedules
         SET target_conversation_id = COALESCE(
           (SELECT c.id
              FROM conversations c
              JOIN workspaces w ON w.id = c.workspace_id
              LEFT JOIN agents owner ON owner.id = w.owner_agent_id
             WHERE w.owner_agent_id = schedules.owner_agent_id
               AND w.workspace_kind = 'agent_home'
               AND c.kind = 'dm_channel'
             ORDER BY CASE
                        WHEN c.title = 'Onboarding' THEN 0
                        WHEN owner.id IS NOT NULL AND c.title = 'dm-' || owner.name THEN 1
                        ELSE 2
                      END,
                      c.created_at ASC
             LIMIT 1),
           ''
         )
       WHERE target_conversation_id = '';
      CREATE INDEX IF NOT EXISTS idx_schedules_target
        ON schedules(target_conversation_id);
    `,
  },
  {
    version: 29,
    name: 'user_auth_credentials',
    // Stage A.1 remote-backend auth foundation. Keep the existing
    // profile identity model intact: `users` remains the profile root,
    // `email` is only the nullable login handle, and password material
    // lives in its own one-to-zero-or-one table.
    up: `
      ALTER TABLE users ADD COLUMN email TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_email_when_set
        ON users(email COLLATE NOCASE)
        WHERE email IS NOT NULL;

      CREATE TABLE IF NOT EXISTS user_password_credentials (
        user_id               TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        password_hash         TEXT NOT NULL,
        password_hash_params  TEXT NOT NULL CHECK (json_valid(password_hash_params)),
        password_updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash     TEXT NOT NULL UNIQUE,
        created_at     INTEGER NOT NULL,
        last_used_at   INTEGER NOT NULL,
        revoked_at     INTEGER,
        user_agent     TEXT,
        ip_first_seen  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
        ON auth_sessions(user_id, revoked_at, last_used_at DESC);
    `,
  },
  {
    version: 30,
    name: 'host_identity_credentials',
    // Stage B.1 remote-backend host identity foundation. Existing
    // registry hosts may be unclaimed until the local claim-or-create
    // route binds them in B.2; credential issuance still requires a
    // user-bound host at the service boundary.
    up: `
      ALTER TABLE hosts ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE hosts ADD COLUMN installation_id TEXT;
      ALTER TABLE hosts ADD COLUMN last_seen_at INTEGER;
      ALTER TABLE hosts ADD COLUMN revoked_at INTEGER;

      CREATE INDEX IF NOT EXISTS idx_hosts_user
        ON hosts(user_id, revoked_at, created_at);

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_hosts_user_installation_when_set
        ON hosts(user_id, installation_id)
        WHERE user_id IS NOT NULL AND installation_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS host_credentials (
        id           TEXT PRIMARY KEY,
        host_id      TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        token_hash   TEXT NOT NULL UNIQUE,
        kind         TEXT NOT NULL CHECK (kind IN ('long_lived', 'bootstrap')),
        expires_at   INTEGER,
        consumed_at  INTEGER,
        revoked_at   INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_host_credentials_host
        ON host_credentials(host_id, kind, revoked_at, expires_at);
    `,
  },
  {
    version: 31,
    name: 'host_installation_unique_active_only',
    // Stage B.4: revoking a local host must not lock the same desktop
    // installation out forever. The B.1 partial-unique index keyed
    // (user_id, installation_id) for any non-null pair, so a revoked
    // row blocked the next claim for the same installation. Switch the
    // partial predicate to active-only — revoked rows are kept for
    // audit history, but a new claim for the same (user, installation)
    // pair mints a fresh active host row. `claimOrCreateLocal` /
    // `getByUserInstallation` filter on `revoked_at IS NULL` to match.
    up: `
      DROP INDEX IF EXISTS uniq_hosts_user_installation_when_set;
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_hosts_user_installation_when_active
        ON hosts(user_id, installation_id)
        WHERE user_id IS NOT NULL
          AND installation_id IS NOT NULL
          AND revoked_at IS NULL;
    `,
  },
  {
    version: 32,
    name: 'conversation_inbox_delivery_in_flight',
    // D2.e: DB inbox remains the only durable delivery queue. In-flight
    // columns are a short lease owned by the current host WS connection so
    // reconnect/replacement can roll rows back to pending instead of relying
    // on a process-local replay queue.
    up: `
      ALTER TABLE conversation_inboxes ADD COLUMN in_flight_owner TEXT;
      ALTER TABLE conversation_inboxes ADD COLUMN in_flight_at INTEGER;
      ALTER TABLE conversation_inboxes ADD COLUMN failed_at INTEGER;
      ALTER TABLE conversation_inboxes ADD COLUMN failed_reason TEXT;

      CREATE INDEX idx_conversation_inbox_replay_pending
        ON conversation_inboxes(conversation_id, agent_id, delivered_at, failed_at, in_flight_owner, id);

      CREATE INDEX idx_conversation_inbox_in_flight_owner
        ON conversation_inboxes(in_flight_owner, delivered_at, failed_at);
    `,
  },
  {
    version: 33,
    name: 'agent_materialization_status',
    // D4.d (additive, server↔daemon formal semantics; see
    // `docs/remote-backend-architecture-notes.md §3.4`): tag the `agents` row
    // with the daemon-side materialization lifecycle so
    // `POST /api/agents` can keep the row reserved across the wire
    // round-trip and so failed/in-progress rows are excluded from
    // default reads.
    //
    // - materialization_status:    enum {pending_materialization, active, failed}.
    //   Existing rows backfill to 'active' — they were written through
    //   the legacy backend-direct-fs path, so the L1 dir already
    //   exists. New rows START in 'pending_materialization' and flip
    //   to 'active' on daemon ack (L3a) or 'failed' on typed error /
    //   timeout (L3b).
    // - materialization_failed_code / materialization_failed_at:
    //   populated only when status='failed'. failed_code mirrors the
    //   wire AgentMaterializeErrorCodeSchema plus server-side codes
    //   (materialize_timeout / host_attach_pending /
    //   dependent_row_insert_failed / backend_crash_during_materialize).
    // - idempotency_key: client-supplied opaque retry key, 1..64
    //   chars, [A-Za-z0-9_-], stored verbatim and unique PER CREATOR
    //   (NOT globally). A globally-unique index would leak the
    //   existence of another user's row through "your key is taken";
    //   per-user scoping preserves HTTP idempotency within each
    //   caller while eliminating that side channel. All lookup paths
    //   MUST filter by (created_by_user_id, idempotency_key) — never
    //   by key alone.
    up: `
      ALTER TABLE agents ADD COLUMN materialization_status TEXT NOT NULL
        DEFAULT 'active'
        CHECK (materialization_status IN (
          'pending_materialization', 'active', 'failed'
        ));
      ALTER TABLE agents ADD COLUMN materialization_failed_code TEXT;
      ALTER TABLE agents ADD COLUMN materialization_failed_at INTEGER;
      ALTER TABLE agents ADD COLUMN idempotency_key TEXT;

      CREATE UNIQUE INDEX idx_agents_idempotency_key_per_user
        ON agents (created_by_user_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    version: 34,
    name: 'task_archive',
    // Task archive is a visibility / organization dimension, not a
    // workflow status. Tasks remain message metadata; `task_archived_at`
    // is scoped to the message's task role rather than to the message
    // itself, so we intentionally avoid a generic `archived_at` column.
    up: `
      ALTER TABLE messages ADD COLUMN task_archived_at INTEGER;

      CREATE INDEX idx_messages_task_workspace_active
        ON messages(task_workspace_id, task_status)
        WHERE task_workspace_id IS NOT NULL
          AND task_archived_at IS NULL;

      CREATE INDEX idx_messages_task_workspace_archived
        ON messages(task_workspace_id, task_archived_at)
        WHERE task_workspace_id IS NOT NULL
          AND task_archived_at IS NOT NULL;
    `,
  },
  {
    version: 35,
    name: 'task_closed_status',
    // Replaces v34's task archive visibility axis with a real workflow
    // terminal status. `task_closed_at` is metadata for ordering/audit;
    // the source of truth is `task_status = 'closed'`.
    up: `
      DROP INDEX IF EXISTS idx_messages_task_workspace_active;
      DROP INDEX IF EXISTS idx_messages_task_workspace_archived;

      ALTER TABLE messages RENAME COLUMN task_archived_at TO task_closed_at;

      UPDATE messages
         SET task_status = 'closed'
       WHERE task_number IS NOT NULL
         AND task_closed_at IS NOT NULL;

      CREATE INDEX idx_messages_task_workspace_closed_at
        ON messages(task_workspace_id, task_closed_at)
        WHERE task_workspace_id IS NOT NULL
          AND task_status = 'closed'
          AND task_closed_at IS NOT NULL;
    `,
  },
  {
    version: 36,
    name: 'host_display_label',
    // ComputerPane / host registry view (#task:808): hosts get a
    // user-facing rename target separate from `name`. `name` stays the
    // stable normalized identifier used by `claimOrCreateLocal` and any
    // future ref resolver; `display_label` carries whatever the user
    // typed (or PATCHed via /api/hosts/:id). Renderer reads
    // `display_label ?? name`. Old rows backfill NULL and fall back to
    // `name` at the render seam — no behavior change for hosts that
    // were claimed before rename existed.
    up: `
      ALTER TABLE hosts ADD COLUMN display_label TEXT;
    `,
  },
  {
    version: 37,
    name: 'saved_messages_user_scope',
    // Saved messages are viewer-private state. Existing rows predate the
    // multi-human model; when a registered legacy viewer exists, preserve
    // their saves under that user, otherwise leave the row unclaimed and
    // invisible to per-user readers.
    up: `
      DROP INDEX IF EXISTS uniq_saved_messages_message;

      ALTER TABLE saved_messages
        ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

      UPDATE saved_messages
         SET user_id = (SELECT value FROM app_settings WHERE key = 'viewer_user_id')
       WHERE user_id IS NULL
         AND EXISTS (
           SELECT 1
             FROM users
            WHERE id = (SELECT value FROM app_settings WHERE key = 'viewer_user_id')
         );

      CREATE UNIQUE INDEX uniq_saved_messages_user_message
        ON saved_messages(user_id, message_id)
        WHERE user_id IS NOT NULL;

      CREATE INDEX idx_saved_messages_user_saved_at
        ON saved_messages(user_id, saved_at DESC)
        WHERE user_id IS NOT NULL;
    `,
  },
  {
    version: 38,
    name: 'drop_global_proxy_settings',
    // Proxy config is daemon-host local truth. The server no longer reads,
    // persists, or forwards proxy URL/runtime allowlist; users set it again
    // from the local Computer detail pane when needed.
    up: `
      DELETE FROM app_settings
       WHERE key IN ('proxy_url', 'proxy_runtimes');
    `,
  },
  {
    version: 39,
    name: 'schedules_fire_failure_metrics',
    // A `cron|interval` schedule whose individual fire fails (transient
    // daemon detach, runtime spawn glitch, target temporarily unhealthy)
    // must NOT terminate the plan. The pre-v39 design routed every wake
    // failure through `markFailed → status='failed'` (terminal), which
    // killed the entire schedule on a single bad fire — observed when
    // the outbound daemon transport was momentarily unattached at a
    // daily cron's tick (`HostRuntimeDisabledError`).
    //
    // v39 adds three columns to track per-fire failure metrics WITHOUT
    // changing the plan's status. The service layer routes `cron|interval`
    // failures here (status returns to `pending` with `next_fire_at`
    // advanced to the natural next tick); `kind:'once'` still uses the
    // legacy `markFailed` (terminal — the plan's only fire is over).
    //
    //   last_failure_reason         most-recent fire's error message
    //   last_failure_at             most-recent fire failure ts (epoch ms)
    //   consecutive_failure_count   resets to 0 on next successful fire
    //
    // No backfill: existing rows already in `status='failed'` stay
    // there. The dev DB has one operator and a hand-applied SQL UPDATE
    // is the recovery path (avoid carrying revival logic in code).
    up: `
      ALTER TABLE schedules ADD COLUMN last_failure_reason TEXT;
      ALTER TABLE schedules ADD COLUMN last_failure_at INTEGER;
      ALTER TABLE schedules ADD COLUMN consecutive_failure_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 40,
    name: 'graded_permissions_human_role_spine',
    // Graded-permissions Layer A (cut 1): the human governance role
    // spine. Replaces the two-valued `canMutateWorkspace` (any human
    // member ≈ admin) with an owner/admin/member role on
    // `workspace_users`, plus a denormalized `workspaces.owner_user_id`
    // pointer. The agent capability axis (`workspace_agent_capabilities`)
    // is a SEPARATE later cut — this migration touches only the human
    // axis. See docs/graded-permissions-v1.md §1.2 / §8 Layer A.
    //
    // Behavior delta: FULLY NEUTRAL on the current install (amendment 3,
    // shiki). The local dogfood DB has exactly one human — that human
    // becomes every workspace's `owner` (owner ⊇ admin ⊇ member), so no
    // capability they have today is stripped. No earliest-joined
    // heuristic and no multi-human backfill branch is needed because
    // there is only one human to assign. The single observable change is
    // that the model becomes expressible: a SECOND human added later
    // joins as `member` (route default), not implicit admin — closing
    // the §0 "any member can archive the workspace" hole.
    //
    // `role` defaults to 'member' for NEW rows (route/trigger writes the
    // creator as 'owner' explicitly). The backfill below promotes the
    // single existing human to 'owner' on every workspace they belong to
    // and stamps `owner_user_id`.
    //
    // Owner resolution is an EXPLICIT single-human resolver, NOT a
    // viewer-only lookup (Cindy review, #task:932). `viewer_user_id` is a
    // legacy app_settings key — register/signup stopped writing it, so a
    // DB registered after its deprecation but upgraded before v40 has a
    // single `users` row and NO `viewer_user_id`. A viewer-only backfill
    // would leave that human a `member` with `owner_user_id` NULL,
    // violating amendment 3. The resolver therefore is:
    //   1. `viewer_user_id` IFF it points at a real `users` row, else
    //   2. the sole `users` row IFF exactly one exists, else
    //   3. NULL — never guess across multiple humans.
    // Every branch degrades to NULL on a pre-registration / multi-human
    // DB, so the UPDATEs match zero rows and the migration is safe on
    // every shape. The COALESCE is duplicated verbatim across the two
    // statements because pure-SQL migrations cannot bind a shared value.
    up: `
      ALTER TABLE workspaces ADD COLUMN owner_user_id TEXT REFERENCES users(id);

      ALTER TABLE workspace_users
        ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'admin', 'member'));

      -- Single local human → owner of every workspace (amendment 3).
      UPDATE workspaces
         SET owner_user_id = COALESCE(
           (SELECT id FROM users
              WHERE id = (SELECT value FROM app_settings WHERE key = 'viewer_user_id')),
           (SELECT id FROM users WHERE (SELECT COUNT(*) FROM users) = 1)
         );

      UPDATE workspace_users
         SET role = 'owner'
       WHERE user_id = COALESCE(
           (SELECT id FROM users
              WHERE id = (SELECT value FROM app_settings WHERE key = 'viewer_user_id')),
           (SELECT id FROM users WHERE (SELECT COUNT(*) FROM users) = 1)
         );
    `,
  },
  {
    version: 41,
    name: 'graded_permissions_agent_capability_spine',
    // Graded-permissions Layer A (cut 2): the agent capability axis. A
    // per-(workspace, agent) effective capability set, stored one row per
    // granted bucket (PRESENCE = GRANTED — no boolean column). This is the
    // SECOND, orthogonal axis to the v40 human role spine; the two never
    // collapse (doc §2 / §6.3 orthogonality test).
    //
    // Behavior delta: FULLY NEUTRAL on every existing install (doc §2.3,
    // amendment). The seed grants the FULL bucket set to every existing
    // `workspace_members` row, so no agent loses any action it can perform
    // today. The only observable change is that the model becomes
    // expressible: capabilities can now be narrowed per agent, and a future
    // route that forgets to gate is caught by the drift test.
    //
    // No-silent-widen discipline (doc §2.3): a FUTURE capability bucket
    // must NOT auto-grant to existing rows via a helper default — it ships
    // its own migration that explicitly decides true/false per row. This
    // seed is that explicit decision for the v41 launch set (full grant).
    //
    // Shape note: the table keys on `agent_id` (not a polymorphic
    // `actor_kind + actor_id`) by design — capabilities are the agent-only
    // axis; humans use `workspace_users.role`, so there is no user variant
    // of this row (architecture-principles §6 justified exception).
    //
    // The composite FK (workspace_id, agent_id) → workspace_members
    // (its PK) with ON DELETE CASCADE makes caps auto-delete when the agent
    // leaves the workspace (no orphan caps, doc §2.4). Purely additive
    // (CREATE TABLE + seed INSERT); foreign_keys stays ON so the seed
    // validates against live `workspace_members` rows — no foreignKeyEscape
    // needed (same as v40's additive ALTER).
    up: `
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

      -- Seed the FULL capability set for every existing membership →
      -- zero behavioral regression (doc §2.3). The PK prefix
      -- (workspace_id, agent_id) also serves per-agent cap lookups, so no
      -- extra index is required.
      INSERT INTO workspace_agent_capabilities (workspace_id, agent_id, capability)
      SELECT m.workspace_id, m.agent_id, c.capability
        FROM workspace_members m
        CROSS JOIN (
          SELECT 'read_messages' AS capability
          UNION ALL SELECT 'send_messages'
          UNION ALL SELECT 'read_tasks'
          UNION ALL SELECT 'create_tasks'
          UNION ALL SELECT 'write_tasks'
          UNION ALL SELECT 'read_attachments'
          UNION ALL SELECT 'upload_attachments'
          UNION ALL SELECT 'create_threads'
          UNION ALL SELECT 'create_channels'
          UNION ALL SELECT 'manage_conversation_members'
          UNION ALL SELECT 'manage_schedules'
        ) c;
    `,
  },
  {
    version: 42,
    name: 'conversation_message_seq_allocator',
    precondition: db => {
      const row = (db as {
        prepare(sql: string): {
          get(): { conversation_id: string; seq: number; count: number } | undefined;
        };
      }).prepare(`
        SELECT conversation_id, seq, COUNT(*) AS count
          FROM messages
         GROUP BY conversation_id, seq
        HAVING COUNT(*) > 1
         LIMIT 1
      `).get();
      if (row) {
        throw new Error(
          'migration v42 cannot add unique conversation message seq: ' +
            `conversation ${row.conversation_id} already has ${row.count} ` +
            `messages with seq ${row.seq}`,
        );
      }
    },
    up: `
      ALTER TABLE conversations
        ADD COLUMN latest_message_seq INTEGER NOT NULL DEFAULT 0;

      UPDATE conversations
         SET latest_message_seq = COALESCE(
           (SELECT MAX(m.seq)
              FROM messages m
             WHERE m.conversation_id = conversations.id),
           0
         );

      CREATE UNIQUE INDEX uniq_messages_conversation_seq
        ON messages(conversation_id, seq);
    `,
  },
];

export const CURRENT_SCHEMA_VERSION =
  migrations[migrations.length - 1]?.version ?? 0;

// D1.d remote-backend V1 startup guard: this is the current `main` baseline at
// the D1 cutover. Older DBs must upgrade through an intermediate release first.
// Brand-new empty databases are still initialized from scratch.
export const MIN_SUPPORTED_SCHEMA_VERSION = 28;
