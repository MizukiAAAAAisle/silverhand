//! The durable deletion-intent lifecycle: the fail-forward marker write, the
//! restart inventory, and the keyed completing write.
//!
//! All three run under the same root-write reservation the other axes use.
//! `begin` is a compare-and-set that turns a null marker into a timestamp; the
//! `WHERE` re-states every precondition the pre-read observed, so a row that moved
//! out from under the lock changes nothing and surfaces as a lost serialized CAS
//! rather than a silent no-op. `complete` re-reads the attempt's own agent under
//! the lock and captures before the delete, exactly as the single-agent axis does;
//! the marker's timestamp is the token it matches on, so another attempt taking the
//! row is `AttemptLost`, not a second teardown.

use silverhand_backend_core::{
    agent_lifecycle::MaterializationStatus,
    identity::{AgentId, HostId},
    persistence::PersistenceFailure,
    teardown::{
        contract::TeardownFailure,
        eligibility::{AgentTeardownEligibility, EligibilityVerdict, hold_eligibility},
        intent::{
            AgentDeletionAttempt, AgentDeletionLifecyclePort, BeginDeletionRecord,
            CompleteDeletion, PersistedDeletionIntent,
        },
        write::AgentTornDown,
    },
};
use sqlx::{Row, sqlite::SqliteRow};
use thiserror::Error;

use super::{
    decode,
    facts::{capture_agent, select_agent_facts},
    store::SqliteHostAgentStore,
    teardown::DELETE_AGENT,
};

/// The pre-read the marker write decides from. It reads `runtime_transition_target`,
/// which the shared agent-facts projection does not carry, because the ONE stage a
/// deletion may not begin from beyond "not active" is a runtime transition holding
/// the row.
const SELECT_BEGIN_PRECHECK: &str = "SELECT host_id, materialization_status, deletion_started_at, \
     runtime_transition_target FROM agents WHERE id = ?";

/// The marker write. `updated_at` is bumped with the marker so the row's mtime
/// reflects the transition, matching the TypeScript authority. The `WHERE` is the
/// serialized compare-and-set: still active, still unmarked, no transition.
const BEGIN_DELETION_CAS: &str = "UPDATE agents \
        SET deletion_started_at = ?, updated_at = ? \
      WHERE id = ? \
        AND materialization_status = 'active' \
        AND deletion_started_at IS NULL \
        AND runtime_transition_target IS NULL";

/// The restart inventory, ordered oldest-marker-first so a resumer drains them in
/// the order they were condemned.
const SELECT_PENDING_DELETIONS: &str = "SELECT id, host_id, deletion_started_at \
       FROM agents WHERE deletion_started_at IS NOT NULL \
      ORDER BY deletion_started_at ASC, id ASC";

/// The writer was reserved and every precondition the pre-read observed still held,
/// yet the CAS changed no row. Under `BEGIN IMMEDIATE` nothing else can have written
/// the row, so this is a broken invariant, not a product answer.
#[derive(Debug, Error)]
#[error("begin agent deletion lost its serialized compare-and-set")]
struct DeletionCasLost;

/// What the pre-read observed, decoded through the same authorities the facts
/// projection uses.
struct BeginPrecheck {
    host_id: HostId,
    status: MaterializationStatus,
    deletion_started_at: Option<i64>,
    runtime_transition_target: Option<String>,
}

fn begin_precheck(row: &SqliteRow) -> Result<BeginPrecheck, sqlx::Error> {
    Ok(BeginPrecheck {
        host_id: decode::host_id(row.try_get("host_id")?)?,
        status: decode::materialization_status(
            &row.try_get::<String, _>("materialization_status")?,
        )?,
        deletion_started_at: row.try_get("deletion_started_at")?,
        runtime_transition_target: row.try_get::<Option<String>, _>("runtime_transition_target")?,
    })
}

fn pending_intent(row: &SqliteRow) -> Result<PersistedDeletionIntent, sqlx::Error> {
    Ok(PersistedDeletionIntent {
        agent_id: decode::agent_id(row.try_get("id")?)?,
        host_id: decode::host_id(row.try_get("host_id")?)?,
        deletion_started_at: row.try_get("deletion_started_at")?,
    })
}

impl AgentDeletionLifecyclePort for SqliteHostAgentStore {
    async fn begin(
        &self,
        agent_id: &AgentId,
        started_at: i64,
    ) -> Result<BeginDeletionRecord, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;

        let Some(row) = sqlx::query(SELECT_BEGIN_PRECHECK)
            .bind(agent_id.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?
        else {
            return Ok(BeginDeletionRecord::NotFound);
        };
        let pre = begin_precheck(&row).map_err(PersistenceFailure::from_source)?;

        // Precedence is the TypeScript authority's: an existing marker answers first
        // (this request changed nothing), then stage, then a runtime transition.
        if let Some(deletion_started_at) = pre.deletion_started_at {
            return Ok(BeginDeletionRecord::AlreadyPending(
                PersistedDeletionIntent {
                    agent_id: agent_id.clone(),
                    host_id: pre.host_id,
                    deletion_started_at,
                },
            ));
        }
        if pre.status != MaterializationStatus::Active {
            return Ok(BeginDeletionRecord::NotActive);
        }
        if pre.runtime_transition_target.is_some() {
            return Ok(BeginDeletionRecord::RuntimeTransitionInProgress);
        }

        let changed = sqlx::query(BEGIN_DELETION_CAS)
            .bind(started_at)
            .bind(started_at)
            .bind(agent_id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?
            .rows_affected();
        if changed != 1 {
            return Err(PersistenceFailure::from_source(DeletionCasLost));
        }
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(BeginDeletionRecord::Started(PersistedDeletionIntent {
            agent_id: agent_id.clone(),
            host_id: pre.host_id,
            deletion_started_at: started_at,
        }))
    }

    async fn list_pending(&self) -> Result<Vec<PersistedDeletionIntent>, PersistenceFailure> {
        let mut conn = self
            .pool()
            .acquire()
            .await
            .map_err(PersistenceFailure::from_source)?;
        let rows = sqlx::query(SELECT_PENDING_DELETIONS)
            .fetch_all(&mut *conn)
            .await
            .map_err(PersistenceFailure::from_source)?;
        rows.iter()
            .map(pending_intent)
            .collect::<Result<Vec<_>, sqlx::Error>>()
            .map_err(PersistenceFailure::from_source)
    }

    async fn complete(
        &self,
        attempt: &AgentDeletionAttempt,
    ) -> Result<CompleteDeletion, TeardownFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;

        let facts = match select_agent_facts(&mut tx, attempt.agent_id())
            .await
            .map_err(PersistenceFailure::from_source)?
        {
            Some(facts) => facts,
            None => return Ok(CompleteDeletion::Gone),
        };

        // The marker's timestamp is the token: another attempt owning the row, a
        // stage change, or a host move all mean this attempt no longer owns the
        // deletion and must delete nothing.
        if facts.materialization_status != MaterializationStatus::Active
            || &facts.host_id != attempt.host_id()
            || facts.deletion_started_at != Some(attempt.deletion_started_at())
        {
            return Ok(CompleteDeletion::AttemptLost);
        }

        let expected = AgentTeardownEligibility::ActiveOn {
            host_id: attempt.host_id().clone(),
        };
        let EligibilityVerdict::Held(held) = hold_eligibility(&expected, facts) else {
            unreachable!("complete re-read the attempt's own agent as active on its own computer");
        };
        let capture = capture_agent(&mut tx, attempt.agent_id())
            .await
            .map_err(PersistenceFailure::from_source)?;
        sqlx::query(DELETE_AGENT)
            .bind(attempt.agent_id().as_str())
            .execute(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
        let torn = AgentTornDown::seal(attempt.agent_id(), held, capture)?;
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(CompleteDeletion::Committed(Box::new(torn)))
    }
}
