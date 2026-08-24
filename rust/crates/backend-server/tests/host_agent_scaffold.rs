//! Scaffold gates for the #2195 host-agent lane.
//!
//! They lock invariants, not the current shape: a new pure library in
//! `backend-core` or a new leaf in a lane namespace must stay green, while the
//! forbidden dependency/capability/activation edges must turn red.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde_json::Value;

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

/// Cargo's own resolution of the workspace, read once per gate.
///
/// A hand-written manifest or lock parser cannot see target-specific edges,
/// `package = ` renames, feature-gated optional edges, or two versions of one
/// name, so every dependency assertion below reads the resolved graph instead of
/// re-deriving one. `--locked --offline` keeps the lock file untouched.
struct ResolvedGraph {
    /// Package id to package name; ids are the only stable identity, because two
    /// versions of one crate share a name.
    names: BTreeMap<String, String>,
    /// Package id to dependency-kind (`normal`, `build`, `dev`) to package ids,
    /// merged across every target so a `cfg(...)` edge cannot hide.
    edges: BTreeMap<String, BTreeMap<String, BTreeSet<String>>>,
    /// Workspace member name to package id.
    members: BTreeMap<String, String>,
}

fn resolved_graph() -> ResolvedGraph {
    let cargo = env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    let output = Command::new(cargo)
        .args(["metadata", "--locked", "--offline", "--format-version", "1"])
        .current_dir(rust_root())
        .output()
        .expect("run cargo metadata");
    assert!(
        output.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: Value = serde_json::from_slice(&output.stdout).expect("cargo metadata json");

    let mut names = BTreeMap::new();
    for package in metadata["packages"].as_array().expect("packages") {
        names.insert(
            package["id"].as_str().expect("package id").to_owned(),
            package["name"].as_str().expect("package name").to_owned(),
        );
    }

    let mut members = BTreeMap::new();
    for id in metadata["workspace_members"]
        .as_array()
        .expect("workspace members")
    {
        let id = id.as_str().expect("member id").to_owned();
        members.insert(names[&id].clone(), id);
    }

    let mut edges: BTreeMap<String, BTreeMap<String, BTreeSet<String>>> = BTreeMap::new();
    for node in metadata["resolve"]["nodes"]
        .as_array()
        .expect("resolve nodes")
    {
        let id = node["id"].as_str().expect("node id").to_owned();
        let per_kind = edges.entry(id).or_default();
        for dependency in node["deps"].as_array().expect("node deps") {
            let target = dependency["pkg"].as_str().expect("dep pkg").to_owned();
            for dependency_kind in dependency["dep_kinds"].as_array().expect("dep kinds") {
                // A normal dependency carries no `kind` at all.
                let kind = dependency_kind["kind"].as_str().unwrap_or("normal");
                per_kind
                    .entry(kind.to_owned())
                    .or_default()
                    .insert(target.clone());
            }
        }
    }

    ResolvedGraph {
        names,
        edges,
        members,
    }
}

impl ResolvedGraph {
    fn member(&self, package: &str) -> &str {
        self.members
            .get(package)
            .unwrap_or_else(|| panic!("{package} is not a workspace member"))
    }

    fn kind(&self, id: &str, kind: &str) -> BTreeSet<String> {
        self.edges
            .get(id)
            .and_then(|per_kind| per_kind.get(kind))
            .cloned()
            .unwrap_or_default()
    }

    /// Everything cargo can compile into `package`: its own normal and build
    /// edges, then the normal and build edges of everything those reach. A dev
    /// edge is never transitive, so it is only ever a hop away from its own
    /// package and never enters this closure.
    fn production_closure(&self, package: &str) -> BTreeSet<String> {
        let root = self.member(package);
        let mut seen = BTreeSet::new();
        let mut queue: VecDeque<String> = self
            .kind(root, "normal")
            .into_iter()
            .chain(self.kind(root, "build"))
            .collect();
        while let Some(id) = queue.pop_front() {
            if !seen.insert(id.clone()) {
                continue;
            }
            queue.extend(self.kind(&id, "normal"));
            queue.extend(self.kind(&id, "build"));
        }
        seen.iter().map(|id| self.names[id].clone()).collect()
    }

    /// Test-only edges of a workspace member, by package name.
    fn dev_dependencies(&self, package: &str) -> BTreeSet<String> {
        self.kind(self.member(package), "dev")
            .iter()
            .map(|id| self.names[id].clone())
            .collect()
    }
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
    let graph = resolved_graph();
    let closure = graph.production_closure("silverhand-backend-core");
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
    let graph = resolved_graph();
    assert!(
        !graph
            .production_closure("silverhand-backend-sqlite")
            .contains("silverhand-backend-server"),
        "backend-sqlite must not depend on the wire crate"
    );
    assert!(
        !graph
            .production_closure("silverhand-backend-server")
            .contains("silverhand-backend-sqlite"),
        "backend-server production code must not be able to name the SQLite adapter"
    );
    assert!(
        graph
            .dev_dependencies("silverhand-backend-server")
            .contains("silverhand-backend-sqlite"),
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
