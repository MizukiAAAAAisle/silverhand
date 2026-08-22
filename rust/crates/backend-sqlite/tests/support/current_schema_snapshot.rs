use std::path::Path;

use sqlx::{AssertSqlSafe, Connection, SqliteConnection, sqlite::SqliteConnectOptions};

const CURRENT_SCHEMA: &str = include_str!(
    "../../../../../packages/backend/tests/migration-baseline/schema-current.normalized.txt"
);

const EXPECTED_TABLES: usize = 33;
const EXPECTED_INDEXES: usize = 73;
const EXPECTED_TRIGGERS: usize = 47;

/// Materializes the checked-in current schema into a new database under the
/// operating system temp root.
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

    for (kind, expected) in [
        ("table", EXPECTED_TABLES),
        ("index", EXPECTED_INDEXES),
        ("trigger", EXPECTED_TRIGGERS),
    ] {
        let entries = schema_entries(kind);
        assert_eq!(
            entries.len(),
            expected,
            "checked-in current schema {kind} count changed"
        );
        for (name, statement) in entries {
            sqlx::query(AssertSqlSafe(statement))
                .execute(&mut connection)
                .await
                .unwrap_or_else(|error| panic!("current-schema {kind} {name:?} failed: {error}"));
        }
    }
    connection
}

fn schema_entries(kind: &str) -> Vec<(&'static str, String)> {
    let prefix = format!("{kind} ");
    CURRENT_SCHEMA
        .lines()
        .filter_map(|line| {
            let entry = line.strip_prefix(&prefix)?;
            let (name, statement) = entry
                .split_once(": ")
                .unwrap_or_else(|| panic!("malformed current-schema {kind} entry"));
            assert!(!name.is_empty(), "current-schema {kind} name is empty");
            assert!(
                statement.starts_with("CREATE "),
                "current-schema {kind} {name:?} is not executable DDL"
            );
            Some((name, strip_collapsed_line_comments(statement)))
        })
        .collect()
}

fn strip_collapsed_line_comments(statement: &str) -> String {
    let mut output = String::with_capacity(statement.len());
    let mut remaining = statement;
    while let Some(comment_start) = remaining.find("--") {
        output.push_str(&remaining[..comment_start]);
        let comment = &remaining[comment_start + 2..];
        let resume = comment
            .match_indices(". ")
            .find_map(|(end, _)| {
                let candidate = &comment[end + 2..];
                sql_resume(candidate).then_some(end + 2)
            })
            .unwrap_or_else(|| panic!("collapsed SQL comment has no executable continuation"));
        output.push(' ');
        remaining = &comment[resume..];
    }
    output.push_str(remaining);
    output
}

fn sql_resume(candidate: &str) -> bool {
    let candidate = candidate.trim_start();
    if [
        "CHECK ",
        "CONSTRAINT ",
        "FOREIGN ",
        "PRIMARY ",
        "SELECT ",
        "UNIQUE ",
    ]
    .iter()
    .any(|prefix| candidate.starts_with(prefix))
    {
        return true;
    }
    let mut words = candidate.split_whitespace();
    let Some(_column) = words.next() else {
        return false;
    };
    matches!(
        words.next().map(|word| word.trim_end_matches(',')),
        Some("BLOB" | "INTEGER" | "NUMERIC" | "REAL" | "TEXT")
    )
}
