//! SQLite adapter for the unread read model — the query
//! [`UnreadPublication`](silverhand_backend_core::messaging::post_commit::UnreadPublication)
//! runs before it emits a single frame.
//!
//! This store CONSUMES the product database. It creates no table, runs no migrator,
//! claims no schema version, and refuses to open a database that does not exist:
//! the schema has an owner, and a second one would be a second migration authority.
//!
//! It is a READ MODEL and nothing else. It decides who is owed an unread update for
//! a conversation and what their counts now are, against the committed database, and
//! hands the answer over as [`UnreadAudience`] — a value, not a branch the effect
//! adapter takes. Placement is resolved HERE, so the publisher's match over the two
//! arms is total and cannot silently drop one.
//!
//! Every predicate below is the migration oracle's, transcribed verbatim. The oracle
//! binds by name (`@viewer`, `@workspace`, `@channelDefaultMode`); SQLx SQLite has no
//! named parameters, so each value is bound ONCE positionally into a `p(...)` CTE and
//! referenced as a scalar subquery `(SELECT viewer FROM p)`. The predicate text is
//! otherwise unchanged, so the set it selects is the same set.

use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::{
        MessageId, ThreadRootId,
        unread::{LatestUnread, UnreadAudience, UnreadReadModel, ViewerUnread},
    },
    persistence::PersistenceFailure,
};
use sqlx::{
    Row, Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const DEFERRED_READ_BEGIN: &str = "BEGIN DEFERRED";
const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The stored channel default the oracle passes as `@channelDefaultMode`: a channel
/// with no per-viewer preference is treated as 'all' (loud).
const CHANNEL_DEFAULT_MODE: &str = "all";

// ---------------------------------------------------------------------------
// Predicate fragments — the oracle's SQL, `@viewer` rewritten to the `p` CTE.
// Defined as macros so the shared rollup is transcribed once and composed by
// `concat!` into `&'static str`, exactly as the sibling messaging store does.
// ---------------------------------------------------------------------------

/// A message is worth counting only if its conversation is live, it is not a system
/// message, and it is not the viewer's own (or an authorless) `user` message.
macro_rules! unread_guards {
    () => {
        "NOT EXISTS (SELECT 1 FROM conversations arch WHERE arch.id = m.conversation_id AND \
         arch.archived_at IS NOT NULL) AND m.from_kind != 'system' AND NOT (m.from_kind = 'user' \
         AND (m.from_user_id = (SELECT viewer FROM p) OR m.from_user_id IS NULL))"
    };
}

/// A main-line message counts when it is past the viewer's main-line read cursor.
macro_rules! mainline_branch {
    () => {
        "m.thread_root_id IS NULL AND m.seq > COALESCE((SELECT cr.last_read_seq FROM \
         conversation_reads cr WHERE cr.user_id = (SELECT viewer FROM p) AND cr.conversation_id = \
         m.conversation_id AND cr.thread_root_id IS NULL), 0)"
    };
}

/// A threaded message counts only for a viewer who follows that thread, and only past
/// their per-thread read cursor.
macro_rules! followed_thread_branch {
    () => {
        "m.thread_root_id IS NOT NULL AND EXISTS (SELECT 1 FROM thread_followers tf WHERE \
         tf.thread_root_id = m.thread_root_id AND tf.principal_kind = 'human' AND tf.principal_id \
         = (SELECT viewer FROM p)) AND m.seq > COALESCE((SELECT cr.last_read_seq FROM \
         conversation_reads cr WHERE cr.user_id = (SELECT viewer FROM p) AND cr.conversation_id = \
         m.conversation_id AND cr.thread_root_id = m.thread_root_id), 0)"
    };
}

/// The unread rollup: guards AND (main-line unread OR followed-thread unread).
macro_rules! rollup_unread {
    () => {
        concat!(
            unread_guards!(),
            " AND ((",
            mainline_branch!(),
            ") OR (",
            followed_thread_branch!(),
            "))"
        )
    };
}

/// A channel enters the badge ambiently when the viewer's effective channel mode is
/// 'all' and the workspace is not muted for them. Correlated on the `c` alias.
macro_rules! channel_ambient_enters {
    () => {
        "(COALESCE((SELECT cap.mode FROM channel_attention_preferences cap WHERE cap.user_id = \
         (SELECT viewer FROM p) AND cap.conversation_id = c.id), (SELECT cdm FROM p)) = 'all' AND \
         NOT EXISTS (SELECT 1 FROM workspace_attention_preferences wap WHERE wap.user_id = \
         (SELECT viewer FROM p) AND wap.workspace_id = c.workspace_id AND wap.muted = 1))"
    };
}

/// A conversation counts positionally (its whole unread contributes to the badge) when
/// its roster is fixed, or open and ambiently entering.
macro_rules! loud_positional {
    () => {
        concat!(
            "(c.roster_policy = 'fixed' OR (c.roster_policy = 'open' AND ",
            channel_ambient_enters!(),
            "))"
        )
    };
}

/// The positional badge term: unread in loud conversations the viewer is seated in.
macro_rules! badge_positional_term {
    () => {
        concat!(
            "SELECT COUNT(m.id) AS c FROM conversations c JOIN conversation_users cu ON \
             cu.conversation_id = c.id AND cu.user_id = (SELECT viewer FROM p) JOIN messages m ON \
             m.conversation_id = c.id AND ",
            rollup_unread!(),
            " WHERE ",
            loud_positional!(),
            " AND c.workspace_id = (SELECT ws FROM p)"
        )
    };
}

/// An unread directed mention: an unread `mention_self` notification whose message is
/// itself still past the viewer's read cursor. Keyed on `n.user_id`, matching the oracle
/// (which does not re-bind the viewer inside this correlated predicate).
macro_rules! effective_directed_mention {
    () => {
        "(n.kind = 'mention_self' AND n.read_at IS NULL AND EXISTS (SELECT 1 FROM messages dm \
         WHERE dm.id = n.message_id AND dm.seq > COALESCE((SELECT dcr.last_read_seq FROM \
         conversation_reads dcr WHERE dcr.user_id = n.user_id AND dcr.conversation_id = \
         n.conversation_id AND dcr.thread_root_id IS dm.thread_root_id), 0)))"
    };
}

/// The directed badge term: distinct unread mentions in QUIET conversations the viewer
/// is seated in — the tier a positional count does not already cover.
macro_rules! badge_directed_term {
    () => {
        concat!(
            "SELECT COUNT(DISTINCT n.message_id) AS c FROM notifications n JOIN conversations c ON \
             c.id = n.conversation_id JOIN conversation_users cu ON cu.conversation_id = c.id AND \
             cu.user_id = (SELECT viewer FROM p) WHERE n.user_id = (SELECT viewer FROM p) AND ",
            effective_directed_mention!(),
            " AND (c.id IS NOT NULL AND c.archived_at IS NULL) AND NOT ",
            loud_positional!(),
            " AND c.workspace_id = (SELECT ws FROM p)"
        )
    };
}

/// The conversation's live human participants, as its placement names them: workspace
/// roster members with workspace membership, or the human endpoints of a direct pair.
/// JOINed to `users` so a named-but-deleted participant drops out; ordered so the plan
/// does not depend on scan order.
macro_rules! participant_user_ids {
    () => {
        "SELECT cu_p.user_id AS user_id FROM conversations c_p JOIN conversation_users cu_p ON \
         cu_p.conversation_id = c_p.id WHERE c_p.id = (SELECT conv FROM p) AND c_p.placement_kind \
         = 'workspace' AND EXISTS (SELECT 1 FROM workspace_users wu_p WHERE wu_p.workspace_id = \
         c_p.workspace_id AND wu_p.user_id = cu_p.user_id) UNION SELECT c_p.endpoint_a_id AS \
         user_id FROM conversations c_p WHERE c_p.id = (SELECT conv FROM p) AND c_p.placement_kind \
         = 'direct_pair' AND c_p.endpoint_a_kind = 'human' UNION SELECT c_p.endpoint_b_id AS \
         user_id FROM conversations c_p WHERE c_p.id = (SELECT conv FROM p) AND c_p.placement_kind \
         = 'direct_pair' AND c_p.endpoint_b_kind = 'human'"
    };
}

/// Placement and workspace of one conversation, or no row when it is gone.
const SELECT_PLACEMENT: &str =
    "SELECT placement_kind, workspace_id FROM conversations WHERE id = ?";

/// The viewer's unread count for one conversation.
const CONVERSATION_UNREAD_COUNT: &str = concat!(
    "WITH p(viewer, conv) AS (SELECT ?, ?) SELECT COUNT(m.id) AS c FROM messages m WHERE \
     m.conversation_id = (SELECT conv FROM p) AND ",
    rollup_unread!()
);

/// The viewer's unread count across every conversation they are seated in, in one workspace.
const WORKSPACE_UNREAD_COUNT: &str = concat!(
    "WITH p(viewer, ws) AS (SELECT ?, ?) SELECT COUNT(m.id) AS c FROM conversations c JOIN \
     conversation_users cu ON cu.conversation_id = c.id AND cu.user_id = (SELECT viewer FROM p) \
     JOIN messages m ON m.conversation_id = c.id AND ",
    rollup_unread!(),
    " WHERE c.workspace_id = (SELECT ws FROM p)"
);

/// The single most-recent unread message for the viewer in one conversation, or no row.
const LATEST_UNREAD: &str = concat!(
    "WITH p(viewer, conv) AS (SELECT ?, ?) SELECT m.conversation_id AS conversation_id, m.id AS \
     message_id, m.seq AS seq, m.thread_root_id AS thread_root_id FROM messages m WHERE \
     m.conversation_id = (SELECT conv FROM p) AND ",
    rollup_unread!(),
    " ORDER BY m.seq DESC LIMIT 1"
);

/// The viewer's tiered attention badge for one workspace: loud unread plus quiet
/// directed mentions, summed. `COALESCE(SUM(...), 0)` gives the oracle's `row?.c ?? 0`.
const BADGE_COUNT: &str = concat!(
    "WITH p(viewer, ws, cdm) AS (SELECT ?, ?, ?) SELECT COALESCE(SUM(c), 0) AS c FROM (",
    badge_positional_term!(),
    " UNION ALL ",
    badge_directed_term!(),
    ")"
);

/// The conversation's live human participants.
const LIVE_PARTICIPANT_USER_IDS: &str = concat!(
    "WITH p(conv) AS (SELECT ?) SELECT u.id AS user_id FROM (",
    participant_user_ids!(),
    ") src JOIN users u ON u.id = src.user_id ORDER BY u.created_at ASC, u.id ASC"
);

/// Reads the committed database to decide who is owed an unread update for a conversation.
#[derive(Clone)]
pub struct SqliteUnreadReadModel {
    pool: SqlitePool,
}

/// Startup and driver failures, surfaced only to the composition root that opens the
/// store; the port below hands them over as [`PersistenceFailure`] sources.
#[derive(Debug, Error)]
pub enum UnreadReadModelError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    /// A workspace-placed conversation whose `workspace_id` is null contradicts the
    /// schema's placement constraint: there is no workspace tier to report, so this is
    /// a broken row rather than an empty audience. The oracle's `requireWorkspacePlacement`
    /// throws here; this is that throw.
    #[error("conversation {0} is workspace-placed but names no workspace")]
    MissingWorkspace(String),
    /// A stored placement outside the closed set the schema constrains.
    #[error("conversation {0} declares an unknown placement {1:?}")]
    UnknownPlacement(String, String),
    /// A stored column that should name something names nothing.
    #[error("stored column {0} does not name a usable identity")]
    MalformedIdentity(&'static str),
}

const PLACEMENT_WORKSPACE: &str = "workspace";
const PLACEMENT_DIRECT_PAIR: &str = "direct_pair";

impl SqliteUnreadReadModel {
    /// Opens an existing product database. A missing file is a failure rather than an
    /// empty database.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, UnreadReadModelError> {
        Self::open_with_busy_timeout(path, BUSY_TIMEOUT).await
    }

    async fn open_with_busy_timeout(
        path: impl AsRef<Path>,
        busy_timeout: Duration,
    ) -> Result<Self, UnreadReadModelError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(busy_timeout);

        let pool = SqlitePoolOptions::new()
            .max_connections(POOL_CONNECTIONS)
            .connect_with(options)
            .await?;

        Ok(Self { pool })
    }

    /// One deferred read across every statement, so the placement, the participants, and
    /// each viewer's counts are read from ONE snapshot — a concurrent send landing
    /// mid-computation cannot make a viewer's conversation count disagree with the
    /// workspace count that must contain it.
    async fn unread_audience_transaction(
        &self,
        conversation: &ConversationId,
    ) -> Result<Option<UnreadAudience>, UnreadReadModelError> {
        let mut tx = self.pool.begin_with(DEFERRED_READ_BEGIN).await?;

        let Some(row) = sqlx::query(SELECT_PLACEMENT)
            .bind(conversation.as_str())
            .fetch_optional(&mut *tx)
            .await?
        else {
            // The conversation is gone. Nothing to publish — the one early return the
            // oracle guards, and the reason the port answers `Option`.
            return Ok(None);
        };
        let placement: String = row.try_get("placement_kind")?;
        let workspace_id: Option<String> = row.try_get("workspace_id")?;

        // The same participants query answers both placements; the fork is which
        // audience shape they populate.
        let viewers = participants(&mut tx, conversation).await?;

        let audience = match placement.as_str() {
            PLACEMENT_WORKSPACE => {
                let workspace = workspace_id.ok_or_else(|| {
                    UnreadReadModelError::MissingWorkspace(conversation.as_str().to_owned())
                })?;
                let workspace = WorkspaceId::parse(workspace).map_err(|_| {
                    UnreadReadModelError::MalformedIdentity("conversations.workspace_id")
                })?;

                let mut computed = Vec::with_capacity(viewers.len());
                for viewer in viewers {
                    computed.push(viewer_unread(&mut tx, conversation, &workspace, viewer).await?);
                }
                UnreadAudience::Workspace {
                    workspace,
                    viewers: computed,
                }
            }
            PLACEMENT_DIRECT_PAIR => UnreadAudience::DirectPair { viewers },
            other => {
                return Err(UnreadReadModelError::UnknownPlacement(
                    conversation.as_str().to_owned(),
                    other.to_owned(),
                ));
            }
        };

        tx.commit().await?;
        Ok(Some(audience))
    }
}

/// The conversation's live human participants, parsed into identities.
async fn participants(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
) -> Result<Vec<UserId>, UnreadReadModelError> {
    let rows: Vec<String> = sqlx::query_scalar(LIVE_PARTICIPANT_USER_IDS)
        .bind(conversation.as_str())
        .fetch_all(&mut **tx)
        .await?;
    rows.into_iter()
        .map(|id| {
            UserId::parse(id).map_err(|_| UnreadReadModelError::MalformedIdentity("users.id"))
        })
        .collect()
}

/// One viewer's unread state after the send, read on the shared snapshot.
async fn viewer_unread(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
    workspace: &WorkspaceId,
    viewer: UserId,
) -> Result<ViewerUnread, UnreadReadModelError> {
    let conversation_unread_count: i64 = sqlx::query_scalar(CONVERSATION_UNREAD_COUNT)
        .bind(viewer.as_str())
        .bind(conversation.as_str())
        .fetch_one(&mut **tx)
        .await?;
    let workspace_unread_count: i64 = sqlx::query_scalar(WORKSPACE_UNREAD_COUNT)
        .bind(viewer.as_str())
        .bind(workspace.as_str())
        .fetch_one(&mut **tx)
        .await?;
    let latest_unread = latest_unread(tx, conversation, &viewer).await?;
    let badge_count: i64 = sqlx::query_scalar(BADGE_COUNT)
        .bind(viewer.as_str())
        .bind(workspace.as_str())
        .bind(CHANNEL_DEFAULT_MODE)
        .fetch_one(&mut **tx)
        .await?;

    Ok(ViewerUnread {
        viewer,
        conversation_unread_count,
        workspace_unread_count,
        latest_unread,
        badge_count,
    })
}

/// The single most-recent unread message for the viewer, or `None` — never a stale anchor.
async fn latest_unread(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
    viewer: &UserId,
) -> Result<Option<LatestUnread>, UnreadReadModelError> {
    let Some(row) = sqlx::query(LATEST_UNREAD)
        .bind(viewer.as_str())
        .bind(conversation.as_str())
        .fetch_optional(&mut **tx)
        .await?
    else {
        return Ok(None);
    };

    let conversation_id: String = row.try_get("conversation_id")?;
    let message_id: String = row.try_get("message_id")?;
    let seq: i64 = row.try_get("seq")?;
    let thread_root_id: Option<String> = row.try_get("thread_root_id")?;

    Ok(Some(LatestUnread {
        conversation: ConversationId::parse(conversation_id)
            .map_err(|_| UnreadReadModelError::MalformedIdentity("messages.conversation_id"))?,
        message: MessageId::parse(message_id)
            .map_err(|_| UnreadReadModelError::MalformedIdentity("messages.id"))?,
        seq,
        thread_root: thread_root_id
            .map(ThreadRootId::parse)
            .transpose()
            .map_err(|_| UnreadReadModelError::MalformedIdentity("messages.thread_root_id"))?,
    }))
}

impl UnreadReadModel for SqliteUnreadReadModel {
    async fn unread_audience(
        &self,
        conversation: &ConversationId,
    ) -> Result<Option<UnreadAudience>, PersistenceFailure> {
        // The driver error is handed over as the source; the boundary that renders it
        // owns the record.
        self.unread_audience_transaction(conversation)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}
