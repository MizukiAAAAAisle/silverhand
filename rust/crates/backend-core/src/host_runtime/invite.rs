//! Creating a user-managed computer: one host row and its first connect credential,
//! or nothing.
//!
//! The invitation is the only operation that brings a host into existence without a
//! prior coordinate to name, so it also owns the retry a unique host name needs.
//! Everything about the credential itself — the token, its verifier, the reveal-once
//! plaintext — comes from [`super::custody`]; this module decides only which host the
//! credential belongs to.

use thiserror::Error;

use super::{
    custody::{ConnectToken, NewLongLivedCredential, mint_credential},
    environment::{
        Clock, ClockFailure, EntropyFailure, EntropySource, now_ms, random_base64url, random_hex,
    },
};
use crate::{foundation::identity::UserId, foundation::persistence::PersistenceFailure};

const HOST_ID_BYTES: usize = 12;
const HOST_NAME_BYTES: usize = 4;
const HOST_NAME_ATTEMPTS: usize = 8;

/// The only host state this operation may create. Lifecycle fields that are
/// impossible for a fresh invitation do not exist in the core model.
pub struct NewUserInviteHost {
    id: String,
    name: String,
    user_id: UserId,
    created_at: i64,
}

impl NewUserInviteHost {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn user_id(&self) -> &UserId {
        &self.user_id
    }
    pub fn created_at(&self) -> i64 {
        self.created_at
    }
}

/// A committed invitation fact. Fixed row/DTO defaults are projections owned by
/// adapters, not optional state carried through the application layer.
pub struct CreatedUserInviteHost {
    id: String,
    name: String,
    user_id: UserId,
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
    pub fn user_id(&self) -> &UserId {
        &self.user_id
    }
    pub fn created_at(&self) -> i64 {
        self.created_at
    }
}

pub struct HostInviteCreatedFact {
    pub host: CreatedUserInviteHost,
    pub connect_token: ConnectToken,
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

#[derive(Debug, Error)]
pub enum HostInviteError {
    #[error(transparent)]
    Entropy(#[from] EntropyFailure),
    #[error(transparent)]
    Clock(#[from] ClockFailure),
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

    pub async fn execute(&self, user_id: UserId) -> Result<HostInviteCreatedFact, HostInviteError> {
        for _ in 0..HOST_NAME_ATTEMPTS {
            let host_id = random_base64url(&self.entropy, HOST_ID_BYTES)?;
            let host_name = format!("computer-{}", random_hex(&self.entropy, HOST_NAME_BYTES)?);
            let (credential, connect_token) =
                mint_credential(&self.entropy, &host_id)?.into_parts();
            let host = NewUserInviteHost {
                id: host_id,
                name: host_name,
                user_id: user_id.clone(),
                created_at: now_ms(&self.clock)?,
            };
            let created = CreatedUserInviteHost::from_new(&host);

            match self
                .unit_of_work
                .create_host_and_credential(host, credential)
                .await
            {
                Ok(()) => {
                    return Ok(HostInviteCreatedFact {
                        host: created,
                        connect_token,
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
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        convert::Infallible,
        error::Error as _,
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

    type RecordedWrite = (String, String, UserId, String, String, String, i64);

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
                credential.id().to_owned(),
                credential.host_id().to_owned(),
                credential.token_hash().to_owned(),
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
        type Error = Infallible;

        fn unix_time_ms(&self) -> Result<i64, Self::Error> {
            Ok(1_700_000_000_123)
        }
    }

    #[derive(Debug, Error)]
    #[error("clock unavailable")]
    struct ClockUnavailable;

    struct FailingClock;
    impl Clock for FailingClock {
        type Error = ClockUnavailable;

        fn unix_time_ms(&self) -> Result<i64, Self::Error> {
            Err(ClockUnavailable)
        }
    }

    fn user() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    #[tokio::test]
    async fn creates_only_the_state_owned_by_a_fresh_user_invite() {
        let store = RecordingStore::new(StoreBehavior::Succeed);
        let service = CreateHostInvite::new(store.clone(), FixedEntropy::bytes(60), FixedClock);
        let fact = service.execute(user()).await.unwrap();
        let raw_token = fact.connect_token.reveal_once();
        let writes = store.writes.lock().unwrap();
        let (host_id, name, user_id, credential_id, credential_host, token_hash, created_at) =
            &writes[0];

        assert_eq!(host_id, "AAECAwQFBgcICQoL");
        assert_eq!(name, "computer-0c0d0e0f");
        assert_eq!(user_id.as_str(), "user-1");
        assert_eq!(created_at, &1_700_000_000_123);
        assert_eq!(credential_id, "EBESExQVFhcYGRob");
        assert_eq!(credential_host, host_id);
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
        // A successful fact owns a reveal-once token, so it is deliberately not
        // printable and `unwrap_err` is unavailable.
        let Err(error) = service.execute(user()).await else {
            panic!("entropy failure must be reported, not a created host");
        };
        assert!(matches!(error, HostInviteError::Entropy(_)));
        assert_eq!(error.to_string(), "secure random source failed");
        assert_eq!(error.source().unwrap().to_string(), "entropy unavailable");
        assert_eq!(store.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn clock_failure_happens_before_the_unit_of_work() {
        let store = RecordingStore::new(StoreBehavior::Succeed);
        let service = CreateHostInvite::new(store.clone(), FixedEntropy::bytes(60), FailingClock);
        let Err(error) = service.execute(user()).await else {
            panic!("clock failure must be reported, not a created host");
        };
        assert!(matches!(error, HostInviteError::Clock(_)));
        assert_eq!(error.to_string(), "system clock failed");
        assert_eq!(error.source().unwrap().to_string(), "clock unavailable");
        assert_eq!(store.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn retries_one_duplicate_name_then_succeeds() {
        let store = RecordingStore::new(StoreBehavior::DuplicateOnce);
        let service = CreateHostInvite::new(store.clone(), FixedEntropy::bytes(120), FixedClock);
        let fact = service.execute(user()).await.unwrap();
        assert_eq!(store.calls.load(Ordering::SeqCst), 2);
        assert_eq!(fact.host.name(), "computer-48494a4b");
    }

    #[tokio::test]
    async fn eight_duplicate_names_exhaust_the_contract() {
        let store = RecordingStore::new(StoreBehavior::AlwaysDuplicate);
        let service = CreateHostInvite::new(store.clone(), FixedEntropy::bytes(8 * 60), FixedClock);
        assert!(matches!(
            service.execute(user()).await,
            Err(HostInviteError::NameAllocation)
        ));
        assert_eq!(store.calls.load(Ordering::SeqCst), 8);
    }
}
