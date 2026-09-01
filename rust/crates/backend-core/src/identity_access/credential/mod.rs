//! The password-credential bounded context.
//!
//! This context owns the `user_password_credentials` authority: how a
//! plaintext password becomes a stored PHC + provenance record, and how a
//! login attempt is verified. The PHC string is the sole verify authority; the
//! structured [`PasswordHashParams`] is honest audit/provenance that the
//! persistence layer serializes into `password_hash_params`.
//!
//! Core only ever *produces* the Rust provenance arm, so it models exactly
//! that. The backward-compatible producer union that also *reads* legacy
//! `@node-rs/argon2` rows is a persistence-representation concern and lives at
//! the SQLite boundary (which already owns JSON serialization).

mod password;
mod store;

pub use password::{
    ARGON2ID_ALGORITHM, ARGON2ID_VERSION, Argon2idCost, Argon2idPasswordHasher, CostMeasurer,
    EmptyCandidateLadder, FLOOR_MEMORY_COST_KIB, FLOOR_TIME_COST, OUTPUT_LEN, PasswordHashError,
    PasswordHashParams, PasswordHasher, PasswordKdf, PreparedPasswordCredential, RUST_PRODUCER,
    RealArgon2Measurer, RustCalibration, TARGET_HASH_MILLIS,
};
pub use store::{LoginCandidate, LoginCredentialLookup};
