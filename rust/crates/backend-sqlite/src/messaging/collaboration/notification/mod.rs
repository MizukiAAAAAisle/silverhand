use crate::messaging::{HostEnvironment, MessagingStore};
use silverhand_backend_core::{
    identity::{AgentId, ConversationId, UserId, WorkspaceId},
    messaging::{MessageId, SendClock, ThreadRootId, collaboration::notification::*},
    persistence::PersistenceFailure,
};
use sqlx::{Row, SqlitePool, sqlite::SqliteRow};
use thiserror::Error;

#[derive(Clone)]
pub struct SqliteNotificationStore<E = HostEnvironment> {
    pool: SqlitePool,
    environment: E,
}
impl<E: Clone> MessagingStore<E> {
    pub fn notifications(&self) -> SqliteNotificationStore<E> {
        SqliteNotificationStore {
            pool: self.pool.clone(),
            environment: self.environment.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum NotificationStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("stored notification identity is malformed")]
    MalformedIdentity,
    #[error("stored notification kind is malformed")]
    MalformedKind,
    #[error("stored notification timestamp is malformed")]
    MalformedTimestamp,
    #[error("stored notification payload is not a JSON object")]
    MalformedPayload,
    #[error("clock failed")]
    Clock(#[source] silverhand_backend_core::messaging::EnvironmentUnavailable),
}
impl From<NotificationStoreError> for PersistenceFailure {
    fn from(value: NotificationStoreError) -> Self {
        Self::from_source(value)
    }
}

fn opt<T>(
    raw: Option<String>,
    parse: impl FnOnce(String) -> Option<T>,
) -> Result<Option<T>, NotificationStoreError> {
    match raw {
        Some(raw) => parse(raw)
            .map(Some)
            .ok_or(NotificationStoreError::MalformedIdentity),
        None => Ok(None),
    }
}
fn decode(row: SqliteRow) -> Result<Notification, NotificationStoreError> {
    let payload_json: Option<String> = row.try_get("payload")?;
    if let Some(raw) = payload_json.as_deref()
        && !matches!(
            serde_json::from_str::<serde_json::Value>(raw),
            Ok(serde_json::Value::Object(_))
        )
    {
        return Err(NotificationStoreError::MalformedPayload);
    }
    Ok(Notification {
        id: NotificationId::parse(row.try_get::<String, _>("id")?)
            .ok_or(NotificationStoreError::MalformedIdentity)?,
        kind: NotificationKind::parse(row.try_get::<String, _>("kind")?.as_str())
            .ok_or(NotificationStoreError::MalformedKind)?,
        user: opt(row.try_get("user_id")?, |v| UserId::parse(v).ok())?,
        agent: opt(row.try_get("agent_id")?, |v| AgentId::parse(v).ok())?,
        workspace: opt(row.try_get("workspace_id")?, |v| WorkspaceId::parse(v).ok())?,
        conversation: opt(row.try_get("conversation_id")?, |v| {
            ConversationId::parse(v).ok()
        })?,
        message: opt(row.try_get("message_id")?, |v| MessageId::parse(v).ok())?,
        thread_root: opt(row.try_get("thread_root_id")?, |v| {
            ThreadRootId::parse(v).ok()
        })?,
        source_workspace: opt(row.try_get("source_workspace_id")?, |v| {
            WorkspaceId::parse(v).ok()
        })?,
        source_conversation: opt(row.try_get("source_conversation_id")?, |v| {
            ConversationId::parse(v).ok()
        })?,
        source_message: opt(row.try_get("source_message_id")?, |v| {
            MessageId::parse(v).ok()
        })?,
        payload_json,
        read_at: match row.try_get::<Option<i64>, _>("read_at")? {
            Some(value) => Some(
                NotificationTimestamp::new(value)
                    .ok_or(NotificationStoreError::MalformedTimestamp)?,
            ),
            None => None,
        },
        created_at: NotificationTimestamp::new(row.try_get("created_at")?)
            .ok_or(NotificationStoreError::MalformedTimestamp)?,
    })
}

impl<E: Clone + Send + Sync + 'static> NotificationReadPort for SqliteNotificationStore<E> {
    type Error = PersistenceFailure;
    async fn list(
        &self,
        viewer: &UserId,
        query: NotificationListQuery,
    ) -> Result<Vec<Notification>, Self::Error> {
        let rows = if query.unread_only {
            sqlx::query("SELECT n.id,n.kind,n.user_id,n.agent_id,n.workspace_id,n.conversation_id,n.message_id,m.thread_root_id,n.source_workspace_id,n.source_conversation_id,n.source_message_id,n.payload,n.read_at,n.created_at FROM notifications n LEFT JOIN messages m ON m.id=n.message_id WHERE n.user_id=? AND n.read_at IS NULL ORDER BY n.created_at DESC,n.id DESC LIMIT ?").bind(viewer.as_str()).bind(i64::from(query.limit)).fetch_all(&self.pool).await
        } else {
            sqlx::query("SELECT n.id,n.kind,n.user_id,n.agent_id,n.workspace_id,n.conversation_id,n.message_id,m.thread_root_id,n.source_workspace_id,n.source_conversation_id,n.source_message_id,n.payload,n.read_at,n.created_at FROM notifications n LEFT JOIN messages m ON m.id=n.message_id WHERE n.user_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT ?").bind(viewer.as_str()).bind(i64::from(query.limit)).fetch_all(&self.pool).await
        }.map_err(NotificationStoreError::from)?;
        rows.into_iter()
            .map(|r| decode(r).map_err(Into::into))
            .collect()
    }
    async fn unread_summary(&self, viewer: &UserId) -> Result<NotificationSummary, Self::Error> {
        let mut tx = self
            .pool
            .begin_with("BEGIN DEFERRED")
            .await
            .map_err(NotificationStoreError::from)?;
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NULL",
        )
        .bind(viewer.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(NotificationStoreError::from)?;
        let counts=sqlx::query("SELECT COALESCE(n.workspace_id,c.workspace_id) scope_id,COUNT(*) c FROM notifications n LEFT JOIN conversations c ON c.id=n.conversation_id WHERE n.user_id=? AND n.read_at IS NULL AND COALESCE(n.workspace_id,c.workspace_id) IS NOT NULL GROUP BY scope_id ORDER BY scope_id").bind(viewer.as_str()).fetch_all(&mut *tx).await.map_err(NotificationStoreError::from)?;
        let latest=sqlx::query("SELECT scope_id,conversation_id,message_id,thread_root_id FROM (SELECT COALESCE(n.workspace_id,c.workspace_id) scope_id,n.conversation_id,m.id message_id,m.thread_root_id,ROW_NUMBER() OVER(PARTITION BY COALESCE(n.workspace_id,c.workspace_id) ORDER BY n.created_at DESC,n.id DESC) rn FROM notifications n JOIN conversations c ON c.id=n.conversation_id JOIN messages m ON m.id=n.message_id WHERE n.user_id=? AND n.read_at IS NULL AND c.archived_at IS NULL) WHERE rn=1 ORDER BY scope_id").bind(viewer.as_str()).fetch_all(&mut *tx).await.map_err(NotificationStoreError::from)?;
        let by_workspace = counts
            .into_iter()
            .map(|r| {
                Ok((
                    WorkspaceId::parse(r.try_get::<String, _>("scope_id")?)
                        .map_err(|_| NotificationStoreError::MalformedIdentity)?,
                    u64::try_from(r.try_get::<i64, _>("c")?)
                        .map_err(|_| NotificationStoreError::MalformedTimestamp)?,
                ))
            })
            .collect::<Result<_, NotificationStoreError>>()?;
        let latest_by_workspace = latest
            .into_iter()
            .map(|r| {
                Ok((
                    WorkspaceId::parse(r.try_get::<String, _>("scope_id")?)
                        .map_err(|_| NotificationStoreError::MalformedIdentity)?,
                    UnreadAnchor {
                        conversation: ConversationId::parse(
                            r.try_get::<String, _>("conversation_id")?,
                        )
                        .map_err(|_| NotificationStoreError::MalformedIdentity)?,
                        message: MessageId::parse(r.try_get::<String, _>("message_id")?)
                            .map_err(|_| NotificationStoreError::MalformedIdentity)?,
                        thread_root: opt(r.try_get("thread_root_id")?, |v| {
                            ThreadRootId::parse(v).ok()
                        })?,
                    },
                ))
            })
            .collect::<Result<_, NotificationStoreError>>()?;
        tx.commit().await.map_err(NotificationStoreError::from)?;
        Ok(NotificationSummary {
            total: u64::try_from(total).map_err(|_| NotificationStoreError::MalformedTimestamp)?,
            by_workspace,
            latest_by_workspace,
        })
    }
}

impl<E: SendClock + Clone + Send + Sync + 'static> NotificationClearPort
    for SqliteNotificationStore<E>
{
    type Error = PersistenceFailure;
    async fn clear(
        &self,
        viewer: UserId,
        selector: NotificationClearSelector,
    ) -> Result<CommittedNotificationClear, Self::Error> {
        let now = self
            .environment
            .now_unix_ms()
            .map_err(NotificationStoreError::Clock)?;
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(NotificationStoreError::from)?;
        let rows = match &selector {
            NotificationClearSelector::Id(v) => sqlx::query("SELECT n.id,COALESCE(n.workspace_id,c.workspace_id) workspace_id FROM notifications n LEFT JOIN conversations c ON c.id=n.conversation_id WHERE n.user_id=? AND n.read_at IS NULL AND n.id=? ORDER BY n.id").bind(viewer.as_str()).bind(v.as_str()).fetch_all(&mut *tx).await,
            NotificationClearSelector::Workspace(v) => sqlx::query("SELECT n.id,COALESCE(n.workspace_id,c.workspace_id) workspace_id FROM notifications n LEFT JOIN conversations c ON c.id=n.conversation_id WHERE n.user_id=? AND n.read_at IS NULL AND n.workspace_id=? ORDER BY n.id").bind(viewer.as_str()).bind(v.as_str()).fetch_all(&mut *tx).await,
            NotificationClearSelector::Conversation(v) => sqlx::query("SELECT n.id,COALESCE(n.workspace_id,c.workspace_id) workspace_id FROM notifications n LEFT JOIN conversations c ON c.id=n.conversation_id WHERE n.user_id=? AND n.read_at IS NULL AND n.conversation_id=? ORDER BY n.id").bind(viewer.as_str()).bind(v.as_str()).fetch_all(&mut *tx).await,
            NotificationClearSelector::All => sqlx::query("SELECT n.id,COALESCE(n.workspace_id,c.workspace_id) workspace_id FROM notifications n LEFT JOIN conversations c ON c.id=n.conversation_id WHERE n.user_id=? AND n.read_at IS NULL ORDER BY n.id").bind(viewer.as_str()).fetch_all(&mut *tx).await,
        }.map_err(NotificationStoreError::from)?;
        let ids: Vec<String> = rows
            .iter()
            .map(|r| r.try_get("id"))
            .collect::<Result<_, _>>()
            .map_err(NotificationStoreError::from)?;
        let mut workspaces = std::collections::BTreeSet::new();
        for row in &rows {
            if let Some(raw) = row
                .try_get::<Option<String>, _>("workspace_id")
                .map_err(NotificationStoreError::from)?
            {
                workspaces.insert(raw);
            }
        }
        for id in &ids {
            sqlx::query(
                "UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL",
            )
            .bind(now)
            .bind(id)
            .bind(viewer.as_str())
            .execute(&mut *tx)
            .await
            .map_err(NotificationStoreError::from)?;
        }
        tx.commit().await.map_err(NotificationStoreError::from)?;
        Ok(CommittedNotificationClear::committed(
            viewer,
            ids.len() as u64,
            workspaces
                .into_iter()
                .map(|raw| {
                    WorkspaceId::parse(raw).map_err(|_| NotificationStoreError::MalformedIdentity)
                })
                .collect::<Result<Vec<_>, _>>()?,
        ))
    }
}
