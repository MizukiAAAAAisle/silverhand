//! One-snapshot SQLite projection for `GET /api/conversations/:id/unread`.

use silverhand_backend_core::{
    identity::{AgentId, ConversationId, UserId, WorkspaceId},
    messaging::collaboration::conversation_unread::{
        ConversationUnread, ConversationUnreadReadPort, ConversationUnreadRefusal, StreamUnread,
        ThreadUnread, UnreadCount,
    },
    messaging::{MessageId, MessageSeq, PrincipalIdentity, ThreadRootId},
    persistence::PersistenceFailure,
};
use sqlx::{Row, Sqlite, SqlitePool, Transaction, sqlite::SqliteRow};
use thiserror::Error;

use crate::{
    messaging::MessagingStore,
    unread_read::{followed_thread_branch, message_unread_guards, unread_guards},
};

use super::activity::valid_title_key_spelling;

const STREAM_UNREAD: &str = concat!(
    "WITH p(viewer,conv) AS (SELECT ?,?), stream_cursor AS (\
       SELECT sh.thread_root_id AS root, COALESCE(cr.last_read_seq,0) AS cursor_seq \
       FROM conversation_stream_heads sh LEFT JOIN conversation_reads cr ON \
       cr.user_id=(SELECT viewer FROM p) AND cr.conversation_id=sh.conversation_id AND \
       cr.thread_root_id IS sh.thread_root_id WHERE sh.conversation_id=(SELECT conv FROM p)\
     ), unread_tail AS (\
       SELECT sc.root AS root,m.id,m.seq,m.from_kind,m.from_user_id FROM stream_cursor sc \
       CROSS JOIN messages m ON \
       m.conversation_id=(SELECT conv FROM p) AND m.thread_root_id IS sc.root AND \
       m.seq>sc.cursor_seq WHERE ",
    message_unread_guards!(),
    "\
     ), per_stream AS (\
       SELECT root,COUNT(*) AS unread_count,MIN(seq) AS first_unread_seq, \
       MIN(CASE WHEN id<>'' AND seq>=0 AND (from_kind='agent' OR \
       (from_kind='user' AND from_user_id IS NOT NULL AND from_user_id<>'')) \
       THEN 1 ELSE 0 END) AS rows_valid FROM unread_tail \
       GROUP BY root\
     ) SELECT ps.root,m.id AS first_unread_message_id,ps.first_unread_seq,ps.unread_count, \
     ps.rows_valid \
     FROM per_stream ps JOIN messages m ON m.conversation_id=(SELECT conv FROM p) AND \
     m.seq=ps.first_unread_seq ORDER BY ps.root IS NOT NULL ASC,ps.root ASC"
);

const FOLLOWED_THREAD_UNREAD: &str = concat!(
    "WITH p(viewer,conv) AS (SELECT ?,?) SELECT EXISTS(SELECT 1 FROM messages m WHERE \
     m.conversation_id=(SELECT conv FROM p) AND ",
    unread_guards!(),
    " AND (",
    followed_thread_branch!(),
    "))"
);

#[derive(Clone)]
pub struct SqliteConversationUnreadRead {
    pool: SqlitePool,
}

impl<E> MessagingStore<E> {
    pub fn conversation_unread(&self) -> SqliteConversationUnreadRead {
        SqliteConversationUnreadRead {
            pool: self.pool.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ConversationUnreadStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("stored identity in the conversation-unread snapshot is malformed")]
    MalformedIdentity,
    #[error("stored conversation placement contradicts the current schema")]
    MalformedPlacement,
    #[error("stored conversation status is outside the published closed set")]
    MalformedStatus,
    #[error("stored unread ordinal or count is outside its domain")]
    MalformedUnread,
    #[error("stored stream-unread rows do not form a sparse set")]
    MalformedStreamSet,
}

impl From<ConversationUnreadStoreError> for PersistenceFailure {
    fn from(value: ConversationUnreadStoreError) -> Self {
        Self::from_source(value)
    }
}

#[derive(Debug)]
enum Placement {
    Workspace(WorkspaceId),
    DirectPair(PrincipalIdentity, PrincipalIdentity),
}

impl ConversationUnreadReadPort for SqliteConversationUnreadRead {
    type Error = PersistenceFailure;

    async fn read(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> Result<Result<ConversationUnread, ConversationUnreadRefusal>, Self::Error> {
        self.read_inner(viewer, conversation)
            .await
            .map_err(PersistenceFailure::from)
    }
}

impl SqliteConversationUnreadRead {
    async fn read_inner(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> Result<Result<ConversationUnread, ConversationUnreadRefusal>, ConversationUnreadStoreError>
    {
        let mut tx = self.pool.begin_with("BEGIN DEFERRED").await?;
        let Some(row) = sqlx::query(
            "SELECT id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,\
             endpoint_a_kind,endpoint_a_id,endpoint_a_deleted_at,\
             endpoint_b_kind,endpoint_b_id,endpoint_b_deleted_at \
             FROM conversations WHERE id=?",
        )
        .bind(conversation.as_str())
        .fetch_optional(&mut *tx)
        .await?
        else {
            tx.commit().await?;
            return Ok(Err(ConversationUnreadRefusal::NotFound));
        };
        let stored = ConversationId::parse(row.try_get::<String, _>("id")?)
            .map_err(|_| ConversationUnreadStoreError::MalformedIdentity)?;
        if &stored != conversation {
            return Err(ConversationUnreadStoreError::MalformedIdentity);
        }
        let placement = decode_placement(&row)?;
        if !participates(&mut tx, viewer, conversation, &placement).await? {
            tx.commit().await?;
            return Ok(Err(ConversationUnreadRefusal::Forbidden));
        }

        validate_streams(&mut tx, viewer, conversation).await?;

        let rows = sqlx::query(STREAM_UNREAD)
            .bind(viewer.as_str())
            .bind(conversation.as_str())
            .fetch_all(&mut *tx)
            .await?;
        let mut mainline = StreamUnread::caught_up();
        let mut threads = Vec::new();
        for row in rows {
            if row.try_get::<i64, _>("rows_valid")? != 1 {
                return Err(ConversationUnreadStoreError::MalformedUnread);
            }
            let count = UnreadCount::new(row.try_get("unread_count")?)
                .map_err(|_| ConversationUnreadStoreError::MalformedUnread)?;
            let unread = StreamUnread::unread(
                count,
                MessageId::parse(row.try_get::<String, _>("first_unread_message_id")?)
                    .map_err(|_| ConversationUnreadStoreError::MalformedIdentity)?,
                MessageSeq::try_from(row.try_get::<i64, _>("first_unread_seq")?)
                    .map_err(|_| ConversationUnreadStoreError::MalformedUnread)?,
            )
            .map_err(|_| ConversationUnreadStoreError::MalformedUnread)?;
            match row.try_get::<Option<String>, _>("root")? {
                None => {
                    if mainline.count() != 0 {
                        return Err(ConversationUnreadStoreError::MalformedStreamSet);
                    }
                    mainline = unread;
                }
                Some(root) => threads.push(
                    ThreadUnread::projected(
                        ThreadRootId::parse(root)
                            .map_err(|_| ConversationUnreadStoreError::MalformedIdentity)?,
                        unread,
                    )
                    .map_err(|_| ConversationUnreadStoreError::MalformedUnread)?,
                ),
            }
        }
        let followed_thread_unread: i64 = sqlx::query_scalar(FOLLOWED_THREAD_UNREAD)
            .bind(viewer.as_str())
            .bind(conversation.as_str())
            .fetch_one(&mut *tx)
            .await?;
        if !matches!(followed_thread_unread, 0 | 1) {
            return Err(ConversationUnreadStoreError::MalformedUnread);
        }
        let value =
            ConversationUnread::projected(stored, mainline, threads, followed_thread_unread == 1)
                .map_err(|_| ConversationUnreadStoreError::MalformedStreamSet)?;
        tx.commit().await?;
        Ok(Ok(value))
    }
}

async fn validate_streams(
    tx: &mut Transaction<'_, Sqlite>,
    viewer: &UserId,
    conversation: &ConversationId,
) -> Result<(), ConversationUnreadStoreError> {
    let rows = sqlx::query(
        "SELECT sh.thread_root_id,sh.latest_seq,cr.last_read_seq,\
         CASE WHEN sh.thread_root_id IS NULL THEN 1 ELSE EXISTS(\
           SELECT 1 FROM messages root WHERE root.id=sh.thread_root_id AND \
           root.conversation_id=sh.conversation_id AND root.thread_root_id IS NULL\
         ) END AS valid_root \
         FROM conversation_stream_heads sh LEFT JOIN conversation_reads cr ON \
         cr.user_id=? AND cr.conversation_id=sh.conversation_id AND \
         cr.thread_root_id IS sh.thread_root_id WHERE sh.conversation_id=? \
         ORDER BY sh.thread_root_id IS NOT NULL ASC,sh.thread_root_id ASC",
    )
    .bind(viewer.as_str())
    .bind(conversation.as_str())
    .fetch_all(&mut **tx)
    .await?;
    let mut previous: Option<Option<String>> = None;
    for row in rows {
        let root: Option<String> = row.try_get("thread_root_id")?;
        if previous.as_ref() == Some(&root) {
            return Err(ConversationUnreadStoreError::MalformedStreamSet);
        }
        previous = Some(root.clone());
        MessageSeq::try_from(row.try_get::<i64, _>("latest_seq")?)
            .map_err(|_| ConversationUnreadStoreError::MalformedUnread)?;
        if let Some(cursor) = row.try_get::<Option<i64>, _>("last_read_seq")? {
            MessageSeq::try_from(cursor)
                .map_err(|_| ConversationUnreadStoreError::MalformedUnread)?;
        }
        if let Some(root) = root {
            ThreadRootId::parse(root)
                .map_err(|_| ConversationUnreadStoreError::MalformedIdentity)?;
            if row.try_get::<i64, _>("valid_root")? != 1 {
                return Err(ConversationUnreadStoreError::MalformedStreamSet);
            }
        }
    }
    Ok(())
}

fn decode_placement(row: &SqliteRow) -> Result<Placement, ConversationUnreadStoreError> {
    let status: String = row.try_get("status")?;
    if !matches!(
        status.as_str(),
        "starting" | "active" | "idle" | "archived" | "crashed"
    ) {
        return Err(ConversationUnreadStoreError::MalformedStatus);
    }
    let placement: String = row.try_get("placement_kind")?;
    let roster: String = row.try_get("roster_policy")?;
    let visibility: String = row.try_get("visibility")?;
    let workspace: Option<String> = row.try_get("workspace_id")?;
    let title: String = row.try_get("title")?;
    let title_key: Option<String> = row.try_get("title_key")?;
    let a_kind: Option<String> = row.try_get("endpoint_a_kind")?;
    let a_id: Option<String> = row.try_get("endpoint_a_id")?;
    let a_deleted: Option<i64> = row.try_get("endpoint_a_deleted_at")?;
    let b_kind: Option<String> = row.try_get("endpoint_b_kind")?;
    let b_id: Option<String> = row.try_get("endpoint_b_id")?;
    let b_deleted: Option<i64> = row.try_get("endpoint_b_deleted_at")?;
    match placement.as_str() {
        "workspace" => {
            if !matches!(roster.as_str(), "open" | "fixed")
                || !matches!(visibility.as_str(), "private" | "public")
                || (visibility == "public" && roster != "open")
                || title.is_empty()
                || !title_key.as_deref().is_some_and(valid_title_key_spelling)
                || a_kind.is_some()
                || a_id.is_some()
                || a_deleted.is_some()
                || b_kind.is_some()
                || b_id.is_some()
                || b_deleted.is_some()
            {
                return Err(ConversationUnreadStoreError::MalformedPlacement);
            }
            let workspace = WorkspaceId::parse(
                workspace.ok_or(ConversationUnreadStoreError::MalformedPlacement)?,
            )
            .map_err(|_| ConversationUnreadStoreError::MalformedIdentity)?;
            Ok(Placement::Workspace(workspace))
        }
        "direct_pair" => {
            if workspace.is_some()
                || title_key.is_some()
                || roster != "fixed"
                || visibility != "private"
            {
                return Err(ConversationUnreadStoreError::MalformedPlacement);
            }
            let a_coordinate = a_kind
                .as_ref()
                .zip(a_id.as_ref())
                .ok_or(ConversationUnreadStoreError::MalformedPlacement)?;
            let b_coordinate = b_kind
                .as_ref()
                .zip(b_id.as_ref())
                .ok_or(ConversationUnreadStoreError::MalformedPlacement)?;
            if a_coordinate >= b_coordinate {
                return Err(ConversationUnreadStoreError::MalformedPlacement);
            }
            Ok(Placement::DirectPair(
                decode_endpoint(a_kind, a_id)?,
                decode_endpoint(b_kind, b_id)?,
            ))
        }
        _ => Err(ConversationUnreadStoreError::MalformedPlacement),
    }
}

fn decode_endpoint(
    kind: Option<String>,
    id: Option<String>,
) -> Result<PrincipalIdentity, ConversationUnreadStoreError> {
    let id = id
        .filter(|value| !value.is_empty())
        .ok_or(ConversationUnreadStoreError::MalformedIdentity)?;
    match kind.as_deref() {
        Some("human") => UserId::parse(id)
            .map(PrincipalIdentity::Human)
            .map_err(|_| ConversationUnreadStoreError::MalformedIdentity),
        Some("agent") => AgentId::parse(id)
            .map(PrincipalIdentity::Agent)
            .map_err(|_| ConversationUnreadStoreError::MalformedIdentity),
        _ => Err(ConversationUnreadStoreError::MalformedPlacement),
    }
}

async fn participates(
    tx: &mut Transaction<'_, Sqlite>,
    viewer: &UserId,
    conversation: &ConversationId,
    placement: &Placement,
) -> Result<bool, ConversationUnreadStoreError> {
    match placement {
        Placement::DirectPair(a, b) => Ok([a, b]
            .into_iter()
            .any(|endpoint| matches!(endpoint, PrincipalIdentity::Human(id) if id == viewer))),
        Placement::Workspace(workspace) => {
            let admitted: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?) \
                 AND EXISTS(SELECT 1 FROM workspace_users WHERE workspace_id=? AND user_id=?) \
                 AND EXISTS(SELECT 1 FROM conversation_users WHERE conversation_id=? AND user_id=?)",
            )
            .bind(workspace.as_str())
            .bind(workspace.as_str())
            .bind(viewer.as_str())
            .bind(conversation.as_str())
            .bind(viewer.as_str())
            .fetch_one(&mut **tx)
            .await?;
            Ok(admitted == 1)
        }
    }
}
