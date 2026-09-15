//! The embedded first-run application flow: turn a proven-loopback, token-bearing
//! request into a session for the single local viewer.
//!
//! This is the composition seam where the embedded-bootstrap context meets the
//! user-identity authority ([`crate::identity_access::user_identity`]) and the session authority
//! ([`crate::identity_access::auth`]). It mirrors the TS `routes.ts` embedded-bootstrap handler +
//! `UserAuthService.register`: decide 0/1/>1 viewers under ONE write lock, create
//! the profile-only local viewer on an empty DB (and backfill its owner
//! membership), select the sole viewer on a single-viewer DB, or refuse an
//! ambiguous multi-viewer DB — then, on either non-refusal, mint the ordinary
//! session exactly once.
//!
//! ## The count/decision is a WRITE-LOCK property, not a pre-read
//!
//! The 0/1/>1 verdict and every write it authorizes ride the SAME
//! `BEGIN IMMEDIATE` transaction inside [`EmbeddedBootstrapUnitOfWork`]: the count
//! is read while the writer lock is held, so a second concurrent bootstrap cannot
//! observe "0 users" and both create. The flow layer never reads the count itself
//! and never splits it from the create — the adapter's single unit of work is the
//! whole authority. Session mint and the `user_changed` announce are the flow's
//! own post-commit steps, exactly as `sign_up` composes them.

use std::future::Future;

use thiserror::Error;

use crate::{
    foundation::identity::UserId,
    foundation::persistence::PersistenceFailure,
    identity_access::auth::{
        IssuedSessionSecret, SessionAudit, SessionIssue, SessionMintError, SessionTokenMint,
    },
    identity_access::user_identity::{UserChangedAnnounce, UserChangedSink, UserRecord},
};

// ===========================================================================
// The atomic choose-or-create port owned by this application seam.
// ===========================================================================

/// The atomic single-viewer choose-or-create write. ONE `BEGIN IMMEDIATE`
/// transaction reads the viewer count under the write lock and, in the same
/// transaction:
///
/// - **0 viewers** → insert the profile-only local `users` row AND backfill it as
///   the owner of every pre-existing workspace (membership row + denormalized
///   `owner_user_id` pointer on every still-unowned workspace) and a member of
///   every pre-existing conversation, then return [`BootstrapChoice::Created`].
/// - **1 viewer** → select it and return [`BootstrapChoice::Selected`]; no writes.
/// - **>1 viewers** → return [`BootstrapChoice::Conflict`]; no writes.
///
/// Surrogate id allocation (mint, retry on a `user_id` collision) is a persistence
/// concern the adapter owns. Exhausting it is an infrastructure fault, hence a
/// [`PersistenceFailure`], never a product outcome. The adapter decides no product
/// policy beyond the count arithmetic — session mint, the announce, and the wire
/// answer are the flow's.
pub trait EmbeddedBootstrapUnitOfWork: Clone + Send + Sync + 'static {
    fn choose_or_create(
        &self,
        now_ms: i64,
    ) -> impl Future<Output = Result<BootstrapChoice, PersistenceFailure>> + Send;
}

/// The raw outcome of the choose-or-create write. The flow maps this onto the
/// product answer (session vs. refusal) and owns the post-commit effects; the
/// adapter neither mints nor announces.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BootstrapChoice {
    /// A brand-new profile-only local viewer was committed; carries the created
    /// row. This is the ONLY arm that owes a `user_changed` announce.
    Created { user: UserRecord },
    /// Exactly one viewer already existed and was selected; carries the row. No
    /// writes occurred, so nothing is announced.
    Selected { user: UserRecord },
    /// More than one viewer exists — the embedded single-viewer assumption is
    /// void. No writes occurred.
    Conflict,
}

// ===========================================================================
// The flow.
// ===========================================================================

/// Everything the bootstrap flow needs, minus the request. Grouping the ports
/// keeps the flow signature legible and mirrors the TS handler's collaborators.
pub struct BootstrapPorts<'a, Uow, Mint, Iss, Sink> {
    pub unit_of_work: &'a Uow,
    pub mint: &'a Mint,
    pub sessions: &'a Iss,
    pub user_changed: &'a Sink,
}

/// The closed outcome of [`bootstrap_session`].
pub enum EmbeddedBootstrap {
    /// The local viewer was created or selected and a session issued. Carries the
    /// profile, the one-time bearer plaintext, and the `user_changed` announce
    /// fate ([`UserChangedAnnounce::Delivered`]/`Failed` only on a create; always
    /// [`UserChangedAnnounce::NotOwed`] on a select).
    Session {
        user: UserRecord,
        secret: IssuedSessionSecret,
        announce: UserChangedAnnounce,
    },
    /// More than one viewer exists — the route's `409`. No session was minted and
    /// nothing was announced; the caller's already-consumed token stays
    /// permanently invalidated regardless.
    Ambiguous,
}

/// Why the embedded bootstrap could not yield a trustworthy answer. Every arm is a
/// safe-500 seam; the product outcomes (session/ambiguous) are the success enum's
/// arms, never an error.
#[derive(Debug, Error)]
pub enum EmbeddedBootstrapError {
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
    #[error(transparent)]
    Mint(#[from] SessionMintError),
}

/// Choose-or-create the single local viewer and, unless the DB is ambiguous, issue
/// its session. The write-lock-guarded verdict lives entirely in
/// [`EmbeddedBootstrapUnitOfWork::choose_or_create`]; this flow only maps the arm
/// and runs the post-commit effects.
///
/// Effect cardinality (a security/idempotency property): the `user_changed` hint
/// fires exactly once, and only on [`BootstrapChoice::Created`]; the session is
/// minted exactly once, on either non-refusal; a [`BootstrapChoice::Conflict`]
/// mints nothing and announces nothing.
pub async fn bootstrap_session<Uow, Mint, Iss, Sink>(
    ports: BootstrapPorts<'_, Uow, Mint, Iss, Sink>,
    audit: &SessionAudit,
    now_ms: i64,
) -> Result<EmbeddedBootstrap, EmbeddedBootstrapError>
where
    Uow: EmbeddedBootstrapUnitOfWork,
    Mint: SessionTokenMint,
    Iss: SessionIssue,
    Sink: UserChangedSink,
{
    match ports.unit_of_work.choose_or_create(now_ms).await? {
        BootstrapChoice::Created { user } => {
            // The one arm that mutated the directory owes the post-commit hint, and
            // it owes it before the session so a lost hint never blocks the answer.
            let announce = announce_user_changed(ports.user_changed, &user.id).await;
            let secret = issue_session(ports.mint, ports.sessions, &user.id, audit, now_ms).await?;
            Ok(EmbeddedBootstrap::Session {
                user,
                secret,
                announce,
            })
        }
        BootstrapChoice::Selected { user } => {
            // A pure select changed no directory fact, so nothing is owed — but a
            // session is still minted for the returning local viewer.
            let secret = issue_session(ports.mint, ports.sessions, &user.id, audit, now_ms).await?;
            Ok(EmbeddedBootstrap::Session {
                user,
                secret,
                announce: UserChangedAnnounce::NotOwed,
            })
        }
        BootstrapChoice::Conflict => Ok(EmbeddedBootstrap::Ambiguous),
    }
}

// ===========================================================================
// Shared steps — mirror the private helpers of `human_auth_flows`.
// ===========================================================================

/// Fire the post-commit `user_changed` hint, capturing its fate as a value. A lost
/// hint never downgrades the committed identity change.
async fn announce_user_changed<Sink>(sink: &Sink, user_id: &UserId) -> UserChangedAnnounce
where
    Sink: UserChangedSink,
{
    match sink.user_changed(user_id).await {
        Ok(()) => UserChangedAnnounce::Delivered,
        Err(failure) => UserChangedAnnounce::Failed(failure),
    }
}

/// Mint one bearer and persist its coordinate, yielding the one-time plaintext.
/// The plaintext survives only because [`crate::identity_access::auth::MintedSession::into_parts`]
/// hands it back here after the coordinate is committed.
async fn issue_session<Mint, Iss>(
    mint: &Mint,
    sessions: &Iss,
    user_id: &UserId,
    audit: &SessionAudit,
    now_ms: i64,
) -> Result<IssuedSessionSecret, EmbeddedBootstrapError>
where
    Mint: SessionTokenMint,
    Iss: SessionIssue,
{
    let (secret, token_hash) = mint.mint()?.into_parts();
    sessions.issue(user_id, token_hash, audit, now_ms).await?;
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        host_runtime::environment::EntropySource,
        identity_access::auth::{EntropySessionTokenMint, MintedSession, SessionTokenHash},
        identity_access::user_identity::UserChangedAnnounceFailure,
    };
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    const NOW: i64 = 7_000;

    fn record(id: &str) -> UserRecord {
        UserRecord {
            id: UserId::parse(id).unwrap(),
            handle: "local".to_owned(),
            display_name: "Local User".to_owned(),
            email: None,
            avatar: None,
            created_at: 10,
            updated_at: 10,
        }
    }

    // ---- fakes ----

    #[derive(Clone)]
    struct FakeUnitOfWork(BootstrapChoice);
    impl EmbeddedBootstrapUnitOfWork for FakeUnitOfWork {
        async fn choose_or_create(
            &self,
            _now_ms: i64,
        ) -> Result<BootstrapChoice, PersistenceFailure> {
            Ok(self.0.clone())
        }
    }

    #[derive(Clone)]
    struct CountingEntropy(Arc<Mutex<u8>>);
    #[derive(Debug, Error)]
    #[error("never")]
    struct NeverFails;
    impl EntropySource for CountingEntropy {
        type Error = NeverFails;
        fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error> {
            let mut cursor = self.0.lock().unwrap();
            for slot in destination.iter_mut() {
                *slot = *cursor;
                *cursor = cursor.wrapping_add(1);
            }
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FakeMint;
    impl SessionTokenMint for FakeMint {
        fn mint(&self) -> Result<MintedSession, SessionMintError> {
            EntropySessionTokenMint::new(CountingEntropy(Arc::new(Mutex::new(1)))).mint()
        }
    }

    #[derive(Clone)]
    struct RecordingIssue {
        issued: Arc<Mutex<Vec<(String, i64)>>>,
    }
    impl SessionIssue for RecordingIssue {
        async fn issue_verified(
            &self,
            user_id: &UserId,
            _expected: &str,
            token_hash: SessionTokenHash,
            audit: &SessionAudit,
            now_ms: i64,
        ) -> Result<bool, PersistenceFailure> {
            self.issue(user_id, token_hash, audit, now_ms).await?;
            Ok(true)
        }
        async fn issue(
            &self,
            user_id: &UserId,
            token_hash: SessionTokenHash,
            _audit: &SessionAudit,
            now_ms: i64,
        ) -> Result<(), PersistenceFailure> {
            self.issued
                .lock()
                .unwrap()
                .push((user_id.as_str().to_owned(), now_ms));
            let _ = token_hash;
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FakeSink(Arc<AtomicUsize>);
    impl UserChangedSink for FakeSink {
        async fn user_changed(&self, _user_id: &UserId) -> Result<(), UserChangedAnnounceFailure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn ports<'a>(
        uow: &'a FakeUnitOfWork,
        mint: &'a FakeMint,
        issue: &'a RecordingIssue,
        sink: &'a FakeSink,
    ) -> BootstrapPorts<'a, FakeUnitOfWork, FakeMint, RecordingIssue, FakeSink> {
        BootstrapPorts {
            unit_of_work: uow,
            mint,
            sessions: issue,
            user_changed: sink,
        }
    }

    #[tokio::test]
    async fn zero_users_creates_issues_a_session_and_announces_exactly_once() {
        let uow = FakeUnitOfWork(BootstrapChoice::Created { user: record("u1") });
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let sink = FakeSink(Arc::new(AtomicUsize::new(0)));

        let outcome = bootstrap_session(
            ports(&uow, &mint, &issue, &sink),
            &SessionAudit::default(),
            NOW,
        )
        .await
        .unwrap();

        let EmbeddedBootstrap::Session {
            user,
            secret,
            announce,
        } = outcome
        else {
            panic!("expected Session");
        };
        assert_eq!(user.id.as_str(), "u1");
        assert!(!secret.into_wire().is_empty());
        assert!(matches!(announce, UserChangedAnnounce::Delivered));
        assert_eq!(sink.0.load(Ordering::SeqCst), 1);
        assert_eq!(
            issue.issued.lock().unwrap().as_slice(),
            &[("u1".to_owned(), NOW)]
        );
    }

    #[tokio::test]
    async fn one_user_selects_issues_a_session_and_never_announces() {
        let uow = FakeUnitOfWork(BootstrapChoice::Selected { user: record("u1") });
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let sink = FakeSink(Arc::new(AtomicUsize::new(0)));

        let outcome = bootstrap_session(
            ports(&uow, &mint, &issue, &sink),
            &SessionAudit::default(),
            NOW,
        )
        .await
        .unwrap();

        let EmbeddedBootstrap::Session { user, announce, .. } = outcome else {
            panic!("expected Session");
        };
        assert_eq!(user.id.as_str(), "u1");
        // A select is owed no announce, and the sink must never be touched.
        assert!(matches!(announce, UserChangedAnnounce::NotOwed));
        assert_eq!(sink.0.load(Ordering::SeqCst), 0);
        // The session is still minted, exactly once.
        assert_eq!(
            issue.issued.lock().unwrap().as_slice(),
            &[("u1".to_owned(), NOW)]
        );
    }

    #[tokio::test]
    async fn many_users_is_ambiguous_and_mints_nothing() {
        let uow = FakeUnitOfWork(BootstrapChoice::Conflict);
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let sink = FakeSink(Arc::new(AtomicUsize::new(0)));

        let outcome = bootstrap_session(
            ports(&uow, &mint, &issue, &sink),
            &SessionAudit::default(),
            NOW,
        )
        .await
        .unwrap();

        assert!(matches!(outcome, EmbeddedBootstrap::Ambiguous));
        // No session, no announce — the refusal is pure.
        assert!(issue.issued.lock().unwrap().is_empty());
        assert_eq!(sink.0.load(Ordering::SeqCst), 0);
    }
}
