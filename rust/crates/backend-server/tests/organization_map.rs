//! Organization map gate (#task:2265).
//!
//! The map at `docs/rust-backend-organization-map.json` is the ONE classification
//! authority for the Rust backend's module organization. This gate holds the map to
//! independent authorities so a green run means the map still describes the tree, not
//! that the tree was reshaped to match a stale map:
//!
//! - the crate-root universe is scanned from every crate's `lib.rs` (an authority the
//!   map does not own), and the map must classify each scanned declaration exactly once;
//! - every row is a STRICT tagged union — exactly one of `target` or `split_required` —
//!   and `split_required` is a `kind`-tagged object whose members close against an
//!   independent scan of the directory / codec `mod` declarations;
//! - `source_shape` is re-derived here, never trusted from the map;
//! - the walk asserts a nonempty lower bound, so moving a directory cannot make the gate
//!   pass vacuously.
//!
//! Owner/role semantics are the map's; this file proves the map's SHAPE and COVERAGE.

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

/// Crate scan scope is derived INDEPENDENTLY from the workspace manifest and the
/// filesystem, never hardcoded — a new backend crate cannot escape the scan by being
/// omitted from a gate list.
///
/// The `members` array is read from the `[workspace]` table via a real TOML parse, and the
/// result is cross-checked against the real crate directories on disk (each `crates/<name>`
/// with a `Cargo.toml`). A drift between the two — a member with no crate, or a crate not in
/// members — fails the gate, so the scope is a structural authority, not a text shape.
fn workspace_crates() -> Vec<String> {
    let manifest = read(&rust_root().join("Cargo.toml"));
    let members = workspace_members(&manifest);
    let mut from_manifest: Vec<String> = members
        .iter()
        .filter_map(|m| m.strip_prefix("crates/").map(|c| c.to_owned()))
        .collect();
    from_manifest.sort();
    from_manifest.dedup();

    // Filesystem authority: every crates/<name> directory that carries a Cargo.toml.
    let mut from_disk: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(rust_root().join("crates")) {
        for e in entries.flatten() {
            if e.path().join("Cargo.toml").exists()
                && let Some(name) = e.file_name().to_str()
            {
                from_disk.push(name.to_owned());
            }
        }
    }
    from_disk.sort();
    from_disk.dedup();

    assert_eq!(
        from_manifest,
        from_disk,
        "workspace members drift from on-disk crates: manifest-only={:?} disk-only={:?}",
        from_manifest
            .iter()
            .filter(|c| !from_disk.contains(c))
            .collect::<Vec<_>>(),
        from_disk
            .iter()
            .filter(|c| !from_manifest.contains(c))
            .collect::<Vec<_>>(),
    );
    assert!(
        from_manifest.len() >= 5,
        "workspace scan found only {} crates",
        from_manifest.len()
    );
    from_manifest
}

/// Parse `[workspace].members` from the manifest with a real TOML parser (no hand-written
/// line/bracket/comment dialect), so `members_backup`, a `#` inside a string, a glob, or any
/// formatting variation cannot mislead the scan.
fn workspace_members(manifest: &str) -> Vec<String> {
    let doc: toml::Value = manifest.parse().expect("Cargo.toml is valid TOML");
    let members = doc
        .get("workspace")
        .and_then(|w| w.get("members"))
        .and_then(|m| m.as_array())
        .expect("[workspace].members array");
    members
        .iter()
        .map(|v| v.as_str().expect("workspace member string").to_owned())
        .collect()
}

/// The axis vocabularies and charters, loaded from the MAP — the single authority. The
/// gate copies no second allowlist; it only checks the map's axes are non-empty, unique,
/// every used owner has a charter, and every row value is a member of the map's own axes.
struct Axes {
    business_owner: BTreeSet<String>,
    structural_role: BTreeSet<String>,
    charters: BTreeSet<String>,
}

/// Read a string array from the map, asserting it has NO duplicate entries by comparing
/// the raw array length with the deduplicated set — a repeated axis value is a defect.
fn unique_string_array(map: &Value, key: &str) -> BTreeSet<String> {
    let arr = map["axes"][key]
        .as_array()
        .unwrap_or_else(|| panic!("axes.{key} must be an array"));
    let raw: Vec<String> = arr
        .iter()
        .map(|v| v.as_str().expect("axis value string").to_owned())
        .collect();
    let set: BTreeSet<String> = raw.iter().cloned().collect();
    assert_eq!(
        set.len(),
        raw.len(),
        "axes.{key} has duplicate value(s): {:?}",
        {
            let mut seen = BTreeSet::new();
            raw.iter()
                .filter(|v| !seen.insert((*v).clone()))
                .cloned()
                .collect::<Vec<_>>()
        }
    );
    set
}

fn load_axes(map: &Value) -> Axes {
    let business_owner = unique_string_array(map, "business_owner");
    let structural_role = unique_string_array(map, "structural_role");
    let charters: BTreeSet<String> = map["charters"]
        .as_object()
        .expect("charters object")
        .keys()
        .cloned()
        .collect();
    assert!(
        !business_owner.is_empty(),
        "map business_owner axis is empty"
    );
    assert!(
        !structural_role.is_empty(),
        "map structural_role axis is empty"
    );
    Axes {
        business_owner,
        structural_role,
        charters,
    }
}

fn rust_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("rust workspace root")
}

fn repo_root() -> PathBuf {
    rust_root()
        .join("..")
        .canonicalize()
        .expect("repo root above rust/")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// Top-level `mod NAME;` declarations of a source file, read through a real parser so a
/// `#[cfg(test)]`-gated declaration still counts (it is still a declared module) and a
/// commented-out or string-embedded `mod` never does.
fn module_declarations(source: &str) -> Vec<(String, bool)> {
    let parsed = syn::parse_file(source).expect("a parseable Rust source file");
    let mut mods = Vec::new();
    for item in &parsed.items {
        if let syn::Item::Mod(item) = item {
            // An inline `mod foo { .. }` is not a crate-root file/dir declaration; only a
            // `mod foo;` (no content) names an external module the map must classify.
            if item.content.is_none() {
                let cfg_test = item.attrs.iter().any(is_cfg_test);
                mods.push((item.ident.to_string(), cfg_test));
            }
        }
    }
    mods
}

fn is_cfg_test(attr: &syn::Attribute) -> bool {
    if !attr.path().is_ident("cfg") {
        return false;
    }
    let mut found = false;
    let _ = attr.parse_nested_meta(|meta| {
        if meta.path.is_ident("test") {
            found = true;
        }
        Ok(())
    });
    found
}

/// Independent source_shape: `hybrid` iff a `<m>.rs` main body AND a `<m>/` directory that
/// carries PRODUCTION child `mod` declarations both exist; `directory` for a namespace
/// directory; else `file`. A sibling directory holding only test fixtures (no production
/// child `mod`) is NOT a hybrid — the `<m>.rs` is the real module.
fn derive_source_shape(crate_src: &Path, module: &str) -> String {
    let dir = crate_src.join(module);
    let file = crate_src.join(format!("{module}.rs"));
    let has_dir = dir.is_dir();
    let has_file = file.exists();
    if has_dir && has_file {
        if child_mod_decls(crate_src, module).is_empty() {
            "file".to_owned()
        } else {
            "hybrid".to_owned()
        }
    } else if has_dir {
        "directory".to_owned()
    } else {
        "file".to_owned()
    }
}

/// The child `mod NAME;` declarations of a directory/hybrid root, read from whichever of
/// `<m>/mod.rs` or `<m>.rs` declares them. This is the independent authority the split
/// `members` must close against.
fn child_mod_decls(crate_src: &Path, module: &str) -> Vec<String> {
    for candidate in [
        crate_src.join(module).join("mod.rs"),
        crate_src.join(format!("{module}.rs")),
    ] {
        if candidate.exists() {
            return module_declarations(&read(&candidate))
                .into_iter()
                .map(|(name, _)| name)
                .collect();
        }
    }
    Vec::new()
}

fn as_str<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("expected string field `{key}` in {row}"))
}

fn assert_axis(axes: &Axes, bo: &str, role: &str, context: &str) {
    assert!(
        axes.business_owner.contains(bo),
        "{context}: business_owner `{bo}` is not a value in the map's business_owner axis"
    );
    assert!(
        axes.structural_role.contains(role),
        "{context}: structural_role `{role}` is not a value in the map's structural_role axis"
    );
    assert!(
        axes.charters.contains(bo),
        "{context}: business_owner `{bo}` has no charter in the map"
    );
}

fn load_map() -> Value {
    let path = repo_root().join("docs/rust-backend-organization-map.json");
    serde_json::from_str(&read(&path)).expect("organization map is valid JSON")
}

/// The independent crate-root universe: every `mod NAME;` in every workspace crate's
/// `lib.rs`, keyed `(crate, module)`, with whether it is `#[cfg(test)]`. Crate scope comes
/// from the workspace manifest, not a gate constant.
fn scanned_crate_roots() -> HashMap<(String, String), bool> {
    let root = rust_root();
    let mut universe = HashMap::new();
    for krate in workspace_crates() {
        let lib = root.join("crates").join(&krate).join("src/lib.rs");
        if !lib.exists() {
            continue; // a non-library crate (e.g. a binary-only member) has no lib.rs
        }
        for (module, cfg_test) in module_declarations(&read(&lib)) {
            let prior = universe.insert((krate.clone(), module.clone()), cfg_test);
            assert!(
                prior.is_none(),
                "{krate}/src/lib.rs declares `{module}` more than once"
            );
        }
    }
    assert!(
        universe.len() > 130,
        "crate-root scan found only {} declarations — the walk is not reading the tree",
        universe.len()
    );
    universe
}

#[test]
fn map_axes_are_self_consistent_and_charter_covered() {
    // The map is the single authority: the gate does not hold a second allowlist. It only
    // proves the map's axes are non-empty + unique, every axis value that is a
    // business_owner has a charter, and (below, per row) every row value is a member of
    // these same axes.
    let map = load_map();
    let axes = load_axes(&map);
    // uniqueness is guaranteed by the BTreeSet load; assert non-empty + charter coverage.
    assert!(!axes.business_owner.is_empty() && !axes.structural_role.is_empty());
    for owner in &axes.business_owner {
        assert!(
            axes.charters.contains(owner),
            "business_owner `{owner}` in the axis has no charter"
        );
    }
    // Every charter key must be a declared business_owner (no orphan charters).
    for owner in &axes.charters {
        assert!(
            axes.business_owner.contains(owner),
            "charter `{owner}` is not a declared business_owner axis value"
        );
    }
}

#[test]
fn crate_roots_are_covered_exactly_once() {
    let map = load_map();
    let scanned = scanned_crate_roots();
    let rows = map["crate_roots"].as_array().expect("crate_roots array");

    let mut seen: HashSet<(String, String)> = HashSet::new();
    for row in rows {
        let krate = as_str(row, "crate").to_owned();
        let module = as_str(row, "module").to_owned();
        let key = (krate.clone(), module.clone());
        assert!(
            seen.insert(key.clone()),
            "map lists {krate}::{module} more than once"
        );
        assert!(
            scanned.contains_key(&key),
            "map classifies {krate}::{module}, which no crate lib.rs declares"
        );
    }
    let mapped: HashSet<(String, String)> = seen;
    let universe: HashSet<(String, String)> = scanned.keys().cloned().collect();
    let unclassified: BTreeSet<_> = universe.difference(&mapped).collect();
    assert!(
        unclassified.is_empty(),
        "these scanned crate roots are not classified by the map: {unclassified:?}"
    );
    assert_eq!(
        mapped.len(),
        universe.len(),
        "map/scan cardinality mismatch"
    );
}

#[test]
fn every_row_is_a_strict_target_xor_split_union() {
    let map = load_map();
    let axes = load_axes(&map);
    let root = rust_root();
    for row in map["crate_roots"].as_array().expect("crate_roots array") {
        let krate = as_str(row, "crate");
        let module = as_str(row, "module");
        let context = format!("{krate}::{module}");
        let crate_src = root.join("crates").join(krate).join("src");

        // No top-level owner/role and no promoted split internals.
        for forbidden in [
            "business_owner",
            "structural_role",
            "child_groups",
            "file_responsibilities",
            "split_kind",
        ] {
            assert!(
                row.get(forbidden).is_none(),
                "{context}: `{forbidden}` must not sit at the row top level"
            );
        }

        let has_target = row.get("target").is_some();
        let has_split = row.get("split_required").is_some();
        assert!(
            has_target ^ has_split,
            "{context}: a row is exactly one of target / split_required"
        );

        // source_shape is re-derived, never trusted.
        let declared_shape = as_str(row, "source_shape");
        let cfg_test = row
            .get("cfg_test")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !cfg_test {
            let derived = derive_source_shape(&crate_src, module);
            assert_eq!(
                declared_shape, derived,
                "{context}: source_shape `{declared_shape}` disagrees with the tree (`{derived}`)"
            );
        }

        if has_target {
            let t = &row["target"];
            assert_axis(
                &axes,
                as_str(t, "business_owner"),
                as_str(t, "structural_role"),
                &context,
            );
            continue;
        }

        let split = &row["split_required"];
        let kind = as_str(split, "kind");
        // current_container may record a physical role or shape, NEVER a business owner.
        if let Some(cc) = split.get("current_container") {
            assert!(
                cc.get("business_owner").is_none(),
                "{context}: current_container must never carry a business_owner"
            );
        }
        match kind {
            "directory_members" => {
                assert_eq!(
                    declared_shape, "directory",
                    "{context}: directory_members requires a directory shape"
                );
                assert_directory_members(&axes, split, &crate_src, module, &context);
            }
            "file_responsibilities" => {
                assert_eq!(
                    declared_shape, "file",
                    "{context}: file_responsibilities requires a file shape"
                );
                assert_file_responsibilities(&axes, split, &context);
            }
            "hybrid" => {
                assert_eq!(
                    declared_shape, "hybrid",
                    "{context}: hybrid requires a hybrid shape"
                );
                assert_hybrid(&axes, split, &crate_src, module, &context);
            }
            other => panic!("{context}: unknown split_required.kind `{other}`"),
        }
    }
}

fn assert_directory_members(
    axes: &Axes,
    split: &Value,
    crate_src: &Path,
    module: &str,
    context: &str,
) {
    let groups = split["groups"]
        .as_array()
        .expect("directory_members groups");
    let declared: BTreeSet<String> = child_mod_decls(crate_src, module).into_iter().collect();
    let mut covered: Vec<String> = Vec::new();
    for g in groups {
        assert_axis(
            axes,
            as_str(g, "business_owner"),
            as_str(g, "structural_role"),
            context,
        );
        for m in g["members"].as_array().expect("group members array") {
            covered.push(m.as_str().expect("member string").to_owned());
        }
    }
    let cov: BTreeSet<String> = covered.iter().cloned().collect();
    assert_eq!(
        cov.len(),
        covered.len(),
        "{context}: a child module is listed in more than one directory group"
    );
    assert_eq!(
        cov, declared,
        "{context}: directory members do not close against the directory mod decls"
    );
}

fn assert_file_responsibilities(axes: &Axes, split: &Value, context: &str) {
    let resps = split["responsibilities"]
        .as_array()
        .expect("file_responsibilities array");
    assert!(
        !resps.is_empty(),
        "{context}: file_responsibilities must be non-empty"
    );
    for r in resps {
        assert!(
            r.get("members").is_none(),
            "{context}: a file responsibility must not claim child modules"
        );
        assert_axis(
            axes,
            as_str(r, "business_owner"),
            as_str(r, "structural_role"),
            context,
        );
    }
}

fn assert_hybrid(axes: &Axes, split: &Value, crate_src: &Path, module: &str, context: &str) {
    // Layer 1: child_groups close against the codec / child mod decls.
    let groups = split["child_groups"]
        .as_array()
        .expect("hybrid child_groups");
    let declared: BTreeSet<String> = child_mod_decls(crate_src, module).into_iter().collect();
    let mut covered: Vec<String> = Vec::new();
    for g in groups {
        assert_axis(
            axes,
            as_str(g, "business_owner"),
            as_str(g, "structural_role"),
            context,
        );
        for m in g["members"].as_array().expect("hybrid group members") {
            covered.push(m.as_str().expect("member string").to_owned());
        }
    }
    let cov: BTreeSet<String> = covered.iter().cloned().collect();
    assert_eq!(
        cov.len(),
        covered.len(),
        "{context}: hybrid child listed twice"
    );
    assert_eq!(
        cov, declared,
        "{context}: hybrid child_groups do not close against the child mod decls"
    );
    // Layer 2: file_responsibilities restore the main-body owners and must be non-empty,
    // so the main file cannot be silently classified by child closure alone.
    let resps = split["file_responsibilities"]
        .as_array()
        .expect("hybrid file_responsibilities");
    assert!(
        !resps.is_empty(),
        "{context}: hybrid file_responsibilities must be non-empty"
    );
    for r in resps {
        assert_axis(
            axes,
            as_str(r, "business_owner"),
            as_str(r, "structural_role"),
            context,
        );
    }
}

// ---------------------------------------------------------------------------
// Table half: the 33-table inventory closes against the replayed final schema.
// ---------------------------------------------------------------------------

#[path = "../../backend-sqlite/tests/support/current_schema_snapshot.rs"]
mod current_schema;

/// The independent table authority: the tables present after the executable schema
/// artifact (itself the replayed baseline + active migrations) is materialized into a
/// real SQLite database, read from `sqlite_master`. This is NOT read from the map.
///
/// The snapshot↔executable-migrations direction is guarded on the TS side by
/// `packages/backend/tests/migration-baseline.test.ts` (two-stage drift guard); this gate
/// closes the map↔snapshot leg, so map↔snapshot↔executable is closed end to end.
async fn replayed_tables() -> BTreeSet<String> {
    use sqlx::Row;
    let dir = tempfile::tempdir().expect("temp dir for schema db");
    let db_path = dir.path().join("schema.db");
    let mut conn = current_schema::create_current_schema(&db_path).await;
    let rows = sqlx::query(
        "SELECT name FROM sqlite_master WHERE type='table' \
         AND name NOT LIKE 'sqlite_%' AND name != '_migrations'",
    )
    .fetch_all(&mut conn)
    .await
    .expect("read sqlite_master");
    rows.into_iter()
        .map(|r| r.get::<String, _>("name"))
        .collect()
}

#[tokio::test]
async fn table_inventory_closes_against_the_replayed_schema() {
    let map = load_map();
    let map_tables: BTreeSet<String> = map["tables"]
        .as_array()
        .expect("tables array")
        .iter()
        .map(|t| as_str(t, "table").to_owned())
        .collect();
    let schema_tables = replayed_tables().await;
    assert_eq!(
        map_tables,
        schema_tables,
        "map table inventory does not equal the replayed final schema (map-only={:?}, schema-only={:?})",
        &map_tables - &schema_tables,
        &schema_tables - &map_tables
    );
}

#[test]
fn table_rows_carry_a_settled_target_and_audited_writer_evidence() {
    let map = load_map();
    let axes = load_axes(&map);
    for t in map["tables"].as_array().expect("tables array") {
        let table = as_str(t, "table");
        let context = format!("table {table}");
        let target = &t["target"];
        assert_axis(
            &axes,
            as_str(target, "business_owner"),
            as_str(target, "structural_role"),
            &context,
        );
        // impl_status reflects AUDITED KNOWN writers, not an exhaustive static proof: it
        // must agree with the recorded evidence shape (a known Rust writer, else a known TS
        // writer, else no known writer). Exhaustive write ownership is a residual for a
        // future typed write-perimeter refactor, NOT enforced here.
        let status = as_str(t, "impl_status");
        assert!(
            matches!(status, "rust_writer_known" | "ts_only" | "no_known_writer"),
            "{context}: impl_status `{status}` is not a legal audited-evidence value"
        );
        let has_rust = t["audited_rust_writers"]
            .as_array()
            .is_some_and(|a| !a.is_empty());
        let has_ts = t["audited_ts_writers"]
            .as_array()
            .is_some_and(|a| !a.is_empty());
        let derived = if has_rust {
            "rust_writer_known"
        } else if has_ts {
            "ts_only"
        } else {
            "no_known_writer"
        };
        assert_eq!(
            status, derived,
            "{context}: impl_status disagrees with the recorded audited writers"
        );
        // Recorded writer paths must EXIST and be PRODUCTION (not a test file / not under a
        // tests/ directory). audited_rust_writers are {path, function} objects;
        // audited_ts_writers are plain path strings.
        for w in t["audited_rust_writers"].as_array().into_iter().flatten() {
            let rel = as_str(w, "path");
            assert_writer_path_is_production(rel, &context, "audited_rust_writers");
            // the recorded function name is non-empty evidence.
            assert!(
                !as_str(w, "function").is_empty(),
                "{context}: audited_rust_writers entry `{rel}` has an empty function"
            );
        }
        for w in t["audited_ts_writers"].as_array().into_iter().flatten() {
            let rel = w.as_str().expect("ts writer path string");
            assert_writer_path_is_production(rel, &context, "audited_ts_writers");
        }
    }
}

/// A recorded writer path must exist relative to the repo root and be a production source
/// (not a `*_tests.rs` / `tests.rs`, and not under a `tests/` directory).
fn assert_writer_path_is_production(rel: &str, context: &str, key: &str) {
    assert!(
        repo_root().join(rel).exists(),
        "{context}: recorded {key} path `{rel}` does not exist"
    );
    let is_test =
        rel.contains("/tests/") || rel.ends_with("/tests.rs") || rel.ends_with("_tests.rs");
    assert!(
        !is_test,
        "{context}: recorded {key} path `{rel}` is a test file, not a production writer"
    );
}

/// Parse a `const NAME: &[(&str, &str)] = &[ ("crate","module"), … ];` table from the
/// scaffold source into a set of (crate, module) pairs (stripping `//` comments so
/// parenthesised prose inside comments is not read as entries). The independent CP
/// authority the organization gate uses for a root-coverage compatibility check.
fn cp_table(source: &str, name: &str) -> BTreeSet<(String, String)> {
    let head = format!("const {name}: &[(&str, &str)] = &[");
    let start = source
        .find(&head)
        .unwrap_or_else(|| panic!("CP table `{name}` not found"))
        + head.len();
    let end = start + source[start..].find("];").expect("CP table close");
    let raw = &source[start..end];
    let body: String = raw
        .lines()
        .map(|line| match line.find("//") {
            Some(pos) => &line[..pos],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let body = body.as_str();
    let mut out = BTreeSet::new();
    let mut i = 0;
    while let Some(rel) = body[i..].find('(') {
        let open = i + rel;
        let close = open + body[open..].find(')').expect("pair close");
        let inner = &body[open + 1..close];
        let parts: Vec<&str> = inner.split(',').collect();
        if parts.len() == 2 {
            let a = parts[0].trim().trim_matches('"');
            let b = parts[1].trim().trim_matches('"');
            if !a.is_empty() && !b.is_empty() {
                out.insert((a.to_owned(), b.to_owned()));
            }
        }
        i = close + 1;
    }
    out
}

// ---------------------------------------------------------------------------
// Target namespaces + mechanically-derived landed/residual (#task:2265).
//
// physical_target is a FULL Rust module path. A NORMAL row targets `crate::namespace::leaf`;
// a SELF-NAMED top-level context root (module name == owner namespace: embedded_bootstrap /
// workspace_data_plane / host_runtime) targets its own path `crate::module`. landed is
// derived mechanically: a root is landed iff its CURRENT full path (`crate::module`) equals
// its physical_target — that is exactly the self-named context roots (9 across the three
// crates); every other root targets a namespaced path it does not yet occupy and is
// residual. residual = scanned roots − mechanically-landed, derived from the map + real tree
// ONLY. The CP inventories in host_agent_scaffold.rs keep their original G4/G5 semantics and
// are used here only as a root-COVERAGE compatibility check, never as a landed/residual
// authority.
// ---------------------------------------------------------------------------

/// Assert an identifier is a legal snake/lower Rust ident (letters, digits, `_`, not
/// starting with a digit, non-empty).
fn is_legal_ident(s: &str) -> bool {
    !s.is_empty()
        && !s.chars().next().unwrap().is_ascii_digit()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The map's per-owner namespace table, validated: every business_owner axis value has a
/// namespace, every namespace is a legal ident, namespaces are unique, and there is no
/// namespace for an owner outside the axis (key closure).
fn validated_namespaces(map: &Value, axes: &Axes) -> std::collections::HashMap<String, String> {
    let by_owner = map["target_namespaces"]["by_business_owner"]
        .as_object()
        .expect("target_namespaces.by_business_owner object");
    let mut ns_by_owner = std::collections::HashMap::new();
    let mut seen_ns: BTreeSet<String> = BTreeSet::new();
    for (owner, ns) in by_owner {
        assert!(
            axes.business_owner.contains(owner),
            "target namespace key `{owner}` is not a business_owner axis value"
        );
        let ns = ns.as_str().expect("namespace string").to_owned();
        assert!(
            is_legal_ident(&ns),
            "target namespace `{ns}` (owner {owner}) is not a legal Rust identifier"
        );
        assert!(
            seen_ns.insert(ns.clone()),
            "duplicate target namespace `{ns}`"
        );
        ns_by_owner.insert(owner.clone(), ns);
    }
    // key closure the other way: every owner used by a row must have a namespace.
    for owner in &axes.business_owner {
        assert!(
            ns_by_owner.contains_key(owner),
            "business_owner `{owner}` has no target namespace"
        );
    }
    ns_by_owner
}

/// Validate a full target path `crate::ns::leaf…`: crate ∈ workspace, ns == the owner's
/// namespace, every segment a legal ident.
fn assert_full_target(
    pt: &str,
    crate_name: &str,
    owner: &str,
    ns_by_owner: &std::collections::HashMap<String, String>,
    context: &str,
) {
    let segs: Vec<&str> = pt.split("::").collect();
    assert!(
        segs.len() >= 3,
        "{context}: physical_target `{pt}` is not a full path crate::namespace::leaf"
    );
    assert_eq!(
        segs[0], crate_name,
        "{context}: target crate mismatch in `{pt}`"
    );
    let ns = ns_by_owner
        .get(owner)
        .unwrap_or_else(|| panic!("{context}: no namespace for owner {owner}"));
    assert_eq!(
        segs[1], ns,
        "{context}: target namespace segment must be `{ns}` (owner {owner}) in `{pt}`"
    );
    // segments after the crate name are Rust module idents (the crate dir name itself may
    // contain a hyphen and is checked by equality above, not as an ident).
    for seg in &segs[1..] {
        assert!(
            is_legal_ident(seg),
            "{context}: target path segment `{seg}` in `{pt}` is not a legal ident"
        );
    }
}

/// Every (crate, module) root, from the independent lib.rs scan.
fn scanned_roots() -> BTreeSet<(String, String)> {
    scanned_crate_roots().into_keys().collect()
}

/// The mechanically-landed roots: a settled row whose CURRENT full path equals its full
/// physical_target. These are exactly the self-named top-level context roots
/// (embedded_bootstrap / workspace_data_plane / host_runtime), which already reside at their
/// target; every other root targets a namespaced path it does not yet occupy.
fn mechanically_landed(map: &Value) -> BTreeSet<(String, String)> {
    let mut landed = BTreeSet::new();
    for r in map["crate_roots"].as_array().expect("crate_roots array") {
        if r.get("target").is_some() {
            let crate_name = as_str(r, "crate");
            let module = as_str(r, "module");
            let current = format!("{crate_name}::{module}");
            let pt = as_str(&r["migration"], "physical_target");
            if current == pt {
                landed.insert((crate_name.to_owned(), module.to_owned()));
            }
        }
    }
    landed
}

#[test]
fn target_namespaces_are_legal_unique_and_axis_closed() {
    let map = load_map();
    let axes = load_axes(&map);
    validated_namespaces(&map, &axes);
}

#[test]
fn physical_targets_are_full_paths_and_landed_is_mechanical() {
    let map = load_map();
    let axes = load_axes(&map);
    let ns_by_owner = validated_namespaces(&map, &axes);
    for r in map["crate_roots"].as_array().expect("crate_roots array") {
        let crate_name = as_str(r, "crate");
        let module = as_str(r, "module");
        let context = format!("{crate_name}::{module}");
        assert!(
            r["migration"].get("status").is_none(),
            "{context}: migration.status must not be stored — landed is derived mechanically"
        );
        if let Some(target) = r.get("target") {
            let owner = as_str(target, "business_owner");
            let pt = as_str(&r["migration"], "physical_target");
            let current = format!("{crate_name}::{module}");
            // A self-named top-level context root (its module name IS its owner namespace,
            // e.g. embedded_bootstrap / workspace_data_plane / host_runtime) is ALREADY at
            // its target: physical_target == current path == crate::module, mechanically
            // landed. A normal row targets crate::ns::module (namespace + leaf), not landed.
            if ns_by_owner[owner] == module {
                assert_eq!(
                    pt, current,
                    "{context}: a self-named context root's target must be its own path \
                     `{current}` (already landed), not a duplicated namespace path"
                );
            } else {
                assert_full_target(pt, crate_name, owner, &ns_by_owner, &context);
                assert_eq!(
                    pt,
                    format!("{crate_name}::{}::{module}", ns_by_owner[owner]),
                    "{context}: a normal settled row's target must be crate::ns::module"
                );
            }
        } else {
            assert!(
                r["migration"].get("split").and_then(Value::as_bool) == Some(true),
                "{context}: split row must carry migration.split = true"
            );
            let sr = &r["split_required"];
            let mut groups: Vec<&Value> = Vec::new();
            match as_str(sr, "kind") {
                "directory_members" => groups.extend(sr["groups"].as_array().unwrap()),
                "file_responsibilities" => {
                    groups.extend(sr["responsibilities"].as_array().unwrap())
                }
                "hybrid" => {
                    groups.extend(sr["child_groups"].as_array().unwrap());
                    groups.extend(sr["file_responsibilities"].as_array().unwrap());
                }
                other => panic!("{context}: unknown split kind {other}"),
            }
            for g in groups {
                let owner = as_str(g, "business_owner");
                // A split group's final leaf module name is not yet evidenced, so it is
                // explicitly `needs_ruling` and records only its KNOWN parent namespace
                // (crate::ns) — it does NOT fake a settled full physical_target using the
                // owner namespace as the leaf.
                assert!(
                    g.get("needs_ruling").and_then(Value::as_bool) == Some(true),
                    "{context}: a split group's final leaf is unevidenced — it must carry \
                     needs_ruling=true, not a faked settled target"
                );
                assert!(
                    g.get("physical_target").is_none(),
                    "{context}: a needs_ruling split group must not claim a settled \
                     physical_target"
                );
                let parent = as_str(g, "target_parent_namespace");
                assert_eq!(
                    parent,
                    format!("{crate_name}::{}", ns_by_owner[owner]),
                    "{context}: split group target_parent_namespace must be crate::<owner ns>"
                );
                // the parent namespace segment must be a legal ident.
                assert!(
                    is_legal_ident(ns_by_owner[owner].as_str()),
                    "{context}: split group parent namespace is not a legal ident"
                );
            }
        }
    }
}

#[test]
fn landed_set_is_exactly_the_self_named_context_roots() {
    // A root is mechanically landed iff its current path equals its physical_target. The
    // such roots are the self-named top-level contexts (module name == owner namespace).
    // Every other root targets crate::ns::leaf and is residual.
    let map = load_map();
    let landed = mechanically_landed(&map);
    let expected: BTreeSet<(String, String)> = [
        ("backend-app", "application_orchestration"),
        ("backend-core", "embedded_bootstrap"),
        ("backend-server", "embedded_bootstrap"),
        ("backend-sqlite", "embedded_bootstrap"),
        ("backend-core", "workspace_data_plane"),
        ("backend-server", "workspace_data_plane"),
        ("backend-sqlite", "workspace_data_plane"),
        ("backend-core", "host_runtime"),
        ("backend-server", "host_runtime"),
        ("backend-sqlite", "host_runtime"),
    ]
    .into_iter()
    .map(|(c, m)| (c.to_owned(), m.to_owned()))
    .collect();
    assert_eq!(
        landed,
        expected,
        "mechanically-landed set drifted: unexpected={:?} missing={:?}",
        &landed - &expected,
        &expected - &landed
    );
}

#[test]
fn residual_is_scanned_minus_landed_from_map_and_tree() {
    // The organization residual ledger is derived from the map + the real tree ALONE:
    // residual = scanned roots − mechanically-landed. Not copied from any CP table.
    let map = load_map();
    let scanned = scanned_roots();
    let landed = mechanically_landed(&map);
    assert!(
        landed.is_subset(&scanned),
        "landed roots must be scanned roots"
    );
    let residual: BTreeSet<(String, String)> = scanned.difference(&landed).cloned().collect();
    // residual is the scanned tree minus the (few) landed self-named contexts; disjoint
    // from landed and together covering the scanned tree.
    assert!(residual.is_disjoint(&landed), "residual and landed overlap");
    let union: BTreeSet<(String, String)> = residual.union(&landed).cloned().collect();
    assert_eq!(
        union, scanned,
        "residual ∪ landed must equal the scanned tree"
    );
    assert!(
        !residual.is_empty(),
        "residual ledger is unexpectedly empty"
    );
}

#[test]
fn cp_inventories_are_a_root_coverage_compatibility_check_only() {
    // The three CP tables retain their original G4/G5 seam semantics; here they are used
    // ONLY to confirm they still cover the current root tree exactly once (a compatibility
    // check), NOT as a landed/residual authority. No entry is reclassified.
    let scaffold = read(&rust_root().join("crates/backend-server/tests/host_agent_scaffold.rs"));
    let seam = cp_table(&scaffold, "SEAM_ROOT_MODULES");
    let did_not_add = cp_table(&scaffold, "ROOT_MODULES_WE_DID_NOT_ADD");
    let organization = cp_table(&scaffold, "ORGANIZATION_ROOT_MODULES");
    assert!(
        seam.is_disjoint(&did_not_add),
        "CP: SEAM and DID_NOT_ADD overlap"
    );
    let sd: BTreeSet<(String, String)> = seam.union(&did_not_add).cloned().collect();
    assert!(
        sd.is_disjoint(&organization),
        "CP: SEAM∪DID and ORGANIZATION overlap"
    );
    let cp_all: BTreeSet<(String, String)> = sd.union(&organization).cloned().collect();
    let scanned = scanned_roots();
    assert_eq!(
        cp_all,
        scanned,
        "CP inventories do not cover the scanned root tree exactly: cp-only={:?} tree-only={:?}",
        &cp_all - &scanned,
        &scanned - &cp_all
    );
}
