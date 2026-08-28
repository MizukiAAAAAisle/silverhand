//! SQLite adapter for the canonical `agents`-row tuning write behind
//! `PATCH /api/agents/{id}`.
//!
//! Like the other write stores, this is a **pure consumer** of an existing product
//! database: it opens a pool against a schema that already exists and migrates or
//! seeds nothing. It decides nothing on its own either — legality (the runtime
//! tuning gate) is admitted in [`silverhand_backend_core::agent_profile_write`]
//! BEFORE the sealed [`AdmittedAgentProfileEdit`] reaches this port, so the adapter
//! only ever sees a sealed edit plus a clock witness, never a raw column bag or a
//! product decision to make.
//!
//! The whole write is one `BEGIN IMMEDIATE` transaction. Only the columns the sealed
//! edit actually names are placed in the `SET` clause — a `Leave` is omitted, a
//! `Clear` writes `NULL`, a `Set` binds the value — and `updated_at` is always
//! stamped to `now_ms`, so a tuning write always bumps the row's instant (matching
//! `agent-service.ts`'s always-touch update). The committed columns are projected
//! from the write's OWN `RETURNING` row — never a post-commit re-read — so the core
//! seal binds the fact this write produced. A `WHERE id = ?` that matches no row
//! yields [`AgentProfileRowWrite::NoSuchAgent`], the surface's `404`.
//!
//! The clock stays in the application: `now_ms` is passed in, exactly as the other
//! write stores take it. Every driver error and every committed row whose id cannot
//! be decoded reaches the caller as the source of a [`PersistenceFailure`]; nothing
//! is logged here.

use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    agent_profile_write::{
        AdmittedAgentProfileEdit, AgentProfileRowWrite, AgentProfileWriteUnitOfWork,
        CommittedAgentRow, FieldEdit, RequiredEdit,
    },
    identity::AgentId,
    persistence::PersistenceFailure,
};
use sqlx::{
    QueryBuilder, Row, Sqlite, SqlitePool,
    sqlite::{
        SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow, SqliteSynchronous,
    },
};
use thiserror::Error;

const ROOT_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";
const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

// The committed columns the core seal binds against the request: the id, the touched
// tuning columns, and the write instant. A FIXED `RETURNING` suffix — it does not
// vary with which columns the `SET` clause touched, so the write always projects the
// same shape the seal reads.
const RETURNING_COMMITTED_ROW: &str =
    " RETURNING id, display_name, description, model, reasoning_effort, fast_mode, updated_at";

/// A pooled connection to an existing product database, offering the canonical
/// agent-tuning write. Holds no clock; `now_ms` is passed in by the application.
#[derive(Clone)]
pub struct SqliteAgentProfileWrite {
    pool: SqlitePool,
}

/// Startup and driver failures surfaced only to the composition root that opens the
/// store. The unit-of-work method hands the driver error over as the source of a
/// [`PersistenceFailure`] instead.
#[derive(Debug, Error)]
pub enum SqliteAgentProfileWriteError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
}

/// A committed row whose `id` column decodes to a value the domain refuses (today
/// only the empty string). The product schema's ids are non-empty by construction,
/// so such a row is a persistence-integrity fault surfaced as the source of a
/// [`PersistenceFailure`], never coerced to a sentinel.
#[derive(Debug, Error)]
#[error("agents.{column} holds an unusable identifier")]
struct CorruptStoredIdentifier {
    column: &'static str,
}

/// A write that failed in the driver or on a row that cannot be decoded into the
/// domain. Both reach the caller as the source of one `PersistenceFailure`; the
/// split lets an integrity fault name its column rather than masquerade as a driver
/// error.
#[derive(Debug, Error)]
enum ProfileWriteFailure {
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error(transparent)]
    Integrity(#[from] CorruptStoredIdentifier),
}

impl SqliteAgentProfileWrite {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SqliteAgentProfileWriteError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            // An acknowledged tuning edit must survive power loss, so WAL runs with
            // FULL — NORMAL would let a recently acknowledged write roll back.
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(BUSY_TIMEOUT);
        let pool = SqlitePoolOptions::new()
            .max_connections(POOL_CONNECTIONS)
            .connect_with(options)
            .await?;
        Ok(Self { pool })
    }

    /// Construct over an already-open pool, so a composition root that shares one
    /// pool across adapters need not reopen the file.
    pub fn from_pool(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn write_profile_edit(
        &self,
        agent: &AgentId,
        edit: &AdmittedAgentProfileEdit,
        now_ms: i64,
    ) -> Result<AgentProfileRowWrite, ProfileWriteFailure> {
        let mut tx = self.pool.begin_with(ROOT_WRITE_BEGIN).await?;

        // Build the `SET` clause from ONLY the columns the sealed edit names, through
        // sqlx's `QueryBuilder` so every value goes through an audited `push_bind`
        // (never string interpolation). A `Leave` contributes nothing; a `Clear`
        // writes a literal `NULL`; a `Set` binds the value. `updated_at` is always
        // appended, so the `SET` clause is never empty — a tuning write always bumps
        // the instant.
        let mut builder = QueryBuilder::<Sqlite>::new("UPDATE agents SET ");
        let mut needs_comma = false;

        if let RequiredEdit::Set(value) = edit.display_name() {
            separator(&mut builder, &mut needs_comma);
            builder.push("display_name = ");
            builder.push_bind(value.as_str());
        }
        push_nullable_str(
            &mut builder,
            &mut needs_comma,
            "description",
            edit.description(),
        );
        push_nullable_str(&mut builder, &mut needs_comma, "model", edit.model());
        push_nullable_str(
            &mut builder,
            &mut needs_comma,
            "reasoning_effort",
            edit.reasoning_effort(),
        );
        match edit.fast_mode() {
            FieldEdit::Leave => {}
            FieldEdit::Clear => {
                separator(&mut builder, &mut needs_comma);
                builder.push("fast_mode = NULL");
            }
            FieldEdit::Set(value) => {
                separator(&mut builder, &mut needs_comma);
                builder.push("fast_mode = ");
                builder.push_bind(*value);
            }
        }

        separator(&mut builder, &mut needs_comma);
        builder.push("updated_at = ");
        builder.push_bind(now_ms);

        builder.push(" WHERE id = ");
        builder.push_bind(agent.as_str());
        builder.push(RETURNING_COMMITTED_ROW);

        let row = builder.build().fetch_optional(&mut *tx).await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(AgentProfileRowWrite::NoSuchAgent);
        };
        let committed = decode_committed_row(&row)?;

        tx.commit().await?;
        Ok(AgentProfileRowWrite::Committed(committed))
    }
}

/// Emit a `, ` before every assignment after the first, so the `SET` list stays
/// well-formed however many columns the sealed edit touched.
fn separator(builder: &mut QueryBuilder<Sqlite>, needs_comma: &mut bool) {
    if *needs_comma {
        builder.push(", ");
    }
    *needs_comma = true;
}

/// Append a nullable STRING column's assignment if the edit names it: `Clear` writes
/// a literal `NULL`; `Set` binds through an audited `push_bind`; `Leave` contributes
/// nothing. `column` is always a hardcoded literal from the call site, never caller
/// input.
fn push_nullable_str(
    builder: &mut QueryBuilder<Sqlite>,
    needs_comma: &mut bool,
    column: &'static str,
    edit: &FieldEdit<String>,
) {
    match edit {
        FieldEdit::Leave => {}
        FieldEdit::Clear => {
            separator(builder, needs_comma);
            builder.push(column);
            builder.push(" = NULL");
        }
        FieldEdit::Set(value) => {
            separator(builder, needs_comma);
            builder.push(column);
            builder.push(" = ");
            builder.push_bind(value.as_str());
        }
    }
}

/// Decode the committed tuning columns from the write's own `RETURNING` row. The id
/// is parsed through the domain's fallible parser, so a malformed committed id is
/// corruption, never a product answer; `fast_mode` is read as an integer and folded
/// `!= 0`, mirroring the detail read's affinity-safe decode.
fn decode_committed_row(row: &SqliteRow) -> Result<CommittedAgentRow, ProfileWriteFailure> {
    let id = AgentId::parse(row.try_get::<String, _>("id")?)
        .map_err(|_| CorruptStoredIdentifier { column: "id" })?;
    let fast_mode: Option<i64> = row.try_get("fast_mode")?;
    let fast_mode = fast_mode.map(|value| value != 0);
    Ok(CommittedAgentRow {
        id,
        display_name: row.try_get("display_name")?,
        description: row.try_get("description")?,
        model: row.try_get("model")?,
        reasoning_effort: row.try_get("reasoning_effort")?,
        fast_mode,
        updated_at: row.try_get("updated_at")?,
    })
}

impl AgentProfileWriteUnitOfWork for SqliteAgentProfileWrite {
    async fn apply_profile_edit(
        &self,
        agent: &AgentId,
        edit: &AdmittedAgentProfileEdit,
        now_ms: i64,
    ) -> Result<AgentProfileRowWrite, PersistenceFailure> {
        self.write_profile_edit(agent, edit, now_ms)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverhand_backend_core::{
        agent_profile_write::{AgentTuningContext, AgentTuningEdit, admit_public_tuning_edit},
        agents::runtime::RuntimeKind,
    };
    use sqlx::{Connection, Executor, SqliteConnection};

    const CURRENT_SCHEMA: &str =
        include_str!("../../../../packages/backend/tests/migration-baseline/schema-current.sql");

    // A codex agent `agent-1` seeded with a full tuning state (model + reasoning +
    // fast_mode) so a Clear has something to erase, and a claude agent `agent-2`
    // whose tuning columns start NULL.
    const SEED_SQL: &str = "\
INSERT INTO users (id, name, display_name, created_at, updated_at) \
  VALUES ('user-1', 'owner', 'Owner', 1, 1); \
INSERT INTO hosts (id, name, kind, created_at) VALUES ('host-1', 'Host', 'local', 1); \
INSERT INTO agents (id, name, display_name, runtime, model, reasoning_effort, fast_mode, description, host_id, created_by_user_id, created_at, updated_at) \
  VALUES ('agent-1', 'alice', 'Alice', 'codex', 'gpt-5.6-sol', 'ultra', 1, 'first', 'host-1', 'user-1', 10, 100); \
INSERT INTO agents (id, name, display_name, runtime, host_id, created_by_user_id, created_at, updated_at) \
  VALUES ('agent-2', 'bob', 'Bob', 'claude', 'host-1', 'user-1', 10, 100);";

    async fn open_seeded() -> (tempfile::TempDir, SqliteAgentProfileWrite) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-profile-write.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        db.execute(sqlx::raw_sql(CURRENT_SCHEMA)).await.unwrap();
        db.execute(sqlx::raw_sql(SEED_SQL)).await.unwrap();
        db.close().await.unwrap();
        let adapter = SqliteAgentProfileWrite::open(&path).await.unwrap();
        (directory, adapter)
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).unwrap()
    }

    fn codex_ctx() -> AgentTuningContext {
        AgentTuningContext {
            runtime: RuntimeKind::Codex,
            model: Some("gpt-5.6-sol".to_owned()),
            reasoning_effort: Some("ultra".to_owned()),
        }
    }

    fn leave_all() -> AgentTuningEdit {
        AgentTuningEdit {
            display_name: RequiredEdit::Leave,
            description: FieldEdit::Leave,
            model: FieldEdit::Leave,
            reasoning_effort: FieldEdit::Leave,
            fast_mode: FieldEdit::Leave,
        }
    }

    async fn stored(
        adapter: &SqliteAgentProfileWrite,
        id: &str,
    ) -> (
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        i64,
    ) {
        sqlx::query_as::<
            _,
            (
                String,
                Option<String>,
                Option<String>,
                Option<i64>,
                Option<String>,
                i64,
            ),
        >(
            "SELECT display_name, description, model, fast_mode, reasoning_effort, updated_at \
               FROM agents WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&adapter.pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_set_edit_writes_only_named_columns_bumps_updated_at_and_returns_the_committed_row() {
        let (_dir, adapter) = open_seeded().await;
        let edit = admit_public_tuning_edit(
            &codex_ctx(),
            AgentTuningEdit {
                display_name: RequiredEdit::Set("Alice II".to_owned()),
                reasoning_effort: FieldEdit::Set("high".to_owned()),
                ..leave_all()
            },
        )
        .unwrap();

        let outcome = adapter
            .apply_profile_edit(&agent("agent-1"), &edit, 777)
            .await
            .unwrap();
        let AgentProfileRowWrite::Committed(row) = outcome else {
            panic!("expected Committed, got {outcome:?}");
        };
        assert_eq!(row.id, agent("agent-1"));
        assert_eq!(row.display_name, "Alice II");
        assert_eq!(row.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(row.updated_at, 777);
        // The left-alone columns kept their seeded values.
        assert_eq!(row.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(row.fast_mode, Some(true));
        assert_eq!(row.description.as_deref(), Some("first"));

        // And the row on disk matches, with updated_at bumped off its seed.
        let (display, description, model, fast, reasoning, updated) =
            stored(&adapter, "agent-1").await;
        assert_eq!(display, "Alice II");
        assert_eq!(description.as_deref(), Some("first"));
        assert_eq!(model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(fast, Some(1));
        assert_eq!(reasoning.as_deref(), Some("high"));
        assert_eq!(updated, 777);
    }

    #[tokio::test]
    async fn a_clear_writes_null_and_leaves_untouched_columns_alone() {
        let (_dir, adapter) = open_seeded().await;
        // Clearing model would strand the stored `ultra` effort, so also clear it —
        // the admission accepts this (baseline codex + no effort is legal).
        let edit = admit_public_tuning_edit(
            &codex_ctx(),
            AgentTuningEdit {
                model: FieldEdit::Clear,
                reasoning_effort: FieldEdit::Clear,
                description: FieldEdit::Clear,
                ..leave_all()
            },
        )
        .unwrap();

        let outcome = adapter
            .apply_profile_edit(&agent("agent-1"), &edit, 900)
            .await
            .unwrap();
        let AgentProfileRowWrite::Committed(row) = outcome else {
            panic!("expected Committed");
        };
        assert_eq!(row.model, None);
        assert_eq!(row.reasoning_effort, None);
        assert_eq!(row.description, None);
        // display_name and fast_mode were left alone.
        assert_eq!(row.display_name, "Alice");
        assert_eq!(row.fast_mode, Some(true));
        assert_eq!(row.updated_at, 900);
    }

    #[tokio::test]
    async fn a_leave_only_edit_still_bumps_updated_at_and_touches_no_value() {
        let (_dir, adapter) = open_seeded().await;
        // An all-Leave sealed edit (the route forbids an empty body, but the adapter
        // is defensive): the SET clause is `updated_at = ?` alone.
        let edit = admit_public_tuning_edit(&codex_ctx(), leave_all()).unwrap();
        let outcome = adapter
            .apply_profile_edit(&agent("agent-1"), &edit, 1234)
            .await
            .unwrap();
        let AgentProfileRowWrite::Committed(row) = outcome else {
            panic!("expected Committed");
        };
        assert_eq!(row.display_name, "Alice");
        assert_eq!(row.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(row.updated_at, 1234);
    }

    #[tokio::test]
    async fn a_fast_mode_set_writes_the_integer_one() {
        let (_dir, adapter) = open_seeded().await;
        // agent-2 (claude) starts with fast_mode NULL; but claude does not support
        // fast mode, so drive the codex agent-1 which starts at 1 → set false → 0.
        let edit = admit_public_tuning_edit(
            &codex_ctx(),
            AgentTuningEdit {
                fast_mode: FieldEdit::Set(false),
                ..leave_all()
            },
        )
        .unwrap();
        let outcome = adapter
            .apply_profile_edit(&agent("agent-1"), &edit, 1500)
            .await
            .unwrap();
        let AgentProfileRowWrite::Committed(row) = outcome else {
            panic!("expected Committed");
        };
        assert_eq!(row.fast_mode, Some(false));
        assert_eq!(stored(&adapter, "agent-1").await.3, Some(0));
    }

    #[tokio::test]
    async fn a_missing_row_is_no_such_agent_and_writes_nothing() {
        let (_dir, adapter) = open_seeded().await;
        let edit = admit_public_tuning_edit(
            &codex_ctx(),
            AgentTuningEdit {
                display_name: RequiredEdit::Set("Ghost".to_owned()),
                ..leave_all()
            },
        )
        .unwrap();
        let outcome = adapter
            .apply_profile_edit(&agent("agent-missing"), &edit, 2000)
            .await
            .unwrap();
        assert!(matches!(outcome, AgentProfileRowWrite::NoSuchAgent));
        // The real agents are untouched.
        assert_eq!(stored(&adapter, "agent-1").await.5, 100);
    }
}
