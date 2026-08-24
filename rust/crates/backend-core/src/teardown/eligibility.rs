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
    /// The destructive branch, which has already destroyed this computer's
    /// host-local tree.
    Purged { host_id: HostId },
}

impl AgentTeardownEligibility {
    /// The stage this request decided its sequence for.
    pub fn expected_status(&self) -> MaterializationStatus {
        match self {
            Self::RowOnly => MaterializationStatus::Failed,
            Self::Purged { .. } => MaterializationStatus::Active,
        }
    }

    /// The computer whose tree is already gone, when there is one.
    pub fn purged_host(&self) -> Option<&HostId> {
        match self {
            Self::RowOnly => None,
            Self::Purged { host_id } => Some(host_id),
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

/// Whether the facts read under the lock still match what the caller acted on.
///
/// Deliberately not conditioned on whether anything moves placement today: the
/// contract is owed to every engine and every future placement writer, and a
/// guarantee that rests on the absence of a writer documents nothing.
pub fn eligibility_moved(
    expected: &AgentTeardownEligibility,
    facts: &AgentTeardownFacts,
) -> Option<EligibilityMoved> {
    if facts.materialization_status != expected.expected_status() {
        return Some(EligibilityMoved::Materialization);
    }
    match expected.purged_host() {
        Some(purged) if facts.host_id != *purged => Some(EligibilityMoved::Placement),
        _ => None,
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

    #[test]
    fn an_unmoved_row_is_still_the_row_the_decision_was_made_for() {
        assert_eq!(
            eligibility_moved(
                &AgentTeardownEligibility::Purged {
                    host_id: host("h1")
                },
                &facts(MaterializationStatus::Active, "h1")
            ),
            None
        );
        assert_eq!(
            eligibility_moved(
                &AgentTeardownEligibility::RowOnly,
                &facts(MaterializationStatus::Failed, "h1")
            ),
            None
        );
    }

    #[test]
    fn a_stage_that_moved_is_named_before_anything_else_is_compared() {
        // This request purged h1 for an active row; since then the row failed
        // re-materialization AND moved to h2, so both facts moved. The stage is
        // what invalidated the whole sequence — reporting placement would tell
        // the operator to look at a computer while the real event was a
        // provisioning transition — so the stage is the one reported.
        assert_eq!(
            eligibility_moved(
                &AgentTeardownEligibility::Purged {
                    host_id: host("h1")
                },
                &facts(MaterializationStatus::Failed, "h2")
            ),
            Some(EligibilityMoved::Materialization)
        );
        assert_eq!(
            eligibility_moved(
                &AgentTeardownEligibility::RowOnly,
                &facts(MaterializationStatus::Active, "h2")
            ),
            Some(EligibilityMoved::Materialization)
        );
    }

    #[test]
    fn a_row_that_moved_computer_is_refused_even_at_the_right_stage() {
        assert_eq!(
            eligibility_moved(
                &AgentTeardownEligibility::Purged {
                    host_id: host("h1")
                },
                &facts(MaterializationStatus::Active, "h2")
            ),
            Some(EligibilityMoved::Placement)
        );
    }

    #[test]
    fn the_row_only_branch_never_compares_placement() {
        // No purge was dispatched, so no computer is wrong for it. A row-only
        // teardown of a row that moved computer is still eligible.
        assert_eq!(
            eligibility_moved(
                &AgentTeardownEligibility::RowOnly,
                &facts(MaterializationStatus::Failed, "somewhere-else")
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
            AgentTeardownEligibility::Purged {
                host_id: host("h1")
            }
            .expected_status(),
            MaterializationStatus::Active
        );
        assert_eq!(AgentTeardownEligibility::RowOnly.purged_host(), None);
    }
}
