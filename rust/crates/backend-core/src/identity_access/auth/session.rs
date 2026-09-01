use std::{fmt, future::Future, time::SystemTime};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{foundation::identity::UserId, foundation::persistence::PersistenceFailure};

pub const DEFAULT_SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

/// An opaque bearer presented by a public caller.
///
/// The value can be hashed for lookup but has no ordinary duplication,
/// comparison, string-view, or serialization surface.
///
/// ```compile_fail
/// use silverhand_backend_core::identity_access::auth::SessionBearer;
/// let token = SessionBearer::parse("secret").unwrap();
/// let _ = token.clone();
/// ```
///
/// ```compile_fail
/// use silverhand_backend_core::identity_access::auth::SessionBearer;
/// let left = SessionBearer::parse("secret").unwrap();
/// let right = SessionBearer::parse("secret").unwrap();
/// let _ = left == right;
/// ```
///
/// ```compile_fail
/// use std::ops::Deref;
/// use silverhand_backend_core::identity_access::auth::SessionBearer;
/// let token = SessionBearer::parse("secret").unwrap();
/// let _: &str = Deref::deref(&token);
/// ```
///
/// ```compile_fail
/// use silverhand_backend_core::identity_access::auth::SessionBearer;
/// let token = SessionBearer::parse("secret").unwrap();
/// let _: &str = token.as_ref();
/// ```
pub struct SessionBearer(String);

impl SessionBearer {
    pub fn parse(raw: impl Into<String>) -> Option<Self> {
        let normalized = raw.into().trim().to_owned();
        (!normalized.is_empty()).then_some(Self(normalized))
    }

    /// The lookup coordinate this bearer folds to. Crate-visible so the logout
    /// flow can derive the revoke coordinate from a presented bearer through the
    /// one canonical derivation, never a second hashing rule.
    pub(crate) fn token_hash(&self) -> SessionTokenHash {
        SessionTokenHash::of_plaintext(&self.0)
    }
}

impl fmt::Debug for SessionBearer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionBearer([REDACTED])")
    }
}

/// The lookup coordinate derived from a bearer. It is intentionally opaque to
/// every layer except the persistence port that performs the exact lookup.
pub struct SessionTokenHash(String);

impl SessionTokenHash {
    /// The one canonical derivation of a lookup coordinate from a plaintext
    /// token. Both the read path (bearer verification) and the write path
    /// (freshly minted secrets) route through this so a stored `token_hash`
    /// and a presented bearer can never disagree on the hashing rule.
    pub fn of_plaintext(plaintext: &str) -> Self {
        let digest = Sha256::digest(plaintext.as_bytes());
        SessionTokenHash(URL_SAFE_NO_PAD.encode(digest))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionTtl(i64);

impl SessionTtl {
    pub fn from_millis(value: i64) -> Result<Self, InvalidSessionTtl> {
        if value <= 0 {
            return Err(InvalidSessionTtl);
        }
        Ok(Self(value))
    }

    pub fn as_millis(self) -> i64 {
        self.0
    }
}

impl Default for SessionTtl {
    fn default() -> Self {
        Self(DEFAULT_SESSION_TTL_MS)
    }
}

#[derive(Debug, Error)]
#[error("session ttl must be positive")]
pub struct InvalidSessionTtl;

/// One validation attempt's time inputs. Persistence must use both values in
/// the same transaction that performs the conditional touch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionValidation {
    now_ms: i64,
    ttl: SessionTtl,
}

impl SessionValidation {
    pub fn new(now_ms: i64, ttl: SessionTtl) -> Self {
        Self { now_ms, ttl }
    }

    pub fn now_ms(self) -> i64 {
        self.now_ms
    }

    pub fn ttl_ms(self) -> i64 {
        self.ttl.as_millis()
    }
}

/// The atomic persistence face of session authentication.
///
/// `Some(UserId)` is admissible only after lookup, eligibility, conditional
/// touch, user-integrity check, typed decode, and commit all succeed. Unknown,
/// revoked, and expired sessions are the indistinguishable `None` outcome.
pub trait SessionValidationPort: Clone + Send + Sync + 'static {
    fn verify_and_touch(
        &self,
        token_hash: SessionTokenHash,
        validation: SessionValidation,
    ) -> impl Future<Output = Result<Option<UserId>, PersistenceFailure>> + Send;
}

pub trait SessionClock: Clone + Send + Sync + 'static {
    fn now_unix_millis(&self) -> i64;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemSessionClock;

impl SessionClock for SystemSessionClock {
    fn now_unix_millis(&self) -> i64 {
        signed_unix_millis(SystemTime::now())
    }
}

fn signed_unix_millis(time: SystemTime) -> i64 {
    let millis = match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => i128::try_from(duration.as_millis()).unwrap_or(i128::MAX),
        Err(error) => -i128::try_from(error.duration().as_millis()).unwrap_or(i128::MAX),
    };
    i64::try_from(millis).unwrap_or_else(|_| {
        if millis.is_negative() {
            i64::MIN
        } else {
            i64::MAX
        }
    })
}

#[derive(Clone)]
pub struct HumanSessionAuthenticator<S, C> {
    sessions: S,
    clock: C,
    ttl: SessionTtl,
}

pub trait AuthenticateHumanSession: Clone + Send + Sync + 'static {
    fn authenticate_session(
        &self,
        bearer: SessionBearer,
    ) -> impl Future<Output = Result<Option<UserId>, PersistenceFailure>> + Send;
}

impl<S, C> HumanSessionAuthenticator<S, C>
where
    S: SessionValidationPort,
    C: SessionClock,
{
    pub fn new(sessions: S, clock: C, ttl: SessionTtl) -> Self {
        Self {
            sessions,
            clock,
            ttl,
        }
    }

    pub async fn authenticate(
        &self,
        bearer: SessionBearer,
    ) -> Result<Option<UserId>, PersistenceFailure> {
        self.sessions
            .verify_and_touch(
                bearer.token_hash(),
                SessionValidation::new(self.clock.now_unix_millis(), self.ttl),
            )
            .await
    }
}

impl<S, C> AuthenticateHumanSession for HumanSessionAuthenticator<S, C>
where
    S: SessionValidationPort,
    C: SessionClock,
{
    async fn authenticate_session(
        &self,
        bearer: SessionBearer,
    ) -> Result<Option<UserId>, PersistenceFailure> {
        self.authenticate(bearer).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Clone)]
    struct FixedClock(i64);

    impl SessionClock for FixedClock {
        fn now_unix_millis(&self) -> i64 {
            self.0
        }
    }

    #[derive(Clone)]
    struct CapturingPort {
        captured: Arc<Mutex<Vec<(String, SessionValidation)>>>,
        result: Option<UserId>,
    }

    impl SessionValidationPort for CapturingPort {
        async fn verify_and_touch(
            &self,
            token_hash: SessionTokenHash,
            validation: SessionValidation,
        ) -> Result<Option<UserId>, PersistenceFailure> {
            self.captured
                .lock()
                .unwrap()
                .push((token_hash.as_str().to_owned(), validation));
            Ok(self.result.clone())
        }
    }

    #[tokio::test]
    async fn hashes_like_the_ts_authority_and_passes_one_time_policy() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let port = CapturingPort {
            captured: Arc::clone(&captured),
            result: Some(UserId::parse("user-1").unwrap()),
        };
        let ttl = SessionTtl::from_millis(1234).unwrap();
        let authenticator = HumanSessionAuthenticator::new(port, FixedClock(9876), ttl);

        let result = authenticator
            .authenticate(SessionBearer::parse("  session-ok  ").unwrap())
            .await
            .unwrap();

        assert_eq!(result.unwrap().as_str(), "user-1");
        assert_eq!(
            *captured.lock().unwrap(),
            vec![(
                "eEBNGuzfQAH-9ONX0xWGTS4aZU8VPc8DL488NmYD4qQ".into(),
                SessionValidation::new(9876, ttl),
            )]
        );
    }

    #[test]
    fn bearer_debug_is_redacted_and_blank_is_not_a_token() {
        assert!(SessionBearer::parse("  ").is_none());
        assert_eq!(
            format!("{:?}", SessionBearer::parse("top-secret").unwrap()),
            "SessionBearer([REDACTED])"
        );
    }

    #[test]
    fn ttl_cannot_disable_expiry() {
        assert!(SessionTtl::from_millis(0).is_err());
        assert!(SessionTtl::from_millis(-1).is_err());
        assert_eq!(SessionTtl::default().as_millis(), DEFAULT_SESSION_TTL_MS);
    }
}
