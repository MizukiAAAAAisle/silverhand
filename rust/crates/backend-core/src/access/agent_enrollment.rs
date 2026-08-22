//! Agent workspace enrollment: placing an agent as a member of a regular
//! workspace.
//!
//! Two independent authorization doors guard this write and stay distinct:
//! the caller's workspace role (governed at the request boundary) answers
//! *whose roster this is*, while enrolling a *specific* agent is its creator's
//! authority — a workspace admin may not place someone else's agent. This
//! module owns the second door and the write itself.

use std::future::Future;

use thiserror::Error;

use crate::persistence::PersistenceFailure;

/// A workspace identity.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WorkspaceId(String);

/// An agent identity.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct AgentId(String);

/// A human-user identity.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct UserId(String);

macro_rules! opaque_id {
    ($ty:ident) => {
        impl $ty {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}
opaque_id!(WorkspaceId);
opaque_id!(AgentId);
opaque_id!(UserId);

/// Who is asking to enroll an agent. `Agent` carries no further fields because
/// no enrollment rule reads any: an agent principal can never enroll.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Principal {
    System,
    Human { user_id: UserId },
    Agent { agent_id: AgentId },
}

/// The immutable authorization facts of an agent: enough to decide who may
/// enroll it. Read through [`AgentEnrollmentReadPort`]; the rule that consumes
/// them stays in this layer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentAuthorityFacts {
    pub id: AgentId,
    pub created_by_user_id: UserId,
}

/// An agent's membership in a workspace, as the application sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentWorkspaceMembership {
    pub workspace_id: WorkspaceId,
    pub agent_id: AgentId,
    pub joined_at_ms: i64,
}

/// The membership row after an idempotent insert. `created` is `true` only when
/// this call wrote a fresh row; it is the sole admissible trigger for the
/// capability default-seed, decided under the write mechanism, not from a read
/// taken before it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MembershipInsertOutcome {
    pub member: AgentWorkspaceMembership,
    pub created: bool,
}

/// Why an enrollment was refused. `AgentNotFound` and `AgentNotOwned` are
/// separate on purpose: the caller is already a workspace admin, so revealing
/// that an id exists discloses nothing, while a distinct refusal lets the
/// surface state the real rule (bring your own agents).
#[derive(Debug, Error)]
pub enum AddAgentMemberError {
    #[error("agent not found")]
    AgentNotFound,
    #[error("agent not owned by the enrolling principal")]
    AgentNotOwned,
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
}

/// The read seam this enrollment needs: an agent's immutable authority facts,
/// separated from any write mechanism. Scoped to enrollment on purpose — it is
/// not a general authorization gate. If another capability later needs the same
/// read, it depends on this narrow trait directly rather than growing this into
/// a shared authorization service.
pub trait AgentEnrollmentReadPort: Clone + Send + Sync + 'static {
    /// The agent's authority facts, or `None` when no such agent exists — which
    /// is itself the `AgentNotFound` answer.
    fn agent(
        &self,
        agent_id: &AgentId,
    ) -> impl Future<Output = Result<Option<AgentAuthorityFacts>, PersistenceFailure>> + Send;
}

/// The in-transaction faces of one enrollment, bound to the [`EnrollmentKey`]
/// its [`AgentEnrollmentUnitOfWork::enroll`] coordinated on — neither names a
/// workspace or an agent, so acting on an uncoordinated pair is not
/// expressible. The `if created` policy that composes them lives in
/// [`enroll_agent_into_workspace`], never in the adapter.
pub trait AgentMembershipTx {
    /// Insert the coordinated agent's workspace-membership row (idempotent).
    fn insert_workspace_membership(
        &mut self,
    ) -> Result<MembershipInsertOutcome, PersistenceFailure>;
    /// Seed the default capability set for the coordinated agent. Called only
    /// on a genuinely created row, so re-adding a member never re-widens a set
    /// that was later narrowed.
    fn seed_capability_defaults(&mut self) -> Result<(), PersistenceFailure>;
}

/// Whose membership in which workspace one enrollment transaction may touch.
/// Every writer of this pair's membership must take the same mechanism for the
/// same key, or nothing is serialized against a concurrent removal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnrollmentKey {
    pub workspace_id: WorkspaceId,
    pub agent_id: AgentId,
}

/// One atomic, key-serialized enrollment. The adapter opens the transaction for
/// `key`, runs `write_core` against a key-bound [`AgentMembershipTx`], then
/// commits; a `write_core` error or a commit failure rolls the whole
/// transaction back and surfaces as the returned error.
///
/// The callback shape is PROVISIONAL for the reason on
/// [`enroll_agent_into_workspace`]: it exists so a real second atomic entry
/// point can share that write-core, not to offer a generic transaction. It is
/// deliberately constrained — the callback reaches only the two
/// [`AgentMembershipTx`] faces, never a connection or raw statement.
pub trait AgentEnrollmentUnitOfWork: Clone + Send + Sync + 'static {
    fn enroll(
        &self,
        key: EnrollmentKey,
        write_core: impl FnOnce(
            &mut dyn AgentMembershipTx,
        ) -> Result<AgentWorkspaceMembership, PersistenceFailure>
        + Send,
    ) -> impl Future<Output = Result<AgentWorkspaceMembership, PersistenceFailure>> + Send;
}

/// Whether `principal` may enroll the given agent: its creator, or the system.
/// An agent principal never may. This is the enrollment authority door — the
/// immutable half of the rule, safe to decide before the write lock.
pub fn can_enroll_agent(principal: &Principal, agent: &AgentAuthorityFacts) -> bool {
    match principal {
        Principal::System => true,
        Principal::Agent { .. } => false,
        Principal::Human { user_id } => *user_id == agent.created_by_user_id,
    }
}

/// The in-transaction write-core: the membership row plus the capability
/// default-seed, with the seed policy held here rather than in the adapter.
///
/// PROVISIONAL shape: it is a free function over the tx scope (not a method) so
/// a second atomic entry point — the conversation member-add auto-provision
/// door in the TS contract — can reuse the exact "seed only when created" rule
/// when it migrates. Only the workspace-member-add use case calls it in Rust
/// today; if that second door lands without reusing it, fold this back into a
/// plain semantic method on the unit of work.
pub fn enroll_agent_into_workspace(
    tx: &mut dyn AgentMembershipTx,
) -> Result<AgentWorkspaceMembership, PersistenceFailure> {
    let inserted = tx.insert_workspace_membership()?;
    if inserted.created {
        tx.seed_capability_defaults()?;
    }
    Ok(inserted.member)
}

/// Enroll an agent as a member of a regular workspace.
///
/// The caller's workspace-role floor is enforced at the request boundary; this
/// use case owns the enrollment-authority door and the atomic write. A missing
/// agent is refused before authority is considered, so even a system caller
/// gets `AgentNotFound` for an id that does not exist.
pub async fn add_workspace_agent_member<R, U>(
    reads: &R,
    uow: &U,
    principal: &Principal,
    workspace_id: WorkspaceId,
    agent_id: AgentId,
) -> Result<AgentWorkspaceMembership, AddAgentMemberError>
where
    R: AgentEnrollmentReadPort,
    U: AgentEnrollmentUnitOfWork,
{
    let Some(agent) = reads.agent(&agent_id).await? else {
        return Err(AddAgentMemberError::AgentNotFound);
    };
    if !can_enroll_agent(principal, &agent) {
        return Err(AddAgentMemberError::AgentNotOwned);
    }
    let key = EnrollmentKey {
        workspace_id,
        agent_id,
    };
    let member = uow.enroll(key, enroll_agent_into_workspace).await?;
    Ok(member)
}
