import { BASELINE_SCHEMA_SQL, BASELINE_SCHEMA_VERSION } from './baseline-schema.js';

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
   *   - asserting a prior bridge has been consumed before a cleanup
   *     migration runs;
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
    version: BASELINE_SCHEMA_VERSION,
    name: 'baseline',
    // Compacted snapshot of historical migrations v1..v44 (#task:1213). The
    // executable DDL is the single authoritative source in baseline-schema.ts
    // (generated, drift-guarded — docs/db-migration-baseline-compaction-v1.md
    // §5.2). Plain CREATE (no IF NOT EXISTS): the floor guard
    // (MIN_SUPPORTED_SCHEMA_VERSION=44 in packages/backend/src/db.ts) guarantees
    // this only ever runs on an empty DB, so it must fail loud if that
    // invariant is ever violated.
    up: BASELINE_SCHEMA_SQL,
  },
  {
    version: 45,
    name: 'users_last_seen_at',
    up: `
      ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
    `,
  },
  {
    version: 46,
    name: 'message_reactions',
    up: `
      -- Message reactions (docs/reactions-design.md §3.1 / §12).
      -- Reactions are an out-of-band projection on a message, NOT messages
      -- themselves: a separate table so they never write a message row, never
      -- allocate a conversation seq, and never advance a stream head — the CAS
      -- exclusion invariant (§12.A). High-frequency, multi-actor, aggregated
      -- data; a metadata-JSON blob would have concurrent-write clobber + no
      -- per-reactor uniqueness, so it gets its own table + unique constraint.
      --
      -- reactor identity is isomorphic (reactor_kind + reactor_id), mirroring
      -- messages.from_* — never a user_id/agent_id column pair
      -- (architecture-principles.md §1 #5). No FK on reactor_id: it softly
      -- references either users(id) or agents(id) by kind.
      CREATE TABLE message_reactions (
        id            TEXT PRIMARY KEY,
        message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        reactor_kind  TEXT NOT NULL CHECK (reactor_kind IN ('user', 'agent')),
        reactor_id    TEXT NOT NULL,
        emoji         TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        UNIQUE (message_id, reactor_kind, reactor_id, emoji)
      );

      CREATE INDEX idx_message_reactions_message
        ON message_reactions(message_id);
    `,
  },
  {
    version: 47,
    name: 'user_list_sort',
    up: `
      -- Per-user (viewer-scoped) list sort state for the workspace rail and
      -- each workspace's channel sidebar (#task:1146 / #task:1147).
      --
      -- This is personal VIEW STATE, not an aggregate field: ordering is
      -- "how THIS viewer arranged the list", so it never lives on the
      -- workspace / conversation aggregate (which would pollute it with
      -- viewer-relative data). It is its own read model with its own tables.
      --
      -- list_key namespaces a list: 'workspaces' (the rail) | 'channels:<ws_id>'
      -- (one workspace's channel sidebar). mode is per-LIST (one [recent|manual]
      -- toggle per list); absence of a row = default 'recent'.
      CREATE TABLE user_list_sort_mode (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        list_key   TEXT NOT NULL,
        mode       TEXT NOT NULL CHECK (mode IN ('recent', 'manual')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, list_key)
      );

      -- Per-entity viewer state within a list: manual rank + recent-opened
      -- timestamp. rank is a SINGLE value per (user, list, entity) — the hard
      -- groups (rail: dm / regular:pinned / regular:unpinned; channel:
      -- pinned / unpinned) are partitioned LIVE at sort time from the entity's
      -- own pin/kind state, NOT baked into a bucket key here. That keeps
      -- pin/unpin from having to migrate ranks across buckets.
      --   rank NULL             = not manually arranged (tails by created_at).
      --   last_accessed_at NULL = never opened by this viewer.
      -- entity_id softly references workspaces(id) OR conversations(id) by
      -- list_key (no FK — polymorphic, mirroring message_reactions.reactor_id);
      -- orphaned rows after a delete are harmless (filtered out when joined
      -- against the live list).
      CREATE TABLE user_sort_entry (
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        list_key         TEXT NOT NULL,
        entity_id        TEXT NOT NULL,
        rank             INTEGER,
        last_accessed_at INTEGER,
        PRIMARY KEY (user_id, list_key, entity_id)
      );

      CREATE INDEX idx_user_sort_entry_lookup
        ON user_sort_entry(user_id, list_key);
    `,
  },
  {
    version: 48,
    name: 'user_list_sort_mode_per_scope',
    up: `
      -- Per-SCOPE sort mode (#task:1146). The workspace rail's sort mode is now
      -- per hard-group (pinned / dm / regular) instead of one per list, so a
      -- "scope" column joins the key. The channel sidebar stays list-wide via
      -- the sentinel scope '' (one mode for the whole list, unchanged).
      --   scope ''                       = list-wide  (channels:<ws_id>)
      --   scope 'pinned'|'dm'|'regular'  = one rail section (workspaces)
      -- SQLite can't add a column to a PRIMARY KEY in place, so rebuild the
      -- table and fold every existing row into the list-wide scope ''. Existing
      -- channel rows are already list-wide (correct). Pre-existing 'workspaces'
      -- rows become a harmless orphan at scope '' — the rail now reads its modes
      -- at the group scopes, so they simply fall back to the default 'recent'
      -- (an accepted reset; the rail's group taxonomy is changing anyway).
      ALTER TABLE user_list_sort_mode RENAME TO user_list_sort_mode_old;
      CREATE TABLE user_list_sort_mode (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        list_key   TEXT NOT NULL,
        scope      TEXT NOT NULL DEFAULT '',
        mode       TEXT NOT NULL CHECK (mode IN ('recent', 'manual')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, list_key, scope)
      );
      INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
        SELECT user_id, list_key, '', mode, updated_at FROM user_list_sort_mode_old;
      DROP TABLE user_list_sort_mode_old;
    `,
  },
  {
    version: 49,
    name: 'conversation_activity_agent_index',
    up: `
      CREATE INDEX IF NOT EXISTS idx_conversation_events_agent
        ON conversation_events(conversation_id, agent_id, id);
    `,
  },
  {
    version: 50,
    name: 'user_sort_entry_starred',
    up: `
      -- Personal ⭐ star (#task:1209). Pin/Star was previously a SHARED aggregate
      -- field on the workspace / conversation (admin-gated, one value for
      -- everyone). It becomes per-VIEWER personal view state: which entities THIS
      -- viewer has starred, living alongside their rank / recent-opened in the
      -- per-(user, list, entity) sort entry. Non-null = starred. It is a PRESENCE
      -- marker (+ timestamp for future/debug), NOT a sort key: within-group order
      -- stays governed by the group's mode (recent → last_accessed_at / manual →
      -- rank), so the STARRED section's sort menu is not silently overridden.
      --
      -- No seed: the old global workspaces.pinned_at / conversations.pinned_at
      -- columns are deliberately NOT migrated into per-user stars (decided by
      -- shiki — few users, a one-time re-star is cheaper than carrying migration
      -- dirty-code as debt). Those columns become vestigial (migrations are
      -- append-only, so they physically remain) and stop being read/written.
      ALTER TABLE user_sort_entry ADD COLUMN starred_at INTEGER;
    `,
  },
  {
    version: 51,
    name: 'conversation_reads_per_stream',
    // Per-stream read cursor (#task:1226). The read boundary was per-CONVERSATION
    // (one cursor for the mainline + every thread together), so thread-level
    // unread could not be expressed (ThreadSummary.unread_count stayed optional
    // and unfilled). This generalizes `conversation_reads` to per-STREAM, exactly
    // mirroring the per-stream `conversation_stream_heads` freshness model: one
    // concept (stream) at one grain on both the read and write sides.
    //
    // thread_root_id NULL = mainline; non-NULL = that reply-cluster. Uniqueness
    // uses the SAME two partial-unique indexes as conversation_stream_heads —
    // SQLite composite PK with a nullable column does not dedupe NULLs reliably,
    // so a PK is wrong here.
    //
    // Table rebuild (SQLite can't drop the old PRIMARY KEY) → foreignKeyEscape so
    // the runner toggles foreign_keys OFF + legacy_alter_table ON and runs
    // foreign_key_check afterward.
    foreignKeyEscape: true,
    up: `
      CREATE TABLE conversation_reads_new (
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        thread_root_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,
        last_read_seq    INTEGER NOT NULL DEFAULT 0,
        read_at          INTEGER NOT NULL
      );

      -- Old per-conversation rows become the MAINLINE cursor (thread_root_id NULL),
      -- value carried over verbatim.
      INSERT INTO conversation_reads_new (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
        SELECT user_id, conversation_id, NULL, last_read_seq, read_at FROM conversation_reads;

      DROP TABLE conversation_reads;
      ALTER TABLE conversation_reads_new RENAME TO conversation_reads;

      CREATE UNIQUE INDEX uniq_conversation_reads_main
        ON conversation_reads(user_id, conversation_id) WHERE thread_root_id IS NULL;
      CREATE UNIQUE INDEX uniq_conversation_reads_thread
        ON conversation_reads(user_id, conversation_id, thread_root_id) WHERE thread_root_id IS NOT NULL;
      CREATE INDEX idx_conversation_reads_conversation
        ON conversation_reads(conversation_id);

      -- Root-invariant guard (mirrors conversation_stream_heads / thread_followers):
      -- thread_root_id REFERENCES messages only proves the message exists, NOT that
      -- it belongs to this conversation or is itself a root (non-reply). Without this
      -- a bad client cursor would silently corrupt unread/first-unread. DB-level
      -- fail-loud backstop; the route layer also pre-validates with friendly 400s.
      CREATE TRIGGER conversation_reads_root_insert
        BEFORE INSERT ON conversation_reads
        WHEN NEW.thread_root_id IS NOT NULL
        BEGIN
          SELECT CASE
            WHEN NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.thread_root_id)
            THEN RAISE(ABORT, 'conversation_reads.thread_root_id must reference an existing message')
          END;
          SELECT CASE
            WHEN COALESCE((SELECT conversation_id FROM messages WHERE id = NEW.thread_root_id), '') != NEW.conversation_id
            THEN RAISE(ABORT, 'conversation_reads root must be in the same conversation')
          END;
          SELECT CASE
            WHEN (SELECT thread_root_id FROM messages WHERE id = NEW.thread_root_id) IS NOT NULL
            THEN RAISE(ABORT, 'conversation_reads root must not itself be a reply')
          END;
        END;

      CREATE TRIGGER conversation_reads_root_update
        BEFORE UPDATE OF thread_root_id, conversation_id ON conversation_reads
        WHEN NEW.thread_root_id IS NOT NULL
        BEGIN
          SELECT CASE
            WHEN NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.thread_root_id)
            THEN RAISE(ABORT, 'conversation_reads.thread_root_id must reference an existing message')
          END;
          SELECT CASE
            WHEN COALESCE((SELECT conversation_id FROM messages WHERE id = NEW.thread_root_id), '') != NEW.conversation_id
            THEN RAISE(ABORT, 'conversation_reads root must be in the same conversation')
          END;
          SELECT CASE
            WHEN (SELECT thread_root_id FROM messages WHERE id = NEW.thread_root_id) IS NOT NULL
            THEN RAISE(ABORT, 'conversation_reads root must not itself be a reply')
          END;
        END;

      -- Eager seed (#task:1226 key decision): every EXISTING thread gets its own
      -- cursor frozen at the user's old mainline value, so the upgrade does not
      -- flood users with historical thread unread, AND the steady-state read model
      -- has ZERO fallback branch (no vestigial baseline column, no dynamic COALESCE
      -- back to the advancing mainline cursor). Bounded one-time INSERT...SELECT.
      INSERT INTO conversation_reads (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
        SELECT cr.user_id, cr.conversation_id, sh.thread_root_id, cr.last_read_seq, cr.read_at
          FROM conversation_reads cr
          JOIN conversation_stream_heads sh
            ON sh.conversation_id = cr.conversation_id
         WHERE cr.thread_root_id IS NULL
           AND sh.thread_root_id IS NOT NULL;
    `,
  },
];

export const CURRENT_SCHEMA_VERSION =
  migrations[migrations.length - 1]?.version ?? 0;

// Baseline compaction floor (#task:1213): historical migrations v1..v44 were
// folded into the single `baseline` snapshot at version 44, so 44 is now the
// lowest version that can upgrade in place. This is a SAFETY invariant, not just
// a support policy — the baseline is a full CREATE, so a non-empty DB below it
// (ledger missing 44) MUST be rejected by the floor guard in
// packages/backend/src/db.ts rather than have the baseline rebuild existing
// tables. A pre-baseline DB must first upgrade through an intermediate release.
// Brand-new empty databases are still initialized from scratch (isEmpty bypass).
export const MIN_SUPPORTED_SCHEMA_VERSION = 44;
