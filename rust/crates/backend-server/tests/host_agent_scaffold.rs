//! Scaffold gates for the #2195 host-agent lane.
//!
//! They lock invariants, not the current shape: a new pure library in
//! `backend-core` or a new leaf in a lane namespace must stay green, while the
//! forbidden dependency/capability/activation edges must turn red.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

/// Driver, wire and runtime families. `backend-core` stays free of all of them
/// through its whole normal + build dependency closure.
const DRIVER_WIRE_RUNTIME: &[&str] = &[
    "axum",
    "http",
    "http-body",
    "hyper",
    "libsqlite3-sys",
    "serde",
    "serde_json",
    "sqlx",
    "sqlx-core",
    "sqlx-sqlite",
    "tokio",
    "tokio-tungstenite",
    "tower",
    "tower-http",
    "tracing",
    "tracing-subscriber",
    "ts-rs",
    "tungstenite",
];

const LANE_NAMESPACES: &[(&str, &str)] = &[
    ("backend-core", "policy"),
    ("backend-server", "host_agent_background"),
];

fn rust_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("rust workspace root")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// Declared dependency names per manifest section.
fn manifest_sections(crate_dir: &str) -> BTreeMap<String, BTreeSet<String>> {
    let source = read(
        &rust_root()
            .join("crates")
            .join(crate_dir)
            .join("Cargo.toml"),
    );
    let mut sections = BTreeMap::new();
    let mut current = String::new();
    for line in source.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = name.to_owned();
            continue;
        }
        if !current.ends_with("dependencies") {
            continue;
        }
        let Some((key, _)) = line.split_once('=') else {
            continue;
        };
        let name = key.trim().split('.').next().unwrap_or("").trim();
        if !name.is_empty() {
            sections
                .entry(current.clone())
                .or_insert_with(BTreeSet::new)
                .insert(name.to_owned());
        }
    }
    sections
}

fn declared(crate_dir: &str, section: &str) -> BTreeSet<String> {
    manifest_sections(crate_dir)
        .remove(section)
        .unwrap_or_default()
}

/// Resolved edges from the lock file. Third-party packages carry no resolved
/// dev-dependencies, so this is the normal + build graph for them.
fn locked_edges() -> BTreeMap<String, BTreeSet<String>> {
    let source = read(&rust_root().join("Cargo.lock"));
    let mut edges = BTreeMap::new();
    let mut name = String::new();
    let mut in_dependencies = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed == "[[package]]" {
            name.clear();
            in_dependencies = false;
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("name = ") {
            name = value.trim_matches('"').to_owned();
            continue;
        }
        if trimmed == "dependencies = [" {
            in_dependencies = true;
            continue;
        }
        if in_dependencies {
            if trimmed == "]" {
                in_dependencies = false;
                continue;
            }
            let dependency = trimmed
                .trim_end_matches(',')
                .trim_matches('"')
                .split(' ')
                .next()
                .unwrap_or("")
                .to_owned();
            if !dependency.is_empty() {
                edges
                    .entry(name.clone())
                    .or_insert_with(BTreeSet::new)
                    .insert(dependency);
            }
        }
    }
    edges
}

fn workspace_members() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("silverhand-backend-app".into(), "backend-app".into()),
        ("silverhand-backend-core".into(), "backend-core".into()),
        ("silverhand-backend-server".into(), "backend-server".into()),
        ("silverhand-backend-sqlite".into(), "backend-sqlite".into()),
    ])
}

/// Normal + build closure. Workspace members contribute their declared normal
/// and build sections, never their dev-dependencies.
fn production_closure(crate_dir: &str) -> BTreeSet<String> {
    let edges = locked_edges();
    let members = workspace_members();
    let mut seen = BTreeSet::new();
    let mut queue: VecDeque<String> = declared(crate_dir, "dependencies")
        .into_iter()
        .chain(declared(crate_dir, "build-dependencies"))
        .collect();
    while let Some(package) = queue.pop_front() {
        if !seen.insert(package.clone()) {
            continue;
        }
        let next: BTreeSet<String> = match members.get(&package) {
            Some(member_dir) => declared(member_dir, "dependencies")
                .into_iter()
                .chain(declared(member_dir, "build-dependencies"))
                .collect(),
            None => edges.get(&package).cloned().unwrap_or_default(),
        };
        queue.extend(next);
    }
    seen
}

fn strip_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut in_block = false;
    while let Some(character) = chars.next() {
        if in_block {
            if character == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block = false;
            }
            continue;
        }
        if character == '/' {
            match chars.peek() {
                Some('/') => {
                    for skipped in chars.by_ref() {
                        if skipped == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                    continue;
                }
                Some('*') => {
                    chars.next();
                    in_block = true;
                    continue;
                }
                _ => {}
            }
        }
        out.push(character);
    }
    out
}

fn rust_sources(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(directory) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(rust_sources(&path));
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
    files.sort();
    files
}

fn lane_source_paths(crate_dir: &str, namespace: &str) -> Vec<PathBuf> {
    rust_sources(
        &rust_root()
            .join("crates")
            .join(crate_dir)
            .join("src")
            .join(namespace),
    )
}

/// Whether the source reaches `namespace` as a path segment. Bare substring
/// matching is not usable here: `roster_policy` is a column, not a module.
fn names_path_segment(source: &str, namespace: &str) -> bool {
    let bytes = source.as_bytes();
    let is_ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let mut index = 0;
    while index < bytes.len() {
        if !is_ident(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && is_ident(bytes[index]) {
            index += 1;
        }
        if &source[start..index] != namespace {
            continue;
        }
        let follows_path = source[..start].ends_with("::");
        let leads_path = source[index..].starts_with("::");
        if follows_path || leads_path {
            return true;
        }
    }
    source
        .lines()
        .filter(|line| line.trim_start().starts_with("use "))
        .any(|line| {
            line.split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
                .any(|token| token == namespace)
        })
}

#[test]
fn g1_core_carries_no_driver_wire_or_runtime_dependency() {
    let closure = production_closure("backend-core");
    let forbidden: Vec<&str> = DRIVER_WIRE_RUNTIME
        .iter()
        .copied()
        .filter(|package| closure.contains(*package))
        .collect();
    assert!(
        forbidden.is_empty(),
        "backend-core production closure reached {forbidden:?}"
    );
    assert!(closure.contains("base64") && closure.contains("sha2"));
}

#[test]
fn g1_the_persistence_and_wire_crates_keep_their_direction() {
    assert!(
        !declared("backend-sqlite", "dependencies").contains("silverhand-backend-server"),
        "backend-sqlite must not depend on the wire crate"
    );
    assert!(
        !production_closure("backend-server").contains("silverhand-backend-sqlite"),
        "backend-server production code must not be able to name the SQLite adapter"
    );
    assert!(
        declared("backend-server", "dev-dependencies").contains("silverhand-backend-sqlite"),
        "the SQLite adapter is a backend-server test-only dependency"
    );
}

#[test]
fn g2_background_policy_names_no_timer_or_driver() {
    // Residual guard only: aliases, macros and re-exports can bypass a source
    // scan. The compile-enforced carrier is G1 plus core's manifest.
    const FORBIDDEN_PATHS: &[&str] = &[
        "tokio",
        "std::time",
        "Instant",
        "SystemTime",
        "sleep",
        "spawn",
        "axum",
        "sqlx",
    ];
    for path in lane_source_paths("backend-core", "policy") {
        let source = strip_comments(&read(&path));
        for forbidden in FORBIDDEN_PATHS {
            assert!(
                !source.contains(forbidden),
                "{} names {forbidden}: policy decisions stay timer-free",
                path.display()
            );
        }
    }
}

#[test]
fn g2_background_timers_carry_no_http_surface() {
    for path in lane_source_paths("backend-server", "host_agent_background") {
        let source = strip_comments(&read(&path));
        for forbidden in ["axum", "Router", "StatusCode"] {
            assert!(
                !source.contains(forbidden),
                "{} names {forbidden}: timers are not an HTTP surface",
                path.display()
            );
        }
    }
}

#[test]
fn g3_cp1_activation_fence_keeps_the_lane_unmounted() {
    // CP1-temporary. The reviewed integration mount invalidates this gate on
    // purpose and deletes it in the same change; owner: the review gate.
    assert!(names_path_segment(
        "silverhand_backend_core::policy::presence_grace::is_online(a, b)",
        "policy"
    ));
    assert!(names_path_segment(
        "use silverhand_backend_core::policy;\n",
        "policy"
    ));
    assert!(!names_path_segment(
        "\"INSERT INTO conversations (roster_policy) VALUES ('open')\"",
        "policy"
    ));

    let app = rust_sources(&rust_root().join("crates/backend-app/src"));
    assert!(!app.is_empty());
    for path in app {
        let source = strip_comments(&read(&path));
        for (_, namespace) in LANE_NAMESPACES {
            assert!(
                !names_path_segment(&source, namespace),
                "{} references {namespace}: CP1 ships no composition edge",
                path.display()
            );
        }
    }
}

#[test]
fn g4_the_seam_touches_only_crate_roots_and_only_as_declarations() {
    for (crate_dir, namespace) in LANE_NAMESPACES {
        let declaration = format!("pub mod {namespace};");
        let root = rust_root()
            .join("crates")
            .join(crate_dir)
            .join("src/lib.rs");
        let source = read(&root);
        assert_eq!(
            source
                .lines()
                .filter(|line| line.trim() == declaration)
                .count(),
            1,
            "{} must declare {namespace} exactly once",
            root.display()
        );
        for (other_dir, _) in LANE_NAMESPACES {
            if other_dir == crate_dir {
                continue;
            }
            let other = rust_root()
                .join("crates")
                .join(other_dir)
                .join("src/lib.rs");
            assert!(
                !read(&other).contains(namespace),
                "{} must not name {namespace}",
                other.display()
            );
        }
    }
}

#[test]
fn g5_namespaces_declare_and_never_carry_business() {
    for (crate_dir, namespace) in LANE_NAMESPACES {
        let path = rust_root()
            .join("crates")
            .join(crate_dir)
            .join("src")
            .join(namespace)
            .join("mod.rs");
        for line in read(&path).lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("//!") {
                continue;
            }
            let is_declaration = (line.starts_with("mod ")
                || line.starts_with("pub mod ")
                || line.starts_with("pub use "))
                && line.ends_with(';');
            assert!(
                is_declaration,
                "{} carries `{line}`: a namespace declares and re-exports only",
                path.display()
            );
        }
    }
}
