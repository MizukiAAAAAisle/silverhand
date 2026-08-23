//! Human workspace enrollment: placing a person as a member of a regular
//! workspace.
//!
//! Like agent enrollment, two authorization doors guard this write and stay
//! distinct. The request-boundary door (the workspace-governance context) answers
//! *whose roster this is* and, for the PEOPLE roster, requires `admin` governance
//! — but that verdict is sampled before any lock and can go stale (a demotion may
//! commit in the seam). So the write itself re-derives the actor's authority from
//! the role row read INSIDE the transaction and refuses by rollback if the actor
//! no longer governs. That in-lock re-derivation is a genuine concurrency door,
//! separate from the boundary gate, and it is the reason the unit of work — not
//! the caller — owns the actor's authority on this path.
//!
//! The write is one async semantic operation, [`HumanEnrollmentUnitOfWork::
//! enroll_human`]: an idempotent `INSERT OR IGNORE` of the membership row at the
//! default `member` role, stamped with the application's `joined_at_candidate`.
//! A re-enrollment keeps the existing row unchanged — its original role (which
//! may be `owner`) and its original join time — which is why the returned member
//! is re-read from the row rather than assumed. On a genuine create, and only
//! then, the application announces the new membership through the slice-local
//! [`ViewerWorkspacesChangedSink`]; that announce is best-effort and never flips
//! the committed enrollment.

use std::future::Future;

use thiserror::Error;

use super::agent_enrollment::{Principal, UserId, WorkspaceId};
use super::clock::EnrollmentClock;
use super::role::{WorkspaceRole, role_governs_workspace};
use crate::persistence::PersistenceFailure;

/// A person's display identity, resolved for the enrollment response. Read
/// through [`HumanEnrollmentReadPort`] before the write, because "does this user
/// exist" is a `404` that must not take a write lock. The write itself needs only
/// the id; these fields exist so the surface can project the enrolled member.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HumanUser {
    pub id: UserId,
    pub name: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A person's membership in a workspace, as the application sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceUserMembership {
    pub workspace_id: WorkspaceId,
    pub user_id: UserId,
    pub joined_at_ms: i64,
    /// The row's authoritative governance role. On a create it is `member`; on a
    /// re-enrollment it is whatever the existing row holds (possibly `owner`),
    /// because the idempotent write never demotes.
    pub role: WorkspaceRole,
}

/// Why a human enrollment was refused. Unlike agent enrollment — whose authority
/// (creator-ownership) is immutable and decided before the lock — the human
/// authority is mutable, so `Forbidden` originates INSIDE the transaction when
/// the actor's in-lock role no longer governs.
#[derive(Debug, Error)]
pub enum AddHumanMemberError {
    #[error("caller no longer governs the workspace people roster")]
    Forbidden,
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
}

/// The read seam this enrollment needs: a person's display identity, or `None`
/// when no such user exists — which is itself the `user not found` answer the
/// surface maps to `404`. Scoped to enrollment; not a general user directory.
pub trait HumanEnrollmentReadPort: Clone + Send + Sync + 'static {
    fn user(
        &self,
        user_id: &UserId,
    ) -> impl Future<Output = Result<Option<HumanUser>, PersistenceFailure>> + Send;
}

/// Whose membership in which workspace one human enrollment touches. Every writer
/// of this pair's membership must serialize on the same key, or nothing is
/// ordered against a concurrent removal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HumanEnrollmentKey {
    pub workspace_id: WorkspaceId,
    pub user_id: UserId,
}

/// The outcome of the atomic write: the (existing or freshly created) membership
/// and whether THIS transaction created it — decided under the lock from the
/// write's own effect, never a read taken before it. `created` gates the
/// exactly-once announce.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HumanEnrollmentCommit {
    pub member: WorkspaceUserMembership,
    pub created: bool,
}

/// One atomic, key-serialized human enrollment.
///
/// The adapter opens a `BEGIN IMMEDIATE` transaction for `key`, re-reads the
/// `actor`'s workspace role UNDER THE LOCK and refuses — rolling the transaction
/// back to [`AddHumanMemberError::Forbidden`] — when [`human_enrollment_authorized`]
/// denies it, then idempotently inserts the membership row at the default
/// `member` role stamped with `joined_at_candidate`. It returns the row re-read
/// from storage (so a re-enrollment reports the unchanged role and join time) and
/// whether the insert created it.
///
/// The actor's authority is re-derived here rather than trusted from the caller
/// precisely because a boundary gate and the write it authorizes are two points
/// in time; the same lock that orders the write makes the actor's role fact
/// authoritative. The join-time candidate and the authorization RULE
/// ([`human_enrollment_authorized`]) both live in the application layer and cross
/// this boundary as data and as a pure function; no transaction handle, SQL
/// statement, or driver type ever does.
pub trait HumanEnrollmentUnitOfWork: Clone + Send + Sync + 'static {
    fn enroll_human(
        &self,
        key: HumanEnrollmentKey,
        actor: Principal,
        joined_at_candidate: i64,
    ) -> impl Future<Output = Result<HumanEnrollmentCommit, AddHumanMemberError>> + Send;
}

/// The slice-local outbound capability: announce that a viewer GAINED membership
/// in a workspace, so their workspace read model can refetch. It is a named fact,
/// not a generic event bus — this slice emits exactly one kind of change and says
/// so in the type.
///
/// The announce is best-effort: the enrollment has already committed by the time
/// it runs, so a failure here must never flip the result. Implementations own
/// logging their own failure; the real event-bus adapter and its composition into
/// the served application are an integration residual outside this slice.
pub trait ViewerWorkspacesChangedSink: Clone + Send + Sync + 'static {
    fn viewer_added_to_workspace(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        role: WorkspaceRole,
    ) -> impl Future<Output = Result<(), PersistenceFailure>> + Send;
}

/// Whether `actor` may enroll a human, decided from the actor's workspace role as
/// read UNDER THE LOCK. `system` passes every governance gate, an agent principal
/// holds no workspace role and never governs, and a human governs iff their role
/// is `admin` or `owner`. This is the RULE the in-lock re-derivation applies; the
/// FACT (the role) is supplied by the unit of work from inside its transaction.
pub fn human_enrollment_authorized(actor: &Principal, actor_role: Option<WorkspaceRole>) -> bool {
    match actor {
        Principal::System => true,
        Principal::Agent { .. } => false,
        Principal::Human { .. } => role_governs_workspace(actor_role),
    }
}

/// Enroll a person as a member of a regular workspace.
///
/// The caller's `admin` floor is enforced at the request boundary; this use case
/// owns the atomic write and its in-lock authority re-derivation. The join-time
/// candidate is sampled from `clock` before the write opens — it stamps a create
/// and is ignored by the idempotent insert on a re-enrollment — and the clock is
/// infallible (mirroring `Date.now()`), so it adds no failure path.
///
/// On a genuine create, the new membership is announced through `sink` exactly
/// once; the announce is best-effort and does not affect the returned member.
pub async fn add_workspace_human_member<U, S, C>(
    uow: &U,
    sink: &S,
    clock: &C,
    actor: &Principal,
    workspace_id: WorkspaceId,
    user_id: UserId,
) -> Result<WorkspaceUserMembership, AddHumanMemberError>
where
    U: HumanEnrollmentUnitOfWork,
    S: ViewerWorkspacesChangedSink,
    C: EnrollmentClock,
{
    let joined_at_candidate = clock.now_unix_millis();
    let key = HumanEnrollmentKey {
        workspace_id,
        user_id,
    };
    let commit = uow
        .enroll_human(key, actor.clone(), joined_at_candidate)
        .await?;

    if commit.created {
        // The enrollment has committed; a failed announce must not flip it. The
        // sink adapter owns logging its own failure (the real event-bus adapter
        // is an integration residual), so here we only guarantee the committed
        // result stands and that a re-enrollment — which did not create — stays
        // silent.
        let _ = sink
            .viewer_added_to_workspace(
                &commit.member.user_id,
                &commit.member.workspace_id,
                commit.member.role,
            )
            .await;
    }

    Ok(commit.member)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone, Default)]
    struct RecordingSink {
        announces: Arc<AtomicUsize>,
    }

    impl ViewerWorkspacesChangedSink for RecordingSink {
        async fn viewer_added_to_workspace(
            &self,
            _user_id: &UserId,
            _workspace_id: &WorkspaceId,
            _role: WorkspaceRole,
        ) -> Result<(), PersistenceFailure> {
            self.announces.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    /// A unit of work that commits at a fixed role and reports `created` from a
    /// flag, so the exactly-once announce can be exercised for both a create and
    /// a re-enrollment without a database.
    #[derive(Clone)]
    struct FixedUow {
        created: bool,
        role: WorkspaceRole,
    }

    impl HumanEnrollmentUnitOfWork for FixedUow {
        async fn enroll_human(
            &self,
            key: HumanEnrollmentKey,
            _actor: Principal,
            joined_at_candidate: i64,
        ) -> Result<HumanEnrollmentCommit, AddHumanMemberError> {
            Ok(HumanEnrollmentCommit {
                member: WorkspaceUserMembership {
                    workspace_id: key.workspace_id,
                    user_id: key.user_id,
                    joined_at_ms: joined_at_candidate,
                    role: self.role,
                },
                created: self.created,
            })
        }
    }

    #[derive(Clone, Copy)]
    struct FixedClock(i64);
    impl EnrollmentClock for FixedClock {
        fn now_unix_millis(&self) -> i64 {
            self.0
        }
    }

    fn admin() -> Principal {
        Principal::Human {
            user_id: UserId::new("actor"),
        }
    }

    #[test]
    fn the_system_principal_governs_without_a_role() {
        assert!(human_enrollment_authorized(&Principal::System, None));
    }

    #[test]
    fn an_agent_principal_never_governs_even_with_a_role_fact() {
        let actor = Principal::Agent {
            agent_id: super::super::AgentId::new("a"),
        };
        assert!(!human_enrollment_authorized(
            &actor,
            Some(WorkspaceRole::Owner)
        ));
    }

    #[test]
    fn a_human_governs_only_at_admin_or_above() {
        assert!(human_enrollment_authorized(
            &admin(),
            Some(WorkspaceRole::Admin)
        ));
        assert!(human_enrollment_authorized(
            &admin(),
            Some(WorkspaceRole::Owner)
        ));
        assert!(!human_enrollment_authorized(
            &admin(),
            Some(WorkspaceRole::Member)
        ));
        assert!(!human_enrollment_authorized(&admin(), None));
    }

    #[tokio::test]
    async fn a_create_announces_exactly_once_and_returns_the_stamped_member() {
        let sink = RecordingSink::default();
        let uow = FixedUow {
            created: true,
            role: WorkspaceRole::Member,
        };

        let member = add_workspace_human_member(
            &uow,
            &sink,
            &FixedClock(1_700_000_000_123),
            &admin(),
            WorkspaceId::new("ws"),
            UserId::new("invitee"),
        )
        .await
        .unwrap();

        assert_eq!(member.joined_at_ms, 1_700_000_000_123);
        assert_eq!(member.role, WorkspaceRole::Member);
        assert_eq!(
            sink.announces.load(Ordering::SeqCst),
            1,
            "a genuine create announces exactly once"
        );
    }

    #[tokio::test]
    async fn a_re_enrollment_does_not_announce_and_preserves_the_existing_role() {
        let sink = RecordingSink::default();
        let uow = FixedUow {
            created: false,
            role: WorkspaceRole::Owner,
        };

        let member = add_workspace_human_member(
            &uow,
            &sink,
            &FixedClock(42),
            &admin(),
            WorkspaceId::new("ws"),
            UserId::new("owner"),
        )
        .await
        .unwrap();

        assert_eq!(
            member.role,
            WorkspaceRole::Owner,
            "a re-enrollment reports the unchanged role, never a demotion to member"
        );
        assert_eq!(
            sink.announces.load(Ordering::SeqCst),
            0,
            "a re-enrollment announces nothing"
        );
    }
}
