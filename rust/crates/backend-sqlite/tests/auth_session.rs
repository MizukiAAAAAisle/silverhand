use std::{error::Error, time::Duration};

use silverhand_backend_core::{
    auth::{HumanSessionAuthenticator, SessionBearer, SessionClock, SessionTtl},
    identity::UserId,
};
use silverhand_backend_sqlite::auth::SqliteSessionStore;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use tempfile::TempDir;

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

const NOW: i64 = 10_000;
const TTL: i64 = 1_000;
const VALID_HASH: &str = "OXoqnFv14szsOMJZa2grsb0F_m5OzqbBDPQnVf8iVAM";
const REVOKED_HASH: &str = "oGgRJHJu_7FtXTjQVIJO4CegvaRq_JWjptU6zmpNusk";
const EXPIRED_HASH: &str = "tSs-8iM4WM4RVthfI1zyxB7d-oyh7tySQ5i5rx2zA8s";
const BOUNDARY_HASH: &str = "rAzQshJaBPdCX82x4n3GQPepXUl8FxwXubjtlRZSBX0";
const EMPTY_USER_HASH: &str = "TIPzKVFB8ZoQg-Fcla9AwGIxD5Upr5yHyKr6sSVFStE";
const DANGLING_HASH: &str = "VYguZpuzxBLIPi-HTFzK0B_Jgr8VjbxjrAoTTTxnLFQ";

#[derive(Clone)]
struct FixedClock;

impl SessionClock for FixedClock {
    fn now_unix_millis(&self) -> i64 {
        NOW
    }
}

async fn fixture() -> (TempDir, std::path::PathBuf, SqliteSessionStore) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sessions.sqlite");
    let mut connection = current_schema::create_current_schema(&path).await;
    sqlx::query(
        "INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES ('user-1', 'user-1', 'User One', 1, 1)",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
    let store = SqliteSessionStore::open(&path).await.unwrap();
    (directory, path, store)
}

async fn insert_session(
    path: &std::path::Path,
    id: &str,
    user_id: &str,
    hash: &str,
    last_used_at: i64,
    revoked_at: Option<i64>,
) {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query(
        "INSERT INTO auth_sessions
            (id, user_id, token_hash, created_at, last_used_at, revoked_at,
             user_agent, ip_first_seen)
         VALUES (?, ?, ?, 1, ?, ?, NULL, NULL)",
    )
    .bind(id)
    .bind(user_id)
    .bind(hash)
    .bind(last_used_at)
    .bind(revoked_at)
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
}

fn authenticator(
    store: SqliteSessionStore,
) -> HumanSessionAuthenticator<SqliteSessionStore, FixedClock> {
    HumanSessionAuthenticator::new(store, FixedClock, SessionTtl::from_millis(TTL).unwrap())
}

async fn last_used_at(path: &std::path::Path, id: &str) -> i64 {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    let value = sqlx::query_scalar("SELECT last_used_at FROM auth_sessions WHERE id = ?")
        .bind(id)
        .fetch_one(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    value
}

#[tokio::test]
async fn valid_session_is_one_committed_typed_fact_and_only_its_hash_is_stored() {
    let (_directory, path, store) = fixture().await;
    insert_session(&path, "valid", "user-1", VALID_HASH, 9_500, None).await;

    let user = authenticator(store)
        .authenticate(SessionBearer::parse("valid-token").unwrap())
        .await
        .unwrap()
        .unwrap();

    assert_eq!(user, UserId::parse("user-1").unwrap());
    assert_eq!(last_used_at(&path, "valid").await, NOW);
    let file = std::fs::read(&path).unwrap();
    assert!(!String::from_utf8_lossy(&file).contains("valid-token"));
}

#[tokio::test]
async fn unknown_revoked_and_expired_sessions_share_one_refusal_and_are_not_touched() {
    let (_directory, path, store) = fixture().await;
    insert_session(&path, "revoked", "user-1", REVOKED_HASH, 9_500, Some(9_900)).await;
    insert_session(&path, "expired", "user-1", EXPIRED_HASH, 8_999, None).await;
    let authenticator = authenticator(store);

    for token in ["unknown-token", "revoked-token", "expired-token"] {
        assert!(
            authenticator
                .authenticate(SessionBearer::parse(token).unwrap())
                .await
                .unwrap()
                .is_none(),
            "{token} escaped the uniform refusal"
        );
    }
    assert_eq!(last_used_at(&path, "revoked").await, 9_500);
    assert_eq!(last_used_at(&path, "expired").await, 8_999);
}

#[tokio::test]
async fn exact_sliding_ttl_boundary_is_still_eligible() {
    let (_directory, path, store) = fixture().await;
    insert_session(&path, "boundary", "user-1", BOUNDARY_HASH, NOW - TTL, None).await;

    let result = authenticator(store)
        .authenticate(SessionBearer::parse("boundary-token").unwrap())
        .await
        .unwrap();

    assert_eq!(result.unwrap().as_str(), "user-1");
    assert_eq!(last_used_at(&path, "boundary").await, NOW);
}

#[tokio::test]
async fn a_concurrent_revoke_finishes_before_validation_can_return_a_principal() {
    let (_directory, path, store) = fixture().await;
    insert_session(&path, "valid", "user-1", VALID_HASH, 9_500, None).await;
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    let mut revoke = sqlx::Connection::begin_with(&mut connection, "BEGIN IMMEDIATE")
        .await
        .unwrap();
    sqlx::query("UPDATE auth_sessions SET revoked_at = 9999 WHERE id = 'valid'")
        .execute(&mut *revoke)
        .await
        .unwrap();

    let mut validation = tokio::spawn(async move {
        authenticator(store)
            .authenticate(SessionBearer::parse("valid-token").unwrap())
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(25), &mut validation)
            .await
            .is_err(),
        "validation escaped while revoke still owned the writer"
    );
    revoke.commit().await.unwrap();

    assert!(validation.await.unwrap().unwrap().is_none());
    assert_eq!(last_used_at(&path, "valid").await, 9_500);
}

#[tokio::test]
async fn invalid_typed_user_rolls_back_the_touch_and_preserves_the_decode_cause() {
    let (_directory, path, store) = fixture().await;
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query(
        "INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES ('', 'empty-id-user', 'Empty Id', 1, 1)",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
    insert_session(&path, "empty-user", "", EMPTY_USER_HASH, 9_500, None).await;

    let failure = authenticator(store)
        .authenticate(SessionBearer::parse("empty-user-token").unwrap())
        .await
        .unwrap_err();

    assert!(error_chain(&failure).contains("persisted session user id is invalid"));
    assert!(error_chain(&failure).contains("user id must not be empty"));
    assert_eq!(last_used_at(&path, "empty-user").await, 9_500);
}

#[tokio::test]
async fn dangling_user_is_an_integrity_failure_before_a_principal_can_escape() {
    let (_directory, path, store) = fixture().await;
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .foreign_keys(false);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query(
        "INSERT INTO auth_sessions
            (id, user_id, token_hash, created_at, last_used_at, revoked_at,
             user_agent, ip_first_seen)
         VALUES ('dangling', 'missing-user', ?, 1, 9500, NULL, NULL, NULL)",
    )
    .bind(DANGLING_HASH)
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();

    let failure = authenticator(store)
        .authenticate(SessionBearer::parse("dangling-token").unwrap())
        .await
        .unwrap_err();

    assert!(error_chain(&failure).contains("authenticated session references a missing user"));
    assert_eq!(last_used_at(&path, "dangling").await, 9_500);
}

#[tokio::test]
async fn real_driver_failure_is_returned_as_the_persistence_source() {
    let (_directory, path, store) = fixture().await;
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("DROP TABLE auth_sessions")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();

    let failure = authenticator(store)
        .authenticate(SessionBearer::parse("valid-token").unwrap())
        .await
        .unwrap_err();

    assert!(error_chain(&failure).contains("no such table: auth_sessions"));
}

fn error_chain(error: &(dyn Error + 'static)) -> String {
    let mut messages = vec![error.to_string()];
    let mut current = error.source();
    while let Some(cause) = current {
        messages.push(cause.to_string());
        current = cause.source();
    }
    messages.join(": ")
}
