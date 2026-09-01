//! SQLite adapter for the password-credential context's `user_password_credentials`
//! authority.
//!
//! Two responsibilities meet here, both persistence-representation concerns the
//! core deliberately does not own:
//!
//! * [`SqliteCredentialStore`] answers the login lookup ([`LoginCredentialLookup`]):
//!   an email resolves to `(user_id, password_hash?)`. It is a pure consumer of an
//!   existing product database.
//! * [`serialize_password_hash_params`] is the write half of the persisted
//!   `password_hash_params` codec. Core produces only the Rust provenance arm, so
//!   the serializer emits exactly one shape — a discriminated member of the SAME
//!   backward-compatible producer union the TS `parsePasswordHashParams` reads
//!   (discriminated by `library`). The camelCase field names and the shared cost
//!   fields (`memoryCostKiB`/`timeCost`/`parallelism`/`outputLen`, which the TS
//!   `Argon2idCostCandidate` base declares) are the wire contract both producers
//!   speak; a checked-in fixture (`tests/fixtures/password-hash-params-rust.json`)
//!   pins the exact bytes so the two implementations cannot drift.

use std::{path::Path, time::Duration};

use serde::Serialize;
use silverhand_backend_core::{
    foundation::persistence::PersistenceFailure,
    identity::UserId,
    identity_access::credential::{
        LoginCandidate, LoginCredentialLookup, PasswordHashParams, RUST_PRODUCER,
    },
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
/// The provenance algorithm tag, spelled the way it is persisted.
const ALGORITHM: &str = "argon2id";
/// The Argon2 version tag, matching the core `ARGON2ID_VERSION`.
const VERSION: &str = "0x13";

const LOOKUP_LOGIN: &str = "\
SELECT u.id AS user_id, c.password_hash AS password_hash \
  FROM users u \
  LEFT JOIN user_password_credentials c ON c.user_id = u.id \
 WHERE u.email = ? COLLATE NOCASE";

/// A pooled connection to an existing product database offering the login-lookup
/// read. Holds no clock: the login flow spends no write here.
#[derive(Clone)]
pub struct SqliteCredentialStore {
    pool: SqlitePool,
}

/// Startup/driver failures surfaced only to the composition root that opens the
/// store; the port method hands the driver error over as a `PersistenceFailure`.
#[derive(Debug, Error)]
pub enum SqliteCredentialStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
}

/// A committed `users.id` that decodes to a value the domain refuses (the empty
/// string). The product schema's ids are non-empty by construction, so this is a
/// persistence-integrity fault, never coerced to a sentinel.
#[derive(Debug, Error)]
#[error("users.id holds an unusable identifier")]
struct CorruptStoredUserId;

impl SqliteCredentialStore {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SqliteCredentialStoreError> {
        let pool = SqlitePoolOptions::new()
            .max_connections(POOL_CONNECTIONS)
            .connect_with(login_options(path.as_ref()))
            .await?;
        Ok(Self { pool })
    }

    /// Construct over an already-open pool so a composition root that shares one
    /// pool across adapters need not reopen the file.
    pub fn from_pool(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn login_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(BUSY_TIMEOUT)
}

impl LoginCredentialLookup for SqliteCredentialStore {
    async fn lookup_login(
        &self,
        email: &str,
    ) -> Result<Option<LoginCandidate>, PersistenceFailure> {
        let row = sqlx::query(LOOKUP_LOGIN)
            .bind(email)
            .fetch_optional(&self.pool)
            .await
            .map_err(PersistenceFailure::from_source)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let raw_user_id: String = row
            .try_get("user_id")
            .map_err(PersistenceFailure::from_source)?;
        let user_id = UserId::parse(raw_user_id)
            .map_err(|_| PersistenceFailure::from_source(CorruptStoredUserId))?;
        let password_hash: Option<String> = row
            .try_get("password_hash")
            .map_err(PersistenceFailure::from_source)?;
        Ok(Some(LoginCandidate {
            user_id,
            password_hash,
        }))
    }
}

// ===========================================================================
// The persisted `password_hash_params` codec — Rust producer arm.
// ===========================================================================

/// The persisted shape of the Rust producer arm. Field order and camelCase names
/// are the wire contract shared with the TS reader; the cost knobs sit at the top
/// level (the shared `Argon2idCostCandidate` base), and the honest Rust calibration
/// lives under `calibration` — never the Node-only `benchmark` fields.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RustParamsWire<'a> {
    algorithm: &'a str,
    library: &'a str,
    version: &'a str,
    // serde's camelCase lowercases the trailing "B" of "KiB"; the wire contract
    // (the TS `Argon2idCostCandidate`) spells it `memoryCostKiB`, so pin it.
    #[serde(rename = "memoryCostKiB")]
    memory_cost_kib: u32,
    time_cost: u32,
    parallelism: u32,
    output_len: u32,
    calibration: CalibrationWire,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationWire {
    target_ms: u64,
    measured_ms: u64,
    candidate_count: u32,
    #[serde(rename = "floorMemoryCostKiB")]
    floor_memory_cost_kib: u32,
    floor_time_cost: u32,
}

/// Serialize the structured Rust provenance into the `password_hash_params` JSON
/// column. The output is a member of the producer union discriminated by
/// `library == "silverhand/argon2-rustcrypto"`; the TS `parsePasswordHashParams`
/// admits it alongside the legacy `@node-rs/argon2` arm.
pub fn serialize_password_hash_params(params: &PasswordHashParams) -> String {
    let wire = RustParamsWire {
        algorithm: ALGORITHM,
        library: RUST_PRODUCER,
        version: VERSION,
        memory_cost_kib: params.cost.memory_cost_kib,
        time_cost: params.cost.time_cost,
        parallelism: params.cost.parallelism,
        output_len: params.cost.output_len,
        calibration: CalibrationWire {
            target_ms: params.calibration.target_millis,
            measured_ms: params.calibration.measured_millis,
            candidate_count: params.calibration.candidate_count,
            floor_memory_cost_kib: params.calibration.floor_memory_cost_kib,
            floor_time_cost: params.calibration.floor_time_cost,
        },
    };
    // The struct is total and every field a plain scalar, so serialization cannot
    // fail; a change that could fail must revisit this expectation deliberately.
    serde_json::to_string(&wire).expect("serializing password_hash_params cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverhand_backend_core::identity_access::credential::{Argon2idCost, RustCalibration};
    use sqlx::{Connection, Executor, SqliteConnection};

    const CURRENT_SCHEMA: &str =
        include_str!("../../../../packages/backend/tests/migration-baseline/schema-current.sql");

    // A signup user with a credential, a profile-only user (no credential row), and
    // a stranger email that resolves to no row at all.
    const SEED_SQL: &str = "\
INSERT INTO users (id, name, display_name, email, created_at, updated_at) \
  VALUES ('user-1', 'alice', 'Alice', 'alice@example.com', 1, 1); \
INSERT INTO users (id, name, display_name, email, created_at, updated_at) \
  VALUES ('user-2', 'bob', 'Bob', 'bob@example.com', 1, 1); \
INSERT INTO user_password_credentials (user_id, password_hash, password_hash_params, password_updated_at) \
  VALUES ('user-1', '$argon2id$v=19$stored', '{\"algorithm\":\"argon2id\"}', 1);";

    async fn open_seeded() -> (tempfile::TempDir, SqliteCredentialStore) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credential.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        db.execute(sqlx::raw_sql(CURRENT_SCHEMA)).await.unwrap();
        db.execute(sqlx::raw_sql(SEED_SQL)).await.unwrap();
        db.close().await.unwrap();
        let store = SqliteCredentialStore::open(&path).await.unwrap();
        (directory, store)
    }

    #[tokio::test]
    async fn a_signup_user_resolves_to_its_user_and_stored_phc() {
        let (_dir, store) = open_seeded().await;
        let candidate = store
            .lookup_login("alice@example.com")
            .await
            .unwrap()
            .expect("a row for a known email");
        assert_eq!(candidate.user_id.as_str(), "user-1");
        assert_eq!(
            candidate.password_hash.as_deref(),
            Some("$argon2id$v=19$stored")
        );
    }

    #[tokio::test]
    async fn a_profile_only_user_resolves_with_a_null_hash() {
        let (_dir, store) = open_seeded().await;
        let candidate = store
            .lookup_login("bob@example.com")
            .await
            .unwrap()
            .expect("a row for a profile-only user");
        assert_eq!(candidate.user_id.as_str(), "user-2");
        assert_eq!(candidate.password_hash, None);
    }

    #[tokio::test]
    async fn the_lookup_is_case_insensitive_on_email() {
        let (_dir, store) = open_seeded().await;
        let candidate = store.lookup_login("ALICE@EXAMPLE.COM").await.unwrap();
        assert_eq!(candidate.unwrap().user_id.as_str(), "user-1");
    }

    #[tokio::test]
    async fn an_unknown_email_resolves_to_none() {
        let (_dir, store) = open_seeded().await;
        assert!(
            store
                .lookup_login("nobody@example.com")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn the_rust_arm_serializes_to_the_checked_in_fixture_bytes() {
        let params = PasswordHashParams {
            cost: Argon2idCost {
                memory_cost_kib: 19 * 1024,
                time_cost: 2,
                parallelism: 1,
                output_len: 32,
            },
            calibration: RustCalibration {
                target_millis: 250,
                measured_millis: 262,
                candidate_count: 3,
                floor_memory_cost_kib: 19 * 1024,
                floor_time_cost: 2,
            },
        };
        let fixture = include_str!("../tests/fixtures/password-hash-params-rust.json");
        assert_eq!(serialize_password_hash_params(&params), fixture.trim_end());
    }
}
