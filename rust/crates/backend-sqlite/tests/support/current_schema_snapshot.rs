use std::path::Path;

use sqlx::{Connection, Executor, SqliteConnection, sqlite::SqliteConnectOptions};

const CURRENT_SCHEMA: &str =
    include_str!("../../../../../packages/backend/tests/migration-baseline/schema-current.sql");

/// Materializes the checked-in executable current-schema artifact into a new
/// database under the operating system temp root.
pub async fn create_current_schema(path: &Path) -> SqliteConnection {
    assert!(!path.exists(), "schema test database must be a fresh file");
    let parent = path.parent().expect("test database path needs a parent");
    let parent = parent.canonicalize().expect("temp parent must exist");
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .expect("system temp root must exist");
    assert!(
        parent.starts_with(&temp_root),
        "schema test database must stay under the system temp root"
    );

    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .expect("fresh test database must open");

    connection
        .execute(sqlx::raw_sql(CURRENT_SCHEMA))
        .await
        .expect("checked-in executable current schema must load");
    connection
}
