//! Driver-free contract test for human workspace enrollment.
//!
//! `FakeAccess` implements the unit of work and the viewer-workspaces sink with
//! no persistence technology in scope. Its `enroll_human` models the one atomic
//! transaction faithfully: it re-derives the actor's authority from the role it
//! reads *inside* the lock (via the same `human_enrollment_authorized` rule the
//! SQLite adapter applies), refuses by rollback when the actor no longer governs,
//! and otherwise writes the roster row idempotently — a fresh pair is created at
//! the default `member` role, an existing one is kept unchanged. This exercises
//! the in-lock authority door and the create-only announce at the application
//! boundary, independent of any driver.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use silverhand_backend_core::access::{
    AddHumanMemberError, EnrollmentClock, HumanEnrollmentCommit, HumanEnrollmentKey,
    HumanEnrollmentOutcome, HumanEnrollmentUnitOfWork, Principal, ViewerAnnounce,
    ViewerAnnounceFailure, ViewerWorkspacesChangedSink, WorkspaceRole, WorkspaceUserMembership,
    add_workspace_human_member, human_enrollment_authorized,
};
use silverhand_backend_core::identity::{AgentId, UserId, WorkspaceId};
use silverhand_backend_core::persistence::PersistenceFailure;

const JOINED_AT_MS: i64 = 1_700_000_000_000;

#[derive(Clone, Copy)]
struct FixedClock(i64);

impl EnrollmentClock for FixedClock {
    fn now_unix_millis(&self) -> i64 {
        self.0
    }
}

fn clock() -> FixedClock {
    FixedClock(JOINED_AT_MS)
}

#[derive(Debug)]
struct DriverError(&'static str);
impl std::fmt::Display for DriverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for DriverError {}

#[derive(Default)]
struct Store {
    /// The actors' governance rows: `user_id -> role`. An actor absent here holds
    /// no role, exactly as a non-member reads under the lock.
    roles: HashMap<String, WorkspaceRole>,
    /// The roster rows this enrollment writes: `user_id -> (joined_at, role)`.
    memberships: HashMap<String, (i64, WorkspaceRole)>,
}

#[derive(Clone, Default)]
struct FakeAccess {
    store: Arc<Mutex<Store>>,
    announces: Arc<Mutex<Vec<String>>>,
    fail_write: bool,
    fail_sink: bool,
}

impl FakeAccess {
    fn with_role(self, user: &str, role: WorkspaceRole) -> Self {
        self.store
            .lock()
            .unwrap()
            .roles
            .insert(user.to_owned(), role);
        self
    }

    fn with_member(self, user: &str, joined_at: i64, role: WorkspaceRole) -> Self {
        self.store
            .lock()
            .unwrap()
            .memberships
            .insert(user.to_owned(), (joined_at, role));
        self
    }
}

impl HumanEnrollmentUnitOfWork for FakeAccess {
    async fn enroll_human(
        &self,
        key: HumanEnrollmentKey,
        actor: Principal,
        joined_at_candidate: i64,
    ) -> Result<HumanEnrollmentCommit, AddHumanMemberError> {
        // One lock: the authority re-read, the idempotent write and its re-read
        // all happen under it, or nothing does.
        let mut store = self.store.lock().unwrap();

        // In-lock authority re-derivation: only a human principal has a role row
        // to read; the rule decides the rest without one.
        let actor_role = match &actor {
            Principal::Human { user_id } => store.roles.get(user_id.as_str()).copied(),
            _ => None,
        };
        if !human_enrollment_authorized(&actor, actor_role) {
            // Dropping out here writes nothing — the rollback.
            return Err(AddHumanMemberError::Forbidden);
        }

        if self.fail_write {
            return Err(AddHumanMemberError::Persistence(
                PersistenceFailure::from_source(DriverError("insert failed")),
            ));
        }

        // INSERT OR IGNORE: a fresh pair is created at the default member role;
        // an existing one is kept, so its role and join time never change.
        let user = key.user_id.as_str().to_owned();
        let created = !store.memberships.contains_key(&user);
        if created {
            store
                .memberships
                .insert(user.clone(), (joined_at_candidate, WorkspaceRole::Member));
        }
        let (stored_joined_at, role) = store.memberships[&user];

        Ok(HumanEnrollmentCommit {
            member: WorkspaceUserMembership {
                workspace_id: key.workspace_id,
                user_id: key.user_id,
                joined_at_ms: stored_joined_at,
                role,
            },
            created,
        })
    }
}

impl ViewerWorkspacesChangedSink for FakeAccess {
    async fn viewer_added_to_workspace(
        &self,
        user_id: &UserId,
        _workspace_id: &WorkspaceId,
        _role: WorkspaceRole,
    ) -> Result<(), ViewerAnnounceFailure> {
        if self.fail_sink {
            return Err(ViewerAnnounceFailure::from_source(DriverError(
                "sink failed",
            )));
        }
        self.announces
            .lock()
            .unwrap()
            .push(user_id.as_str().to_owned());
        Ok(())
    }
}

fn ws() -> WorkspaceId {
    WorkspaceId::parse("ws-1").unwrap()
}

fn human(user: &str) -> Principal {
    Principal::Human {
        user_id: UserId::parse(user).unwrap(),
    }
}

async fn enroll(
    fake: &FakeAccess,
    actor: Principal,
    target: &str,
) -> Result<HumanEnrollmentOutcome, AddHumanMemberError> {
    add_workspace_human_member(
        fake,
        fake,
        &clock(),
        &actor,
        ws(),
        UserId::parse(target).unwrap(),
    )
    .await
}

#[tokio::test]
async fn an_admin_creates_a_member_at_the_clock_join_time_and_announces_once() {
    let fake = FakeAccess::default().with_role("admin", WorkspaceRole::Admin);

    let outcome = enroll(&fake, human("admin"), "invitee").await.unwrap();

    assert_eq!(outcome.member.role, WorkspaceRole::Member);
    assert_eq!(outcome.member.joined_at_ms, JOINED_AT_MS);
    assert!(matches!(outcome.announce, ViewerAnnounce::Delivered));
    assert_eq!(fake.announces.lock().unwrap().as_slice(), ["invitee"]);
}

#[tokio::test]
async fn a_re_enrollment_keeps_the_existing_role_and_join_time_and_is_silent() {
    let fake = FakeAccess::default()
        .with_role("admin", WorkspaceRole::Admin)
        .with_member("invitee", 111, WorkspaceRole::Owner);

    let outcome = enroll(&fake, human("admin"), "invitee").await.unwrap();

    assert_eq!(
        outcome.member.role,
        WorkspaceRole::Owner,
        "the idempotent write never demotes the existing owner"
    );
    assert_eq!(
        outcome.member.joined_at_ms, 111,
        "the original join time is kept"
    );
    assert!(
        matches!(outcome.announce, ViewerAnnounce::NotOwed),
        "no announce was OWED — which is a different fact from one delivered"
    );
    assert!(
        fake.announces.lock().unwrap().is_empty(),
        "a re-enrollment created nothing, so it announces nothing"
    );
}

#[tokio::test]
async fn a_member_actor_is_refused_in_the_lock_and_writes_nothing() {
    let fake = FakeAccess::default().with_role("plain", WorkspaceRole::Member);

    let err = enroll(&fake, human("plain"), "invitee").await.unwrap_err();

    assert!(matches!(err, AddHumanMemberError::Forbidden));
    assert!(
        fake.store.lock().unwrap().memberships.is_empty(),
        "the rollback left no roster row"
    );
    assert!(fake.announces.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_actor_who_holds_no_role_is_refused() {
    // A human with no workspace_users row does not govern.
    let fake = FakeAccess::default();

    let err = enroll(&fake, human("stranger"), "invitee")
        .await
        .unwrap_err();

    assert!(matches!(err, AddHumanMemberError::Forbidden));
    assert!(fake.store.lock().unwrap().memberships.is_empty());
}

#[tokio::test]
async fn an_agent_principal_can_never_enroll() {
    let fake = FakeAccess::default();
    let actor = Principal::Agent {
        agent_id: AgentId::parse("agent-1").unwrap(),
    };

    let err = enroll(&fake, actor, "invitee").await.unwrap_err();

    assert!(matches!(err, AddHumanMemberError::Forbidden));
}

#[tokio::test]
async fn the_system_principal_enrolls_without_a_role_row() {
    let fake = FakeAccess::default();

    let outcome = enroll(&fake, Principal::System, "invitee").await.unwrap();

    assert_eq!(outcome.member.role, WorkspaceRole::Member);
    assert_eq!(fake.announces.lock().unwrap().as_slice(), ["invitee"]);
}

#[tokio::test]
async fn a_write_failure_surfaces_as_persistence_and_announces_nothing() {
    let mut fake = FakeAccess::default().with_role("admin", WorkspaceRole::Admin);
    fake.fail_write = true;

    let err = enroll(&fake, human("admin"), "invitee").await.unwrap_err();

    match err {
        AddHumanMemberError::Persistence(cause) => {
            assert!(
                std::error::Error::source(&cause).is_some(),
                "cause preserved"
            );
        }
        other => panic!("expected persistence failure, got {other:?}"),
    }
    assert!(fake.store.lock().unwrap().memberships.is_empty());
    assert!(fake.announces.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_failing_announce_does_not_flip_the_committed_enrollment() {
    let mut fake = FakeAccess::default().with_role("admin", WorkspaceRole::Admin);
    fake.fail_sink = true;

    // The write has committed by the time the announce runs; a sink failure can
    // never turn a committed create into an error — but it is reported, not
    // swallowed, so a caller cannot fail to notice the viewer went untold.
    let outcome = enroll(&fake, human("admin"), "invitee").await.unwrap();

    assert_eq!(outcome.member.role, WorkspaceRole::Member);
    assert_eq!(
        fake.store.lock().unwrap().memberships.get("invitee"),
        Some(&(JOINED_AT_MS, WorkspaceRole::Member)),
        "the enrollment stands despite the failed announce"
    );

    let ViewerAnnounce::Failed(cause) = outcome.announce else {
        panic!("a refused sink must be reported as a LOSS, not as NotOwed or Delivered");
    };
    // The sink's own error survives as the chain's tail, so the boundary that logs
    // it can name the real reason rather than "announce failed".
    assert_eq!(
        std::error::Error::source(&cause).unwrap().to_string(),
        "sink failed"
    );
}
