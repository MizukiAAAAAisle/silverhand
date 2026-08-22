use std::path::Path;

use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

const CURRENT_SCHEMA: &str = include_str!(
    "../../../../../packages/backend/tests/migration-baseline/schema-current.normalized.txt"
);

const REQUIRED_ENTRIES: &[&str] = &[
    "table users: ",
    "table hosts: ",
    "table host_credentials: ",
    "index idx_hosts_user: ",
    "index idx_host_credentials_host: ",
    "index uniq_hosts_user_installation_when_active: ",
];

/// Materializes only the Host slice from the checked-in current-schema oracle.
/// The destination must be a new file under the operating system temp root.
pub async fn create_current_host_schema(path: &Path) -> SqliteConnection {
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

    for prefix in REQUIRED_ENTRIES {
        let statement = unique_statement(prefix);
        sqlx::query(statement)
            .execute(&mut connection)
            .await
            .unwrap_or_else(|error| panic!("current-schema entry {prefix:?} failed: {error}"));
    }
    sqlx::query(
        "INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES ('user-1', 'user-1', 'User One', 1, 1)",
    )
    .execute(&mut connection)
    .await
    .expect("current users schema must accept the Host fixture owner");
    connection
}

fn unique_statement(prefix: &str) -> &'static str {
    let matches = CURRENT_SCHEMA
        .lines()
        .filter_map(|line| line.strip_prefix(prefix))
        .collect::<Vec<_>>();
    assert_eq!(
        matches.len(),
        1,
        "checked-in current schema must contain exactly one {prefix:?} entry"
    );
    let statement = matches[0];
    assert!(
        statement.starts_with("CREATE "),
        "current-schema entry must remain executable DDL"
    );
    statement
}
