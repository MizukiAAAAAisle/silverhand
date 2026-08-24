//! What the pre-lock phase already acted on, re-checked under the write lock.
//!
//! Not "this looked true a moment ago" but "this request has ALREADY done
//! something irreversible for this fact": the stage chose the sequence, and a
//! purge names the computer whose host-local tree was already destroyed. Both
//! cascades read facts before their write — one purges host-local files, which
//! must not run inside the lock, and one answers a refusal without taking a
//! write lock to say no — so those pre-lock reads are HINTS, and this is the rule
//! that makes having taken them safe.

use crate::{
    agent_lifecycle::MaterializationStatus, identity::HostId, teardown::facts::AgentTeardownFacts,
};

/// What teardown a row's CURRENT stage owes.
///
/// One total rule, consumed by both axes: the single-agent path dispatches on it
/// before it takes any lock, and the computer cascade classifies each of its
/// agents with it under the lock. A new materialization stage therefore states its
/// teardown obligation once, here, instead of being silently admitted by whichever
/// axis happens not to mention it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeardownBranch {
    /// Nothing may be torn down: a reserve → flip transaction is in flight and a
    /// teardown would race it.
    Refused,
    /// Delete the row and stop. A failed row has no dependents, no runtime child
    /// and no host-local tree.
    RowOnly,
    /// The full destructive sequence: stop the children, purge the host-local
    /// tree, cascade the rows.
    Full,
}

/// The branch a stage owes. Exhaustive by construction.
pub fn teardown_branch(status: MaterializationStatus) -> TeardownBranch {
    match status {
        MaterializationStatus::PendingMaterialization => TeardownBranch::Refused,
        MaterializationStatus::Failed => TeardownBranch::RowOnly,
        MaterializationStatus::Active => TeardownBranch::Full,
    }
}

/// What the caller already did, in the only two shapes that exist.
///
/// A closed sum rather than a stage plus an optional host, so the two unsound
/// combinations are not expressible: an active graph deleted with NO host-local
/// purge and no placement re-check, and a row-only delete claiming a purge it
/// never dispatched. `PendingMaterialization` is absent entirely — a
/// materialization in flight is refused before any of this, so "commit a pending
/// teardown" is not a request this rule can be handed.
///
/// Adding a third eligible stage therefore means adding an arm here, where its
/// host-local obligation has to be stated.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentTeardownEligibility {
    /// The row-only branch: no runtime stops, no purge, nothing routed — so
    /// placement cannot be wrong and is not part of the eligibility.
    RowOnly,
    /// Active, and on this computer. Both axes owe the placement comparison, for
    /// two different reasons: the single-agent path has ALREADY destroyed that
    /// computer's host-local tree before taking the lock, and the computer
    /// cascade's whole dependency set is keyed on that computer. The arm names the
    /// comparison rather than either reason, so neither axis has to pretend it is
    /// the other.
    ActiveOn { host_id: HostId },
}

impl AgentTeardownEligibility {
    /// The stage this request decided its sequence for.
    pub fn expected_status(&self) -> MaterializationStatus {
        match self {
            Self::RowOnly => MaterializationStatus::Failed,
            Self::ActiveOn { .. } => MaterializationStatus::Active,
        }
    }

    /// The computer the row must still be on, when placement is part of the
    /// eligibility at all.
    pub fn expected_host(&self) -> Option<&HostId> {
        match self {
            Self::RowOnly => None,
            Self::ActiveOn { host_id } => Some(host_id),
        }
    }
}

/// Which fact moved since the pre-lock phase acted on it. Both are "nothing
/// happened, re-read and retry" outcomes for the caller; they differ in what the
/// operator needs to see.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EligibilityMoved {
    /// The row left the stage this sequence was chosen for, or arrived at it from
    /// another — so a provisioning transition has run since.
    Materialization,
    /// The row is placed on a computer this request never purged. Deleting it
    /// would leave its CURRENT computer holding the files with no row left to
    /// retry from.
    Placement,
}

/// Proof that THIS rule judged THESE facts and admitted the write.
///
/// The witness has no public constructor, and it OWNS the facts it was minted
/// from — the write boundary reads them back out of it rather than keeping its own
/// copy. Two things follow, and only these two:
///
///  - an implementation cannot report a committed teardown from a comparison it
///    re-stated itself, because the outcome type it must return can only be built
///    around a witness (see [`crate::teardown::write::AgentTornDown`]);
///  - the facts a committed teardown reports as the row it deleted are the facts
///    this rule judged, because it has no copy of its own to report instead.
///
/// It does NOT by itself make a committed outcome single-channel. The post-commit
/// capture is a second channel that describes a row, and binding it to this witness
/// is [`crate::teardown::write::AgentTornDown::seal`]'s job, not this type's.
///
/// It also does not prove the facts handed in were read under the mechanism, or
/// read unfiltered. A witness minted from fabricated facts is a well-formed
/// witness. That residual is the differential persistence contract's, which must
/// include a fact-filtering case and an in-transaction-versus-pre-read case, because
/// an implementation that filters facts can still answer correctly for the cases a
/// naive suite happens to try.
///
/// ```compile_fail
/// use silverhand_backend_core::teardown::eligibility::EligibilityHeld;
/// // Assembled from parts, this would admit a write no rule judged.
/// let _: EligibilityHeld = EligibilityHeld { facts: unimplemented!() };
/// ```
///
/// The control for that gate — same path, same name, minted the only way it can be.
/// A `compile_fail` block passes on any error, including a stale path, so the gate
/// above is only worth something next to this.
///
/// ```
/// use silverhand_backend_core::{
///     agent_lifecycle::MaterializationStatus,
///     identity::{AgentId, HostId},
///     teardown::{
///         eligibility::{
///             AgentTeardownEligibility, EligibilityHeld, EligibilityVerdict, hold_eligibility,
///         },
///         facts::AgentTeardownFacts,
///     },
/// };
/// let host_id = HostId::parse("h1").unwrap();
/// let facts = AgentTeardownFacts {
///     id: AgentId::parse("a1").unwrap(),
///     name: "a1".into(),
///     display_name: "a1".into(),
///     runtime: "claude".into(),
///     host_id: host_id.clone(),
///     materialization_status: MaterializationStatus::Active,
///     failed_code: None,
///     deletion_started_at: None,
/// };
/// let EligibilityVerdict::Held(held) =
///     hold_eligibility(&AgentTeardownEligibility::ActiveOn { host_id }, facts)
/// else {
///     panic!("an unmoved active row is admitted");
/// };
/// let held: EligibilityHeld = held;
/// assert_eq!(held.facts().id.as_str(), "a1");
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EligibilityHeld {
    facts: AgentTeardownFacts,
}

impl EligibilityHeld {
    /// The facts as judged. The only facts a committed outcome may describe.
    pub fn facts(&self) -> &AgentTeardownFacts {
        &self.facts
    }

    pub fn into_facts(self) -> AgentTeardownFacts {
        self.facts
    }
}

/// The rule's verdict: admitted with a witness, or the fact that moved.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EligibilityVerdict {
    Held(EligibilityHeld),
    Moved(EligibilityMoved),
}

/// Judge the facts read under the mechanism against what the caller acted on.
///
/// Deliberately not conditioned on whether anything moves placement today: the
/// contract is owed to every engine and every future placement writer, and a
/// guarantee that rests on the absence of a writer documents nothing.
///
/// The facts are taken BY VALUE so the admitted verdict can own them: an
/// implementation that kept its own copy and passed a different one onward cannot
/// report it AS the judged row, because the outcome reads that row out of the
/// witness. Other channels a committed outcome carries are bound where they are
/// composed, not here.
pub fn hold_eligibility(
    expected: &AgentTeardownEligibility,
    facts: AgentTeardownFacts,
) -> EligibilityVerdict {
    if facts.materialization_status != expected.expected_status() {
        return EligibilityVerdict::Moved(EligibilityMoved::Materialization);
    }
    match expected.expected_host() {
        Some(host_id) if facts.host_id != *host_id => {
            EligibilityVerdict::Moved(EligibilityMoved::Placement)
        }
        _ => EligibilityVerdict::Held(EligibilityHeld { facts }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::AgentId;

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn facts(status: MaterializationStatus, host_id: &str) -> AgentTeardownFacts {
        AgentTeardownFacts {
            id: AgentId::parse("a1").expect("agent id"),
            name: "agent".into(),
            display_name: "Agent".into(),
            runtime: "claude".into(),
            host_id: host(host_id),
            materialization_status: status,
            failed_code: None,
            deletion_started_at: None,
        }
    }

    fn moved(
        expected: &AgentTeardownEligibility,
        status: MaterializationStatus,
        host_id: &str,
    ) -> Option<EligibilityMoved> {
        match hold_eligibility(expected, facts(status, host_id)) {
            EligibilityVerdict::Held(_) => None,
            EligibilityVerdict::Moved(moved) => Some(moved),
        }
    }

    fn active_on(host_id: &str) -> AgentTeardownEligibility {
        AgentTeardownEligibility::ActiveOn {
            host_id: host(host_id),
        }
    }

    #[test]
    fn every_stage_states_the_teardown_it_owes() {
        assert_eq!(
            teardown_branch(MaterializationStatus::PendingMaterialization),
            TeardownBranch::Refused
        );
        assert_eq!(
            teardown_branch(MaterializationStatus::Failed),
            TeardownBranch::RowOnly
        );
        assert_eq!(
            teardown_branch(MaterializationStatus::Active),
            TeardownBranch::Full
        );
    }

    #[test]
    fn an_unmoved_row_is_still_the_row_the_decision_was_made_for() {
        assert_eq!(
            moved(&active_on("h1"), MaterializationStatus::Active, "h1"),
            None
        );
        assert_eq!(
            moved(
                &AgentTeardownEligibility::RowOnly,
                MaterializationStatus::Failed,
                "h1"
            ),
            None
        );
    }

    #[test]
    fn the_witness_carries_the_very_facts_that_were_judged() {
        // The write boundary reads the judged row back out of the witness rather
        // than keeping a copy, so a witness that described some other row would be
        // a committed teardown of a row nothing admitted.
        let judged = facts(MaterializationStatus::Active, "h1");
        let EligibilityVerdict::Held(held) = hold_eligibility(&active_on("h1"), judged.clone())
        else {
            panic!("expected the rule to admit");
        };
        assert_eq!(held.facts(), &judged);
        assert_eq!(held.into_facts(), judged);
    }

    #[test]
    fn a_stage_that_moved_is_named_before_anything_else_is_compared() {
        // This request purged h1 for an active row; since then the row failed
        // re-materialization AND moved to h2, so both facts moved. The stage is
        // what invalidated the whole sequence — reporting placement would tell
        // the operator to look at a computer while the real event was a
        // provisioning transition — so the stage is the one reported.
        assert_eq!(
            moved(&active_on("h1"), MaterializationStatus::Failed, "h2"),
            Some(EligibilityMoved::Materialization)
        );
        assert_eq!(
            moved(
                &AgentTeardownEligibility::RowOnly,
                MaterializationStatus::Active,
                "h2"
            ),
            Some(EligibilityMoved::Materialization)
        );
    }

    #[test]
    fn a_row_that_moved_computer_is_refused_even_at_the_right_stage() {
        assert_eq!(
            moved(&active_on("h1"), MaterializationStatus::Active, "h2"),
            Some(EligibilityMoved::Placement)
        );
    }

    #[test]
    fn the_row_only_branch_never_compares_placement() {
        // No purge was dispatched, so no computer is wrong for it. A row-only
        // teardown of a row that moved computer is still eligible.
        assert_eq!(
            moved(
                &AgentTeardownEligibility::RowOnly,
                MaterializationStatus::Failed,
                "somewhere-else"
            ),
            None
        );
    }

    #[test]
    fn each_arm_states_the_stage_it_was_chosen_for() {
        assert_eq!(
            AgentTeardownEligibility::RowOnly.expected_status(),
            MaterializationStatus::Failed
        );
        assert_eq!(
            active_on("h1").expected_status(),
            MaterializationStatus::Active
        );
        assert_eq!(AgentTeardownEligibility::RowOnly.expected_host(), None);
    }
}
