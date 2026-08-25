//! The single-agent write axis, and the one place the write boundary is spoken.
//!
//! Rust admits a trait through one impl block, so [`AgentTeardownUnitOfWork`] is
//! implemented here for [`SqliteHostAgentStore`]: this file owns `tear_down_agent`
//! inline and delegates the computer axis to [`super::cascade`], keeping the trait
//! surface in one place while each axis keeps its own mechanism.
//!
//! `tear_down_agent` reserves the writer, re-reads the agent's eligibility UNDER the
//! lock, and only then captures and deletes — the re-read is what makes the caller's
//! pre-lock decision safe. The delete touches ONLY the agent row; foreign-key
//! cascades erase the workspace, its conversations and their attachments, which is
//! why the capture is taken first: the storage keys vanish with the rows.

use silverhand_backend_core::{
    persistence::PersistenceFailure,
    teardown::{
        cascade::CascadeConsent,
        contract::TeardownFailure,
        eligibility::{AgentTeardownEligibility, EligibilityVerdict, hold_eligibility},
        write::{
            AgentTeardownCommit, AgentTeardownKey, AgentTeardownUnitOfWork, AgentTornDown,
            ComputerCascadeCommit, ComputerTeardownKey,
        },
    },
};

use super::{
    cascade,
    facts::{capture_agent, select_agent_facts},
    store::SqliteHostAgentStore,
};

/// The single-agent-row delete both write axes use: this axis deletes the one row
/// it re-read, and the computer cascade deletes each dependent through it. Foreign
/// keys erase everything the row owned.
pub(super) const DELETE_AGENT: &str = "DELETE FROM agents WHERE id = ?";

impl AgentTeardownUnitOfWork for SqliteHostAgentStore {
    async fn tear_down_agent(
        &self,
        key: AgentTeardownKey,
        expected: AgentTeardownEligibility,
    ) -> Result<AgentTeardownCommit, TeardownFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;

        let facts = match select_agent_facts(&mut tx, &key.agent_id)
            .await
            .map_err(PersistenceFailure::from_source)?
        {
            Some(facts) => facts,
            None => return Ok(AgentTeardownCommit::Gone),
        };

        match hold_eligibility(&expected, facts.clone()) {
            EligibilityVerdict::Moved(moved) => Ok(AgentTeardownCommit::Moved {
                moved,
                facts: Box::new(facts),
            }),
            EligibilityVerdict::Held(held) => {
                let capture = capture_agent(&mut tx, &key.agent_id)
                    .await
                    .map_err(PersistenceFailure::from_source)?;
                sqlx::query(DELETE_AGENT)
                    .bind(key.agent_id.as_str())
                    .execute(&mut *tx)
                    .await
                    .map_err(PersistenceFailure::from_source)?;
                let torn = AgentTornDown::seal(&key.agent_id, held, capture)?;
                tx.commit().await.map_err(PersistenceFailure::from_source)?;
                Ok(AgentTeardownCommit::Committed(Box::new(torn)))
            }
        }
    }

    async fn cascade_computer(
        &self,
        key: ComputerTeardownKey,
        consent: CascadeConsent,
    ) -> Result<ComputerCascadeCommit, TeardownFailure> {
        cascade::cascade_computer(self, key, consent).await
    }
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, time::Duration};

    use silverhand_backend_core::identity::{AgentId, HostId};
    use sqlx::Connection;
    use tempfile::TempDir;

    use super::*;

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
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

    /// The reservation fails a contended begin with SQLITE_BUSY (code 5). Walks the
    /// source chain because the axis hands the driver error over as
    /// `PersistenceFailure`'s source inside `TeardownFailure`.
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
    const ACTIVE_AGENT: &str = "INSERT INTO agents \
         (id, name, runtime, host_id, created_by_user_id, created_at, updated_at, \
          materialization_status, session_scope) \
         VALUES ('a1', 'a1', 'claude', 'h1', 'u1', 1, 1, 'active', 'conversation')";

    /// The deterministic writer-reservation gate. A no-write answer (`Moved`, from a
    /// mismatched eligibility) succeeds while nothing is held, then fails at the very
    /// first statement with SQLITE_BUSY once the single writer is held elsewhere.
    ///
    /// Falsifier: change the store's `BEGIN IMMEDIATE` to `BEGIN DEFERRED` and this
    /// test turns RED — a deferred begin takes no writer lock, so the no-write read
    /// path returns `Ok(Moved)` even while a writer is held, and `unwrap_err` panics.
    #[tokio::test]
    async fn tear_down_reserves_the_writer_before_its_first_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "reservation.db", &[USER, HOST, ACTIVE_AGENT]).await;
        let store = SqliteHostAgentStore::open_with_busy_timeout(&path, Duration::from_millis(50))
            .await
            .unwrap();

        let idle = store
            .tear_down_agent(
                AgentTeardownKey {
                    agent_id: agent("a1"),
                },
                AgentTeardownEligibility::ActiveOn {
                    host_id: host("h-other"),
                },
            )
            .await
            .unwrap();
        assert!(matches!(idle, AgentTeardownCommit::Moved { .. }));

        let held = store.begin_root_write().await.unwrap();
        let contended = store
            .tear_down_agent(
                AgentTeardownKey {
                    agent_id: agent("a1"),
                },
                AgentTeardownEligibility::ActiveOn {
                    host_id: host("h-other"),
                },
            )
            .await
            .unwrap_err();
        assert!(
            is_sqlite_busy(&contended),
            "the write axis did not reserve the writer before its first read"
        );
        held.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn an_eligible_agent_is_committed_and_its_row_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "commit.db", &[USER, HOST, ACTIVE_AGENT]).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let commit = store
            .tear_down_agent(
                AgentTeardownKey {
                    agent_id: agent("a1"),
                },
                AgentTeardownEligibility::ActiveOn {
                    host_id: host("h1"),
                },
            )
            .await
            .unwrap();
        assert!(matches!(commit, AgentTeardownCommit::Committed(_)));

        let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM agents WHERE id = 'a1'")
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    async fn an_absent_agent_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "gone.db", &[USER, HOST]).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let commit = store
            .tear_down_agent(
                AgentTeardownKey {
                    agent_id: agent("a1"),
                },
                AgentTeardownEligibility::ActiveOn {
                    host_id: host("h1"),
                },
            )
            .await
            .unwrap();
        assert!(matches!(commit, AgentTeardownCommit::Gone));
    }
}
