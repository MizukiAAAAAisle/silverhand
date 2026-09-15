//! Self-service password replacement. Hashing stays outside the write transaction;
//! the adapter compares the verified PHC and retires human sessions atomically.
use super::{PasswordHashError, PasswordHasher, PreparedPasswordCredential};
use crate::{
    foundation::{identity::UserId, persistence::PersistenceFailure},
    identity_access::auth::SessionTokenHash,
};
use std::future::Future;

pub trait PasswordChangeStore: Clone + Send + Sync + 'static {
    fn password_for_user(
        &self,
        user: &UserId,
    ) -> impl Future<Output = Result<Option<String>, PersistenceFailure>> + Send;
    fn replace_password(
        &self,
        user: &UserId,
        session: &SessionTokenHash,
        expected: &str,
        replacement: PreparedPasswordCredential,
        now_ms: i64,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

#[derive(Debug, thiserror::Error)]
pub enum PasswordChangeError {
    #[error("password persistence failed")]
    Persistence(#[from] PersistenceFailure),
    #[error("password hashing failed")]
    Hash(#[from] PasswordHashError),
}

pub async fn change_password<S: PasswordChangeStore, H: PasswordHasher>(
    store: &S,
    hasher: &H,
    user: &UserId,
    session: &SessionTokenHash,
    current: &str,
    replacement: &str,
    now_ms: i64,
) -> Result<bool, PasswordChangeError> {
    let Some(expected) = store.password_for_user(user).await? else {
        hasher.verify_dummy(current).await?;
        return Ok(false);
    };
    if !hasher.verify(&expected, current).await? {
        return Ok(false);
    }
    let prepared = hasher.hash(replacement).await?;
    Ok(store
        .replace_password(user, session, &expected, prepared, now_ms)
        .await?)
}
