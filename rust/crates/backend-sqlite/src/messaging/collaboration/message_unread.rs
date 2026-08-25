//! One-snapshot SQLite projections for the three roll-up message-unread reads.

use std::collections::BTreeMap;

use silverhand_backend_core::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::collaboration::message_unread::{
        ConversationMessageUnread, ConversationMessageUnreadReadPort,
        ConversationMessageUnreadRefusal, LatestUnreadPointer, NonZeroUnreadCount, UnreadCount,
        UnreadRollup, ViewerMessageUnreadSummary, ViewerMessageUnreadSummaryReadPort,
        WorkspaceConversationUnread, WorkspaceMessageUnread, WorkspaceMessageUnreadReadPort,
        WorkspaceMessageUnreadRefusal, WorkspaceUnreadTotal,
    },
    messaging::{MessageId, MessageSeq, ThreadRootId},
    persistence::PersistenceFailure,
};
use sqlx::{Row, SqlitePool, sqlite::SqliteRow};
use thiserror::Error;

use crate::{messaging::MessagingStore, unread_read::rollup_unread};

use super::conversation_unread::{
    ConversationUnreadStoreError, Placement, decode_placement, participates,
};

macro_rules! conversation_columns {
    () => {
        "c.id,c.workspace_id,c.placement_kind,c.roster_policy,c.title,\
         c.title_key,c.status,c.visibility,c.endpoint_a_kind,c.endpoint_a_id,c.endpoint_a_deleted_at,\
         c.endpoint_b_kind,c.endpoint_b_id,c.endpoint_b_deleted_at"
    };
}

macro_rules! candidate_columns {
    () => {
        "m.conversation_id AS message_conversation_id,m.id AS message_id,m.seq,\
         m.thread_root_id,m.from_kind,m.from_user_id,m.from_agent_id,\
         CASE WHEN m.thread_root_id IS NULL THEN 1 ELSE EXISTS(SELECT 1 FROM messages root WHERE \
         root.id=m.thread_root_id AND root.conversation_id=m.conversation_id AND \
         root.thread_root_id IS NULL) END AS root_valid,\
         CASE WHEN m.from_kind='user' THEN EXISTS(SELECT 1 FROM users u WHERE u.id=m.from_user_id) \
         WHEN m.from_kind='agent' THEN EXISTS(SELECT 1 FROM agents a WHERE a.id=m.from_agent_id) \
         ELSE 0 END AS author_valid"
    };
}

const WORKSPACE_CANDIDATES: &str = concat!(
    "WITH p(viewer,ws) AS (SELECT ?,?) SELECT ",
    conversation_columns!(),
    ",",
    candidate_columns!(),
    " FROM conversations c JOIN conversation_users cu ON cu.conversation_id=c.id AND \
     cu.user_id=(SELECT viewer FROM p) JOIN messages m ON m.conversation_id=c.id AND ",
    rollup_unread!(),
    " WHERE c.workspace_id=(SELECT ws FROM p) ORDER BY c.id ASC,m.seq ASC,m.id ASC"
);

const SUMMARY_CANDIDATES: &str = concat!(
    "WITH p(viewer) AS (SELECT ?) SELECT ",
    conversation_columns!(),
    ",cu.user_id AS source_viewer,",
    candidate_columns!(),
    " FROM conversations c JOIN conversation_users cu ON cu.conversation_id=c.id AND \
     cu.user_id=(SELECT viewer FROM p) JOIN messages m ON m.conversation_id=c.id AND ",
    rollup_unread!(),
    " ORDER BY c.workspace_id ASC,c.id ASC,m.seq ASC,m.id ASC"
);

const CONVERSATION_CANDIDATES: &str = concat!(
    "WITH p(viewer,conv) AS (SELECT ?,?) SELECT ",
    candidate_columns!(),
    " FROM messages m WHERE m.conversation_id=(SELECT conv FROM p) AND ",
    rollup_unread!(),
    " ORDER BY m.seq ASC,m.id ASC"
);

#[derive(Clone)]
pub struct SqliteMessageUnreadRead {
    pool: SqlitePool,
}

impl<E> MessagingStore<E> {
    pub fn message_unread(&self) -> SqliteMessageUnreadRead {
        SqliteMessageUnreadRead {
            pool: self.pool.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum MessageUnreadStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("conversation access snapshot is malformed")]
    Access(#[from] ConversationUnreadStoreError),
    #[error("stored message-unread identity is malformed")]
    MalformedIdentity,
    #[error("stored message-unread ordinal or count is malformed")]
    MalformedUnread,
    #[error("stored unread candidate has an invalid author or thread root")]
    MalformedCandidate,
    #[error("stored unread candidates do not form a closed projection")]
    MalformedProjection,
}

impl From<MessageUnreadStoreError> for PersistenceFailure {
    fn from(value: MessageUnreadStoreError) -> Self {
        Self::from_source(value)
    }
}

impl WorkspaceMessageUnreadReadPort for SqliteMessageUnreadRead {
    type Error = PersistenceFailure;

    async fn read_workspace(
        &self,
        viewer: &UserId,
        workspace: &WorkspaceId,
    ) -> Result<Result<WorkspaceMessageUnread, WorkspaceMessageUnreadRefusal>, Self::Error> {
        self.read_workspace_inner(viewer, workspace)
            .await
            .map_err(PersistenceFailure::from)
    }
}

impl ViewerMessageUnreadSummaryReadPort for SqliteMessageUnreadRead {
    type Error = PersistenceFailure;

    async fn read_summary(
        &self,
        viewer: &UserId,
    ) -> Result<ViewerMessageUnreadSummary, Self::Error> {
        self.read_summary_inner(viewer)
            .await
            .map_err(PersistenceFailure::from)
    }
}

impl ConversationMessageUnreadReadPort for SqliteMessageUnreadRead {
    type Error = PersistenceFailure;

    async fn read_conversation(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> Result<Result<ConversationMessageUnread, ConversationMessageUnreadRefusal>, Self::Error>
    {
        self.read_conversation_inner(viewer, conversation)
            .await
            .map_err(PersistenceFailure::from)
    }
}

impl SqliteMessageUnreadRead {
    async fn read_workspace_inner(
        &self,
        viewer: &UserId,
        requested: &WorkspaceId,
    ) -> Result<
        Result<WorkspaceMessageUnread, WorkspaceMessageUnreadRefusal>,
        MessageUnreadStoreError,
    > {
        let mut tx = self.pool.begin_with("BEGIN DEFERRED").await?;
        let Some(raw_workspace) =
            sqlx::query_scalar::<_, String>("SELECT id FROM workspaces WHERE id=?")
                .bind(requested.as_str())
                .fetch_optional(&mut *tx)
                .await?
        else {
            tx.commit().await?;
            return Ok(Err(WorkspaceMessageUnreadRefusal::NotFound));
        };
        let workspace = WorkspaceId::parse(raw_workspace)
            .map_err(|_| MessageUnreadStoreError::MalformedIdentity)?;
        if &workspace != requested {
            return Err(MessageUnreadStoreError::MalformedIdentity);
        }
        let member: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM workspace_users WHERE workspace_id=? AND user_id=?)",
        )
        .bind(workspace.as_str())
        .bind(viewer.as_str())
        .fetch_one(&mut *tx)
        .await?;
        if member != 1 {
            tx.commit().await?;
            return Ok(Err(WorkspaceMessageUnreadRefusal::Forbidden));
        }

        let rows = sqlx::query(WORKSPACE_CANDIDATES)
            .bind(viewer.as_str())
            .bind(workspace.as_str())
            .fetch_all(&mut *tx)
            .await?;
        let candidates = decode_workspace_candidates(rows, &workspace)?;
        let projection = workspace_projection(workspace, candidates)?;
        tx.commit().await?;
        Ok(Ok(projection))
    }

    async fn read_summary_inner(
        &self,
        viewer: &UserId,
    ) -> Result<ViewerMessageUnreadSummary, MessageUnreadStoreError> {
        let mut tx = self.pool.begin_with("BEGIN DEFERRED").await?;
        let rows = sqlx::query(SUMMARY_CANDIDATES)
            .bind(viewer.as_str())
            .fetch_all(&mut *tx)
            .await?;
        let mut totals = BTreeMap::<String, (UserId, WorkspaceId, i64)>::new();
        for row in rows {
            let source_viewer = UserId::parse(row.try_get::<String, _>("source_viewer")?)
                .map_err(|_| MessageUnreadStoreError::MalformedIdentity)?;
            let placement = decode_placement(&row)?;
            let Placement::Workspace(workspace) = placement else {
                return Err(MessageUnreadStoreError::MalformedProjection);
            };
            let candidate = decode_candidate(&row)?;
            let source_conversation = ConversationId::parse(row.try_get::<String, _>("id")?)
                .map_err(|_| MessageUnreadStoreError::MalformedIdentity)?;
            if candidate.conversation != source_conversation {
                return Err(MessageUnreadStoreError::MalformedIdentity);
            }
            let entry = totals.entry(workspace.as_str().to_owned()).or_insert((
                source_viewer.clone(),
                workspace,
                0,
            ));
            if entry.0 != source_viewer {
                return Err(MessageUnreadStoreError::MalformedProjection);
            }
            entry.2 = entry
                .2
                .checked_add(1)
                .ok_or(MessageUnreadStoreError::MalformedUnread)?;
        }
        let projected = totals
            .into_values()
            .map(|(source_viewer, workspace, count)| {
                let count = UnreadCount::new(count)
                    .map_err(|_| MessageUnreadStoreError::MalformedUnread)?;
                let count = NonZeroUnreadCount::new(count)
                    .map_err(|_| MessageUnreadStoreError::MalformedUnread)?;
                Ok(WorkspaceUnreadTotal::projected(
                    source_viewer,
                    workspace,
                    count,
                ))
            })
            .collect::<Result<Vec<_>, MessageUnreadStoreError>>()?;
        let summary = ViewerMessageUnreadSummary::projected(viewer.clone(), projected)
            .map_err(|_| MessageUnreadStoreError::MalformedProjection)?;
        tx.commit().await?;
        Ok(summary)
    }

    async fn read_conversation_inner(
        &self,
        viewer: &UserId,
        requested: &ConversationId,
    ) -> Result<
        Result<ConversationMessageUnread, ConversationMessageUnreadRefusal>,
        MessageUnreadStoreError,
    > {
        let mut tx = self.pool.begin_with("BEGIN DEFERRED").await?;
        let Some(row) = sqlx::query(
            "SELECT id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,\
             endpoint_a_kind,endpoint_a_id,endpoint_a_deleted_at,\
             endpoint_b_kind,endpoint_b_id,endpoint_b_deleted_at FROM conversations WHERE id=?",
        )
        .bind(requested.as_str())
        .fetch_optional(&mut *tx)
        .await?
        else {
            tx.commit().await?;
            return Ok(Err(ConversationMessageUnreadRefusal::NotFound));
        };
        let stored = ConversationId::parse(row.try_get::<String, _>("id")?)
            .map_err(|_| MessageUnreadStoreError::MalformedIdentity)?;
        if &stored != requested {
            return Err(MessageUnreadStoreError::MalformedIdentity);
        }
        let placement = decode_placement(&row)?;
        if !participates(&mut tx, viewer, requested, &placement).await? {
            tx.commit().await?;
            return Ok(Err(ConversationMessageUnreadRefusal::Forbidden));
        }
        let rows = sqlx::query(CONVERSATION_CANDIDATES)
            .bind(viewer.as_str())
            .bind(stored.as_str())
            .fetch_all(&mut *tx)
            .await?;
        let mut candidates = Vec::with_capacity(rows.len());
        for row in rows {
            let candidate = decode_candidate(&row)?;
            if candidate.conversation != stored {
                return Err(MessageUnreadStoreError::MalformedIdentity);
            }
            candidates.push(candidate);
        }
        let rollup = rollup(&stored, candidates)?;
        let projection = ConversationMessageUnread::projected(stored, rollup)
            .map_err(|_| MessageUnreadStoreError::MalformedProjection)?;
        tx.commit().await?;
        Ok(Ok(projection))
    }
}

struct Candidate {
    conversation: ConversationId,
    message: MessageId,
    seq: MessageSeq,
    thread_root: Option<ThreadRootId>,
}

fn decode_candidate(row: &SqliteRow) -> Result<Candidate, MessageUnreadStoreError> {
    if row.try_get::<i64, _>("root_valid")? != 1 || row.try_get::<i64, _>("author_valid")? != 1 {
        return Err(MessageUnreadStoreError::MalformedCandidate);
    }
    let from_kind: String = row.try_get("from_kind")?;
    let from_user: Option<String> = row.try_get("from_user_id")?;
    let from_agent: Option<String> = row.try_get("from_agent_id")?;
    match from_kind.as_str() {
        "user" if from_user.as_deref().is_some_and(|id| !id.is_empty()) && from_agent.is_none() => {
        }
        "agent"
            if from_agent.as_deref().is_some_and(|id| !id.is_empty()) && from_user.is_none() => {}
        _ => return Err(MessageUnreadStoreError::MalformedCandidate),
    }
    Ok(Candidate {
        conversation: ConversationId::parse(row.try_get::<String, _>("message_conversation_id")?)
            .map_err(|_| MessageUnreadStoreError::MalformedIdentity)?,
        message: MessageId::parse(row.try_get::<String, _>("message_id")?)
            .map_err(|_| MessageUnreadStoreError::MalformedIdentity)?,
        seq: MessageSeq::try_from(row.try_get::<i64, _>("seq")?)
            .map_err(|_| MessageUnreadStoreError::MalformedUnread)?,
        thread_root: row
            .try_get::<Option<String>, _>("thread_root_id")?
            .map(ThreadRootId::parse)
            .transpose()
            .map_err(|_| MessageUnreadStoreError::MalformedIdentity)?,
    })
}

fn decode_workspace_candidates(
    rows: Vec<SqliteRow>,
    requested: &WorkspaceId,
) -> Result<Vec<Candidate>, MessageUnreadStoreError> {
    let mut candidates = Vec::with_capacity(rows.len());
    for row in rows {
        let placement = decode_placement(&row)?;
        if !matches!(placement, Placement::Workspace(ref workspace) if workspace == requested) {
            return Err(MessageUnreadStoreError::MalformedProjection);
        }
        let source_conversation = ConversationId::parse(row.try_get::<String, _>("id")?)
            .map_err(|_| MessageUnreadStoreError::MalformedIdentity)?;
        let candidate = decode_candidate(&row)?;
        if candidate.conversation != source_conversation {
            return Err(MessageUnreadStoreError::MalformedIdentity);
        }
        candidates.push(candidate);
    }
    Ok(candidates)
}

fn rollup(
    conversation: &ConversationId,
    candidates: Vec<Candidate>,
) -> Result<UnreadRollup, MessageUnreadStoreError> {
    let count =
        i64::try_from(candidates.len()).map_err(|_| MessageUnreadStoreError::MalformedUnread)?;
    let latest = candidates.last().map(|candidate| {
        LatestUnreadPointer::projected(
            candidate.conversation.clone(),
            candidate.message.clone(),
            candidate.seq,
            candidate.thread_root.clone(),
        )
    });
    if candidates.windows(2).any(|pair| pair[0].seq >= pair[1].seq)
        || candidates
            .iter()
            .any(|candidate| &candidate.conversation != conversation)
    {
        return Err(MessageUnreadStoreError::MalformedProjection);
    }
    UnreadRollup::projected(
        UnreadCount::new(count).map_err(|_| MessageUnreadStoreError::MalformedUnread)?,
        latest,
    )
    .map_err(|_| MessageUnreadStoreError::MalformedProjection)
}

fn workspace_projection(
    workspace: WorkspaceId,
    candidates: Vec<Candidate>,
) -> Result<WorkspaceMessageUnread, MessageUnreadStoreError> {
    let mut grouped = BTreeMap::<String, (ConversationId, Vec<Candidate>)>::new();
    for candidate in candidates {
        grouped
            .entry(candidate.conversation.as_str().to_owned())
            .or_insert_with(|| (candidate.conversation.clone(), Vec::new()))
            .1
            .push(candidate);
    }
    let mut rows = Vec::with_capacity(grouped.len());
    for (_, (conversation, candidates)) in grouped {
        let unread = match rollup(&conversation, candidates)? {
            UnreadRollup::Unread(value) => value,
            UnreadRollup::CaughtUp => return Err(MessageUnreadStoreError::MalformedProjection),
        };
        rows.push(
            WorkspaceConversationUnread::projected(workspace.clone(), conversation, unread)
                .map_err(|_| MessageUnreadStoreError::MalformedProjection)?,
        );
    }
    WorkspaceMessageUnread::projected(workspace, rows)
        .map_err(|_| MessageUnreadStoreError::MalformedProjection)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_candidate_carries_the_membership_rows_viewer_not_a_rebound_label() {
        assert!(SUMMARY_CANDIDATES.contains("cu.user_id AS source_viewer"));
        assert!(!SUMMARY_CANDIDATES.contains("(SELECT viewer FROM p) AS source_viewer"));
    }
}
