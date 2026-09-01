//! The single source-bound agent-row read the runtime-switch saga runs, for both
//! the pre-lock preflight and the authoritative under-lock re-read.
//!
//! This adapter WITNESSES the row it read: `source` is the row's own primary key,
//! projected from the `RETURNING`-shaped select and bound by the core saga against
//! the requested agent, so a snapshot resolved from the wrong row is a fault the
//! use case catches rather than acts on. A missing row is `None`; a stored token
//! outside its closed set (`runtime`, `session_scope`) is corrupt storage surfaced
//! as a read failure, never defaulted into a decision input.

use silverhand_backend_core::{
    host_runtime::agent_runtime_switch::{SwitchAgentSnapshot, SwitchAgentSnapshotRead},
    identity::AgentId,
    persistence::PersistenceFailure,
};
use sqlx::{Row, sqlite::SqliteRow};

use super::{decode, store::SqliteHostAgentStore};

/// The four row facts the preflight and the under-lock re-read decide from. SEATS
/// are NOT read here — those come through the lock-fenced sealed seat read so they
/// can only be enumerated while the transition marker is held.
const SELECT_SWITCH_SNAPSHOT: &str =
    "SELECT id, runtime, session_scope, host_id FROM agents WHERE id = ?";

fn switch_snapshot(row: &SqliteRow) -> Result<SwitchAgentSnapshot, sqlx::Error> {
    Ok(SwitchAgentSnapshot {
        source: decode::agent_id(row.try_get("id")?)?,
        runtime: decode::runtime(&row.try_get::<String, _>("runtime")?)?,
        session_scope: decode::session_scope(&row.try_get::<String, _>("session_scope")?)?,
        host: decode::host_id(row.try_get("host_id")?)?,
    })
}

impl SwitchAgentSnapshotRead for SqliteHostAgentStore {
    async fn read_switch_snapshot(
        &self,
        agent: &AgentId,
    ) -> Result<Option<SwitchAgentSnapshot>, PersistenceFailure> {
        let row = sqlx::query(SELECT_SWITCH_SNAPSHOT)
            .bind(agent.as_str())
            .fetch_optional(self.pool())
            .await
            .map_err(PersistenceFailure::from_source)?;
        row.as_ref()
            .map(switch_snapshot)
            .transpose()
            .map_err(PersistenceFailure::from_source)
    }
}
