use crate::messaging::{HostEnvironment, MessagingStore};
use silverhand_backend_core::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::{
        SendClock,
        collaboration::attention_preference::{
            AttentionPreferencePort, AttentionPreferenceRefusal, ChannelAttentionMode,
            CommittedAttentionPreference, WorkspaceAttentionPreference,
        },
    },
    persistence::PersistenceFailure,
};
use sqlx::SqlitePool;
use thiserror::Error;

#[derive(Clone)]
pub struct SqliteAttentionPreferenceStore<E = HostEnvironment> {
    pool: SqlitePool,
    environment: E,
}

impl<E: Clone> MessagingStore<E> {
    pub fn attention_preferences(&self) -> SqliteAttentionPreferenceStore<E> {
        SqliteAttentionPreferenceStore {
            pool: self.pool.clone(),
            environment: self.environment.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum AttentionPreferenceStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("stored attention preference identity is malformed")]
    MalformedIdentity,
    #[error("stored channel attention mode is malformed")]
    MalformedMode,
    #[error("stored workspace mute flag is malformed")]
    MalformedMute,
    #[error("clock failed")]
    Clock(#[source] silverhand_backend_core::messaging::EnvironmentUnavailable),
}

impl From<AttentionPreferenceStoreError> for PersistenceFailure {
    fn from(value: AttentionPreferenceStoreError) -> Self {
        Self::from_source(value)
    }
}

impl<E: SendClock + Clone + Send + Sync + 'static> AttentionPreferencePort
    for SqliteAttentionPreferenceStore<E>
{
    type Error = PersistenceFailure;

    async fn set_channel(
        &self,
        viewer: UserId,
        conversation: ConversationId,
        mode: Option<ChannelAttentionMode>,
    ) -> Result<Result<CommittedAttentionPreference, AttentionPreferenceRefusal>, Self::Error> {
        let now = self
            .environment
            .now_unix_ms()
            .map_err(AttentionPreferenceStoreError::Clock)?;
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AttentionPreferenceStoreError::from)?;

        // This is the production getChannel boundary: only an open-roster,
        // workspace-placed regular channel reaches the preference aggregate.
        let workspace_raw: Option<String> = sqlx::query_scalar(
            "SELECT workspace_id FROM conversations WHERE id=? AND placement_kind='workspace' AND roster_policy='open'",
        )
        .bind(conversation.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(AttentionPreferenceStoreError::from)?
        .flatten();
        let Some(workspace_raw) = workspace_raw else {
            return Ok(Err(AttentionPreferenceRefusal::ChannelNotFound));
        };
        let workspace = WorkspaceId::parse(workspace_raw)
            .map_err(|_| AttentionPreferenceStoreError::MalformedIdentity)?;

        let admitted: Option<i64> = sqlx::query_scalar(
            "SELECT 1 WHERE EXISTS(SELECT 1 FROM workspace_users WHERE workspace_id=? AND user_id=?) AND EXISTS(SELECT 1 FROM conversation_users WHERE conversation_id=? AND user_id=?)",
        )
        .bind(workspace.as_str())
        .bind(viewer.as_str())
        .bind(conversation.as_str())
        .bind(viewer.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(AttentionPreferenceStoreError::from)?;
        if admitted.is_none() {
            return Ok(Err(AttentionPreferenceRefusal::Forbidden));
        }
        let Some(mode) = mode else {
            return Ok(Err(AttentionPreferenceRefusal::InvalidInput));
        };

        sqlx::query(
            "INSERT INTO channel_attention_preferences(user_id,conversation_id,mode,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET mode=excluded.mode,updated_at=excluded.updated_at",
        )
        .bind(viewer.as_str())
        .bind(conversation.as_str())
        .bind(mode.as_str())
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(AttentionPreferenceStoreError::from)?;
        let stored: String = sqlx::query_scalar(
            "SELECT mode FROM channel_attention_preferences WHERE user_id=? AND conversation_id=?",
        )
        .bind(viewer.as_str())
        .bind(conversation.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(AttentionPreferenceStoreError::from)?;
        let stored = ChannelAttentionMode::parse(&stored)
            .ok_or(AttentionPreferenceStoreError::MalformedMode)?;
        tx.commit()
            .await
            .map_err(AttentionPreferenceStoreError::from)?;
        Ok(Ok(CommittedAttentionPreference::channel(
            viewer,
            workspace,
            conversation,
            stored,
        )))
    }

    async fn get_workspace(
        &self,
        viewer: &UserId,
        workspace: WorkspaceId,
    ) -> Result<Result<WorkspaceAttentionPreference, AttentionPreferenceRefusal>, Self::Error> {
        let mut tx = self
            .pool
            .begin_with("BEGIN DEFERRED")
            .await
            .map_err(AttentionPreferenceStoreError::from)?;
        let visible: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM workspaces w JOIN workspace_users wu ON wu.workspace_id=w.id AND wu.user_id=? WHERE w.id=?",
        )
        .bind(viewer.as_str())
        .bind(workspace.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(AttentionPreferenceStoreError::from)?;
        if visible.is_none() {
            return Ok(Err(AttentionPreferenceRefusal::Forbidden));
        }
        let owner: Option<String> =
            sqlx::query_scalar("SELECT owner_agent_id FROM workspaces WHERE id=?")
                .bind(workspace.as_str())
                .fetch_one(&mut *tx)
                .await
                .map_err(AttentionPreferenceStoreError::from)?;
        if owner.is_some() {
            return Ok(Err(AttentionPreferenceRefusal::WorkspaceNotFound));
        }
        let muted: Option<i64> = sqlx::query_scalar(
            "SELECT muted FROM workspace_attention_preferences WHERE user_id=? AND workspace_id=?",
        )
        .bind(viewer.as_str())
        .bind(workspace.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(AttentionPreferenceStoreError::from)?;
        let muted = match muted {
            None | Some(0) => false,
            Some(1) => true,
            Some(_) => return Err(AttentionPreferenceStoreError::MalformedMute.into()),
        };
        tx.commit()
            .await
            .map_err(AttentionPreferenceStoreError::from)?;
        Ok(Ok(WorkspaceAttentionPreference::projected(
            workspace, muted,
        )))
    }

    async fn set_workspace(
        &self,
        viewer: UserId,
        workspace: WorkspaceId,
        muted: Option<bool>,
    ) -> Result<Result<CommittedAttentionPreference, AttentionPreferenceRefusal>, Self::Error> {
        let now = self
            .environment
            .now_unix_ms()
            .map_err(AttentionPreferenceStoreError::Clock)?;
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AttentionPreferenceStoreError::from)?;
        let visible: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM workspaces w JOIN workspace_users wu ON wu.workspace_id=w.id AND wu.user_id=? WHERE w.id=?",
        )
        .bind(viewer.as_str())
        .bind(workspace.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(AttentionPreferenceStoreError::from)?;
        if visible.is_none() {
            return Ok(Err(AttentionPreferenceRefusal::Forbidden));
        }
        let owner: Option<String> =
            sqlx::query_scalar("SELECT owner_agent_id FROM workspaces WHERE id=?")
                .bind(workspace.as_str())
                .fetch_one(&mut *tx)
                .await
                .map_err(AttentionPreferenceStoreError::from)?;
        if owner.is_some() {
            return Ok(Err(AttentionPreferenceRefusal::WorkspaceNotFound));
        }
        let Some(muted) = muted else {
            return Ok(Err(AttentionPreferenceRefusal::InvalidInput));
        };
        sqlx::query(
            "INSERT INTO workspace_attention_preferences(user_id,workspace_id,muted,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,workspace_id) DO UPDATE SET muted=excluded.muted,updated_at=excluded.updated_at",
        )
        .bind(viewer.as_str())
        .bind(workspace.as_str())
        .bind(if muted { 1_i64 } else { 0_i64 })
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(AttentionPreferenceStoreError::from)?;
        let stored: i64 = sqlx::query_scalar(
            "SELECT muted FROM workspace_attention_preferences WHERE user_id=? AND workspace_id=?",
        )
        .bind(viewer.as_str())
        .bind(workspace.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(AttentionPreferenceStoreError::from)?;
        let stored = match stored {
            0 => false,
            1 => true,
            _ => return Err(AttentionPreferenceStoreError::MalformedMute.into()),
        };
        tx.commit()
            .await
            .map_err(AttentionPreferenceStoreError::from)?;
        Ok(Ok(CommittedAttentionPreference::workspace(
            viewer, workspace, stored,
        )))
    }
}
