//! Deleting a computer, and with it everything rooted on that computer.
//!
//! Two rules live here, at deliberately different depths:
//!
//!  - [`hold_computer_lifecycle`] answers whether this computer's lifecycle is a
//!    user request's to END at all. It is answerable from the computer row alone,
//!    so a pre-flight face may ask it without taking a write lock to say no. The
//!    conditional row delete re-states the same condition in its own `WHERE`, so
//!    answering early is an optimization, not the guarantee.
//!  - [`admit_cascade`] is the IN-LOCK question, decided from the authoritative
//!    dependency set. Every refusal it produces rolls the whole scope back, which
//!    is what makes "non-2xx means nothing happened — including bytes" true: the
//!    commit is the single decision point, and every unrollbackable effect (runtime
//!    stops, the host-local purge, the blob sweep) runs after it.
//!
//! WHOSE computer it is belongs to neither: that is authorization over a computer
//! and lives in [`crate::capability::computer_access`]. This module consumes its
//! witness, so the order — is it theirs, then may its lifecycle be ended, then does
//! its dependency set admit the cascade — is carried by the types rather than by an
//! implementation remembering to ask in that order.
//!
//! A regular workspace is NOT rooted on a computer, so this cascade can never
//! reach one. Its member agents placed here are deleted, which is the same outcome
//! as deleting those agents individually.

use crate::{
    capability::computer_access::ComputerAccessHeld,
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

/// Proof that this computer's lifecycle is a user request's to end, and that the
/// requester it answers to was already established.
///
/// Private constructor, and it owns both halves it rests on: the access witness and
/// the computer facts it judged. So a committed cascade cannot describe a computer
/// other than the one admitted, and cannot exist for a requester no rule matched.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerLifecycleHeld {
    access: ComputerAccessHeld,
    facts: ComputerTeardownFacts,
}

impl ComputerLifecycleHeld {
    /// The owner every post-commit announcement is fanned out on. Read from the
    /// access witness, because by then the row it came from is deleted.
    pub fn owner(&self) -> &UserId {
        self.access.owner()
    }

    pub fn computer(&self) -> &ComputerTeardownFacts {
        &self.facts
    }
}

/// The lifecycle rule's verdict.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ComputerLifecycle {
    Held(ComputerLifecycleHeld),
    /// Theirs, but the platform owns this computer's lifecycle.
    NotUserManaged,
}

/// May this computer's lifecycle be ended by a user request?
///
/// The deletable computer is a CONJUNCTION — a `remote` machine the user invited —
/// and it is stated here rather than pre-combined by an adapter, so the other
/// combinations cannot quietly acquire a meaning. An app install and a system
/// computer are refused for the same reason a local one is: their lifecycle is not
/// a user request's to end.
pub fn hold_computer_lifecycle(
    access: ComputerAccessHeld,
    facts: ComputerTeardownFacts,
) -> ComputerLifecycle {
    if facts.provisioning_source != ProvisioningSource::UserInvite || facts.kind != HostKind::Remote
    {
        return ComputerLifecycle::NotUserManaged;
    }
    ComputerLifecycle::Held(ComputerLifecycleHeld { access, facts })
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

/// Proof that the authoritative dependency set admitted the cascade.
///
/// Owns the set it judged and the lifecycle witness it required, so a committed
/// cascade can be built only around facts this rule saw, and only for a computer
/// whose lifecycle and requester were established first. Transitive on purpose:
/// the write boundary consumes one witness and gets all three answers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CascadeAdmitted {
    lifecycle: ComputerLifecycleHeld,
    dependents: Vec<AgentTeardownFacts>,
}

impl CascadeAdmitted {
    pub fn lifecycle(&self) -> &ComputerLifecycleHeld {
        &self.lifecycle
    }

    /// Hand the lifecycle witness on to the committed outcome, which must keep it:
    /// the owner it names is read after the row it came from is deleted.
    pub fn into_lifecycle(self) -> ComputerLifecycleHeld {
        self.lifecycle
    }

    /// Every agent row this cascade may delete, as judged.
    pub fn dependents(&self) -> &[AgentTeardownFacts] {
        &self.dependents
    }

    /// The admitted rows whose stage owes nothing but the row delete. Derived from
    /// the judged set through the one stage authority, so the half of a cascade
    /// that has no post-commit work of its own cannot be reported from anywhere
    /// else.
    pub fn row_only(&self) -> Vec<AgentTeardownFacts> {
        self.dependents
            .iter()
            .filter(|agent| {
                teardown_branch(agent.materialization_status) == TeardownBranch::RowOnly
            })
            .cloned()
            .collect()
    }
}

/// The cascade rule's verdict.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CascadeAdmission {
    Admitted(CascadeAdmitted),
    Refused(CascadeRefused),
}

/// Does the authoritative dependency set admit the cascade?
///
/// Legality is decided before consent. A computer holding a mid-materialization
/// agent is not made deletable by confirming a cascade, so reporting the missing
/// confirmation first would send the user through a dialog whose answer is then
/// refused anyway. Between the two legality arms the order is fixed to the
/// TypeScript authority's, not derived: both are transient and either would be a
/// defensible answer for a computer holding both, so the two implementations must
/// at least answer identically while both are reachable.
///
/// The set is taken BY VALUE: the admitted witness owns it, and the consent refusal
/// hands it back rather than copying it, so there is no second set anywhere for a
/// report to disagree with.
pub fn admit_cascade(
    lifecycle: ComputerLifecycleHeld,
    agents: Vec<AgentTeardownFacts>,
    consent: CascadeConsent,
) -> CascadeAdmission {
    // The stage rule is the single authority for "may this row be torn down", so a
    // stage that stops being teardownable joins this refusal without being
    // mentioned here.
    let in_flight = agents
        .iter()
        .filter(|agent| teardown_branch(agent.materialization_status) == TeardownBranch::Refused)
        .count();
    if in_flight > 0 {
        return CascadeAdmission::Refused(CascadeRefused::MaterializationInFlight {
            agents: in_flight,
        });
    }
    let deleting = agents
        .iter()
        .filter(|agent| agent.deletion_started_at.is_some())
        .count();
    if deleting > 0 {
        return CascadeAdmission::Refused(CascadeRefused::DeletionInFlight { agents: deleting });
    }
    if !agents.is_empty() && consent == CascadeConsent::Absent {
        return CascadeAdmission::Refused(CascadeRefused::ConsentRequired { dependents: agents });
    }
    CascadeAdmission::Admitted(CascadeAdmitted {
        lifecycle,
        dependents: agents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent_lifecycle::MaterializationStatus,
        capability::computer_access::{
            ComputerAccess, ComputerOwnershipFacts, can_access_computer,
        },
        identity::{AgentId, HostId},
    };

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    /// The access witness cannot be built from parts, so every test that needs one
    /// obtains it the way production does. That is the guarantee, not a detour.
    fn access(owner: &str) -> ComputerAccessHeld {
        let facts = ComputerOwnershipFacts {
            owner: Some(user(owner)),
        };
        let ComputerAccess::Held(held) = can_access_computer(&user(owner), Some(&facts)) else {
            panic!("expected the owner to be admitted");
        };
        held
    }

    fn computer(kind: HostKind, provisioning_source: ProvisioningSource) -> ComputerTeardownFacts {
        ComputerTeardownFacts {
            id: HostId::parse("h1").expect("host id"),
            kind,
            provisioning_source,
        }
    }

    fn user_managed() -> ComputerTeardownFacts {
        computer(HostKind::Remote, ProvisioningSource::UserInvite)
    }

    fn lifecycle_held() -> ComputerLifecycleHeld {
        let ComputerLifecycle::Held(held) = hold_computer_lifecycle(access("u1"), user_managed())
        else {
            panic!("expected a user-managed computer to be admitted");
        };
        held
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
            deletion_started_at: Some(1),
            ..agent(id, MaterializationStatus::Active)
        }
    }

    fn refusal(agents: Vec<AgentTeardownFacts>, consent: CascadeConsent) -> Option<CascadeRefused> {
        match admit_cascade(lifecycle_held(), agents, consent) {
            CascadeAdmission::Admitted(_) => None,
            CascadeAdmission::Refused(refused) => Some(refused),
        }
    }

    #[test]
    fn both_halves_of_user_managed_are_required() {
        for facts in [
            computer(HostKind::Local, ProvisioningSource::UserInvite),
            computer(HostKind::Remote, ProvisioningSource::AppInstall),
            computer(HostKind::Remote, ProvisioningSource::System),
            computer(HostKind::Local, ProvisioningSource::AppInstall),
        ] {
            assert_eq!(
                hold_computer_lifecycle(access("u1"), facts),
                ComputerLifecycle::NotUserManaged
            );
        }
    }

    #[test]
    fn the_lifecycle_witness_carries_the_requester_the_fan_out_needs() {
        // Read from the access witness rather than the computer row, because by the
        // time the fan-out runs that row is deleted.
        let held = lifecycle_held();
        assert_eq!(held.owner(), &user("u1"));
        assert_eq!(held.computer(), &user_managed());
    }

    #[test]
    fn a_computer_with_no_agents_needs_no_confirmation() {
        assert_eq!(refusal(Vec::new(), CascadeConsent::Absent), None);
    }

    #[test]
    fn an_unconfirmed_cascade_reports_what_it_would_have_destroyed() {
        assert_eq!(
            refusal(
                vec![agent("a1", MaterializationStatus::Active)],
                CascadeConsent::Absent
            ),
            Some(CascadeRefused::ConsentRequired {
                dependents: vec![agent("a1", MaterializationStatus::Active)],
            })
        );
    }

    #[test]
    fn a_confirmed_cascade_admits_the_very_set_it_judged() {
        let agents = vec![
            agent("a1", MaterializationStatus::Active),
            agent("a2", MaterializationStatus::Failed),
        ];
        let CascadeAdmission::Admitted(admitted) =
            admit_cascade(lifecycle_held(), agents.clone(), CascadeConsent::Confirmed)
        else {
            panic!("expected the cascade to be admitted");
        };
        assert_eq!(admitted.dependents(), agents.as_slice());
        assert_eq!(admitted.lifecycle().owner(), &user("u1"));
    }

    #[test]
    fn the_row_only_half_is_derived_through_the_one_stage_authority() {
        let CascadeAdmission::Admitted(admitted) = admit_cascade(
            lifecycle_held(),
            vec![
                agent("a1", MaterializationStatus::Active),
                agent("a2", MaterializationStatus::Failed),
            ],
            CascadeConsent::Confirmed,
        ) else {
            panic!("expected the cascade to be admitted");
        };
        assert_eq!(
            admitted
                .row_only()
                .iter()
                .map(|agent| agent.id.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec!["a2"]
        );
    }

    #[test]
    fn illegality_is_reported_even_when_the_cascade_was_never_confirmed() {
        // Confirming would not make it legal, so asking for confirmation first
        // would walk the user through a dialog whose answer is refused anyway.
        for consent in [CascadeConsent::Absent, CascadeConsent::Confirmed] {
            assert_eq!(
                refusal(
                    vec![agent("a1", MaterializationStatus::PendingMaterialization)],
                    consent
                ),
                Some(CascadeRefused::MaterializationInFlight { agents: 1 })
            );
            assert_eq!(
                refusal(vec![deleting("a1")], consent),
                Some(CascadeRefused::DeletionInFlight { agents: 1 })
            );
        }
    }

    #[test]
    fn a_stage_in_flight_is_named_before_a_deletion_in_flight() {
        // Both are transient and either answer would be defensible; the order is
        // parity with the TypeScript authority, not a derived principle.
        assert_eq!(
            refusal(
                vec![
                    deleting("a1"),
                    agent("a2", MaterializationStatus::PendingMaterialization),
                ],
                CascadeConsent::Confirmed
            ),
            Some(CascadeRefused::MaterializationInFlight { agents: 1 })
        );
    }

    #[test]
    fn a_refusal_counts_every_agent_it_is_about() {
        assert_eq!(
            refusal(
                vec![
                    agent("a1", MaterializationStatus::PendingMaterialization),
                    agent("a2", MaterializationStatus::PendingMaterialization),
                ],
                CascadeConsent::Confirmed
            ),
            Some(CascadeRefused::MaterializationInFlight { agents: 2 })
        );
        assert_eq!(
            refusal(
                vec![deleting("a1"), deleting("a2"), deleting("a3")],
                CascadeConsent::Confirmed
            ),
            Some(CascadeRefused::DeletionInFlight { agents: 3 })
        );
    }

    #[test]
    fn a_teardownable_stage_is_not_in_flight_for_either_reason() {
        assert_eq!(
            refusal(
                vec![
                    agent("a1", MaterializationStatus::Active),
                    agent("a2", MaterializationStatus::Failed),
                ],
                CascadeConsent::Confirmed
            ),
            None
        );
    }
}
