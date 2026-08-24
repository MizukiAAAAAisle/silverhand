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
//! ## The rules are invoked here, and the committed outcome proves it
//!
//! The implementation reads the authoritative facts under the mechanism and calls
//! the rules THERE — they are not handed verdicts from outside, because a verdict
//! decided before the lock is exactly the stale answer this boundary exists to
//! reject. What keeps that from becoming trust is the shape of the outcome types:
//! [`AgentTornDown`] and [`ComputerCascade`] can only be built around a witness the
//! rules mint ([`crate::teardown::eligibility::EligibilityHeld`],
//! [`crate::teardown::cascade::CascadeAdmitted`]), and those witnesses OWN the facts
//! they judged, so a committed outcome has no second channel to describe a row from.
//! An implementation that re-stated a comparison inline has nothing to return.
//!
//! For the computer axis the witness chain also fixes the ORDER: the cascade
//! admission requires the lifecycle witness, which requires the access witness, so
//! "is it theirs, then may its lifecycle end, then does its dependency set admit
//! this" cannot be asked out of order or skipped.
//!
//! What no witness can prove is that the facts were read UNDER the mechanism, whole
//! and unfiltered — one minted from a stale or filtered read is well-formed. That
//! residual is owed as a differential persistence contract on each real adapter, and
//! it must include a case where filtering one raw half changes the refusal, and a
//! case where the authority changes after the pre-lock read and the in-lock
//! judgement is required to see the new facts.
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
        cascade::{CascadeAdmitted, CascadeConsent, CascadeRefused, ComputerLifecycleHeld},
        eligibility::{AgentTeardownEligibility, EligibilityHeld, EligibilityMoved},
        facts::{AgentTeardownCapture, AgentTeardownFacts},
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

/// One agent whose full teardown COMMITTED, with the post-commit work captured from
/// the same snapshot.
///
/// The facts are read out of the witness rather than stored beside it: there is one
/// place a committed teardown can describe a row from, and it is the row the rule
/// admitted. Both axes produce this type — the single-agent delete and each full
/// cascade inside a computer teardown — because both owe exactly this pair.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTornDown {
    held: EligibilityHeld,
    capture: AgentTeardownCapture,
}

impl AgentTornDown {
    /// Only constructible from a witness, which is the whole seal.
    pub fn new(held: EligibilityHeld, capture: AgentTeardownCapture) -> Self {
        Self { held, capture }
    }

    pub fn facts(&self) -> &AgentTeardownFacts {
        self.held.facts()
    }

    pub fn capture(&self) -> &AgentTeardownCapture {
        &self.capture
    }

    pub fn into_parts(self) -> (AgentTeardownFacts, AgentTeardownCapture) {
        (self.held.into_facts(), self.capture)
    }
}

/// What the single-agent write found.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentTeardownCommit {
    /// The row is already gone — a concurrent delete won. Not a failure.
    Gone,
    /// Nothing happened: a fact the pre-lock phase had already acted on had moved
    /// since. Carries the facts as read UNDER the mechanism, i.e. the state the
    /// refusal is about. Unwitnessed by construction — this is the arm where the
    /// rule refused.
    Moved {
        moved: EligibilityMoved,
        facts: Box<AgentTeardownFacts>,
    },
    Committed(Box<AgentTornDown>),
}

/// What the computer cascade deleted, captured inside the write because every row
/// it derives from is deleted there.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerCascade {
    lifecycle: ComputerLifecycleHeld,
    row_only: Vec<AgentTeardownFacts>,
    torn_down: Vec<AgentTornDown>,
}

impl ComputerCascade {
    /// Only constructible from the admission, and the row-only half is DERIVED from
    /// the admitted set rather than accepted: the half of a cascade that has no
    /// post-commit work of its own is the easiest to misreport, and nothing outside
    /// this type gets to name it. The full teardowns each carry their own witness.
    pub fn new(admitted: CascadeAdmitted, torn_down: Vec<AgentTornDown>) -> Self {
        Self {
            row_only: admitted.row_only(),
            lifecycle: admitted.into_lifecycle(),
            torn_down,
        }
    }

    /// The owner every announcement this cascade causes is fanned out on.
    pub fn owner(&self) -> &UserId {
        self.lifecycle.owner()
    }

    pub fn computer(&self) -> &HostId {
        &self.lifecycle.computer().id
    }

    /// The failed rows, deleted row-only: no dependents, no runtime, no tree.
    pub fn row_only(&self) -> &[AgentTeardownFacts] {
        &self.row_only
    }

    /// The full cascades, with the post-commit work captured for each.
    pub fn torn_down(&self) -> &[AgentTornDown] {
        &self.torn_down
    }

    /// Every agent row the cascade deleted — the identity fan-out set. Derived
    /// rather than stored, because a stored union is a third field that can
    /// disagree with the two halves it summarises.
    pub fn deleted_agents(&self) -> impl Iterator<Item = &AgentTeardownFacts> {
        self.row_only
            .iter()
            .chain(self.torn_down.iter().map(AgentTornDown::facts))
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

    /// Take the two narrow projections under the mechanism, pass the access witness
    /// through the lifecycle rule and the dependency set through the cascade rule,
    /// capture, then delete the agent rows and the computer row as one unit.
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
        capability::computer_access::{
            ComputerAccess, ComputerOwnershipFacts, can_access_computer,
        },
        teardown::{
            cascade::{
                CascadeAdmission, ComputerLifecycle, admit_cascade, hold_computer_lifecycle,
            },
            eligibility::{EligibilityVerdict, hold_eligibility},
            facts::{ComputerTeardownFacts, HostKind, ProvisioningSource, StoredBlobRef},
        },
    };

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn host() -> HostId {
        HostId::parse("h1").expect("host id")
    }

    fn facts(id: &str, status: MaterializationStatus) -> AgentTeardownFacts {
        AgentTeardownFacts {
            id: AgentId::parse(id).expect("agent id"),
            name: id.into(),
            display_name: id.into(),
            runtime: "claude".into(),
            host_id: host(),
            materialization_status: status,
            failed_code: None,
            deletion_started_at: None,
        }
    }

    fn capture(key: &str) -> AgentTeardownCapture {
        AgentTeardownCapture {
            runtime_sessions: Vec::new(),
            dm_blob_refs: vec![StoredBlobRef {
                storage: "blob".into(),
                storage_key: key.into(),
            }],
            dm_channel_id: None,
            regular_workspace_count: 0,
        }
    }

    /// Obtained the way production obtains it: from the rule, under the eligibility
    /// the cascade key names. Nothing here can assemble one.
    fn torn_down(id: &str) -> AgentTornDown {
        let expected = AgentTeardownEligibility::ActiveOn { host_id: host() };
        let EligibilityVerdict::Held(held) =
            hold_eligibility(&expected, facts(id, MaterializationStatus::Active))
        else {
            panic!("expected the rule to admit");
        };
        AgentTornDown::new(held, capture(id))
    }

    fn admitted(agents: Vec<AgentTeardownFacts>) -> CascadeAdmitted {
        let ownership = ComputerOwnershipFacts {
            owner: Some(user("u1")),
        };
        let ComputerAccess::Held(access) = can_access_computer(&user("u1"), Some(&ownership))
        else {
            panic!("expected the owner to be admitted");
        };
        let ComputerLifecycle::Held(lifecycle) = hold_computer_lifecycle(
            access,
            ComputerTeardownFacts {
                id: host(),
                kind: HostKind::Remote,
                provisioning_source: ProvisioningSource::UserInvite,
            },
        ) else {
            panic!("expected a user-managed computer to be admitted");
        };
        let CascadeAdmission::Admitted(admitted) =
            admit_cascade(lifecycle, agents, CascadeConsent::Confirmed)
        else {
            panic!("expected the cascade to be admitted");
        };
        admitted
    }

    #[test]
    fn a_committed_teardown_describes_the_row_the_rule_admitted() {
        let torn = torn_down("a1");
        assert_eq!(torn.facts().id.as_str(), "a1");
        assert_eq!(torn.capture().dm_blob_refs[0].storage_key, "a1");
        let (facts, capture) = torn.into_parts();
        assert_eq!(facts.id.as_str(), "a1");
        assert_eq!(capture.dm_blob_refs.len(), 1);
    }

    #[test]
    fn the_fan_out_set_is_every_row_the_cascade_deleted() {
        let cascade = ComputerCascade::new(
            admitted(vec![
                facts("a1", MaterializationStatus::Failed),
                facts("a2", MaterializationStatus::Active),
                facts("a3", MaterializationStatus::Active),
            ]),
            vec![torn_down("a2"), torn_down("a3")],
        );
        assert_eq!(
            cascade
                .deleted_agents()
                .map(|agent| agent.id.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec!["a1", "a2", "a3"]
        );
        assert_eq!(cascade.owner(), &user("u1"));
        assert_eq!(cascade.computer(), &host());
    }

    #[test]
    fn the_row_only_half_comes_from_the_admission_and_not_from_the_caller() {
        // Every failed row in the admitted set is reported, and a caller has no way
        // to add one that was never judged or to omit one that was.
        let cascade = ComputerCascade::new(
            admitted(vec![
                facts("a1", MaterializationStatus::Failed),
                facts("a2", MaterializationStatus::Failed),
            ]),
            Vec::new(),
        );
        assert_eq!(
            cascade
                .row_only()
                .iter()
                .map(|agent| agent.id.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec!["a1", "a2"]
        );
        assert!(cascade.torn_down().is_empty());
    }

    #[test]
    fn a_cascade_that_deleted_only_the_computer_names_no_agent() {
        let cascade = ComputerCascade::new(admitted(Vec::new()), Vec::new());
        assert_eq!(cascade.deleted_agents().count(), 0);
    }
}
