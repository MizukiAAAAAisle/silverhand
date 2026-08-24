//! Deleting a computer, and with it everything rooted on that computer.
//!
//! Two rules live here, and they are deliberately at different depths:
//!
//!  - [`computer_lifecycle_refusal`] is a PRE-FLIGHT question — is this computer's
//!    lifecycle the user's to end at all — answerable without taking a write lock,
//!    because saying "not user-managed" needs no coordination. The conditional row
//!    delete re-states the same condition in its own `WHERE`, so this answering
//!    early is an optimization, not the guarantee.
//!  - [`cascade_refusal`] is the IN-LOCK question, decided from the authoritative
//!    dependency set. Every refusal it produces rolls the whole scope back, which
//!    is what makes "non-2xx means nothing happened — including bytes" true: the
//!    commit is the single decision point, and every unrollbackable effect (runtime
//!    stops, the host-local purge, the blob sweep) runs after it.
//!
//! A regular workspace is NOT rooted on a computer, so this cascade can never
//! reach one. Its member agents placed here are deleted, which is the same outcome
//! as deleting those agents individually.

use crate::{
    identity::UserId,
    teardown::{
        eligibility::{TeardownBranch, teardown_branch},
        facts::{AgentTeardownFacts, ComputerTeardownFacts, HostKind, ProvisioningSource},
    },
};

/// "Delete this computer and everything on it."
///
/// Consent, and NOT authorization: it is not an id snapshot either. Everything
/// this cascade can reach is rooted on the computer the user just condemned, so a
/// dependency that appears between the dialog and the request cannot change the
/// CLASS of what is destroyed — an exact-id snapshot would have bought only that,
/// at the price of a second consent model. Legality is re-decided under the lock
/// regardless of this flag.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CascadeConsent {
    Confirmed,
    Absent,
}

/// Why a computer's lifecycle is not the requester's to end. Both arms are
/// pre-flight and neither takes a lock to say no.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ComputerLifecycleRefused {
    /// No such computer, or not this requester's. ONE arm on purpose: a requester
    /// who does not own the computer must not learn that the id exists.
    NotFound,
    /// Present and theirs, but the platform owns this computer's lifecycle.
    NotUserManaged,
}

/// Whether this requester may end this computer's lifecycle at all.
///
/// The deletable computer is a CONJUNCTION — a `remote` machine the user invited —
/// and it is stated here rather than pre-combined by an adapter, so the other
/// combinations cannot quietly acquire a meaning. An app install and a system
/// computer are refused for the same reason a local one is: their lifecycle is not
/// a user request's to end.
pub fn computer_lifecycle_refusal(
    computer: Option<&ComputerTeardownFacts>,
    requester: &UserId,
) -> Option<ComputerLifecycleRefused> {
    let Some(computer) = computer else {
        return Some(ComputerLifecycleRefused::NotFound);
    };
    if computer.user_id.as_ref() != Some(requester) {
        return Some(ComputerLifecycleRefused::NotFound);
    }
    if computer.provisioning_source != ProvisioningSource::UserInvite
        || computer.kind != HostKind::Remote
    {
        return Some(ComputerLifecycleRefused::NotUserManaged);
    }
    None
}

/// Why the cascade may not run, decided from the dependency set read under the
/// lock. Each arm carries what the refusal was decided on, so it describes the
/// state that actually held rather than a state the caller might re-read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CascadeRefused {
    /// At least one agent here is mid-materialization. Transient, so this asks for
    /// a retry rather than offering a cascade — no consent makes it legal.
    MaterializationInFlight { agents: usize },
    /// At least one agent here holds a durable deletion intent whose resumer owns
    /// its purge. Deleting that row underneath the worker would strand a daemon
    /// fence with no control-plane attempt to complete from.
    DeletionInFlight { agents: usize },
    /// The caller never confirmed the cascade. Carries what it would have
    /// destroyed, so a caller that skipped the discovery step still learns it.
    ConsentRequired { dependents: Vec<AgentTeardownFacts> },
}

/// Whether the authoritative dependency set admits the cascade.
///
/// Legality is decided before consent. A computer holding a mid-materialization
/// agent is not made deletable by confirming a cascade, so reporting the missing
/// confirmation first would send the user through a dialog whose answer is then
/// refused anyway. Between the two legality arms the order is fixed to the
/// TypeScript authority's, not derived: both are transient and either would be a
/// defensible answer for a computer holding both, so the two implementations must
/// at least answer identically while both are reachable.
pub fn cascade_refusal(
    agents: &[AgentTeardownFacts],
    consent: CascadeConsent,
) -> Option<CascadeRefused> {
    // The stage rule is the single authority for "may this row be torn down", so a
    // stage that stops being teardownable joins this refusal without being
    // mentioned here.
    let in_flight = agents
        .iter()
        .filter(|agent| teardown_branch(agent.materialization_status) == TeardownBranch::Refused)
        .count();
    if in_flight > 0 {
        return Some(CascadeRefused::MaterializationInFlight { agents: in_flight });
    }
    let deleting = agents
        .iter()
        .filter(|agent| agent.deletion_started_at.is_some())
        .count();
    if deleting > 0 {
        return Some(CascadeRefused::DeletionInFlight { agents: deleting });
    }
    if !agents.is_empty() && consent == CascadeConsent::Absent {
        return Some(CascadeRefused::ConsentRequired {
            dependents: agents.to_vec(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent_lifecycle::MaterializationStatus,
        identity::{AgentId, HostId},
    };

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn agent(id: &str, status: MaterializationStatus) -> AgentTeardownFacts {
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

    fn deleting(id: &str) -> AgentTeardownFacts {
        AgentTeardownFacts {
            deletion_started_at: Some(17),
            ..agent(id, MaterializationStatus::Active)
        }
    }

    fn computer(
        owner: Option<&str>,
        kind: HostKind,
        provisioning_source: ProvisioningSource,
    ) -> ComputerTeardownFacts {
        ComputerTeardownFacts {
            id: HostId::parse("h1").expect("host id"),
            user_id: owner.map(user),
            kind,
            provisioning_source,
        }
    }

    fn user_managed() -> ComputerTeardownFacts {
        computer(Some("u1"), HostKind::Remote, ProvisioningSource::UserInvite)
    }

    #[test]
    fn the_owner_of_a_user_invited_remote_computer_may_end_its_lifecycle() {
        assert_eq!(
            computer_lifecycle_refusal(Some(&user_managed()), &user("u1")),
            None
        );
    }

    #[test]
    fn a_computer_that_is_not_the_requesters_is_indistinguishable_from_absent() {
        // Both answer NotFound, which is the point: a non-owner learns nothing
        // about the id, not even that a computer they may not touch exists.
        assert_eq!(
            computer_lifecycle_refusal(None, &user("u1")),
            Some(ComputerLifecycleRefused::NotFound)
        );
        assert_eq!(
            computer_lifecycle_refusal(Some(&user_managed()), &user("u2")),
            Some(ComputerLifecycleRefused::NotFound)
        );
        assert_eq!(
            computer_lifecycle_refusal(
                Some(&computer(
                    None,
                    HostKind::Remote,
                    ProvisioningSource::UserInvite
                )),
                &user("u1")
            ),
            Some(ComputerLifecycleRefused::NotFound)
        );
    }

    #[test]
    fn both_halves_of_user_managed_are_required() {
        // Each combination that is not (remote, user_invite) is refused for the
        // same reason, so neither half can be dropped from the conjunction.
        for facts in [
            computer(Some("u1"), HostKind::Local, ProvisioningSource::UserInvite),
            computer(Some("u1"), HostKind::Remote, ProvisioningSource::AppInstall),
            computer(Some("u1"), HostKind::Remote, ProvisioningSource::System),
        ] {
            assert_eq!(
                computer_lifecycle_refusal(Some(&facts), &user("u1")),
                Some(ComputerLifecycleRefused::NotUserManaged),
                "{facts:?} must not be user-deletable"
            );
        }
    }

    #[test]
    fn an_empty_computer_needs_no_confirmation() {
        assert_eq!(cascade_refusal(&[], CascadeConsent::Absent), None);
    }

    #[test]
    fn a_confirmed_cascade_over_teardownable_agents_is_admitted() {
        assert_eq!(
            cascade_refusal(
                &[
                    agent("a1", MaterializationStatus::Active),
                    agent("a2", MaterializationStatus::Failed)
                ],
                CascadeConsent::Confirmed
            ),
            None
        );
    }

    #[test]
    fn an_unconfirmed_cascade_reports_what_it_would_have_destroyed() {
        let agents = [agent("a1", MaterializationStatus::Active)];
        assert_eq!(
            cascade_refusal(&agents, CascadeConsent::Absent),
            Some(CascadeRefused::ConsentRequired {
                dependents: agents.to_vec()
            })
        );
    }

    #[test]
    fn illegality_is_reported_even_when_the_cascade_was_never_confirmed() {
        // Consent cannot make either of these legal, so answering "confirm first"
        // would walk the user through a dialog whose answer is refused anyway.
        assert_eq!(
            cascade_refusal(
                &[agent("a1", MaterializationStatus::PendingMaterialization)],
                CascadeConsent::Absent
            ),
            Some(CascadeRefused::MaterializationInFlight { agents: 1 })
        );
        assert_eq!(
            cascade_refusal(&[deleting("a1")], CascadeConsent::Absent),
            Some(CascadeRefused::DeletionInFlight { agents: 1 })
        );
    }

    #[test]
    fn a_stage_in_flight_is_named_before_a_deletion_in_flight() {
        // Both are transient; the order is parity with the TypeScript authority
        // while both implementations are reachable, and this pins it.
        assert_eq!(
            cascade_refusal(
                &[
                    deleting("a1"),
                    agent("a2", MaterializationStatus::PendingMaterialization)
                ],
                CascadeConsent::Confirmed
            ),
            Some(CascadeRefused::MaterializationInFlight { agents: 1 })
        );
    }

    #[test]
    fn a_refusal_counts_every_agent_it_is_about() {
        assert_eq!(
            cascade_refusal(
                &[
                    agent("a1", MaterializationStatus::PendingMaterialization),
                    agent("a2", MaterializationStatus::PendingMaterialization),
                    agent("a3", MaterializationStatus::Active)
                ],
                CascadeConsent::Confirmed
            ),
            Some(CascadeRefused::MaterializationInFlight { agents: 2 })
        );
        assert_eq!(
            cascade_refusal(&[deleting("a1"), deleting("a2")], CascadeConsent::Confirmed),
            Some(CascadeRefused::DeletionInFlight { agents: 2 })
        );
    }
}
