//! The one write boundary both cascades take.
//!
//! ## One mechanism, two axes
//!
//! Deleting an agent and deleting the computer that agent sits on destroy the SAME
//! rows, so they are two keys on ONE boundary rather than two boundaries: the
//! single-agent axis keys on the agent, the computer axis keys on the (computer,
//! owner) pair. Per engine:
//!
//!  - SQLite: root-only immediate transactions. The write lock is file-wide, so the
//!    two axes already exclude each other with nothing extra — which is exactly why
//!    they must not drift into two mechanisms.
//!  - Pooled engines: the two axes must take mechanisms that exclude each other,
//!    and the single-agent axis's must be derivable from the COMPUTER half too — a
//!    lock on the agent row alone would let a computer cascade and a single-agent
//!    delete run concurrently over the same rows. The obligation is symmetric: it
//!    also binds the row the cascade deletes at its root, because a lock taken on a
//!    row that is then deleted must still order the two writers.
//!
//! ## Data crosses this boundary; a transaction never does
//!
//! Each method is ONE semantic operation over data. No scope, handle or callback is
//! handed out, so application code cannot interleave work inside the lock, and the
//! ordering that makes a refusal mean "nothing happened" is not something a caller
//! can get wrong.
//!
//! The consequence is that the implementation INVOKES the rules rather than
//! receiving their verdicts: it reads the authoritative facts under the mechanism
//! and calls [`crate::teardown::eligibility::eligibility_moved`] /
//! [`crate::teardown::cascade::cascade_refusal`] there. The rules stay owned here,
//! and the refusal behaviour is pinned on the real adapter by a persistence
//! contract suite rather than by trusting an implementation to re-derive them.
//!
//! ## What this boundary does NOT promise
//!
//! Atomicity covers CONTROL-PLANE ROWS and the capture taken from the same
//! snapshot. The host-local purge and the blob sweep live outside it, and the two
//! axes deliberately order the purge differently — the single-agent path purges
//! before the commit and fails closed, so a retry can still re-target the tree,
//! while the computer path purges after the commit and best-effort, because the
//! control plane that could reference those bytes is itself being deleted and
//! refusing would recreate an undeletable computer. So the purge → commit window can
//! leave regenerated host-local files, and a post-commit sweep failure leaves blobs
//! with no row left to name them. Both are residuals, not properties claimed here.

use std::future::Future;

use crate::{
    identity::{AgentId, HostId, UserId},
    persistence::PersistenceFailure,
    teardown::{
        cascade::{CascadeConsent, CascadeRefused},
        eligibility::{AgentTeardownEligibility, EligibilityMoved},
        facts::{AgentTeardownCommitted, AgentTeardownFacts},
    },
};

/// Which agent this write may tear down.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTeardownKey {
    pub agent_id: AgentId,
}

/// Which computer this write may tear down, and for whom. The owner is part of the
/// key because the row delete is CONDITIONAL on it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerTeardownKey {
    pub host_id: HostId,
    pub user_id: UserId,
}

/// What the single-agent write found.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentTeardownCommit {
    /// The row is already gone — a concurrent delete won. Not a failure.
    Gone,
    /// Nothing happened: a fact the pre-lock phase had already acted on had moved
    /// since. Carries the facts as read UNDER the mechanism, i.e. the state the
    /// refusal is about.
    Moved {
        moved: EligibilityMoved,
        facts: Box<AgentTeardownFacts>,
    },
    Committed(Box<AgentTeardownCommitted>),
}

/// What the computer cascade deleted, captured inside the write because every row
/// it derives from is deleted there.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerCascade {
    /// The failed rows, deleted row-only: no dependents, no runtime, no tree.
    pub row_only: Vec<AgentTeardownFacts>,
    /// The full cascades, with the post-commit work captured for each.
    pub torn_down: Vec<AgentTeardownCommitted>,
}

impl ComputerCascade {
    /// Every agent row the cascade deleted — the identity fan-out set. Derived
    /// rather than stored, because a stored union is a third field that can
    /// disagree with the two halves it summarises.
    pub fn deleted_agents(&self) -> impl Iterator<Item = &AgentTeardownFacts> {
        self.row_only
            .iter()
            .chain(self.torn_down.iter().map(|torn| &torn.facts))
    }
}

/// What the computer cascade found.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ComputerCascadeCommit {
    /// Nothing happened: the in-lock rule refused from the authoritative set and
    /// the whole scope rolled back.
    Refused(CascadeRefused),
    /// The conditional computer-row delete matched nothing — deleted concurrently,
    /// or never user-managed. Nothing happened; the agent deletes rolled back with
    /// it, rather than reporting a success this request did not cause.
    ComputerGone,
    Committed(ComputerCascade),
}

/// The atomic write boundary. Atomic AND serializing: each axis decides from an
/// authoritative read that PRECEDES its writes, so the mechanism must be held
/// before the first statement — a deferred begin would take the lock at the first
/// write, after the read it is supposed to protect.
pub trait AgentTeardownUnitOfWork: Clone + Send + Sync + 'static {
    /// Re-read the agent's eligibility under the mechanism, capture the
    /// post-commit work, and delete the row. `expected` is what the caller's
    /// pre-lock phase ALREADY ACTED ON; re-reading it here is what makes having
    /// taken those decisions outside the lock safe.
    fn tear_down_agent(
        &self,
        key: AgentTeardownKey,
        expected: AgentTeardownEligibility,
    ) -> impl Future<Output = Result<AgentTeardownCommit, PersistenceFailure>> + Send;

    /// Read the computer's dependency set under the mechanism, check the cascade
    /// rule against it, capture, then delete the agent rows and the computer row as
    /// one unit.
    fn cascade_computer(
        &self,
        key: ComputerTeardownKey,
        consent: CascadeConsent,
    ) -> impl Future<Output = Result<ComputerCascadeCommit, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent_lifecycle::MaterializationStatus,
        teardown::facts::{AgentTeardownCapture, StoredBlobRef},
    };

    fn facts(id: &str, status: MaterializationStatus) -> AgentTeardownFacts {
        AgentTeardownFacts {
            id: AgentId::parse(id).expect("agent id"),
            name: id.into(),
            display_name: id.into(),
            runtime: "claude".into(),
            host_id: HostId::parse("h1").expect("host id"),
            materialization_status: status,
            failed_code: None,
            deletion_started_at: None,
        }
    }

    fn torn_down(id: &str) -> AgentTeardownCommitted {
        AgentTeardownCommitted {
            facts: facts(id, MaterializationStatus::Active),
            capture: AgentTeardownCapture {
                runtime_sessions: Vec::new(),
                dm_blob_refs: vec![StoredBlobRef {
                    storage: "blob".into(),
                    storage_key: id.into(),
                }],
                dm_channel_id: None,
                regular_workspace_count: 0,
            },
        }
    }

    #[test]
    fn the_fan_out_set_is_every_row_the_cascade_deleted() {
        let cascade = ComputerCascade {
            row_only: vec![facts("a1", MaterializationStatus::Failed)],
            torn_down: vec![torn_down("a2"), torn_down("a3")],
        };
        assert_eq!(
            cascade
                .deleted_agents()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a1", "a2", "a3"]
        );
    }

    #[test]
    fn a_cascade_that_deleted_only_the_computer_names_no_agent() {
        let cascade = ComputerCascade {
            row_only: Vec::new(),
            torn_down: Vec::new(),
        };
        assert_eq!(cascade.deleted_agents().count(), 0);
    }
}
