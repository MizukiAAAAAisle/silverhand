//! The workspace deletion domain: the delete verdict and the captured teardown plan.
//!
//! `DELETE /api/workspaces/{id}` is a saga, but the AUTHORITY is a SINGLE writer
//! transaction (Cindy R6 #4): under ONE `BEGIN IMMEDIATE` lock it reads the subject,
//! decides the full verdict, and — only if the subject is deletable by this requester
//! — captures the FULL teardown plan and cascades the row, ALL in that one tx. It
//! returns a single CLOSED outcome `WorkspaceDeletionOutcome`:
//!   - `Committed(plan)` — the row was cascaded; the plan (captured pre-cascade in the
//!     SAME tx, so it reflects exactly the erased rows) authorizes the destructive
//!     aftermath (conversation-run terminalize, detached runtime hard-stop, blob sweep)
//!     and the `viewer_workspaces_changed { removed }` fan-out. Route → 204 + effects.
//!   - `IdempotentNoop` — no workspace answers to this id (never existed, or a
//!     concurrent winner already removed it under this very lock). Route → 204, zero
//!     effect.
//!   - `NotDeletableKind` — an agent-home. Route → `409 workspace_not_deletable`.
//!   - `Forbidden` — a regular workspace the requester does not own (incl. a
//!     post-request owner change). Route → `403`.
//!
//! Because the decision + capture + cascade are one lock, there is no stale pre-lock
//! witness and no separate phase-1 authority; the fresh gate is the only authority and
//! each distinct product result keeps its distinct status (never all folded to 204).

use crate::foundation::blob_store::StoredBlob;
use crate::foundation::identity::{AgentId, ConversationId, UserId, WorkspaceId};
use crate::foundation::persistence::PersistenceFailure;
use std::future::Future;

/// The workspace-kind fact the delete verdict reads. A regular workspace is
/// deletable by its owner; an agent-home is never deletable via this endpoint; a
/// missing id is the idempotent no-op. These are DISTINCT here (unlike the
/// governance facts' fused `NoSuchWorkspace`) because the endpoint answers each
/// with a different status (204 / 409 / 204-after-owner-check).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceDeletionSubject {
    /// No workspace answers to this id — the delete is an idempotent 204 no-op.
    Missing,
    /// An agent-home workspace — `409 workspace_not_deletable`, never removed here.
    AgentHome,
    /// A regular workspace with the caller's stored governance role (`None` when
    /// no role row names them).
    Regular {
        actor_role: Option<crate::identity_access::access::WorkspaceRole>,
    },
}

/// The pre-write delete verdict, mirroring the reference `deleteWorkspace`
/// outcome set. `IdempotentNoop` and `Deletable` both terminate at `204`, but only
/// the latter performs the row delete + effects; the two 4xx arms refuse.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceDeletionVerdict {
    /// Missing id — 204, no delete, no effects.
    IdempotentNoop,
    /// Agent-home — `409 { error, code: 'workspace_not_deletable' }`.
    NotDeletableKind,
    /// Regular workspace but the caller is not its owner — `403 forbidden`.
    Forbidden,
    /// Regular workspace and the caller is its owner — perform the delete.
    Deletable,
}

/// Decide the delete verdict from the subject + the acting user. Mirrors the
/// reference order: existence-noop → agent-home → owner floor → deletable.
pub fn decide_workspace_deletion(subject: &WorkspaceDeletionSubject) -> WorkspaceDeletionVerdict {
    use crate::identity_access::access::WorkspaceRole;
    match subject {
        WorkspaceDeletionSubject::Missing => WorkspaceDeletionVerdict::IdempotentNoop,
        WorkspaceDeletionSubject::AgentHome => WorkspaceDeletionVerdict::NotDeletableKind,
        WorkspaceDeletionSubject::Regular { actor_role } => {
            // Owner floor: only an owner (the requester is a human by this route's
            // perimeter) may delete a regular workspace.
            if actor_role.is_some_and(|role| role.meets_floor(WorkspaceRole::Owner)) {
                WorkspaceDeletionVerdict::Deletable
            } else {
                WorkspaceDeletionVerdict::Forbidden
            }
        }
    }
}

/// One conversation-scoped runtime seat captured for teardown: the exact
/// `(conversation, agent)` a ConversationSlot runs under. Captured in the writer
/// transaction BEFORE the FK cascade erases `conversation_agents` — the aftermath
/// must NOT re-read the audience post-commit (it would be empty). AgentSlot agents
/// (`session_scope = 'agent'`) are deliberately excluded: their seat is not
/// workspace-scoped and is not stopped by a workspace delete.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceRuntimeSeat {
    pub conversation: ConversationId,
    pub agent: AgentId,
}

/// The teardown plan captured in the SAME phase-2 reserved-writer transaction as
/// the conditional row DELETE, right before the cascade erases the rows — so every
/// coordinate reflects exactly what THIS delete cascades (Cindy R5 #2). The
/// aftermath consumes this committed plan and never live-re-reads an audience the
/// cascade removed, and never acts on a stale phase-1 snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceTeardownPlan {
    /// The conversation-scoped seats to hard-stop, captured pre-cascade IN the
    /// phase-2 tx. The aftermath resolves each seat's live host/generation by scope
    /// (the seat registry is in-memory, not cascade-affected) and hard-stops it.
    pub runtime_seats: Vec<WorkspaceRuntimeSeat>,
    /// The canonical stored blobs of every attachment in the workspace's
    /// conversations, captured pre-cascade IN the phase-2 tx so the storage keys
    /// survive the row delete; the aftermath best-effort deletes them from the one
    /// blob store post-commit.
    pub blobs: Vec<StoredBlob>,
    /// EVERY conversation id in the workspace, captured pre-cascade IN the phase-2 tx
    /// INDEPENDENTLY of the routed runtime seats (Cindy R3-next #2). The
    /// `conversation_closed` run-state terminalization must cover every workspace
    /// conversation — a conversation whose roster/agent rows are already gone can
    /// still have a live ConversationSlot run in the in-memory run map, and deriving
    /// the set from `runtime_seats` (which come from current roster rows) would miss
    /// it. The hard-stop still consumes only the routed `runtime_seats`.
    pub conversation_ids: Vec<ConversationId>,
    /// The viewer members to notify with `viewer_workspaces_changed { removed }`.
    pub viewer_members: Vec<UserId>,
    /// The workspace that was torn down.
    pub workspace: WorkspaceId,
}

/// The SINGLE closed outcome of the one-transaction workspace-delete authority
/// (Cindy R6 #4). The writer decides under a fresh `BEGIN IMMEDIATE` lock and returns
/// exactly one of these — each a DISTINCT product result the route maps to a distinct
/// status, never folded together:
/// - `Committed(plan)` — the row was cascaded; the plan (captured pre-cascade in the
///   SAME tx) authorizes the destructive aftermath + `removed` fan-out. Route → 204.
/// - `IdempotentNoop` — no workspace answers to the id under the lock (never existed
///   OR a concurrent winner already removed it). Route → 204, zero effect.
/// - `NotDeletableKind` — an agent-home. Route → `409 workspace_not_deletable`.
/// - `Forbidden` — a regular workspace the requester does not own (incl. a
///   post-request owner change). Route → `403`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceDeletionOutcome {
    /// The row was cascaded under the fresh lock; the carried plan drives the
    /// destructive aftermath (runtime terminalize/stop, blob sweep) + `removed` fan-out.
    Committed(WorkspaceTeardownPlan),
    /// No workspace answered to the id under the lock — idempotent, zero effect.
    IdempotentNoop,
    /// An agent-home — never deletable via this endpoint.
    NotDeletableKind,
    /// A regular workspace the requester does not own.
    Forbidden,
}

/// The workspace-delete write authority: ONE transaction is the sole authority (Cindy
/// R6 #4). Under a single `BEGIN IMMEDIATE` lock it reads the subject (kind + the human
/// actor's role) — never a stale pre-lock witness — decides the full verdict, and only
/// if the subject is deletable by this requester captures the FULL teardown plan and
/// cascades the row IN THE SAME tx, so the plan reflects exactly the rows erased. It
/// returns a single closed `WorkspaceDeletionOutcome`; a concurrent winner that removed
/// the row before this lock is observed as `IdempotentNoop`, an owner change as
/// `Forbidden`, a kind change as `NotDeletableKind` — each distinct. ONLY
/// `Committed(plan)` authorizes the destructive aftermath + `removed` fan-out, so no
/// destructive effect precedes the authorization. The blob sweep is over the captured
/// refs (post-commit; a mid-sweep crash leaves GC-able orphan blobs — the accepted
/// trade-off).
pub trait WorkspaceDeletionWrite {
    fn delete_workspace(
        &self,
        requester: &UserId,
        workspace_id: &WorkspaceId,
    ) -> impl Future<Output = Result<WorkspaceDeletionOutcome, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_access::access::WorkspaceRole;

    #[test]
    fn missing_is_an_idempotent_noop() {
        assert_eq!(
            decide_workspace_deletion(&WorkspaceDeletionSubject::Missing),
            WorkspaceDeletionVerdict::IdempotentNoop
        );
    }

    #[test]
    fn agent_home_is_not_deletable_here() {
        assert_eq!(
            decide_workspace_deletion(&WorkspaceDeletionSubject::AgentHome),
            WorkspaceDeletionVerdict::NotDeletableKind
        );
    }

    #[test]
    fn only_the_owner_may_delete_a_regular_workspace() {
        assert_eq!(
            decide_workspace_deletion(&WorkspaceDeletionSubject::Regular {
                actor_role: Some(WorkspaceRole::Owner)
            }),
            WorkspaceDeletionVerdict::Deletable
        );
        for role in [None, Some(WorkspaceRole::Member)] {
            assert_eq!(
                decide_workspace_deletion(&WorkspaceDeletionSubject::Regular { actor_role: role }),
                WorkspaceDeletionVerdict::Forbidden
            );
        }
    }
}
