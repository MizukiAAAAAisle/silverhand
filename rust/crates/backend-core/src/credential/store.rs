//! The login-verification read face of the credential context.
//!
//! Signup and reset PRODUCE credentials (the hashing authority in
//! [`super::password`]); login CONSULTS them. This port is that consult: an email
//! resolves to the owning user and the stored PHC — or to nothing. It is
//! deliberately a read model, not the `user_password_credentials` row: the login
//! flow needs exactly the user id and the verify authority (the PHC string),
//! never the provenance JSON.
//!
//! The two "cannot authenticate" shapes — no such email, and an email whose user
//! carries no password (a profile-only identity) — are NOT distinguished here.
//! Both surface so the login flow spends one dummy Argon2id verify and returns the
//! single uniform failure, so response timing cannot separate "unknown email"
//! from "no password" from "wrong password".

use std::future::Future;

use crate::{identity::UserId, persistence::PersistenceFailure};

/// What an email resolves to for login: the owning user, and the stored PHC if a
/// password credential exists. `password_hash` is `None` for a profile-only user
/// (a row in `users` with no row in `user_password_credentials`), which the login
/// flow treats identically to an unknown email.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoginCandidate {
    pub user_id: UserId,
    pub password_hash: Option<String>,
}

/// Resolve a normalized login email to its [`LoginCandidate`]. `None` is "no user
/// answers to this email" — indistinguishable, by design, from a user with no
/// password once the login flow has spent its dummy verify.
pub trait LoginCredentialLookup: Clone + Send + Sync + 'static {
    fn lookup_login(
        &self,
        email: &str,
    ) -> impl Future<Output = Result<Option<LoginCandidate>, PersistenceFailure>> + Send;
}
