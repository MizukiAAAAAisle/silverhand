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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostKind {
    Remote,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostProvisioningSource {
    UserInvite,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostCredentialKind {
    LongLived,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Host {
    pub id: String,
    pub name: String,
    pub kind: HostKind,
    pub user_id: String,
    pub installation_id: Option<String>,
    pub last_seen_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub created_at: i64,
    pub activated_at: Option<i64>,
    pub finalized_at: Option<i64>,
    pub provisioning_source: HostProvisioningSource,
    pub display_label: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NewHostCredential {
    pub id: String,
    pub host_id: String,
    pub token_hash: String,
    pub kind: HostCredentialKind,
    pub expires_at: Option<i64>,
    pub consumed_at: Option<i64>,
    pub revoked_at: Option<i64>,
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
    pub host: Host,
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
        host: Host,
        credential: NewHostCredential,
    ) -> impl Future<Output = Result<Host, HostInviteWriteError>> + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialAuthState {
    pub credential_id: String,
    pub host_id: String,
    pub host_user_id: Option<String>,
    pub kind: String,
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
    if state.kind != "long_lived" {
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
        let created_at = self.clock.unix_time_ms()?;
        for _ in 0..HOST_NAME_ATTEMPTS {
            let host_id = self.random_base64url(HOST_ID_BYTES)?;
            let host_name = format!("computer-{}", self.random_hex(HOST_NAME_BYTES)?);
            let credential_id = self.random_base64url(CREDENTIAL_ID_BYTES)?;
            let raw_token = self.random_base64url(CONNECT_TOKEN_BYTES)?;
            let token_hash = hash_host_token(&raw_token);

            let host = Host {
                id: host_id.clone(),
                name: host_name,
                kind: HostKind::Remote,
                user_id: user_id.clone(),
                installation_id: None,
                last_seen_at: None,
                revoked_at: None,
                created_at,
                activated_at: None,
                finalized_at: None,
                provisioning_source: HostProvisioningSource::UserInvite,
                display_label: None,
            };
            let credential = NewHostCredential {
                id: credential_id,
                host_id,
                token_hash,
                kind: HostCredentialKind::LongLived,
                expires_at: None,
                consumed_at: None,
                revoked_at: None,
            };

            match self
                .unit_of_work
                .create_host_and_credential(host, credential)
                .await
            {
                Ok(host) => {
                    return Ok(HostInviteCreatedFact {
                        host,
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

pub fn hash_host_token(token: &str) -> String {
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
        sync::{Arc, Mutex},
    };

    use super::*;

    #[derive(Clone, Default)]
    struct RecordingStore(Arc<Mutex<Vec<(Host, NewHostCredential)>>>);

    impl HostInviteUnitOfWork for RecordingStore {
        async fn create_host_and_credential(
            &self,
            host: Host,
            credential: NewHostCredential,
        ) -> Result<Host, HostInviteWriteError> {
            self.0.lock().unwrap().push((host.clone(), credential));
            Ok(host)
        }
    }

    struct FixedEntropy(Mutex<VecDeque<u8>>);

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

    struct FixedClock;

    impl Clock for FixedClock {
        fn unix_time_ms(&self) -> Result<i64, HostInviteError> {
            Ok(1_700_000_000_123)
        }
    }

    #[tokio::test]
    async fn creates_the_host_and_default_credential_as_one_semantic_write() {
        let store = RecordingStore::default();
        let entropy = FixedEntropy(Mutex::new((0_u8..60).collect()));
        let service = CreateHostInvite::new(store.clone(), entropy, FixedClock);

        let fact = service.execute("user-1".into()).await.unwrap();
        let raw_token = fact.connect_token.reveal_once();
        let writes = store.0.lock().unwrap();
        let (host, credential) = &writes[0];

        assert_eq!(host.id, "AAECAwQFBgcICQoL");
        assert_eq!(host.name, "computer-0c0d0e0f");
        assert_eq!(host.user_id, "user-1");
        assert_eq!(host.created_at, 1_700_000_000_123);
        assert_eq!(host.kind, HostKind::Remote);
        assert_eq!(host.provisioning_source, HostProvisioningSource::UserInvite);
        assert_eq!(host.activated_at, None);
        assert_eq!(host.finalized_at, None);
        assert_eq!(credential.id, "EBESExQVFhcYGRob");
        assert_eq!(credential.host_id, host.id);
        assert_eq!(credential.kind, HostCredentialKind::LongLived);
        assert_eq!(credential.expires_at, None);
        assert_eq!(credential.consumed_at, None);
        assert_eq!(credential.revoked_at, None);
        assert_eq!(raw_token.len(), 43);
        assert_ne!(credential.token_hash, raw_token);
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
