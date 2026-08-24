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
