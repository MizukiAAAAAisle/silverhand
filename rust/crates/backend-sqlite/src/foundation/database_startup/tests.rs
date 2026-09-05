use super::*;

// Deterministic subprocess barrier, absent from every production binary. It
// pauses the actual preparation owner while contenders exercise both runners.
pub(super) fn pause_preparation(path: &Path, phase: &str) {
    if std::env::var_os("SILVERHAND_TEST_PREPARATION_DB").as_deref() != Some(path.as_os_str())
        || std::env::var("SILVERHAND_TEST_PREPARATION_PHASE").as_deref() != Ok(phase)
    {
        return;
    }
    use std::io::Write as _;
    println!("PREPARATION_PAUSED:{phase}");
    std::io::stdout().flush().unwrap();
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
}

#[tokio::test]
async fn preparation_subprocess_owner() {
    let Some(path) = std::env::var_os("SILVERHAND_TEST_PREPARATION_DB") else {
        return;
    };
    let path = PathBuf::from(path);
    let allowed = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../.cache")
        .canonicalize()
        .unwrap();
    assert!(
        path.parent()
            .unwrap()
            .canonicalize()
            .unwrap()
            .starts_with(allowed)
    );
    prepare_database(&path, true).await.unwrap();
}

fn isolated() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.cache/task2352-startup");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap()
}

async fn connect(path: &Path) -> SqliteConnection {
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full),
    )
    .await
    .unwrap()
}

async fn snapshot(
    db: &mut SqliteConnection,
    omit_retired_preferences: bool,
) -> Vec<(String, Vec<String>)> {
    let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_migrations' ORDER BY name").fetch_all(&mut *db).await.unwrap();
    let mut result = vec![];
    for table in tables {
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
                .bind(&table)
                .fetch_all(&mut *db)
                .await
                .unwrap();
        let quoted = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        let projection = columns
            .iter()
            .map(|c| format!("quote({})", quoted(c)))
            .collect::<Vec<_>>()
            .join(",");
        let predicate = if omit_retired_preferences && table == "user_list_sort_mode" {
            " WHERE NOT (list_key='workspaces' AND scope IN ('','pinned'))"
        } else {
            ""
        };
        let sql = format!(
            "SELECT json_array({projection}) FROM {}{predicate}",
            quoted(&table)
        );
        let mut rows: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.as_str()))
            .fetch_all(&mut *db)
            .await
            .unwrap();
        rows.sort();
        result.push((table, rows));
    }
    result
}

#[tokio::test]
async fn empty_store_runs_shared_history_without_ts_then_current_is_noop() {
    let root = isolated();
    let path = root.path().join("data/database.sqlite");
    let first = prepare_database(&path, false).await.unwrap();
    assert_eq!(first.before_step, 0);
    assert_eq!(first.after_step, 88);
    assert_eq!(first.after_epoch, 69);
    assert_eq!(first.applied_steps, (44..=88).collect::<Vec<_>>());
    assert!(first.backup_path.is_none());
    let second = prepare_database(&path, false).await.unwrap();
    assert!(second.applied_steps.is_empty());
    assert!(second.backup_path.is_none());
    let mut db = connect(&path).await;
    let ledger: Vec<(i64, String)> =
        sqlx::query_as("SELECT version,name FROM _migrations ORDER BY version")
            .fetch_all(&mut db)
            .await
            .unwrap();
    assert_eq!(
        ledger,
        plan()
            .steps
            .into_iter()
            .map(|s| (s.version, s.name))
            .collect::<Vec<_>>()
    );
    db.close().await.unwrap();
}

#[tokio::test]
async fn step87_upgrade_requires_permission_and_restorable_directory_backup() {
    let root = isolated();
    let path = root.path().join("data/database.sqlite");
    fs::create_dir(path.parent().unwrap()).unwrap();
    let mut old_plan = plan();
    old_plan.steps.retain(|s| s.version <= 87);
    let mut db = connect(&path).await;
    prepare_connected(&mut db, &path, true, &old_plan)
        .await
        .unwrap();
    db.execute(sqlx::raw_sql(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/backend/tests/fixtures/workspace-cold-read/seed.sql"
    ))))
    .await
    .unwrap();
    db.execute("INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at,author_id,author_name,author_display_name) VALUES ('message-1','conv-open','human','user-1','Preserved 世界',1,100,'user-1','viewer','Viewer'); INSERT INTO auth_sessions(id,user_id,token_hash,created_at,last_used_at) VALUES ('session-1','user-1','synthetic-not-a-real-token',100,100); INSERT INTO user_list_sort_mode(user_id,list_key,scope,mode,updated_at) VALUES ('user-1','workspaces','','manual',1),('user-1','workspaces','pinned','manual',1),('user-1','channels','','manual',1)").await.unwrap();
    let before = snapshot(&mut db, false).await;
    let expected = snapshot(&mut db, true).await;
    assert_ne!(
        before, expected,
        "fixture contains the two intentionally retired preferences"
    );
    db.close().await.unwrap();
    fs::write(
        path.parent().unwrap().join("blob"),
        b"preserve file contents",
    )
    .unwrap();
    assert!(matches!(
        prepare_database(&path, false).await,
        Err(DatabaseStartupError::UpgradeDisabled { from: 87, to: 88 })
    ));
    let upgraded = prepare_database(&path, true).await.unwrap();
    assert_eq!(upgraded.applied_steps, vec![88]);
    let backup = upgraded.backup_path.unwrap();
    let mut live = connect(&path).await;
    assert_eq!(
        snapshot(&mut live, false).await,
        expected,
        "all non-retired business rows and fields preserved"
    );
    live.close().await.unwrap();
    assert_eq!(
        fs::read(backup.join("blob")).unwrap(),
        b"preserve file contents"
    );
    let restored = root.path().join("restored");
    copy_tree(&backup, &restored).unwrap();
    let restored_path = restored.join("database.sqlite");
    let mut db = connect(&restored_path).await;
    let version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _migrations")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(version, 87);
    assert_eq!(
        snapshot(&mut db, false).await,
        before,
        "restored backup recovers every old business row, including retired preferences"
    );
    db.close().await.unwrap();
    assert_eq!(
        prepare_database(&restored_path, true)
            .await
            .unwrap()
            .after_step,
        88
    );
    // Optional export for the real-process smoke; fixture generation remains a
    // test-only activity, never a production startup fallback.
    if let Some(output) = std::env::var_os("SILVERHAND_STARTUP_FIXTURE_EXPORT") {
        let output = PathBuf::from(output);
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        assert!(
            output
                .parent()
                .unwrap()
                .canonicalize()
                .unwrap()
                .starts_with(workspace.join(".cache"))
        );
        copy_tree(&backup, &output).unwrap();
    }
}

#[tokio::test]
async fn failed_step_rolls_back_sql_and_ledger_before_restart() {
    let root = isolated();
    let path = root.path().join("data/database.sqlite");
    fs::create_dir(path.parent().unwrap()).unwrap();
    let mut broken = plan();
    broken.steps[1]
        .up
        .push_str("; SELECT * FROM deliberate_missing_table;");
    let mut db = connect(&path).await;
    assert!(
        prepare_connected(&mut db, &path, true, &broken)
            .await
            .is_err()
    );
    db.close().await.unwrap();
    let mut db = connect(&path).await;
    let version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _migrations")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(version, 44);
    db.close().await.unwrap();
    let restarted = prepare_database(&path, true).await.unwrap();
    assert_eq!(restarted.applied_steps, (45..=88).collect::<Vec<_>>());
    assert!(restarted.backup_path.is_some());
}

#[tokio::test]
async fn migration_lock_refuses_second_owner_then_releases() {
    let root = isolated();
    let path = root.path().join("data/database.sqlite");
    fs::create_dir(path.parent().unwrap()).unwrap();
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .locking_mode(SqliteLockingMode::Exclusive)
        .journal_mode(SqliteJournalMode::Wal);
    let mut held = SqliteConnection::connect_with(&options).await.unwrap();
    held.execute("BEGIN EXCLUSIVE; COMMIT;").await.unwrap();
    assert!(prepare_database(&path, true).await.is_err());
    held.close().await.unwrap();
    prepare_database(&path, true).await.unwrap();
}

#[tokio::test]
async fn unsupported_gapped_and_malformed_ledgers_fail_without_recreating_data() {
    for (sql, expected) in [
        (
            "CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES('retain')",
            "schema_too_old",
        ),
        (
            "CREATE TABLE _migrations(version INTEGER); INSERT INTO _migrations VALUES(89)",
            "schema_too_new",
        ),
        (
            "CREATE TABLE _migrations(version INTEGER); INSERT INTO _migrations VALUES(44),(46)",
            "schema_ledger_inconsistent",
        ),
        (
            "CREATE TABLE _migrations(wrong_column INTEGER)",
            "database startup SQL failed",
        ),
    ] {
        let root = isolated();
        let path = root.path().join("data/db.sqlite");
        fs::create_dir(path.parent().unwrap()).unwrap();
        let mut db = connect(&path).await;
        db.execute(sql).await.unwrap();
        db.close().await.unwrap();
        let error = prepare_database(&path, true).await.unwrap_err();
        assert!(error.to_string().contains(expected), "{error}");
        assert!(path.exists());
        assert!(!root.path().join("data.migration.lock").exists());
        assert_eq!(
            fs::read_dir(root.path()).unwrap().count(),
            1,
            "no backup or replacement on admission refusal"
        );
    }
}

#[tokio::test]
async fn fk_escape_failure_rolls_back_and_restores_connection_pragmas() {
    let root = isolated();
    let path = root.path().join("db.sqlite");
    let mut db = connect(&path).await;
    let mut broken = plan();
    broken.steps[1].foreign_key_escape = true;
    broken.steps[1].up.push_str("; CREATE TABLE injected_parent(id INTEGER PRIMARY KEY); CREATE TABLE injected_child(id INTEGER REFERENCES injected_parent(id)); INSERT INTO injected_child VALUES(7);");
    assert!(matches!(
        prepare_connected(&mut db, &path, true, &broken).await,
        Err(DatabaseStartupError::Integrity(_))
    ));
    let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&mut db)
        .await
        .unwrap();
    let legacy: i64 = sqlx::query_scalar("PRAGMA legacy_alter_table")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!((fk, legacy), (1, 0));
    let partial: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema WHERE name LIKE 'injected_%'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(partial, 0);
    db.close().await.unwrap();
}

#[tokio::test]
async fn current_store_still_probes_write_lock_and_releases_ownership_on_failure() {
    let root = isolated();
    let path = root.path().join("data/db.sqlite");
    prepare_database(&path, true).await.unwrap();
    let mut db = connect(&path).await;
    let tx = db.begin_with("BEGIN IMMEDIATE").await.unwrap();
    assert!(prepare_database(&path, true).await.is_err());
    assert!(!root.path().join("data.migration.lock").exists());
    tx.rollback().await.unwrap();
    db.close().await.unwrap();
    assert!(
        prepare_database(&path, true)
            .await
            .unwrap()
            .applied_steps
            .is_empty()
    );
}

#[tokio::test]
async fn current_store_rejects_bad_persisted_address_keys() {
    let root = isolated();
    let path = root.path().join("data/db.sqlite");
    prepare_database(&path, true).await.unwrap();
    let mut db = connect(&path).await;
    db.execute("INSERT INTO workspaces(id,name,name_key,created_at,updated_at) VALUES('w','Correct','wrong',1,1)").await.unwrap();
    db.close().await.unwrap();
    assert!(matches!(
        prepare_database(&path, true).await,
        Err(DatabaseStartupError::Integrity(_))
    ));
    assert!(!root.path().join("data.migration.lock").exists());
}

#[cfg(unix)]
#[test]
fn backup_preserves_links_and_files_but_omits_runtime_socket() {
    use std::os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixListener,
    };
    let root = isolated();
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::write(data.join("file"), b"payload").unwrap();
    fs::set_permissions(data.join("file"), fs::Permissions::from_mode(0o600)).unwrap();
    symlink("file", data.join("link")).unwrap();
    let socket = data.join("s");
    let _listener = UnixListener::bind(&socket).unwrap();
    let dest = root.path().join("backup");
    copy_tree(&data, &dest).unwrap();
    assert_eq!(fs::read(dest.join("file")).unwrap(), b"payload");
    assert_eq!(fs::read_link(dest.join("link")).unwrap(), Path::new("file"));
    assert_eq!(
        fs::metadata(dest.join("file"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(!dest.join("s").exists());
}
