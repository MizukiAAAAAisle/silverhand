//! The durable runtime-transition lock: acquire, release, and commit-and-release,
//! each a compare-and-set under the same root-write reservation the other axes use.
//!
//! `begin` is a pre-read then a compare-and-set that turns a null lock into a target;
//! the `WHERE` re-states every precondition the pre-read observed, so a row that moved
//! out from under the lock changes nothing and surfaces as a lost serialized CAS
//! rather than a silent no-op. `abort` and `complete` are keyed compare-and-sets on
//! the target the caller owns: a row taken by another attempt matches nothing, so it
//! is `NotHeld` / `Lost`, never a second write. `complete` writes the `runtime` +
//! tuning and clears the lock in the SAME statement, so the ownership guard gates the
//! tuning write itself.
//!
//! The `(runtime_transition_target, runtime_transition_started_at)` pair is set and
//! cleared together in every statement, satisfying the schema's paired CHECK and its
//! insert/update triggers.

use silverhand_backend_core::{
    agents::runtime::RuntimeKind,
    identity::AgentId,
    persistence::PersistenceFailure,
    runtime_transition::{
        AbortTransition, BeginTransition, CompleteTransition, RuntimeTransitionCommit,
        RuntimeTransitionWrite,
    },
};
use sqlx::{Row, sqlite::SqliteRow};
use thiserror::Error;

use super::store::SqliteHostAgentStore;

/// The pre-read `begin` decides from: enough to answer `NotFound` / `Deleting` /
/// `InProgress` before the acquiring compare-and-set runs.
const SELECT_BEGIN_PRECHECK: &str =
    "SELECT deletion_started_at, runtime_transition_target FROM agents WHERE id = ?";

/// Acquire: a null lock becomes `target` with its paired started-at. The `WHERE`
/// re-states the preconditions the pre-read observed as the serialized compare-and-set.
/// It does NOT bump `updated_at` — the runtime has not changed yet, matching the
/// TypeScript `beginRuntimeTransition`.
const BEGIN_TRANSITION_CAS: &str = "UPDATE agents \
        SET runtime_transition_target = ?, runtime_transition_started_at = ? \
      WHERE id = ? \
        AND runtime_transition_target IS NULL \
        AND deletion_started_at IS NULL";

/// Release a lock held for the caller's target, clearing the pair together.
const ABORT_TRANSITION_CAS: &str = "UPDATE agents \
        SET runtime_transition_target = NULL, runtime_transition_started_at = NULL \
      WHERE id = ? \
        AND runtime_transition_target = ?";

/// Commit runtime + tuning and release the lock, guarded by the owned target. The
/// target column and the new `runtime` value are the same string, so the pair CHECK
/// and the ownership guard cannot disagree.
const COMPLETE_TRANSITION_CAS: &str = "UPDATE agents \
        SET runtime = ?, model = ?, reasoning_effort = ?, fast_mode = ?, \
            runtime_transition_target = NULL, runtime_transition_started_at = NULL, \
            updated_at = ? \
      WHERE id = ? \
        AND runtime_transition_target = ?";

/// The writer was reserved and every precondition the pre-read observed still held, yet
/// the acquiring compare-and-set changed no row. Under `BEGIN IMMEDIATE` nothing else
/// can have written the row, so this is a broken invariant, not a product answer.
#[derive(Debug, Error)]
#[error("begin runtime transition lost its serialized compare-and-set")]
struct BeginTransitionCasLost;

/// What the pre-read observed of the lock columns.
struct BeginPrecheck {
    deletion_started_at: Option<i64>,
    runtime_transition_target: Option<String>,
}

fn begin_precheck(row: &SqliteRow) -> Result<BeginPrecheck, sqlx::Error> {
    Ok(BeginPrecheck {
        deletion_started_at: row.try_get("deletion_started_at")?,
        runtime_transition_target: row.try_get::<Option<String>, _>("runtime_transition_target")?,
    })
}

/// The stored `fast_mode` boolean as its `0`/`1`/null column, matching the
/// `fast_mode === null ? null : fast_mode ? 1 : 0` the TypeScript writer applies.
fn fast_mode_column(fast_mode: Option<bool>) -> Option<i64> {
    fast_mode.map(|on| if on { 1 } else { 0 })
}

impl RuntimeTransitionWrite for SqliteHostAgentStore {
    async fn begin(
        &self,
        agent: &AgentId,
        target: RuntimeKind,
        now_ms: i64,
    ) -> Result<BeginTransition, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;

        let Some(row) = sqlx::query(SELECT_BEGIN_PRECHECK)
            .bind(agent.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?
        else {
            return Ok(BeginTransition::NotFound);
        };
        let pre = begin_precheck(&row).map_err(PersistenceFailure::from_source)?;

        // Precedence is the TypeScript authority's re-read: an in-flight delete answers
        // before an in-flight transition.
        if pre.deletion_started_at.is_some() {
            return Ok(BeginTransition::Deleting);
        }
        if pre.runtime_transition_target.is_some() {
            return Ok(BeginTransition::InProgress);
        }

        let changed = sqlx::query(BEGIN_TRANSITION_CAS)
            .bind(target.as_str())
            .bind(now_ms)
            .bind(agent.as_str())
            .execute(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?
            .rows_affected();
        if changed != 1 {
            return Err(PersistenceFailure::from_source(BeginTransitionCasLost));
        }
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(BeginTransition::Started)
    }

    async fn abort(
        &self,
        agent: &AgentId,
        target: RuntimeKind,
    ) -> Result<AbortTransition, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;
        let changed = sqlx::query(ABORT_TRANSITION_CAS)
            .bind(agent.as_str())
            .bind(target.as_str())
            .execute(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?
            .rows_affected();
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(if changed > 0 {
            AbortTransition::Released
        } else {
            AbortTransition::NotHeld
        })
    }

    async fn complete(
        &self,
        agent: &AgentId,
        commit: &RuntimeTransitionCommit,
        now_ms: i64,
    ) -> Result<CompleteTransition, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;
        let changed = sqlx::query(COMPLETE_TRANSITION_CAS)
            .bind(commit.runtime.as_str())
            .bind(commit.model.as_deref())
            .bind(commit.reasoning_effort.as_deref())
            .bind(fast_mode_column(commit.fast_mode))
            .bind(now_ms)
            .bind(agent.as_str())
            .bind(commit.runtime.as_str())
            .execute(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?
            .rows_affected();
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(if changed > 0 {
            CompleteTransition::Committed
        } else {
            CompleteTransition::Lost
        })
    }
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, time::Duration};

    use sqlx::{Connection, Row};
    use tempfile::TempDir;

    use super::*;

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    async fn seed_schema(dir: &TempDir, name: &str, seed: &[&'static str]) -> PathBuf {
        let path = dir.path().join(name);
        let mut connection = crate::current_schema::create_current_schema(&path).await;
        for statement in seed {
            sqlx::query(*statement)
                .execute(&mut connection)
                .await
                .expect("seed statement");
        }
        connection.close().await.expect("close seed connection");
        path
    }

    /// Walks the source chain for SQLITE_BUSY (code 5), the way the reservation gate
    /// hands a contended begin over as `PersistenceFailure`'s source.
    fn is_sqlite_busy(error: &(dyn std::error::Error + 'static)) -> bool {
        let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
        while let Some(err) = current {
            if let Some(sqlx_error) = err.downcast_ref::<sqlx::Error>()
                && sqlx_error
                    .as_database_error()
                    .and_then(|db| db.code().map(|code| code.into_owned()))
                    .as_deref()
                    == Some("5")
            {
                return true;
            }
            current = err.source();
        }
        false
    }

    const USER: &str = "INSERT INTO users (id, name, display_name, created_at, updated_at) \
         VALUES ('u1', 'u1', 'U1', 1, 1)";
    const HOST: &str =
        "INSERT INTO hosts (id, name, kind, created_at) VALUES ('h1', 'h1', 'local', 1)";
    /// Active, runtime `claude`, no lock and no tuning columns set, mtime at 1.
    const ACTIVE_A1: &str = "INSERT INTO agents \
         (id, name, runtime, host_id, created_by_user_id, created_at, updated_at, \
          materialization_status, session_scope) \
         VALUES ('a1', 'a1', 'claude', 'h1', 'u1', 1, 1, 'active', 'conversation')";
    /// Active but a transition to `codex` already holds the lock.
    const TRANSITION_A1: &str = "INSERT INTO agents \
         (id, name, runtime, host_id, created_by_user_id, created_at, updated_at, \
          materialization_status, session_scope, \
          runtime_transition_target, runtime_transition_started_at) \
         VALUES ('a1', 'a1', 'claude', 'h1', 'u1', 1, 1, 'active', 'conversation', 'codex', 1)";
    /// Active but a deletion marker holds the row.
    const DELETING_A1: &str = "INSERT INTO agents \
         (id, name, runtime, host_id, created_by_user_id, created_at, updated_at, \
          materialization_status, session_scope, deletion_started_at) \
         VALUES ('a1', 'a1', 'claude', 'h1', 'u1', 1, 1, 'active', 'conversation', 7)";

    async fn lock_columns(store: &SqliteHostAgentStore) -> (Option<String>, Option<i64>) {
        let row = sqlx::query(
            "SELECT runtime_transition_target, runtime_transition_started_at \
               FROM agents WHERE id = 'a1'",
        )
        .fetch_one(store.pool())
        .await
        .unwrap();
        (
            row.get::<Option<String>, _>("runtime_transition_target"),
            row.get::<Option<i64>, _>("runtime_transition_started_at"),
        )
    }

    /// The deterministic writer-reservation gate. A no-write answer (`NotFound`, from an
    /// absent agent) succeeds while nothing is held, then fails at `begin_root_write`
    /// with SQLITE_BUSY once the single writer is held.
    ///
    /// Falsifier: change the store's `BEGIN IMMEDIATE` to `BEGIN DEFERRED` and this test
    /// turns RED — a deferred begin takes no writer lock, so the no-write answer returns
    /// `Ok(NotFound)` even while a writer is held, and `unwrap_err` panics.
    #[tokio::test]
    async fn begin_reserves_the_writer_before_its_precheck() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "begin-reservation.db", &[USER, HOST]).await;
        let store = SqliteHostAgentStore::open_with_busy_timeout(&path, Duration::from_millis(50))
            .await
            .unwrap();

        let idle = store
            .begin(&agent("missing"), RuntimeKind::Codex, 1)
            .await
            .unwrap();
        assert!(matches!(idle, BeginTransition::NotFound));

        let held = store.begin_root_write().await.unwrap();
        let contended = store
            .begin(&agent("missing"), RuntimeKind::Codex, 1)
            .await
            .unwrap_err();
        assert!(
            is_sqlite_busy(&contended),
            "begin did not reserve the writer before its pre-read"
        );
        held.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn begin_acquires_the_lock_without_touching_runtime_or_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "begin.db", &[USER, HOST, ACTIVE_A1]).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let started = store
            .begin(&agent("a1"), RuntimeKind::Codex, 5)
            .await
            .unwrap();
        assert_eq!(started, BeginTransition::Started);

        let row = sqlx::query(
            "SELECT runtime, updated_at, runtime_transition_target, runtime_transition_started_at \
               FROM agents WHERE id = 'a1'",
        )
        .fetch_one(store.pool())
        .await
        .unwrap();
        // The lock is held for the target with its paired started-at...
        assert_eq!(
            row.get::<Option<String>, _>("runtime_transition_target"),
            Some("codex".to_string())
        );
        assert_eq!(
            row.get::<Option<i64>, _>("runtime_transition_started_at"),
            Some(5)
        );
        // ...but the runtime and the row's mtime are untouched until `complete`.
        assert_eq!(row.get::<String, _>("runtime"), "claude");
        assert_eq!(row.get::<i64, _>("updated_at"), 1);
    }

    #[tokio::test]
    async fn begin_refuses_each_precedence_arm() {
        let dir = tempfile::tempdir().unwrap();

        let missing = seed_schema(&dir, "missing.db", &[USER, HOST]).await;
        let store = SqliteHostAgentStore::open(&missing).await.unwrap();
        assert_eq!(
            store
                .begin(&agent("a1"), RuntimeKind::Codex, 1)
                .await
                .unwrap(),
            BeginTransition::NotFound
        );

        // A deletion marker answers before a transition would.
        let deleting = seed_schema(&dir, "deleting.db", &[USER, HOST, DELETING_A1]).await;
        let store = SqliteHostAgentStore::open(&deleting).await.unwrap();
        assert_eq!(
            store
                .begin(&agent("a1"), RuntimeKind::Codex, 1)
                .await
                .unwrap(),
            BeginTransition::Deleting
        );

        // A held lock refuses a second acquire, whatever the new target.
        let transition = seed_schema(&dir, "transition.db", &[USER, HOST, TRANSITION_A1]).await;
        let store = SqliteHostAgentStore::open(&transition).await.unwrap();
        assert_eq!(
            store
                .begin(&agent("a1"), RuntimeKind::Cursor, 1)
                .await
                .unwrap(),
            BeginTransition::InProgress
        );
    }

    #[tokio::test]
    async fn abort_releases_only_a_matching_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "abort.db", &[USER, HOST, TRANSITION_A1]).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        // The wrong target matches nothing; the lock is left intact.
        assert_eq!(
            store
                .abort(&agent("a1"), RuntimeKind::Cursor)
                .await
                .unwrap(),
            AbortTransition::NotHeld
        );
        assert_eq!(
            lock_columns(&store).await,
            (Some("codex".to_string()), Some(1))
        );

        // The owned target releases the pair together.
        assert_eq!(
            store.abort(&agent("a1"), RuntimeKind::Codex).await.unwrap(),
            AbortTransition::Released
        );
        assert_eq!(lock_columns(&store).await, (None, None));
    }

    #[tokio::test]
    async fn abort_is_not_held_when_no_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "abort-none.db", &[USER, HOST, ACTIVE_A1]).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        assert_eq!(
            store.abort(&agent("a1"), RuntimeKind::Codex).await.unwrap(),
            AbortTransition::NotHeld
        );
    }

    #[tokio::test]
    async fn complete_writes_runtime_and_tuning_and_releases_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "complete.db", &[USER, HOST, TRANSITION_A1]).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let commit = RuntimeTransitionCommit {
            runtime: RuntimeKind::Codex,
            model: Some("gpt".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: Some(true),
        };
        assert_eq!(
            store.complete(&agent("a1"), &commit, 42).await.unwrap(),
            CompleteTransition::Committed
        );

        let row = sqlx::query(
            "SELECT runtime, model, reasoning_effort, fast_mode, updated_at, \
                    runtime_transition_target, runtime_transition_started_at \
               FROM agents WHERE id = 'a1'",
        )
        .fetch_one(store.pool())
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("runtime"), "codex");
        assert_eq!(
            row.get::<Option<String>, _>("model"),
            Some("gpt".to_string())
        );
        assert_eq!(
            row.get::<Option<String>, _>("reasoning_effort"),
            Some("high".to_string())
        );
        assert_eq!(row.get::<Option<i64>, _>("fast_mode"), Some(1));
        assert_eq!(row.get::<i64, _>("updated_at"), 42);
        assert_eq!(
            row.get::<Option<String>, _>("runtime_transition_target"),
            None
        );
        assert_eq!(
            row.get::<Option<i64>, _>("runtime_transition_started_at"),
            None
        );
    }

    #[tokio::test]
    async fn complete_clears_tuning_columns_to_null() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "complete-null.db", &[USER, HOST, TRANSITION_A1]).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        // A commit with no tuning writes SQL NULLs, not the previous values.
        let commit = RuntimeTransitionCommit {
            runtime: RuntimeKind::Codex,
            model: None,
            reasoning_effort: None,
            fast_mode: None,
        };
        assert_eq!(
            store.complete(&agent("a1"), &commit, 42).await.unwrap(),
            CompleteTransition::Committed
        );

        let row =
            sqlx::query("SELECT model, reasoning_effort, fast_mode FROM agents WHERE id = 'a1'")
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(row.get::<Option<String>, _>("model"), None);
        assert_eq!(row.get::<Option<String>, _>("reasoning_effort"), None);
        assert_eq!(row.get::<Option<i64>, _>("fast_mode"), None);
    }

    #[tokio::test]
    async fn complete_is_lost_when_the_lock_moved() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "complete-lost.db", &[USER, HOST, TRANSITION_A1]).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        // Another attempt took the row: the lock now names a different target, so this
        // commit's guard matches nothing and must write nothing.
        sqlx::query("UPDATE agents SET runtime_transition_target = 'cursor' WHERE id = 'a1'")
            .execute(store.pool())
            .await
            .unwrap();

        let commit = RuntimeTransitionCommit {
            runtime: RuntimeKind::Codex,
            model: Some("gpt".to_string()),
            reasoning_effort: None,
            fast_mode: None,
        };
        assert_eq!(
            store.complete(&agent("a1"), &commit, 42).await.unwrap(),
            CompleteTransition::Lost
        );

        // The runtime and mtime are untouched; the other attempt's lock still stands.
        let row = sqlx::query(
            "SELECT runtime, updated_at, runtime_transition_target FROM agents WHERE id = 'a1'",
        )
        .fetch_one(store.pool())
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("runtime"), "claude");
        assert_eq!(row.get::<i64, _>("updated_at"), 1);
        assert_eq!(
            row.get::<Option<String>, _>("runtime_transition_target"),
            Some("cursor".to_string())
        );
    }
}
