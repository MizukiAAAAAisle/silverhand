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
    foundation::persistence::PersistenceFailure,
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

    use silverhand_backend_core::{
        host_runtime::runtime_credential::RuntimeScope,
        host_runtime::runtime_event::RuntimeObservedStatus,
        identity::{AgentId, HostId},
        teardown::facts::AgentTeardownCapture,
    };
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

    /// A single agent with all four post-commit authorities populated and mutually
    /// distinguishable, so each half of its capture can be asserted — and
    /// independently falsified — from ONE durable committed teardown:
    ///
    /// - two raw runtime seats, one idle at generation 0 and one active at
    ///   generation 1, so a running-only filter or a derived/reset generation shows;
    /// - three fixed-roster home channels created in the REVERSE of the roster
    ///   priority, with blobs on the two the ordering puts after the head (the head
    ///   itself has none), so a head-only sweep or a created_at ordering shows;
    /// - one regular-workspace membership beside the agent's OWNED home, so a
    ///   miscount shows — the schema forbids a home from being a membership row, so
    ///   the count is regular-only by construction.
    const CAPTURE_FIXTURE: [&str; 14] = [
        "INSERT INTO users (id, name, display_name, created_at, updated_at) \
         VALUES ('u1', 'u1', 'U1', 1, 1)",
        "INSERT INTO hosts (id, name, kind, created_at) VALUES ('h1', 'h1', 'local', 1)",
        "INSERT INTO agents \
         (id, name, runtime, host_id, created_by_user_id, created_at, updated_at, \
          materialization_status, session_scope) \
         VALUES ('a1', 'a1', 'claude', 'h1', 'u1', 1, 1, 'active', 'conversation')",
        "INSERT INTO workspaces (id, name, name_key, owner_agent_id, created_at, updated_at) \
         VALUES ('w-home', 'a1 home', NULL, 'a1', 1, 1)",
        "INSERT INTO workspaces (id, name, name_key, created_at, updated_at) \
         VALUES ('w-reg', 'Regular', 'reg', 1, 1)",
        "INSERT INTO conversations \
         (id, workspace_id, placement_kind, roster_policy, title, title_key, status, \
          created_at, updated_at) \
         VALUES ('ch-general', 'w-home', 'workspace', 'fixed', 'general', 'general', \
          'active', 100, 100)",
        "INSERT INTO conversations \
         (id, workspace_id, placement_kind, roster_policy, title, title_key, status, \
          created_at, updated_at) \
         VALUES ('ch-dm', 'w-home', 'workspace', 'fixed', 'dm-a1', 'dma1', \
          'active', 200, 200)",
        "INSERT INTO conversations \
         (id, workspace_id, placement_kind, roster_policy, title, title_key, status, \
          created_at, updated_at) \
         VALUES ('ch-onboarding', 'w-home', 'workspace', 'fixed', 'Onboarding', 'onboarding', \
          'active', 300, 300)",
        "INSERT INTO attachments \
         (id, channel_id, filename, size, content_type, storage, storage_key, \
          created_by_kind, created_by_id, created_at) \
         VALUES ('att-dm', 'ch-dm', 'f', 1, 'text/plain', 's-dm', 'k-dm', 'user', 'u1', 1)",
        "INSERT INTO attachments \
         (id, channel_id, filename, size, content_type, storage, storage_key, \
          created_by_kind, created_by_id, created_at) \
         VALUES ('att-general', 'ch-general', 'f', 1, 'text/plain', 's-general', 'k-general', \
          'user', 'u1', 1)",
        // Joining each channel auto-creates an idle, generation-0 slot (a schema
        // trigger both requires participation and mints the seat), so ch-general is
        // the not-running seat as created; the UPDATE advances only ch-dm to a
        // running status and the next generation.
        "INSERT INTO conversation_agents (conversation_id, agent_id, joined_at) \
         VALUES ('ch-general', 'a1', 1)",
        "INSERT INTO conversation_agents (conversation_id, agent_id, joined_at) \
         VALUES ('ch-dm', 'a1', 1)",
        "UPDATE agent_runtime_slots SET observed_status = 'active', generation = 1 \
         WHERE agent_id = 'a1' AND conversation_id = 'ch-dm'",
        "INSERT INTO workspace_members (workspace_id, agent_id, joined_at) \
         VALUES ('w-reg', 'a1', 1)",
    ];

    /// The one durable committed teardown the capture gates read. `capture_agent`
    /// (facts.rs) is the single helper all THREE write paths consume — this axis
    /// (`teardown.rs`), the computer cascade (`cascade.rs`), and the
    /// deletion-completion path (`intent.rs`) — so pinning its output on this
    /// single-agent commit locks the capture code every path shares. Hands back the
    /// owned capture so each gate below asserts exactly one of its four halves; stub
    /// any half to `Vec::new()`/`None`/`0` and only that half's gate turns RED.
    async fn capture_from_committed_teardown(dir: &TempDir) -> AgentTeardownCapture {
        let path = seed_schema(dir, "capture.db", &CAPTURE_FIXTURE).await;
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
            .expect("an eligible active agent tears down");
        let AgentTeardownCommit::Committed(torn) = commit else {
            panic!("an eligible active agent commits its teardown");
        };
        torn.capture().clone()
    }

    /// Half 1 — every RAW seat is captured, running or not, with its exact scope,
    /// status and generation. Asserting the idle seat as well locks the adapter out
    /// of a running-only filter; asserting the exact status and generation locks it
    /// out of deriving a status or resetting the generation the row carried.
    #[tokio::test]
    async fn the_committed_capture_carries_every_raw_seat() {
        let dir = tempfile::tempdir().unwrap();
        let capture = capture_from_committed_teardown(&dir).await;

        assert_eq!(capture.runtime_sessions.len(), 2);

        let idle = capture
            .runtime_sessions
            .iter()
            .find(|session| session.scope.source().map(|c| c.as_str()) == Some("ch-general"))
            .expect("the idle seat is captured, not filtered out");
        assert!(matches!(
            &idle.scope,
            RuntimeScope::ConversationSlot { agent, .. } if agent == &self::agent("a1")
        ));
        assert_eq!(idle.status, RuntimeObservedStatus::Idle);
        assert_eq!(idle.generation.as_i64(), 0);

        let active = capture
            .runtime_sessions
            .iter()
            .find(|session| session.scope.source().map(|c| c.as_str()) == Some("ch-dm"))
            .expect("the active seat is captured");
        assert!(matches!(
            &active.scope,
            RuntimeScope::ConversationSlot { agent, .. } if agent == &self::agent("a1")
        ));
        assert_eq!(active.status, RuntimeObservedStatus::Active);
        assert_eq!(active.generation.as_i64(), 1);
    }

    /// Half 2 — the blob sweep spans the WHOLE ordered channel set, not just its
    /// head, and captures each blob's FULL durable coordinate. Blobs live only on
    /// the two channels the ordering puts after the head, so a sweep that stopped
    /// at the first channel would capture nothing; the two carry distinct storage
    /// backends, so dropping or crossing the `storage` half — which the post-commit
    /// sweeper needs to route to the right backend — turns this RED even though the
    /// keys still match.
    #[tokio::test]
    async fn the_committed_capture_sweeps_blobs_across_every_home_channel() {
        let dir = tempfile::tempdir().unwrap();
        let capture = capture_from_committed_teardown(&dir).await;

        let mut pairs: Vec<(&str, &str)> = capture
            .dm_blob_refs
            .iter()
            .map(|blob| (blob.storage.as_str(), blob.storage_key.as_str()))
            .collect();
        pairs.sort_unstable();
        assert_eq!(pairs, [("s-dm", "k-dm"), ("s-general", "k-general")]);
    }

    /// Half 3 — the summary handle is the roster ordering's HEAD, not the
    /// earliest-created row. The three channels are created in the reverse of the
    /// priority (onboarding last), so a plain created_at order would surface
    /// `ch-general` and this turns RED.
    #[tokio::test]
    async fn the_committed_capture_picks_the_dm_channel_by_the_roster_ordering() {
        let dir = tempfile::tempdir().unwrap();
        let capture = capture_from_committed_teardown(&dir).await;

        assert_eq!(
            capture.dm_channel_id.as_ref().map(|id| id.as_str()),
            Some("ch-onboarding")
        );
    }

    /// Half 4 — the workspace count is the agent's REGULAR memberships, exact and
    /// without its owned home. The agent owns a home and is a member of one regular
    /// workspace; the schema forbids a home from being a membership row, so the
    /// count is regular-only and the exact 1 shows a miscount.
    #[tokio::test]
    async fn the_committed_capture_counts_regular_memberships_without_the_home() {
        let dir = tempfile::tempdir().unwrap();
        let capture = capture_from_committed_teardown(&dir).await;

        assert_eq!(capture.regular_workspace_count, 1);
    }
}
