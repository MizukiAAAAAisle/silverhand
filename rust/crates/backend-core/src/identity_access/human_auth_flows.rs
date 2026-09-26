//! The human credentialed-session application flows: signup, login, logout.
//!
//! These are the composition seam where three bounded contexts meet — the
//! user-identity authority ([`crate::identity_access::user_identity`]), the password-credential
//! authority ([`crate::identity_access::credential`]), and the session authority
//! ([`crate::identity_access::auth`]). Each context owns its own tables and invariants; this
//! module orchestrates them into the three public flows, exactly as the TS
//! `UserAuthService` + `PasswordCredentialService` + `AuthSessionService` compose,
//! but without any one context reaching into another's model.
//!
//! ## The answer ordering is a SECURITY property, not a style choice
//!
//! Signup pays one unconditional Argon2id hash BEFORE any branch, then decides
//! the handle, then the credential answer — in that fixed order. If the email
//! check came first, an attacker holding one publicly-known taken handle could
//! read `auth_failed` as "this email is registered" and `handle_taken` as "it is
//! not", turning the uniform credential answer into an email-existence oracle. So
//! the order is: hash (cost floor) → handle verdict → email verdict. The
//! DB-conflict path RE-ANSWERS in the same order (a conflict proves a pre-check
//! read was stale), so the ordering holds even under a race.

use std::future::Future;

use thiserror::Error;

use crate::{
    foundation::identity::UserId,
    foundation::persistence::PersistenceFailure,
    identity_access::auth::{
        IssuedSessionSecret, SessionAudit, SessionBearer, SessionIssue, SessionMintError,
        SessionRevoke, SessionTokenMint,
    },
    identity_access::credential::{
        LoginCredentialLookup, PasswordHashError, PasswordHasher, PreparedPasswordCredential,
    },
    identity_access::user_identity::{
        DisplayName, EmailAddress, ParticipantHandle, UserChangedAnnounce, UserChangedSink,
        UserEmailLookup, UserProfileRead, UserRecord,
    },
};

// ===========================================================================
// Cross-context ports owned by this application seam.
// ===========================================================================

/// The @-handle namespace predicate spanning BOTH halves of the one mention
/// namespace — a handle held by an agent is exactly as taken as one held by a
/// human. No single bounded context owns this question (it reads `agents` AND
/// `users`), so it is an application-level port the composition root wires to the
/// shared availability predicate, never re-derived per caller.
pub trait HandleNamespaceRead: Clone + Send + Sync + 'static {
    fn is_handle_taken(
        &self,
        handle: &ParticipantHandle,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

/// The atomic first-time registration write: create the `users` row AND upsert
/// its password credential in ONE transaction, or neither. Internal id allocation
/// (mint a surrogate id, retry on a `user_id` collision) is a persistence concern
/// the adapter owns; it surfaces only the handle/email conflicts the flow's
/// security ordering must arbitrate. Exhausting id allocation is an infrastructure
/// fault, not a product outcome, so it is a [`PersistenceFailure`].
pub trait HumanRegistrationUnitOfWork: Clone + Send + Sync + 'static {
    fn register(
        &self,
        handle: &ParticipantHandle,
        display_name: &DisplayName,
        email: &EmailAddress,
        credential: &PreparedPasswordCredential,
        now_ms: i64,
    ) -> impl Future<Output = Result<HumanRegistration, PersistenceFailure>> + Send;
}

/// The raw outcome of the registration write. The application flow maps the two
/// conflict arms onto the security-ordered product answer; the adapter does not
/// decide that ordering.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HumanRegistration {
    /// A brand-new identity committed; carries the created row.
    Registered { user: UserRecord },
    /// The chosen handle is taken (in either half of the namespace) at insert time.
    HandleConflict,
    /// The email is taken at insert time.
    EmailConflict,
}

// ===========================================================================
// Errors — every arm is a safe-500 seam.
// ===========================================================================

/// Why a credentialed flow could not yield a trustworthy answer. Every arm maps
/// to the ratified bare-text `500`; none is a product outcome (those are the
/// success/refusal arms of the outcome enums).
#[derive(Debug, Error)]
pub enum HumanAuthError {
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
    #[error(transparent)]
    Hash(#[from] PasswordHashError),
    #[error(transparent)]
    Mint(#[from] SessionMintError),
    /// A credential or session resolved to a user id, but no `users` row answers
    /// to it — a dangling pointer, i.e. persistence corruption, never a 404.
    #[error("an authenticated user id resolves to no user row")]
    MissingUser,
}

// ===========================================================================
// Signup: POST /auth/signup.
// ===========================================================================

/// Everything the signup flow needs, minus the request. Grouping the ports keeps
/// the flow signature legible and mirrors the TS service's injected collaborators.
pub struct SignupPorts<'a, Ha, El, Reg, Hr, Mint, Iss, Sink> {
    pub handles: &'a Ha,
    pub emails: &'a El,
    pub hasher: &'a Hr,
    pub registration: &'a Reg,
    pub mint: &'a Mint,
    pub sessions: &'a Iss,
    pub user_changed: &'a Sink,
}

/// The signup request, already admitted into value objects (parse failure is the
/// route's terminal `400`, never reaches here).
pub struct SignupCommand {
    pub email: EmailAddress,
    pub handle: ParticipantHandle,
    pub password: String,
    /// `None` means "derive a default from the email local part".
    pub display_name: Option<DisplayName>,
    pub audit: SessionAudit,
}

/// The closed outcome of [`sign_up`].
pub enum Signup {
    /// A new identity was registered and a session issued. Carries the created
    /// profile, the one-time bearer plaintext, and the `user_changed` announce
    /// fate.
    Registered {
        user: UserRecord,
        secret: IssuedSessionSecret,
        announce: UserChangedAnnounce,
    },
    /// The chosen handle is taken — the one actionable rejection (a handle is
    /// public by construction, so reporting it leaks no credential fact).
    HandleTaken,
    /// The uniform credential failure (unknown/duplicate email, etc.).
    AuthFailed,
}

/// Register a brand-new email+password identity and issue its first session.
pub async fn sign_up<Ha, El, Reg, Hr, Mint, Iss, Sink>(
    ports: SignupPorts<'_, Ha, El, Reg, Hr, Mint, Iss, Sink>,
    command: SignupCommand,
    now_ms: i64,
) -> Result<Signup, HumanAuthError>
where
    Ha: HandleNamespaceRead,
    El: UserEmailLookup,
    Reg: HumanRegistrationUnitOfWork,
    Hr: PasswordHasher,
    Mint: SessionTokenMint,
    Iss: SessionIssue,
    Sink: UserChangedSink,
{
    // Cost floor FIRST, before any identity branch: every attempt that reaches
    // here pays one Argon2id hash whatever the outcome, so neither answer below is
    // a cheap probe.
    let credential = ports.hasher.hash(&command.password).await?;

    // Decided on the handle alone, across both halves of the mention namespace.
    if ports.handles.is_handle_taken(&command.handle).await? {
        return Ok(Signup::HandleTaken);
    }
    if ports
        .emails
        .find_by_email(command.email.as_str())
        .await?
        .is_some()
    {
        return Ok(Signup::AuthFailed);
    }

    let display_name = command
        .display_name
        .unwrap_or_else(|| DisplayName::derived_default_from_email(&command.email));

    match ports
        .registration
        .register(
            &command.handle,
            &display_name,
            &command.email,
            &credential,
            now_ms,
        )
        .await?
    {
        HumanRegistration::Registered { user } => {
            let announce = announce_user_changed(ports.user_changed, &user.id).await;
            let secret =
                issue_session(ports.mint, ports.sessions, &user.id, &command.audit, now_ms).await?;
            Ok(Signup::Registered {
                user,
                secret,
                announce,
            })
        }
        // A taken handle is always reported as such: the world moved under the
        // pre-check, and the handle verdict must depend only on the handle.
        HumanRegistration::HandleConflict => Ok(Signup::HandleTaken),
        // On an email conflict, RE-ANSWER the handle authoritatively first (the
        // conflict proves the pre-check read was stale): if the handle is now
        // taken, that wins; only a free handle collapses to the uniform failure.
        HumanRegistration::EmailConflict => {
            if ports.handles.is_handle_taken(&command.handle).await? {
                Ok(Signup::HandleTaken)
            } else {
                Ok(Signup::AuthFailed)
            }
        }
    }
}

// ===========================================================================
// Login: POST /auth/login.
// ===========================================================================

/// Everything the login flow needs, minus the request.
pub struct LoginPorts<'a, Lookup, Reads, Hr, Mint, Iss> {
    pub credentials: &'a Lookup,
    pub users: &'a Reads,
    pub hasher: &'a Hr,
    pub mint: &'a Mint,
    pub sessions: &'a Iss,
}

/// The login request, already admitted into value objects.
pub struct LoginCommand {
    pub email: EmailAddress,
    pub password: String,
    pub audit: SessionAudit,
}

/// The closed outcome of [`log_in`].
pub enum Login {
    /// The credential verified; carries the profile and a fresh session bearer.
    Authenticated {
        user: UserRecord,
        secret: IssuedSessionSecret,
    },
    /// The uniform credential failure — unknown email, profile-only user, or wrong
    /// password, all indistinguishable after one dummy-equalized verify.
    AuthFailed,
}

/// Verify an email+password and, on success, issue a session.
///
/// Timing uniformity is a security property: the "no such email" and "user has no
/// password" paths spend one dummy Argon2id verify before returning the same
/// failure a wrong password returns.
pub async fn log_in<Lookup, Reads, Hr, Mint, Iss>(
    ports: LoginPorts<'_, Lookup, Reads, Hr, Mint, Iss>,
    command: LoginCommand,
    now_ms: i64,
) -> Result<Login, HumanAuthError>
where
    Lookup: LoginCredentialLookup,
    Reads: UserProfileRead,
    Hr: PasswordHasher,
    Mint: SessionTokenMint,
    Iss: SessionIssue,
{
    let candidate = ports
        .credentials
        .lookup_login(command.email.as_str())
        .await?;
    let Some(candidate) = candidate else {
        ports.hasher.verify_dummy(&command.password).await?;
        return Ok(Login::AuthFailed);
    };
    let Some(phc) = candidate.password_hash else {
        // A profile-only user: spend the dummy cost, then the uniform failure.
        ports.hasher.verify_dummy(&command.password).await?;
        return Ok(Login::AuthFailed);
    };
    if !ports.hasher.verify(&phc, &command.password).await? {
        return Ok(Login::AuthFailed);
    }

    // The credential verified; the profile MUST exist (a dangling credential is
    // corruption, mapped to a safe-500 — never a 404).
    let user = ports
        .users
        .get(&candidate.user_id)
        .await?
        .ok_or(HumanAuthError::MissingUser)?;
    let (secret, token_hash) = ports.mint.mint()?.into_parts();
    if !ports
        .sessions
        .issue_verified(&candidate.user_id, &phc, token_hash, &command.audit, now_ms)
        .await?
    {
        return Ok(Login::AuthFailed);
    }
    Ok(Login::Authenticated { user, secret })
}

// ===========================================================================
// Logout: POST /auth/logout.
// ===========================================================================

/// Revoke the presented bearer's session. Returns whether a LIVE session was
/// revoked; `false` (unknown or already-revoked bearer) and a missing bearer both
/// map to the route's `401`. The revoke coordinate is derived from the bearer
/// through the one canonical hashing rule, so a presented bearer and a stored
/// `token_hash` can never disagree.
pub async fn log_out<R>(
    revoke: &R,
    bearer: &SessionBearer,
    now_ms: i64,
) -> Result<bool, PersistenceFailure>
where
    R: SessionRevoke,
{
    revoke.revoke(bearer.token_hash(), now_ms).await
}

// ===========================================================================
// Shared steps.
// ===========================================================================

/// Fire the post-commit `user_changed` hint, capturing its fate as a value. A
/// lost hint never downgrades the committed identity change.
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
/// The plaintext survives only because [`MintedSession::into_parts`] hands it back
/// here after the coordinate is committed.
async fn issue_session<Mint, Iss>(
    mint: &Mint,
    sessions: &Iss,
    user_id: &UserId,
    audit: &SessionAudit,
    now_ms: i64,
) -> Result<IssuedSessionSecret, HumanAuthError>
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
        identity_access::auth::{MintedSession, SessionTokenHash},
        identity_access::credential::LoginCandidate,
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
            handle: "alice".to_owned(),
            display_name: "Alice".to_owned(),
            email: Some("alice@example.com".to_owned()),
            avatar: None,
            created_at: 10,
            updated_at: 10,
        }
    }

    // ---- fakes ----

    #[derive(Clone)]
    struct FakeHandles(bool);
    impl HandleNamespaceRead for FakeHandles {
        async fn is_handle_taken(
            &self,
            _handle: &ParticipantHandle,
        ) -> Result<bool, PersistenceFailure> {
            Ok(self.0)
        }
    }

    #[derive(Clone)]
    struct FakeEmails(bool);
    impl UserEmailLookup for FakeEmails {
        async fn find_by_email(&self, _email: &str) -> Result<Option<UserId>, PersistenceFailure> {
            Ok(self.0.then(|| UserId::parse("existing").unwrap()))
        }
    }

    #[derive(Clone)]
    struct FakeRegistration(HumanRegistration);
    impl HumanRegistrationUnitOfWork for FakeRegistration {
        async fn register(
            &self,
            _handle: &ParticipantHandle,
            _display_name: &DisplayName,
            _email: &EmailAddress,
            _credential: &PreparedPasswordCredential,
            _now_ms: i64,
        ) -> Result<HumanRegistration, PersistenceFailure> {
            Ok(self.0.clone())
        }
    }

    /// A deterministic hasher fake — never touches Argon2, records verify_dummy.
    #[derive(Clone)]
    struct FakeHasher {
        verify_ok: bool,
        dummy_calls: Arc<AtomicUsize>,
    }
    impl FakeHasher {
        fn new(verify_ok: bool) -> Self {
            Self {
                verify_ok,
                dummy_calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }
    impl PasswordHasher for FakeHasher {
        async fn hash(
            &self,
            _password: &str,
        ) -> Result<PreparedPasswordCredential, PasswordHashError> {
            Ok(PreparedPasswordCredential {
                phc: "$argon2id$fake".to_owned(),
                params: crate::identity_access::credential::PasswordHashParams {
                    cost: crate::identity_access::credential::Argon2idCost {
                        memory_cost_kib: 19 * 1024,
                        time_cost: 2,
                        parallelism: 1,
                        output_len: 32,
                    },
                    calibration: crate::identity_access::credential::RustCalibration {
                        target_millis: 250,
                        measured_millis: 250,
                        candidate_count: 1,
                        floor_memory_cost_kib: 19 * 1024,
                        floor_time_cost: 2,
                    },
                },
            })
        }
        async fn verify(&self, _phc: &str, _password: &str) -> Result<bool, PasswordHashError> {
            Ok(self.verify_ok)
        }
        async fn verify_dummy(&self, _password: &str) -> Result<(), PasswordHashError> {
            self.dummy_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    /// A hasher whose dummy-verify path faults — so a test can prove the login
    /// flow propagates the fault to a safe-500 rather than silently returning the
    /// uniform failure without spending (and honestly failing) the cost.
    #[derive(Clone)]
    struct FailingDummyHasher;
    impl PasswordHasher for FailingDummyHasher {
        async fn hash(
            &self,
            _password: &str,
        ) -> Result<PreparedPasswordCredential, PasswordHashError> {
            Err(PasswordHashError::offload_join_failed(
                std::io::Error::other("test KDF failure"),
            ))
        }
        async fn verify(&self, _phc: &str, _password: &str) -> Result<bool, PasswordHashError> {
            Ok(false)
        }
        async fn verify_dummy(&self, _password: &str) -> Result<(), PasswordHashError> {
            Err(PasswordHashError::offload_join_failed(
                std::io::Error::other("test KDF failure"),
            ))
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

    /// A mint fake that produces a fixed, decodable bearer.
    #[derive(Clone)]
    struct FakeMint;
    impl SessionTokenMint for FakeMint {
        fn mint(&self) -> Result<MintedSession, SessionMintError> {
            // Reuse the real entropy mint so MintedSession is constructed properly.
            crate::identity_access::auth::EntropySessionTokenMint::new(CountingEntropy(Arc::new(
                Mutex::new(1),
            )))
            .mint()
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

    #[derive(Clone)]
    struct FakeReads(Option<UserRecord>);
    impl UserProfileRead for FakeReads {
        async fn get(&self, _user_id: &UserId) -> Result<Option<UserRecord>, PersistenceFailure> {
            Ok(self.0.clone())
        }
    }

    #[derive(Clone)]
    struct FakeLookup(Option<LoginCandidate>);
    impl LoginCredentialLookup for FakeLookup {
        async fn lookup_login(
            &self,
            _email: &str,
        ) -> Result<Option<LoginCandidate>, PersistenceFailure> {
            Ok(self.0.clone())
        }
    }

    fn signup_command() -> SignupCommand {
        SignupCommand {
            email: EmailAddress::parse("alice@example.com").unwrap(),
            handle: ParticipantHandle::parse("alice").unwrap(),
            password: "correct horse".to_owned(),
            display_name: None,
            audit: SessionAudit::capture(Some("agent"), Some("1.2.3.4")),
        }
    }

    fn signup_ports<'a>(
        handles: &'a FakeHandles,
        emails: &'a FakeEmails,
        hasher: &'a FakeHasher,
        registration: &'a FakeRegistration,
        mint: &'a FakeMint,
        issue: &'a RecordingIssue,
        sink: &'a FakeSink,
    ) -> SignupPorts<
        'a,
        FakeHandles,
        FakeEmails,
        FakeRegistration,
        FakeHasher,
        FakeMint,
        RecordingIssue,
        FakeSink,
    > {
        SignupPorts {
            handles,
            emails,
            hasher,
            registration,
            mint,
            sessions: issue,
            user_changed: sink,
        }
    }

    #[tokio::test]
    async fn signup_registers_issues_a_session_and_announces_once() {
        let handles = FakeHandles(false);
        let emails = FakeEmails(false);
        let hasher = FakeHasher::new(true);
        let registration = FakeRegistration(HumanRegistration::Registered { user: record("u1") });
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let sink = FakeSink(Arc::new(AtomicUsize::new(0)));

        let outcome = sign_up(
            signup_ports(
                &handles,
                &emails,
                &hasher,
                &registration,
                &mint,
                &issue,
                &sink,
            ),
            signup_command(),
            NOW,
        )
        .await
        .unwrap();

        let Signup::Registered {
            user,
            secret,
            announce,
        } = outcome
        else {
            panic!("expected Registered");
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
    async fn signup_hashes_before_identity_probes_and_stops_at_a_taken_handle() {
        #[derive(Clone)]
        struct Probes {
            taken: bool,
            trace: Arc<Mutex<Vec<&'static str>>>,
        }
        impl PasswordHasher for Probes {
            async fn hash(
                &self,
                password: &str,
            ) -> Result<PreparedPasswordCredential, PasswordHashError> {
                let credential = FakeHasher::new(true).hash(password).await?;
                self.trace.lock().unwrap().push("hash completed");
                Ok(credential)
            }
            async fn verify(&self, _: &str, _: &str) -> Result<bool, PasswordHashError> {
                panic!("signup must not verify");
            }
            async fn verify_dummy(&self, _: &str) -> Result<(), PasswordHashError> {
                panic!("signup must not dummy-verify");
            }
        }
        impl HandleNamespaceRead for Probes {
            async fn is_handle_taken(
                &self,
                _: &ParticipantHandle,
            ) -> Result<bool, PersistenceFailure> {
                self.trace.lock().unwrap().push("handle");
                Ok(self.taken)
            }
        }
        impl UserEmailLookup for Probes {
            async fn find_by_email(&self, _: &str) -> Result<Option<UserId>, PersistenceFailure> {
                self.trace.lock().unwrap().push("email");
                Ok(Some(UserId::parse("existing").unwrap()))
            }
        }
        for taken in [true, false] {
            let probes = Probes {
                taken,
                trace: Arc::new(Mutex::new(Vec::new())),
            };
            let issue = RecordingIssue {
                issued: Arc::new(Mutex::new(Vec::new())),
            };
            let sink = FakeSink(Arc::new(AtomicUsize::new(0)));
            let outcome = sign_up(
                SignupPorts {
                    handles: &probes,
                    emails: &probes,
                    hasher: &probes,
                    registration: &FakeRegistration(HumanRegistration::Registered {
                        user: record("u1"),
                    }),
                    mint: &FakeMint,
                    sessions: &issue,
                    user_changed: &sink,
                },
                signup_command(),
                NOW,
            )
            .await
            .unwrap();
            if taken {
                assert!(matches!(outcome, Signup::HandleTaken));
                assert_eq!(*probes.trace.lock().unwrap(), ["hash completed", "handle"]);
            } else {
                assert!(matches!(outcome, Signup::AuthFailed));
                assert_eq!(
                    *probes.trace.lock().unwrap(),
                    ["hash completed", "handle", "email"]
                );
            }
            assert!(issue.issued.lock().unwrap().is_empty());
            assert_eq!(sink.0.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn signup_email_conflict_reanswers_the_handle_authoritatively() {
        // Pre-check saw a free handle, but by insert time the email conflicted AND
        // the handle was taken: the authoritative re-read must win over the stale
        // pre-check, so the answer is HandleTaken, not the uniform AuthFailed.
        #[derive(Clone)]
        struct SequenceHandles(Arc<AtomicUsize>);
        impl HandleNamespaceRead for SequenceHandles {
            async fn is_handle_taken(
                &self,
                _handle: &ParticipantHandle,
            ) -> Result<bool, PersistenceFailure> {
                // First call (pre-check) free; every later call (re-read) taken.
                Ok(self.0.fetch_add(1, Ordering::SeqCst) > 0)
            }
        }

        let handles = SequenceHandles(Arc::new(AtomicUsize::new(0)));
        let emails = FakeEmails(false);
        let hasher = FakeHasher::new(true);
        let registration = FakeRegistration(HumanRegistration::EmailConflict);
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let sink = FakeSink(Arc::new(AtomicUsize::new(0)));

        let outcome = sign_up(
            SignupPorts {
                handles: &handles,
                emails: &emails,
                hasher: &hasher,
                registration: &registration,
                mint: &mint,
                sessions: &issue,
                user_changed: &sink,
            },
            signup_command(),
            NOW,
        )
        .await
        .unwrap();
        assert!(matches!(outcome, Signup::HandleTaken));
        assert!(issue.issued.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn signup_email_conflict_with_free_handle_is_auth_failed() {
        let handles = FakeHandles(false);
        let emails = FakeEmails(false);
        let hasher = FakeHasher::new(true);
        let registration = FakeRegistration(HumanRegistration::EmailConflict);
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let sink = FakeSink(Arc::new(AtomicUsize::new(0)));

        let outcome = sign_up(
            signup_ports(
                &handles,
                &emails,
                &hasher,
                &registration,
                &mint,
                &issue,
                &sink,
            ),
            signup_command(),
            NOW,
        )
        .await
        .unwrap();
        assert!(matches!(outcome, Signup::AuthFailed));
        assert!(issue.issued.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn login_unknown_email_spends_a_dummy_verify_and_fails() {
        let lookup = FakeLookup(None);
        let reads = FakeReads(None);
        let hasher = FakeHasher::new(true);
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let outcome = log_in(
            LoginPorts {
                credentials: &lookup,
                users: &reads,
                hasher: &hasher,
                mint: &mint,
                sessions: &issue,
            },
            LoginCommand {
                email: EmailAddress::parse("nobody@example.com").unwrap(),
                password: "x".to_owned(),
                audit: SessionAudit::default(),
            },
            NOW,
        )
        .await
        .unwrap();
        assert!(matches!(outcome, Login::AuthFailed));
        assert_eq!(hasher.dummy_calls.load(Ordering::SeqCst), 1);
        assert!(issue.issued.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn login_profile_only_user_spends_a_dummy_verify_and_fails() {
        let lookup = FakeLookup(Some(LoginCandidate {
            user_id: UserId::parse("u1").unwrap(),
            password_hash: None,
        }));
        let reads = FakeReads(Some(record("u1")));
        let hasher = FakeHasher::new(true);
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let outcome = log_in(
            LoginPorts {
                credentials: &lookup,
                users: &reads,
                hasher: &hasher,
                mint: &mint,
                sessions: &issue,
            },
            LoginCommand {
                email: EmailAddress::parse("alice@example.com").unwrap(),
                password: "x".to_owned(),
                audit: SessionAudit::default(),
            },
            NOW,
        )
        .await
        .unwrap();
        assert!(matches!(outcome, Login::AuthFailed));
        assert_eq!(hasher.dummy_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn login_wrong_password_fails_without_a_dummy_verify() {
        let lookup = FakeLookup(Some(LoginCandidate {
            user_id: UserId::parse("u1").unwrap(),
            password_hash: Some("$argon2id$stored".to_owned()),
        }));
        let reads = FakeReads(Some(record("u1")));
        let hasher = FakeHasher::new(false); // verify returns false
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let outcome = log_in(
            LoginPorts {
                credentials: &lookup,
                users: &reads,
                hasher: &hasher,
                mint: &mint,
                sessions: &issue,
            },
            LoginCommand {
                email: EmailAddress::parse("alice@example.com").unwrap(),
                password: "wrong".to_owned(),
                audit: SessionAudit::default(),
            },
            NOW,
        )
        .await
        .unwrap();
        assert!(matches!(outcome, Login::AuthFailed));
        assert_eq!(hasher.dummy_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn login_with_a_faulting_dummy_verify_is_a_safe_500_not_auth_failed() {
        // An unknown email must still spend the dummy verify; if THAT faults
        // (entropy/KDF failure), the flow must surface the fault as a safe-500,
        // never swallow it and answer the uniform failure without paying the cost.
        let lookup = FakeLookup(None);
        let reads = FakeReads(None);
        let hasher = FailingDummyHasher;
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let result = log_in(
            LoginPorts {
                credentials: &lookup,
                users: &reads,
                hasher: &hasher,
                mint: &mint,
                sessions: &issue,
            },
            LoginCommand {
                email: EmailAddress::parse("nobody@example.com").unwrap(),
                password: "x".to_owned(),
                audit: SessionAudit::default(),
            },
            NOW,
        )
        .await;
        assert!(matches!(result, Err(HumanAuthError::Hash(_))));
        assert!(issue.issued.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn login_success_issues_a_session_over_the_read_profile() {
        let lookup = FakeLookup(Some(LoginCandidate {
            user_id: UserId::parse("u1").unwrap(),
            password_hash: Some("$argon2id$stored".to_owned()),
        }));
        let reads = FakeReads(Some(record("u1")));
        let hasher = FakeHasher::new(true);
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let outcome = log_in(
            LoginPorts {
                credentials: &lookup,
                users: &reads,
                hasher: &hasher,
                mint: &mint,
                sessions: &issue,
            },
            LoginCommand {
                email: EmailAddress::parse("alice@example.com").unwrap(),
                password: "correct horse".to_owned(),
                audit: SessionAudit::default(),
            },
            NOW,
        )
        .await
        .unwrap();
        let Login::Authenticated { user, secret } = outcome else {
            panic!("expected Authenticated");
        };
        assert_eq!(user.id.as_str(), "u1");
        assert!(!secret.into_wire().is_empty());
        assert_eq!(
            issue.issued.lock().unwrap().as_slice(),
            &[("u1".to_owned(), NOW)]
        );
    }

    #[tokio::test]
    async fn login_with_a_verified_but_missing_user_is_a_safe_500() {
        let lookup = FakeLookup(Some(LoginCandidate {
            user_id: UserId::parse("u1").unwrap(),
            password_hash: Some("$argon2id$stored".to_owned()),
        }));
        let reads = FakeReads(None); // credential resolves to no user row
        let hasher = FakeHasher::new(true);
        let mint = FakeMint;
        let issue = RecordingIssue {
            issued: Arc::new(Mutex::new(Vec::new())),
        };
        let result = log_in(
            LoginPorts {
                credentials: &lookup,
                users: &reads,
                hasher: &hasher,
                mint: &mint,
                sessions: &issue,
            },
            LoginCommand {
                email: EmailAddress::parse("alice@example.com").unwrap(),
                password: "correct horse".to_owned(),
                audit: SessionAudit::default(),
            },
            NOW,
        )
        .await;
        assert!(matches!(result, Err(HumanAuthError::MissingUser)));
    }

    #[derive(Clone)]
    struct FakeRevoke(bool);
    impl SessionRevoke for FakeRevoke {
        async fn revoke(
            &self,
            _token_hash: SessionTokenHash,
            _now_ms: i64,
        ) -> Result<bool, PersistenceFailure> {
            Ok(self.0)
        }
    }

    #[tokio::test]
    async fn logout_reports_whether_a_live_session_was_revoked() {
        let bearer = SessionBearer::parse("some-token").unwrap();
        assert!(log_out(&FakeRevoke(true), &bearer, NOW).await.unwrap());
        assert!(!log_out(&FakeRevoke(false), &bearer, NOW).await.unwrap());
    }
}
