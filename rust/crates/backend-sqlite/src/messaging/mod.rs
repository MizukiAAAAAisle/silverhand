//! SQLite adapter for the product create-message write unit.
//!
//! This store CONSUMES the product database. It creates no table, runs no
//! migrator, claims no schema version, and refuses to open a database that does
//! not exist: the schema has an owner, and a second one would be a second
//! migration authority.
//!
//! Everything engine-specific stays here — SQL text, PRAGMAs, transaction mode,
//! driver errors. The port returns application facts and refusals, so no driver
//! type reaches the application or the wire.

use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use silverhand_backend_core::messaging::{
    self, ConversationEndpoint, ConversationFacts, ConversationId, ConversationRefusal,
    CreatedMessage, DirectPairEndpoints, EndpointPrincipalReads, EnvironmentUnavailable,
    InvalidSeq, MessageAuthor, MessageCreatedFact, MessageId, MessageSeq, NotificationId,
    ParticipantHandle, PostAuthorityReads, PrincipalKind, ReplyTargetRefusal, SendActor, SendClock,
    SendDestination, SendEntropy, SendMessage, SendMessageError, SendMessageUnitOfWork,
    ThreadFollowerSource, ThreadReplyFact, ThreadRootId, ThreadRootRefusal, UserId,
    attachments::{AttachmentLabel, AttachmentSnapshot, AttachmentSource},
    freshness::{FreshnessGate, FreshnessGuardInvariant, RuntimeScope, StaleEventId},
    mention_cc::{self, MentionCopyOutcome, MentionCopySkip},
    post_commit::{
        CommittedMentionRow, DeliveryPlan, EffectFailure, MainDeliveryPlan, MentionIntent,
        MentionedViewerRecord, PostCommitPlan, ReplyAudience,
    },
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

const SELECT_MESSAGE_IN_CONVERSATION: &str = "SELECT id, thread_root_id, from_kind, \
     from_agent_id, from_user_id FROM messages WHERE conversation_id = ? AND id = ?";
const SELECT_AGENT_ID_BY_NAME: &str = "SELECT id FROM agents WHERE name = ?";
const SELECT_CONVERSATION_PLACE: &str =
    "SELECT workspace_id, title FROM conversations WHERE id = ?";
const SELECT_WORKSPACE_NAME: &str = "SELECT name FROM workspaces WHERE id = ?";
/// Who, among the names a body used, may read that conversation right now.
///
/// ONE set-shaped read bounded by the handles the message actually named. The
/// adapter holds SQLite's single writer while it runs and a 64KiB body can name
/// many people, so asking per handle would put an unbounded number of point
/// queries under that reservation; `json_each` makes the named set the driver and
/// `users` a unique-index probe per name.
///
/// The human rule is the same two facts as everywhere — the `conversation_users`
/// seat AND workspace membership — conjoined on each candidate's own id. Both
/// halves are load-bearing: a seat that outlived its membership is not a
/// participant, so it must not be told.
///
/// NO PLACEMENT ARM, and its absence is a fact about the caller rather than a
/// simplification: a mention intent carries a `WorkspaceId`, and one is minted
/// only for a workspace-placed conversation (`mention_self` is workspace-only —
/// in a direct pair the stream IS the mention). A rosterless placement reaching
/// here would produce no seat rows and therefore no viewers, so the omission is
/// fail-closed in both readings.
///
/// Membership is checked against the workspace the ROW WILL NAME — the intent's,
/// bound here — not against whatever the conversation column says at record time.
/// Otherwise the entitlement answered for one workspace and the coordinate written
/// pointed at another.
///
/// The author is excluded in the statement, so a person who named themselves is
/// never a candidate. Bound as a nullable id: an agent author excludes nobody,
/// which is what `IS NOT NULL` gives for free.
macro_rules! entitled_viewers_sql {
    () => {
        "SELECT u.id, u.name FROM json_each(?) named JOIN users u ON u.name = named.value WHERE \
         u.id IS NOT ? AND EXISTS (SELECT 1 FROM conversation_users cu WHERE cu.conversation_id = \
         ? AND cu.user_id = u.id) AND EXISTS (SELECT 1 FROM workspace_users wu WHERE \
         wu.workspace_id = ? AND wu.user_id = u.id) ORDER BY u.created_at ASC, u.id ASC"
    };
}

const SELECT_ENTITLED_VIEWERS: &str = entitled_viewers_sql!();
/// The same statement, asked about its own plan, so the bound cannot be asserted
/// against a paraphrase.
#[cfg(test)]
const EXPLAIN_ENTITLED_VIEWERS: &str = concat!("EXPLAIN QUERY PLAN ", entitled_viewers_sql!());

/// The durable record that a person was named in a conversation they can read. Its
/// coordinates are the source's, because that is what the reader can open.
const INSERT_MENTION_SELF: &str = "INSERT INTO notifications (id, kind, user_id, workspace_id, \
     conversation_id, message_id, source_workspace_id, source_conversation_id, source_message_id, \
     payload, created_at) VALUES (?, 'mention_self', ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/// The conversation's agent participants, as the placement names them, conjoined
/// with a live principal row: a delivery row for an agent that no longer exists
/// cannot be written at all. Ordered so the plan does not depend on scan order.
const SELECT_PARTICIPANT_AGENTS: &str = "SELECT a.id FROM conversations c JOIN agents a ON \
     ((c.placement_kind = 'workspace' AND EXISTS (SELECT 1 FROM conversation_agents ca WHERE \
     ca.conversation_id = c.id AND ca.agent_id = a.id)) OR (c.placement_kind = 'direct_pair' AND \
     ((c.endpoint_a_kind = 'agent' AND c.endpoint_a_id = a.id) OR (c.endpoint_b_kind = 'agent' AND \
     c.endpoint_b_id = a.id)))) WHERE c.id = ? ORDER BY a.id ASC";

/// A direct line is got-or-created: the conflict target is the partial unique index
/// over the endpoint columns, so two sends racing to mention the same agent end up
/// on one line rather than two.
const OPEN_DIRECT_PAIR: &str = "INSERT INTO conversations (id, workspace_id, placement_kind, \
     roster_policy, endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id, title, status, \
     visibility, created_at, updated_at) VALUES (?, NULL, 'direct_pair', 'fixed', ?, ?, ?, ?, '', \
     'idle', 'private', ?, ?) ON CONFLICT (endpoint_a_kind, endpoint_a_id, endpoint_b_kind, \
     endpoint_b_id) WHERE placement_kind = 'direct_pair' DO NOTHING";
const SELECT_DIRECT_PAIR: &str = "SELECT id FROM conversations WHERE placement_kind = \
     'direct_pair' AND endpoint_a_kind = ? AND endpoint_a_id = ? AND endpoint_b_kind = ? AND \
     endpoint_b_id = ?";

/// The copy is authored by the system: it is not the mentioning person speaking on
/// the line, and it names the message it came from so the two can never be
/// mistaken for independent facts.
const INSERT_MENTION_COPY: &str = "INSERT INTO messages (id, conversation_id, from_kind, content, \
     metadata, seq, created_at, cc_source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
/// The author's own record that the mention left their conversation. Its
/// coordinates are the SOURCE's, because the reader is the author and their read
/// path is the message they can see — never the recipient's copy, which they cannot.
const INSERT_MENTION_NOTIFICATION: &str = "INSERT INTO notifications (id, kind, user_id, agent_id, \
     workspace_id, conversation_id, message_id, source_workspace_id, source_conversation_id, \
     source_message_id, payload, created_at) VALUES (?, 'mention_external', ?, ?, ?, ?, ?, ?, ?, \
     ?, ?, ?)";
const SELECT_USER_ID_BY_NAME: &str = "SELECT id FROM users WHERE name = ?";

/// Following is idempotent: a principal already following a cluster is not
/// followed again, and the insert reports which case happened so history is
/// backfilled exactly once.
const FOLLOW_CLUSTER: &str = "INSERT INTO thread_followers (thread_root_id, conversation_id, \
     principal_kind, principal_id, followed_at, source) VALUES (?, ?, ?, ?, ?, ?) ON \
     CONFLICT(thread_root_id, principal_kind, principal_id) DO NOTHING";
/// The cluster's history as of this reply: every earlier message of the cluster,
/// oldest first. The root is fetched separately because it is not one of its own
/// replies.
const SELECT_CLUSTER_HISTORY: &str = "SELECT id, from_kind, from_agent_id FROM messages WHERE \
     conversation_id = ? AND thread_root_id = ? AND seq < ? ORDER BY seq ASC";
/// Delivery rows are idempotent per (conversation, agent, message), so a
/// re-followed cluster cannot queue the same message twice.
const ENSURE_INBOX_DELIVERY: &str = "INSERT INTO conversation_inboxes (conversation_id, agent_id, \
     message_id, delivered_at, delivery_kind, created_at) VALUES (?, ?, ?, NULL, ?, ?) ON \
     CONFLICT(conversation_id, agent_id, message_id) DO NOTHING";
/// Who a cluster's reply is for, as ONE set-shaped read. The follower rows for this
/// root bound the candidates, `JOIN agents` is the liveness conjunct, and the
/// placement predicate is correlated on each candidate's own id. Follower rows are
/// not authority over who may read a cluster — they are candidates participation
/// and liveness still have to accept — and they outlive both, so asking per
/// follower would put two point queries per row inside the writer's reservation
/// while the set itself grows with the cluster's history.
///
/// This is the SECOND text expressing one participation rule (the write gate holds
/// the point form), which is a real cost paid deliberately: a differential test
/// drives both across the placement arms, liveness, and lingering followers, and a
/// plan test keeps the candidate set bounded by the root rather than by the
/// installation.
macro_rules! cluster_audience_sql {
    () => {
        "SELECT tf.principal_id FROM thread_followers tf JOIN conversations c ON c.id = \
         tf.conversation_id JOIN agents a ON a.id = tf.principal_id WHERE tf.thread_root_id = ? \
         AND tf.principal_kind = 'agent' AND ((c.placement_kind = 'workspace' AND EXISTS (SELECT 1 \
         FROM conversation_agents ca WHERE ca.conversation_id = c.id AND ca.agent_id = a.id)) OR \
         (c.placement_kind = 'direct_pair' AND ((c.endpoint_a_kind = 'agent' AND c.endpoint_a_id = \
         a.id) OR (c.endpoint_b_kind = 'agent' AND c.endpoint_b_id = a.id)))) ORDER BY \
         tf.followed_at ASC, tf.principal_id ASC"
    };
}

const SELECT_CLUSTER_AUDIENCE: &str = cluster_audience_sql!();
/// The same statement, asked about its own plan, so the bound cannot be asserted
/// against a paraphrase.
#[cfg(test)]
const EXPLAIN_CLUSTER_AUDIENCE: &str = concat!("EXPLAIN QUERY PLAN ", cluster_audience_sql!());
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
const FROM_KIND_SYSTEM: &str = "system";
const PRINCIPAL_KIND_HUMAN: &str = "human";
const PRINCIPAL_KIND_AGENT: &str = "agent";
const FOLLOWER_SOURCE_REPLY: &str = "reply";
const FOLLOWER_SOURCE_TARGET_AUTHOR: &str = "target_author";
const FOLLOWER_SOURCE_MENTION: &str = "mention";
/// Historical context a follower is catching up on, as opposed to a message that
/// arrived while it was already following.
const DELIVERY_KIND_OBSERVE: &str = "observe";
/// A message that arrived for someone now: it is owed an answer, not context.
const DELIVERY_KIND_TURN: &str = "turn";
const PLACEMENT_DIRECT_PAIR: &str = "direct_pair";
const ENDPOINT_KIND_HUMAN: &str = "human";
const ENDPOINT_KIND_AGENT: &str = "agent";

/// The host capabilities this store uses unless a caller injects others.
pub struct HostEnvironment;

impl SendClock for HostEnvironment {
    fn now_unix_ms(&self) -> Result<i64, EnvironmentUnavailable> {
        unix_ms_since_epoch(SystemTime::now())
    }
}

impl SendEntropy for HostEnvironment {
    fn fill(&self, buffer: &mut [u8]) -> Result<(), EnvironmentUnavailable> {
        getrandom::fill(buffer).map_err(EnvironmentUnavailable::from_source)
    }
}

/// The conversion the clock performs, separated from reading the clock so the unit
/// it answers in can be asserted without depending on what time it is.
fn unix_ms_since_epoch(moment: SystemTime) -> Result<i64, EnvironmentUnavailable> {
    let since_epoch = moment
        .duration_since(UNIX_EPOCH)
        .map_err(EnvironmentUnavailable::from_source)?;
    i64::try_from(since_epoch.as_millis()).map_err(EnvironmentUnavailable::from_source)
}

pub struct MessagingStore<E = HostEnvironment> {
    pool: SqlitePool,
    environment: E,
}

/// Startup and driver failures, surfaced only to the composition root that opens
/// the store. The port below never exposes it.
#[derive(Debug, Error)]
pub enum MessagingStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("attachment snapshot could not be serialized")]
    Serialization(#[from] serde_json::Error),
    /// A stored ordinal outside the domain's range. The column is the store's own,
    /// so this is a broken database rather than a caller's mistake.
    #[error("stored message ordinal is outside the range the domain defines")]
    Ordinal(#[from] InvalidSeq),
    /// A direct pair whose endpoint columns are absent or unknown contradicts the
    /// schema's own constraints, so there is no participation question to answer.
    #[error("conversation row contradicts the placement constraints of its schema")]
    MalformedPlacement,
    /// A stored column that should name something names nothing. Unrelated to
    /// placement, and named apart from it so a reader is not misdirected.
    #[error("stored column {field} does not name a usable identity")]
    MalformedIdentity { field: &'static str },
    /// A host capability the write depends on could not answer. Kept as a source
    /// rather than a marker: "no identity could be minted" is only actionable
    /// with the reason attached.
    #[error("a host capability this write depends on could not answer")]
    Environment(#[from] EnvironmentUnavailable),
}

fn infrastructure(error: MessagingStoreError) -> SendMessageError {
    PersistenceFailure::from_source(error).into()
}

fn driver(error: sqlx::Error) -> PersistenceFailure {
    PersistenceFailure::from_source(MessagingStoreError::Sql(error))
}

impl MessagingStore<HostEnvironment> {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, MessagingStoreError> {
        Self::open_with(path, HostEnvironment).await
    }
}

impl<E> MessagingStore<E> {
    /// Opens an existing product database with injected host capabilities. A
    /// missing file is a failure rather than an empty database.
    pub async fn open_with(
        path: impl AsRef<Path>,
        environment: E,
    ) -> Result<Self, MessagingStoreError> {
        Self::open_with_busy_timeout(path, environment, BUSY_TIMEOUT).await
    }

    async fn open_with_busy_timeout(
        path: impl AsRef<Path>,
        environment: E,
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

        Ok(Self { pool, environment })
    }

    /// Reserves the single writer before the first statement, so contention
    /// surfaces before any of the unit's reads are trusted.
    async fn begin_root_write(&self) -> Result<Transaction<'_, Sqlite>, sqlx::Error> {
        self.pool.begin_with(ROOT_WRITE_BEGIN).await
    }
}

impl<E: SendClock + SendEntropy + Send + Sync> MessagingStore<E> {
    #[tracing::instrument(skip(self, command), fields(
        target_conversation = command.target_conversation().as_str(),
        content_bytes = command.content().byte_length(),
    ))]
    async fn send_message_transaction(
        &self,
        command: SendMessage,
    ) -> Result<MessageCreatedFact, SendMessageError> {
        // The environment is asked before a transaction exists, so a host that
        // cannot answer costs nothing: there is no writer to reserve and no
        // statement to roll back.
        let created_at_ms = self.environment.now_unix_ms()?;
        let message_id = MessageId::mint(&self.environment)?;

        let mut scope = TxScope {
            tx: self.begin_root_write().await.map_err(driver)?,
            entropy: &self.environment,
        };
        match scope.write(command, message_id, created_at_ms).await {
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

impl<E: SendClock + SendEntropy + Send + Sync> MentionedViewerRecord for MessagingStore<E> {
    /// Writes the records this send owes the people it named — deciding, HERE, who
    /// those names belong to and who may still read the conversation.
    ///
    /// One transaction of its own, taken after the send has committed: the entitlement
    /// read and every insert share it, so the rows that exist are the rows the world
    /// looked like when they were written. A person removed before this runs is not a
    /// candidate; a person removed after it commits keeps a record of something they
    /// could read at the time.
    async fn record_mentioned_viewers(
        &self,
        intent: &MentionIntent,
    ) -> Result<Vec<CommittedMentionRow>, EffectFailure> {
        self.record_mentions_transaction(intent)
            .await
            .map_err(EffectFailure::from_source)
    }
}

impl<E: SendClock + SendEntropy> MessagingStore<E> {
    #[tracing::instrument(skip(self, intent), fields(
        source_conversation = intent.source_conversation().as_str(),
        named = intent.handles().len(),
    ))]
    async fn record_mentions_transaction(
        &self,
        intent: &MentionIntent,
    ) -> Result<Vec<CommittedMentionRow>, MessagingStoreError> {
        let named = serde_json::to_string(
            &intent
                .handles()
                .iter()
                .map(ParticipantHandle::as_str)
                .collect::<Vec<_>>(),
        )?;
        let payload_of = |mentioned: &str| {
            serde_json::to_string(&serde_json::json!({
                "conversation_title": intent.source_conversation_title(),
                "trigger_name": intent.trigger_name(),
                "mentioned_name": mentioned,
                "mention_excerpt": intent.excerpt(),
            }))
        };

        let mut tx = self.pool.begin_with(ROOT_WRITE_BEGIN).await?;
        let entitled = sqlx::query(SELECT_ENTITLED_VIEWERS)
            .bind(named)
            .bind(intent.author().map(UserId::as_str))
            .bind(intent.source_conversation().as_str())
            .bind(intent.source_workspace().as_str())
            .fetch_all(&mut *tx)
            .await?;

        let mut rows = Vec::with_capacity(entitled.len());
        for row in entitled {
            let viewer: String = row.try_get("id")?;
            let mentioned: String = row.try_get("name")?;
            let id = NotificationId::mint(&self.environment)?;
            let created_at_ms = self.environment.now_unix_ms()?;

            sqlx::query(INSERT_MENTION_SELF)
                .bind(id.as_str())
                .bind(&viewer)
                .bind(intent.source_workspace().as_str())
                .bind(intent.source_conversation().as_str())
                .bind(intent.source_message().as_str())
                .bind(intent.source_workspace().as_str())
                .bind(intent.source_conversation().as_str())
                .bind(intent.source_message().as_str())
                .bind(payload_of(&mentioned)?)
                .bind(created_at_ms)
                .execute(&mut *tx)
                .await?;

            rows.push(CommittedMentionRow::committed(
                id,
                created_at_ms,
                UserId::parse(viewer)
                    .map_err(|_| MessagingStoreError::MalformedIdentity { field: "users.id" })?,
                ParticipantHandle::parse(mentioned).map_err(|_| {
                    MessagingStoreError::MalformedIdentity {
                        field: "users.name",
                    }
                })?,
                intent.clone(),
            ));
        }

        // Nothing is reported until every row of this batch is durable: a partial
        // report would tell some people about a record and leave others' behind.
        tx.commit().await?;
        Ok(rows)
    }
}

impl<E: SendClock + SendEntropy + Send + Sync> SendMessageUnitOfWork for MessagingStore<E> {
    async fn send_message(
        &self,
        command: SendMessage,
    ) -> Result<MessageCreatedFact, SendMessageError> {
        self.send_message_transaction(command).await
    }
}

/// The transaction's own scope. Every fact the write depends on is read through
/// it, so a concurrent change cannot land between a check and the insert.
struct TxScope<'connection, 'entropy, E> {
    tx: Transaction<'connection, Sqlite>,
    entropy: &'entropy E,
}

impl<E: SendEntropy + Send + Sync> TxScope<'_, '_, E> {
    async fn write(
        &mut self,
        command: SendMessage,
        message_id: MessageId,
        created_at_ms: i64,
    ) -> Result<MessageCreatedFact, SendMessageError> {
        // The sender's own binding must still exist. Read for existence only: what
        // the send is authorized against is the target.
        if command.source_conversation() != command.target_conversation()
            && self
                .conversation_facts(command.source_conversation())
                .await?
                .is_none()
        {
            return Err(ConversationRefusal::NotFound.into());
        }

        let facts =
            messaging::assert_post_authority(self, command.target_conversation(), command.actor())
                .await?;

        let thread_root = self
            .resolve_thread_root(&facts.id, command.destination())
            .await?;
        let snapshots = self
            .resolve_attachments(&facts.id, command.attachment_refs())
            .await?;
        let freshness_bypassed = self.assert_fresh(&command, &facts.id).await?;

        let seq = self.reserve_next_seq(&facts.id).await?;
        let author = self.author_snapshot(command.actor()).await?;
        let message = self
            .insert_message(
                &command,
                &facts.id,
                message_id,
                created_at_ms,
                thread_root,
                seq,
                author,
                snapshots,
            )
            .await?;
        self.bump_stream_head(&facts.id, message.thread_root_id.as_ref(), seq)
            .await?;

        let thread = match &message.thread_root_id {
            None => None,
            Some(root) => {
                // A cluster's durable consequences belong to this transaction: a
                // follower recorded without its catch-up would leave an agent
                // following a conversation whose beginning it cannot see.
                self.apply_cluster_follow_effects(&facts.id, root, &command, seq, created_at_ms)
                    .await?;
                Some(ThreadReplyFact {
                    thread_root_id: root.clone(),
                    // Counted after the insert, so the reported total already
                    // includes this reply and is never a value from the future.
                    reply_count: self.count_thread_replies(&facts.id, root).await?,
                })
            }
        };

        let mention_copies = self
            .apply_mention_copies(&command, &facts.id, &message, created_at_ms)
            .await?;
        // Planned last, so the enumeration sees every row this unit wrote — a
        // follower this very reply created is part of who it is for.
        let post_commit = self
            .plan_post_commit(command.source_conversation(), &facts.id, &command, &message)
            .await?;

        Ok(MessageCreatedFact::committed(
            message,
            thread,
            post_commit,
            freshness_bypassed,
            mention_copies,
        ))
    }

    /// Resolves the cluster this send belongs to, checking the caller's name for it
    /// here rather than trusting that some earlier layer did.
    async fn resolve_thread_root(
        &mut self,
        conversation: &ConversationId,
        destination: &SendDestination,
    ) -> Result<Option<ThreadRootId>, SendMessageError> {
        match destination {
            SendDestination::MainLine => Ok(None),
            // A named root must be a message of this conversation that starts a
            // cluster. Unknown, foreign, and "is itself a reply" are one answer.
            SendDestination::Thread(root) => {
                let row = self
                    .message_in_conversation(conversation, root.as_str())
                    .await?
                    .ok_or(ThreadRootRefusal)?;
                if row.thread_root_id.is_some() {
                    return Err(ThreadRootRefusal.into());
                }
                Ok(Some(root.clone()))
            }
            // A reply names a message; the cluster is that message's own root, or
            // the message itself when it starts one.
            SendDestination::Reply(target) => {
                let row = self
                    .message_in_conversation(conversation, target.as_str())
                    .await?
                    .ok_or(ReplyTargetRefusal)?;
                let root = row.thread_root_id.unwrap_or(row.id);
                Ok(Some(ThreadRootId::parse(root).map_err(|_| {
                    infrastructure(MessagingStoreError::MalformedIdentity {
                        field: "messages.id",
                    })
                })?))
            }
        }
    }

    async fn message_in_conversation(
        &mut self,
        conversation: &ConversationId,
        message_id: &str,
    ) -> Result<Option<MessageRow>, SendMessageError> {
        let row = sqlx::query(SELECT_MESSAGE_IN_CONVERSATION)
            .bind(conversation.as_str())
            .bind(message_id)
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        let Some(row) = row else { return Ok(None) };

        Ok(Some(MessageRow {
            id: row.try_get("id").map_err(driver)?,
            thread_root_id: row.try_get("thread_root_id").map_err(driver)?,
            from_kind: row.try_get("from_kind").map_err(driver)?,
            from_agent_id: row.try_get("from_agent_id").map_err(driver)?,
            from_user_id: row.try_get("from_user_id").map_err(driver)?,
        }))
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
                .map_err(|_| {
                    infrastructure(MessagingStoreError::MalformedIdentity {
                        field: "attachments.channel_id",
                    })
                })?,
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
            match messaging::freshness::freshness_gate(command.actor(), command.freshness_bypass())
            {
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
                .bind(command.source_conversation().as_str())
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
                stale_event_id: StaleEventId::mint(self.entropy)?,
                target_conversation_id: target.clone(),
            }
            .into());
        }
        Ok(false)
    }

    /// Advances the conversation's counter and reads back what it reserved. The
    /// counter is conversation-global: a reply and a main-line message draw from
    /// it alike, which is what makes `(conversation, ordinal)` a total order.
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

        // The column is this store's own, so a value the domain rejects is a
        // broken database and is reported with the value that broke it.
        MessageSeq::try_from(reserved)
            .map_err(|error| infrastructure(MessagingStoreError::Ordinal(error)))
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

    #[allow(clippy::too_many_arguments)]
    async fn insert_message(
        &mut self,
        command: &SendMessage,
        conversation: &ConversationId,
        id: MessageId,
        created_at_ms: i64,
        thread_root: Option<ThreadRootId>,
        seq: MessageSeq,
        author: Option<MessageAuthor>,
        attachments: Vec<AttachmentSnapshot>,
    ) -> Result<CreatedMessage, SendMessageError> {
        let metadata = metadata_json(&attachments)?;
        let (from_kind, agent_id, user_id) = match command.actor() {
            SendActor::Agent(agent) => (FROM_KIND_AGENT, Some(agent.as_str()), None),
            SendActor::User(user) => (FROM_KIND_USER, None, Some(user.as_str())),
        };

        sqlx::query(INSERT_MESSAGE)
            .bind(id.as_str())
            .bind(conversation.as_str())
            .bind(from_kind)
            .bind(agent_id)
            .bind(user_id)
            .bind(command.content().as_str())
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
            from_kind: command.actor().from_kind(),
            from_agent_id: match command.actor() {
                SendActor::Agent(agent) => Some(agent.clone()),
                SendActor::User(_) => None,
            },
            from_user_id: match command.actor() {
                SendActor::User(user) => Some(user.clone()),
                SendActor::Agent(_) => None,
            },
            author,
            content: command.content().clone(),
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

    /// Copies this message to each agent it addressed that cannot read the
    /// conversation it was written in, onto the direct line between them and the
    /// author — minting that line if it does not exist yet.
    ///
    /// The copy, its delivery row and the author's notification commit with the
    /// message that caused them: a copy that could be lost while the mention stands
    /// would leave the author believing they had reached someone they had not.
    ///
    /// Only a person's mention carries this promise. An agent's does not, so its
    /// send addresses no copies at all.
    async fn apply_mention_copies(
        &mut self,
        command: &SendMessage,
        source: &ConversationId,
        message: &CreatedMessage,
        created_at_ms: i64,
    ) -> Result<Vec<MentionCopyOutcome>, SendMessageError> {
        let SendActor::User(author) = command.actor() else {
            return Ok(Vec::new());
        };
        let addressed: Vec<ParticipantHandle> = command
            .addressed()
            .iter()
            .filter(|reference| reference.kind() == PrincipalKind::Agent)
            .map(|reference| reference.handle().clone())
            .collect();
        if addressed.is_empty() {
            return Ok(Vec::new());
        }

        // A copy is named after where it came from, and a direct line has no
        // workspace to be named after.
        let (workspace_id, source_title) = self.conversation_place(source).await?;
        let Some(workspace_id) = workspace_id else {
            return Ok(addressed
                .into_iter()
                .map(|handle| MentionCopyOutcome::Skipped {
                    handle,
                    reason: MentionCopySkip::SourceNotWorkspacePlaced,
                    agent: None,
                })
                .collect());
        };
        let workspace_name = self.workspace_name(&workspace_id).await?;

        // No "already copied" arm: the addressed set is deduplicated where it is
        // derived, and one handle names one agent, so a second copy to the same
        // agent has no way to be asked for.
        let mut outcomes = Vec::with_capacity(addressed.len());
        for handle in addressed {
            let Some(agent) = self.agent_by_name(&handle).await? else {
                outcomes.push(MentionCopyOutcome::Skipped {
                    handle,
                    reason: MentionCopySkip::UnknownHandle,
                    agent: None,
                });
                continue;
            };
            // Already a participant: it received the original, and a copy would be
            // the same message twice.
            if self.is_agent_participant(source, &agent).await? {
                outcomes.push(MentionCopyOutcome::Skipped {
                    handle,
                    reason: MentionCopySkip::AlreadyMember,
                    agent: Some(agent),
                });
                continue;
            }
            // The handle was resolved to an id HERE, inside the unit, and the
            // verdict was computed before it: a name that now points at a different
            // agent than it did then is not granted, and the copy does not happen.
            if !command.direct_lines().contains(&agent) {
                outcomes.push(MentionCopyOutcome::Skipped {
                    handle,
                    reason: MentionCopySkip::NoDirectLine,
                    agent: Some(agent),
                });
                continue;
            }

            let place = MentionCopyPlace {
                workspace_id: &workspace_id,
                workspace_name: &workspace_name,
                source: source.clone(),
                source_title: &source_title,
            };
            let line = self.open_direct_pair(author, &agent, created_at_ms).await?;
            let copy = self
                .write_mention_copy(&line, &handle, &place, message, author, created_at_ms)
                .await?;

            self.ensure_delivery(
                &line,
                &agent,
                copy.id.as_str(),
                DELIVERY_KIND_TURN,
                created_at_ms,
            )
            .await?;
            self.notify_author_of_copy(author, &agent, &place, message, created_at_ms)
                .await?;

            outcomes.push(MentionCopyOutcome::Copied {
                handle,
                agent,
                copy: Box::new(copy),
            });
        }
        Ok(outcomes)
    }

    /// Decides what this send owes the world, from the same snapshot it was written
    /// in.
    ///
    /// Two layers: who was named is a fact of the body and does not depend on the
    /// path, while who receives the message does — a reply reaches its cluster's
    /// followers, a main-line message reaches the conversation's participants.
    async fn plan_post_commit(
        &mut self,
        source: &ConversationId,
        target: &ConversationId,
        command: &SendMessage,
        message: &CreatedMessage,
    ) -> Result<PostCommitPlan, SendMessageError> {
        let mentions = self.mention_intent(target, command, message).await?;

        if let Some(root) = &message.thread_root_id {
            let audience = self.cluster_audience(root, command.actor()).await?;
            return Ok(PostCommitPlan::committed(
                mentions,
                DeliveryPlan::ReplyCluster(ReplyAudience::committed(audience)),
            ));
        }

        // Three cases, and they differ in both answers. An agent writing into its own
        // conversation is not delivered its own message, and starts nobody: the
        // runtime that would be started is the one already running to write this. An
        // agent writing into ANOTHER conversation is not the same actor there — that
        // conversation's own session is a recipient, and idle recipients are started.
        // A person's send excludes nobody and starts whoever is idle.
        let writes_elsewhere = source != target;
        let (excluded, starts) = match command.actor() {
            SendActor::Agent(agent) if !writes_elsewhere => {
                (Some(agent.as_str().to_owned()), false)
            }
            SendActor::Agent(_) => (None, true),
            SendActor::User(_) => (None, true),
        };

        let participants: Vec<String> = sqlx::query_scalar(SELECT_PARTICIPANT_AGENTS)
            .bind(target.as_str())
            .fetch_all(&mut *self.tx)
            .await
            .map_err(driver)?;
        let recipients: Vec<messaging::AgentId> = participants
            .into_iter()
            .filter(|candidate| excluded.as_deref() != Some(candidate.as_str()))
            .map(|candidate| {
                messaging::AgentId::parse(candidate).map_err(|_| {
                    infrastructure(MessagingStoreError::MalformedIdentity { field: "agents.id" })
                })
            })
            .collect::<Result<_, _>>()?;
        let start_eligible = if starts {
            recipients.clone()
        } else {
            Vec::new()
        };

        Ok(PostCommitPlan::committed(
            mentions,
            DeliveryPlan::MainLine(MainDeliveryPlan::committed(recipients, start_eligible)),
        ))
    }

    /// What this send says about naming people, if it named anyone inside a workspace.
    ///
    /// Only the facts of the send: the handles the body named, where it happened, who
    /// wrote it, and what it said. Who is entitled to be told is NOT decided here —
    /// that is a fact of the moment the record is written, and deciding it now would
    /// both freeze an entitlement that can be revoked in between and drag its reads
    /// into this transaction, where a failed lookup for a notification would roll back
    /// a message that was otherwise complete.
    ///
    /// Nothing is recorded outside a workspace: a mention record is navigated to by
    /// workspace and conversation, and a direct line has no workspace to reach it from.
    async fn mention_intent(
        &mut self,
        conversation: &ConversationId,
        command: &SendMessage,
        message: &CreatedMessage,
    ) -> Result<Option<MentionIntent>, SendMessageError> {
        let handles: Vec<ParticipantHandle> = command
            .addressed()
            .iter()
            .filter(|reference| reference.kind() == PrincipalKind::Human)
            .map(|reference| reference.handle().clone())
            .collect();
        if handles.is_empty() {
            return Ok(None);
        }

        let (workspace_id, title) = self.conversation_place(conversation).await?;
        let Some(workspace_id) = workspace_id else {
            return Ok(None);
        };
        let workspace = messaging::WorkspaceId::parse(workspace_id).map_err(|_| {
            infrastructure(MessagingStoreError::MalformedIdentity {
                field: "conversations.workspace_id",
            })
        })?;

        Ok(Some(MentionIntent::committed(
            handles,
            match command.actor() {
                SendActor::User(author) => Some(author.clone()),
                SendActor::Agent(_) => None,
            },
            trigger_name_of(message),
            workspace,
            conversation.clone(),
            title,
            message.id.clone(),
            mention_cc::mention_excerpt(message.content.as_str()),
        )))
    }

    async fn conversation_place(
        &mut self,
        conversation: &ConversationId,
    ) -> Result<(Option<String>, String), SendMessageError> {
        let row = sqlx::query(SELECT_CONVERSATION_PLACE)
            .bind(conversation.as_str())
            .fetch_one(&mut *self.tx)
            .await
            .map_err(driver)?;
        Ok((
            row.try_get("workspace_id").map_err(driver)?,
            row.try_get("title").map_err(driver)?,
        ))
    }

    async fn workspace_name(&mut self, workspace: &str) -> Result<String, SendMessageError> {
        let name: Option<String> = sqlx::query_scalar(SELECT_WORKSPACE_NAME)
            .bind(workspace)
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        name.ok_or_else(|| {
            infrastructure(MessagingStoreError::MalformedIdentity {
                field: "conversations.workspace_id",
            })
        })
    }

    async fn agent_by_name(
        &mut self,
        handle: &ParticipantHandle,
    ) -> Result<Option<messaging::AgentId>, SendMessageError> {
        let found: Option<String> = sqlx::query_scalar(SELECT_AGENT_ID_BY_NAME)
            .bind(handle.as_str())
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        match found {
            None => Ok(None),
            Some(id) => Ok(Some(messaging::AgentId::parse(id).map_err(|_| {
                infrastructure(MessagingStoreError::MalformedIdentity { field: "agents.id" })
            })?)),
        }
    }

    /// Gets or creates the line between two principals. The endpoints are stored in
    /// one canonical order so the pair has a single identity whichever side is
    /// asking; the order is the database's own, which in Rust is just how strings
    /// compare.
    async fn open_direct_pair(
        &mut self,
        author: &UserId,
        agent: &messaging::AgentId,
        created_at_ms: i64,
    ) -> Result<ConversationId, SendMessageError> {
        let human = (ENDPOINT_KIND_HUMAN, author.as_str());
        let machine = (ENDPOINT_KIND_AGENT, agent.as_str());
        let (first, second) = if machine <= human {
            (machine, human)
        } else {
            (human, machine)
        };

        let minted = ConversationId::mint(self.entropy)?;
        sqlx::query(OPEN_DIRECT_PAIR)
            .bind(minted.as_str())
            .bind(first.0)
            .bind(first.1)
            .bind(second.0)
            .bind(second.1)
            .bind(created_at_ms)
            .bind(created_at_ms)
            .execute(&mut *self.tx)
            .await
            .map_err(driver)?;

        // Absent only if the statement above neither wrote the row nor conflicted
        // with it, which the conflict target rules out.
        let existing: Option<String> = sqlx::query_scalar(SELECT_DIRECT_PAIR)
            .bind(first.0)
            .bind(first.1)
            .bind(second.0)
            .bind(second.1)
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        let existing = existing.ok_or_else(|| {
            infrastructure(MessagingStoreError::MalformedIdentity {
                field: "conversations.direct_pair",
            })
        })?;
        ConversationId::parse(existing).map_err(|_| {
            infrastructure(MessagingStoreError::MalformedIdentity {
                field: "conversations.id",
            })
        })
    }

    /// Writes the copy into the line: the same three facts a send writes anywhere —
    /// the conversation's ordinal, the message, the stream head.
    async fn write_mention_copy(
        &mut self,
        line: &ConversationId,
        recipient: &ParticipantHandle,
        place: &MentionCopyPlace<'_>,
        message: &CreatedMessage,
        author: &UserId,
        created_at_ms: i64,
    ) -> Result<mention_cc::CommittedMentionCopy, SendMessageError> {
        let seq = self.reserve_next_seq(line).await?;
        let copy = mention_cc::CommittedMentionCopy {
            id: MessageId::mint(self.entropy)?,
            conversation_id: line.clone(),
            from_kind: messaging::FromKind::System,
            content: mention_cc::render_copy_body(&mention_cc::MentionCopySource {
                recipient_handle: recipient,
                source_workspace_name: place.workspace_name,
                source_conversation_title: place.source_title,
                source_content: message.content.as_str(),
            }),
            metadata: mention_cc::MentionCopyMetadata {
                subtype: mention_cc::MENTION_COPY_SUBTYPE,
                source_workspace_id: place.workspace_id.to_owned(),
                source_workspace_name: place.workspace_name.to_owned(),
                source_conversation_id: place.source.clone(),
                source_conversation_title: place.source_title.to_owned(),
                source_message_id: message.id.clone(),
                source_from_kind: messaging::FromKind::User,
                source_from_user_id: author.clone(),
                source_message_content: message.content.as_str().to_owned(),
            },
            seq,
            created_at_ms,
            cc_source_message_id: message.id.clone(),
        };

        // The row is written FROM the fact, so what was committed and what is
        // reported are the same value rather than two renderings of one intent.
        sqlx::query(INSERT_MENTION_COPY)
            .bind(copy.id.as_str())
            .bind(copy.conversation_id.as_str())
            .bind(from_kind_column(copy.from_kind))
            .bind(&copy.content)
            .bind(mention_copy_metadata(&copy.metadata)?)
            .bind(copy.seq.get())
            .bind(copy.created_at_ms)
            .bind(copy.cc_source_message_id.as_str())
            .execute(&mut *self.tx)
            .await
            .map_err(driver)?;
        self.bump_stream_head(&copy.conversation_id, None, copy.seq)
            .await?;
        Ok(copy)
    }

    async fn notify_author_of_copy(
        &mut self,
        author: &UserId,
        agent: &messaging::AgentId,
        place: &MentionCopyPlace<'_>,
        message: &CreatedMessage,
        created_at_ms: i64,
    ) -> Result<(), SendMessageError> {
        let payload = mention_cc::MentionNotificationPayload::of(
            place.workspace_name,
            place.source_title,
            message.content.as_str(),
        );
        let id = MessageId::mint(self.entropy)?;

        sqlx::query(INSERT_MENTION_NOTIFICATION)
            .bind(id.as_str())
            .bind(author.as_str())
            .bind(agent.as_str())
            .bind(place.workspace_id)
            .bind(place.source.as_str())
            .bind(message.id.as_str())
            .bind(place.workspace_id)
            .bind(place.source.as_str())
            .bind(message.id.as_str())
            .bind(mention_notification_payload(&payload)?)
            .bind(created_at_ms)
            .execute(&mut *self.tx)
            .await
            .map_err(driver)?;
        Ok(())
    }

    /// Records who follows this cluster now, and catches up whoever is new to it.
    ///
    /// Three sources, in this order: the sender, the root's author, and every
    /// principal the reply addressed. A reference widens the cluster's audience but
    /// grants nothing — following is not a way into a conversation — so each
    /// candidate still has to pass participation and liveness.
    async fn apply_cluster_follow_effects(
        &mut self,
        conversation: &ConversationId,
        root: &ThreadRootId,
        command: &SendMessage,
        current_seq: MessageSeq,
        followed_at_ms: i64,
    ) -> Result<(), SendMessageError> {
        // The cluster's anchor is read once: every catch-up needs it, and one
        // transaction is one snapshot.
        let root_row = self
            .message_in_conversation(conversation, root.as_str())
            .await?;

        self.follow_actor(
            conversation,
            root,
            root_row.as_ref(),
            command.actor(),
            ThreadFollowerSource::Reply,
            current_seq,
            followed_at_ms,
        )
        .await?;

        if let Some(row) = &root_row
            && let Some(author) = actor_of_row(row)?
        {
            self.follow_actor(
                conversation,
                root,
                root_row.as_ref(),
                &author,
                ThreadFollowerSource::TargetAuthor,
                current_seq,
                followed_at_ms,
            )
            .await?;
        }

        for reference in command.addressed().iter() {
            // The reference's own kind decides which namespace answers for the
            // handle: a human reference must never resolve to an agent of the same
            // name.
            let statement = match reference.kind() {
                PrincipalKind::Agent => SELECT_AGENT_ID_BY_NAME,
                PrincipalKind::Human => SELECT_USER_ID_BY_NAME,
            };
            let resolved: Option<String> = sqlx::query_scalar(statement)
                .bind(reference.handle().as_str())
                .fetch_optional(&mut *self.tx)
                .await
                .map_err(driver)?;
            let Some(resolved) = resolved else { continue };

            let addressed = actor_of(reference.kind(), resolved)?;
            self.follow_actor(
                conversation,
                root,
                root_row.as_ref(),
                &addressed,
                ThreadFollowerSource::Mention,
                current_seq,
                followed_at_ms,
            )
            .await?;
        }
        Ok(())
    }

    /// Participation and liveness are both required, and they are different
    /// questions: participation survives a departed principal on purpose so a
    /// survivor keeps reading, while a delivery row for a principal that no longer
    /// exists cannot be written at all.
    #[allow(clippy::too_many_arguments)]
    async fn follow_actor(
        &mut self,
        conversation: &ConversationId,
        root: &ThreadRootId,
        root_row: Option<&MessageRow>,
        actor: &SendActor,
        source: ThreadFollowerSource,
        current_seq: MessageSeq,
        followed_at_ms: i64,
    ) -> Result<(), SendMessageError> {
        let (kind, id) = match actor {
            SendActor::Agent(agent) => (PRINCIPAL_KIND_AGENT, agent.as_str()),
            SendActor::User(user) => (PRINCIPAL_KIND_HUMAN, user.as_str()),
        };

        let participates = match actor {
            SendActor::Agent(agent) => self.is_agent_participant(conversation, agent).await?,
            SendActor::User(user) => self.is_user_participant(conversation, user).await?,
        };
        if !participates {
            return Ok(());
        }
        let alive = match actor {
            SendActor::Agent(agent) => self.agent_exists(agent).await?,
            SendActor::User(user) => {
                self.endpoint_principal_exists(&ConversationEndpoint {
                    kind: PrincipalKind::Human,
                    id: user.as_str().to_owned(),
                    deleted_at_ms: None,
                })
                .await?
            }
        };
        if !alive {
            return Ok(());
        }

        let followed = sqlx::query(FOLLOW_CLUSTER)
            .bind(root.as_str())
            .bind(conversation.as_str())
            .bind(kind)
            .bind(id)
            .bind(followed_at_ms)
            .bind(match source {
                ThreadFollowerSource::Reply => FOLLOWER_SOURCE_REPLY,
                ThreadFollowerSource::TargetAuthor => FOLLOWER_SOURCE_TARGET_AUTHOR,
                ThreadFollowerSource::Mention => FOLLOWER_SOURCE_MENTION,
            })
            .execute(&mut *self.tx)
            .await
            .map_err(driver)?
            .rows_affected();

        // Only a NEW follower is caught up, and only an agent has anywhere to
        // catch up into: a person reads a conversation, an agent is delivered one.
        if followed == 1
            && let SendActor::Agent(agent) = actor
        {
            self.backfill_cluster_history(
                conversation,
                root_row,
                root,
                agent,
                current_seq,
                followed_at_ms,
            )
            .await?;
        }
        Ok(())
    }

    /// Queues the cluster as it stood before this reply: the root, which anchors it,
    /// and every earlier message of it. Complete by design — a follower that joined
    /// mid-cluster must not land with a hole next to the newest replies — and the
    /// agent's own messages are skipped because it has already seen what it said.
    /// The current reply is not queued here; delivering it is a separate act.
    #[allow(clippy::too_many_arguments)]
    async fn backfill_cluster_history(
        &mut self,
        conversation: &ConversationId,
        root_row: Option<&MessageRow>,
        root: &ThreadRootId,
        agent: &messaging::AgentId,
        current_seq: MessageSeq,
        queued_at_ms: i64,
    ) -> Result<(), SendMessageError> {
        if let Some(root_row) = root_row
            && !root_row.authored_by(agent)
        {
            self.ensure_delivery(
                conversation,
                agent,
                &root_row.id,
                DELIVERY_KIND_OBSERVE,
                queued_at_ms,
            )
            .await?;
        }

        let history = sqlx::query(SELECT_CLUSTER_HISTORY)
            .bind(conversation.as_str())
            .bind(root.as_str())
            .bind(current_seq.get())
            .fetch_all(&mut *self.tx)
            .await
            .map_err(driver)?;
        for row in history {
            let earlier = MessageRow {
                id: row.try_get("id").map_err(driver)?,
                thread_root_id: None,
                from_kind: row.try_get("from_kind").map_err(driver)?,
                from_agent_id: row.try_get("from_agent_id").map_err(driver)?,
                from_user_id: None,
            };
            if earlier.authored_by(agent) {
                continue;
            }
            self.ensure_delivery(
                conversation,
                agent,
                &earlier.id,
                DELIVERY_KIND_OBSERVE,
                queued_at_ms,
            )
            .await?;
        }
        Ok(())
    }

    async fn ensure_delivery(
        &mut self,
        conversation: &ConversationId,
        agent: &messaging::AgentId,
        message_id: &str,
        delivery_kind: &'static str,
        queued_at_ms: i64,
    ) -> Result<(), SendMessageError> {
        sqlx::query(ENSURE_INBOX_DELIVERY)
            .bind(conversation.as_str())
            .bind(agent.as_str())
            .bind(message_id)
            .bind(delivery_kind)
            .bind(queued_at_ms)
            .execute(&mut *self.tx)
            .await
            .map_err(driver)?;
        Ok(())
    }

    /// Who this reply is for: the cluster's follower agents that still participate
    /// and still exist, minus the sender — nobody is delivered their own message.
    /// Read here because the answer must include the followers this transaction
    /// just created.
    async fn cluster_audience(
        &mut self,
        root: &ThreadRootId,
        actor: &SendActor,
    ) -> Result<Vec<messaging::AgentId>, SendMessageError> {
        let rows: Vec<String> = sqlx::query_scalar(SELECT_CLUSTER_AUDIENCE)
            .bind(root.as_str())
            .fetch_all(&mut *self.tx)
            .await
            .map_err(driver)?;

        let sender = match actor {
            SendActor::Agent(agent) => Some(agent.as_str()),
            SendActor::User(_) => None,
        };
        rows.into_iter()
            .filter(|candidate| sender != Some(candidate.as_str()))
            .map(|candidate| {
                messaging::AgentId::parse(candidate).map_err(|_| {
                    infrastructure(MessagingStoreError::MalformedIdentity {
                        field: "thread_followers.principal_id",
                    })
                })
            })
            .collect()
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

/// The principal a stored row names as its author, or nothing when the row was
/// written by the system or its author is no longer named on it.
fn actor_of_row(row: &MessageRow) -> Result<Option<SendActor>, SendMessageError> {
    match row.from_kind.as_str() {
        FROM_KIND_AGENT => match &row.from_agent_id {
            Some(agent) => Ok(Some(actor_of(PrincipalKind::Agent, agent.clone())?)),
            None => Ok(None),
        },
        FROM_KIND_USER => match &row.from_user_id {
            Some(user) => Ok(Some(actor_of(PrincipalKind::Human, user.clone())?)),
            None => Ok(None),
        },
        _ => Ok(None),
    }
}

fn actor_of(kind: PrincipalKind, id: String) -> Result<SendActor, SendMessageError> {
    let malformed = || {
        infrastructure(MessagingStoreError::MalformedIdentity {
            field: "messages author",
        })
    };
    Ok(match kind {
        PrincipalKind::Agent => {
            SendActor::Agent(messaging::AgentId::parse(id).map_err(|_| malformed())?)
        }
        PrincipalKind::Human => SendActor::User(UserId::parse(id).map_err(|_| malformed())?),
    })
}

/// Where a copy came from, carried together because every write of a copy needs all
/// of it.
struct MentionCopyPlace<'facts> {
    workspace_id: &'facts str,
    workspace_name: &'facts str,
    source: ConversationId,
    source_title: &'facts str,
}

fn from_kind_column(kind: messaging::FromKind) -> &'static str {
    match kind {
        messaging::FromKind::User => FROM_KIND_USER,
        messaging::FromKind::Agent => FROM_KIND_AGENT,
        messaging::FromKind::System => FROM_KIND_SYSTEM,
    }
}

fn mention_copy_metadata(
    metadata: &mention_cc::MentionCopyMetadata,
) -> Result<String, SendMessageError> {
    serde_json::to_string(&serde_json::json!({
        "subtype": metadata.subtype,
        "source_workspace_id": metadata.source_workspace_id,
        "source_workspace_name": metadata.source_workspace_name,
        "source_conversation_id": metadata.source_conversation_id.as_str(),
        "source_conversation_title": metadata.source_conversation_title,
        "source_message_id": metadata.source_message_id.as_str(),
        "source_from_kind": from_kind_column(metadata.source_from_kind),
        "source_from_user_id": metadata.source_from_user_id.as_str(),
        "source_message_content": metadata.source_message_content,
    }))
    .map_err(|error| infrastructure(MessagingStoreError::Serialization(error)))
}

fn mention_notification_payload(
    payload: &mention_cc::MentionNotificationPayload<'_>,
) -> Result<String, SendMessageError> {
    serde_json::to_string(&serde_json::json!({
        "source_workspace_name": payload.source_workspace_name,
        "source_conversation_title": payload.source_conversation_title,
        "mention_excerpt": payload.mention_excerpt,
    }))
    .map_err(|error| infrastructure(MessagingStoreError::Serialization(error)))
}

/// Who named someone, as a reader will see it. The sender's own snapshot, taken
/// inside the transaction: display name if it says anything, then name, then the id —
/// an id is not friendly, but it is never absent.
fn trigger_name_of(message: &CreatedMessage) -> String {
    match &message.author {
        None => String::new(),
        Some(author) => {
            let display = author.display_name.as_deref().unwrap_or("").trim();
            if !display.is_empty() {
                return display.to_owned();
            }
            if !author.name.trim().is_empty() {
                return author.name.clone();
            }
            author.id.clone()
        }
    }
}

struct MessageRow {
    id: String,
    thread_root_id: Option<String>,
    from_kind: String,
    from_agent_id: Option<String>,
    from_user_id: Option<String>,
}

impl MessageRow {
    fn authored_by(&self, agent: &messaging::AgentId) -> bool {
        self.from_kind == FROM_KIND_AGENT && self.from_agent_id.as_deref() == Some(agent.as_str())
    }
}

impl<E: Send + Sync> EndpointPrincipalReads for TxScope<'_, '_, E> {
    async fn endpoint_principal_exists(
        &mut self,
        endpoint: &ConversationEndpoint,
    ) -> Result<bool, PersistenceFailure> {
        let statement = match endpoint.kind {
            PrincipalKind::Agent => SELECT_AGENT_EXISTS,
            PrincipalKind::Human => SELECT_USER_EXISTS,
        };
        let found: Option<i64> = sqlx::query_scalar(statement)
            .bind(endpoint.id.as_str())
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(driver)?;
        Ok(found.is_some())
    }
}

impl<E: Send + Sync> PostAuthorityReads for TxScope<'_, '_, E> {
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
                a: endpoint_from_row(&row, EndpointSlot::A)?,
                b: endpoint_from_row(&row, EndpointSlot::B)?,
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

enum EndpointSlot {
    A,
    B,
}

fn endpoint_from_row(
    row: &sqlx::sqlite::SqliteRow,
    slot: EndpointSlot,
) -> Result<ConversationEndpoint, PersistenceFailure> {
    let malformed = || PersistenceFailure::from_source(MessagingStoreError::MalformedPlacement);
    let (kind_column, id_column, deleted_column) = match slot {
        EndpointSlot::A => ("endpoint_a_kind", "endpoint_a_id", "endpoint_a_deleted_at"),
        EndpointSlot::B => ("endpoint_b_kind", "endpoint_b_id", "endpoint_b_deleted_at"),
    };

    let kind: Option<String> = row.try_get(kind_column).map_err(driver)?;
    let id: Option<String> = row.try_get(id_column).map_err(driver)?;
    let deleted_at_ms: Option<i64> = row.try_get(deleted_column).map_err(driver)?;
    let (kind, id) = kind.zip(id).ok_or_else(malformed)?;

    let kind = match kind.as_str() {
        ENDPOINT_KIND_HUMAN => PrincipalKind::Human,
        ENDPOINT_KIND_AGENT => PrincipalKind::Agent,
        _ => return Err(malformed()),
    };
    Ok(ConversationEndpoint {
        kind,
        id,
        deleted_at_ms,
    })
}

/// The durable snapshot shape, owned by the schema that holds it rather than by
/// the application type it is projected from.
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

#[cfg(test)]
#[path = "../../tests/support/current_schema_snapshot.rs"]
mod current_schema;

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;
    use std::time::Instant;

    /// Opening needs a database file but no product schema, so these two facts
    /// about the connection itself are checked without one.
    async fn empty_database(path: &Path) {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        SqlitePool::connect_with(options)
            .await
            .unwrap()
            .close()
            .await;
    }

    /// The clock's unit, asserted as a conversion: a wall-clock reading would make
    /// the assertion depend on the machine's time rather than on this code.
    #[test]
    fn the_host_clock_answers_in_unix_milliseconds() {
        let one_and_a_half_seconds = UNIX_EPOCH + Duration::from_millis(1_500);

        assert_eq!(unix_ms_since_epoch(UNIX_EPOCH).unwrap(), 0);
        assert_eq!(unix_ms_since_epoch(one_and_a_half_seconds).unwrap(), 1_500);
    }

    /// The host randomness is exercised for reachability only, alongside the host
    /// clock it shares an adapter with. What it produces is not asserted: any claim
    /// about the bytes would be a claim about chance.
    #[test]
    fn the_host_entropy_answers() {
        let mut buffer = [0u8; 32];

        assert!(HostEnvironment.fill(&mut buffer).is_ok());
    }

    /// A moment this system cannot express as a Unix millisecond is reported
    /// rather than truncated into a plausible one.
    #[test]
    fn a_moment_outside_the_supported_range_is_refused() {
        let before_epoch = UNIX_EPOCH - Duration::from_millis(1);
        let far_future = UNIX_EPOCH + Duration::from_secs(1 << 60);

        assert!(unix_ms_since_epoch(before_epoch).is_err());
        assert!(unix_ms_since_epoch(far_future).is_err());
    }

    /// The audience read must stay bounded by the cluster. A plan that scanned
    /// `agents` would make every send cost the size of the installation, which is
    /// exactly what the single statement exists to avoid.
    #[tokio::test]
    async fn the_audience_read_is_bounded_by_the_cluster_not_the_installation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("plan.sqlite");
        let mut connection = super::current_schema::create_current_schema(&path).await;

        let plan: Vec<String> = sqlx::query(EXPLAIN_CLUSTER_AUDIENCE)
            .bind("root-1")
            .fetch_all(&mut connection)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect();

        let followers_bounded = plan.iter().any(|step| {
            step.starts_with("SEARCH tf") || step.starts_with("SEARCH thread_followers")
        });
        assert!(
            followers_bounded,
            "the cluster's follower rows were not searched by root: {plan:?}"
        );
        for step in &plan {
            assert!(
                !step.starts_with("SCAN a") && !step.starts_with("SCAN agents"),
                "the plan scans every agent in the installation: {plan:?}"
            );
            assert!(
                !step.starts_with("SCAN tf"),
                "the plan scans every follower row: {plan:?}"
            );
        }
    }

    /// The entitlement read and the inserts are ONE write transaction, and the proof
    /// is that the read cannot happen without the writer.
    ///
    /// The batch chosen here would write NOTHING — it names somebody this database
    /// has never heard of — so an adapter that read on a snapshot and only asked for
    /// the writer when it had a row to insert would answer "nobody entitled" and
    /// succeed. Refusing instead is what says the decision and the rows it justifies
    /// share a transaction: nothing can be committed against a world that has moved
    /// on since the question was asked.
    #[tokio::test]
    async fn the_entitlement_decision_cannot_be_taken_without_the_writer() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("entitlement-writer.sqlite");
        current_schema::create_current_schema(&path)
            .await
            .close()
            .await
            .unwrap();
        let store = MessagingStore::open_with_busy_timeout(
            &path,
            HostEnvironment,
            Duration::from_millis(25),
        )
        .await
        .unwrap();

        let held = store.pool.begin_with(ROOT_WRITE_BEGIN).await.unwrap();
        let started = Instant::now();
        let failure = store
            .record_mentions_transaction(&MentionIntent::committed(
                vec![ParticipantHandle::parse("nobody").unwrap()],
                None,
                "Lio".into(),
                messaging::WorkspaceId::parse("ws-1").unwrap(),
                ConversationId::parse("conv-1").unwrap(),
                "Channel".into(),
                MessageId::parse("message-1").unwrap(),
                "named nobody".into(),
            ))
            .await
            .unwrap_err();

        assert!(
            started.elapsed() < Duration::from_secs(1),
            "writer contention exceeded the controlled short timeout"
        );
        let MessagingStoreError::Sql(error) = &failure else {
            panic!("expected a driver failure, got {failure:?}");
        };
        assert_eq!(
            error
                .as_database_error()
                .and_then(|it| it.code())
                .as_deref(),
            Some("5"), // SQLITE_BUSY
        );
        held.rollback().await.unwrap();
    }

    /// The entitlement read must stay bounded by the NAMES A BODY USED. It runs while
    /// the adapter holds SQLite's single writer, so a plan that scanned `users` — or
    /// either membership table — would make one mention cost the size of the
    /// installation and hold the writer for it.
    #[tokio::test]
    async fn the_entitlement_read_is_bounded_by_the_named_set_not_the_installation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("entitlement-plan.sqlite");
        let mut connection = super::current_schema::create_current_schema(&path).await;

        let plan: Vec<String> = sqlx::query(EXPLAIN_ENTITLED_VIEWERS)
            .bind(r#"["human"]"#)
            .bind(Option::<&str>::None)
            .bind("conv-1")
            .bind("ws-1")
            .fetch_all(&mut connection)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect();

        // What has to hold is the COST, not one spelling of it: `users` is reached by
        // NAME, so the read is bounded by the names the body used. Reaching it any
        // other way makes one mention cost the installation — that is the shape the
        // prohibitions below forbid, and it is what a correlated rewrite produces.
        // The `ORDER BY` temp b-tree sorts that same bounded set rather than a table.
        assert!(
            plan.iter()
                .any(|step| step.starts_with("SEARCH u") || step.starts_with("SEARCH users")),
            "a named handle was not resolved through an index on `users`: {plan:?}"
        );
        for step in &plan {
            assert!(
                !step.starts_with("SCAN u") && !step.starts_with("SCAN users"),
                "the plan scans every person in the installation: {plan:?}"
            );
            assert!(
                !step.starts_with("SCAN cu")
                    && !step.starts_with("SCAN conversation_users")
                    && !step.starts_with("SCAN wu")
                    && !step.starts_with("SCAN workspace_users"),
                "the plan scans a membership table instead of probing it: {plan:?}"
            );
        }
    }

    /// The one cell the send path cannot reach: a follower row that names an agent
    /// whose row is gone, on a placement whose participation is named by the
    /// conversation row rather than by a roster with a foreign key. Participation
    /// says yes and existence says no, and the two texts have to agree that the
    /// answer is no — a delivery row for a principal that does not exist cannot be
    /// written at all. Reached directly because a survivor's further sends into such
    /// a pair are refused, so no send can observe it.
    #[tokio::test]
    async fn the_two_participation_texts_agree_when_a_follower_no_longer_exists() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("liveness.sqlite");
        let mut db = super::current_schema::create_current_schema(&path).await;

        for statement in [
            "INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-1', 'host', 'local', 0)",
            "INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES ('user-1', \
             'human', 'Human', 0, 0)",
            "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, \
             display_name, created_by_user_id) VALUES ('agent-gone', 'gone', 'claude', 'host-1', \
             0, 0, 'Gone', 'user-1')",
            "INSERT INTO conversations (id, placement_kind, roster_policy, title, status, \
             endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id, created_at, \
             updated_at) VALUES ('pair-1', 'direct_pair', 'fixed', 'DM', 'open', 'agent', \
             'agent-gone', 'human', 'user-1', 0, 0)",
            "INSERT INTO messages (id, conversation_id, from_kind, content, seq, created_at) \
             VALUES ('root-000000000000', 'pair-1', 'system', 'anchor', 1, 0)",
            "INSERT INTO thread_followers (thread_root_id, conversation_id, principal_kind, \
             principal_id, followed_at, source) VALUES ('root-000000000000', 'pair-1', 'agent', \
             'agent-gone', 1, 'reply')",
        ] {
            sqlx::query(statement).execute(&mut db).await.unwrap();
        }

        let audience_before: Vec<String> = sqlx::query_scalar(SELECT_CLUSTER_AUDIENCE)
            .bind("root-000000000000")
            .fetch_all(&mut db)
            .await
            .unwrap();
        assert_eq!(audience_before, vec!["agent-gone".to_owned()]);

        // The agents row goes; the pair still names the same id as its endpoint,
        // because that column is not a foreign key.
        sqlx::query("DELETE FROM agents WHERE id = 'agent-gone'")
            .execute(&mut db)
            .await
            .unwrap();

        let participates: Option<i64> = sqlx::query_scalar(SELECT_AGENT_PARTICIPATES)
            .bind("pair-1")
            .bind("agent-gone")
            .bind("agent-gone")
            .bind("agent-gone")
            .fetch_optional(&mut db)
            .await
            .unwrap();
        let exists: Option<i64> = sqlx::query_scalar(SELECT_AGENT_EXISTS)
            .bind("agent-gone")
            .fetch_optional(&mut db)
            .await
            .unwrap();
        let audience_after: Vec<String> = sqlx::query_scalar(SELECT_CLUSTER_AUDIENCE)
            .bind("root-000000000000")
            .fetch_all(&mut db)
            .await
            .unwrap();

        assert!(
            participates.is_some(),
            "the pair stopped naming its endpoint"
        );
        assert!(exists.is_none());
        assert!(
            audience_after.is_empty(),
            "the audience kept an agent that no longer exists"
        );
    }

    #[tokio::test]
    async fn the_store_refuses_to_provision_a_database_it_does_not_own() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("absent.db");

        let outcome = MessagingStore::open(&path).await;

        assert!(matches!(outcome, Err(MessagingStoreError::Sql(_))));
        assert!(!path.exists(), "the store created a database file");
    }

    #[tokio::test]
    async fn every_pool_connection_carries_the_durability_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("configuration.db");
        empty_database(&path).await;
        let store = MessagingStore::open(&path).await.unwrap();

        let mut connections = Vec::new();
        for _ in 0..POOL_CONNECTIONS {
            connections.push(store.pool.acquire().await.unwrap());
        }
        for connection in &mut connections {
            let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
                .fetch_one(&mut **connection)
                .await
                .unwrap();
            let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
                .fetch_one(&mut **connection)
                .await
                .unwrap();
            let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
                .fetch_one(&mut **connection)
                .await
                .unwrap();
            let busy_timeout_ms: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
                .fetch_one(&mut **connection)
                .await
                .unwrap();

            assert_eq!(journal_mode, "wal");
            assert_eq!(synchronous, 2); // FULL
            assert_eq!(foreign_keys, 1);
            assert_eq!(busy_timeout_ms, 5_000);
        }
    }
}
