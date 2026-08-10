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
    // and is pinned by the two-stage migration-baseline drift guard. Plain
    // CREATE (no IF NOT EXISTS): the floor guard
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
      -- Message reactions (docs/reactions-design.md §3.1 / §4).
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
  {
    version: 52,
    name: 'channel_attention_preferences',
    // Activity / Attention bounded context (#task:1227, docs/activity-lifecycle-v1.md
    // §9.1). The FIRST write-side aggregate Attention owns: a per-(viewer,
    // channel) ambient preference — the policy input to `enter()` (§6). It is a
    // user DECISION (the channel `所有消息 / 仅提及` control), not a derived fact,
    // so it legitimately gets its own table (建表准入测试, §4.2). Everything else
    // Attention surfaces is a projection (cursor read-model / notifications /
    // tasks), never stored. (v65 adds the SECOND and — today — last one, the
    // per-(viewer, workspace) mute suppressor, and a third `mode` value `'mute'`;
    // the shape below is v52's, kept verbatim as history.)
    //
    // `mode`:
    //   'all'      = ambient on  → channel mainline ambient unread enters Activity
    //   'mentions' = ambient off → ambient unread stays as in-place hint only;
    //                directed (@me / task / DM) still enters, unconditionally (§6).
    // Absence of a row = the default (`'all'`, ambient on — §6 channel
    // default). The table stores the viewer's explicit choice (which MAY equal
    // the default — we do not delete-on-default); reads resolve absence to the
    // default. Scope is REGULAR channel only: a DM's unread is directed-grade
    // (always enters, §5.1) and a thread's ambient is follow-driven delivery, so
    // neither carries this preference. The route gates with getChannel (kind =
    // 'channel'); the triggers below are the DB fail-loud backstop so no
    // repo/test can write a pref for a dm_channel or thread out from under the
    // route.
    //
    // delivery ⊥ attention (§5.2): this never touches thread_followers/wake.
    up: `
      CREATE TABLE channel_attention_preferences (
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        mode             TEXT NOT NULL CHECK (mode IN ('all', 'mentions')),
        updated_at       INTEGER NOT NULL,
        PRIMARY KEY (user_id, conversation_id)
      );

      CREATE INDEX idx_channel_attention_prefs_conversation
        ON channel_attention_preferences(conversation_id);

      -- Regular-channel-only invariant (DB backstop; route pre-validates with a
      -- friendly 404). A pref on a dm_channel/thread is meaningless dead state
      -- and would leave ②c's enter() ambiguous — fail loud instead.
      CREATE TRIGGER channel_attention_prefs_channel_only_insert
        BEFORE INSERT ON channel_attention_preferences
        BEGIN
          SELECT CASE
            WHEN COALESCE(
              (SELECT kind FROM conversations WHERE id = NEW.conversation_id), ''
            ) != 'channel'
            THEN RAISE(ABORT, 'channel_attention_preferences.conversation_id must reference a regular channel')
          END;
        END;

      CREATE TRIGGER channel_attention_prefs_channel_only_update
        BEFORE UPDATE OF conversation_id ON channel_attention_preferences
        BEGIN
          SELECT CASE
            WHEN COALESCE(
              (SELECT kind FROM conversations WHERE id = NEW.conversation_id), ''
            ) != 'channel'
            THEN RAISE(ABORT, 'channel_attention_preferences.conversation_id must reference a regular channel')
          END;
        END;
    `,
  },
  {
    version: 53,
    name: 'retire_thread_conversation_kind',
    // #task:1303 (2c) — retire the legacy `conversations.kind='thread'` fossil
    // (isolated thread conversations, "Sense1"). Its producer was removed
    // 2026-06-11; the reply-cluster model (messages.thread_root_id, "Sense2")
    // is now the sole meaning of "thread" in the domain. Phase-1 of #task:1303
    // hard-deleted every fossil row from the live DBs (the legacy-thread purge
    // device); this migration tightens the schema so no new fossil row can ever
    // be written, closing the fossil out of the ubiquitous language for good.
    //
    // SQLite cannot ALTER a CHECK constraint, so narrowing the column CHECK
    // `kind IN ('channel','dm_channel','thread')` → `('channel','dm_channel')`
    // and dropping the `thread` branch of the table-level parent CHECK requires
    // a full table rebuild. foreignKeyEscape: the runner toggles foreign_keys
    // OFF + legacy_alter_table ON around it (conversations has a self-FK via
    // parent_conversation_id and is referenced by nearly every table) and runs
    // foreign_key_check afterward.
    //
    // parent_conversation_id is KEPT (now provably always NULL under the tight
    // CHECK) along with idx_conversations_parent — dropping the column is out of
    // scope for this cut. DROP TABLE auto-drops the old
    // conversations_thread_parent_{insert,update} triggers; they are NOT
    // recreated (nothing left to guard once 'thread' cannot exist).
    foreignKeyEscape: true,
    // Fail-loud backstop: safe only on a DB whose fossil rows were already
    // purged (Phase-1). If any kind='thread' row — or any non-NULL
    // parent_conversation_id — survives, the INSERT...SELECT below would trip
    // the new CHECK with an opaque SQLite error. Abort first with a
    // developer-readable message; the throw rolls back the transaction so no
    // _migrations row is written and the upgrade is retried next boot (after
    // the operator runs the purge device).
    precondition: (db) => {
      const handle = db as {
        prepare: (sql: string) => { get: () => { n: number } };
      };
      const { n } = handle
        .prepare(
          `SELECT COUNT(*) AS n FROM conversations
             WHERE kind = 'thread' OR parent_conversation_id IS NOT NULL`,
        )
        .get();
      if (n > 0) {
        throw new Error(
          `migration v53: refusing to tighten the conversations CHECK — ${n} legacy thread fossil row(s) remain ` +
            `(kind='thread' or parent_conversation_id NOT NULL). Run the legacy-thread purge before upgrading.`,
        );
      }
    },
    up: `
      CREATE TABLE conversations_new (
        id                      TEXT PRIMARY KEY,
        workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        workspace_path          TEXT NOT NULL,
        kind                    TEXT NOT NULL CHECK (kind IN ('channel', 'dm_channel')),
        parent_conversation_id  TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        title                   TEXT NOT NULL,
        status                  TEXT NOT NULL,
        spawned_by_agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
        closed_at               INTEGER,
        close_summary           TEXT,
        pinned_at               INTEGER,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        archived_at             INTEGER,
        latest_message_seq      INTEGER NOT NULL DEFAULT 0,
        CHECK (
          (kind = 'channel' AND parent_conversation_id IS NULL)
          OR
          (kind = 'dm_channel' AND parent_conversation_id IS NULL)
        )
      );

      INSERT INTO conversations_new (
        id, workspace_id, workspace_path, kind, parent_conversation_id, title,
        status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
        created_at, updated_at, archived_at, latest_message_seq
      )
        SELECT
          id, workspace_id, workspace_path, kind, parent_conversation_id, title,
          status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
          created_at, updated_at, archived_at, latest_message_seq
        FROM conversations;

      DROP TABLE conversations;
      ALTER TABLE conversations_new RENAME TO conversations;

      -- Rebuild every conversations index verbatim (DROP TABLE took them out).
      CREATE INDEX idx_conversations_workspace
        ON conversations(workspace_id, kind, updated_at DESC);
      CREATE INDEX idx_conversations_parent
        ON conversations(parent_conversation_id, created_at ASC);
      CREATE INDEX idx_conversations_status
        ON conversations(status);
      CREATE INDEX idx_conversations_archived_at
        ON conversations(workspace_id) WHERE archived_at IS NOT NULL;
    `,
  },
  {
    version: 54,
    name: 'drop_conversation_parent_column',
    // #task:1305 — the legacy isolated-thread conversation model is gone from
    // data, schema, DTOs, and runtime code. v53 kept parent_conversation_id as
    // an always-NULL physical column so the kind discriminator cleanup could
    // land independently; this migration removes that last storage fossil.
    //
    // SQLite table rebuild is the least ambiguous shape here: it drops the
    // column, drops idx_conversations_parent, and preserves every surviving
    // conversations column/index explicitly.
    foreignKeyEscape: true,
    precondition: (db) => {
      const handle = db as {
        prepare: (sql: string) => { get: () => { n: number } };
      };
      const { n } = handle
        .prepare(
          `SELECT COUNT(*) AS n FROM conversations
             WHERE parent_conversation_id IS NOT NULL`,
        )
        .get();
      if (n > 0) {
        throw new Error(
          `migration v54: refusing to drop conversations.parent_conversation_id — ${n} row(s) still reference a parent conversation`,
        );
      }
    },
    up: `
      CREATE TABLE conversations_new (
        id                      TEXT PRIMARY KEY,
        workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        workspace_path          TEXT NOT NULL,
        kind                    TEXT NOT NULL CHECK (kind IN ('channel', 'dm_channel')),
        title                   TEXT NOT NULL,
        status                  TEXT NOT NULL,
        spawned_by_agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
        closed_at               INTEGER,
        close_summary           TEXT,
        pinned_at               INTEGER,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        archived_at             INTEGER,
        latest_message_seq      INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO conversations_new (
        id, workspace_id, workspace_path, kind, title, status,
        spawned_by_agent_id, closed_at, close_summary, pinned_at,
        created_at, updated_at, archived_at, latest_message_seq
      )
        SELECT
          id, workspace_id, workspace_path, kind, title, status,
          spawned_by_agent_id, closed_at, close_summary, pinned_at,
          created_at, updated_at, archived_at, latest_message_seq
        FROM conversations;

      DROP TABLE conversations;
      ALTER TABLE conversations_new RENAME TO conversations;

      CREATE INDEX idx_conversations_workspace
        ON conversations(workspace_id, kind, updated_at DESC);
      CREATE INDEX idx_conversations_status
        ON conversations(status);
      CREATE INDEX idx_conversations_archived_at
        ON conversations(workspace_id) WHERE archived_at IS NOT NULL;
    `,
  },
  {
    version: 55,
    name: 'host_activation_and_provisioning_source',
    up: `
      -- User-managed computers split host lifecycle from provisioning source:
      -- activated_at is the readiness marker (NULL = pending attach),
      -- while provisioning_source is lifecycle metadata only. Runtime
      -- placement/ACL must compose owner scope with activated/not-revoked and
      -- never branch on provisioning_source.
      ALTER TABLE hosts ADD COLUMN activated_at INTEGER;
      ALTER TABLE hosts ADD COLUMN provisioning_source TEXT NOT NULL DEFAULT 'system'
        CHECK (provisioning_source IN ('app_install', 'user_invite', 'system'));

      -- Existing desktop-claimed installs are app-managed. Unclaimed bootstrap
      -- placeholders and standalone/system rows intentionally remain system.
      UPDATE hosts
         SET provisioning_source = 'app_install'
       WHERE user_id IS NOT NULL
         AND installation_id IS NOT NULL;

      -- Existing active user-owned local hosts predate the pending lifecycle;
      -- treat them as activated so current desktop placement continues to work.
      -- Revoked rows and unowned/system placeholders stay NULL.
      UPDATE hosts
         SET activated_at = COALESCE(last_seen_at, created_at)
       WHERE user_id IS NOT NULL
         AND kind = 'local'
         AND revoked_at IS NULL;
    `,
  },
  {
    version: 56,
    name: 'host_finalization_lifecycle',
    up: `
      -- User-invited computers are setup drafts until the user confirms the
      -- Add computer modal. activated_at only proves daemon attachment;
      -- finalized_at is the boundary for host list / placement eligibility.
      ALTER TABLE hosts ADD COLUMN finalized_at INTEGER;

      -- Existing app-managed active hosts predate the finalize boundary and
      -- are already formal computers. User-invite rows are left NULL so any
      -- in-flight setup remains modal-scoped until explicit finalization.
      UPDATE hosts
         SET finalized_at = activated_at
       WHERE activated_at IS NOT NULL
         AND revoked_at IS NULL
         AND provisioning_source != 'user_invite';
    `,
  },
  {
    version: 57,
    name: 'agent_runtime_transition_lock',
    up: `
      -- Runtime switching is a multi-step transition: block new spawn/delivery,
      -- clear every old-runtime session, then atomically install the target
      -- runtime and tuning. The persisted lock survives a process crash; boot
      -- safely rolls it back because agents.runtime is unchanged until commit.
      ALTER TABLE agents ADD COLUMN runtime_transition_started_at INTEGER;
      ALTER TABLE agents ADD COLUMN runtime_transition_target TEXT
        CHECK (
          (runtime_transition_target IS NULL AND runtime_transition_started_at IS NULL)
          OR
          (runtime_transition_target IN ('claude','codex','cursor','gemini','qoder','opencode')
           AND runtime_transition_started_at IS NOT NULL)
        );

      -- SQLite may skip a column-level CHECK when an UPDATE touches only the
      -- sibling column. Pair triggers make the two-column invariant explicit
      -- for every insert and either-column update.
      CREATE TRIGGER agents_runtime_transition_pair_insert
        BEFORE INSERT ON agents
        WHEN (NEW.runtime_transition_target IS NULL) !=
             (NEW.runtime_transition_started_at IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'agents runtime transition lock must be a pair');
        END;

      CREATE TRIGGER agents_runtime_transition_pair_update
        BEFORE UPDATE OF runtime_transition_target, runtime_transition_started_at ON agents
        WHEN (NEW.runtime_transition_target IS NULL) !=
             (NEW.runtime_transition_started_at IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'agents runtime transition lock must be a pair');
        END;
    `,
  },
  {
    version: 58,
    name: 'conversation_visibility',
    up: `
      -- public/private channel visibility. ADDITIVE: every
      -- existing conversation is explicitly backfilled 'private' by the DEFAULT
      -- so there is NO "missing = private" long-term compat branch — the column
      -- is the single source of truth from day one. visibility is only
      -- meaningful for regular channels; a 'dm_channel' (and any future
      -- non-channel kind) is private by construction. public read is gated on
      -- kind='channel' in the permission layer, so this pairing is a
      -- security-relevant invariant, not cosmetic.
      --
      -- A single cross-column CHECK is the whole enforcement. SQLite re-validates
      -- every CHECK on the row for ANY INSERT or UPDATE, including an UPDATE that
      -- touches only the sibling 'kind' column — so demoting a public channel's
      -- kind out from under the pairing aborts on the CHECK alone. (Verified: a
      -- same-shape table with only this CHECK and no trigger rejects
      -- UPDATE...SET kind='dm_channel' on a (channel, public) row with a
      -- "CHECK constraint failed" error.) No BEFORE trigger is needed; adding one
      -- would be permanently redundant. Mirrors the v57 runtime-transition
      -- ADD COLUMN + cross-column CHECK pattern.
      ALTER TABLE conversations ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (
          visibility IN ('private', 'public')
          AND (visibility = 'private' OR kind = 'channel')
        );
    `,
  },
  {
    version: 59,
    name: 'task_edit_source_provenance',
    up: `
      -- Task block-1 redesign. A task keeps being a messages row with task_*
      -- columns; this migration makes its DEFINITION explicitly editable
      -- (title + content via \`task edit\`) with optimistic concurrency and
      -- last-editor attribution, and adds an immutable source-message
      -- provenance link that doubles as a creation mutex.

      -- Immutable provenance: the message that TRIGGERED this task. NULL for a
      -- self-authored task with no originating message. It is NOT a content
      -- source — title/content are the task's own definition; this is pure
      -- provenance + the lock key below.
      ALTER TABLE messages ADD COLUMN source_message_id TEXT;

      -- Optimistic-concurrency token for \`task edit\` (title/content). Bumped
      -- ONLY on an edit, so a concurrent status/assignee change never
      -- spuriously conflicts a title/content edit. NULL for non-task rows.
      ALTER TABLE messages ADD COLUMN task_revision INTEGER;

      -- Last-editor attribution for the "edited by X · <time>" byline. Set
      -- ONLY on \`task edit\` (never on status/assignee), so it names who last
      -- shaped the definition. NULL until the first edit.
      ALTER TABLE messages ADD COLUMN task_last_editor_kind TEXT
        CHECK (task_last_editor_kind IS NULL OR task_last_editor_kind IN ('agent', 'user'));
      ALTER TABLE messages ADD COLUMN task_last_editor_id TEXT;
      ALTER TABLE messages ADD COLUMN task_last_edited_at INTEGER;

      -- Every existing task starts at revision 0 (concrete, never NULL for a
      -- task row) so the edit path has no "NULL means 0" compat branch.
      UPDATE messages SET task_revision = 0 WHERE task_number IS NOT NULL;

      -- Creation mutex + permanent provenance identity: at most ONE task per
      -- source message, FOR THE LIFETIME OF THAT MESSAGE. source_message_id
      -- is a permanent identity key, not a lock held only while the task is
      -- active: once a message has spawned a task, it can never spawn another,
      -- regardless of that task's status. A closed or done task does NOT
      -- release its source — to continue the work you reopen the original
      -- task, you never build a second from the same message. A second create
      -- from the same source hits this unique index and the service maps it to
      -- a typed conflict pointing at the existing task (whatever its status).
      -- NULLs repeat freely in a SQLite unique index, so sourceless tasks and
      -- all non-task rows (source_message_id IS NULL) are unconstrained; the
      -- partial predicate just keeps those NULL rows out of the index.
      CREATE UNIQUE INDEX idx_messages_source_message_id
        ON messages(source_message_id)
        WHERE source_message_id IS NOT NULL;
    `,
  },
  {
    version: 60,
    name: 'tasks_first_class_aggregate',
    up: `
      -- Task-system model redesign. A task becomes a FIRST-CLASS aggregate with
      -- its own table — it is no longer a \`messages\` row carrying task_*
      -- annotations. \`id\` is the identity everywhere (REST/events/mutations);
      -- \`task_number\` is the per-workspace human/CLI resolver.
      --
      -- source_message_id / created_event_message_id are RAW ids (NO foreign
      -- key): a declared source is permanent provenance + the nav discriminant,
      -- so it must survive deletion of the referenced message (navigation then
      -- resolves to 'unavailable') rather than be silently nulled by ON DELETE
      -- SET NULL and reclassify the task to "no source". creator_* are likewise
      -- RAW immutable provenance (the CHECK requires the id present, so a
      -- cascade-null would break it). Only workspace/conversation/assignee are
      -- real FK relationships.
      CREATE TABLE tasks (
        id                       TEXT PRIMARY KEY,
        workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task_number              INTEGER NOT NULL,
        conversation_id          TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        thread_root_id           TEXT,
        title                    TEXT NOT NULL,
        content                  TEXT NOT NULL DEFAULT '',
        status                   TEXT NOT NULL,
        assignee_agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
        assignee_user_id         TEXT REFERENCES users(id)  ON DELETE SET NULL,
        creator_kind             TEXT NOT NULL,
        creator_agent_id         TEXT,
        creator_user_id          TEXT,
        source_message_id        TEXT,
        created_event_message_id TEXT,
        last_editor_kind         TEXT,
        last_editor_id           TEXT,
        last_edited_at           INTEGER,
        created_at               INTEGER NOT NULL,
        closed_at                INTEGER,
        CHECK (status IN ('todo', 'in_progress', 'in_review', 'done', 'closed')),
        CHECK (task_number > 0),
        -- At most one assignee (agent XOR user, or neither = unassigned).
        CHECK (assignee_agent_id IS NULL OR assignee_user_id IS NULL),
        -- Creator kind pairs EXACTLY with its id column (immutable provenance).
        -- 'system' = both ids null: a task whose creating agent/user was since
        -- deleted (from_agent_id/from_user_id are ON DELETE SET NULL — a
        -- supported product path), degraded exactly as the old store did.
        CHECK (
          (creator_kind = 'agent'  AND creator_agent_id IS NOT NULL AND creator_user_id IS NULL) OR
          (creator_kind = 'user'   AND creator_user_id  IS NOT NULL AND creator_agent_id IS NULL) OR
          (creator_kind = 'system' AND creator_agent_id IS NULL     AND creator_user_id  IS NULL)
        ),
        -- Last-editor is all-null (never edited) or a COMPLETE triple, so the
        -- "edited by X · <time>" byline can always be fully rendered.
        CHECK (
          (last_editor_kind IS NULL AND last_editor_id IS NULL AND last_edited_at IS NULL) OR
          (last_editor_kind IN ('agent', 'user') AND last_editor_id IS NOT NULL AND last_edited_at IS NOT NULL)
        ),
        -- closed_at is set IFF the task is in the terminal 'closed' status
        -- (mirrors the service: 'done' does NOT set closed_at).
        CHECK ((status = 'closed') = (closed_at IS NOT NULL))
      );

      -- Per-workspace monotonic numbering (replaces the old
      -- uniq_messages_task_workspace_number invariant).
      CREATE UNIQUE INDEX uniq_tasks_workspace_number ON tasks(workspace_id, task_number);
      -- Permanent 1:1 source→task mutex (moves off messages).
      CREATE UNIQUE INDEX uniq_tasks_source_message ON tasks(source_message_id)
        WHERE source_message_id IS NOT NULL;
      -- Board queries.
      CREATE INDEX idx_tasks_workspace_status ON tasks(workspace_id, status);
      CREATE INDEX idx_tasks_conversation ON tasks(conversation_id);

      -- ── Backfill from the retired "message IS task" rows ────────────────
      -- Migrated tasks REUSE their old anchor message id as tasks.id (that id
      -- WAS the task identity), so every historical reference — including
      -- task system-event metadata.task_message_id — carries forward unchanged.
      -- We copy ONLY the explicit source_message_id column (never guess the
      -- anchor's own id as a source). created_event_message_id is derived ONLY
      -- from the deterministic task_create system event; missing → NULL →
      -- navigation resolves to 'unavailable'. No message rows are deleted.
      INSERT INTO tasks (
        id, workspace_id, task_number, conversation_id, thread_root_id,
        title, content, status, assignee_agent_id, assignee_user_id,
        creator_kind, creator_agent_id, creator_user_id,
        source_message_id, created_event_message_id,
        last_editor_kind, last_editor_id, last_edited_at,
        created_at, closed_at
      )
      SELECT
        m.id,
        COALESCE(m.task_workspace_id, (SELECT c.workspace_id FROM conversations c WHERE c.id = m.conversation_id)),
        m.task_number,
        m.conversation_id,
        m.thread_root_id,
        COALESCE(
          NULLIF(TRIM(m.task_title), ''),
          NULLIF(TRIM(CASE WHEN instr(m.content, char(10)) > 0
                           THEN substr(m.content, 1, instr(m.content, char(10)) - 1)
                           ELSE m.content END), ''),
          '(untitled task)'
        ),
        m.content,
        m.task_status,
        m.task_assignee_agent_id,
        m.task_assignee_user_id,
        -- Creator degrades to 'system' when neither author id survives (the
        -- creating agent/user was deleted — a supported lifecycle), matching
        -- the creator-pairing CHECK and the old store's missing-actor handling.
        CASE WHEN m.from_user_id  IS NOT NULL THEN 'user'
             WHEN m.from_agent_id IS NOT NULL THEN 'agent'
             ELSE 'system' END,
        CASE WHEN m.from_user_id IS NULL THEN m.from_agent_id ELSE NULL END,
        m.from_user_id,
        m.source_message_id,
        (SELECT sm.id FROM messages sm
           WHERE json_extract(sm.metadata, '$.subtype') = 'task_create'
             AND json_extract(sm.metadata, '$.task_message_id') = m.id
           ORDER BY sm.seq, sm.id
           LIMIT 1),
        m.task_last_editor_kind,
        m.task_last_editor_id,
        m.task_last_edited_at,
        m.created_at,
        CASE WHEN m.task_status = 'closed' THEN m.task_closed_at ELSE NULL END
      FROM messages m
      WHERE m.task_number IS NOT NULL;

      -- Add the canonical task_id to existing task system-event metadata. For a
      -- migrated task, tasks.id == the old anchor id == metadata.task_message_id,
      -- so this is a deterministic copy. Legacy partial rows (no task_message_id)
      -- are left untouched and keep rendering via the partial reader.
      UPDATE messages
        SET metadata = json_set(metadata, '$.task_id', json_extract(metadata, '$.task_message_id'))
        WHERE json_extract(metadata, '$.subtype') IN
                ('task_create', 'task_claim', 'task_unclaim', 'task_status')
          AND json_extract(metadata, '$.task_message_id') IS NOT NULL;
    `,
  },
  {
    version: 61,
    name: 'workspace_cascade_child_fk_indexes',
    // #task:1677 — deleting a workspace is ONE row delete that fans out
    // through FK actions (CASCADE / SET NULL). For every parent row the
    // cascade touches, SQLite runs an internal `child_col = ?` lookup on
    // each referencing child table; a child column with no leftmost-prefix
    // index makes that lookup a FULL TABLE SCAN, so a small workspace's
    // delete is amplified by GLOBAL table sizes (measured on production
    // data: 14.3s for 2 conversations / 156 messages; 9.9ms once indexed —
    // #task:1674). This migration indexes every child key on the
    // workspace-delete cascade tree that lacked leftmost coverage; child
    // keys reachable only via other delete paths (agent/user deletes) are
    // deliberately NOT included here.
    //
    // Per-message amplifiers (scanned once per deleted message):
    //   - messages.thread_root_id       (self-FK; existing idx starts with
    //                                    conversation_id — unusable for the
    //                                    bare `thread_root_id = ?` FK probe)
    //   - conversation_inboxes.message_id (only 3rd position in the unique)
    //   - notifications.message_id / source_message_id (SET NULL)
    //   - saved_messages.message_id     (only 2nd position in the unique)
    //   - conversation_reads.thread_root_id / conversation_stream_heads.
    //     thread_root_id (only non-leftmost positions in partial uniques)
    // Per-conversation amplifiers (scanned once per deleted conversation):
    //   - conversation_stream_heads.conversation_id (covered ONLY by two
    //     partial uniques whose predicates a bare FK probe does not imply)
    //   - thread_followers.conversation_id (only 1st col of PK is
    //     thread_root_id; conversation_id uncovered)
    //   - saved_messages.conversation_id
    // Per-workspace amplifiers (scanned once per deleted workspace):
    //   - notifications.workspace_id (CASCADE) / source_workspace_id (SET NULL)
    //
    // Full (non-partial) indexes throughout: FK enforcement probes are
    // internal statements — coverage must not depend on partial-index
    // predicate implication.
    up: `
      CREATE INDEX idx_messages_thread_root_id
        ON messages(thread_root_id);
      CREATE INDEX idx_conversation_inboxes_message
        ON conversation_inboxes(message_id);
      CREATE INDEX idx_notifications_workspace
        ON notifications(workspace_id);
      CREATE INDEX idx_notifications_source_workspace
        ON notifications(source_workspace_id);
      CREATE INDEX idx_notifications_message
        ON notifications(message_id);
      CREATE INDEX idx_notifications_source_message
        ON notifications(source_message_id);
      CREATE INDEX idx_saved_messages_conversation
        ON saved_messages(conversation_id);
      CREATE INDEX idx_saved_messages_message
        ON saved_messages(message_id);
      CREATE INDEX idx_conversation_reads_thread_root
        ON conversation_reads(thread_root_id);
      CREATE INDEX idx_conversation_stream_heads_conversation
        ON conversation_stream_heads(conversation_id);
      CREATE INDEX idx_conversation_stream_heads_thread_root
        ON conversation_stream_heads(thread_root_id);
      CREATE INDEX idx_thread_followers_conversation
        ON thread_followers(conversation_id);
    `,
  },
  {
    version: 62,
    name: 'attachment_content_revision',
    up: `
      -- Attachment update capability (#task:1767, docs/attachments-design.md).
      -- An attachment id is now a STABLE reference whose bytes the creator may
      -- replace in place; it no longer promises id→bytes永久不变. content_revision
      -- is a monotonic freshness/cache-bust token (NOT a version system — no
      -- history is retained, no rollback): it advances on every successful
      -- content replace so a renderer can key its blob cache / inflight fetch on
      -- (id, revision) and an \`attachment_changed\` event can bump the client's
      -- generation. It is NOT an HTTP validator (serve is \`no-store\`) and it is
      -- NOT carried in a message's attachment snapshot (the snapshot stays a
      -- point-in-time {id,filename,size,content_type}; live authority is the DTO).
      -- Every existing row starts at 1 via the DEFAULT so there is no
      -- "missing = 1" compat branch — the column is authoritative from day one.
      ALTER TABLE attachments ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 63,
    name: 'message_author_snapshot',
    up: `
      -- #task:1791 — messages.from_agent_id / from_user_id are ON DELETE SET
      -- NULL, so hard-deleting an actor wipes the id the renderer joins on and
      -- every historical message by that actor degrades to a generic "@agent".
      -- These columns are a SEND-TIME author snapshot that OUTLIVES the actor:
      --
      --   author_id            — the authoring actor's id, WITH NO FOREIGN KEY.
      --                          It must NOT be nulled when the actor row is
      --                          deleted; it is the stable, non-collapsing
      --                          aggregation key that lets the server render an
      --                          identifiable, explicitly-"deleted" byline
      --                          instead of a generic one.
      --   author_name          — the actor's @handle at send time.
      --   author_display_name  — the actor's display name at send time.
      --
      -- No avatar bytes are snapshotted (a deleted author renders a neutral
      -- avatar). Server resolution (MessageAuthorDto):
      --   from_*_id NOT NULL            -> 'active'     (FK intact ⇔ actor lives;
      --                                                  read CURRENT name/avatar)
      --   from_*_id NULL + author_id     -> 'deleted'   (snapshot names it)
      --   from_*_id NULL + no author_id  -> 'unresolved'(legacy row whose actor
      --                                                  was deleted before this
      --                                                  snapshot existed; never
      --                                                  guessed as 'deleted')
      ALTER TABLE messages ADD COLUMN author_id           TEXT;
      ALTER TABLE messages ADD COLUMN author_name         TEXT;
      ALTER TABLE messages ADD COLUMN author_display_name TEXT;

      -- Backfill still-resolvable history from the live authority so a message
      -- whose actor still exists gets a snapshot now (and flips from 'active' to
      -- 'deleted' cleanly if that actor is later deleted). NOTE the fidelity
      -- boundary: for messages sent from v63 onward the snapshot is captured at
      -- SEND time (the actor's identity at the moment the row was written); this
      -- one-time backfill instead captures each surviving actor's CURRENT identity
      -- at MIGRATION time — a best-effort reconstruction, since no send-time value
      -- was ever recorded for pre-v63 rows. Rows whose actor was ALREADY
      -- hard-deleted have from_*_id = NULL and nothing to copy from → author_id
      -- stays NULL → 'unresolved' (we cannot fabricate an identity that was never
      -- captured). System rows keep all three NULL. agents.name / users.name /
      -- display_name are all NOT NULL, so a matched actor always yields non-null
      -- author_name / author_display_name.
      UPDATE messages
        SET author_id           = from_agent_id,
            author_name         = (SELECT a.name         FROM agents a WHERE a.id = messages.from_agent_id),
            author_display_name = (SELECT a.display_name FROM agents a WHERE a.id = messages.from_agent_id)
        WHERE from_kind = 'agent' AND from_agent_id IS NOT NULL;

      UPDATE messages
        SET author_id           = from_user_id,
            author_name         = (SELECT u.name         FROM users u WHERE u.id = messages.from_user_id),
            author_display_name = (SELECT u.display_name FROM users u WHERE u.id = messages.from_user_id)
        WHERE from_kind = 'user' AND from_user_id IS NOT NULL;
    `,
  },
  {
    version: 64,
    name: 'drop_workspace_local_binding_columns',
    // relocation-v1 §6/§7 (#task:1807 + #task:1808) — retire BOTH columns that
    // encoded a workspace's host-local binding: `workspace_path` (the legacy
    // filesystem path, denormalized onto every conversation) and
    // `workspaces.workspace_host_id` (the owning-host pointer). A regular
    // workspace no longer owns a working directory OR a home host: its bundle
    // resolves to a TERMINAL deterministic agent-centric coordinate
    // (`<agent home>/workspaces/<workspace_id>`), computed the same way on every
    // host. There is no DB column — and no registry lookup — the backend
    // consults to derive a path or an owning host (invariant I1). Per §6 the two
    // are ONE removal set landing in ONE release tree under ONE triple bump, so
    // they retire in a SINGLE `workspaces` rebuild — never a v64(path)+v65(host)
    // pair that rebuilds the parent twice and leaves an intermediate schema that
    // was never a legal release.
    //
    // This migration is UNPUBLISHED — both drops were forward-fixed IN PLACE
    // across #task:1807 (`workspace_path`) and #task:1808 (`workspace_host_id`)
    // into this one rebuild; history was never amended and no sibling migration
    // was appended. Any such staging marker stays in THIS comment, never inside
    // the DDL string: a comment inside a CREATE TABLE is preserved verbatim in
    // `sqlite_master.sql` and would corrupt the schema fingerprint.
    //
    // Two SQLite table rebuilds (the columns are NOT NULL and can't be dropped
    // in place; template = v54 `drop_conversation_parent_column`): the child
    // `conversations` is rebuilt first, then the parent `workspaces`. With
    // `foreignKeyEscape` the runner disables `foreign_keys` around the whole
    // migration and runs `foreign_key_check` afterward, so dropping the parent
    // never cascade-deletes children and every surviving FK is re-validated.
    // No precondition: we are discarding populated columns, not asserting
    // emptiness. Every surviving column, constraint, and index is reproduced
    // explicitly.
    foreignKeyEscape: true,
    up: `
      CREATE TABLE conversations_new (
        id                      TEXT PRIMARY KEY,
        workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind                    TEXT NOT NULL CHECK (kind IN ('channel', 'dm_channel')),
        title                   TEXT NOT NULL,
        status                  TEXT NOT NULL,
        spawned_by_agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
        closed_at               INTEGER,
        close_summary           TEXT,
        pinned_at               INTEGER,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        archived_at             INTEGER,
        latest_message_seq      INTEGER NOT NULL DEFAULT 0,
        visibility              TEXT NOT NULL DEFAULT 'private'
          CHECK (
            visibility IN ('private', 'public')
            AND (visibility = 'private' OR kind = 'channel')
          )
      );

      INSERT INTO conversations_new (
        id, workspace_id, kind, title, status,
        spawned_by_agent_id, closed_at, close_summary, pinned_at,
        created_at, updated_at, archived_at, latest_message_seq, visibility
      )
        SELECT
          id, workspace_id, kind, title, status,
          spawned_by_agent_id, closed_at, close_summary, pinned_at,
          created_at, updated_at, archived_at, latest_message_seq, visibility
        FROM conversations;

      DROP TABLE conversations;
      ALTER TABLE conversations_new RENAME TO conversations;

      CREATE INDEX idx_conversations_workspace
        ON conversations(workspace_id, kind, updated_at DESC);
      CREATE INDEX idx_conversations_status
        ON conversations(status);
      CREATE INDEX idx_conversations_archived_at
        ON conversations(workspace_id) WHERE archived_at IS NOT NULL;

      CREATE TABLE workspaces_new (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        description        TEXT,
        workspace_kind     TEXT NOT NULL
          CHECK (workspace_kind IN ('regular', 'agent_home')),
        owner_agent_id     TEXT UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
        archived_at        INTEGER,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        pinned_at          INTEGER,
        owner_user_id      TEXT REFERENCES users(id),
        CHECK (
          (workspace_kind = 'agent_home' AND owner_agent_id IS NOT NULL)
          OR
          (workspace_kind = 'regular' AND owner_agent_id IS NULL)
        )
      );

      INSERT INTO workspaces_new (
        id, name, description, workspace_kind,
        owner_agent_id, archived_at, created_at, updated_at, pinned_at,
        owner_user_id
      )
        SELECT
          id, name, description, workspace_kind,
          owner_agent_id, archived_at, created_at, updated_at, pinned_at,
          owner_user_id
        FROM workspaces;

      DROP TABLE workspaces;
      ALTER TABLE workspaces_new RENAME TO workspaces;

      CREATE UNIQUE INDEX workspaces_regular_name_unique
        ON workspaces(name) WHERE workspace_kind = 'regular';
      CREATE INDEX idx_workspaces_pinned_at
        ON workspaces(workspace_kind, pinned_at) WHERE pinned_at IS NOT NULL;
    `,
  },
  {
    version: 65,
    name: 'attention_mute_tier_and_workspace_suppressor',
    // #task:1870 (docs/activity-lifecycle-v1.md §6/§8/§9.1) — the three attention
    // tiers. Two schema facts land together because they are ONE product decision
    // and each is meaningless alone:
    //
    //   1. `channel_attention_preferences.mode` gains a third value, `'mute'`.
    //      The channel scope is ONE mutually-exclusive choice, so it stays a
    //      single enum: `mode` + a separate `muted` boolean would only need an
    //      ADD COLUMN, but it would make the illegal state
    //      (`muted` AND ambient on) EXPRESSIBLE and push the invariant from the
    //      type surface onto the render surface. SQLite cannot ALTER a CHECK, so
    //      the price of that guarantee is this table rebuild — paid once.
    //
    //   2. `workspace_attention_preferences` — the per-(viewer, workspace) mute
    //      SUPPRESSOR. Deliberately a BOOLEAN, not a fourth tier and not an
    //      overridable default: it sits ABOVE the channel tier, so un-muting a
    //      workspace restores every channel's own stored mode unchanged. That is
    //      what makes this a pure schema addition: no backfill, no inherit axis,
    //      and not one existing row is re-read or rewritten.
    //
    // The suppressor gets its OWN table rather than a column on `workspace_users`
    // (which governance also writes): it is a viewer's attention decision, so it
    // is owned state under the same 建表准入 test (§4.2) that admitted the channel
    // preference, and it must not inherit membership's lifecycle. Attention now
    // owns exactly TWO write-side aggregates; it still stores no read state and
    // still never touches delivery (§5.2 — no thread_followers, no wake).
    //
    // Scope guards mirror the channel table's `channel_only` backstop: a pref on
    // an `agent_home` workspace is meaningless dead state (a DM is
    // directed-grade — it cannot be muted, and it has no ambient tier to
    // suppress), so the DB fails loud instead of storing it.
    up: `
      CREATE TABLE channel_attention_preferences_new (
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        mode             TEXT NOT NULL CHECK (mode IN ('all', 'mentions', 'mute')),
        updated_at       INTEGER NOT NULL,
        PRIMARY KEY (user_id, conversation_id)
      );

      INSERT INTO channel_attention_preferences_new (
        user_id, conversation_id, mode, updated_at
      )
        SELECT user_id, conversation_id, mode, updated_at
        FROM channel_attention_preferences;

      DROP TABLE channel_attention_preferences;
      ALTER TABLE channel_attention_preferences_new
        RENAME TO channel_attention_preferences;

      CREATE INDEX idx_channel_attention_prefs_conversation
        ON channel_attention_preferences(conversation_id);

      CREATE TRIGGER channel_attention_prefs_channel_only_insert
        BEFORE INSERT ON channel_attention_preferences
        BEGIN
          SELECT CASE
            WHEN COALESCE(
              (SELECT kind FROM conversations WHERE id = NEW.conversation_id), ''
            ) != 'channel'
            THEN RAISE(ABORT, 'channel_attention_preferences.conversation_id must reference a regular channel')
          END;
        END;

      CREATE TRIGGER channel_attention_prefs_channel_only_update
        BEFORE UPDATE OF conversation_id ON channel_attention_preferences
        BEGIN
          SELECT CASE
            WHEN COALESCE(
              (SELECT kind FROM conversations WHERE id = NEW.conversation_id), ''
            ) != 'channel'
            THEN RAISE(ABORT, 'channel_attention_preferences.conversation_id must reference a regular channel')
          END;
        END;

      CREATE TABLE workspace_attention_preferences (
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        muted         INTEGER NOT NULL CHECK (muted IN (0, 1)),
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (user_id, workspace_id)
      );

      CREATE INDEX idx_workspace_attention_prefs_workspace
        ON workspace_attention_preferences(workspace_id);

      CREATE TRIGGER workspace_attention_prefs_regular_only_insert
        BEFORE INSERT ON workspace_attention_preferences
        BEGIN
          SELECT CASE
            WHEN COALESCE(
              (SELECT workspace_kind FROM workspaces WHERE id = NEW.workspace_id), ''
            ) != 'regular'
            THEN RAISE(ABORT, 'workspace_attention_preferences.workspace_id must reference a regular workspace')
          END;
        END;

      CREATE TRIGGER workspace_attention_prefs_regular_only_update
        BEFORE UPDATE OF workspace_id ON workspace_attention_preferences
        BEGIN
          SELECT CASE
            WHEN COALESCE(
              (SELECT workspace_kind FROM workspaces WHERE id = NEW.workspace_id), ''
            ) != 'regular'
            THEN RAISE(ABORT, 'workspace_attention_preferences.workspace_id must reference a regular workspace')
          END;
        END;
    `,
  },
  {
    version: 66,
    name: 'task_board_ordered_access_paths',
    up: `
      -- #task:1884 — the human task board reads one status column at a time as a
      -- keyset window (ORDER BY task_number DESC, id DESC LIMIT n). Bounding the
      -- ROWS the client renders is only half of it: without an index that is
      -- already in that order, every window still sorts the whole column, so the
      -- authority's cost stays proportional to the population, not to the page.
      --
      -- Two access paths because the board has two real query shapes and one
      -- composite cannot serve both: the DEFAULT view is cross-workspace
      -- ("All workspaces"), where a leading workspace_id column is unusable, and
      -- the narrowed view filters one workspace first.
      --
      -- Column order mirrors the queries exactly: status equality, then the sort
      -- key. The trailing id column is the unique tiebreak that makes the keyset
      -- a TOTAL order — task_number is monotonic only per workspace
      -- (uniq_tasks_workspace_number), so on a cross-workspace board two tasks
      -- can share a number and a number-only cursor could skip or repeat rows.
      CREATE INDEX idx_tasks_status_number
        ON tasks(status, task_number DESC, id DESC);

      CREATE INDEX idx_tasks_workspace_status_number
        ON tasks(workspace_id, status, task_number DESC, id DESC);

      -- Superseded: idx_tasks_workspace_status(workspace_id, status) is a strict
      -- PREFIX of the index above, so every lookup it served is served
      -- identically — keeping it would only add a second b-tree to maintain on
      -- every task write.
      DROP INDEX idx_tasks_workspace_status;
    `,
  },
  {
    version: 67,
    name: 'conversation_reads_stream_cursor_lookup',
    up: `
      -- #task:1967 — the unread read-model resolves a cursor per STREAM
      -- (user_id, conversation_id, thread_root_id), where the stream is a
      -- variable, not a literal: the per-conversation and Activity queries walk
      -- a set of streams and look up each one's cursor.
      --
      -- The two partial uniques (uniq_conversation_reads_main /
      -- uniq_conversation_reads_thread) cannot serve that lookup. A partial
      -- index is usable only when the WHERE clause IMPLIES its predicate, and a
      -- dynamic root implies neither "thread_root_id IS NULL" nor
      -- "IS NOT NULL" — so the planner fell back to
      -- idx_conversation_reads_conversation(conversation_id) and filtered rows,
      -- once per candidate message.
      --
      -- Hence a FULL (non-partial) index with the exact column order the lookup
      -- binds. It carries NO uniqueness contract: the two partial uniques keep
      -- owning mainline-NULL / thread-non-NULL uniqueness, and this index is
      -- purely an access path. Leading user_id because every reader is
      -- viewer-scoped; conversation_id then thread_root_id so a per-conversation
      -- prefix scan is available as well as the full three-column probe.
      --
      -- The two existing single-column indexes stay: they cover the FK/cascade
      -- probes (conversation_id, thread_root_id) that this index's leading
      -- user_id cannot serve.
      CREATE INDEX idx_conversation_reads_user_conversation_stream
        ON conversation_reads(user_id, conversation_id, thread_root_id);
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
