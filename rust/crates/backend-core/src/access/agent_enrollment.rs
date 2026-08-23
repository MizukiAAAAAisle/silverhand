//! Agent workspace enrollment: placing an agent as a member of a regular
//! workspace.
//!
//! Two independent authorization doors guard this write and stay distinct:
//! the caller's workspace role (governed at the request boundary) answers
//! *whose roster this is*, while enrolling a *specific* agent is its creator's
//! authority — a workspace admin may not place someone else's agent. This
//! module owns the second door and the atomic write.
//!
//! The write is one async semantic operation, [`AgentEnrollmentUnitOfWork::
//! enroll_agent`]. The adapter runs the idempotent membership insert and the
//! create-only capability seed inside a single `BEGIN IMMEDIATE` transaction and
//! learns `created` from that insert's own affected-row count — never a read
//! taken before it. The application decides authorization synchronously and
//! hands the seed policy across as data; it never holds a transaction handle, a
//! SQL statement, or a driver type.

use std::future::Future;

use thiserror::Error;

use super::clock::EnrollmentClock;
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

/// A capability that can be granted to an agent within a workspace. The set is
/// closed — an unknown capability is not expressible — so the persisted `CHECK`
/// constraint is mirrored by the type rather than duplicated as free text. Each
/// variant maps to one stable persisted token via [`Capability::as_str`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Capability {
    ReadMessages,
    SendMessages,
    ReadTasks,
    CreateTasks,
    WriteTasks,
    ReadAttachments,
    UploadAttachments,
    CreateThreads,
    CreateChannels,
    ManageConversationMembers,
    ManageSchedules,
}

impl Capability {
    /// The stable token this capability persists as. Adapters write exactly this
    /// string; nothing else may invent capability text.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReadMessages => "read_messages",
            Self::SendMessages => "send_messages",
            Self::ReadTasks => "read_tasks",
            Self::CreateTasks => "create_tasks",
            Self::WriteTasks => "write_tasks",
            Self::ReadAttachments => "read_attachments",
            Self::UploadAttachments => "upload_attachments",
            Self::CreateThreads => "create_threads",
            Self::CreateChannels => "create_channels",
            Self::ManageConversationMembers => "manage_conversation_members",
            Self::ManageSchedules => "manage_schedules",
        }
    }
}

/// The capabilities granted to a *freshly created* agent membership. Passing
/// this set to [`AgentEnrollmentUnitOfWork::enroll_agent`] is how the
/// application expresses the seed-only-on-create policy: the unit of work grants
/// exactly these when — and only when — it creates the membership row, so
/// re-enrolling a member never re-widens a set that was later narrowed. The set
/// lives here, in the application layer, not in any adapter.
pub const DEFAULT_AGENT_CAPABILITIES: [Capability; 11] = [
    Capability::ReadMessages,
    Capability::SendMessages,
    Capability::ReadTasks,
    Capability::CreateTasks,
    Capability::WriteTasks,
    Capability::ReadAttachments,
    Capability::UploadAttachments,
    Capability::CreateThreads,
    Capability::CreateChannels,
    Capability::ManageConversationMembers,
    Capability::ManageSchedules,
];

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

/// Whose membership in which workspace one enrollment touches. Every writer of
/// this pair's membership must serialize on the same key, or nothing is ordered
/// against a concurrent removal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnrollmentKey {
    pub workspace_id: WorkspaceId,
    pub agent_id: AgentId,
}

/// One atomic, key-serialized agent enrollment.
///
/// The adapter opens a `BEGIN IMMEDIATE` transaction for `key`, idempotently
/// inserts the membership row stamped with `joined_at_candidate`, and — only
/// when that insert *created* the row, decided from the write's own
/// affected-row count rather than a prior read — grants `seed_on_create` before
/// committing. Any failure rolls the whole transaction back and surfaces as the
/// returned error; a re-enrollment commits the unchanged membership, keeps the
/// original stored join time (the candidate is ignored on the no-op insert), and
/// touches no capabilities.
///
/// This is the only seam the application holds: a single business operation.
/// The seed set and the join-time candidate arrive as data so the create-only
/// capability policy and the time source both stay in the application, and no
/// transaction handle, SQL statement, or driver type ever crosses this boundary.
pub trait AgentEnrollmentUnitOfWork: Clone + Send + Sync + 'static {
    fn enroll_agent(
        &self,
        key: EnrollmentKey,
        seed_on_create: &[Capability],
        joined_at_candidate: i64,
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

/// Enroll an agent as a member of a regular workspace.
///
/// The caller's workspace-role floor is enforced at the request boundary; this
/// use case owns the enrollment-authority door and delegates the atomic write to
/// the unit of work. Authorization is decided synchronously and in order: a
/// missing agent is refused before authority is considered, so even a system
/// caller gets `AgentNotFound` for an id that does not exist, and only an
/// existing, owned agent reaches the write.
///
/// The join-time candidate is sampled from `clock` only *after* both doors
/// admit and *before* the write opens: the stamp belongs to an already-authorized
/// enrollment, and it is the create-only candidate the unit of work ignores on a
/// re-enrollment's no-op insert. The clock is infallible (mirroring `Date.now()`),
/// so reading it introduces no failure path this surface could not otherwise
/// express.
pub async fn add_workspace_agent_member<R, U, C>(
    reads: &R,
    uow: &U,
    clock: &C,
    principal: &Principal,
    workspace_id: WorkspaceId,
    agent_id: AgentId,
) -> Result<AgentWorkspaceMembership, AddAgentMemberError>
where
    R: AgentEnrollmentReadPort,
    U: AgentEnrollmentUnitOfWork,
    C: EnrollmentClock,
{
    let Some(agent) = reads.agent(&agent_id).await? else {
        return Err(AddAgentMemberError::AgentNotFound);
    };
    if !can_enroll_agent(principal, &agent) {
        return Err(AddAgentMemberError::AgentNotOwned);
    }
    let joined_at_candidate = clock.now_unix_millis();
    let key = EnrollmentKey {
        workspace_id,
        agent_id,
    };
    let member = uow
        .enroll_agent(key, &DEFAULT_AGENT_CAPABILITIES, joined_at_candidate)
        .await?;
    Ok(member)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn default_capabilities_map_to_the_persisted_tokens() {
        let tokens: Vec<&str> = DEFAULT_AGENT_CAPABILITIES
            .iter()
            .map(Capability::as_str)
            .collect();
        assert_eq!(
            tokens,
            [
                "read_messages",
                "send_messages",
                "read_tasks",
                "create_tasks",
                "write_tasks",
                "read_attachments",
                "upload_attachments",
                "create_threads",
                "create_channels",
                "manage_conversation_members",
                "manage_schedules",
            ]
        );
    }

    /// A read port that always resolves the agent to a single known owner, so the
    /// use case reaches the clock sample.
    #[derive(Clone)]
    struct OwnedByOwner;

    impl AgentEnrollmentReadPort for OwnedByOwner {
        async fn agent(
            &self,
            agent_id: &AgentId,
        ) -> Result<Option<AgentAuthorityFacts>, PersistenceFailure> {
            Ok(Some(AgentAuthorityFacts {
                id: agent_id.clone(),
                created_by_user_id: UserId::new("owner"),
            }))
        }
    }

    /// A unit of work that records whether it was ever entered. If the clock
    /// refuses before the write, this must stay `false`.
    #[derive(Clone, Default)]
    struct RecordingUow {
        entered: Arc<AtomicBool>,
    }

    impl AgentEnrollmentUnitOfWork for RecordingUow {
        async fn enroll_agent(
            &self,
            key: EnrollmentKey,
            _seed_on_create: &[Capability],
            joined_at_candidate: i64,
        ) -> Result<AgentWorkspaceMembership, PersistenceFailure> {
            self.entered.store(true, Ordering::SeqCst);
            Ok(AgentWorkspaceMembership {
                workspace_id: key.workspace_id,
                agent_id: key.agent_id,
                joined_at_ms: joined_at_candidate,
            })
        }
    }

    /// A clock that records whether it was sampled and yields a fixed candidate.
    /// The use case must sample it only after both doors admit, so on a refusal
    /// `sampled` must stay `false`.
    #[derive(Clone, Default)]
    struct RecordingClock {
        sampled: Arc<AtomicBool>,
        value: i64,
    }

    impl EnrollmentClock for RecordingClock {
        fn now_unix_millis(&self) -> i64 {
            self.sampled.store(true, Ordering::SeqCst);
            self.value
        }
    }

    /// A read port that resolves no agent, so the use case refuses with
    /// `AgentNotFound` before authority — and before the clock — is considered.
    #[derive(Clone)]
    struct NoAgent;

    impl AgentEnrollmentReadPort for NoAgent {
        async fn agent(
            &self,
            _agent_id: &AgentId,
        ) -> Result<Option<AgentAuthorityFacts>, PersistenceFailure> {
            Ok(None)
        }
    }

    fn owner() -> Principal {
        Principal::Human {
            user_id: UserId::new("owner"),
        }
    }

    #[tokio::test]
    async fn the_clock_is_sampled_after_admission_and_its_candidate_reaches_the_unit_of_work() {
        let uow = RecordingUow::default();
        let clock = RecordingClock {
            value: 1_700_000_000_123,
            ..RecordingClock::default()
        };

        let member = add_workspace_agent_member(
            &OwnedByOwner,
            &uow,
            &clock,
            &owner(),
            WorkspaceId::new("ws"),
            AgentId::new("agent"),
        )
        .await
        .unwrap();

        assert!(
            clock.sampled.load(Ordering::SeqCst),
            "an admitted enrollment must sample the clock"
        );
        assert!(
            uow.entered.load(Ordering::SeqCst),
            "an admitted enrollment must enter the unit of work"
        );
        assert_eq!(
            member.joined_at_ms, 1_700_000_000_123,
            "the sampled candidate must flow into the created membership"
        );
    }

    #[tokio::test]
    async fn a_refusal_before_authority_never_samples_the_clock_or_enters_the_unit_of_work() {
        let uow = RecordingUow::default();
        let clock = RecordingClock::default();

        let error = add_workspace_agent_member(
            &NoAgent,
            &uow,
            &clock,
            &owner(),
            WorkspaceId::new("ws"),
            AgentId::new("ghost"),
        )
        .await
        .unwrap_err();

        assert!(matches!(error, AddAgentMemberError::AgentNotFound));
        assert!(
            !clock.sampled.load(Ordering::SeqCst),
            "a refusal must never sample the clock"
        );
        assert!(
            !uow.entered.load(Ordering::SeqCst),
            "a refusal must never enter the unit of work"
        );
    }
}
