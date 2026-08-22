use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    host_runtime::{
        CredentialAuthState, CredentialKind, HostCredentialLookup, HostInviteUnitOfWork,
        HostInviteWriteError, NewLongLivedCredential, NewUserInviteHost,
    },
    persistence::PersistenceFailure,
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const ROOT_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";

#[derive(Clone)]
pub struct SqliteHostRuntimeStore {
    pool: SqlitePool,
}

#[derive(Debug, Error)]
pub enum SqliteHostRuntimeStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
}

impl SqliteHostRuntimeStore {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SqliteHostRuntimeStoreError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        Ok(Self { pool })
    }

    async fn create_transaction(
        &self,
        host: NewUserInviteHost,
        credential: NewLongLivedCredential,
    ) -> Result<(), HostInviteWriteError> {
        let mut tx = self
            .pool
            .begin_with(ROOT_WRITE_BEGIN)
            .await
            .map_err(persistence)?;
        let name_exists: i64 =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM hosts WHERE name = ?)")
                .bind(host.name())
                .fetch_one(&mut *tx)
                .await
                .map_err(persistence)?;
        if name_exists != 0 {
            return Err(HostInviteWriteError::DuplicateHostName);
        }

        sqlx::query(
            "INSERT INTO hosts
                (id, name, kind, user_id, installation_id, last_seen_at, revoked_at,
                 created_at, display_label, activated_at, finalized_at, provisioning_source)
             VALUES (?, ?, 'remote', ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, 'user_invite')",
        )
        .bind(host.id())
        .bind(host.name())
        .bind(host.user_id())
        .bind(host.created_at())
        .execute(&mut *tx)
        .await
        .map_err(persistence)?;

        sqlx::query(
            "INSERT INTO host_credentials
                (id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at)
             VALUES (?, ?, ?, 'long_lived', NULL, NULL, NULL)",
        )
        .bind(credential.id())
        .bind(credential.host_id())
        .bind(credential.token_hash())
        .execute(&mut *tx)
        .await
        .map_err(persistence)?;

        tx.commit().await.map_err(persistence)?;
        Ok(())
    }
}

impl HostInviteUnitOfWork for SqliteHostRuntimeStore {
    async fn create_host_and_credential(
        &self,
        host: NewUserInviteHost,
        credential: NewLongLivedCredential,
    ) -> Result<(), HostInviteWriteError> {
        self.create_transaction(host, credential).await
    }
}

impl HostCredentialLookup for SqliteHostRuntimeStore {
    async fn lookup_by_token_hash(
        &self,
        token_hash: String,
    ) -> Result<Option<CredentialAuthState>, PersistenceFailure> {
        let row = sqlx::query(
            "SELECT c.id AS credential_id, c.host_id, c.kind, c.expires_at,
                    c.consumed_at, c.revoked_at AS credential_revoked_at,
                    h.user_id AS host_user_id, h.revoked_at AS host_revoked_at
               FROM host_credentials c
               JOIN hosts h ON h.id = c.host_id
              WHERE c.token_hash = ?",
        )
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await
        .map_err(PersistenceFailure::from_source)?;
        row.map(|row| -> Result<CredentialAuthState, sqlx::Error> {
            let kind: String = row.try_get("kind")?;
            Ok(CredentialAuthState {
                credential_id: row.try_get("credential_id")?,
                host_id: row.try_get("host_id")?,
                host_user_id: row.try_get("host_user_id")?,
                kind: decode_credential_kind(&kind)?,
                expires_at: row.try_get("expires_at")?,
                consumed_at: row.try_get("consumed_at")?,
                credential_revoked_at: row.try_get("credential_revoked_at")?,
                host_revoked_at: row.try_get("host_revoked_at")?,
            })
        })
        .transpose()
        .map_err(PersistenceFailure::from_source)
    }
}

fn persistence(error: sqlx::Error) -> HostInviteWriteError {
    HostInviteWriteError::Persistence(PersistenceFailure::from_source(error))
}

fn decode_credential_kind(kind: &str) -> Result<CredentialKind, sqlx::Error> {
    match kind {
        "long_lived" => Ok(CredentialKind::LongLived),
        "bootstrap" => Ok(CredentialKind::Bootstrap),
        _ => Err(sqlx::Error::Decode(Box::new(InvalidCredentialKind))),
    }
}

#[derive(Debug, Error)]
#[error("persisted host credential kind is unsupported")]
struct InvalidCredentialKind;

#[cfg(test)]
#[path = "../../tests/support/current_schema.rs"]
mod current_schema;

#[cfg(test)]
mod tests {
    use silverhand_backend_core::host_runtime::{
        CreateHostInvite, HostTokenRejection, OsEntropy, SystemClock, VerifyHostTokenFact,
        verify_host_token,
    };
    use sqlx::Connection;
    use tempfile::TempDir;

    use super::*;

    async fn fixture() -> (TempDir, SqliteHostRuntimeStore) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("host.sqlite");
        super::current_schema::create_current_host_schema(&path)
            .await
            .close()
            .await
            .unwrap();
        let store = SqliteHostRuntimeStore::open(&path).await.unwrap();
        (directory, store)
    }

    #[tokio::test]
    async fn persists_only_the_hash_and_verifies_after_reopening() {
        let (directory, store) = fixture().await;
        let service = CreateHostInvite::new(store.clone(), OsEntropy, SystemClock);
        let fact = service.execute("user-1".into()).await.unwrap();
        let host_id = fact.host.id().to_owned();
        let redacted = format!("{:?}", fact.connect_token);
        let raw_token = fact.connect_token.reveal_once();
        drop(service);
        drop(store);

        let reopened = SqliteHostRuntimeStore::open(directory.path().join("host.sqlite"))
            .await
            .unwrap();
        let verified = verify_host_token(&reopened, format!("  {raw_token}  "), i64::MAX / 2)
            .await
            .unwrap();
        assert!(
            matches!(verified, VerifyHostTokenFact::Accepted { host_id: ref verified_id, ref user_id, .. } if verified_id == &host_id && user_id == "user-1")
        );

        let row = sqlx::query("SELECT token_hash FROM host_credentials WHERE host_id = ?")
            .bind(&host_id)
            .fetch_one(&reopened.pool)
            .await
            .unwrap();
        let stored: String = row.try_get("token_hash").unwrap();
        assert_ne!(stored, raw_token);
        assert_eq!(redacted, "ConnectToken([REDACTED])");
        assert!(!redacted.contains(&raw_token));

        let row = sqlx::query(
            "SELECT h.kind, h.provisioning_source, h.installation_id, h.last_seen_at,
                    h.revoked_at, h.display_label, h.activated_at, h.finalized_at,
                    c.kind AS credential_kind, c.expires_at, c.consumed_at,
                    c.revoked_at AS credential_revoked_at
               FROM hosts h
               JOIN host_credentials c ON c.host_id = h.id
              WHERE h.id = ?",
        )
        .bind(&host_id)
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("kind"), "remote");
        assert_eq!(row.get::<String, _>("provisioning_source"), "user_invite");
        assert_eq!(row.get::<String, _>("credential_kind"), "long_lived");
        for column in ["installation_id", "display_label"] {
            assert_eq!(
                row.get::<Option<String>, _>(column),
                None,
                "column {column}"
            );
        }
        for column in [
            "last_seen_at",
            "revoked_at",
            "activated_at",
            "finalized_at",
            "expires_at",
            "consumed_at",
            "credential_revoked_at",
        ] {
            assert_eq!(row.get::<Option<i64>, _>(column), None, "column {column}");
        }
    }

    #[tokio::test]
    async fn credential_failure_rolls_back_the_host_row() {
        let (_directory, store) = fixture().await;
        sqlx::query("CREATE TRIGGER refuse_credential BEFORE INSERT ON host_credentials BEGIN SELECT RAISE(ABORT, 'credential refused'); END")
            .execute(&store.pool)
            .await
            .unwrap();
        let service = CreateHostInvite::new(store.clone(), OsEntropy, SystemClock);

        assert!(service.execute("user-1".into()).await.is_err());
        let host_count: i64 = sqlx::query_scalar("SELECT count(*) FROM hosts")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let credential_count: i64 = sqlx::query_scalar("SELECT count(*) FROM host_credentials")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!((host_count, credential_count), (0, 0));
    }

    #[tokio::test]
    async fn unknown_and_blank_tokens_are_rejected_without_plaintext_comparison() {
        let (_directory, store) = fixture().await;
        assert_eq!(
            verify_host_token(&store, "   ".into(), 0).await.unwrap(),
            VerifyHostTokenFact::Rejected(HostTokenRejection::Missing)
        );
        assert_eq!(
            verify_host_token(&store, "unknown".into(), 0)
                .await
                .unwrap(),
            VerifyHostTokenFact::Rejected(HostTokenRejection::Missing)
        );
    }

    #[test]
    fn credential_kind_is_decoded_at_the_sqlite_boundary() {
        assert_eq!(
            decode_credential_kind("long_lived").unwrap(),
            CredentialKind::LongLived
        );
        assert_eq!(
            decode_credential_kind("bootstrap").unwrap(),
            CredentialKind::Bootstrap
        );
        assert!(decode_credential_kind("future_kind").is_err());
    }
}
