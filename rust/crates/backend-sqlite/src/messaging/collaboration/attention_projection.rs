//! SQLite authority for the tiered badge and per-workspace mode cold faces.

use crate::{
    messaging::MessagingStore,
    unread_read::{UnreadReadModelError, attention_badge_counts},
};
use silverhand_backend_core::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::collaboration::{
        attention_preference::ChannelAttentionMode,
        attention_projection::{
            AttentionBadgeProjectionError, AttentionBadgeRollup, AttentionCount,
            AttentionModesRefusal, AttentionProjectionPort, ChannelAttentionTier,
            WorkspaceAttentionCount, WorkspaceAttentionModes,
        },
    },
    persistence::PersistenceFailure,
};
use sqlx::{Row, SqlitePool};
use thiserror::Error;

const CHANNEL_DEFAULT_MODE: &str = "all";

// Mirrors the one effective-directed-claim predicate shared by the TS badge and
// modes faces: unread mention_self, anchored, and above its own stream cursor.
const CHANNEL_TIERS: &str = r#"
WITH p(viewer, workspace, channel_default_mode) AS (SELECT ?, ?, ?)
SELECT c.id AS conversation_id,
       COALESCE((SELECT cap.mode
                   FROM channel_attention_preferences cap
                  WHERE cap.user_id=(SELECT viewer FROM p)
                    AND cap.conversation_id=c.id),
                (SELECT channel_default_mode FROM p)) AS mode,
       CASE WHEN EXISTS(
                    SELECT 1 FROM workspace_attention_preferences wap
                     WHERE wap.user_id=(SELECT viewer FROM p)
                       AND wap.workspace_id=c.workspace_id
                       AND wap.muted=1)
            THEN 'mute'
            ELSE COALESCE((SELECT cap.mode
                             FROM channel_attention_preferences cap
                            WHERE cap.user_id=(SELECT viewer FROM p)
                              AND cap.conversation_id=c.id),
                          (SELECT channel_default_mode FROM p))
       END AS effective_mode,
       (SELECT COUNT(DISTINCT n.message_id)
          FROM notifications n
         WHERE n.user_id=(SELECT viewer FROM p)
           AND n.conversation_id=c.id
           AND n.kind='mention_self'
           AND n.read_at IS NULL
           AND EXISTS(
                 SELECT 1 FROM messages dm
                  WHERE dm.id=n.message_id
                    AND dm.seq > COALESCE((
                          SELECT dcr.last_read_seq FROM conversation_reads dcr
                           WHERE dcr.user_id=n.user_id
                             AND dcr.conversation_id=n.conversation_id
                             AND dcr.thread_root_id IS dm.thread_root_id), 0)
               )) AS directed_unread_count
  FROM conversations c
  JOIN conversation_users cu
    ON cu.conversation_id=c.id AND cu.user_id=(SELECT viewer FROM p)
 WHERE c.workspace_id=(SELECT workspace FROM p)
   AND c.placement_kind='workspace'
   AND c.roster_policy='open'
   AND c.id IS NOT NULL
   AND c.archived_at IS NULL
 ORDER BY c.created_at ASC, c.id ASC
"#;

const MUTED_VISIBLE_WORKSPACES: &str = r#"
SELECT p.workspace_id
  FROM workspace_attention_preferences p
  JOIN workspace_users wu
    ON wu.workspace_id=p.workspace_id AND wu.user_id=?
 WHERE p.user_id=? AND p.muted=1
 ORDER BY p.workspace_id
"#;

#[derive(Clone)]
pub struct SqliteAttentionProjection {
    pool: SqlitePool,
}

impl<E> MessagingStore<E> {
    pub fn attention_projection(&self) -> SqliteAttentionProjection {
        SqliteAttentionProjection {
            pool: self.pool.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum AttentionProjectionStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("tiered badge authority failed")]
    Badge(#[from] UnreadReadModelError),
    #[error("stored attention projection identity is malformed")]
    MalformedIdentity,
    #[error("stored attention mode is malformed")]
    MalformedMode,
    #[error("stored workspace mute flag is malformed")]
    MalformedMute,
    #[error("stored attention count is malformed")]
    MalformedCount,
    #[error("attention badge total overflowed")]
    TotalOverflow,
    #[error("attention badge authority returned a duplicate workspace")]
    DuplicateWorkspace,
}

impl From<AttentionProjectionStoreError> for PersistenceFailure {
    fn from(value: AttentionProjectionStoreError) -> Self {
        Self::from_source(value)
    }
}

impl AttentionProjectionPort for SqliteAttentionProjection {
    type Error = PersistenceFailure;

    async fn badges(&self, viewer: &UserId) -> Result<AttentionBadgeRollup, Self::Error> {
        let mut tx = self
            .pool
            .begin_with("BEGIN DEFERRED")
            .await
            .map_err(AttentionProjectionStoreError::from)?;
        let badge_rows = attention_badge_counts(&mut tx, viewer)
            .await
            .map_err(AttentionProjectionStoreError::from)?;
        let muted_rows = sqlx::query(MUTED_VISIBLE_WORKSPACES)
            .bind(viewer.as_str())
            .bind(viewer.as_str())
            .fetch_all(&mut *tx)
            .await
            .map_err(AttentionProjectionStoreError::from)?;

        let mut by_workspace = Vec::with_capacity(badge_rows.len());
        for (workspace, raw_count) in badge_rows {
            let count = AttentionCount::new(raw_count)
                .map_err(|_| AttentionProjectionStoreError::MalformedCount)?;
            if count.get() > 0 {
                by_workspace.push(WorkspaceAttentionCount::projected(workspace, count));
            }
        }
        let mut muted_workspaces = Vec::with_capacity(muted_rows.len());
        for row in muted_rows {
            let raw: String = row
                .try_get("workspace_id")
                .map_err(AttentionProjectionStoreError::from)?;
            let workspace = WorkspaceId::parse(raw)
                .map_err(|_| AttentionProjectionStoreError::MalformedIdentity)?;
            muted_workspaces.push(workspace);
        }
        let projected =
            AttentionBadgeRollup::projected(by_workspace, muted_workspaces).map_err(|error| {
                match error {
                    AttentionBadgeProjectionError::DuplicateWorkspace => {
                        AttentionProjectionStoreError::DuplicateWorkspace
                    }
                    AttentionBadgeProjectionError::TotalOverflow => {
                        AttentionProjectionStoreError::TotalOverflow
                    }
                }
            })?;
        tx.commit()
            .await
            .map_err(AttentionProjectionStoreError::from)?;
        Ok(projected)
    }

    async fn modes(
        &self,
        viewer: &UserId,
        workspace: WorkspaceId,
    ) -> Result<Result<WorkspaceAttentionModes, AttentionModesRefusal>, Self::Error> {
        let mut tx = self
            .pool
            .begin_with("BEGIN DEFERRED")
            .await
            .map_err(AttentionProjectionStoreError::from)?;
        let visible = sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM workspace_users WHERE workspace_id=? AND user_id=?",
        )
        .bind(workspace.as_str())
        .bind(viewer.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(AttentionProjectionStoreError::from)?
        .is_some();
        if !visible {
            tx.rollback()
                .await
                .map_err(AttentionProjectionStoreError::from)?;
            return Ok(Err(AttentionModesRefusal::Forbidden));
        }

        let raw_muted = sqlx::query_scalar::<_, i64>(
            "SELECT muted FROM workspace_attention_preferences WHERE user_id=? AND workspace_id=?",
        )
        .bind(viewer.as_str())
        .bind(workspace.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(AttentionProjectionStoreError::from)?;
        let muted = match raw_muted {
            None | Some(0) => false,
            Some(1) => true,
            Some(_) => return Err(AttentionProjectionStoreError::MalformedMute.into()),
        };

        let rows = sqlx::query(CHANNEL_TIERS)
            .bind(viewer.as_str())
            .bind(workspace.as_str())
            .bind(CHANNEL_DEFAULT_MODE)
            .fetch_all(&mut *tx)
            .await
            .map_err(AttentionProjectionStoreError::from)?;
        let mut channels = Vec::with_capacity(rows.len());
        for row in rows {
            let raw_conversation: String = row
                .try_get("conversation_id")
                .map_err(AttentionProjectionStoreError::from)?;
            let raw_mode: String = row
                .try_get("mode")
                .map_err(AttentionProjectionStoreError::from)?;
            let raw_effective: String = row
                .try_get("effective_mode")
                .map_err(AttentionProjectionStoreError::from)?;
            let raw_count: i64 = row
                .try_get("directed_unread_count")
                .map_err(AttentionProjectionStoreError::from)?;
            channels.push(ChannelAttentionTier::projected(
                ConversationId::parse(raw_conversation)
                    .map_err(|_| AttentionProjectionStoreError::MalformedIdentity)?,
                ChannelAttentionMode::parse(&raw_mode)
                    .ok_or(AttentionProjectionStoreError::MalformedMode)?,
                ChannelAttentionMode::parse(&raw_effective)
                    .ok_or(AttentionProjectionStoreError::MalformedMode)?,
                AttentionCount::new(raw_count)
                    .map_err(|_| AttentionProjectionStoreError::MalformedCount)?,
            ));
        }
        tx.commit()
            .await
            .map_err(AttentionProjectionStoreError::from)?;
        Ok(Ok(WorkspaceAttentionModes::projected(
            workspace, muted, channels,
        )))
    }
}
