//! Scaffold gates for the #2195 host-agent lane and the #2201 host-control seam.
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

/// Driver, wire and runtime families. `backend-core`'s linked library stays free
/// of all of them through its whole transitive normal closure.
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

/// Async runtimes, servers and DB drivers. A build script is allowed to read a
/// pinned authority and generate tables, so a wire format alone says nothing
/// about it; reaching one of these families says it does something other than
/// generation. Build closures are held to this list instead of the linked one.
const RUNTIME_AND_DRIVER: &[&str] = &[
    "axum",
    "hyper",
    "libsqlite3-sys",
    "sqlx",
    "sqlx-core",
    "sqlx-sqlite",
    "tokio",
    "tokio-tungstenite",
    "tower",
    "tower-http",
    "tungstenite",
];

/// Every crate root in the workspace. The seam budget is counted in these files,
/// so all of them are checked and not only the ones that own a lane namespace.
const CRATE_ROOTS: &[&str] = &[
    "backend-app",
    "backend-core",
    "backend-filesystem",
    "backend-server",
    "backend-sqlite",
];

/// Every module this lane DECLARES at a crate root — the seam ledger. Shaping
/// owes one labeled integration-seam line per entry. G4 holds each entry to one
/// declaration in its own root and forbids any UNREGISTERED second owner.
///
/// A name the lane deliberately distributes across roles lists each owning root as
/// its own entry: a core port and its SQLite adapter (`user_presence_cold_read`), or
/// a SQLite persistence lane and the server route surface that mounts it
/// (`host_agent`). This mirrors the base crates, where `workspace_cold_read`,
/// `direct_pair_read`, `access` and `auth` each name their own module in several
/// roots; only an owner in a root NOT listed here is the accidental fork G4 refuses.
///
/// Flat modules belong here too. One table serving every gate is what let a flat
/// module sit in no inventory at all, guarded by nothing and with no signal, so
/// membership here answers only "did this lane declare it at a root".
const SEAM_ROOT_MODULES: &[(&str, &str)] = &[
    ("backend-core", "agent_availability_read"),
    ("backend-core", "agent_detail_read"),
    ("backend-core", "agent_lifecycle"),
    ("backend-core", "agent_list_read"),
    ("backend-core", "agent_presence_read"),
    ("backend-core", "capability"),
    ("backend-core", "cold_read"),
    ("backend-core", "host_resources_read"),
    ("backend-core", "policy"),
    ("backend-core", "teardown"),
    ("backend-core", "user_presence_cold_read"),
    ("backend-core", "user_presence_last_seen"),
    ("backend-server", "host_agent"),
    ("backend-server", "host_agent_background"),
    ("backend-server", "host_control"),
    ("backend-server", "host_resources"),
    ("backend-sqlite", "agent_availability_read"),
    ("backend-sqlite", "agent_detail_read"),
    ("backend-sqlite", "agent_list_read"),
    ("backend-sqlite", "agent_presence_read"),
    ("backend-sqlite", "agent_view_acl"),
    ("backend-sqlite", "host_agent"),
    ("backend-sqlite", "host_resources_read"),
    ("backend-sqlite", "user_presence_cold_read"),
    ("backend-sqlite", "user_presence_last_seen"),
];

/// The declarations this lane did NOT add, across EVERY root in `CRATE_ROOTS`.
///
/// It exists so the seam ledger can be CLOSED over the tree rather than trusted:
/// recognising a declaration no inventory knows about requires knowing what was
/// already there. Without it, forgetting an entry above is silent — twice now the
/// same defect.
///
/// It spans the roots that own no seam as well, because a closure whose SCAN RANGE
/// is derived from the seam table can only find omissions in roots that table
/// already names. A module added to a root with no seam entry would be read by no
/// gate at all, and every table-driven gate would pass — the next lane module lands
/// in `backend-sqlite`, a root in exactly that state.
///
/// Membership answers "was it already there", which no parser can decide. The tree
/// gate holds every declaration to EXACTLY ONE classification; the classification
/// itself was reconciled once against the root declarations at base `08d5e4de` — 1
/// in backend-app, 15 in backend-core, 15 in backend-server, 11 in backend-sqlite,
/// with no seam entry among them. #task:2209 then removed the foundation proof
/// vertical (`backend-core::foundation_message`, `backend-server::{http,wire}`),
/// leaving 1 in backend-app, 14 in backend-core, 13 in backend-server, 11 in
/// backend-sqlite.
///
/// CP1-temporary, with G3's accounting: it guards "every lane module is registered
/// where it is guarded", it is deleted when the seam is extracted into the
/// integration commit that owns those lines, and its owner is the review gate. A
/// merge that brings new modules into these roots must extend one list or the
/// other, and having to choose is the point.
const ROOT_MODULES_WE_DID_NOT_ADD: &[(&str, &str)] = &[
    ("backend-app", "current_schema"),
    ("backend-core", "access"),
    ("backend-core", "auth"),
    ("backend-core", "blob_store"),
    ("backend-core", "direct_pair_read"),
    ("backend-core", "host_runtime"),
    ("backend-core", "identity"),
    ("backend-core", "messaging"),
    ("backend-core", "persistence"),
    ("backend-core", "runtime_credential"),
    ("backend-core", "runtime_delivery"),
    ("backend-core", "runtime_event"),
    ("backend-core", "scope_event"),
    ("backend-core", "viewer_workspace_sort"),
    ("backend-core", "workspace_cold_read"),
    ("backend-core", "workspace_face"),
    ("backend-filesystem", "blob_store"),
    ("backend-server", "access"),
    ("backend-server", "auth"),
    ("backend-server", "bearer"),
    ("backend-server", "current_schema"),
    ("backend-server", "daemon_delivery"),
    ("backend-server", "daemon_events"),
    ("backend-server", "direct_pairs"),
    ("backend-server", "error"),
    ("backend-server", "host_runtime"),
    ("backend-server", "messaging"),
    ("backend-server", "runtime_credential"),
    ("backend-server", "scope_events"),
    ("backend-server", "workspaces"),
    ("backend-sqlite", "access"),
    ("backend-sqlite", "auth"),
    ("backend-sqlite", "current_schema"),
    ("backend-sqlite", "direct_pair_read"),
    ("backend-sqlite", "host_runtime"),
    ("backend-sqlite", "messaging"),
    ("backend-sqlite", "runtime_credential"),
    ("backend-sqlite", "runtime_delivery"),
    ("backend-sqlite", "scope_event"),
    ("backend-sqlite", "unread_read"),
    ("backend-sqlite", "workspace_cold_read"),
];

/// TRANSITIONAL — the root modules the vocabulary-ownership lanes declare.
///
/// It exists for one reason: G0 below closes every root declaration over an
/// inventory, so a new root module has to be classified somewhere or the gate goes
/// red with no way to record that the module is legitimate. This is that record and
/// nothing more.
///
/// It carries NO seam and NO activation semantics. An entry here owes no labeled
/// integration-seam line, is not fenced against composition, and is not held to
/// G4's single-owner accounting; those obligations belong to `SEAM_ROOT_MODULES`
/// and are not claimed for these modules.
///
/// This whole file is CP1 history that #task:2209 deletes, so this table has no
/// future: do not extend it into a durable inventory, do not build a union
/// abstraction over the three lists, and do not carry it through convergence.
const ORGANIZATION_ROOT_MODULES: &[(&str, &str)] = &[("backend-core", "agents")];

/// The seam modules that are DIRECTORY modules, owning a `<name>/mod.rs`. G5 reads
/// that file, so a flat module must not appear here — the gate would then fail on a
/// missing path instead of on a violation. G0 holds this list to exactly the
/// directory-shaped entries above, so neither shape can drift out of its gate.
const DIRECTORY_NAMESPACES: &[(&str, &str)] = &[
    ("backend-core", "capability"),
    ("backend-core", "cold_read"),
    ("backend-core", "policy"),
    ("backend-core", "teardown"),
    ("backend-server", "host_agent"),
    ("backend-server", "host_agent_background"),
    ("backend-server", "host_control"),
    ("backend-sqlite", "host_agent"),
];

/// The modules a composition must name to ACTIVATE this lane: rules that decide, a
/// read that answers a route, the HTTP surface that mounts that read, the write that
/// commits, the timers that fire.
///
/// Membership is that question and not "is it ours". `agent_lifecycle` is a
/// materialization vocabulary the base crates already share; converting a stored
/// token into that enum starts no rule, opens no port and fires no timer, so it is
/// deliberately absent, while every deciding, reading, mounting, writing and timing
/// module is present. The /api/presence vertical adds two: the read port
/// `user_presence_cold_read`, and the route surface `host_agent` whose appearance in
/// the composition root is the mount this fence refuses in CP1. The
/// /api/agents/:id/availability vertical adds one: the read port
/// `agent_availability_read`; its route surface is a submodule of `host_agent`,
/// already listed. The /api/agents/:id agent-detail vertical adds one the same
/// way: the read port `agent_detail_read`, whose route surface is likewise a
/// submodule of `host_agent`. The /api/agents/:id/presence vertical adds one the
/// same way again: the read port `agent_presence_read`, whose route surface is a
/// submodule of `host_agent`. The /api/hosts/:id/resources vertical (#task:2198)
/// adds two, because its route surface is a crate-root SIBLING rather than a
/// `host_agent` leaf: the read port `host_resources_read` and the surface
/// `host_resources`. The `/api/agents` list vertical adds one on the same
/// grounds once more: the read port `agent_list_read`; its route surface and the DTO
/// projector it shares with detail are both submodules of `host_agent`. G0 keeps it
/// a subset of the seam ledger.
const ACTIVATION_NAMESPACES: &[(&str, &str)] = &[
    ("backend-core", "agent_availability_read"),
    ("backend-core", "agent_detail_read"),
    ("backend-core", "agent_list_read"),
    ("backend-core", "agent_presence_read"),
    ("backend-core", "capability"),
    ("backend-core", "cold_read"),
    ("backend-core", "host_resources_read"),
    ("backend-core", "policy"),
    ("backend-core", "teardown"),
    ("backend-core", "user_presence_cold_read"),
    ("backend-server", "host_agent"),
    ("backend-server", "host_agent_background"),
    ("backend-server", "host_control"),
    ("backend-server", "host_resources"),
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

    /// Everything cargo links into `package`'s own library: its normal edges,
    /// then the normal edges of everything those reach. A dev edge is never
    /// transitive, and a dependency's build script feeds a separate binary that
    /// is never linked into its consumer, so neither kind enters this closure.
    fn linked_closure(&self, package: &str) -> BTreeSet<String> {
        self.closure(self.kind(self.member(package), "normal"), &["normal"])
    }

    /// Everything cargo compiles to produce `package`'s build script: its build
    /// edges, then the normal and build edges of everything those reach. None of
    /// it is linked into the library, so this answers a different question than
    /// [`Self::linked_closure`] and is held to a different family list.
    fn build_closure(&self, package: &str) -> BTreeSet<String> {
        self.closure(
            self.kind(self.member(package), "build"),
            &["normal", "build"],
        )
    }

    fn closure(&self, roots: BTreeSet<String>, follow: &[&str]) -> BTreeSet<String> {
        let mut seen = BTreeSet::new();
        let mut queue: VecDeque<String> = roots.into_iter().collect();
        while let Some(id) = queue.pop_front() {
            if !seen.insert(id.clone()) {
                continue;
            }
            for kind in follow {
                queue.extend(self.kind(&id, kind));
            }
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

/// Whether the source names `identifier` as a WHOLE identifier.
///
/// A bare substring cannot be used for a namespace name that is a suffix of an
/// unrelated one — `workspace_cold_read` is a different module, not a second
/// declaration of `cold_read` — and matching a `::`-delimited path segment cannot
/// either, because a declaration or re-export of a namespace need not carry a `::`.
fn names_identifier(source: &str, identifier: &str) -> bool {
    let is_ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    source.match_indices(identifier).any(|(start, matched)| {
        let before_is_ident = start > 0 && is_ident(source.as_bytes()[start - 1]);
        let after = start + matched.len();
        let after_is_ident = after < source.len() && is_ident(source.as_bytes()[after]);
        !before_is_ident && !after_is_ident
    })
}

/// Whether every character is legal in an identifier, and there is at least one.
fn is_identifier(candidate: &str) -> bool {
    !candidate.is_empty()
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Drops leading attributes, so `#[cfg(test)] mod x;` parses as the declaration it
/// is, and a crate root's own `#![forbid(..)]` does not hide the first one.
///
/// Terminates each attribute at the first `]`, which is sufficient for attributes
/// carrying paths, strings and nested parens; an attribute containing a `]` inside a
/// string would end the scan early and can only make this predicate MISS, never
/// invent, a declaration.
fn strip_attributes(item: &str) -> &str {
    let mut rest = item.trim_start();
    loop {
        let opened = rest.strip_prefix("#![").or_else(|| rest.strip_prefix("#["));
        let Some(attribute) = opened else {
            return rest;
        };
        let Some(end) = attribute.find(']') else {
            return rest;
        };
        rest = attribute[end + 1..].trim_start();
    }
}

/// Splits a leading visibility off an item, reporting whether the item is EXPORTED
/// beyond its own file.
///
/// `pub`, `pub(crate)`, `pub(super)` and `pub(in path)` are four spellings of one
/// property, and matching text per spelling is how `pub(crate) use` slipped past a
/// gate whose prose claimed to catch re-exports.
fn split_visibility(item: &str) -> (bool, &str) {
    let Some(rest) = item.strip_prefix("pub") else {
        return (false, item);
    };
    if let Some(restriction) = rest.strip_prefix('(') {
        return match restriction.find(')') {
            Some(end) => (true, restriction[end + 1..].trim_start()),
            None => (false, item),
        };
    }
    // `pub` must be a whole token: `published` is not a visibility.
    if rest.starts_with(char::is_whitespace) {
        return (true, rest.trim_start());
    }
    (false, item)
}

/// Whether `text` ends with `keyword` as a whole token rather than as the tail of a
/// longer identifier.
fn ends_with_token(text: &str, keyword: &str) -> bool {
    match text.strip_suffix(keyword) {
        Some(before) => !before
            .ends_with(|character: char| character.is_ascii_alphanumeric() || character == '_'),
        None => false,
    }
}

/// The LAST whole-token occurrence of `keyword`, split into what precedes it and
/// what follows.
fn split_last_token<'a>(chunk: &'a str, keyword: &str) -> Option<(&'a str, &'a str)> {
    let mut searched = chunk.len();
    while let Some(found) = chunk[..searched].rfind(keyword) {
        let before = &chunk[..found];
        if !before
            .ends_with(|character: char| character.is_ascii_alphanumeric() || character == '_')
        {
            return Some((before, &chunk[found + keyword.len()..]));
        }
        searched = found;
    }
    None
}

/// Whether an item's leading text ends in a visibility, which is how an exported
/// `use` is told from a private one when the item is read from its end.
fn ends_with_visibility(before: &str) -> bool {
    let trimmed = before.trim_end();
    let head = match trimmed.strip_suffix(')') {
        Some(restricted) => match restricted.rfind('(') {
            Some(open) => restricted[..open].trim_end(),
            None => return false,
        },
        None => trimmed,
    };
    ends_with_token(head, "pub")
}

/// The `mod NAME` a chunk ENDS with, at any visibility and behind any attributes.
///
/// Read from the END because a `;`-delimited chunk also carries the tail of whatever
/// preceded it: a crate root that holds code as well as declarations — the
/// composition root does — puts closing braces and expressions in front of its `mod`
/// lines, and a start-anchored match finds none of them. Inline modules stay excluded
/// for free: `mod tests {` leaves a brace where the name would be.
fn trailing_declaration(chunk: &str) -> Option<&str> {
    let (_, name) = split_last_token(chunk.trim_end(), "mod ")?;
    let name = name.trim();
    is_identifier(name).then_some(name)
}

/// The use tree of an EXPORTED `use` a chunk ends with. A private `use` names the
/// path for one file and adds no path anyone else can reach.
fn trailing_export(chunk: &str) -> Option<&str> {
    let (before, tree) = split_last_token(chunk, "use ")?;
    ends_with_visibility(before).then_some(tree)
}

/// Whether this source takes OWNERSHIP of `namespace` — declares it, or re-exports
/// it under a second path.
///
/// Deliberately not "mentions it": a crate root legitimately consumes another
/// crate's namespace, and prose and a struct field can carry the same word. Only a
/// declaration or an exported `use` creates a second owner.
///
/// Item-based rather than line-based, because a visibility qualifier, a leading
/// attribute and a braced group spanning several lines are all legal ways to own a
/// name, and a line-anchored equality test recognises none of them.
fn declares_or_reexports(source: &str, namespace: &str) -> bool {
    strip_comments(source).split(';').any(|chunk| {
        // Any visibility: a second `mod` of this name is a second module, and a
        // private one still owns the directory.
        trailing_declaration(chunk) == Some(namespace)
            || trailing_export(chunk).is_some_and(|tree| names_identifier(tree, namespace))
    })
}

/// Every module a crate root declares from a file, by name.
fn module_declarations(source: &str) -> BTreeSet<String> {
    strip_comments(source)
        .split(';')
        .filter_map(|chunk| trailing_declaration(chunk).map(str::to_owned))
        .collect()
}

fn root_module_declarations(crate_dir: &str) -> BTreeSet<String> {
    let root = rust_root()
        .join("crates")
        .join(crate_dir)
        .join("src/lib.rs");
    module_declarations(&read(&root))
}

/// Every module either inventory classifies for this root. A root absent from both
/// yields the empty set, which is what makes an unregistered declaration there a
/// failure rather than an unvisited file.
fn registered_modules(crate_dir: &str) -> BTreeSet<String> {
    SEAM_ROOT_MODULES
        .iter()
        .chain(ROOT_MODULES_WE_DID_NOT_ADD)
        .chain(ORGANIZATION_ROOT_MODULES)
        .filter(|(owner, _)| *owner == crate_dir)
        .map(|(_, module)| (*module).to_owned())
        .collect()
}

/// What a root declares that nothing classifies, and what an inventory claims that
/// the root no longer declares.
///
/// Pure over the two sets so the seamless-root case can be driven through this same
/// comparison, without waiting for another lane to add a module to prove it.
fn classification_gaps(
    declared: &BTreeSet<String>,
    registered: &BTreeSet<String>,
) -> (Vec<String>, Vec<String>) {
    (
        declared.difference(registered).cloned().collect(),
        registered.difference(declared).cloned().collect(),
    )
}

/// G0 — every module in every crate root sits in the inventory that guards it.
///
/// The gates below are driven by tables, and a module missing from a table is not
/// guarded by anything, with no signal at all. That failure has now happened twice,
/// so the tables are checked against the tree instead of trusted: a declaration no
/// inventory knows about fails here, and a shape mismatch (a flat module listed
/// where a `mod.rs` is read) fails here rather than as a confusing missing path.
///
/// The scan range is `CRATE_ROOTS`, never a range derived from a table being
/// verified. A closure that enumerates only the roots the seam ledger already names
/// cannot see the omission that matters — a module added to a root with no seam
/// entry, where no gate reads the file and every table-driven gate passes.
#[test]
fn g0_every_lane_module_sits_in_the_inventory_that_guards_it() {
    // Controls, both directions: a declaration is recognised at any visibility and
    // behind attributes, and nothing else is mistaken for one.
    assert!(is_identifier("cold_read") && !is_identifier("cold_read {") && !is_identifier(""));
    assert_eq!(split_visibility("pub(crate) use x"), (true, "use x"));
    assert_eq!(
        split_visibility("pub(in crate::wire) mod x"),
        (true, "mod x")
    );
    assert_eq!(split_visibility("pub mod x"), (true, "mod x"));
    assert_eq!(split_visibility("mod x"), (false, "mod x"));
    assert_eq!(
        split_visibility("published_at: 1"),
        (false, "published_at: 1")
    );
    assert_eq!(
        strip_attributes("#[cfg(test)]\n#[path = \"../x.rs\"]\nmod current_schema"),
        "mod current_schema"
    );
    // A crate root opens with an inner attribute, and it sits in the same item as
    // the first declaration: missing it hides that declaration from the closure.
    assert_eq!(
        strip_attributes("#![forbid(unsafe_code)]\n\npub mod access"),
        "pub mod access"
    );
    // A root that also carries CODE puts the tail of a function in front of its
    // declarations, which is how the composition root declares its only module.
    assert_eq!(
        trailing_declaration(
            "\n    rendered\n}\n\n#[cfg(test)]\n#[path = \"../x.rs\"]\nmod current_schema"
        ),
        Some("current_schema")
    );
    assert_eq!(
        trailing_declaration("pub(crate) mod policy"),
        Some("policy")
    );
    assert_eq!(trailing_declaration("mod tests {\n    use super::*"), None);
    assert_eq!(trailing_declaration("let rendered = demod x"), None);
    assert_eq!(trailing_declaration("fn cold_read() {}"), None);
    assert_eq!(
        trailing_export("}\n\npub(crate) use crate::cold_read"),
        Some("crate::cold_read")
    );
    assert_eq!(trailing_export("}\n\nuse crate::cold_read"), None);

    // Each classification is a claim about one module, and a set union of the
    // tables would silently absorb a repeated or doubled one.
    let inventories: [(&str, &[(&str, &str)]); 3] = [
        ("the seam ledger", SEAM_ROOT_MODULES),
        ("the inherited list", ROOT_MODULES_WE_DID_NOT_ADD),
        (
            "the transitional organization list",
            ORGANIZATION_ROOT_MODULES,
        ),
    ];
    let classified: Vec<(&str, BTreeSet<(&str, &str)>)> = inventories
        .iter()
        .map(|(label, table)| {
            let entries: BTreeSet<(&str, &str)> = table.iter().copied().collect();
            assert_eq!(entries.len(), table.len(), "{label} repeats an entry");
            (*label, entries)
        })
        .collect();
    for (position, (label, entries)) in classified.iter().enumerate() {
        for (other_label, other) in &classified[position + 1..] {
            let both: Vec<&(&str, &str)> = entries.intersection(other).collect();
            assert!(
                both.is_empty(),
                "{both:?} is claimed by {label} and by {other_label}"
            );
        }
    }

    for crate_dir in CRATE_ROOTS {
        let (unclassified, absent) = classification_gaps(
            &root_module_declarations(crate_dir),
            &registered_modules(crate_dir),
        );
        assert!(
            unclassified.is_empty(),
            "{crate_dir}/src/lib.rs declares {unclassified:?}, which no inventory \
             classifies: an unregistered module is guarded by nothing"
        );
        assert!(
            absent.is_empty(),
            "an inventory claims {absent:?} in {crate_dir}/src/lib.rs, which no longer \
             declares them"
        );
    }

    // The case the previous range could not reach: a root owning no seam entry.
    // Driven through the same parser and the same comparison as the roots above,
    // from a fixture, so it holds without another lane adding a module to prove it.
    let seamless_root = "#![forbid(unsafe_code)]\n\npub mod access;\npub mod host_agent;\n";
    assert_eq!(
        classification_gaps(
            &module_declarations(seamless_root),
            &["access".to_owned()].into_iter().collect(),
        )
        .0,
        vec!["host_agent".to_owned()],
        "a declaration in a root with no seam entry must still be reported"
    );

    // The fifth workspace crate `backend-filesystem` is now in `CRATE_ROOTS`, so the
    // loop above scans its one declaration. Prove that classification is load-bearing
    // rather than trusting a reader: driven against the REAL filesystem root with its
    // entry removed, `blob_store` is reported — so deleting the classification turns
    // G0 red. Without filesystem in the scan range, that entry would be dead and its
    // deletion silent, which is the second-layer false-green this closes.
    assert_eq!(
        classification_gaps(
            &root_module_declarations("backend-filesystem"),
            &BTreeSet::new(),
        )
        .0,
        vec!["blob_store".to_owned()],
        "deleting backend-filesystem's root classification must turn G0 red"
    );

    let mut directory_shaped: BTreeSet<(&str, &str)> = BTreeSet::new();
    for (crate_dir, module) in SEAM_ROOT_MODULES {
        let module_dir = rust_root()
            .join("crates")
            .join(crate_dir)
            .join("src")
            .join(module);
        let is_directory = module_dir.join("mod.rs").is_file();
        assert!(
            is_directory != module_dir.with_extension("rs").is_file(),
            "{}: a module is either a directory with mod.rs or a flat file",
            module_dir.display()
        );
        if is_directory {
            directory_shaped.insert((crate_dir, module));
        }
    }
    // Exact, both ways: a flat module listed here would send G5 at a missing path,
    // and an entry outside the ledger would fence a namespace this lane never added.
    assert_eq!(
        DIRECTORY_NAMESPACES
            .iter()
            .copied()
            .collect::<BTreeSet<_>>(),
        directory_shaped,
        "the directory inventory and the tree disagree about which seam modules own a mod.rs"
    );

    for entry in ACTIVATION_NAMESPACES {
        assert!(
            SEAM_ROOT_MODULES.contains(entry),
            "{entry:?} is fenced against activation but is not in the seam ledger"
        );
    }
}

#[test]
fn g1_core_carries_no_driver_wire_or_runtime_dependency() {
    let graph = resolved_graph();

    let linked = graph.linked_closure("silverhand-backend-core");
    let in_library: Vec<&str> = DRIVER_WIRE_RUNTIME
        .iter()
        .copied()
        .filter(|package| linked.contains(*package))
        .collect();
    assert!(
        in_library.is_empty(),
        "backend-core linked closure reached {in_library:?}"
    );
    assert!(linked.contains("base64") && linked.contains("sha2"));

    let build = graph.build_closure("silverhand-backend-core");
    let in_build: Vec<&str> = RUNTIME_AND_DRIVER
        .iter()
        .copied()
        .filter(|package| build.contains(*package))
        .collect();
    assert!(
        in_build.is_empty(),
        "backend-core build closure reached {in_build:?}"
    );
}

#[test]
fn g1_the_persistence_and_wire_crates_keep_their_direction() {
    let graph = resolved_graph();
    assert!(
        !graph
            .linked_closure("silverhand-backend-sqlite")
            .contains("silverhand-backend-server"),
        "backend-sqlite must not depend on the wire crate"
    );
    assert!(
        !graph
            .linked_closure("silverhand-backend-server")
            .contains("silverhand-backend-sqlite"),
        "backend-server production code must not be able to name the SQLite adapter"
    );
    assert!(
        graph
            .dev_dependencies("silverhand-backend-server")
            .contains("silverhand-backend-sqlite"),
        "the SQLite adapter is a backend-server test-only dependency"
    );

    // The filesystem adapter is a leaf: its linked closure reaches only backend-core
    // (+ tokio), so it can name neither the wire crate nor the SQLite adapter. This
    // pins the new adapter's acyclicity.
    //
    // Honest scope: the reverse edge — backend-server naming backend-filesystem — DOES
    // exist as #task:2200's approved typed local-alias capability, and is deliberately
    // NOT fenced here. So this gate pins adapter acyclicity, not the full
    // "persistence/wire direction" its title claims; that one approved server→filesystem
    // edge is a bounded exception, not a hole.
    let filesystem = graph.linked_closure("silverhand-backend-filesystem");
    assert!(
        !filesystem.contains("silverhand-backend-server"),
        "backend-filesystem must not depend on the wire crate"
    );
    assert!(
        !filesystem.contains("silverhand-backend-sqlite"),
        "backend-filesystem must not depend on the SQLite adapter"
    );
}

#[test]
fn g2_background_policy_names_no_timer_or_driver() {
    // Residual guard only: aliases, macros and re-exports can bypass a source
    // scan. The compile-enforced carrier is G1 plus core's manifest.
    //
    // A crate or module path is a reach wherever it appears, so it is matched as
    // a substring. A bare type or function name only catches an aliased reach,
    // and a domain type may legitimately end in one — `ActivityInstant` is a
    // validated stamp, not a clock — so those are matched as whole identifiers.
    const FORBIDDEN_PATHS: &[&str] = &["tokio", "std::time", "axum", "sqlx"];
    const FORBIDDEN_NAMES: &[&str] = &["Instant", "SystemTime", "sleep", "spawn"];
    for path in lane_source_paths("backend-core", "policy") {
        let source = strip_comments(&read(&path));
        for forbidden in FORBIDDEN_PATHS {
            assert!(
                !source.contains(forbidden),
                "{} names {forbidden}: policy decisions stay timer-free",
                path.display()
            );
        }
        for forbidden in FORBIDDEN_NAMES {
            assert!(
                !names_identifier(&source, forbidden),
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
fn g4_the_seam_touches_only_crate_roots_and_only_as_declarations() {
    // A near-miss name is not a second declaration, and a field is not a re-export.
    assert!(!declares_or_reexports(
        "pub mod workspace_cold_read;",
        "cold_read"
    ));
    assert!(!declares_or_reexports(
        "    capability: messaging_store.clone(),",
        "capability"
    ));
    // A private import names the namespace for one file and creates no second path.
    assert!(!declares_or_reexports(
        "use silverhand_backend_core::cold_read::availability::read_agent_availability;",
        "cold_read"
    ));
    // Stripping a visibility must not turn every item into a declaration.
    assert!(!declares_or_reexports(
        "pub(crate) fn cold_read() {}",
        "cold_read"
    ));

    // Every spelling that DOES create a second owner, including the ones a
    // line-anchored `pub use ` test used to miss.
    assert!(declares_or_reexports("pub mod cold_read;", "cold_read"));
    assert!(declares_or_reexports("mod cold_read;", "cold_read"));
    assert!(declares_or_reexports(
        "pub use silverhand_backend_core::cold_read;",
        "cold_read"
    ));
    // The standing counterexample for the module that was in no inventory at all:
    // both bypass spellings, in the two roots that could host them.
    assert!(declares_or_reexports(
        "pub(crate) use silverhand_backend_core::agent_lifecycle;",
        "agent_lifecycle"
    ));
    assert!(declares_or_reexports(
        "pub(in crate::wire) use silverhand_backend_core::agent_lifecycle;",
        "agent_lifecycle"
    ));
    assert!(declares_or_reexports(
        "pub(crate) mod agent_lifecycle;",
        "agent_lifecycle"
    ));
    assert!(declares_or_reexports(
        "pub use silverhand_backend_core::{\n    agent_lifecycle,\n    identity,\n};",
        "agent_lifecycle"
    ));

    for (crate_dir, namespace) in SEAM_ROOT_MODULES {
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
        for other_dir in CRATE_ROOTS {
            if other_dir == crate_dir {
                continue;
            }
            // A co-owner the lane registered is not a fork: a name distributed across
            // roles (a core port and its SQLite adapter, a SQLite lane and its route
            // surface) lists each owning root as its own seam entry. Only an owner in a
            // root NOT in the ledger is the accidental second declaration this refuses.
            if SEAM_ROOT_MODULES.contains(&(*other_dir, *namespace)) {
                continue;
            }
            let other = rust_root()
                .join("crates")
                .join(other_dir)
                .join("src/lib.rs");
            assert!(
                !declares_or_reexports(&read(&other), namespace),
                "{} declares or re-exports {namespace} without a seam entry: an unregistered second owner",
                other.display()
            );
        }
    }
}

#[test]
fn g5_namespaces_declare_and_never_carry_business() {
    for (crate_dir, namespace) in DIRECTORY_NAMESPACES {
        let path = rust_root()
            .join("crates")
            .join(crate_dir)
            .join("src")
            .join(namespace)
            .join("mod.rs");
        // Item-based for the same reason as G4: a braced re-export group and a
        // visibility qualifier are legal, and a function body is not.
        for item in strip_comments(&read(&path)).split(';') {
            let item = item.trim();
            if item.is_empty() {
                continue;
            }
            let (_, rest) = split_visibility(strip_attributes(item));
            assert!(
                rest.starts_with("mod ") || rest.starts_with("use "),
                "{} carries `{item}`: a namespace declares and re-exports only",
                path.display()
            );
        }
    }
}

/// G6 — the capability namespace decides, and never acquires.
///
/// A pure decision over already-read facts is what lets one rule serve a face
/// that reads before an independent write and a face that must read under the
/// write lock it commits in. The two properties that make it pure are carried
/// differently, and only one of them needs a fence:
///
///  - "holds no driver" is already compile-enforced — `backend-core`'s production
///    closure reaches no driver, wire or runtime crate (G1);
///  - "acquires nothing" is a SIGNATURE property: these functions take facts and
///    return a verdict, so a rule that wanted to read would have to change its
///    signature and every call site. This gate is the tripwire against the first
///    step towards that — declaring a port or going async inside the namespace.
///
/// A LEXICAL fence, with the same accounting as G3: it guards the named boundary
/// "capability acquires no facts", it is removed when a compile-level carrier
/// exists (a sealed fact-provider trait owned outside this namespace would be
/// one), and it is owned by this lane.
#[test]
fn g6_capability_decides_over_facts_and_declares_no_port() {
    let paths = lane_source_paths("backend-core", "capability");
    assert!(
        paths.len() >= 4,
        "expected the capability namespace to carry its leaves, found {paths:?}"
    );
    for path in paths {
        let source = strip_comments(&read(&path));
        for forbidden in ["async fn", "impl Future", "-> impl Future", "trait "] {
            assert!(
                !source.contains(forbidden),
                "{} carries `{forbidden}`: a capability decides over facts it was handed",
                path.display()
            );
        }
    }
}
