//! The request-boundary governance door.
//!
//! Enrollment has two authorization doors, and this is the first one: *whose
//! roster is this, and does the caller have standing to touch it at all?* That
//! question belongs to the workspace-governance context, not to enrollment, so
//! enrollment depends only on the verdict.
//!
//! The port lives here, beside the use cases that consume it, because it is
//! driver-free: it names a question and an answer, never a transaction or a
//! statement. A persistence adapter implements it without any knowledge of the
//! HTTP surface, and the HTTP surface consumes the verdict without any knowledge
//! of the adapter — neither depends on the other.

use std::future::Future;

use crate::foundation::identity::WorkspaceId;
use crate::foundation::persistence::PersistenceFailure;

use super::role::{WorkspaceRole, role_governs_workspace};
use crate::foundation::identity::Principal;

/// The request-boundary door: the caller's standing to add members to a
/// workspace. It resolves the workspace and the caller's role CEILING together —
/// both concerns of the workspace-governance context, not of enrollment — and
/// answers before any enrollment work runs, so a caller without standing cannot
/// probe input shape.
///
/// This verdict is sampled *before* any write lock and can therefore go stale: a
/// demotion may commit in the seam between it and the write. Guarding against
/// that is not this door's job — the human-enrollment unit of work re-derives the
/// actor's authority under its own lock. The two doors are separate on purpose,
/// and neither substitutes for the other.
pub trait WorkspaceAccessPolicy: Clone + Send + Sync + 'static {
    fn authorize_member_governance(
        &self,
        principal: &Principal,
        workspace_id: &WorkspaceId,
    ) -> impl Future<Output = Result<WorkspaceGovernance, PersistenceFailure>> + Send;
}

/// The boundary door's verdict: the caller's governance CEILING over this
/// workspace, resolved in one read. The floors a surface applies are pure
/// comparisons against it — the agent roster needs `Member` or above, the people
/// roster needs `Admin` — so neither costs a second database round-trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceGovernance {
    /// No such regular workspace — missing, or an agent-home — so `404`.
    WorkspaceNotFound,
    /// The caller is below the member floor (not a workspace member, or an agent
    /// principal) — `403` for either roster.
    Denied,
    /// The caller is a workspace member but does not govern it: the agent roster
    /// admits, the people roster is refused at the admin floor.
    Member,
    /// The caller governs the workspace (admin or owner, or the system
    /// principal): both rosters admit.
    Admin,
}

/// What an adapter must read for the verdict, and nothing more. The rule that
/// turns these facts into a [`WorkspaceGovernance`] is pure and lives below, so a
/// persistence adapter never re-implements the role axis and cannot drift from
/// the in-lock re-derivation that consults the same [`role_governs_workspace`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceGovernanceFacts {
    /// No regular workspace answers to this id. Missing and "it is some agent's
    /// private home" are ONE fact here on purpose: an agent home has no people
    /// or agent roster to govern, so the product answers `404` for both and an
    /// adapter must not let a caller distinguish them.
    NoSuchWorkspace,
    /// A regular workspace exists, together with the caller's stored governance
    /// role — `None` when no role row names them, which is not membership.
    /// Non-human principals hold no role row at all and pass `None`; the rule
    /// below decides them without one.
    Regular { actor_role: Option<WorkspaceRole> },
}

/// The pure boundary-door rule: the caller's governance CEILING over a
/// workspace.
///
/// Workspace existence is answered FIRST and for every principal, so a caller
/// who could otherwise govern anything still learns only `404` about a workspace
/// that is not there — the product resolves the container before it grades the
/// caller.
///
/// Above that: `system` governs unconditionally, an agent principal is never a
/// governance actor (governance is a human surface), and a human's ceiling is
/// their stored role — `admin` and `owner` govern, a plain `member` clears only
/// the member floor, and no role row at all is not membership.
pub fn governance_ceiling(
    principal: &Principal,
    facts: WorkspaceGovernanceFacts,
) -> WorkspaceGovernance {
    let WorkspaceGovernanceFacts::Regular { actor_role } = facts else {
        return WorkspaceGovernance::WorkspaceNotFound;
    };
    match principal {
        Principal::System => WorkspaceGovernance::Admin,
        Principal::Agent { .. } => WorkspaceGovernance::Denied,
        Principal::Human { .. } if role_governs_workspace(actor_role) => WorkspaceGovernance::Admin,
        Principal::Human { .. } if actor_role.is_some() => WorkspaceGovernance::Member,
        Principal::Human { .. } => WorkspaceGovernance::Denied,
    }
}

/// A floor-parametric verdict over the SAME facts [`governance_ceiling`] reads,
/// for the surfaces whose floor the collapsed ceiling cannot express.
///
/// The ceiling folds `admin` and `owner` into one `Admin` rung because its two
/// consumers (the agent and people rosters) need only the member and admin
/// floors. The workspace-metadata surfaces need MORE resolution: rename requires
/// `admin`, but archive/delete require `owner`, and `Admin` cannot tell an admin
/// from an owner. So this door answers the floor question directly — is the
/// caller's standing at least `min_role`? — rather than reporting a rung a
/// consumer must then re-interpret.
///
/// It is the SAME door pattern, sampled at the SAME point (pre-lock, so it can go
/// stale — the write re-derives under its own lock), over the SAME facts and the
/// SAME role axis ([`WorkspaceRole::meets_floor`]); only the question's shape
/// differs. Mirrors the product's `canGovernWorkspace(ctx, principal, id, minRole)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceGovernanceFloor {
    /// No such regular workspace — missing, or an agent-home — so `404`.
    WorkspaceNotFound,
    /// The workspace exists but the caller does not clear `min_role` — `403`.
    Denied,
    /// The caller clears `min_role` and may perform the operation.
    Governs,
}

/// The pure floor-door rule: does `principal` govern this workspace at least at
/// `min_role`?
///
/// Existence is resolved FIRST and for every principal, exactly like
/// [`governance_ceiling`], so a caller who could otherwise govern anything still
/// learns only `404` about a workspace that is not there. Above that: `system`
/// governs at every floor, an agent principal is never a governance actor, and a
/// human clears the floor iff their stored role [`meets_floor`](WorkspaceRole::meets_floor)
/// — a `None` role is not membership and clears nothing.
pub fn governance_floor_verdict(
    principal: &Principal,
    facts: WorkspaceGovernanceFacts,
    min_role: WorkspaceRole,
) -> WorkspaceGovernanceFloor {
    let WorkspaceGovernanceFacts::Regular { actor_role } = facts else {
        return WorkspaceGovernanceFloor::WorkspaceNotFound;
    };
    let governs = match principal {
        Principal::System => true,
        Principal::Agent { .. } => false,
        Principal::Human { .. } => actor_role.is_some_and(|role| role.meets_floor(min_role)),
    };
    if governs {
        WorkspaceGovernanceFloor::Governs
    } else {
        WorkspaceGovernanceFloor::Denied
    }
}

/// The request-boundary read the floor door consumes: the caller's governance
/// facts over one workspace, resolved in a single read, before any write lock.
///
/// It is the driver-free twin of [`WorkspaceAccessPolicy`]: that door returns the
/// collapsed ceiling for the roster surfaces, this one returns the RAW facts so a
/// surface can apply its own floor via [`governance_floor_verdict`] with
/// owner-fidelity. An adapter serves both off the same read and never
/// re-implements the role axis. Sampled pre-lock — it can go stale, and the write
/// path re-derives authority under its own lock.
pub trait WorkspaceGovernanceFactsRead: Clone + Send + Sync + 'static {
    fn read_governance_facts(
        &self,
        principal: &Principal,
        workspace_id: &WorkspaceId,
    ) -> impl Future<Output = Result<WorkspaceGovernanceFacts, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::foundation::identity::{AgentId, UserId};

    fn human() -> Principal {
        Principal::Human {
            user_id: UserId::parse("user-1").unwrap(),
        }
    }

    fn regular(actor_role: Option<WorkspaceRole>) -> WorkspaceGovernanceFacts {
        WorkspaceGovernanceFacts::Regular { actor_role }
    }

    #[test]
    fn a_missing_workspace_is_not_found_for_every_principal_including_system() {
        for principal in [
            human(),
            Principal::System,
            Principal::Agent {
                agent_id: AgentId::parse("agent-1").unwrap(),
            },
        ] {
            assert_eq!(
                governance_ceiling(&principal, WorkspaceGovernanceFacts::NoSuchWorkspace),
                WorkspaceGovernance::WorkspaceNotFound,
                "existence is resolved before the caller is graded"
            );
        }
    }

    #[test]
    fn a_humans_ceiling_is_their_stored_role() {
        assert_eq!(
            governance_ceiling(&human(), regular(Some(WorkspaceRole::Owner))),
            WorkspaceGovernance::Admin
        );
        assert_eq!(
            governance_ceiling(&human(), regular(Some(WorkspaceRole::Admin))),
            WorkspaceGovernance::Admin
        );
        assert_eq!(
            governance_ceiling(&human(), regular(Some(WorkspaceRole::Member))),
            WorkspaceGovernance::Member,
            "a plain member clears the agent roster's floor but not the people roster's"
        );
    }

    #[test]
    fn a_human_with_no_role_row_is_not_a_member() {
        assert_eq!(
            governance_ceiling(&human(), regular(None)),
            WorkspaceGovernance::Denied
        );
    }

    #[test]
    fn the_system_principal_governs_an_existing_workspace_without_a_role_row() {
        assert_eq!(
            governance_ceiling(&Principal::System, regular(None)),
            WorkspaceGovernance::Admin
        );
    }

    #[test]
    fn an_agent_principal_is_never_a_governance_actor() {
        let agent = Principal::Agent {
            agent_id: AgentId::parse("agent-1").unwrap(),
        };
        // Not even a role token reaching this rule could promote an agent: the
        // arm is decided by the principal kind, before the role is consulted.
        for role in [
            None,
            Some(WorkspaceRole::Member),
            Some(WorkspaceRole::Admin),
            Some(WorkspaceRole::Owner),
        ] {
            assert_eq!(
                governance_ceiling(&agent, regular(role)),
                WorkspaceGovernance::Denied
            );
        }
    }

    // ---- the floor door ----

    #[test]
    fn the_floor_door_resolves_existence_before_grading_any_principal() {
        for principal in [
            human(),
            Principal::System,
            Principal::Agent {
                agent_id: AgentId::parse("agent-1").unwrap(),
            },
        ] {
            for floor in [
                WorkspaceRole::Member,
                WorkspaceRole::Admin,
                WorkspaceRole::Owner,
            ] {
                assert_eq!(
                    governance_floor_verdict(
                        &principal,
                        WorkspaceGovernanceFacts::NoSuchWorkspace,
                        floor,
                    ),
                    WorkspaceGovernanceFloor::WorkspaceNotFound,
                    "existence is resolved before the floor is applied"
                );
            }
        }
    }

    #[test]
    fn a_human_clears_a_floor_iff_their_stored_role_meets_it() {
        // Owner clears every floor; admin clears admin but not owner; member
        // clears only member. This is the resolution the collapsed ceiling loses,
        // and it is exactly what the owner-floored archive surface needs.
        assert_eq!(
            governance_floor_verdict(
                &human(),
                regular(Some(WorkspaceRole::Owner)),
                WorkspaceRole::Owner
            ),
            WorkspaceGovernanceFloor::Governs
        );
        assert_eq!(
            governance_floor_verdict(
                &human(),
                regular(Some(WorkspaceRole::Admin)),
                WorkspaceRole::Owner
            ),
            WorkspaceGovernanceFloor::Denied,
            "an admin does not clear the owner floor — the distinction Admin cannot express"
        );
        assert_eq!(
            governance_floor_verdict(
                &human(),
                regular(Some(WorkspaceRole::Admin)),
                WorkspaceRole::Admin
            ),
            WorkspaceGovernanceFloor::Governs
        );
        assert_eq!(
            governance_floor_verdict(
                &human(),
                regular(Some(WorkspaceRole::Member)),
                WorkspaceRole::Admin
            ),
            WorkspaceGovernanceFloor::Denied
        );
        assert_eq!(
            governance_floor_verdict(
                &human(),
                regular(Some(WorkspaceRole::Member)),
                WorkspaceRole::Member
            ),
            WorkspaceGovernanceFloor::Governs
        );
    }

    #[test]
    fn a_human_with_no_role_row_clears_no_floor() {
        for floor in [
            WorkspaceRole::Member,
            WorkspaceRole::Admin,
            WorkspaceRole::Owner,
        ] {
            assert_eq!(
                governance_floor_verdict(&human(), regular(None), floor),
                WorkspaceGovernanceFloor::Denied
            );
        }
    }

    #[test]
    fn the_system_principal_clears_every_floor_of_an_existing_workspace() {
        for floor in [
            WorkspaceRole::Member,
            WorkspaceRole::Admin,
            WorkspaceRole::Owner,
        ] {
            assert_eq!(
                governance_floor_verdict(&Principal::System, regular(None), floor),
                WorkspaceGovernanceFloor::Governs
            );
        }
    }

    #[test]
    fn an_agent_principal_clears_no_floor_regardless_of_role_token() {
        let agent = Principal::Agent {
            agent_id: AgentId::parse("agent-1").unwrap(),
        };
        for role in [None, Some(WorkspaceRole::Owner)] {
            for floor in [
                WorkspaceRole::Member,
                WorkspaceRole::Admin,
                WorkspaceRole::Owner,
            ] {
                assert_eq!(
                    governance_floor_verdict(&agent, regular(role), floor),
                    WorkspaceGovernanceFloor::Denied,
                    "governance is a human surface; an agent principal never governs"
                );
            }
        }
    }
}
