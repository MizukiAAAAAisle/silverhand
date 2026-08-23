//! SQLite adapter for the product create-message write unit.
//!
//! This store CONSUMES the product database. It creates no table, runs no
//! migrator and claims no schema version: the schema is owned elsewhere, and a
//! second owner would be a second migration authority.
//!
//! Everything engine-specific stays here — SQL text, PRAGMAs, transaction mode,
//! driver errors. The port returns application facts and refusals, so no driver
//! type reaches the application or the wire.

#[cfg(test)]
mod tests;

use std::{path::Path, time::Duration};

use silverhand_backend_core::messaging::{
    self, ConversationEndpoint, ConversationFacts, ConversationId, ConversationRefusal,
    CreatedMessage, DirectPairEndpoints, EndpointKind, EndpointPrincipalReads, MessageAuthor,
    MessageCreatedFact, MessageId, MessageSeq, PostAuthorityReads, ReplyTargetRefusal, SendActor,
    SendDestination, SendMessage, SendMessageError, SendMessageUnitOfWork, ThreadProjections,
    ThreadRootId, UserId,
    attachments::{AttachmentLabel, AttachmentSnapshot, AttachmentSource},
    freshness::{FreshnessGate, FreshnessGuardInvariant, RuntimeScope, StaleEventId},
};
use silverhand_backend_core::persistence::PersistenceFailure;
use sqlx::{
    Row, Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const ROOT_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";
const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

const SELECT_CONVERSATION_FACTS: &str = "SELECT closed_at, archived_at, placement_kind, \
     endpoint_a_kind, endpoint_a_id, endpoint_a_deleted_at, endpoint_b_kind, endpoint_b_id, \
     endpoint_b_deleted_at FROM conversations WHERE id = ?";
const SELECT_AGENT_EXISTS: &str = "SELECT 1 FROM agents WHERE id = ?";
const SELECT_USER_EXISTS: &str = "SELECT 1 FROM users WHERE id = ?";

/// Participation is placement-based, in one text per principal kind: a workspace
/// channel names its participants by roster row, a direct pair by its endpoints.
/// Splitting the arms would let a rosterless placement answer "not a participant"
/// to the principals the placement itself names.
const SELECT_AGENT_PARTICIPATES: &str = "SELECT 1 FROM conversations c WHERE c.id = ? AND \
     ((c.placement_kind = 'workspace' AND EXISTS (SELECT 1 FROM conversation_agents ca WHERE \
     ca.conversation_id = c.id AND ca.agent_id = ?)) OR (c.placement_kind = 'direct_pair' AND \
     ((c.endpoint_a_kind = 'agent' AND c.endpoint_a_id = ?) OR (c.endpoint_b_kind = 'agent' AND \
     c.endpoint_b_id = ?))))";
/// The human arm carries two facts for a channel — the seat AND workspace
/// membership — so a seat that outlived a workspace removal admits nobody.
const SELECT_USER_PARTICIPATES: &str = "SELECT 1 FROM conversations c WHERE c.id = ? AND \
     ((c.placement_kind = 'workspace' AND EXISTS (SELECT 1 FROM conversation_users cu WHERE \
     cu.conversation_id = c.id AND cu.user_id = ?) AND EXISTS (SELECT 1 FROM workspace_users wu \
     WHERE wu.workspace_id = c.workspace_id AND wu.user_id = ?)) OR (c.placement_kind = \
     'direct_pair' AND ((c.endpoint_a_kind = 'human' AND c.endpoint_a_id = ?) OR \
     (c.endpoint_b_kind = 'human' AND c.endpoint_b_id = ?))))";

const SELECT_REPLY_TARGET: &str =
    "SELECT id, thread_root_id FROM messages WHERE conversation_id = ? AND id = ?";
const SELECT_ATTACHMENT_SOURCE: &str =
    "SELECT id, channel_id, filename, size, content_type FROM attachments WHERE id = ?";
const SELECT_AGENT_SESSION_SCOPE: &str = "SELECT session_scope FROM agents WHERE id = ?";

/// The guard predicate: in-flight rows count as undelivered, which makes the
/// guarded set a strict superset of what a runtime can drain. Existence only —
/// never a sequence comparison — so it cannot be confused by row reuse.
const SELECT_UNDELIVERED_IN_CONVERSATION: &str = "SELECT 1 FROM conversation_inboxes WHERE \
     conversation_id = ? AND agent_id = ? AND delivered_at IS NULL AND failed_at IS NULL LIMIT 1";
const SELECT_UNDELIVERED_FOR_AGENT: &str = "SELECT 1 FROM conversation_inboxes WHERE agent_id = ? \
     AND delivered_at IS NULL AND failed_at IS NULL LIMIT 1";

const RESERVE_NEXT_SEQ: &str =
    "UPDATE conversations SET latest_message_seq = latest_message_seq + 1 WHERE id = ?";
const SELECT_LATEST_SEQ: &str = "SELECT latest_message_seq FROM conversations WHERE id = ?";
const SELECT_AGENT_AUTHOR: &str = "SELECT name, display_name FROM agents WHERE id = ?";
const SELECT_USER_AUTHOR: &str = "SELECT name, display_name FROM users WHERE id = ?";

const INSERT_MESSAGE: &str = "INSERT INTO messages (id, conversation_id, from_kind, from_agent_id, \
     from_user_id, content, metadata, seq, created_at, thread_root_id, author_id, author_name, \
     author_display_name, cc_source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/// Update-then-insert rather than upsert: the stream-head table's uniqueness is
/// two PARTIAL indexes, which cannot be named as a conflict target. The key
/// compares with `IS` because the main line's head is the row whose root is NULL.
const UPDATE_STREAM_HEAD: &str = "UPDATE conversation_stream_heads SET latest_seq = ? WHERE \
     conversation_id = ? AND thread_root_id IS ?";
const INSERT_STREAM_HEAD: &str = "INSERT INTO conversation_stream_heads (conversation_id, \
     thread_root_id, latest_seq) VALUES (?, ?, ?)";

/// System copies are excluded so a cluster's badge counts what participants said,
/// and so a live count, a replay and a cold open agree.
const COUNT_THREAD_REPLIES: &str = "SELECT count(*) FROM messages WHERE conversation_id = ? AND \
     thread_root_id = ? AND from_kind != 'system'";

const FROM_KIND_USER: &str = "user";
const FROM_KIND_AGENT: &str = "agent";
const PLACEMENT_DIRECT_PAIR: &str = "direct_pair";
const ENDPOINT_KIND_HUMAN: &str = "human";
const ENDPOINT_KIND_AGENT: &str = "agent";

#[derive(Clone)]
pub struct MessagingStore {
    pool: SqlitePool,
}

/// Startup and driver failures, surfaced only to the composition root that opens
/// the store. The port below never exposes it.
#[derive(Debug, Error)]
pub enum MessagingStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("system time is outside the supported Unix-millisecond range")]
    Clock,
    #[error("attachment snapshot could not be serialized")]
    Serialization(#[from] serde_json::Error),
    #[error("system entropy is unavailable")]
    Entropy,
    /// A direct pair whose endpoint columns are absent or unknown contradicts the
    /// schema's own constraints, so there is no participation question to answer.
    #[error("conversation row contradicts the placement constraints of its schema")]
    MalformedPlacement,
}

fn infrastructure(error: MessagingStoreError) -> SendMessageError {
    PersistenceFailure::from_source(error).into()
}

fn driver(error: sqlx::Error) -> PersistenceFailure {
    PersistenceFailure::from_source(MessagingStoreError::Sql(error))
}

impl MessagingStore {
    /// Opens an existing product database. A missing file is a failure rather than
    /// an empty database: provisioning belongs to the schema's owner.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, MessagingStoreError> {
        Self::open_with_busy_timeout(path, BUSY_TIMEOUT).await
    }

    async fn open_with_busy_timeout(
        path: impl AsRef<Path>,
        busy_timeout: Duration,
    ) -> Result<Self, MessagingStoreError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            // An acknowledged send must survive power loss, so WAL runs with
            // FULL. NORMAL would skip the commit fsync and let an acknowledged
            // message roll back.
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(busy_timeout);

        let pool = SqlitePoolOptions::new()
            .max_connections(POOL_CONNECTIONS)
            .connect_with(options)
            .await?;

        Ok(Self { pool })
    }

    /// Reserves the single writer before the first statement, so contention
    /// surfaces before any of the unit's reads are trusted.
    async fn begin_root_write(&self) -> Result<Transaction<'_, Sqlite>, sqlx::Error> {
        self.pool.begin_with(ROOT_WRITE_BEGIN).await
    }

    #[tracing::instrument(skip(self, command), fields(
        target_conversation = command.target_conversation.as_str(),
        content_bytes = command.content.len(),
    ))]
    async fn send_message_transaction(
        &self,
        command: SendMessage,
    ) -> Result<MessageCreatedFact, SendMessageError> {
        let mut scope = TxScope {
            tx: self.begin_root_write().await.map_err(driver)?,
        };
        match scope.write(command).await {
            Ok(fact) => {
                scope.tx.commit().await.map_err(driver)?;
                Ok(fact)
            }
            Err(refusal) => {
                // The refusal is the answer: a rollback statement that itself
                // fails must not replace it.
                drop(scope.tx.rollback().await);
                Err(refusal)
            }
        }
    }
}

impl SendMessageUnitOfWork for MessagingStore {
    async fn send_message(
        &self,
        command: SendMessage,
    ) -> Result<MessageCreatedFact, SendMessageError> {
        self.send_message_transaction(command).await
    }
}

/// The transaction's own scope. Every fact the write depends on is read through
/// it, so a concurrent change cannot land between a check and the insert.
struct TxScope<'connection> {
    tx: Transaction<'connection, Sqlite>,
}

impl TxScope<'_> {
    async fn write(
        &mut self,
        command: SendMessage,
    ) -> Result<MessageCreatedFact, SendMessageError> {
        // The sender's own binding must still exist. Read for existence only: what
        // the send is authorized against is the target.
        if command.source_conversation != command.target_conversation
            && self
                .conversation_facts(&command.source_conversation)
                .await?
                .is_none()
        {
            return Err(ConversationRefusal::NotFound.into());
        }

        let facts =
            messaging::assert_post_authority(self, &command.target_conversation, &command.actor)
                .await?;

        let thread_root = self
            .resolve_thread_root(&facts.id, &command.destination)
            .await?;
        let snapshots = self
            .resolve_attachments(&facts.id, &command.attachment_refs)
            .await?;
        let freshness_bypassed = self.assert_fresh(&command, &facts.id).await?;

        let seq = self.reserve_next_seq(&facts.id).await?;
        let author = self.author_snapshot(&command.actor).await?;
        let message = self
            .insert_message(&command, &facts.id, thread_root, seq, author, snapshots)
            .await?;
        self.bump_stream_head(&facts.id, message.thread_root_id.as_ref(), seq)
            .await?;

        let projections = match &message.thread_root_id {
            None => None,
            Some(root) => Some(ThreadProjections {
                thread_root_id: root.clone(),
                // Counted after the insert, so the reported total already
                // includes this reply and is never a value from the future.
                reply_count: self.count_thread_replies(&facts.id, root).await?,
            }),
        };

        Ok(MessageCreatedFact {
            message,
            projections,
            freshness_bypassed,
        })
    }

    async fn resolve_thread_root(
        &mut self,
        conversation: &ConversationId,
        destination: &SendDestination,
    ) -> Result<Option<ThreadRootId>, SendMessageError> {
        match destination {
            SendDestination::MainLine => Ok(None),
            SendDestination::Thread(root) => Ok(Some(root.clone())),
            // A reply names a message; the cluster is that message's own root, or
            // the message itself when it starts one.
            SendDestination::Reply(target) => {
                let row = sqlx::query(SELECT_REPLY_TARGET)
                    .bind(conversation.as_str())
                    .bind(target.as_str())
                    .fetch_optional(&mut *self.tx)
                    .await
                    .map_err(driver)?
                    .ok_or(ReplyTargetRefusal)?;

                let existing_root: Option<String> =
                    row.try_get("thread_root_id").map_err(driver)?;
                let root = match existing_root {
                    Some(root) => root,
                    None => row.try_get::<String, _>("id").map_err(driver)?,
                };
                Ok(Some(ThreadRootId::parse(root).map_err(|_| {
                    infrastructure(MessagingStoreError::MalformedPlacement)
                })?))
            }
        }
    }

    async fn resolve_attachments(
        &mut self,
        conversation: &ConversationId,
        refs: &[messaging::attachments::AttachmentRef],
    ) -> Result<Vec<AttachmentSnapshot>, SendMessageError> {
        if refs.is_empty() {
            return Ok(Vec::new());
        }

        // Looked up one id at a time: an `IN` list would have to be assembled as
        // SQL text, and the decision below stops at the first bad reference
        // anyway, so a batched read would buy nothing it can use.
        let mut sources = Vec::with_capacity(refs.len());
        for reference in refs {
            let row = sqlx::query(SELECT_ATTACHMENT_SOURCE)
                .bind(reference.id.as_str())
                .fetch_optional(&mut *self.tx)
                .await
                .map_err(driver)?;
            let Some(row) = row else { continue };

            sources.push(AttachmentSource {
                id: reference.id.clone(),
                channel_id: ConversationId::parse(
                    row.try_get::<String, _>("channel_id").map_err(driver)?,
                )
                .map_err(|_| infrastructure(MessagingStoreError::MalformedPlacement))?,
                filename: row.try_get("filename").map_err(driver)?,
                size: row.try_get("size").map_err(driver)?,
                content_type: row.try_get("content_type").map_err(driver)?,
            });
        }

        Ok(messaging::attachments::resolve_attachment_snapshots(
            conversation,
            refs,
            &sources,
        )?)
    }

    /// Returns whether the guard was skipped at the sender's request.
    async fn assert_fresh(
        &mut self,
        command: &SendMessage,
        target: &ConversationId,
    ) -> Result<bool, SendMessageError> {
        let agent =
            match messaging::freshness::freshness_gate(&command.actor, command.freshness_bypass) {
                FreshnessGate::NotApplicable => return Ok(false),
                FreshnessGate::Bypassed => return Ok(true),
                FreshnessGate::Check(agent) => agent,
            };

        let declared: Option<String> = sqlx::query_scalar(SELECT_AGENT_SESSION_SCOPE)
            .bind(agent.as_str())
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        let declared = declared.ok_or_else(|| FreshnessGuardInvariant::AgentAbsent {
            agent: agent.clone(),
        })?;
        let scope = RuntimeScope::parse_session_scope(&declared).ok_or_else(|| {
            FreshnessGuardInvariant::UnknownSessionScope {
                agent: agent.clone(),
            }
        })?;

        // The conversation arm keys on the SOURCE conversation: freshness is about
        // what this runtime has not yet consumed, not about where it is writing.
        let undelivered: Option<i64> = match scope {
            RuntimeScope::Conversation => sqlx::query_scalar(SELECT_UNDELIVERED_IN_CONVERSATION)
                .bind(command.source_conversation.as_str())
                .bind(agent.as_str())
                .fetch_optional(&mut *self.tx)
                .await
                .map_err(driver)?,
            RuntimeScope::Agent => sqlx::query_scalar(SELECT_UNDELIVERED_FOR_AGENT)
                .bind(agent.as_str())
                .fetch_optional(&mut *self.tx)
                .await
                .map_err(driver)?,
        };

        if undelivered.is_some() {
            return Err(messaging::StaleRefusal {
                stale_event_id: StaleEventId::mint()
                    .map_err(|_| infrastructure(MessagingStoreError::Entropy))?,
                target_conversation_id: target.clone(),
            }
            .into());
        }
        Ok(false)
    }

    /// Advances the conversation's counter and reads back what it reserved. The
    /// counter is conversation-global: a reply and a main-line message draw from
    /// it alike, which is what makes `(conversation, seq)` a total order.
    async fn reserve_next_seq(
        &mut self,
        conversation: &ConversationId,
    ) -> Result<MessageSeq, SendMessageError> {
        sqlx::query(RESERVE_NEXT_SEQ)
            .bind(conversation.as_str())
            .execute(&mut *self.tx)
            .await
            .map_err(driver)?;
        let reserved: i64 = sqlx::query_scalar(SELECT_LATEST_SEQ)
            .bind(conversation.as_str())
            .fetch_one(&mut *self.tx)
            .await
            .map_err(driver)?;
        Ok(MessageSeq::reserved(reserved))
    }

    /// Read live and copied onto the row, so the message keeps reporting its
    /// author after the principal is renamed or removed.
    async fn author_snapshot(
        &mut self,
        actor: &SendActor,
    ) -> Result<Option<MessageAuthor>, SendMessageError> {
        let (statement, id) = match actor {
            SendActor::Agent(agent) => (SELECT_AGENT_AUTHOR, agent.as_str()),
            SendActor::User(user) => (SELECT_USER_AUTHOR, user.as_str()),
        };
        let row = sqlx::query(statement)
            .bind(id)
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        let Some(row) = row else { return Ok(None) };

        Ok(Some(MessageAuthor {
            id: id.to_owned(),
            name: row.try_get("name").map_err(driver)?,
            display_name: row.try_get("display_name").map_err(driver)?,
        }))
    }

    async fn insert_message(
        &mut self,
        command: &SendMessage,
        conversation: &ConversationId,
        thread_root: Option<ThreadRootId>,
        seq: MessageSeq,
        author: Option<MessageAuthor>,
        attachments: Vec<AttachmentSnapshot>,
    ) -> Result<CreatedMessage, SendMessageError> {
        let id = MessageId::mint().map_err(|_| infrastructure(MessagingStoreError::Entropy))?;
        let created_at_ms = now_unix_ms()?;
        let metadata = metadata_json(&attachments)?;
        let (from_kind, agent_id, user_id) = match &command.actor {
            SendActor::Agent(agent) => (FROM_KIND_AGENT, Some(agent.as_str()), None),
            SendActor::User(user) => (FROM_KIND_USER, None, Some(user.as_str())),
        };

        sqlx::query(INSERT_MESSAGE)
            .bind(id.as_str())
            .bind(conversation.as_str())
            .bind(from_kind)
            .bind(agent_id)
            .bind(user_id)
            .bind(&command.content)
            .bind(metadata)
            .bind(seq.get())
            .bind(created_at_ms)
            .bind(thread_root.as_ref().map(ThreadRootId::as_str))
            .bind(author.as_ref().map(|author| author.id.as_str()))
            .bind(author.as_ref().map(|author| author.name.as_str()))
            .bind(
                author
                    .as_ref()
                    .and_then(|author| author.display_name.as_deref()),
            )
            .bind(None::<&str>)
            .execute(&mut *self.tx)
            .await
            .map_err(driver)?;

        Ok(CreatedMessage {
            id,
            conversation_id: conversation.clone(),
            from_kind: command.actor.from_kind(),
            from_agent_id: match &command.actor {
                SendActor::Agent(agent) => Some(agent.clone()),
                SendActor::User(_) => None,
            },
            from_user_id: match &command.actor {
                SendActor::User(user) => Some(user.clone()),
                SendActor::Agent(_) => None,
            },
            author,
            content: command.content.clone(),
            attachments,
            seq,
            created_at_ms,
            thread_root_id: thread_root,
        })
    }

    /// The head is advanced unconditionally: it records which ordinal a stream last
    /// reached, and is not a token anything competes for.
    async fn bump_stream_head(
        &mut self,
        conversation: &ConversationId,
        thread_root: Option<&ThreadRootId>,
        seq: MessageSeq,
    ) -> Result<(), SendMessageError> {
        let root = thread_root.map(ThreadRootId::as_str);
        let updated = sqlx::query(UPDATE_STREAM_HEAD)
            .bind(seq.get())
            .bind(conversation.as_str())
            .bind(root)
            .execute(&mut *self.tx)
            .await
            .map_err(driver)?
            .rows_affected();

        if updated == 0 {
            sqlx::query(INSERT_STREAM_HEAD)
                .bind(conversation.as_str())
                .bind(root)
                .bind(seq.get())
                .execute(&mut *self.tx)
                .await
                .map_err(driver)?;
        }
        Ok(())
    }

    async fn count_thread_replies(
        &mut self,
        conversation: &ConversationId,
        root: &ThreadRootId,
    ) -> Result<i64, SendMessageError> {
        sqlx::query_scalar(COUNT_THREAD_REPLIES)
            .bind(conversation.as_str())
            .bind(root.as_str())
            .fetch_one(&mut *self.tx)
            .await
            .map_err(|error| driver(error).into())
    }
}

impl EndpointPrincipalReads for TxScope<'_> {
    async fn endpoint_principal_exists(
        &mut self,
        endpoint: &ConversationEndpoint,
    ) -> Result<bool, PersistenceFailure> {
        let statement = match endpoint.kind {
            EndpointKind::Agent => SELECT_AGENT_EXISTS,
            EndpointKind::Human => SELECT_USER_EXISTS,
        };
        let found: Option<i64> = sqlx::query_scalar(statement)
            .bind(endpoint.id.as_str())
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        Ok(found.is_some())
    }
}

impl PostAuthorityReads for TxScope<'_> {
    async fn conversation_facts(
        &mut self,
        conversation: &ConversationId,
    ) -> Result<Option<ConversationFacts>, PersistenceFailure> {
        let row = sqlx::query(SELECT_CONVERSATION_FACTS)
            .bind(conversation.as_str())
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        let Some(row) = row else { return Ok(None) };

        let closed_at: Option<i64> = row.try_get("closed_at").map_err(driver)?;
        let archived_at: Option<i64> = row.try_get("archived_at").map_err(driver)?;
        let placement: String = row.try_get("placement_kind").map_err(driver)?;

        let direct_pair = if placement == PLACEMENT_DIRECT_PAIR {
            Some(DirectPairEndpoints {
                a: endpoint_from_row(&row, "endpoint_a")?,
                b: endpoint_from_row(&row, "endpoint_b")?,
            })
        } else {
            None
        };

        Ok(Some(ConversationFacts {
            id: conversation.clone(),
            is_closed: closed_at.is_some(),
            is_archived: archived_at.is_some(),
            direct_pair,
        }))
    }

    async fn agent_exists(
        &mut self,
        agent: &messaging::AgentId,
    ) -> Result<bool, PersistenceFailure> {
        let found: Option<i64> = sqlx::query_scalar(SELECT_AGENT_EXISTS)
            .bind(agent.as_str())
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        Ok(found.is_some())
    }

    async fn is_agent_participant(
        &mut self,
        conversation: &ConversationId,
        agent: &messaging::AgentId,
    ) -> Result<bool, PersistenceFailure> {
        let found: Option<i64> = sqlx::query_scalar(SELECT_AGENT_PARTICIPATES)
            .bind(conversation.as_str())
            .bind(agent.as_str())
            .bind(agent.as_str())
            .bind(agent.as_str())
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        Ok(found.is_some())
    }

    async fn is_user_participant(
        &mut self,
        conversation: &ConversationId,
        user: &UserId,
    ) -> Result<bool, PersistenceFailure> {
        let found: Option<i64> = sqlx::query_scalar(SELECT_USER_PARTICIPATES)
            .bind(conversation.as_str())
            .bind(user.as_str())
            .bind(user.as_str())
            .bind(user.as_str())
            .bind(user.as_str())
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        Ok(found.is_some())
    }
}

fn endpoint_from_row(
    row: &sqlx::sqlite::SqliteRow,
    prefix: &str,
) -> Result<ConversationEndpoint, PersistenceFailure> {
    let malformed = || PersistenceFailure::from_source(MessagingStoreError::MalformedPlacement);
    let (kind_column, id_column, deleted_column) = match prefix {
        "endpoint_a" => ("endpoint_a_kind", "endpoint_a_id", "endpoint_a_deleted_at"),
        _ => ("endpoint_b_kind", "endpoint_b_id", "endpoint_b_deleted_at"),
    };

    let kind: Option<String> = row.try_get(kind_column).map_err(driver)?;
    let id: Option<String> = row.try_get(id_column).map_err(driver)?;
    let deleted_at_ms: Option<i64> = row.try_get(deleted_column).map_err(driver)?;
    let (kind, id) = kind.zip(id).ok_or_else(malformed)?;

    let kind = match kind.as_str() {
        ENDPOINT_KIND_HUMAN => EndpointKind::Human,
        ENDPOINT_KIND_AGENT => EndpointKind::Agent,
        _ => return Err(malformed()),
    };
    Ok(ConversationEndpoint {
        kind,
        id,
        deleted_at_ms,
    })
}

/// The durable snapshot shape, versioned by the schema that holds it rather than
/// by the application type it is projected from.
#[derive(serde::Serialize)]
struct StoredAttachmentSnapshot<'a> {
    id: &'a str,
    filename: &'a str,
    size: i64,
    content_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

/// Attachments travel in the message's metadata column, so a message with none
/// stores no metadata at all rather than an empty container.
fn metadata_json(attachments: &[AttachmentSnapshot]) -> Result<Option<String>, SendMessageError> {
    if attachments.is_empty() {
        return Ok(None);
    }
    let stored: Vec<StoredAttachmentSnapshot<'_>> = attachments
        .iter()
        .map(|snapshot| StoredAttachmentSnapshot {
            id: snapshot.id.as_str(),
            filename: &snapshot.filename,
            size: snapshot.size,
            content_type: &snapshot.content_type,
            label: snapshot.label.as_ref().map(AttachmentLabel::to_string),
        })
        .collect();

    serde_json::to_string(&serde_json::json!({ "attachments": stored }))
        .map(Some)
        .map_err(|error| infrastructure(MessagingStoreError::Serialization(error)))
}

fn now_unix_ms() -> Result<i64, SendMessageError> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| infrastructure(MessagingStoreError::Clock))?;
    i64::try_from(elapsed.as_millis()).map_err(|_| infrastructure(MessagingStoreError::Clock))
}
