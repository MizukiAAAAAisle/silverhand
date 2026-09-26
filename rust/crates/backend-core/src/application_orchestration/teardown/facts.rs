//! The typed facts a teardown consumes, one projection per phase.
//!
//! Deliberately not one wide impact object and not a row DTO: each type below
//! names exactly what ONE phase reads, so a column added to an agent, workspace
//! or conversation cannot silently become an input to a delete.

use crate::{
    foundation::identity::{AgentId, ConversationId, HostId},
    host_runtime::computer::{HostKind, ProvisioningSource},
    host_runtime::runtime_credential::{RuntimeGeneration, RuntimeScope},
    host_runtime::runtime_event::RuntimeObservedStatus,
    identity_access::agent_lifecycle::MaterializationStatus,
};

/// The agent facts a teardown consumes. Every field has a named consumer:
/// the stage drives the dispatch and the in-lock eligibility re-read; the host
/// routes the host-local purge and the post-commit runtime stop on both axes (by
/// then no agent row is left to resolve it from); name, display name and runtime
/// serve the summary logs and the computer cascade's dependent projection; the
/// failure code serves the row-only delete's log line.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTeardownFacts {
    pub id: AgentId,
    pub name: String,
    pub display_name: String,
    /// Which runtime this agent runs, as an opaque projection. Teardown never
    /// branches on it — it forwards it to a log and a dependent listing — so a
    /// closed runtime vocabulary is not this module's to declare.
    pub runtime: String,
    pub host_id: HostId,
    pub materialization_status: MaterializationStatus,
    pub failed_code: Option<String>,
    pub deletion_started_at: Option<i64>,
}

/// One runtime SEAT of the agent, with its RAW observed status. Deciding which
/// statuses still own a live child is a domain rule and stays in
/// [`is_running_session`]; an adapter-side filter would put that rule where no
/// test of this layer can see it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRuntimeSessionFacts {
    /// The stable custody identity. Its source conversation, when it has one, is
    /// read from the scope rather than carried a second time.
    pub scope: RuntimeScope,
    pub status: RuntimeObservedStatus,
    /// Captured before the cascade so a post-commit stop cannot target a
    /// successor that claimed the seat afterwards.
    pub generation: RuntimeGeneration,
}

/// Whether this seat still owns a live runtime child.
pub fn is_running_session(session: &AgentRuntimeSessionFacts) -> bool {
    matches!(
        session.status,
        RuntimeObservedStatus::Starting | RuntimeObservedStatus::Active
    )
}

/// Where a blob physically lives. Opaque here on purpose: teardown never
/// interprets either half, it only carries them to the post-commit sweeper.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredBlobRef {
    pub storage: String,
    pub storage_key: String,
}

/// Everything the POST-COMMIT phase needs, captured inside the write scope
/// because the same transaction deletes every row it derives from.
///
/// The blob refs are why this cannot be recomputed afterwards: the storage key
/// lives on the attachment row, which cascades away with the agent's home. The
/// sessions are the authoritative live-child set for both axes and are stopped in
/// FULL on both — a scope-and-generation pair names a seat, not a promise that
/// nothing reclaimed it, and re-stopping is sound because the daemon's stop is
/// idempotent. The workspace count is a log-only fact: the log is the only place
/// a residue-leaving best-effort phase can be accounted for.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTeardownCapture {
    /// Whose capture this is. Not consumed by any post-commit phase — every phase
    /// below is already keyed by what it carries — but a capture is the SECOND
    /// channel through which a committed teardown could describe a row, so it must
    /// name the row it came from or nothing can check that it is the same one the
    /// rule admitted. See [`crate::application_orchestration::teardown::write::AgentTornDown::seal`].
    pub agent_id: AgentId,
    pub runtime_sessions: Vec<AgentRuntimeSessionFacts>,
    pub dm_blob_refs: Vec<StoredBlobRef>,
    /// The agent's own home channel, for the summary log. Absent when it owns no
    /// home.
    pub dm_channel_id: Option<ConversationId>,
    pub regular_workspace_count: u32,
}

/// The computer facts the LIFECYCLE rule reads: the two halves of "is this
/// lifecycle a user request's to end".
///
/// Whose computer it is is deliberately absent. Ownership is authorization and is
/// read as its own narrow projection by [`crate::identity_access::capability::computer_access`], so
/// neither rule can answer the other's question from a field it happens to hold.
///
/// Both halves here are projected RAW rather than pre-combined into one deletable
/// flag, because the combination is a rule — see
/// [`crate::application_orchestration::teardown::cascade::hold_computer_lifecycle`] — and an adapter that
/// collapsed them would hold that rule where no test of this layer can see it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerTeardownFacts {
    pub id: HostId,
    pub kind: HostKind,
    pub provisioning_source: ProvisioningSource,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(status: RuntimeObservedStatus) -> AgentRuntimeSessionFacts {
        AgentRuntimeSessionFacts {
            scope: RuntimeScope::AgentSlot {
                agent: AgentId::parse("a1").expect("agent id"),
            },
            status,
            generation: RuntimeGeneration::new(3).expect("generation"),
        }
    }

    #[test]
    fn only_a_starting_or_active_seat_owns_a_live_child() {
        assert!(is_running_session(&session(
            RuntimeObservedStatus::Starting
        )));
        assert!(is_running_session(&session(RuntimeObservedStatus::Active)));
        assert!(!is_running_session(&session(RuntimeObservedStatus::Idle)));
        assert!(!is_running_session(&session(
            RuntimeObservedStatus::Crashed
        )));
    }
}
