//! One-snapshot SQLite projection for persisted conversation-agent activity.

use serde_json::Value;
use silverhand_backend_core::{
    identity::{AgentId, ConversationId, UserId},
    messaging::{
        PrincipalIdentity,
        collaboration::{
            channel_directory::{ChannelVisibility, DirectoryRoster},
            channel_lifecycle::ChannelLifecyclePlacement,
            conversation_agent_activity::{
                ActivityCreatedAt, ActivityEventId, ActivityPageRequest, ActivityPayload,
                ConversationActivityEvent, ConversationActivityKind, ConversationAgentActivityPage,
                ConversationAgentActivityReadPort, ConversationAgentActivityRefusal,
            },
        },
    },
    persistence::PersistenceFailure,
};
use sqlx::{Row, SqlitePool};
use thiserror::Error;

use crate::messaging::{MessagingStore, SELECT_AGENT_PARTICIPATES};

use super::channel_lifecycle::{
    ChannelLifecycleStoreError, load_channel_row, load_human_members, load_workspace_role,
};

#[derive(Clone)]
pub struct SqliteConversationAgentActivityRead {
    pool: SqlitePool,
}

impl<E> MessagingStore<E> {
    pub fn conversation_agent_activity(&self) -> SqliteConversationAgentActivityRead {
        SqliteConversationAgentActivityRead {
            pool: self.pool.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ConversationAgentActivityStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("conversation access snapshot is malformed")]
    Access(#[from] ChannelLifecycleStoreError),
    #[error("stored conversation activity identity is malformed")]
    Identity,
    #[error("stored conversation activity id is outside its domain")]
    EventId,
    #[error("stored conversation activity kind is outside the closed set")]
    Kind,
    #[error("stored conversation activity payload is not valid JSON")]
    Payload,
    #[error("stored conversation activity created_at is outside its wire domain")]
    CreatedAt,
    #[error("stored conversation activity page is not a closed ordered projection")]
    Page,
}

impl From<ConversationAgentActivityStoreError> for PersistenceFailure {
    fn from(value: ConversationAgentActivityStoreError) -> Self {
        Self::from_source(value)
    }
}

impl ConversationAgentActivityReadPort for SqliteConversationAgentActivityRead {
    type Error = PersistenceFailure;

    async fn read(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
        agent: &AgentId,
        page: ActivityPageRequest,
    ) -> Result<Result<ConversationAgentActivityPage, ConversationAgentActivityRefusal>, Self::Error>
    {
        self.read_inner(viewer, conversation, agent, page)
            .await
            .map_err(PersistenceFailure::from)
    }
}

impl SqliteConversationAgentActivityRead {
    async fn read_inner(
        &self,
        viewer: &UserId,
        requested: &ConversationId,
        target: &AgentId,
        page: ActivityPageRequest,
    ) -> Result<
        Result<ConversationAgentActivityPage, ConversationAgentActivityRefusal>,
        ConversationAgentActivityStoreError,
    > {
        let mut tx = self.pool.begin_with("BEGIN DEFERRED").await?;
        let Some(channel) = load_channel_row(&mut tx, requested).await? else {
            tx.commit().await?;
            return Ok(Err(ConversationAgentActivityRefusal::NotFound));
        };

        // Reuse the detail face's complete selected membership and role decode.
        // Public visibility may widen the viewer gate, but never hides a broken
        // membership row or weakens target-agent participation below.
        let human_members = load_human_members(&mut tx, requested).await?;
        let stored_member = human_members.iter().any(|member| member == viewer);
        let visible = match channel.placement() {
            ChannelLifecyclePlacement::Workspace(workspace) => {
                let workspace_exists: bool =
                    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspaces w WHERE w.id=?)")
                        .bind(workspace.workspace().as_str())
                        .fetch_one(&mut *tx)
                        .await?;
                let role = if workspace_exists {
                    load_workspace_role(&mut tx, viewer, workspace.workspace()).await?
                } else {
                    None
                };
                let is_member = role.is_some() && stored_member;
                let public_widen = role.is_some()
                    && workspace.roster() == DirectoryRoster::Open
                    && channel.visibility() == ChannelVisibility::Public
                    && channel.archived_at().is_none();
                is_member || public_widen
            }
            ChannelLifecyclePlacement::DirectPair(participants) => participants
                .both()
                .contains(&&PrincipalIdentity::Human(viewer.clone())),
        };
        if !visible {
            tx.commit().await?;
            return Ok(Err(ConversationAgentActivityRefusal::Forbidden));
        }

        let target_participates: Option<i64> = sqlx::query_scalar(SELECT_AGENT_PARTICIPATES)
            .bind(requested.as_str())
            .bind(target.as_str())
            .bind(target.as_str())
            .bind(target.as_str())
            .fetch_optional(&mut *tx)
            .await?;
        if target_participates.is_none() {
            tx.commit().await?;
            return Ok(Err(ConversationAgentActivityRefusal::TargetNotParticipant));
        }

        let selected = sqlx::query(
            "SELECT id,conversation_id,agent_id,kind,payload,created_at \
             FROM conversation_events \
             WHERE conversation_id=? AND agent_id=? AND (? IS NULL OR id < ?) \
             ORDER BY id DESC LIMIT ?",
        )
        .bind(requested.as_str())
        .bind(target.as_str())
        .bind(page.before().and_then(|value| value.persisted_value()))
        .bind(page.before().and_then(|value| value.persisted_value()))
        .bind(i64::from(page.limit()) + 1)
        .fetch_all(&mut *tx)
        .await?;

        // Decode every selected row, including the look-ahead row, before
        // slicing or reversing. A malformed has-more candidate cannot vanish
        // behind pagination.
        let mut decoded = Vec::with_capacity(selected.len());
        for row in selected {
            let id = ActivityEventId::new(row.try_get("id")?)
                .map_err(|_| ConversationAgentActivityStoreError::EventId)?;
            let conversation = ConversationId::parse(row.try_get::<String, _>("conversation_id")?)
                .map_err(|_| ConversationAgentActivityStoreError::Identity)?;
            let agent = row
                .try_get::<Option<String>, _>("agent_id")?
                .map(AgentId::parse)
                .transpose()
                .map_err(|_| ConversationAgentActivityStoreError::Identity)?;
            let kind = ConversationActivityKind::parse(&row.try_get::<String, _>("kind")?)
                .map_err(|_| ConversationAgentActivityStoreError::Kind)?;
            let payload = decode_payload(row.try_get("payload")?)?;
            let created_at = ActivityCreatedAt::new(row.try_get("created_at")?)
                .map_err(|_| ConversationAgentActivityStoreError::CreatedAt)?;
            decoded.push(ConversationActivityEvent::projected(
                id,
                conversation,
                agent,
                kind,
                payload,
                created_at,
            ));
        }

        let limit = usize::from(page.limit());
        let has_more = decoded.len() > limit;
        decoded.truncate(limit);
        decoded.reverse();
        let next_before = has_more.then(|| {
            decoded
                .first()
                .expect("a positive page limit with a look-ahead row retains one event")
                .id()
        });
        let page = ConversationAgentActivityPage::projected(
            requested.clone(),
            target.clone(),
            decoded,
            next_before,
        )
        .map_err(|_| ConversationAgentActivityStoreError::Page)?;
        tx.commit().await?;
        Ok(Ok(page))
    }
}

fn decode_payload(
    raw: Option<String>,
) -> Result<ActivityPayload, ConversationAgentActivityStoreError> {
    let Some(raw) = raw else {
        return Ok(ActivityPayload::Null);
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|_| ConversationAgentActivityStoreError::Payload)?;
    match parsed {
        Value::Object(object) => Ok(ActivityPayload::object_json(
            Value::Object(object).to_string(),
        )),
        _ => Ok(ActivityPayload::Null),
    }
}
