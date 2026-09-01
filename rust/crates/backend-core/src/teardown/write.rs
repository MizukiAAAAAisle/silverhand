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
//! they judged, so the row a committed outcome reports as deleted is the row a rule
//! admitted. An implementation that re-stated a comparison inline has nothing to
//! return.
//!
//! A witness is not enough on its own, because a committed outcome carries MORE than
//! the judged row: the post-commit capture describes an agent, and a cascade reports
//! a set of teardowns. Each is a second channel that can name something else, so
//! both outcome types are built through a FALLIBLE seal that binds every channel to
//! the request's own coordinates — [`AgentTornDown::seal`] and
//! [`ComputerCascade::seal`]. A mismatch there is an internal contract failure
//! ([`crate::teardown::contract`]), never a product refusal: a caller cannot cause
//! it and has nothing to do about it.
//!
//! For the computer axis the witness chain also fixes the ORDER: the cascade
//! admission requires the lifecycle witness, which requires the access witness, so
//! "is it theirs, then may its lifecycle end, then does its dependency set admit
//! this" cannot be asked out of order or skipped — and each link checks that it is
//! about the same computer as the last, so three answers in sequence cannot be three
//! answers about three computers.
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
    foundation::identity::{AgentId, HostId, UserId},
    teardown::{
        cascade::{CascadeAdmitted, CascadeConsent, CascadeRefused, ComputerLifecycleHeld},
        contract::{TeardownContractViolation, TeardownFailure, same_agent, same_computer},
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
/// The facts are read out of the witness rather than stored beside it, so the row
/// this reports as deleted is the row the rule admitted. Both axes produce this
/// type — the single-agent delete and each full cascade inside a computer teardown —
/// because both owe exactly this pair.
///
/// The capture is a SECOND channel that describes an agent: its blob refs drive a
/// sweep and its seats drive runtime stops, so a capture taken for another agent
/// would stop a live child and delete bytes belonging to a row this teardown never
/// touched. [`Self::seal`] is what makes the pair one agent's.
///
/// ```compile_fail
/// use silverhand_backend_core::teardown::write::AgentTornDown;
/// // Assembled from parts, this would report a teardown no rule admitted.
/// let _: AgentTornDown = AgentTornDown {
///     held: unimplemented!(),
///     capture: unimplemented!(),
/// };
/// ```
///
/// The control for that gate — same path, same name, sealed the only way it can be:
///
/// ```
/// use silverhand_backend_core::{
///     identity_access::agent_lifecycle::MaterializationStatus,
///     foundation::identity::{AgentId, HostId},
///     teardown::{
///         eligibility::{AgentTeardownEligibility, EligibilityVerdict, hold_eligibility},
///         facts::{AgentTeardownCapture, AgentTeardownFacts},
///         write::AgentTornDown,
///     },
/// };
/// let agent_id = AgentId::parse("a1").unwrap();
/// let host_id = HostId::parse("h1").unwrap();
/// let EligibilityVerdict::Held(held) = hold_eligibility(
///     &AgentTeardownEligibility::ActiveOn { host_id: host_id.clone() },
///     AgentTeardownFacts {
///         id: agent_id.clone(),
///         name: "a1".into(),
///         display_name: "a1".into(),
///         runtime: "claude".into(),
///         host_id,
///         materialization_status: MaterializationStatus::Active,
///         failed_code: None,
///         deletion_started_at: None,
///     },
/// ) else {
///     panic!("an unmoved active row is admitted");
/// };
/// let capture = AgentTeardownCapture {
///     agent_id: agent_id.clone(),
///     runtime_sessions: Vec::new(),
///     dm_blob_refs: Vec::new(),
///     dm_channel_id: None,
///     regular_workspace_count: 0,
/// };
/// let torn: AgentTornDown = AgentTornDown::seal(&agent_id, held, capture).expect("one agent");
/// assert_eq!(torn.facts().id, agent_id);
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTornDown {
    held: EligibilityHeld,
    capture: AgentTeardownCapture,
}

impl AgentTornDown {
    /// Seal a committed teardown around the request's own agent id.
    ///
    /// Both channels are checked against `requested` rather than against each
    /// other: agreeing with each other about a THIRD agent is a splice too, and the
    /// only coordinate with authority is the one the request named.
    ///
    /// Every captured seat is checked as well, and not because a scope is a fact
    /// this module reads — it is forwarded to a stop — but because forwarding is
    /// exactly the harm: a seat belonging to another agent, stopped here, kills a
    /// live child of a row nothing admitted.
    pub fn seal(
        requested: &AgentId,
        held: EligibilityHeld,
        capture: AgentTeardownCapture,
    ) -> Result<Self, TeardownContractViolation> {
        same_agent(requested, &held.facts().id)?;
        same_agent(requested, &capture.agent_id)?;
        for session in &capture.runtime_sessions {
            same_agent(requested, session.scope.agent())?;
        }
        Ok(Self { held, capture })
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
///
/// ```compile_fail
/// use silverhand_backend_core::teardown::write::ComputerCascade;
/// // Assembled from parts, this would report a fan-out no rule judged.
/// let _: ComputerCascade = ComputerCascade {
///     lifecycle: unimplemented!(),
///     row_only: unimplemented!(),
///     torn_down: unimplemented!(),
/// };
/// ```
///
/// The control for that gate — same path, same name, sealed the only way it can be:
///
/// ```
/// use silverhand_backend_core::{
///     identity_access::capability::computer_access::{ComputerAccess, ComputerOwnershipFacts, can_access_computer},
///     host_runtime::computer::{HostKind, ProvisioningSource},
///     foundation::identity::{HostId, UserId},
///     teardown::{
///         cascade::{CascadeAdmission, CascadeConsent, ComputerLifecycle, admit_cascade, hold_computer_lifecycle},
///         facts::ComputerTeardownFacts,
///         write::{ComputerCascade, ComputerTeardownKey},
///     },
/// };
/// let user_id = UserId::parse("u1").unwrap();
/// let host_id = HostId::parse("h1").unwrap();
/// let ComputerAccess::Held(access) = can_access_computer(
///     &user_id,
///     Some(&ComputerOwnershipFacts { id: host_id.clone(), owner: Some(user_id.clone()) }),
/// ) else {
///     panic!("the owner is admitted");
/// };
/// let ComputerLifecycle::Held(lifecycle) = hold_computer_lifecycle(
///     access,
///     ComputerTeardownFacts {
///         id: host_id.clone(),
///         kind: HostKind::Remote,
///         provisioning_source: ProvisioningSource::UserInvite,
///     },
/// )
/// .expect("one computer")
/// else {
///     panic!("an invited remote is user-managed");
/// };
/// let CascadeAdmission::Admitted(admitted) =
///     admit_cascade(lifecycle, Vec::new(), CascadeConsent::Absent).expect("one computer")
/// else {
///     panic!("a computer with no dependents needs no confirmation");
/// };
/// let key = ComputerTeardownKey { host_id, user_id };
/// let cascade: ComputerCascade =
///     ComputerCascade::seal(&key, admitted, Vec::new()).expect("one cascade");
/// assert_eq!(cascade.deleted_agents().count(), 0);
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerCascade {
    lifecycle: ComputerLifecycleHeld,
    row_only: Vec<AgentTeardownFacts>,
    torn_down: Vec<AgentTornDown>,
}

impl ComputerCascade {
    /// Seal a committed cascade around the key the write ran for.
    ///
    /// Three separate questions, and none of them is answerable by the caller:
    ///
    ///  - the admission must be the one for THIS key — same computer, same
    ///    requester. Otherwise a cascade authorized elsewhere is reported here, and
    ///    the fan-out goes to the wrong owner's scope;
    ///  - every reported teardown must be on that computer, because this cascade's
    ///    claim is that it destroyed what was rooted there;
    ///  - the reported full teardowns must be EXACTLY the admitted full set. Missing
    ///    one silently drops its post-commit work — a live child never stopped, blobs
    ///    never swept — while an extra or a repeat runs that work for a row this
    ///    cascade did not delete, or twice.
    ///
    /// The row-only half is DERIVED from the admission rather than accepted at all:
    /// the half of a cascade that has no post-commit work of its own is the easiest
    /// to misreport, and nothing outside this type gets to name it.
    pub fn seal(
        key: &ComputerTeardownKey,
        admitted: CascadeAdmitted,
        torn_down: Vec<AgentTornDown>,
    ) -> Result<Self, TeardownContractViolation> {
        let lifecycle = admitted.lifecycle();
        same_computer(&key.host_id, &lifecycle.computer().id)?;
        if key.user_id != *lifecycle.owner() {
            return Err(TeardownContractViolation::RequesterMismatch {
                expected: key.user_id.clone(),
                found: lifecycle.owner().clone(),
            });
        }
        for torn in &torn_down {
            same_computer(&key.host_id, &torn.facts().host_id)?;
        }
        let expected = sorted_ids(admitted.full_teardowns().iter().map(|agent| &agent.id));
        let reported = sorted_ids(torn_down.iter().map(|torn| &torn.facts().id));
        if expected != reported {
            return Err(TeardownContractViolation::DependentSetMismatch {
                admitted: expected,
                reported,
            });
        }
        Ok(Self {
            row_only: admitted.row_only(),
            lifecycle: admitted.into_lifecycle(),
            torn_down,
        })
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

/// Sorted so that comparing two of these compares MULTISETS: order carries no
/// meaning here, but a repeat does, and sorting keeps a duplicate from cancelling
/// out against an omission.
fn sorted_ids<'a>(ids: impl Iterator<Item = &'a AgentId>) -> Vec<AgentId> {
    let mut ids: Vec<AgentId> = ids.cloned().collect();
    ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
    ids
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
///
/// Both methods fail with [`TeardownFailure`] rather than a persistence error alone,
/// because sealing the outcome is part of implementing them: an implementation whose
/// report does not describe one aggregate must surface that as the defect it is,
/// where no operator is sent to look at a driver for it.
pub trait AgentTeardownUnitOfWork: Clone + Send + Sync + 'static {
    /// Re-read the agent's eligibility under the mechanism, capture the
    /// post-commit work, and delete the row. `expected` is what the caller's
    /// pre-lock phase ALREADY ACTED ON; re-reading it here is what makes having
    /// taken those decisions outside the lock safe.
    fn tear_down_agent(
        &self,
        key: AgentTeardownKey,
        expected: AgentTeardownEligibility,
    ) -> impl Future<Output = Result<AgentTeardownCommit, TeardownFailure>> + Send;

    /// Take the two narrow projections under the mechanism, pass the access witness
    /// through the lifecycle rule and the dependency set through the cascade rule,
    /// capture, then delete the agent rows and the computer row as one unit.
    fn cascade_computer(
        &self,
        key: ComputerTeardownKey,
        consent: CascadeConsent,
    ) -> impl Future<Output = Result<ComputerCascadeCommit, TeardownFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        host_runtime::computer::{HostKind, ProvisioningSource},
        host_runtime::runtime_credential::{RuntimeGeneration, RuntimeScope},
        host_runtime::runtime_event::RuntimeObservedStatus,
        identity_access::agent_lifecycle::MaterializationStatus,
        identity_access::capability::computer_access::{
            ComputerAccess, ComputerOwnershipFacts, can_access_computer,
        },
        teardown::{
            cascade::{
                CascadeAdmission, ComputerLifecycle, admit_cascade, hold_computer_lifecycle,
            },
            eligibility::{EligibilityVerdict, hold_eligibility},
            facts::{AgentRuntimeSessionFacts, ComputerTeardownFacts, StoredBlobRef},
        },
    };

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn facts_on(id: &str, host_id: &str, status: MaterializationStatus) -> AgentTeardownFacts {
        AgentTeardownFacts {
            id: agent(id),
            name: id.into(),
            display_name: id.into(),
            runtime: "claude".into(),
            host_id: host(host_id),
            materialization_status: status,
            failed_code: None,
            deletion_started_at: None,
        }
    }

    fn facts(id: &str, status: MaterializationStatus) -> AgentTeardownFacts {
        facts_on(id, "h1", status)
    }

    fn capture(id: &str) -> AgentTeardownCapture {
        AgentTeardownCapture {
            agent_id: agent(id),
            runtime_sessions: Vec::new(),
            dm_blob_refs: vec![StoredBlobRef {
                storage: "blob".into(),
                storage_key: id.into(),
            }],
            dm_channel_id: None,
            regular_workspace_count: 0,
        }
    }

    fn seat(agent_id: &str) -> AgentRuntimeSessionFacts {
        AgentRuntimeSessionFacts {
            scope: RuntimeScope::AgentSlot {
                agent: agent(agent_id),
            },
            status: RuntimeObservedStatus::Active,
            generation: RuntimeGeneration::new(1).expect("generation"),
        }
    }

    /// Obtained the way production obtains it: from the rule, under the eligibility
    /// the cascade key names. Nothing here can assemble one.
    fn held(id: &str, host_id: &str) -> EligibilityHeld {
        let expected = AgentTeardownEligibility::ActiveOn {
            host_id: host(host_id),
        };
        let EligibilityVerdict::Held(held) = hold_eligibility(
            &expected,
            facts_on(id, host_id, MaterializationStatus::Active),
        ) else {
            panic!("expected the rule to admit");
        };
        held
    }

    fn torn_down_on(id: &str, host_id: &str) -> AgentTornDown {
        AgentTornDown::seal(&agent(id), held(id, host_id), capture(id)).expect("one agent")
    }

    fn torn_down(id: &str) -> AgentTornDown {
        torn_down_on(id, "h1")
    }

    fn admitted(agents: Vec<AgentTeardownFacts>) -> CascadeAdmitted {
        let ownership = ComputerOwnershipFacts {
            id: host("h1"),
            owner: Some(user("u1")),
        };
        let ComputerAccess::Held(access) = can_access_computer(&user("u1"), Some(&ownership))
        else {
            panic!("expected the owner to be admitted");
        };
        let ComputerLifecycle::Held(lifecycle) = hold_computer_lifecycle(
            access,
            ComputerTeardownFacts {
                id: host("h1"),
                kind: HostKind::Remote,
                provisioning_source: ProvisioningSource::UserInvite,
            },
        )
        .expect("one computer") else {
            panic!("expected a user-managed computer to be admitted");
        };
        let CascadeAdmission::Admitted(admitted) =
            admit_cascade(lifecycle, agents, CascadeConsent::Confirmed).expect("one computer")
        else {
            panic!("expected the cascade to be admitted");
        };
        admitted
    }

    fn key(host_id: &str, user_id: &str) -> ComputerTeardownKey {
        ComputerTeardownKey {
            host_id: host(host_id),
            user_id: user(user_id),
        }
    }

    fn cascade(
        admitted: CascadeAdmitted,
        torn_down: Vec<AgentTornDown>,
    ) -> Result<ComputerCascade, TeardownContractViolation> {
        ComputerCascade::seal(&key("h1", "u1"), admitted, torn_down)
    }

    fn set_mismatch(admitted: &[&str], reported: &[&str]) -> TeardownContractViolation {
        TeardownContractViolation::DependentSetMismatch {
            admitted: admitted.iter().map(|id| agent(id)).collect(),
            reported: reported.iter().map(|id| agent(id)).collect(),
        }
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
    fn a_capture_taken_for_another_agent_cannot_be_sealed_in() {
        // Both halves are well formed on their own; composed, the sweep would
        // delete a2's blobs while reporting a1's teardown.
        assert_eq!(
            AgentTornDown::seal(&agent("a1"), held("a1", "h1"), capture("a2")),
            Err(TeardownContractViolation::AgentMismatch {
                expected: agent("a1"),
                found: agent("a2"),
            })
        );
    }

    #[test]
    fn a_captured_seat_belonging_to_another_agent_cannot_be_sealed_in() {
        // This one is not about what the report says: the seat is forwarded to a
        // stop, so sealing it in would kill a live child of a row nothing admitted.
        let mut capture = capture("a1");
        capture.runtime_sessions = vec![seat("a1"), seat("a2")];
        assert_eq!(
            AgentTornDown::seal(&agent("a1"), held("a1", "h1"), capture),
            Err(TeardownContractViolation::AgentMismatch {
                expected: agent("a1"),
                found: agent("a2"),
            })
        );
    }

    #[test]
    fn a_witness_for_another_agent_is_not_this_requests_teardown() {
        // Checked against the request rather than against the capture: two channels
        // agreeing with each other about a third agent is a splice too.
        assert_eq!(
            AgentTornDown::seal(&agent("a1"), held("a2", "h1"), capture("a2")),
            Err(TeardownContractViolation::AgentMismatch {
                expected: agent("a1"),
                found: agent("a2"),
            })
        );
    }

    #[test]
    fn the_fan_out_set_is_every_row_the_cascade_deleted() {
        let cascade = cascade(
            admitted(vec![
                facts("a1", MaterializationStatus::Failed),
                facts("a2", MaterializationStatus::Active),
                facts("a3", MaterializationStatus::Active),
            ]),
            vec![torn_down("a2"), torn_down("a3")],
        )
        .expect("one cascade");
        assert_eq!(
            cascade
                .deleted_agents()
                .map(|agent| agent.id.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec!["a1", "a2", "a3"]
        );
        assert_eq!(cascade.owner(), &user("u1"));
        assert_eq!(cascade.computer(), &host("h1"));
    }

    #[test]
    fn the_row_only_half_comes_from_the_admission_and_not_from_the_caller() {
        // Every failed row in the admitted set is reported, and a caller has no way
        // to add one that was never judged or to omit one that was.
        let cascade = cascade(
            admitted(vec![
                facts("a1", MaterializationStatus::Failed),
                facts("a2", MaterializationStatus::Failed),
            ]),
            Vec::new(),
        )
        .expect("one cascade");
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
        let cascade = cascade(admitted(Vec::new()), Vec::new()).expect("one cascade");
        assert_eq!(cascade.deleted_agents().count(), 0);
    }

    #[test]
    fn a_missing_full_teardown_is_not_a_committed_cascade() {
        // Silently dropping it would leave a2's child running and its blobs
        // unswept, with no row left to discover either from.
        assert_eq!(
            cascade(
                admitted(vec![
                    facts("a1", MaterializationStatus::Active),
                    facts("a2", MaterializationStatus::Active),
                ]),
                vec![torn_down("a1")],
            ),
            Err(set_mismatch(&["a1", "a2"], &["a1"]))
        );
    }

    #[test]
    fn a_teardown_that_was_never_admitted_cannot_be_reported() {
        assert_eq!(
            cascade(
                admitted(vec![facts("a1", MaterializationStatus::Active)]),
                vec![torn_down("a1"), torn_down("a2")],
            ),
            Err(set_mismatch(&["a1"], &["a1", "a2"]))
        );
    }

    #[test]
    fn a_full_teardown_reported_twice_is_not_a_committed_cascade() {
        // Its post-commit work would run twice, and a count of reports would agree
        // with a count of admissions while describing two different things.
        assert_eq!(
            cascade(
                admitted(vec![
                    facts("a1", MaterializationStatus::Active),
                    facts("a2", MaterializationStatus::Active),
                ]),
                vec![torn_down("a1"), torn_down("a1")],
            ),
            Err(set_mismatch(&["a1", "a2"], &["a1", "a1"]))
        );
    }

    #[test]
    fn a_reported_teardown_placed_on_another_computer_is_not_this_cascades() {
        // The id set matches exactly, so only the placement check catches this: a
        // witness admitted for a1 on h2 is not the a1 this cascade destroyed.
        assert_eq!(
            cascade(
                admitted(vec![facts("a1", MaterializationStatus::Active)]),
                vec![torn_down_on("a1", "h2")],
            ),
            Err(TeardownContractViolation::ComputerMismatch {
                expected: host("h1"),
                found: host("h2"),
            })
        );
    }

    #[test]
    fn a_cascade_cannot_be_reported_under_another_computers_key() {
        assert_eq!(
            ComputerCascade::seal(&key("h2", "u1"), admitted(Vec::new()), Vec::new()),
            Err(TeardownContractViolation::ComputerMismatch {
                expected: host("h2"),
                found: host("h1"),
            })
        );
    }

    #[test]
    fn a_cascade_cannot_be_reported_for_another_requester() {
        // The owner drives the whole post-commit fan-out, so this would announce
        // one user's deletions on another user's scope.
        assert_eq!(
            ComputerCascade::seal(&key("h1", "u2"), admitted(Vec::new()), Vec::new()),
            Err(TeardownContractViolation::RequesterMismatch {
                expected: user("u2"),
                found: user("u1"),
            })
        );
    }
}
