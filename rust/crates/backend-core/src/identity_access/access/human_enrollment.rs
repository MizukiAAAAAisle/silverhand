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
//! [`ViewerWorkspacesChangedSink`]. That announce runs after the commit, so it can
//! never emit a phantom event, and it can never flip the committed enrollment —
//! but it is not swallowed either: its fate comes back as [`ViewerAnnounce`], for
//! the boundary that owns observability to record.

use std::future::Future;

use thiserror::Error;

use super::clock::EnrollmentClock;
use super::role::{WorkspaceRole, role_governs_workspace};
use crate::foundation::identity::Principal;
use crate::{
    foundation::identity::{UserId, WorkspaceId},
    foundation::persistence::PersistenceFailure,
};

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
/// Its failure is [`ViewerAnnounceFailure`] and deliberately NOT a
/// `PersistenceFailure`: announcing is not storing. A transport that could not
/// reach a viewer has lost a notification, not corrupted a fact, and calling it
/// persistence would send a reader looking for a database problem that is not
/// there.
///
/// The announce is best-effort in the sense that it can never flip the committed
/// enrollment — but "best-effort" is not "unobserved": the outcome is carried back
/// to the caller as [`ViewerAnnounce`], because a lost notification leaves a
/// client stale until it refetches and somebody has to be able to say so.
pub trait ViewerWorkspacesChangedSink: Clone + Send + Sync + 'static {
    fn viewer_added_to_workspace(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        role: WorkspaceRole,
    ) -> impl Future<Output = Result<(), ViewerAnnounceFailure>> + Send;
}

/// An outward announce could not be delivered. Opaque like
/// [`PersistenceFailure`] and for the same reason — the transport's concrete
/// error stays available as the `source` for the boundary that records it, while
/// no transport type leaks into the application layer.
///
/// Deliberately NOT the messaging context's `EffectFailure`, which is the same
/// shape: that type belongs to messaging's post-commit capabilities, and having
/// enrollment import it would make this context depend on that one for a concept
/// it merely shares. Messaging's own rule is that each capability owns its
/// failure. If the two ever want one name, the move is to promote a single
/// crate-level post-commit failure that both contexts consume — not to reach
/// sideways.
#[derive(Debug, Error)]
#[error("viewer workspace announce could not be delivered")]
pub struct ViewerAnnounceFailure {
    #[source]
    source: Box<dyn std::error::Error + Send + Sync + 'static>,
}

impl ViewerAnnounceFailure {
    pub fn from_source<E>(source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

/// What became of the post-commit announce — a value the enrollment hands back
/// rather than a `Result` its caller may quietly drop. Not a `Result` for the same
/// reason messaging's post-commit report is not one: the enrollment happened, and
/// nothing here can unhappen it.
///
/// The three arms are the three distinct facts a boundary may need to record, and
/// keeping them distinct is the point: `NotOwed` (nothing was created, so nothing
/// was announced and there is nothing to log) must not be confused with
/// `Delivered`, and neither with `Failed`, which is the only one that leaves a
/// client stale.
#[derive(Debug)]
pub enum ViewerAnnounce {
    /// No announce was owed: this request enrolled nobody new, so the sink was
    /// never called. A re-enrollment lands here and is silent by construction.
    NotOwed,
    /// The announce was owed and the sink accepted it.
    Delivered,
    /// The announce was owed and could not be delivered. The enrollment is
    /// committed regardless; the viewer simply was not told, so their read model
    /// stays stale until it refetches for another reason.
    Failed(ViewerAnnounceFailure),
}

/// A committed enrollment together with the fate of its announce.
///
/// The two travel together because they are one request's outcome: the membership
/// is the product answer, and the announce is a side obligation that either was
/// not owed, was met, or was lost. The fields are SEALED and reachable only through
/// [`into_parts`](Self::into_parts), which yields both at once — so a caller cannot
/// take the `member` while letting the [`ViewerAnnounce`] fall on the floor.
///
/// This is a *sealed outcome plus a `#[must_use]` guard*, not a linear type: Rust
/// cannot force the returned value to be consumed at all. What it does force is that
/// any consumer who opens it receives the announce in the same move and must name
/// it, and `#[must_use]` makes an outright discard a warning. The one production
/// consumer matches that announce exhaustively (no `_` arm), so a future new
/// [`ViewerAnnounce`] arm breaks the build rather than being silently ignored.
#[derive(Debug)]
#[must_use = "a committed enrollment carries an announce outcome that must be recorded"]
pub struct HumanEnrollmentOutcome {
    member: WorkspaceUserMembership,
    announce: ViewerAnnounce,
}

impl HumanEnrollmentOutcome {
    /// Split the outcome into its two halves at once: the committed membership and
    /// the fate of its announce. This is the ONLY way to reach either, so a caller
    /// that wants the member necessarily receives the announce in the same move.
    pub fn into_parts(self) -> (WorkspaceUserMembership, ViewerAnnounce) {
        (self.member, self.announce)
    }
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
/// On a genuine create, and only then, the new membership is announced through
/// `sink` exactly once. The announce runs strictly AFTER the commit, so a
/// rolled-back write can never emit a phantom event, and its fate never touches
/// the returned member — it is reported beside it as
/// [`ViewerAnnounce`](HumanEnrollmentOutcome::announce) for the boundary to record.
pub async fn add_workspace_human_member<U, S, C>(
    uow: &U,
    sink: &S,
    clock: &C,
    actor: &Principal,
    workspace_id: WorkspaceId,
    user_id: UserId,
) -> Result<HumanEnrollmentOutcome, AddHumanMemberError>
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

    // The role announced is the one the WRITE returned, re-read from the row —
    // never the `member` default the insert bound, so the announce can never
    // describe a membership the database does not hold.
    let announce = if commit.created {
        match sink
            .viewer_added_to_workspace(
                &commit.member.user_id,
                &commit.member.workspace_id,
                commit.member.role,
            )
            .await
        {
            Ok(()) => ViewerAnnounce::Delivered,
            Err(cause) => ViewerAnnounce::Failed(cause),
        }
    } else {
        ViewerAnnounce::NotOwed
    };

    Ok(HumanEnrollmentOutcome {
        member: commit.member,
        announce,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error as _;
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
        ) -> Result<(), ViewerAnnounceFailure> {
            self.announces.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[derive(Debug, Error)]
    #[error("the transport was unreachable")]
    struct TransportDown;

    /// A sink that always refuses, so the lost-announce arm is exercised without a
    /// transport — and counts its calls, so "called once and failed" stays
    /// distinguishable from "never called".
    #[derive(Clone, Default)]
    struct FailingSink {
        attempts: Arc<AtomicUsize>,
    }

    impl ViewerWorkspacesChangedSink for FailingSink {
        async fn viewer_added_to_workspace(
            &self,
            _user_id: &UserId,
            _workspace_id: &WorkspaceId,
            _role: WorkspaceRole,
        ) -> Result<(), ViewerAnnounceFailure> {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            Err(ViewerAnnounceFailure::from_source(TransportDown))
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
            user_id: UserId::parse("actor").unwrap(),
        }
    }

    #[test]
    fn the_system_principal_governs_without_a_role() {
        assert!(human_enrollment_authorized(&Principal::System, None));
    }

    #[test]
    fn an_agent_principal_never_governs_even_with_a_role_fact() {
        let actor = Principal::Agent {
            agent_id: crate::foundation::identity::AgentId::parse("a").unwrap(),
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

        let (member, announce) = add_workspace_human_member(
            &uow,
            &sink,
            &FixedClock(1_700_000_000_123),
            &admin(),
            WorkspaceId::parse("ws").unwrap(),
            UserId::parse("invitee").unwrap(),
        )
        .await
        .unwrap()
        .into_parts();

        assert_eq!(member.joined_at_ms, 1_700_000_000_123);
        assert_eq!(member.role, WorkspaceRole::Member);
        assert!(matches!(announce, ViewerAnnounce::Delivered));
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

        let (member, announce) = add_workspace_human_member(
            &uow,
            &sink,
            &FixedClock(42),
            &admin(),
            WorkspaceId::parse("ws").unwrap(),
            UserId::parse("owner").unwrap(),
        )
        .await
        .unwrap()
        .into_parts();

        assert_eq!(
            member.role,
            WorkspaceRole::Owner,
            "a re-enrollment reports the unchanged role, never a demotion to member"
        );
        assert!(
            matches!(announce, ViewerAnnounce::NotOwed),
            "nothing was created, so no announce was owed — not a delivered one"
        );
        assert_eq!(
            sink.announces.load(Ordering::SeqCst),
            0,
            "a re-enrollment announces nothing"
        );
    }

    #[tokio::test]
    async fn a_lost_announce_leaves_the_enrollment_committed_and_names_its_cause() {
        let sink = FailingSink::default();
        let uow = FixedUow {
            created: true,
            role: WorkspaceRole::Member,
        };

        let (member, announce) = add_workspace_human_member(
            &uow,
            &sink,
            &FixedClock(7),
            &admin(),
            WorkspaceId::parse("ws").unwrap(),
            UserId::parse("invitee").unwrap(),
        )
        .await
        .expect("a lost announce is not an enrollment failure")
        .into_parts();

        assert_eq!(
            member.joined_at_ms, 7,
            "the committed membership stands exactly as written"
        );
        assert_eq!(sink.attempts.load(Ordering::SeqCst), 1);

        let ViewerAnnounce::Failed(cause) = announce else {
            panic!("a refused sink must surface the loss, not report delivery");
        };
        // The transport's own error survives as the source, so a boundary can log
        // the whole chain instead of an opaque "announce failed".
        assert_eq!(
            cause.to_string(),
            "viewer workspace announce could not be delivered"
        );
        assert_eq!(
            cause.source().unwrap().to_string(),
            "the transport was unreachable"
        );
    }
}
