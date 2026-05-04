export interface Migration {
  version: number;
  name: string;
  up: string;
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
];
