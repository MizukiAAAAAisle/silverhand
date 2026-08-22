//! Adapter tests against the real product schema.
//!
//! Each test gets its own file-backed database, built from the checked-in schema
//! oracle the TypeScript migration chain is already gated against. Nothing here
//! touches a live database, and the store under test never provisions one.

use std::path::Path;

use serde_json::json;
use silverhand_backend_core::messaging::{
    AgentId, ConversationId, MessageId, MessageSeq, SendActor, SendDestination, SendMessage,
    ThreadRootId, UserId, attachments::AttachmentRef,
};
use sqlx::{Row, SqlitePool, sqlite::SqliteConnectOptions};
use tempfile::TempDir;

use super::*;

/// The product schema as SQL, generated from the owning migration chain. Checked
/// in because these tests must not run a migrator, and regenerated rather than
/// edited.
const SCHEMA_FIXTURE: &str = include_str!("../../tests/fixtures/product-schema.sql");

/// The owning chain's own drift artifact: a whitespace-collapsed fingerprint of
/// every `sqlite_master` row. It is not executable — a collapsed line comment
/// swallows the rest of its statement — so it cannot be the fixture, but it keeps
/// the fixture from silently becoming a second schema authority.
const SCHEMA_FINGERPRINT_ORACLE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/backend/tests/migration-baseline/schema-current.normalized.txt"
));

const SCHEMA_FINGERPRINT_SQL: &str = "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT \
     NULL AND name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY type, name";

const HOST_ID: &str = "host-1";
const USER_ID: &str = "user-1";
const AGENT_ID: &str = "agent-1";
/// A second runtime, declared at birth to judge freshness across every
/// conversation. Its scope is immutable, so the broad arm needs its own agent
/// rather than an update.
const BROAD_AGENT_ID: &str = "agent-2";
const WORKSPACE_ID: &str = "ws-1";
const CHANNEL_ID: &str = "conv-1";
const OTHER_CHANNEL_ID: &str = "conv-2";
const PAIR_ID: &str = "pair-1";

struct Fixture {
    _dir: TempDir,
    store: MessagingStore,
    pool: SqlitePool,
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("product.db");
        let pool = provision(&path).await;
        seed(&pool).await;
        let store = MessagingStore::open(&path).await.unwrap();
        Self {
            _dir: dir,
            store,
            pool,
        }
    }

    async fn scalar<T>(&self, sql: &'static str) -> T
    where
        T: for<'row> sqlx::Decode<'row, sqlx::Sqlite> + sqlx::Type<sqlx::Sqlite> + Send + Unpin,
    {
        sqlx::query_scalar(sql).fetch_one(&self.pool).await.unwrap()
    }

    async fn latest_seq(&self, conversation: &str) -> i64 {
        sqlx::query_scalar("SELECT latest_message_seq FROM conversations WHERE id = ?")
            .bind(conversation)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn stream_head(&self, conversation: &str, thread_root: Option<&str>) -> Option<i64> {
        sqlx::query_scalar(
            "SELECT latest_seq FROM conversation_stream_heads WHERE conversation_id = ? AND \
             thread_root_id IS ?",
        )
        .bind(conversation)
        .bind(thread_root)
        .fetch_optional(&self.pool)
        .await
        .unwrap()
    }
}

/// Applies the fixture to a fresh file. The store under test never does this: the
/// schema has an owner, and provisioning here is the test standing in for it.
async fn provision(path: &Path) -> SqlitePool {
    let pool = SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true),
    )
    .await
    .unwrap();

    sqlx::raw_sql(SCHEMA_FIXTURE).execute(&pool).await.unwrap();
    pool
}

/// The same fingerprint the owning chain computes for its own drift guard.
async fn schema_fingerprint(pool: &SqlitePool) -> String {
    let rows = sqlx::query(SCHEMA_FINGERPRINT_SQL)
        .fetch_all(pool)
        .await
        .unwrap();
    let mut fingerprint = String::new();
    for row in rows {
        let kind: String = row.get("type");
        let name: String = row.get("name");
        let sql: String = row.get("sql");
        let collapsed = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        fingerprint.push_str(&format!("{kind} {name}: {collapsed}\n"));
    }
    fingerprint
}

async fn seed(pool: &SqlitePool) {
    sqlx::query("INSERT INTO hosts (id, name, kind, created_at) VALUES (?, 'host', 'local', 0)")
        .bind(HOST_ID)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES (?, 'human', \
         'Human', 0, 0)",
    )
    .bind(USER_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, display_name, \
         created_by_user_id) VALUES (?, 'lio', 'claude', ?, 0, 0, 'Lio', ?)",
    )
    .bind(AGENT_ID)
    .bind(HOST_ID)
    .bind(USER_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, display_name, \
         created_by_user_id, session_scope) VALUES (?, 'broad', 'claude', ?, 0, 0, 'Broad', ?, \
         'agent')",
    )
    .bind(BROAD_AGENT_ID)
    .bind(HOST_ID)
    .bind(USER_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspaces (id, name, name_key, created_at, updated_at, owner_user_id) VALUES \
         (?, 'Space', 'space', 0, 0, ?)",
    )
    .bind(WORKSPACE_ID)
    .bind(USER_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO workspace_users (workspace_id, user_id, joined_at) VALUES (?, ?, 0)")
        .bind(WORKSPACE_ID)
        .bind(USER_ID)
        .execute(pool)
        .await
        .unwrap();

    for (id, title_key) in [(CHANNEL_ID, "general"), (OTHER_CHANNEL_ID, "other")] {
        sqlx::query(
            "INSERT INTO conversations (id, workspace_id, placement_kind, roster_policy, title, \
             title_key, status, created_at, updated_at) VALUES (?, ?, 'workspace', 'open', \
             'Channel', ?, 'open', 0, 0)",
        )
        .bind(id)
        .bind(WORKSPACE_ID)
        .bind(title_key)
        .execute(pool)
        .await
        .unwrap();
        for agent in [AGENT_ID, BROAD_AGENT_ID] {
            sqlx::query(
                "INSERT INTO conversation_agents (conversation_id, agent_id, joined_at) VALUES (?, \
                 ?, 0)",
            )
            .bind(id)
            .bind(agent)
            .execute(pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO conversation_users (conversation_id, user_id, joined_at) VALUES (?, ?, 0)",
        )
        .bind(id)
        .bind(USER_ID)
        .execute(pool)
        .await
        .unwrap();
    }

    // A direct pair carries its participants on the row: no roster rows exist for
    // it by construction.
    sqlx::query(
        "INSERT INTO conversations (id, placement_kind, roster_policy, title, status, \
         endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id, created_at, updated_at) \
         VALUES (?, 'direct_pair', 'fixed', 'DM', 'open', 'agent', ?, 'human', ?, 0, 0)",
    )
    .bind(PAIR_ID)
    .bind(AGENT_ID)
    .bind(USER_ID)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO attachments (id, channel_id, filename, size, content_type, storage, \
         storage_key, created_by_kind, created_by_id, created_at) VALUES ('att-here', ?, \
         'note.txt', 12, 'text/plain', 'local', 'k1', 'user', ?, 0)",
    )
    .bind(CHANNEL_ID)
    .bind(USER_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO attachments (id, channel_id, filename, size, content_type, storage, \
         storage_key, created_by_kind, created_by_id, created_at) VALUES ('att-elsewhere', ?, \
         'other.png', 34, 'image/png', 'local', 'k2', 'user', ?, 0)",
    )
    .bind(OTHER_CHANNEL_ID)
    .bind(USER_ID)
    .execute(pool)
    .await
    .unwrap();
}

fn agent_actor() -> SendActor {
    SendActor::Agent(AgentId::parse(AGENT_ID).unwrap())
}

fn user_actor() -> SendActor {
    SendActor::User(UserId::parse(USER_ID).unwrap())
}

fn send(actor: SendActor, conversation: &str, content: &str) -> SendMessage {
    SendMessage {
        source_conversation: ConversationId::parse(conversation).unwrap(),
        target_conversation: ConversationId::parse(conversation).unwrap(),
        actor,
        content: content.to_owned(),
        destination: SendDestination::MainLine,
        attachment_refs: Vec::new(),
        freshness_bypass: false,
    }
}

async fn enqueue_inbox_row_for(
    pool: &SqlitePool,
    agent: &str,
    conversation: &str,
    message_id: &str,
    delivered_at: Option<i64>,
    failed_at: Option<i64>,
) {
    sqlx::query(
        "INSERT INTO conversation_inboxes (conversation_id, agent_id, message_id, delivered_at, \
         failed_at, delivery_kind, created_at) VALUES (?, ?, ?, ?, ?, 'turn', 0)",
    )
    .bind(conversation)
    .bind(agent)
    .bind(message_id)
    .bind(delivered_at)
    .bind(failed_at)
    .execute(pool)
    .await
    .unwrap();
}

async fn enqueue_inbox_row(
    pool: &SqlitePool,
    conversation: &str,
    message_id: &str,
    delivered_at: Option<i64>,
    failed_at: Option<i64>,
) {
    enqueue_inbox_row_for(
        pool,
        AGENT_ID,
        conversation,
        message_id,
        delivered_at,
        failed_at,
    )
    .await;
}

/// The fixture is generated, so it can drift from the schema it was generated
/// from. This is the gate: regenerate the fixture when it fails, and never edit
/// either side to make it pass.
#[tokio::test]
async fn the_fixture_still_describes_the_schema_its_owner_publishes() {
    let fixture = Fixture::new().await;

    assert_eq!(
        schema_fingerprint(&fixture.pool).await,
        SCHEMA_FINGERPRINT_ORACLE,
        "the checked-in fixture no longer matches the owning migration chain"
    );
}

#[tokio::test]
async fn the_store_refuses_to_provision_a_database_it_does_not_own() {
    let dir = tempfile::tempdir().unwrap();

    let outcome = MessagingStore::open(dir.path().join("absent.db")).await;

    assert!(matches!(outcome, Err(MessagingStoreError::Sql(_))));
    assert!(
        !dir.path().join("absent.db").exists(),
        "the store created a database file"
    );
}

#[tokio::test]
async fn opening_the_store_adds_no_table_and_no_migration_ledger() {
    let fixture = Fixture::new().await;
    let before: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY \
         name",
    )
    .fetch_all(&fixture.pool)
    .await
    .unwrap();

    fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "hello"))
        .await
        .unwrap();

    let after: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY \
         name",
    )
    .fetch_all(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    assert!(
        !after.iter().any(|name| name.contains("migration")),
        "a migration ledger appeared: {after:?}"
    );
}

/// The main line writes exactly three rows: the reserved ordinal, the message, the
/// stream head. Delivery is a post-commit consequence, so no inbox row and no
/// durable event may exist yet — a store that wrote one would be claiming that
/// delivery is part of the same fact.
#[tokio::test]
async fn a_main_line_send_writes_the_ordinal_the_message_and_the_head_only() {
    let fixture = Fixture::new().await;

    let fact = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "first"))
        .await
        .unwrap();

    assert_eq!(fact.message.seq, MessageSeq::reserved(1));
    assert_eq!(fixture.latest_seq(CHANNEL_ID).await, 1);
    assert_eq!(fixture.stream_head(CHANNEL_ID, None).await, Some(1));
    assert_eq!(fact.projections, None);
    assert_eq!(
        fixture.scalar::<i64>("SELECT count(*) FROM messages").await,
        1
    );
    assert_eq!(
        fixture
            .scalar::<i64>("SELECT count(*) FROM conversation_inboxes")
            .await,
        0
    );
    assert_eq!(
        fixture
            .scalar::<i64>("SELECT count(*) FROM conversation_events")
            .await,
        0
    );
}

#[tokio::test]
async fn the_committed_row_reports_the_same_facts_the_caller_was_given() {
    let fixture = Fixture::new().await;

    let fact = fixture
        .store
        .send_message(send(user_actor(), CHANNEL_ID, "spoken once"))
        .await
        .unwrap();

    let row = sqlx::query(
        "SELECT id, conversation_id, from_kind, from_agent_id, from_user_id, content, metadata, \
         seq, created_at, thread_root_id, author_id, author_name, author_display_name, \
         cc_source_message_id FROM messages WHERE id = ?",
    )
    .bind(fact.message.id.as_str())
    .fetch_one(&fixture.pool)
    .await
    .unwrap();

    assert_eq!(row.get::<String, _>("from_kind"), "user");
    assert_eq!(row.get::<Option<String>, _>("from_agent_id"), None);
    assert_eq!(
        row.get::<Option<String>, _>("from_user_id").as_deref(),
        Some(USER_ID)
    );
    assert_eq!(row.get::<String, _>("content"), "spoken once");
    assert_eq!(row.get::<Option<String>, _>("metadata"), None);
    assert_eq!(row.get::<i64, _>("seq"), fact.message.seq.get());
    assert_eq!(row.get::<i64, _>("created_at"), fact.message.created_at_ms);
    assert_eq!(row.get::<Option<String>, _>("thread_root_id"), None);
    assert_eq!(row.get::<Option<String>, _>("cc_source_message_id"), None);
    // The author is copied onto the row, so the message keeps naming its sender
    // after a rename or a deletion.
    assert_eq!(
        row.get::<Option<String>, _>("author_id").as_deref(),
        Some(USER_ID)
    );
    assert_eq!(
        row.get::<Option<String>, _>("author_name").as_deref(),
        Some("human")
    );
    assert_eq!(
        row.get::<Option<String>, _>("author_display_name")
            .as_deref(),
        Some("Human")
    );
    let author = fact.message.author.unwrap();
    assert_eq!(author.name, "human");
    assert_eq!(author.display_name.as_deref(), Some("Human"));
}

/// A minted identity is what the wire publishes, so it must survive the round trip
/// unchanged rather than being re-encoded by the store.
#[tokio::test]
async fn the_stored_identity_is_the_minted_one() {
    let fixture = Fixture::new().await;

    let fact = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "identity"))
        .await
        .unwrap();

    let stored: String = sqlx::query_scalar("SELECT id FROM messages")
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(stored, fact.message.id.as_str());
    assert_eq!(stored.len(), 16);
}

#[tokio::test]
async fn ordinals_are_conversation_global_and_a_thread_keeps_its_own_head() {
    let fixture = Fixture::new().await;
    let root = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "root"))
        .await
        .unwrap();

    let mut reply = send(user_actor(), CHANNEL_ID, "reply");
    reply.destination = SendDestination::Reply(MessageId::parse(root.message.id.as_str()).unwrap());
    let reply = fixture.store.send_message(reply).await.unwrap();
    let after = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "main line again"))
        .await
        .unwrap();

    // The reply draws from the conversation's counter, not from a per-thread one.
    assert_eq!(reply.message.seq, MessageSeq::reserved(2));
    assert_eq!(after.message.seq, MessageSeq::reserved(3));
    assert_eq!(
        reply.message.thread_root_id.as_ref().unwrap().as_str(),
        root.message.id.as_str()
    );
    assert_eq!(
        fixture
            .stream_head(CHANNEL_ID, Some(root.message.id.as_str()))
            .await,
        Some(2)
    );
    assert_eq!(fixture.stream_head(CHANNEL_ID, None).await, Some(3));
}

#[tokio::test]
async fn ordinals_of_two_conversations_do_not_share_a_counter() {
    let fixture = Fixture::new().await;

    fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "here"))
        .await
        .unwrap();
    let elsewhere = fixture
        .store
        .send_message(send(agent_actor(), OTHER_CHANNEL_ID, "there"))
        .await
        .unwrap();

    assert_eq!(elsewhere.message.seq, MessageSeq::reserved(1));
    assert_eq!(fixture.latest_seq(CHANNEL_ID).await, 1);
    assert_eq!(fixture.latest_seq(OTHER_CHANNEL_ID).await, 1);
}

#[tokio::test]
async fn the_main_line_head_is_updated_rather_than_duplicated() {
    let fixture = Fixture::new().await;

    for _ in 0..3 {
        fixture
            .store
            .send_message(send(agent_actor(), CHANNEL_ID, "again"))
            .await
            .unwrap();
    }

    assert_eq!(
        fixture
            .scalar::<i64>("SELECT count(*) FROM conversation_stream_heads")
            .await,
        1
    );
    assert_eq!(fixture.stream_head(CHANNEL_ID, None).await, Some(3));
}

/// The reply count is absolute and computed after the insert, so it already
/// includes the reply being reported; system copies are not participants' words
/// and stay out of it.
#[tokio::test]
async fn a_reply_reports_an_absolute_count_that_excludes_system_copies() {
    let fixture = Fixture::new().await;
    let root = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "root"))
        .await
        .unwrap();
    let root_id = root.message.id.as_str().to_owned();

    let mut first = send(user_actor(), CHANNEL_ID, "one");
    first.destination = SendDestination::Reply(MessageId::parse(root_id.clone()).unwrap());
    let first = fixture.store.send_message(first).await.unwrap();

    sqlx::query(
        "INSERT INTO messages (id, conversation_id, from_kind, content, seq, created_at, \
         thread_root_id) VALUES ('sys-copy-000000', ?, 'system', 'copied', 99, 0, ?)",
    )
    .bind(CHANNEL_ID)
    .bind(&root_id)
    .execute(&fixture.pool)
    .await
    .unwrap();

    let mut second = send(user_actor(), CHANNEL_ID, "two");
    second.destination = SendDestination::Reply(MessageId::parse(root_id.clone()).unwrap());
    let second = fixture.store.send_message(second).await.unwrap();

    assert_eq!(first.projections.unwrap().reply_count, 1);
    let projections = second.projections.unwrap();
    assert_eq!(projections.reply_count, 2);
    assert_eq!(
        projections.thread_root_id,
        ThreadRootId::parse(root_id).unwrap()
    );
}

/// A reply to a message of another conversation is refused as if the message did
/// not exist, so a reply cannot be used to probe another stream.
#[tokio::test]
async fn a_reply_target_outside_the_conversation_is_not_found() {
    let fixture = Fixture::new().await;
    let elsewhere = fixture
        .store
        .send_message(send(agent_actor(), OTHER_CHANNEL_ID, "far away"))
        .await
        .unwrap();

    let mut reply = send(agent_actor(), CHANNEL_ID, "reply");
    reply.destination =
        SendDestination::Reply(MessageId::parse(elsewhere.message.id.as_str()).unwrap());
    let error = fixture.store.send_message(reply).await.unwrap_err();

    assert_eq!(error.code(), Some("reply_target_not_found"));
    assert_eq!(fixture.latest_seq(CHANNEL_ID).await, 0);
}

#[tokio::test]
async fn a_closed_conversation_answers_with_its_lifecycle() {
    let fixture = Fixture::new().await;
    sqlx::query("UPDATE conversations SET closed_at = 1 WHERE id = ?")
        .bind(CHANNEL_ID)
        .execute(&fixture.pool)
        .await
        .unwrap();

    let error = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "too late"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), Some("conversation_closed"));
}

#[tokio::test]
async fn an_archived_conversation_answers_with_its_lifecycle() {
    let fixture = Fixture::new().await;
    sqlx::query("UPDATE conversations SET archived_at = 1 WHERE id = ?")
        .bind(CHANNEL_ID)
        .execute(&fixture.pool)
        .await
        .unwrap();

    let error = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "too late"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), Some("conversation_archived"));
}

/// A refused send leaves the conversation exactly as it was: the ordinal it would
/// have consumed is still unissued.
#[tokio::test]
async fn a_refused_send_consumes_no_ordinal() {
    let fixture = Fixture::new().await;
    sqlx::query("DELETE FROM conversation_agents WHERE conversation_id = ? AND agent_id = ?")
        .bind(CHANNEL_ID)
        .bind(AGENT_ID)
        .execute(&fixture.pool)
        .await
        .unwrap();

    let error = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "outsider"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), Some("agent_not_participant_of_conversation"));
    assert_eq!(fixture.latest_seq(CHANNEL_ID).await, 0);
    assert_eq!(
        fixture.scalar::<i64>("SELECT count(*) FROM messages").await,
        0
    );
    assert_eq!(
        fixture
            .scalar::<i64>("SELECT count(*) FROM conversation_stream_heads")
            .await,
        0
    );
}

/// A direct pair has no roster rows: its participants are the endpoints on the
/// row, and a roster-shaped question would refuse both of them.
#[tokio::test]
async fn a_direct_pair_endpoint_participates_without_a_roster_row() {
    let fixture = Fixture::new().await;

    let by_agent = fixture
        .store
        .send_message(send(agent_actor(), PAIR_ID, "from the agent"))
        .await
        .unwrap();
    let by_human = fixture
        .store
        .send_message(send(user_actor(), PAIR_ID, "from the human"))
        .await
        .unwrap();

    assert_eq!(by_agent.message.seq, MessageSeq::reserved(1));
    assert_eq!(by_human.message.seq, MessageSeq::reserved(2));
}

#[tokio::test]
async fn a_pair_whose_endpoint_departed_refuses_its_survivor() {
    let fixture = Fixture::new().await;
    sqlx::query("UPDATE conversations SET endpoint_b_deleted_at = 1 WHERE id = ?")
        .bind(PAIR_ID)
        .execute(&fixture.pool)
        .await
        .unwrap();

    let error = fixture
        .store
        .send_message(send(agent_actor(), PAIR_ID, "anyone there"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), Some("conversation_endpoint_gone"));
}

/// A person's channel seat is two facts. A seat that outlived the workspace
/// membership admits nobody, because the membership is what the seat was granted
/// under.
#[tokio::test]
async fn a_human_needs_the_seat_and_the_workspace_membership() {
    let fixture = Fixture::new().await;
    sqlx::query("DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?")
        .bind(WORKSPACE_ID)
        .bind(USER_ID)
        .execute(&fixture.pool)
        .await
        .unwrap();

    let error = fixture
        .store
        .send_message(send(user_actor(), CHANNEL_ID, "still seated"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), Some("user_not_participant_of_conversation"));
}

#[tokio::test]
async fn an_attachment_of_another_channel_is_refused_and_nothing_is_written() {
    let fixture = Fixture::new().await;
    let mut command = send(user_actor(), CHANNEL_ID, "look at this");
    command.attachment_refs = vec![AttachmentRef {
        id: silverhand_backend_core::messaging::AttachmentId::parse("att-elsewhere").unwrap(),
        label: None,
    }];

    let error = fixture.store.send_message(command).await.unwrap_err();

    assert_eq!(error.code(), Some("attachment_outside_channel"));
    assert_eq!(fixture.latest_seq(CHANNEL_ID).await, 0);
    assert_eq!(
        fixture.scalar::<i64>("SELECT count(*) FROM messages").await,
        0
    );
}

#[tokio::test]
async fn an_accepted_attachment_is_stored_as_a_snapshot_in_the_message_metadata() {
    let fixture = Fixture::new().await;
    let mut command = send(user_actor(), CHANNEL_ID, "with a file");
    command.attachment_refs = vec![AttachmentRef {
        id: silverhand_backend_core::messaging::AttachmentId::parse("att-here").unwrap(),
        label: Some("File #1".to_owned()),
    }];

    let fact = fixture.store.send_message(command).await.unwrap();

    let metadata: String = sqlx::query_scalar("SELECT metadata FROM messages WHERE id = ?")
        .bind(fact.message.id.as_str())
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&metadata).unwrap(),
        json!({
            "attachments": [{
                "id": "att-here",
                "filename": "note.txt",
                "size": 12,
                "content_type": "text/plain",
                "label": "File #1",
            }]
        })
    );
    assert_eq!(fact.message.attachments.len(), 1);
}

#[tokio::test]
async fn an_agent_holding_undelivered_input_is_refused_as_stale() {
    let fixture = Fixture::new().await;
    let existing = fixture
        .store
        .send_message(send(user_actor(), CHANNEL_ID, "read me first"))
        .await
        .unwrap();
    enqueue_inbox_row(
        &fixture.pool,
        CHANNEL_ID,
        existing.message.id.as_str(),
        None,
        None,
    )
    .await;

    let error = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "talking over it"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), Some("message_stale"));
    assert_eq!(fixture.latest_seq(CHANNEL_ID).await, 1);
    assert!(error.to_string().contains("undelivered input"));
}

/// The guard counts rows a runtime cannot yet drain, so an in-flight lease still
/// reads as undelivered.
#[tokio::test]
async fn an_in_flight_delivery_still_counts_as_undelivered() {
    let fixture = Fixture::new().await;
    let existing = fixture
        .store
        .send_message(send(user_actor(), CHANNEL_ID, "leased"))
        .await
        .unwrap();
    enqueue_inbox_row(
        &fixture.pool,
        CHANNEL_ID,
        existing.message.id.as_str(),
        None,
        None,
    )
    .await;
    sqlx::query("UPDATE conversation_inboxes SET in_flight_owner = 'runtime-1', in_flight_at = 1")
        .execute(&fixture.pool)
        .await
        .unwrap();

    let error = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "talking over it"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), Some("message_stale"));
}

#[tokio::test]
async fn a_delivered_or_failed_row_leaves_the_runtime_fresh() {
    let fixture = Fixture::new().await;
    let existing = fixture
        .store
        .send_message(send(user_actor(), CHANNEL_ID, "consumed"))
        .await
        .unwrap();
    enqueue_inbox_row(
        &fixture.pool,
        CHANNEL_ID,
        existing.message.id.as_str(),
        Some(1),
        None,
    )
    .await;

    let after_drain = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "my turn"))
        .await
        .unwrap();

    assert_eq!(after_drain.message.seq, MessageSeq::reserved(2));
    assert!(!after_drain.freshness_bypassed);
}

#[tokio::test]
async fn sending_anyway_lands_and_records_that_the_guard_was_skipped() {
    let fixture = Fixture::new().await;
    let existing = fixture
        .store
        .send_message(send(user_actor(), CHANNEL_ID, "unread"))
        .await
        .unwrap();
    enqueue_inbox_row(
        &fixture.pool,
        CHANNEL_ID,
        existing.message.id.as_str(),
        None,
        None,
    )
    .await;

    let mut command = send(agent_actor(), CHANNEL_ID, "anyway");
    command.freshness_bypass = true;
    let fact = fixture.store.send_message(command).await.unwrap();

    assert!(fact.freshness_bypassed);
    assert_eq!(fact.message.seq, MessageSeq::reserved(2));
}

/// A person has no runtime, so undelivered agent input cannot make a human send
/// stale.
#[tokio::test]
async fn a_human_send_is_never_stale() {
    let fixture = Fixture::new().await;
    let existing = fixture
        .store
        .send_message(send(user_actor(), CHANNEL_ID, "unread by the agent"))
        .await
        .unwrap();
    enqueue_inbox_row(
        &fixture.pool,
        CHANNEL_ID,
        existing.message.id.as_str(),
        None,
        None,
    )
    .await;

    let fact = fixture
        .store
        .send_message(send(user_actor(), CHANNEL_ID, "people keep talking"))
        .await
        .unwrap();

    assert_eq!(fact.message.seq, MessageSeq::reserved(2));
}

/// The conversation arm asks about the runtime's own binding, so undelivered input
/// in one conversation does not gag a runtime bound to another.
#[tokio::test]
async fn the_conversation_arm_keys_on_the_runtimes_binding() {
    let fixture = Fixture::new().await;
    let existing = fixture
        .store
        .send_message(send(user_actor(), OTHER_CHANNEL_ID, "elsewhere"))
        .await
        .unwrap();
    enqueue_inbox_row(
        &fixture.pool,
        OTHER_CHANNEL_ID,
        existing.message.id.as_str(),
        None,
        None,
    )
    .await;

    let fact = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "unrelated stream"))
        .await
        .unwrap();

    assert_eq!(fact.message.seq, MessageSeq::reserved(1));
}

/// An agent-scoped runtime sees its whole field of view, so undelivered input
/// anywhere makes it stale.
#[tokio::test]
async fn the_agent_arm_spans_every_conversation() {
    let fixture = Fixture::new().await;
    let existing = fixture
        .store
        .send_message(send(user_actor(), OTHER_CHANNEL_ID, "elsewhere"))
        .await
        .unwrap();
    enqueue_inbox_row_for(
        &fixture.pool,
        BROAD_AGENT_ID,
        OTHER_CHANNEL_ID,
        existing.message.id.as_str(),
        None,
        None,
    )
    .await;

    let broad = SendActor::Agent(AgentId::parse(BROAD_AGENT_ID).unwrap());
    let error = fixture
        .store
        .send_message(send(broad, CHANNEL_ID, "unrelated stream"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), Some("message_stale"));
}

#[tokio::test]
async fn content_is_stored_byte_exact_at_the_utf8_cap() {
    let fixture = Fixture::new().await;
    let content = "汉".repeat(silverhand_backend_core::messaging::MAX_MESSAGE_CONTENT_BYTES / 3);

    let fact = fixture
        .store
        .send_message(send(user_actor(), CHANNEL_ID, &content))
        .await
        .unwrap();

    let stored: String = sqlx::query_scalar("SELECT content FROM messages WHERE id = ?")
        .bind(fact.message.id.as_str())
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(stored, content);
    assert_eq!(stored.len(), 65_535);
}

/// A driver failure reaches the caller as an infrastructure failure with its cause
/// intact, and publishes no domain code a caller could branch on.
#[tokio::test]
async fn a_driver_failure_rolls_back_and_keeps_its_cause() {
    let fixture = Fixture::new().await;
    sqlx::query(
        "CREATE TRIGGER reject_test_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, \
         'forced insert failure'); END",
    )
    .execute(&fixture.pool)
    .await
    .unwrap();

    let error = fixture
        .store
        .send_message(send(agent_actor(), CHANNEL_ID, "never lands"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), None);
    let mut cause: &(dyn std::error::Error + 'static) = &error;
    while let Some(next) = cause.source() {
        cause = next;
    }
    assert!(
        cause.to_string().contains("forced insert failure"),
        "driver cause was lost: {cause}"
    );
    assert_eq!(fixture.latest_seq(CHANNEL_ID).await, 0);
}

#[tokio::test]
async fn a_send_into_a_conversation_that_does_not_exist_is_not_found() {
    let fixture = Fixture::new().await;

    let error = fixture
        .store
        .send_message(send(agent_actor(), "conv-absent", "into the void"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), Some("conversation_not_found"));
}

#[tokio::test]
async fn every_pool_connection_carries_the_durability_configuration() {
    let fixture = Fixture::new().await;
    let mut connections = Vec::new();
    for _ in 0..POOL_CONNECTIONS {
        connections.push(fixture.store.pool.acquire().await.unwrap());
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

        assert_eq!(journal_mode, "wal");
        assert_eq!(synchronous, 2); // FULL
        assert_eq!(foreign_keys, 1);
    }
}
