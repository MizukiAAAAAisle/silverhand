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

use crate::identity::WorkspaceId;
use crate::persistence::PersistenceFailure;

use super::agent_enrollment::Principal;
use super::role::{WorkspaceRole, role_governs_workspace};

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{AgentId, UserId};

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
}
