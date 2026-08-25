#![forbid(unsafe_code)]
//! SQLite adapters for `backend-core`'s ports.
//!
//! The `foundation_message` store below is the foundation proof store, not the
//! product message store. It owns its own `foundation_*` tables, creates them
//! itself, and claims no migration ledger, so opening it against a database cannot
//! take over that database's schema identity or version history. The product
//! create-message write unit lives in [`messaging`], which consumes a database it
//! does not own.
//!
//! Everything specific to the engine stays inside this crate: SQL text, schema,
//! PRAGMAs, transaction modes and driver errors. The ports return application
//! facts and `PersistenceFailure`, so no driver type reaches the application or
//! the wire.

pub mod messaging;

use std::{path::Path, time::Duration};

pub mod access;
pub mod agent_availability_read;
pub mod agent_detail_read;
pub mod agent_presence_read;
pub mod agent_view_acl;

use silverhand_backend_core::foundation_message::{
    Message, MessageCreatedFact, MessagePageFact, MessageReadUnitOfWork, MessageUnitOfWork,
};
use silverhand_backend_core::persistence::PersistenceFailure;
use sqlx::{
    Row, Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

pub mod auth;
pub mod direct_pair_read;
pub mod host_agent;
pub mod host_runtime;
pub mod runtime_credential;
pub mod runtime_delivery;
pub mod scope_event;
pub mod unread_read;
pub mod user_presence_cold_read;
pub mod workspace_cold_read;

#[cfg(test)]
#[path = "../tests/support/current_schema_snapshot.rs"]
mod current_schema;

const ROOT_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";
const DEFERRED_READ_BEGIN: &str = "BEGIN DEFERRED";
const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Body length is unconstrained here: no application rule defines a limit, and a
/// limit with no owner in the domain does not belong in the schema.
const CREATE_MESSAGES_TABLE: &str = "CREATE TABLE IF NOT EXISTS foundation_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    body          TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
) STRICT";

/// `kind` and `json_valid` are this store's own invariants: it records exactly
/// one event shape, and the durable payload must stay readable.
const CREATE_MESSAGE_EVENTS_TABLE: &str = "CREATE TABLE IF NOT EXISTS foundation_message_events (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   INTEGER NOT NULL REFERENCES foundation_messages(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind = 'message_created'),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT";

const INSERT_MESSAGE: &str = "INSERT INTO foundation_messages (body, created_at_ms) VALUES (?, ?)";
const INSERT_MESSAGE_EVENT: &str =
    "INSERT INTO foundation_message_events (message_id, kind, payload_json) VALUES (?, ?, ?)";
const COUNT_MESSAGES: &str = "SELECT count(*) FROM foundation_messages";
const LATEST_MESSAGE: &str =
    "SELECT id, body, created_at_ms FROM foundation_messages ORDER BY id DESC LIMIT 1";

/// Which transaction capability an operation needs. The mode follows from an
/// operation's own semantics and appears in no application port, use case, or
/// repository signature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TxMode {
    /// Multi-statement write invariant: reserve the single writer before the
    /// first statement so contention surfaces before any work is done.
    RootWrite,
    /// Read-only unit needing one snapshot across several statements. It must
    /// not take a writer reservation it never uses.
    DeferredRead,
}

#[derive(Clone)]
pub struct FoundationMessageStore {
    pool: SqlitePool,
}

/// Startup and driver failures, surfaced only to the composition root that opens
/// the store. The ports below never expose it.
#[derive(Debug, Error)]
pub enum FoundationMessageStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("system time is outside the supported Unix-millisecond range")]
    Clock,
    #[error("event serialization failed")]
    Serialization(#[from] serde_json::Error),
}

impl FoundationMessageStore {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, FoundationMessageStoreError> {
        Self::open_with_busy_timeout(path, BUSY_TIMEOUT).await
    }

    async fn open_with_busy_timeout(
        path: impl AsRef<Path>,
        busy_timeout: Duration,
    ) -> Result<Self, FoundationMessageStoreError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            // An acknowledged write must survive power loss, so WAL runs with
            // FULL. NORMAL would skip the commit fsync and let a recently
            // acknowledged transaction roll back.
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(busy_timeout);

        let pool = SqlitePoolOptions::new()
            .max_connections(POOL_CONNECTIONS)
            .connect_with(options)
            .await?;

        let store = Self { pool };
        store.ensure_schema().await?;
        Ok(store)
    }

    /// Creates only this store's own tables, idempotently and without recording a
    /// migration version, so the database's schema identity stays untouched.
    async fn ensure_schema(&self) -> Result<(), FoundationMessageStoreError> {
        let mut tx = self.begin(TxMode::RootWrite).await?;
        sqlx::query(CREATE_MESSAGES_TABLE).execute(&mut *tx).await?;
        sqlx::query(CREATE_MESSAGE_EVENTS_TABLE)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// The single place that turns a required capability into a begin statement.
    async fn begin(&self, mode: TxMode) -> Result<Transaction<'_, Sqlite>, sqlx::Error> {
        match mode {
            TxMode::RootWrite => self.pool.begin_with(ROOT_WRITE_BEGIN).await,
            TxMode::DeferredRead => self.pool.begin_with(DEFERRED_READ_BEGIN).await,
        }
    }

    #[tracing::instrument(skip(self))]
    async fn latest_page_transaction(
        &self,
    ) -> Result<MessagePageFact, FoundationMessageStoreError> {
        let mut tx = self.begin(TxMode::DeferredRead).await?;
        let total: i64 = sqlx::query_scalar(COUNT_MESSAGES)
            .fetch_one(&mut *tx)
            .await?;
        let row = sqlx::query(LATEST_MESSAGE).fetch_optional(&mut *tx).await?;
        let latest = match row {
            Some(row) => Some(Message {
                id: row.try_get("id")?,
                body: row.try_get("body")?,
                created_at_ms: row.try_get("created_at_ms")?,
            }),
            None => None,
        };
        tx.commit().await?;
        Ok(MessagePageFact { total, latest })
    }

    #[tracing::instrument(skip(self, body), fields(body_len = body.len()))]
    async fn create_message_transaction(
        &self,
        body: String,
    ) -> Result<MessageCreatedFact, FoundationMessageStoreError> {
        let created_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| FoundationMessageStoreError::Clock)?
            .as_millis();
        let created_at_ms =
            i64::try_from(created_at_ms).map_err(|_| FoundationMessageStoreError::Clock)?;

        // Reserve the single writer before any read or business work, so a
        // conflict surfaces before the first INSERT rather than part-way through.
        let mut tx = self.begin(TxMode::RootWrite).await?;
        let result = sqlx::query(INSERT_MESSAGE)
            .bind(&body)
            .bind(created_at_ms)
            .execute(&mut *tx)
            .await?;

        let fact = MessageCreatedFact {
            message: Message {
                id: result.last_insert_rowid(),
                body,
                created_at_ms,
            },
        };
        let payload_json = serde_json::to_string(&StoredMessageCreatedV1::from(&fact))?;

        sqlx::query(INSERT_MESSAGE_EVENT)
            .bind(fact.message.id)
            .bind("message_created")
            .bind(payload_json)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(fact)
    }
}

/// The durable payload is versioned independently of any wire DTO, and replaying
/// it must go through an explicit projection rather than a shared type.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredMessageCreatedV1<'a> {
    version: u8,
    message_id: i64,
    body: &'a str,
    created_at_ms: i64,
}

impl<'a> From<&'a MessageCreatedFact> for StoredMessageCreatedV1<'a> {
    fn from(fact: &'a MessageCreatedFact) -> Self {
        Self {
            version: 1,
            message_id: fact.message.id,
            body: &fact.message.body,
            created_at_ms: fact.message.created_at_ms,
        }
    }
}

impl MessageUnitOfWork for FoundationMessageStore {
    async fn create_message_with_event(
        &self,
        body: String,
    ) -> Result<MessageCreatedFact, PersistenceFailure> {
        // The driver error is handed over as the source. The refusal is not
        // logged here: the boundary that renders it owns that record.
        self.create_message_transaction(body)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}

impl MessageReadUnitOfWork for FoundationMessageStore {
    async fn latest_page(&self) -> Result<MessagePageFact, PersistenceFailure> {
        self.latest_page_transaction()
            .await
            .map_err(PersistenceFailure::from_source)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        error::Error,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Instant,
    };

    use serde_json::json;
    use tempfile::{TempDir, tempdir};
    use tracing::{
        Level,
        span::{Attributes, Id, Record},
    };

    use super::*;

    const FORCED_EVENT_FAILURE: &str = "forced event failure";
    /// SQLx accepts only `&'static str` SQL, keeping the statement literal rather
    /// than assembled.
    const REJECT_EVENTS: &str = "CREATE TRIGGER reject_test_event BEFORE INSERT ON \
         foundation_message_events BEGIN SELECT RAISE(ABORT, 'forced event failure'); END";

    async fn open_at(dir: &TempDir, name: &str) -> FoundationMessageStore {
        FoundationMessageStore::open(dir.path().join(name))
            .await
            .unwrap()
    }

    /// Makes every event insert fail, so a message row can only survive if the
    /// write unit is not atomic.
    async fn reject_events(store: &FoundationMessageStore) {
        assert!(
            REJECT_EVENTS.contains(FORCED_EVENT_FAILURE),
            "the trigger message and the asserted cause drifted apart"
        );
        sqlx::query(REJECT_EVENTS)
            .execute(&store.pool)
            .await
            .unwrap();
    }

    fn root_cause(error: &(dyn Error + 'static)) -> String {
        let mut current = error;
        while let Some(cause) = current.source() {
            current = cause;
        }
        current.to_string()
    }

    /// The store must not be able to take over a database's schema identity: it
    /// records no migration version and creates nothing outside its own
    /// namespace.
    #[tokio::test]
    async fn opening_the_store_claims_no_migration_ledger() {
        let dir = tempdir().unwrap();
        let store = open_at(&dir, "identity.db").await;

        let ledgers: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name LIKE '%migration%'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .fetch_all(&store.pool)
        .await
        .unwrap();

        assert_eq!(ledgers, 0, "the store recorded a migration version");
        assert_eq!(
            tables,
            vec!["foundation_message_events", "foundation_messages"],
            "the store created tables outside its own foundation namespace"
        );
    }

    #[tokio::test]
    async fn opening_an_existing_store_preserves_its_rows() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reopen.db");
        let first = FoundationMessageStore::open(&path).await.unwrap();
        first
            .create_message_transaction("survives reopen".into())
            .await
            .unwrap();
        drop(first);

        let reopened = FoundationMessageStore::open(&path).await.unwrap();
        let page = reopened.latest_page_transaction().await.unwrap();

        assert_eq!(page.total, 1);
        assert_eq!(page.latest.unwrap().body, "survives reopen");
    }

    #[tokio::test]
    async fn schema_places_no_limit_on_body_length() {
        let dir = tempdir().unwrap();
        let store = open_at(&dir, "body-length.db").await;

        let fact = store
            .create_message_transaction("x".repeat(20_000))
            .await
            .unwrap();

        assert_eq!(fact.message.body.len(), 20_000);
    }

    #[tokio::test]
    async fn rolls_back_message_when_event_insert_fails() {
        let dir = tempdir().unwrap();
        let store = open_at(&dir, "rollback.db").await;
        reject_events(&store).await;

        let error = store
            .create_message_transaction("must roll back".into())
            .await
            .unwrap_err();
        assert!(matches!(error, FoundationMessageStoreError::Sql(_)));

        let message_count: i64 = sqlx::query_scalar(COUNT_MESSAGES)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(message_count, 0);
    }

    #[tokio::test]
    async fn applies_required_configuration_to_every_pool_connection() {
        let dir = tempdir().unwrap();
        let store = open_at(&dir, "configuration.db").await;
        let mut connections = Vec::new();
        for _ in 0..POOL_CONNECTIONS {
            connections.push(store.pool.acquire().await.unwrap());
        }

        for connection in &mut connections {
            let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
                .fetch_one(&mut **connection)
                .await
                .unwrap();
            let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
                .fetch_one(&mut **connection)
                .await
                .unwrap();
            let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
                .fetch_one(&mut **connection)
                .await
                .unwrap();
            let busy_timeout_ms: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
                .fetch_one(&mut **connection)
                .await
                .unwrap();

            assert_eq!(foreign_keys, 1);
            assert_eq!(journal_mode, "wal");
            assert_eq!(synchronous, 2); // FULL
            assert_eq!(busy_timeout_ms, 5_000);
        }
        drop(connections);

        let sqlite_version: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let version = sqlite_version
            .split('.')
            .map(|part| part.parse::<u32>().unwrap())
            .collect::<Vec<_>>();
        assert!(version.as_slice() >= &[3, 51, 3]);
    }

    #[tokio::test]
    async fn durable_payload_is_a_versioned_projection_of_the_application_fact() {
        let dir = tempdir().unwrap();
        let store = open_at(&dir, "payload.db").await;
        let fact = store
            .create_message_transaction("stored fact".into())
            .await
            .unwrap();
        let payload: String =
            sqlx::query_scalar("SELECT payload_json FROM foundation_message_events")
                .fetch_one(&store.pool)
                .await
                .unwrap();

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
            json!({
                "version": 1,
                "messageId": fact.message.id,
                "body": fact.message.body,
                "createdAtMs": fact.message.created_at_ms,
            })
        );
    }

    #[tokio::test]
    async fn root_write_reserves_the_writer_before_its_first_insert() {
        let dir = tempdir().unwrap();
        let store = FoundationMessageStore::open_with_busy_timeout(
            dir.path().join("writer-reservation.db"),
            Duration::from_millis(25),
        )
        .await
        .unwrap();

        let first = store.begin(TxMode::RootWrite).await.unwrap();
        let started = Instant::now();
        let error = store.begin(TxMode::RootWrite).await.unwrap_err();

        assert!(
            started.elapsed() < Duration::from_secs(1),
            "writer contention exceeded the controlled short timeout"
        );
        let database_error = error.as_database_error().unwrap();
        assert_eq!(database_error.code().as_deref(), Some("5")); // SQLITE_BUSY
        first.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn nested_root_immediate_is_rejected_instead_of_becoming_a_savepoint() {
        let dir = tempdir().unwrap();
        let store = open_at(&dir, "nested-root.db").await;
        let mut root = store.begin(TxMode::RootWrite).await.unwrap();
        let connection = sqlx::Acquire::acquire(&mut root).await.unwrap();

        let error = sqlx::Connection::begin_with(connection, ROOT_WRITE_BEGIN)
            .await
            .unwrap_err();
        assert!(matches!(error, sqlx::Error::InvalidSavePointStatement));
        root.rollback().await.unwrap();
    }

    /// A read unit must not queue behind a writer reservation it never uses. With
    /// a 25ms busy timeout, a read that wrongly asked for the writer would fail
    /// instead of returning a snapshot.
    #[tokio::test]
    async fn deferred_read_reads_a_snapshot_while_a_writer_is_held() {
        let dir = tempdir().unwrap();
        let store = FoundationMessageStore::open_with_busy_timeout(
            dir.path().join("deferred-read.db"),
            Duration::from_millis(25),
        )
        .await
        .unwrap();
        store
            .create_message_transaction("committed before".into())
            .await
            .unwrap();

        let held_writer = store.begin(TxMode::RootWrite).await.unwrap();
        let started = Instant::now();
        let page = store.latest_page_transaction().await.unwrap();

        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the deferred read waited on the writer reservation"
        );
        assert_eq!(page.total, 1);
        assert_eq!(page.latest.unwrap().body, "committed before");

        // A root write asked for while the writer is held does fail, so the
        // assertion above is about the mode rather than about an idle database.
        let contended = store.begin(TxMode::RootWrite).await.unwrap_err();
        assert_eq!(
            contended.as_database_error().unwrap().code().as_deref(),
            Some("5") // SQLITE_BUSY
        );

        held_writer.rollback().await.unwrap();
    }

    /// A read unit reads one snapshot. Statements inside a deferred read see the
    /// database as of that unit's first read, so a commit landing between them is
    /// invisible until a new transaction begins — which is what lets a total and
    /// a latest row be reported together without disagreeing.
    #[tokio::test]
    async fn deferred_read_holds_one_snapshot_across_statements() {
        let dir = tempdir().unwrap();
        let store = open_at(&dir, "snapshot.db").await;
        store
            .create_message_transaction("first".into())
            .await
            .unwrap();

        let mut read_tx = store.begin(TxMode::DeferredRead).await.unwrap();
        let total_before: i64 = sqlx::query_scalar(COUNT_MESSAGES)
            .fetch_one(&mut *read_tx)
            .await
            .unwrap();
        assert_eq!(total_before, 1);

        store
            .create_message_transaction("committed mid-read".into())
            .await
            .unwrap();

        let total_after: i64 = sqlx::query_scalar(COUNT_MESSAGES)
            .fetch_one(&mut *read_tx)
            .await
            .unwrap();
        let latest_body: Option<String> =
            sqlx::query_scalar("SELECT body FROM foundation_messages ORDER BY id DESC LIMIT 1")
                .fetch_optional(&mut *read_tx)
                .await
                .unwrap();

        assert_eq!(
            total_after, 1,
            "the second statement left the transaction's snapshot"
        );
        assert_eq!(
            latest_body.as_deref(),
            Some("first"),
            "count and latest disagreed inside one read unit"
        );
        read_tx.rollback().await.unwrap();

        let page = store.latest_page_transaction().await.unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.latest.unwrap().body, "committed mid-read");
    }

    /// The adapter half of the source-chain contract: a real driver failure
    /// reaches the port's caller as the root cause of `PersistenceFailure`.
    #[tokio::test]
    async fn driver_failure_survives_as_the_root_cause_of_the_port_error() {
        let dir = tempdir().unwrap();
        let store = open_at(&dir, "source-chain.db").await;
        reject_events(&store).await;

        let failure = store
            .create_message_with_event("cause must survive".into())
            .await
            .unwrap_err();

        assert_eq!(failure.to_string(), "persistence operation failed");
        assert!(
            root_cause(&failure).contains(FORCED_EVENT_FAILURE),
            "driver cause was lost before the port boundary: {}",
            root_cause(&failure)
        );
    }

    /// Counts events at WARN or ERROR. Spans are ignored: instrumentation is not
    /// a refusal record.
    struct RefusalCounter {
        count: Arc<AtomicUsize>,
    }

    impl tracing::Subscriber for RefusalCounter {
        fn enabled(&self, _metadata: &tracing::Metadata<'_>) -> bool {
            true
        }

        fn new_span(&self, _span: &Attributes<'_>) -> Id {
            Id::from_u64(1)
        }

        fn record(&self, _span: &Id, _values: &Record<'_>) {}

        fn record_follows_from(&self, _span: &Id, _follows: &Id) {}

        fn event(&self, event: &tracing::Event<'_>) {
            if *event.metadata().level() <= Level::WARN {
                self.count.fetch_add(1, Ordering::SeqCst);
            }
        }

        fn enter(&self, _span: &Id) {}

        fn exit(&self, _span: &Id) {}
    }

    /// A refusal is reported by returning its cause, not by logging it here;
    /// logging it would duplicate the record owned by the rendering boundary.
    #[test]
    fn adapter_emits_no_refusal_record_of_its_own() {
        let count = Arc::new(AtomicUsize::new(0));
        let subscriber = RefusalCounter {
            count: Arc::clone(&count),
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let observed = tracing::subscriber::with_default(subscriber, || {
            runtime.block_on(async {
                let dir = tempdir().unwrap();
                let store = open_at(&dir, "no-refusal-log.db").await;
                reject_events(&store).await;
                let failure = store
                    .create_message_with_event("must not be logged here".into())
                    .await
                    .unwrap_err();
                root_cause(&failure)
            })
        });

        assert!(observed.contains(FORCED_EVENT_FAILURE));
        assert_eq!(
            count.load(Ordering::SeqCst),
            0,
            "the adapter logged the refusal instead of only returning its cause"
        );
    }
}
