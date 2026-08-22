//! Host invitation and connect-credential domain boundary.

use std::{fmt, future::Future};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::persistence::PersistenceFailure;

const HOST_ID_BYTES: usize = 12;
const HOST_NAME_BYTES: usize = 4;
const CREDENTIAL_ID_BYTES: usize = 12;
const CONNECT_TOKEN_BYTES: usize = 32;
const HOST_NAME_ATTEMPTS: usize = 8;

/// The only host state this operation may create. Lifecycle fields that are
/// impossible for a fresh invitation do not exist in the core model.
pub struct NewUserInviteHost {
    id: String,
    name: String,
    user_id: String,
    created_at: i64,
}

impl NewUserInviteHost {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn user_id(&self) -> &str {
        &self.user_id
    }
    pub fn created_at(&self) -> i64 {
        self.created_at
    }
}

/// A committed invitation fact. Fixed row/DTO defaults are projections owned
/// by adapters, not optional state carried through the application layer.
pub struct CreatedUserInviteHost {
    id: String,
    name: String,
    user_id: String,
    created_at: i64,
}

impl CreatedUserInviteHost {
    fn from_new(host: &NewUserInviteHost) -> Self {
        Self {
            id: host.id.clone(),
            name: host.name.clone(),
            user_id: host.user_id.clone(),
            created_at: host.created_at,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn user_id(&self) -> &str {
        &self.user_id
    }
    pub fn created_at(&self) -> i64 {
        self.created_at
    }
}

/// Persistence input for the first credential. Its type fixes the lifecycle to
/// active, long-lived and unconsumed; no caller can construct another state.
///
/// ```compile_fail
/// use silverhand_backend_core::host_runtime::NewLongLivedCredential;
/// fn requires_debug<T: std::fmt::Debug>() {}
/// requires_debug::<NewLongLivedCredential>();
/// ```
///
/// ```compile_fail
/// use silverhand_backend_core::host_runtime::NewLongLivedCredential;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<NewLongLivedCredential>();
/// ```
pub struct NewLongLivedCredential {
    id: String,
    host_id: String,
    token_hash: String,
}

impl NewLongLivedCredential {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn host_id(&self) -> &str {
        &self.host_id
    }
    pub fn token_hash(&self) -> &str {
        &self.token_hash
    }
}

/// Reveal-once credential. Its public surface intentionally has no `Clone`,
/// `Display`, `Deref`, serialization, or equality implementation.
///
/// ```compile_fail
/// use silverhand_backend_core::host_runtime::ConnectToken;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<ConnectToken>();
/// ```
///
/// ```compile_fail
/// use silverhand_backend_core::host_runtime::ConnectToken;
/// fn requires_display<T: std::fmt::Display>() {}
/// requires_display::<ConnectToken>();
/// ```
pub struct ConnectToken(String);

impl ConnectToken {
    pub fn reveal_once(self) -> String {
        self.0
    }
}

impl fmt::Debug for ConnectToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConnectToken([REDACTED])")
    }
}

struct PresentedConnectToken(String);

impl PresentedConnectToken {
    fn parse(raw: String) -> Option<Self> {
        let normalized = raw.trim();
        (!normalized.is_empty()).then(|| Self(normalized.to_owned()))
    }

    fn hash(&self) -> String {
        hash_host_token(&self.0)
    }
}

impl fmt::Debug for PresentedConnectToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PresentedConnectToken([REDACTED])")
    }
}

pub struct HostInviteCreatedFact {
    pub host: CreatedUserInviteHost,
    pub connect_token: ConnectToken,
}

pub trait EntropySource: Send + Sync {
    type Error: std::error::Error + Send + Sync + 'static;
    fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error>;
}

pub trait Clock: Send + Sync {
    fn unix_time_ms(&self) -> Result<i64, HostInviteError>;
}

#[derive(Debug, Error)]
pub enum HostInviteWriteError {
    #[error("host name already exists")]
    DuplicateHostName,
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
}

pub trait HostInviteUnitOfWork: Clone + Send + Sync + 'static {
    fn create_host_and_credential(
        &self,
        host: NewUserInviteHost,
        credential: NewLongLivedCredential,
    ) -> impl Future<Output = Result<(), HostInviteWriteError>> + Send;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialKind {
    LongLived,
    Bootstrap,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialAuthState {
    pub credential_id: String,
    pub host_id: String,
    pub host_user_id: Option<String>,
    pub kind: CredentialKind,
    pub expires_at: Option<i64>,
    pub consumed_at: Option<i64>,
    pub credential_revoked_at: Option<i64>,
    pub host_revoked_at: Option<i64>,
}

pub trait HostCredentialLookup: Clone + Send + Sync + 'static {
    fn lookup_by_token_hash(
        &self,
        token_hash: String,
    ) -> impl Future<Output = Result<Option<CredentialAuthState>, PersistenceFailure>> + Send;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostTokenRejection {
    Missing,
    CredentialNotUsable,
    CredentialExpired,
    CredentialRevoked,
    HostRevoked,
    HostUnbound,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VerifyHostTokenFact {
    Accepted {
        host_id: String,
        user_id: String,
        credential_id: String,
    },
    Rejected(HostTokenRejection),
}

pub async fn verify_host_token<S: HostCredentialLookup>(
    store: &S,
    raw_token: String,
    now: i64,
) -> Result<VerifyHostTokenFact, PersistenceFailure> {
    let Some(token) = PresentedConnectToken::parse(raw_token) else {
        return Ok(VerifyHostTokenFact::Rejected(HostTokenRejection::Missing));
    };
    let Some(state) = store.lookup_by_token_hash(token.hash()).await? else {
        return Ok(VerifyHostTokenFact::Rejected(HostTokenRejection::Missing));
    };
    if state.kind != CredentialKind::LongLived {
        return Ok(VerifyHostTokenFact::Rejected(
            HostTokenRejection::CredentialNotUsable,
        ));
    }
    if let Some(revoked_at) = state.credential_revoked_at {
        if state.consumed_at.is_none() {
            return Ok(VerifyHostTokenFact::Rejected(
                HostTokenRejection::CredentialRevoked,
            ));
        }
        if revoked_at <= now {
            return Ok(VerifyHostTokenFact::Rejected(
                HostTokenRejection::CredentialExpired,
            ));
        }
    } else if state.consumed_at.is_some() {
        return Ok(VerifyHostTokenFact::Rejected(
            HostTokenRejection::CredentialNotUsable,
        ));
    }
    if state.expires_at.is_some_and(|expires_at| expires_at <= now) {
        return Ok(VerifyHostTokenFact::Rejected(
            HostTokenRejection::CredentialExpired,
        ));
    }
    if state.host_revoked_at.is_some() {
        return Ok(VerifyHostTokenFact::Rejected(
            HostTokenRejection::HostRevoked,
        ));
    }
    let Some(user_id) = state.host_user_id else {
        return Ok(VerifyHostTokenFact::Rejected(
            HostTokenRejection::HostUnbound,
        ));
    };
    Ok(VerifyHostTokenFact::Accepted {
        host_id: state.host_id,
        user_id,
        credential_id: state.credential_id,
    })
}

#[derive(Debug, Error)]
pub enum HostInviteError {
    #[error("secure random source failed")]
    Entropy(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("system time is outside the supported Unix-millisecond range")]
    Clock,
    #[error("unable to allocate a unique host name")]
    NameAllocation,
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
}

#[derive(Clone)]
pub struct CreateHostInvite<U, R, C> {
    unit_of_work: U,
    entropy: R,
    clock: C,
}

impl<U, R, C> CreateHostInvite<U, R, C>
where
    U: HostInviteUnitOfWork,
    R: EntropySource,
    C: Clock,
{
    pub fn new(unit_of_work: U, entropy: R, clock: C) -> Self {
        Self {
            unit_of_work,
            entropy,
            clock,
        }
    }

    pub async fn execute(&self, user_id: String) -> Result<HostInviteCreatedFact, HostInviteError> {
        for _ in 0..HOST_NAME_ATTEMPTS {
            let host_id = self.random_base64url(HOST_ID_BYTES)?;
            let host_name = format!("computer-{}", self.random_hex(HOST_NAME_BYTES)?);
            let credential_id = self.random_base64url(CREDENTIAL_ID_BYTES)?;
            let raw_token = self.random_base64url(CONNECT_TOKEN_BYTES)?;
            let host = NewUserInviteHost {
                id: host_id.clone(),
                name: host_name,
                user_id: user_id.clone(),
                created_at: self.clock.unix_time_ms()?,
            };
            let created = CreatedUserInviteHost::from_new(&host);
            let credential = NewLongLivedCredential {
                id: credential_id,
                host_id,
                token_hash: hash_host_token(&raw_token),
            };

            match self
                .unit_of_work
                .create_host_and_credential(host, credential)
                .await
            {
                Ok(()) => {
                    return Ok(HostInviteCreatedFact {
                        host: created,
                        connect_token: ConnectToken(raw_token),
                    });
                }
                Err(HostInviteWriteError::DuplicateHostName) => continue,
                Err(HostInviteWriteError::Persistence(error)) => {
                    return Err(HostInviteError::Persistence(error));
                }
            }
        }
        Err(HostInviteError::NameAllocation)
    }

    fn random_base64url(&self, length: usize) -> Result<String, HostInviteError> {
        let mut bytes = vec![0_u8; length];
        self.entropy
            .fill(&mut bytes)
            .map_err(|error| HostInviteError::Entropy(Box::new(error)))?;
        Ok(base64url(&bytes))
    }

    fn random_hex(&self, length: usize) -> Result<String, HostInviteError> {
        let mut bytes = vec![0_u8; length];
        self.entropy
            .fill(&mut bytes)
            .map_err(|error| HostInviteError::Entropy(Box::new(error)))?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}

fn base64url(input: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(input)
}

fn hash_host_token(token: &str) -> String {
    base64url(&Sha256::digest(token.as_bytes()))
}

#[derive(Clone, Copy, Debug, Default)]
pub struct OsEntropy;

impl EntropySource for OsEntropy {
    type Error = getrandom::Error;
    fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error> {
        getrandom::fill(destination)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn unix_time_ms(&self) -> Result<i64, HostInviteError> {
        let milliseconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| HostInviteError::Clock)?
            .as_millis();
        i64::try_from(milliseconds).map_err(|_| HostInviteError::Clock)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        convert::Infallible,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use super::*;

    #[derive(Clone, Copy)]
    enum StoreBehavior {
        Succeed,
        DuplicateOnce,
        AlwaysDuplicate,
    }

    type RecordedWrite = (String, String, String, String, String, i64);

    #[derive(Clone)]
    struct RecordingStore {
        behavior: StoreBehavior,
        calls: Arc<AtomicUsize>,
        writes: Arc<Mutex<Vec<RecordedWrite>>>,
    }

    impl RecordingStore {
        fn new(behavior: StoreBehavior) -> Self {
            Self {
                behavior,
                calls: Arc::new(AtomicUsize::new(0)),
                writes: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl HostInviteUnitOfWork for RecordingStore {
        async fn create_host_and_credential(
            &self,
            host: NewUserInviteHost,
            credential: NewLongLivedCredential,
        ) -> Result<(), HostInviteWriteError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            self.writes.lock().unwrap().push((
                host.id,
                host.name,
                host.user_id,
                credential.id,
                credential.token_hash,
                host.created_at,
            ));
            match self.behavior {
                StoreBehavior::Succeed => Ok(()),
                StoreBehavior::DuplicateOnce if call == 0 => {
                    Err(HostInviteWriteError::DuplicateHostName)
                }
                StoreBehavior::DuplicateOnce => Ok(()),
                StoreBehavior::AlwaysDuplicate => Err(HostInviteWriteError::DuplicateHostName),
            }
        }
    }

    struct FixedEntropy(Mutex<VecDeque<u8>>);

    impl FixedEntropy {
        fn bytes(count: usize) -> Self {
            Self(Mutex::new((0..count).map(|index| index as u8).collect()))
        }
    }

    impl EntropySource for FixedEntropy {
        type Error = Infallible;
        fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error> {
            let mut bytes = self.0.lock().unwrap();
            for destination in destination {
                *destination = bytes.pop_front().unwrap();
            }
            Ok(())
        }
    }

    #[derive(Debug, Error)]
    #[error("entropy unavailable")]
    struct EntropyUnavailable;

    struct FailingEntropy;

    impl EntropySource for FailingEntropy {
        type Error = EntropyUnavailable;
        fn fill(&self, _destination: &mut [u8]) -> Result<(), Self::Error> {
            Err(EntropyUnavailable)
        }
    }

    struct FixedClock;
    impl Clock for FixedClock {
        fn unix_time_ms(&self) -> Result<i64, HostInviteError> {
            Ok(1_700_000_000_123)
        }
    }

    struct FailingClock;
    impl Clock for FailingClock {
        fn unix_time_ms(&self) -> Result<i64, HostInviteError> {
            Err(HostInviteError::Clock)
        }
    }

    #[tokio::test]
    async fn creates_only_the_state_owned_by_a_fresh_user_invite() {
        let store = RecordingStore::new(StoreBehavior::Succeed);
        let service = CreateHostInvite::new(store.clone(), FixedEntropy::bytes(60), FixedClock);
        let fact = service.execute("user-1".into()).await.unwrap();
        let raw_token = fact.connect_token.reveal_once();
        let writes = store.writes.lock().unwrap();
        let (host_id, name, user_id, credential_id, token_hash, created_at) = &writes[0];

        assert_eq!(host_id, "AAECAwQFBgcICQoL");
        assert_eq!(name, "computer-0c0d0e0f");
        assert_eq!(user_id, "user-1");
        assert_eq!(created_at, &1_700_000_000_123);
        assert_eq!(credential_id, "EBESExQVFhcYGRob");
        assert_eq!(fact.host.id(), host_id);
        assert_eq!(fact.host.name(), name);
        assert_eq!(fact.host.user_id(), user_id);
        assert_eq!(raw_token.len(), 43);
        assert_ne!(token_hash, &raw_token);
        assert_eq!(store.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn entropy_failure_happens_before_the_unit_of_work() {
        let store = RecordingStore::new(StoreBehavior::Succeed);
        let service = CreateHostInvite::new(store.clone(), FailingEntropy, FixedClock);
        assert!(matches!(
            service.execute("user-1".into()).await,
            Err(HostInviteError::Entropy(_))
        ));
        assert_eq!(store.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn clock_failure_happens_before_the_unit_of_work() {
        let store = RecordingStore::new(StoreBehavior::Succeed);
        let service = CreateHostInvite::new(store.clone(), FixedEntropy::bytes(60), FailingClock);
        assert!(matches!(
            service.execute("user-1".into()).await,
            Err(HostInviteError::Clock)
        ));
        assert_eq!(store.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn retries_one_duplicate_name_then_succeeds() {
        let store = RecordingStore::new(StoreBehavior::DuplicateOnce);
        let service = CreateHostInvite::new(store.clone(), FixedEntropy::bytes(120), FixedClock);
        let fact = service.execute("user-1".into()).await.unwrap();
        assert_eq!(store.calls.load(Ordering::SeqCst), 2);
        assert_eq!(fact.host.name(), "computer-48494a4b");
    }

    #[tokio::test]
    async fn eight_duplicate_names_exhaust_the_contract() {
        let store = RecordingStore::new(StoreBehavior::AlwaysDuplicate);
        let service = CreateHostInvite::new(store.clone(), FixedEntropy::bytes(8 * 60), FixedClock);
        assert!(matches!(
            service.execute("user-1".into()).await,
            Err(HostInviteError::NameAllocation)
        ));
        assert_eq!(store.calls.load(Ordering::SeqCst), 8);
    }

    #[test]
    fn token_debug_is_always_redacted() {
        let token = ConnectToken("super-secret".into());
        assert_eq!(format!("{token:?}"), "ConnectToken([REDACTED])");
        assert!(!format!("{token:?}").contains("super-secret"));
    }

    #[test]
    fn base64url_matches_the_unpadded_node_contract() {
        assert_eq!(base64url(&[]), "");
        assert_eq!(base64url(&[0]), "AA");
        assert_eq!(base64url(&[0xff, 0xee, 0xdd]), "_-7d");
        assert_eq!(base64url(&[0_u8; 32]).len(), 43);
    }

    #[test]
    fn sha256_hash_matches_the_node_base64url_contract() {
        assert_eq!(
            hash_host_token("host token"),
            "AaArGqMOKkFjJjNtp11rIN4CVXC7R5Hhxa1iE3_W-b0"
        );
    }
}
