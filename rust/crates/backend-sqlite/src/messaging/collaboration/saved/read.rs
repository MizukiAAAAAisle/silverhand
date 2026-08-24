use silverhand_backend_core::{
    identity::{AgentId, ConversationId, UserId, WorkspaceId},
    messaging::{
        AttachmentId, FromKind, MessageId, MessageSeq, PrincipalIdentity, ThreadRootId,
        attachments::AttachmentSnapshot,
        collaboration::saved::{
            SavedAt, SavedEntry, SavedEntryId, SavedLinkedTask, SavedListQuery, SavedMessage,
            SavedMessageProjection, SavedPlace, SavedReadPort, SavedReadRefusal, SavedTaskAssignee,
            SavedTaskNumber, SavedTaskStatus,
        },
    },
    persistence::PersistenceFailure,
};
use sqlx::{QueryBuilder, Row, Sqlite, sqlite::SqliteRow};

use crate::messaging::author::{AuthorEvidence, resolve_authors};

use super::{SELECT_JOINED, SavedStoreError, SqliteSavedStore, push_participates};

const LIST_LIMIT: i64 = 200;

impl<E> SavedReadPort for SqliteSavedStore<E>
where
    E: Clone + Send + Sync + 'static,
{
    type Error = PersistenceFailure;

    async fn list(
        &self,
        viewer: &UserId,
        query: SavedListQuery,
    ) -> Result<Result<Vec<SavedEntry>, SavedReadRefusal>, Self::Error> {
        let mut tx = self
            .pool
            .begin_with("BEGIN DEFERRED")
            .await
            .map_err(SavedStoreError::from)?;
        if let Some(workspace) = query.workspace.as_ref() {
            let exists: i64 =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?)")
                    .bind(workspace.as_str())
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(SavedStoreError::from)?;
            if exists == 0 {
                tx.rollback().await.map_err(SavedStoreError::from)?;
                return Ok(Err(SavedReadRefusal::WorkspaceNotFound));
            }
            let member: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?)",
            )
            .bind(workspace.as_str())
            .bind(viewer.as_str())
            .fetch_one(&mut *tx)
            .await
            .map_err(SavedStoreError::from)?;
            if member == 0 {
                tx.rollback().await.map_err(SavedStoreError::from)?;
                return Ok(Err(SavedReadRefusal::Forbidden));
            }
        }

        let mut builder = QueryBuilder::<Sqlite>::new(SELECT_JOINED);
        builder
            .push(" WHERE sm.user_id = ")
            .push_bind(viewer.as_str())
            .push(" AND ");
        push_participates(&mut builder, viewer.as_str());
        if let Some(workspace) = query.workspace.as_ref() {
            builder
                .push(" AND c.workspace_id = ")
                .push_bind(workspace.as_str());
        }
        if let Some(sender) = query.sender.as_ref() {
            builder
                .push(" AND m.from_kind = ")
                .push_bind(sender.kind())
                .push(" AND m.author_id = ")
                .push_bind(sender.id());
        }
        if let Some(since) = query.since {
            builder.push(" AND sm.saved_at >= ").push_bind(since.get());
        }
        builder
            .push(" ORDER BY sm.saved_at DESC, sm.id DESC LIMIT ")
            .push_bind(LIST_LIMIT);
        let rows = builder
            .build()
            .fetch_all(&mut *tx)
            .await
            .map_err(SavedStoreError::from)?;
        let entries = decode_entries(&mut tx, rows).await?;
        tx.commit().await.map_err(SavedStoreError::from)?;
        Ok(Ok(entries))
    }
}

pub(super) async fn decode_entries(
    conn: &mut sqlx::SqliteConnection,
    rows: Vec<SqliteRow>,
) -> Result<Vec<SavedEntry>, PersistenceFailure> {
    let evidence = rows
        .iter()
        .map(author_evidence)
        .collect::<Result<Vec<_>, _>>()?;
    let authors = resolve_authors(conn, &evidence).await?;
    rows.iter()
        .zip(authors)
        .map(|(row, author)| decode_entry(row, author))
        .collect()
}

fn author_evidence(row: &SqliteRow) -> Result<AuthorEvidence, PersistenceFailure> {
    Ok(AuthorEvidence {
        from_kind: decode_from_kind(row.try_get("from_kind").map_err(SavedStoreError::from)?)?,
        from_agent_id: row
            .try_get("from_agent_id")
            .map_err(SavedStoreError::from)?,
        from_user_id: row.try_get("from_user_id").map_err(SavedStoreError::from)?,
        author_id: row.try_get("author_id").map_err(SavedStoreError::from)?,
        author_name: row.try_get("author_name").map_err(SavedStoreError::from)?,
        author_display_name: row
            .try_get("author_display_name")
            .map_err(SavedStoreError::from)?,
    })
}

fn decode_entry(
    row: &SqliteRow,
    author: Option<silverhand_backend_core::messaging::MessageAuthor>,
) -> Result<SavedEntry, PersistenceFailure> {
    let saved_conversation = conversation_id(
        row.try_get("saved_conversation_id")
            .map_err(SavedStoreError::from)?,
    )?;
    let message_conversation = conversation_id(
        row.try_get("message_conversation_id")
            .map_err(SavedStoreError::from)?,
    )?;
    if saved_conversation != message_conversation {
        return Err(SavedStoreError::MismatchedConversation.into());
    }
    let place = match row
        .try_get::<String, _>("placement_kind")
        .map_err(SavedStoreError::from)?
        .as_str()
    {
        "workspace" => SavedPlace::WorkspaceChannel {
            conversation: saved_conversation.clone(),
            workspace: WorkspaceId::parse(
                row.try_get::<Option<String>, _>("workspace_id")
                    .map_err(SavedStoreError::from)?
                    .ok_or(SavedStoreError::MalformedPlacement)?,
            )
            .map_err(|_| SavedStoreError::MalformedIdentity)?,
            channel_name: row
                .try_get::<Option<String>, _>("channel_name")
                .map_err(SavedStoreError::from)?
                .ok_or(SavedStoreError::MalformedPlacement)?,
        },
        "direct_pair" => SavedPlace::DirectPair {
            conversation: saved_conversation.clone(),
        },
        _ => return Err(SavedStoreError::MalformedPlacement.into()),
    };
    let metadata_json: Option<String> = row.try_get("metadata").map_err(SavedStoreError::from)?;
    let attachments = decode_attachments(metadata_json.as_deref())?;
    let linked_task = decode_linked_task(row)?;
    let projection = SavedMessageProjection {
        id: message_id(row.try_get("message_id").map_err(SavedStoreError::from)?)?,
        conversation: message_conversation,
        from_kind: decode_from_kind(row.try_get("from_kind").map_err(SavedStoreError::from)?)?,
        from_agent: optional_agent(
            row.try_get("from_agent_id")
                .map_err(SavedStoreError::from)?,
        )?,
        from_user: optional_user(row.try_get("from_user_id").map_err(SavedStoreError::from)?)?,
        author,
        content: row.try_get("content").map_err(SavedStoreError::from)?,
        metadata_json,
        attachments,
        seq: MessageSeq::try_from(
            row.try_get::<i64, _>("seq")
                .map_err(SavedStoreError::from)?,
        )
        .map_err(|_| SavedStoreError::MalformedOrdinal)?,
        created_at_ms: row.try_get("created_at").map_err(SavedStoreError::from)?,
        thread_root: row
            .try_get::<Option<String>, _>("thread_root_id")
            .map_err(SavedStoreError::from)?
            .map(ThreadRootId::parse)
            .transpose()
            .map_err(|_| SavedStoreError::MalformedIdentity)?,
        linked_task,
    };
    SavedEntry::projected(
        SavedEntryId::parse(
            row.try_get::<String, _>("saved_id")
                .map_err(SavedStoreError::from)?,
        )
        .map_err(|_| SavedStoreError::MalformedIdentity)?,
        SavedMessage::projected(projection),
        place,
        SavedAt::new(
            row.try_get::<i64, _>("saved_at")
                .map_err(SavedStoreError::from)?,
        )
        .map_err(|_| SavedStoreError::MalformedOrdinal)?,
    )
    .map_err(|_| SavedStoreError::MismatchedConversation.into())
}

fn decode_linked_task(row: &SqliteRow) -> Result<Option<SavedLinkedTask>, PersistenceFailure> {
    let Some(id) = row
        .try_get::<Option<String>, _>("task_id")
        .map_err(SavedStoreError::from)?
    else {
        return Ok(None);
    };
    if id.is_empty() {
        return Err(SavedStoreError::MalformedLinkedTask.into());
    }
    let number = SavedTaskNumber::new(
        row.try_get::<Option<i64>, _>("task_number")
            .map_err(SavedStoreError::from)?
            .ok_or(SavedStoreError::MalformedLinkedTask)?,
    )
    .map_err(|_| SavedStoreError::MalformedLinkedTask)?;
    let status = SavedTaskStatus::parse(
        &row.try_get::<Option<String>, _>("task_status")
            .map_err(SavedStoreError::from)?
            .ok_or(SavedStoreError::MalformedLinkedTask)?,
    )
    .ok_or(SavedStoreError::MalformedLinkedTask)?;
    let agent: Option<String> = row
        .try_get("assignee_agent_id")
        .map_err(SavedStoreError::from)?;
    let human: Option<String> = row
        .try_get("assignee_user_id")
        .map_err(SavedStoreError::from)?;
    let assignee = match (agent, human) {
        (Some(id), None) => Some(SavedTaskAssignee::projected(
            PrincipalIdentity::Agent(
                AgentId::parse(id.clone()).map_err(|_| SavedStoreError::MalformedIdentity)?,
            ),
            row.try_get::<Option<String>, _>("assignee_agent_name")
                .map_err(SavedStoreError::from)?
                .unwrap_or(id),
        )),
        (None, Some(id)) => Some(SavedTaskAssignee::projected(
            PrincipalIdentity::Human(
                UserId::parse(id.clone()).map_err(|_| SavedStoreError::MalformedIdentity)?,
            ),
            row.try_get::<Option<String>, _>("assignee_user_name")
                .map_err(SavedStoreError::from)?
                .unwrap_or(id),
        )),
        (None, None) => None,
        _ => return Err(SavedStoreError::MalformedLinkedTask.into()),
    };
    Ok(Some(SavedLinkedTask {
        id,
        number,
        title: row
            .try_get::<Option<String>, _>("task_title")
            .map_err(SavedStoreError::from)?
            .unwrap_or_default(),
        status,
        assignee,
    }))
}

fn decode_attachments(raw: Option<&str>) -> Result<Vec<AttachmentSnapshot>, PersistenceFailure> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let metadata: serde_json::Value =
        serde_json::from_str(raw).map_err(SavedStoreError::MalformedMetadata)?;
    if !metadata.is_object() {
        return Err(SavedStoreError::MalformedMetadataShape.into());
    }
    let Some(items) = metadata
        .get("attachments")
        .and_then(serde_json::Value::as_array)
    else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for item in items {
        let Some(id) = item.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(filename) = item.get("filename").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(size) = item.get("size").and_then(serde_json::Value::as_i64) else {
            continue;
        };
        let Some(content_type) = item.get("content_type").and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Ok(id) = AttachmentId::parse(id) else {
            continue;
        };
        out.push(AttachmentSnapshot {
            id,
            filename: filename.to_owned(),
            size,
            content_type: content_type.to_owned(),
            label: None,
        });
    }
    Ok(out)
}

fn decode_from_kind(raw: String) -> Result<FromKind, PersistenceFailure> {
    match raw.as_str() {
        "user" => Ok(FromKind::User),
        "agent" => Ok(FromKind::Agent),
        "system" => Ok(FromKind::System),
        _ => Err(SavedStoreError::MalformedAuthor.into()),
    }
}

fn message_id(raw: String) -> Result<MessageId, PersistenceFailure> {
    MessageId::parse(raw).map_err(|_| SavedStoreError::MalformedIdentity.into())
}

fn conversation_id(raw: String) -> Result<ConversationId, PersistenceFailure> {
    ConversationId::parse(raw).map_err(|_| SavedStoreError::MalformedIdentity.into())
}

fn optional_agent(raw: Option<String>) -> Result<Option<AgentId>, PersistenceFailure> {
    raw.map(AgentId::parse)
        .transpose()
        .map_err(|_| SavedStoreError::MalformedIdentity.into())
}

fn optional_user(raw: Option<String>) -> Result<Option<UserId>, PersistenceFailure> {
    raw.map(UserId::parse)
        .transpose()
        .map_err(|_| SavedStoreError::MalformedIdentity.into())
}
