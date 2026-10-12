//! Self-service account deletion.
//!
//! Deleting an account removes the `users` row and everything that is only the
//! person's (sessions, credentials, memberships, preferences, reads, saved items,
//! notifications, reactions, follows, computers). Conversation content stays: a
//! message keeps its send-time author snapshot and resolves as a deleted author.
//!
//! Deletion is refused while the account still owns agents or regular workspaces;
//! the person deletes or transfers those first.

use std::future::Future;

use crate::{
    foundation::identity::{AgentId, HostId, UserId, WorkspaceId},
    foundation::persistence::PersistenceFailure,
    identity_access::{
        auth::SessionTokenHash,
        avatar::AvatarBlobPointer,
        credential::{PasswordHashError, PasswordHasher},
        user_identity::ParticipantHandle,
    },
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnedAgent {
    pub id: AgentId,
    pub name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnedWorkspace {
    pub id: WorkspaceId,
    pub name: String,
}

/// What still has to go before the account may be deleted.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AccountDeletionBlockers {
    pub agents: Vec<OwnedAgent>,
    pub workspaces: Vec<OwnedWorkspace>,
}

impl AccountDeletionBlockers {
    pub fn is_clear(&self) -> bool {
        self.agents.is_empty() && self.workspaces.is_empty()
    }
}

/// Post-commit residue of a deleted account: bytes and connections that the
/// deleted rows used to name.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeletedAccount {
    pub user_id: UserId,
    pub avatar: Option<AvatarBlobPointer>,
    pub hosts: Vec<HostId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AccountDeletionWrite {
    Deleted(DeletedAccount),
    /// The handle, password or session no longer match what was verified.
    Rejected,
    Blocked(AccountDeletionBlockers),
}

pub trait AccountDeletionStore: Clone + Send + Sync + 'static {
    fn deletion_blockers(
        &self,
        user: &UserId,
    ) -> impl Future<Output = Result<AccountDeletionBlockers, PersistenceFailure>> + Send;

    fn password_for_user(
        &self,
        user: &UserId,
    ) -> impl Future<Output = Result<Option<String>, PersistenceFailure>> + Send;

    /// Re-checks handle, password hash and session under the write lock, then
    /// deletes in one transaction.
    fn delete_account(
        &self,
        user: &UserId,
        session: &SessionTokenHash,
        handle: &ParticipantHandle,
        expected_password_hash: &str,
    ) -> impl Future<Output = Result<AccountDeletionWrite, PersistenceFailure>> + Send;
}

#[derive(Debug, thiserror::Error)]
pub enum AccountDeletionError {
    #[error("account deletion persistence failed")]
    Persistence(#[from] PersistenceFailure),
    #[error("password verification failed")]
    Hash(#[from] PasswordHashError),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AccountDeletionOutcome {
    Deleted(DeletedAccount),
    /// Wrong password or handle. One arm so the answer is not an oracle for which.
    Rejected,
    Blocked(AccountDeletionBlockers),
}

pub async fn delete_account<S: AccountDeletionStore, H: PasswordHasher>(
    store: &S,
    hasher: &H,
    user: &UserId,
    session: &SessionTokenHash,
    handle: &ParticipantHandle,
    password: &str,
) -> Result<AccountDeletionOutcome, AccountDeletionError> {
    let Some(expected) = store.password_for_user(user).await? else {
        hasher.verify_dummy(password).await?;
        return Ok(AccountDeletionOutcome::Rejected);
    };
    if !hasher.verify(&expected, password).await? {
        return Ok(AccountDeletionOutcome::Rejected);
    }
    Ok(
        match store
            .delete_account(user, session, handle, &expected)
            .await?
        {
            AccountDeletionWrite::Deleted(deleted) => AccountDeletionOutcome::Deleted(deleted),
            AccountDeletionWrite::Rejected => AccountDeletionOutcome::Rejected,
            AccountDeletionWrite::Blocked(blockers) => AccountDeletionOutcome::Blocked(blockers),
        },
    )
}
