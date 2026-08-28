//! The SQLite adapter for the agent-materialization lifecycle: the reserve INSERT, the
//! two failure compare-and-sets, the reopen compare-and-set, and the crash-recovery bulk
//! fail — each under the store's single-writer reservation.
//!
//! This adapter WITNESSES; it never mints the domain verdict. Every write projects the
//! row it actually touched from its own `RETURNING` clause and hands it back for the core
//! free functions to bind and seal. A guarded compare-and-set that changed no row returns
//! `None` (→ `Lost`); the reserve reports a unique-index violation as
//! [`ReserveRecord::ConstraintConflict`], detected by the driver's error *kind* — never by
//! parsing the message or the index name, so the two unique constraints that can fire (the
//! `name` uniqueness and the per-creator `idempotency_key` index) fold into one honest
//! fact. There is no activate write here — see the core module docs.

use silverhand_backend_core::{
    agent_materialization::{
        AgentMaterializationLookup, AgentMaterializationWrite, IdempotentReservationRow,
        MaterializationFlipRow, ReserveAgentInput, ReserveRecord, ReservedAgentRow,
        STALE_MATERIALIZATION_FAILED_CODE,
    },
    identity::{AgentId, UserId},
    persistence::PersistenceFailure,
};
use sqlx::{Row, sqlite::SqliteRow};

use super::store::SqliteHostAgentStore;

/// Insert a fresh `pending_materialization` row and return the columns the domain seals
/// its committed identity against. `display_name` seeds from the handle, matching the
/// TypeScript `reserveForMaterialize`.
const RESERVE_INSERT: &str = "INSERT INTO agents \
        (id, name, display_name, runtime, model, reasoning_effort, fast_mode, \
         host_id, description, session_scope, created_by_user_id, \
         materialization_status, idempotency_key, created_at, updated_at) \
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_materialization', ?, ?, ?) \
    RETURNING id, materialization_status, created_by_user_id, idempotency_key, \
              created_at, updated_at";

/// `pending|failed → failed`, stamping the typed code and timestamp. The status guard is
/// the sole eligibility gate; `active` is deliberately unmatched (a live row's failure
/// surface is destructive delete, not an in-place flip).
const FAIL_CAS: &str = "UPDATE agents \
        SET materialization_status = 'failed', \
            materialization_failed_code = ?, \
            materialization_failed_at = ?, \
            updated_at = ? \
      WHERE id = ? \
        AND materialization_status IN ('pending_materialization', 'failed') \
    RETURNING id, materialization_status, materialization_failed_code, \
              materialization_failed_at, updated_at";

/// `failed → pending_materialization`, clearing the failure columns so a later failure
/// writes a fresh stamp. Strictly `failed`-guarded: pending and active are unmatched.
const REOPEN_CAS: &str = "UPDATE agents \
        SET materialization_status = 'pending_materialization', \
            materialization_failed_code = NULL, \
            materialization_failed_at = NULL, \
            updated_at = ? \
      WHERE id = ? \
        AND materialization_status = 'failed' \
    RETURNING id, materialization_status, materialization_failed_code, \
              materialization_failed_at, updated_at";

/// Crash recovery: fail every row still pending and created strictly before the cutoff,
/// stamping the canonical code, and return the rows it touched. `active`/`failed` rows are
/// unmatched.
const MARK_STALE_FAILED: &str = "UPDATE agents \
        SET materialization_status = 'failed', \
            materialization_failed_code = ?, \
            materialization_failed_at = ?, \
            updated_at = ? \
      WHERE materialization_status = 'pending_materialization' \
        AND created_at < ? \
    RETURNING id, materialization_status, materialization_failed_code, \
              materialization_failed_at, updated_at";

/// Read the row for a `(created_by_user_id, idempotency_key)` pair. The creator and key
/// ride the row's OWN columns so the domain can bind them against the request; the `WHERE`
/// is this adapter's implementation, not the port contract.
const FIND_BY_IDEMPOTENCY: &str = "SELECT id, created_by_user_id, idempotency_key, \
            materialization_status, materialization_failed_code, materialization_failed_at, \
            name, runtime, model, description, host_id, session_scope \
       FROM agents \
      WHERE created_by_user_id = ? \
        AND idempotency_key = ?";

/// The stored `fast_mode` boolean as its `0`/`1`/null column, matching the
/// `fast_mode === undefined ? null : fast_mode ? 1 : 0` the TypeScript reserve applies.
fn fast_mode_column(fast_mode: Option<bool>) -> Option<i64> {
    fast_mode.map(|on| if on { 1 } else { 0 })
}

/// True when a driver error is a unique-constraint violation, decided by the error *kind*
/// the driver reports — never by inspecting the message or the offending index name.
fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(|db| db.is_unique_violation())
}

/// Project the reserve after-image from its `RETURNING` row. The `AgentId` is decoded from
/// the row's OWN `id`, never the query parameter.
fn reserved_agent_row(row: &SqliteRow) -> Result<ReservedAgentRow, sqlx::Error> {
    Ok(ReservedAgentRow {
        agent_id: super::decode::agent_id(row.try_get::<String, _>("id")?)?,
        materialization_status: row.try_get::<String, _>("materialization_status")?,
        created_by_user_id: row.try_get::<String, _>("created_by_user_id")?,
        idempotency_key: row.try_get::<Option<String>, _>("idempotency_key")?,
        created_at: row.try_get::<i64, _>("created_at")?,
        updated_at: row.try_get::<i64, _>("updated_at")?,
    })
}

/// Project a flip after-image from its `RETURNING` row.
fn flip_row(row: &SqliteRow) -> Result<MaterializationFlipRow, sqlx::Error> {
    Ok(MaterializationFlipRow {
        agent_id: super::decode::agent_id(row.try_get::<String, _>("id")?)?,
        materialization_status: row.try_get::<String, _>("materialization_status")?,
        materialization_failed_code: row
            .try_get::<Option<String>, _>("materialization_failed_code")?,
        materialization_failed_at: row.try_get::<Option<i64>, _>("materialization_failed_at")?,
        updated_at: row.try_get::<i64, _>("updated_at")?,
    })
}

/// Project a lookup witness. Identity columns are decoded fail-closed; the creator, key,
/// status, and runtime are carried raw for the domain to bind and parse.
fn idempotent_reservation_row(row: &SqliteRow) -> Result<IdempotentReservationRow, sqlx::Error> {
    Ok(IdempotentReservationRow {
        agent_id: super::decode::agent_id(row.try_get::<String, _>("id")?)?,
        created_by_user_id: row.try_get::<String, _>("created_by_user_id")?,
        idempotency_key: row.try_get::<Option<String>, _>("idempotency_key")?,
        materialization_status: row.try_get::<String, _>("materialization_status")?,
        materialization_failed_code: row
            .try_get::<Option<String>, _>("materialization_failed_code")?,
        materialization_failed_at: row.try_get::<Option<i64>, _>("materialization_failed_at")?,
        name: row.try_get::<String, _>("name")?,
        runtime: row.try_get::<String, _>("runtime")?,
        model: row.try_get::<Option<String>, _>("model")?,
        description: row.try_get::<Option<String>, _>("description")?,
        host_id: row.try_get::<String, _>("host_id")?,
        session_scope: row.try_get::<String, _>("session_scope")?,
    })
}

impl AgentMaterializationLookup for SqliteHostAgentStore {
    async fn find_by_idempotency(
        &self,
        creator: &UserId,
        key: &silverhand_backend_core::agent_materialization::IdempotencyKey,
    ) -> Result<Option<IdempotentReservationRow>, PersistenceFailure> {
        let row = sqlx::query(FIND_BY_IDEMPOTENCY)
            .bind(creator.as_str())
            .bind(key.as_str())
            .fetch_optional(self.pool())
            .await
            .map_err(PersistenceFailure::from_source)?;
        match row {
            Some(row) => Ok(Some(
                idempotent_reservation_row(&row).map_err(PersistenceFailure::from_source)?,
            )),
            None => Ok(None),
        }
    }
}

impl AgentMaterializationWrite for SqliteHostAgentStore {
    async fn reserve(
        &self,
        input: &ReserveAgentInput,
        now_ms: i64,
    ) -> Result<ReserveRecord, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;

        let attempted = sqlx::query(RESERVE_INSERT)
            .bind(input.agent_id.as_str())
            .bind(input.name.as_str())
            .bind(input.name.as_str())
            .bind(input.runtime.as_str())
            .bind(input.model.as_deref())
            .bind(input.reasoning_effort.as_deref())
            .bind(fast_mode_column(input.fast_mode))
            .bind(input.host_id.as_str())
            .bind(input.description.as_deref())
            .bind(input.session_scope.as_str())
            .bind(input.created_by_user_id.as_str())
            .bind(input.idempotency_key.as_str())
            .bind(now_ms)
            .bind(now_ms)
            .fetch_optional(&mut *tx)
            .await;

        match attempted {
            Ok(Some(row)) => {
                let witness = reserved_agent_row(&row).map_err(PersistenceFailure::from_source)?;
                tx.commit().await.map_err(PersistenceFailure::from_source)?;
                Ok(ReserveRecord::Inserted(witness))
            }
            // An `INSERT ... RETURNING` that inserts a row always returns it; no row means
            // a broken invariant, not a product answer.
            Ok(None) => Err(PersistenceFailure::from_source(ReserveReturnedNoRow)),
            // The conflict rolls back as the transaction drops; nothing was written.
            Err(error) if is_unique_violation(&error) => Ok(ReserveRecord::ConstraintConflict),
            Err(error) => Err(PersistenceFailure::from_source(error)),
        }
    }

    async fn fail(
        &self,
        agent: &AgentId,
        failed_code: &str,
        failed_at: i64,
        now_ms: i64,
    ) -> Result<Option<MaterializationFlipRow>, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;
        let returned = sqlx::query(FAIL_CAS)
            .bind(failed_code)
            .bind(failed_at)
            .bind(now_ms)
            .bind(agent.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
        let witness = match returned {
            Some(row) => Some(flip_row(&row).map_err(PersistenceFailure::from_source)?),
            None => None,
        };
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(witness)
    }

    async fn reopen_failed(
        &self,
        agent: &AgentId,
        now_ms: i64,
    ) -> Result<Option<MaterializationFlipRow>, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;
        let returned = sqlx::query(REOPEN_CAS)
            .bind(now_ms)
            .bind(agent.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
        let witness = match returned {
            Some(row) => Some(flip_row(&row).map_err(PersistenceFailure::from_source)?),
            None => None,
        };
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(witness)
    }

    async fn mark_stale_failed(
        &self,
        cutoff_created_at: i64,
        failed_at: i64,
        now_ms: i64,
    ) -> Result<Vec<MaterializationFlipRow>, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;
        let returned = sqlx::query(MARK_STALE_FAILED)
            .bind(STALE_MATERIALIZATION_FAILED_CODE)
            .bind(failed_at)
            .bind(now_ms)
            .bind(cutoff_created_at)
            .fetch_all(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
        let mut rows = Vec::with_capacity(returned.len());
        for row in &returned {
            rows.push(flip_row(row).map_err(PersistenceFailure::from_source)?);
        }
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(rows)
    }
}

/// A reserve `INSERT ... RETURNING` that reported success but handed back no row — a broken
/// SQLite invariant the boundary surfaces as a safe `500`, never a product answer.
#[derive(Debug, thiserror::Error)]
#[error("reserve insert returned no row")]
struct ReserveReturnedNoRow;

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use silverhand_backend_core::{
        agent_lifecycle::MaterializationStatus,
        agent_materialization::{
            FailOutcome, IdempotencyKey, ReopenOutcome, ReserveOutcome, fail_materialization,
            find_idempotent_reservation, mark_stale_materializations_failed,
            reopen_failed_materialization, reserve_agent,
        },
        agents::runtime::RuntimeKind,
        identity::HostId,
    };
    use tempfile::TempDir;

    use super::*;

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    async fn seed_schema(dir: &TempDir, name: &str, seed: &[String]) -> PathBuf {
        let path = dir.path().join(name);
        let mut connection = crate::current_schema::create_current_schema(&path).await;
        for statement in seed {
            sqlx::query(sqlx::AssertSqlSafe(statement.as_str()))
                .execute(&mut connection)
                .await
                .expect("seed statement");
        }
        use sqlx::Connection;
        connection.close().await.expect("close seed connection");
        path
    }

    const USER: &str = "INSERT INTO users (id, name, display_name, created_at, updated_at) \
         VALUES ('u1', 'u1', 'U1', 1, 1)";
    const HOST: &str =
        "INSERT INTO hosts (id, name, kind, created_at) VALUES ('h1', 'h1', 'local', 1)";

    /// Seed one agent row in an arbitrary status with the given create timestamp and key.
    fn seed_agent(
        id: &str,
        status: &str,
        created_at: i64,
        idempotency_key: Option<&str>,
    ) -> String {
        let key = match idempotency_key {
            Some(k) => format!("'{k}'"),
            None => "NULL".to_string(),
        };
        format!(
            "INSERT INTO agents \
             (id, name, display_name, runtime, host_id, created_by_user_id, created_at, \
              updated_at, materialization_status, session_scope, idempotency_key) \
             VALUES ('{id}', '{id}', '{id}', 'claude', 'h1', 'u1', {created_at}, {created_at}, \
                     '{status}', 'conversation', {key})"
        )
    }

    fn base_seed() -> Vec<String> {
        vec![USER.to_string(), HOST.to_string()]
    }

    fn input(id: &str, key: &str) -> ReserveAgentInput {
        ReserveAgentInput {
            agent_id: agent(id),
            name: id.to_string(),
            runtime: RuntimeKind::Codex,
            model: Some("gpt".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: Some(true),
            host_id: HostId::parse("h1").unwrap(),
            description: Some("d".to_string()),
            session_scope: "conversation".to_string(),
            created_by_user_id: user("u1"),
            idempotency_key: IdempotencyKey::new(key),
        }
    }

    #[tokio::test]
    async fn reserve_inserts_a_pending_row_and_seals_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "reserve.db", &base_seed()).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let ReserveOutcome::Reserved(reserved) = reserve_agent(&store, &input("a1", "idem-1"), 42)
            .await
            .unwrap()
        else {
            panic!("expected a reserved agent");
        };
        assert_eq!(reserved.agent_id(), &agent("a1"));
        assert_eq!(reserved.created_by_user_id(), &user("u1"));
        assert_eq!(reserved.idempotency_key(), &IdempotencyKey::new("idem-1"));
        assert_eq!(reserved.created_at(), 42);
        assert_eq!(reserved.updated_at(), 42);

        // The lookup sees the pending row with the metadata the seal proved and the handle
        // mirrored into display_name.
        let hit = find_idempotent_reservation(&store, &user("u1"), &IdempotencyKey::new("idem-1"))
            .await
            .unwrap()
            .expect("a hit");
        assert_eq!(
            hit.materialization_status(),
            MaterializationStatus::PendingMaterialization
        );
        assert_eq!(hit.runtime(), RuntimeKind::Codex);
        assert_eq!(hit.name(), "a1");
        assert_eq!(hit.host_id(), "h1");
        assert_eq!(hit.session_scope(), "conversation");
    }

    #[tokio::test]
    async fn reserve_reports_a_duplicate_handle_as_a_constraint_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_agent("a1", "active", 1, Some("other-key")));
        let path = seed_schema(&dir, "reserve-name.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        // A different id but the same handle `a1` trips the `name` unique constraint.
        assert_eq!(
            reserve_agent(&store, &input("a1", "fresh-key"), 42)
                .await
                .unwrap(),
            ReserveOutcome::ConstraintConflict
        );
    }

    #[tokio::test]
    async fn reserve_reports_a_duplicate_idempotency_key_as_a_constraint_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_agent(
            "existing",
            "pending_materialization",
            1,
            Some("idem-1"),
        ));
        let path = seed_schema(&dir, "reserve-idem.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        // A fresh handle but the same `(u1, idem-1)` trips the per-creator index.
        assert_eq!(
            reserve_agent(&store, &input("a2", "idem-1"), 42)
                .await
                .unwrap(),
            ReserveOutcome::ConstraintConflict
        );
    }

    #[tokio::test]
    async fn fail_flips_a_pending_row_and_reflips_a_failed_one() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_agent(
            "a1",
            "pending_materialization",
            1,
            Some("idem-1"),
        ));
        let path = seed_schema(&dir, "fail.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let FailOutcome::Failed(failed) =
            fail_materialization(&store, &agent("a1"), "boom", 10, 11)
                .await
                .unwrap()
        else {
            panic!("expected a failed transition");
        };
        assert_eq!(failed.failed_code(), "boom");
        assert_eq!(failed.failed_at(), 10);
        assert_eq!(failed.updated_at(), 11);

        // failed -> failed re-stamps (the guard admits an already-failed row).
        let FailOutcome::Failed(refailed) =
            fail_materialization(&store, &agent("a1"), "again", 20, 21)
                .await
                .unwrap()
        else {
            panic!("expected a re-stamped failure");
        };
        assert_eq!(refailed.failed_code(), "again");
        assert_eq!(refailed.failed_at(), 20);
    }

    #[tokio::test]
    async fn fail_is_lost_against_an_active_or_absent_row() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_agent("a1", "active", 1, Some("idem-1")));
        let path = seed_schema(&dir, "fail-lost.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        assert_eq!(
            fail_materialization(&store, &agent("a1"), "boom", 10, 11)
                .await
                .unwrap(),
            FailOutcome::Lost
        );
        assert_eq!(
            fail_materialization(&store, &agent("missing"), "boom", 10, 11)
                .await
                .unwrap(),
            FailOutcome::Lost
        );
    }

    #[tokio::test]
    async fn reopen_flips_a_failed_row_and_clears_the_failure() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        // A failed row carrying a stale failure stamp, to prove reopen clears it.
        seed.push(
            "INSERT INTO agents \
             (id, name, display_name, runtime, host_id, created_by_user_id, created_at, \
              updated_at, materialization_status, session_scope, idempotency_key, \
              materialization_failed_code, materialization_failed_at) \
             VALUES ('a1', 'a1', 'a1', 'claude', 'h1', 'u1', 1, 1, 'failed', 'conversation', \
                     'idem-1', 'stale', 9)"
                .to_string(),
        );
        let path = seed_schema(&dir, "reopen.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let ReopenOutcome::Reopened(reopened) =
            reopen_failed_materialization(&store, &agent("a1"), 30)
                .await
                .unwrap()
        else {
            panic!("expected a reopened reservation");
        };
        assert_eq!(reopened.updated_at(), 30);

        let hit = find_idempotent_reservation(&store, &user("u1"), &IdempotencyKey::new("idem-1"))
            .await
            .unwrap()
            .expect("a hit");
        assert_eq!(
            hit.materialization_status(),
            MaterializationStatus::PendingMaterialization
        );
        assert_eq!(hit.materialization_failed_code(), None);
        assert_eq!(hit.materialization_failed_at(), None);
    }

    #[tokio::test]
    async fn reopen_is_lost_against_pending_active_or_absent() {
        let dir = tempfile::tempdir().unwrap();
        for status in ["pending_materialization", "active"] {
            let mut seed = base_seed();
            seed.push(seed_agent("a1", status, 1, Some("idem-1")));
            let path = seed_schema(&dir, &format!("reopen-{status}.db"), &seed).await;
            let store = SqliteHostAgentStore::open(&path).await.unwrap();
            assert_eq!(
                reopen_failed_materialization(&store, &agent("a1"), 30)
                    .await
                    .unwrap(),
                ReopenOutcome::Lost
            );
        }

        let path = seed_schema(&dir, "reopen-missing.db", &base_seed()).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();
        assert_eq!(
            reopen_failed_materialization(&store, &agent("missing"), 30)
                .await
                .unwrap(),
            ReopenOutcome::Lost
        );
    }

    #[tokio::test]
    async fn stale_sweep_fails_only_the_old_pending_rows() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_agent(
            "old-pending",
            "pending_materialization",
            5,
            Some("k-old"),
        ));
        seed.push(seed_agent(
            "new-pending",
            "pending_materialization",
            50,
            Some("k-new"),
        ));
        seed.push(seed_agent("old-active", "active", 5, Some("k-active")));
        seed.push(seed_agent("old-failed", "failed", 5, Some("k-failed")));
        let path = seed_schema(&dir, "stale.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        // cutoff strictly greater than old (5), strictly not greater than new (50).
        let swept = mark_stale_materializations_failed(&store, 25, 25, 26)
            .await
            .unwrap();
        assert_eq!(swept, vec![agent("old-pending")]);

        // The new pending row is untouched.
        let new_hit =
            find_idempotent_reservation(&store, &user("u1"), &IdempotencyKey::new("k-new"))
                .await
                .unwrap()
                .expect("a hit");
        assert_eq!(
            new_hit.materialization_status(),
            MaterializationStatus::PendingMaterialization
        );

        // The swept row carries the canonical code.
        let old_hit =
            find_idempotent_reservation(&store, &user("u1"), &IdempotencyKey::new("k-old"))
                .await
                .unwrap()
                .expect("a hit");
        assert_eq!(
            old_hit.materialization_status(),
            MaterializationStatus::Failed
        );
        assert_eq!(
            old_hit.materialization_failed_code(),
            Some(STALE_MATERIALIZATION_FAILED_CODE)
        );
        assert_eq!(old_hit.materialization_failed_at(), Some(25));
    }

    #[tokio::test]
    async fn lookup_returns_none_for_an_absent_pair() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "lookup-miss.db", &base_seed()).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();
        assert!(
            find_idempotent_reservation(&store, &user("u1"), &IdempotencyKey::new("nope"))
                .await
                .unwrap()
                .is_none()
        );
    }
}
