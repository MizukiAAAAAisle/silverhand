//! Email recovery-code password reset.
//!
//! A code is bound to one account and one issuance (`code_id`) and stored only as an
//! HMAC under a process-memory key, so a database copy cannot enumerate the six-digit
//! space; a restart therefore invalidates every outstanding code. Every reset
//! attempt is counted before the code is compared, so concurrent guesses cannot
//! exceed the budget. Hashing a new password happens outside any write transaction;
//! the store re-checks every condition when it commits the reset.
use std::future::Future;

use hmac::{KeyInit, Mac};
use sha2::Sha256;

use super::{PasswordHashError, PasswordHasher, PreparedPasswordCredential};
use crate::{
    foundation::{identity::UserId, persistence::PersistenceFailure},
    host_runtime::environment::EntropySource,
};

pub const RECOVERY_CODE_TTL_MS: i64 = 15 * 60 * 1000;
pub const RECOVERY_CODE_MAX_ATTEMPTS: i64 = 5;
pub const RECOVERY_WINDOW_MS: i64 = 60 * 60 * 1000;
pub const RECOVERY_WINDOW_MAX_SENDS: i64 = 5;
pub const RECOVERY_WINDOW_MAX_ATTEMPTS: i64 = 10;
pub const RECOVERY_RESEND_INTERVAL_MS: i64 = 60 * 1000;

const PURPOSE: &[u8] = b"silverhand.password-recovery.v1";

/// The process-memory HMAC key. Never persisted or logged.
#[derive(Clone)]
pub struct RecoveryCodeKey([u8; 32]);

impl std::fmt::Debug for RecoveryCodeKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RecoveryCodeKey([REDACTED])")
    }
}

#[derive(Debug, thiserror::Error)]
#[error("secure random source failed")]
pub struct RecoveryEntropyFailure(#[source] Box<dyn std::error::Error + Send + Sync>);

impl RecoveryCodeKey {
    pub fn generate<E: EntropySource>(entropy: &E) -> Result<Self, RecoveryEntropyFailure> {
        let mut key = [0u8; 32];
        entropy
            .fill(&mut key)
            .map_err(|error| RecoveryEntropyFailure(Box::new(error)))?;
        Ok(Self(key))
    }

    pub fn digest(&self, user: &UserId, code_id: &str, code: &str) -> String {
        let mut mac = hmac::Hmac::<Sha256>::new_from_slice(&self.0).expect("any key length");
        for part in [
            PURPOSE,
            user.as_str().as_bytes(),
            code_id.as_bytes(),
            code.as_bytes(),
        ] {
            mac.update(&(part.len() as u64).to_be_bytes());
            mac.update(part);
        }
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

/// A freshly issued code, handed to the mail sender only.
pub struct IssuedRecoveryCode {
    pub email: String,
    pub code: String,
}

impl std::fmt::Debug for IssuedRecoveryCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("IssuedRecoveryCode([REDACTED])")
    }
}

/// A live code the reset may test against.
pub struct PendingRecoveryCode {
    pub user_id: UserId,
    pub code_id: String,
    pub code_hash: String,
}

pub trait PasswordRecoveryStore: Clone + Send + Sync + 'static {
    fn account_for_email(
        &self,
        email: &str,
    ) -> impl Future<Output = Result<Option<UserId>, PersistenceFailure>> + Send;
    /// Stores the code if the account still has this email and the hourly send,
    /// attempt and resend-interval limits allow it. `false` means nothing changed.
    fn issue_code(
        &self,
        user: &UserId,
        email: &str,
        code_id: &str,
        code_hash: &str,
        now_ms: i64,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
    /// Atomically spends one attempt on the live code for this email, within the
    /// per-code and hourly attempt budgets. `None` means no attempt is available.
    fn claim_attempt(
        &self,
        email: &str,
        now_ms: i64,
    ) -> impl Future<Output = Result<Option<PendingRecoveryCode>, PersistenceFailure>> + Send;
    /// Atomically re-checks every pending condition, replaces the password,
    /// clears the code and revokes all sessions. `false` means nothing changed.
    fn complete_reset(
        &self,
        code: &PendingRecoveryCode,
        email: &str,
        replacement: PreparedPasswordCredential,
        now_ms: i64,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

#[derive(Debug, thiserror::Error)]
pub enum PasswordRecoveryError {
    #[error("password recovery persistence failed")]
    Persistence(#[from] PersistenceFailure),
    #[error("password hashing failed")]
    Hash(#[from] PasswordHashError),
    #[error(transparent)]
    Entropy(#[from] RecoveryEntropyFailure),
}

/// Six uniformly random decimal digits.
fn random_code<E: EntropySource>(entropy: &E) -> Result<String, RecoveryEntropyFailure> {
    const SPACE: u32 = 1_000_000;
    const LIMIT: u32 = u32::MAX - (u32::MAX % SPACE);
    loop {
        let mut bytes = [0u8; 4];
        entropy
            .fill(&mut bytes)
            .map_err(|error| RecoveryEntropyFailure(Box::new(error)))?;
        let value = u32::from_be_bytes(bytes);
        if value < LIMIT {
            return Ok(format!("{:06}", value % SPACE));
        }
    }
}

fn random_code_id<E: EntropySource>(entropy: &E) -> Result<String, RecoveryEntropyFailure> {
    let mut bytes = [0u8; 16];
    entropy
        .fill(&mut bytes)
        .map_err(|error| RecoveryEntropyFailure(Box::new(error)))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// `None` covers every non-issuing case (unknown email, limits), so callers cannot
/// tell them apart.
pub async fn issue_recovery_code<S: PasswordRecoveryStore, E: EntropySource>(
    store: &S,
    key: &RecoveryCodeKey,
    entropy: &E,
    email: &str,
    now_ms: i64,
) -> Result<Option<IssuedRecoveryCode>, PasswordRecoveryError> {
    let Some(user) = store.account_for_email(email).await? else {
        return Ok(None);
    };
    let code_id = random_code_id(entropy)?;
    let code = random_code(entropy)?;
    let code_hash = key.digest(&user, &code_id, &code);
    if !store
        .issue_code(&user, email, &code_id, &code_hash, now_ms)
        .await?
    {
        return Ok(None);
    }
    Ok(Some(IssuedRecoveryCode {
        email: email.to_owned(),
        code,
    }))
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

pub async fn reset_password_with_code<
    S: PasswordRecoveryStore,
    H: PasswordHasher,
    C: crate::identity_access::auth::SessionClock,
>(
    store: &S,
    hasher: &H,
    clock: &C,
    key: &RecoveryCodeKey,
    email: &str,
    code: &str,
    replacement: &str,
) -> Result<bool, PasswordRecoveryError> {
    let Some(pending) = store.claim_attempt(email, clock.now_unix_millis()).await? else {
        // Same digest work as the existing-code branch.
        let _ = key.digest(
            &UserId::parse("-").expect("non-empty"),
            "0".repeat(32).as_str(),
            code,
        );
        return Ok(false);
    };
    let presented = key.digest(&pending.user_id, &pending.code_id, code);
    if !constant_time_eq(&presented, &pending.code_hash) {
        return Ok(false);
    }
    let prepared = hasher.hash(replacement).await?;
    // Expiry is judged at commit time; hashing can outlast the code.
    Ok(store
        .complete_reset(&pending, email, prepared, clock.now_unix_millis())
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Counter(std::sync::atomic::AtomicU32);
    #[derive(Debug, thiserror::Error)]
    #[error("never")]
    struct Never;
    impl EntropySource for Counter {
        type Error = Never;
        fn fill(&self, destination: &mut [u8]) -> Result<(), Never> {
            let next = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            for (index, byte) in destination.iter_mut().enumerate() {
                *byte = next.to_be_bytes()[index % 4];
            }
            Ok(())
        }
    }

    #[test]
    fn codes_are_six_digits_and_reject_the_biased_tail() {
        let entropy = Counter(std::sync::atomic::AtomicU32::new(u32::MAX - 3));
        let code = random_code(&entropy).unwrap();
        assert_eq!(code.len(), 6);
        assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
        assert_eq!(code, "000000");
    }

    #[test]
    fn the_digest_binds_account_issuance_and_key() {
        let key = RecoveryCodeKey([7; 32]);
        let other = RecoveryCodeKey([8; 32]);
        let user = UserId::parse("user-1").unwrap();
        let base = key.digest(&user, "id-1", "123456");
        assert_eq!(base, key.digest(&user, "id-1", "123456"));
        assert_ne!(
            base,
            key.digest(&UserId::parse("user-2").unwrap(), "id-1", "123456")
        );
        assert_ne!(base, key.digest(&user, "id-2", "123456"));
        assert_ne!(base, key.digest(&user, "id-1", "123457"));
        assert_ne!(base, other.digest(&user, "id-1", "123456"));
        assert_eq!(base.len(), 64);
    }
}
