use std::{fs, path::Path};

const INNER_ROOTS: [&str; 3] = ["src/application", "src/contracts", "src/http"];

const ADAPTER_ONLY_MARKERS: [&str; 11] = [
    "sqlx",
    "sqlite",
    "pragma",
    "last_insert_rowid",
    "journal_mode",
    "busy_timeout",
    "foreign_keys",
    "migrate!",
    "crate::adapters",
    "crate::composition",
    "sqliteadaptererror",
];

/// A deliberately modest textual regression fence for this spike. This is not
/// a Rust module dependency proof: aliases and indirect re-exports can evade
/// lexical checks. Production should strengthen the direction with crate
/// dependencies and visibility.
#[test]
fn current_spike_keeps_sqlite_markers_out_of_inner_source() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));

    for root in INNER_ROOTS {
        for source_path in rust_sources_for_root(crate_root, root) {
            let source = fs::read_to_string(&source_path).unwrap();
            let normalized = source.to_ascii_lowercase();
            for marker in ADAPTER_ONLY_MARKERS {
                assert!(
                    !normalized.contains(marker),
                    "{} leaks adapter marker {marker:?}",
                    source_path.display()
                );
            }
        }
    }

    let adapter = fs::read_to_string(crate_root.join("src/adapters/sqlite.rs")).unwrap();
    assert!(adapter.contains("impl MessageUnitOfWork for SqliteDatabase"));
    for required in [
        "sqlx::migrate!",
        "SqlitePool",
        "foreign_keys(true)",
        "journal_mode(",
        "busy_timeout(",
        "last_insert_rowid()",
        "begin_with(ROOT_WRITE_BEGIN)",
        "BEGIN IMMEDIATE",
        ".commit().await?",
        "StoredMessageCreatedV1",
    ] {
        assert!(
            adapter.contains(required),
            "SQLite adapter no longer owns required detail {required:?}"
        );
    }
    assert!(
        !adapter.contains("contracts::") && !adapter.contains("ServerEvent"),
        "SQLite durable payload must not depend on HTTP/WS wire DTOs"
    );

    let composition = fs::read_to_string(crate_root.join("src/composition.rs")).unwrap();
    assert!(composition.contains("SqliteDatabase"));
    for forbidden in ["sqlx", "PRAGMA", "migrate!", ".begin(", ".commit("] {
        assert!(
            !composition.contains(forbidden),
            "composition root owns adapter implementation detail {forbidden:?}"
        );
    }
}

fn rust_sources_for_root(crate_root: &Path, root: &str) -> Vec<std::path::PathBuf> {
    let flat = crate_root.join(format!("{root}.rs"));
    let mut sources = vec![flat];
    let directory = crate_root.join(root);
    if directory.is_dir() {
        collect_rust_sources(&directory, &mut sources);
    }
    sources
}

fn collect_rust_sources(directory: &Path, sources: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect_rust_sources(&path, sources);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            sources.push(path);
        }
    }
}
