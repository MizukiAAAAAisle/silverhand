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
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
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

fn item_attrs(item: &syn::Item) -> &[syn::Attribute] {
    match item {
        syn::Item::Const(item) => &item.attrs,
        syn::Item::Enum(item) => &item.attrs,
        syn::Item::ExternCrate(item) => &item.attrs,
        syn::Item::Fn(item) => &item.attrs,
        syn::Item::ForeignMod(item) => &item.attrs,
        syn::Item::Impl(item) => &item.attrs,
        syn::Item::Macro(item) => &item.attrs,
        syn::Item::Mod(item) => &item.attrs,
        syn::Item::Static(item) => &item.attrs,
        syn::Item::Struct(item) => &item.attrs,
        syn::Item::Trait(item) => &item.attrs,
        syn::Item::TraitAlias(item) => &item.attrs,
        syn::Item::Type(item) => &item.attrs,
        syn::Item::Union(item) => &item.attrs,
        syn::Item::Use(item) => &item.attrs,
        _ => &[],
    }
}

/// Independent source_shape: `hybrid` iff a `<m>.rs` main body AND a `<m>/` directory that
/// carries PRODUCTION child `mod` declarations both exist; `directory` for a namespace
/// directory; else `file`. A sibling directory holding only test fixtures (no production
/// child `mod`) is NOT a hybrid — the `<m>.rs` is the real module. `base` is the directory
/// the module's `<m>.rs` / `<m>/` sits in — the crate `src/` for a residual root, or
/// `src/<namespace>/` for a landed root (#task:2272).
fn derive_source_shape(base: &Path, module: &str) -> String {
    let dir = base.join(module);
    let file = base.join(format!("{module}.rs"));
    let has_dir = dir.is_dir();
    let has_file = file.exists();
    if has_dir && has_file {
        if child_mod_decls(base, module).is_empty() {
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
/// `members` must close against. `base` is the directory the module sits in (see
/// [`derive_source_shape`]).
fn child_mod_decls(base: &Path, module: &str) -> Vec<String> {
    for candidate in [
        base.join(module).join("mod.rs"),
        base.join(format!("{module}.rs")),
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

// ---------------------------------------------------------------------------
// Module-location model (#task:2272): a settled row's module lives at EXACTLY one
// physical place, and the gate discovers which from the real tree — never from a stored
// flag. A RESIDUAL root still sits at the crate root (`crate::module`); a LANDED root has
// been moved under its target namespace (`crate::namespace::leaf`) and now sits in
// `src/<namespace>/`. The namespace directory itself is a CONTAINER, not a business unit:
// it is declared at the crate root but is not a map row, and its members are the landed
// leaves. This is the minimal, honest evolution of the #2265 crate-root scan so a real
// relocation neither passes vacuously nor forces the map to keep describing the old shape.
// ---------------------------------------------------------------------------

/// Whether a module file/dir physically exists directly under `base` (a `<m>.rs` or a
/// `<m>/` directory).
fn module_exists_in(base: &Path, module: &str) -> bool {
    base.join(format!("{module}.rs")).exists() || base.join(module).is_dir()
}

/// Where a settled row's module physically resides. Landed iff it sits at its
/// `physical_target` under the owner namespace; residual iff it still sits at the crate
/// root. EXACTLY ONE must be true — both present is an un-cleaned coexistence, neither is a
/// missing module — either fails the gate. There are no compatibility-path exceptions:
/// a settled unit has one physical source path. Returns `(is_landed, base_dir, leaf)`, where
/// `base_dir` is the directory the module sits in and `leaf` its final segment.
fn resolve_settled_location(
    crate_src: &Path,
    module: &str,
    physical_target: &str,
) -> (bool, PathBuf, String) {
    // physical_target is `crate::[namespace::]leaf`; segments after the crate name are the
    // module path under `src/`. A self-named context root (`crate::module`) has no extra
    // namespace and is trivially landed at the root.
    let segs: Vec<&str> = physical_target.split("::").collect();
    let under_src = &segs[1..]; // module path segments beneath the crate
    let leaf = (*under_src.last().expect("physical_target has a leaf")).to_owned();
    let target_base = {
        let mut b = crate_src.to_path_buf();
        for seg in &under_src[..under_src.len() - 1] {
            b = b.join(seg);
        }
        b
    };
    let at_root = module_exists_in(crate_src, module);
    // Self-named context roots (target_base == crate_src, leaf == module) are landed at the
    // root by construction; treat them as landed, not as a root/target coexistence.
    let self_named = target_base == crate_src && leaf == module;
    if self_named {
        assert!(
            at_root,
            "{module}: self-named context root must exist at the crate root ({})",
            crate_src.display()
        );
        return (true, crate_src.to_path_buf(), leaf);
    }
    let at_target = module_exists_in(&target_base, &leaf);
    assert!(
        at_root ^ at_target,
        "{module}: a settled module must reside at EXACTLY one of its crate root \
         (`{module}`, residual) or its physical_target (`{physical_target}`, landed) — \
         at_root={at_root} at_target={at_target}. Both present is an uncleaned coexistence; \
         neither is a missing module."
    );
    if at_target {
        (true, target_base, leaf)
    } else {
        (false, crate_src.to_path_buf(), module.to_owned())
    }
}

/// The map's target namespaces (owner → namespace), as a `(crate-agnostic)` set of
/// namespace idents. Read from `target_namespaces` — the single authority (#task:2272).
fn target_namespaces(map: &Value) -> BTreeSet<String> {
    map["target_namespaces"]["by_business_owner"]
        .as_object()
        .expect("target_namespaces.by_business_owner object")
        .values()
        .map(|v| v.as_str().expect("namespace string").to_owned())
        .collect()
}

/// Per `(crate, namespace)` role in the real tree — the model #task:2272's proof point must
/// get right, because a self-named context and a relocation container are NOT mutually
/// exclusive. A single root namespace `crate::host_runtime` can BOTH be its own landed
/// business unit (a settled row `module == "host_runtime"`, the directory as a whole) AND
/// descend to contribute landed leaves (`crate::host_runtime::agent_bulk_stop`). A pure
/// container (e.g. `identity_access`) only descends. This is decided PER (crate, namespace),
/// never by globally excluding a namespace that happens to be self-named somewhere.
struct NamespaceRole {
    /// The namespace has a self-named settled row (`module == namespace`): it is itself one
    /// landed business unit keyed `(crate, namespace)`, and the `namespace/` directory's
    /// non-leaf children are that context's OWN internal submodules (not business rows).
    has_self_row: bool,
    /// The leaf module names (children of `namespace/`) that are settled rows whose
    /// `physical_target` is `crate::namespace::leaf` — the relocated business units that have
    /// landed here. Verified to physically reside here by [`resolve_settled_location`].
    landed_leaves: BTreeSet<String>,
}

/// For a `(crate, namespace)`, read the map to find its self-row (if any) and the settled
/// rows whose target is `crate::namespace::leaf` that have physically landed in `namespace/`.
fn namespace_role(
    map: &Value,
    crate_name: &str,
    crate_src: &Path,
    namespace: &str,
) -> NamespaceRole {
    let mut has_self_row = false;
    let mut landed_leaves = BTreeSet::new();
    for r in map["crate_roots"].as_array().expect("crate_roots array") {
        if as_str(r, "crate") != crate_name || r.get("target").is_none() {
            continue;
        }
        let cfg_test = r.get("cfg_test").and_then(Value::as_bool).unwrap_or(false);
        if cfg_test {
            continue;
        }
        let module = as_str(r, "module");
        let pt = as_str(&r["migration"], "physical_target");
        if module == namespace && pt == format!("{crate_name}::{namespace}") {
            has_self_row = true;
        }
        // A row whose target is `crate::namespace::leaf`: it belongs to THIS namespace. It is
        // counted as landed only if the resolver finds it physically under `namespace/`.
        let expected_prefix = format!("{crate_name}::{namespace}::");
        if let Some(leaf) = pt.strip_prefix(&expected_prefix)
            && !leaf.contains("::")
        {
            let (is_landed, _base, resolved_leaf) = resolve_settled_location(crate_src, module, pt);
            if is_landed {
                landed_leaves.insert(resolved_leaf);
            }
        }
    }
    NamespaceRole {
        has_self_row,
        landed_leaves,
    }
}

/// The keys a namespace directory contributes to the universe, and which of its `mod.rs`
/// children are unaccounted — the PURE decision at the heart of #task:2272's P0. A namespace
/// can be BOTH a self-named context (keyed `(crate, ns)`) AND a business-leaf container (each
/// landed leaf keyed `(crate, ns::leaf)`); the two are not exclusive. A landed leaf is a
/// classified business unit that physically resides at its owner namespace — whether it moved
/// there by relocation or was born-at-target (a net-new #2341 migration feature module); the
/// PURE-container scan does not distinguish the two (`resolve_settled_location` proves physical
/// residence for both).
///
/// Returns `(keys, unaccounted_children)`. A child is accounted iff it is a landed leaf OR —
/// when the namespace has a self-named context row — ANY other child (absorbed as an
/// internal submodule of that context). This is a deliberate trade-off, NOT a closed-set
/// classification of a context's internals: when `has_self_row` is true, `unaccounted` is
/// always empty — this function does NOT prove a stray module inside a self-named / dual-role
/// context is illegal (that is intentionally left to the context's own decomposition, not
/// re-inventoried here). It therefore closes ONLY the PURE-CONTAINER case: a namespace with
/// no self row must have every child be a landed leaf, so a stray module there is red. What
/// guards a real landed leaf against going missing or coexisting at two paths is the
/// settled-row `resolve_settled_location` check, not this child scan.
fn namespace_universe_keys(
    krate: &str,
    namespace: &str,
    role: &NamespaceRole,
    children: &[String],
) -> (BTreeSet<(String, String)>, Vec<String>) {
    let mut keys = BTreeSet::new();
    if role.has_self_row {
        keys.insert((krate.to_owned(), namespace.to_owned()));
    }
    for leaf in &role.landed_leaves {
        keys.insert((krate.to_owned(), format!("{namespace}::{leaf}")));
    }
    let unaccounted: Vec<String> = children
        .iter()
        .filter(|c| !role.landed_leaves.contains(*c) && !role.has_self_row)
        .cloned()
        .collect();
    (keys, unaccounted)
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

/// The independent crate-root universe, keyed `(crate, full_path)` with whether it is
/// `#[cfg(test)]`. Crate scope comes from the workspace manifest, not a gate constant.
///
/// A top-level `mod NAME;` in a crate's `lib.rs` is one of:
/// - a RESIDUAL business unit (keyed `NAME`) — not a target namespace, or a namespace with
///   no directory yet;
/// - a NAMESPACE DIRECTORY. Decided PER (crate, namespace) via [`namespace_role`], it may
///   simultaneously be a SELF-NAMED CONTEXT (its own landed unit, keyed `NAME`) and a
///   RELOCATION CONTAINER (descends to landed leaves, keyed `NAME::LEAF`) — the two are NOT
///   mutually exclusive (#task:2272). The scan descends one level. For a PURE container (no
///   self row) every child of `NAME/mod.rs` must be a landed leaf, so a stray module there is
///   red. For a self-named / dual-role context the non-leaf children are its OWN internal
///   decomposition and are deliberately NOT re-classified here (see [`namespace_universe_keys`]) —
///   a stray module inside such a context is not caught by this scan. What keeps a real
///   relocated leaf from going missing or coexisting at two paths is the settled-row
///   `resolve_settled_location` check, not this child scan.
fn scanned_crate_roots() -> HashMap<(String, String), bool> {
    let root = rust_root();
    let map = load_map();
    let namespaces = target_namespaces(&map);
    let mut universe = HashMap::new();
    for krate in workspace_crates() {
        let crate_src = root.join("crates").join(&krate).join("src");
        let lib = crate_src.join("lib.rs");
        if !lib.exists() {
            continue; // a non-library crate (e.g. a binary-only member) has no lib.rs
        }
        for (module, cfg_test) in module_declarations(&read(&lib)) {
            let is_namespace_dir = namespaces.contains(&module) && crate_src.join(&module).is_dir();
            if !is_namespace_dir {
                let prior = universe.insert((krate.clone(), module.clone()), cfg_test);
                assert!(
                    prior.is_none(),
                    "{krate}/src/lib.rs declares `{module}` more than once"
                );
                continue;
            }
            // A namespace directory: a self-named context and/or a relocation container.
            let role = namespace_role(&map, &krate, &crate_src, &module);
            let container_mod = crate_src.join(&module).join("mod.rs");
            assert!(
                container_mod.exists(),
                "{krate}: namespace directory `{module}` has no {module}/mod.rs"
            );
            let children: Vec<String> = module_declarations(&read(&container_mod))
                .into_iter()
                .map(|(c, _)| c)
                .collect();
            let (keys, unaccounted) = namespace_universe_keys(&krate, &module, &role, &children);
            // PURE-CONTAINER teeth: for a namespace with NO self row, every child of
            // NAME/mod.rs must be a landed leaf, so a stray module there is red. For a
            // self-named / dual-role context, non-leaf children are its own internals and are
            // NOT flagged here (a trade-off — not a closed-set classification of internals).
            // A relocated leaf going missing / coexisting is guarded by the settled-row
            // resolver, not this scan.
            assert!(
                unaccounted.is_empty(),
                "{krate}: `{module}/mod.rs` declares {unaccounted:?} in a PURE container \
                 (no self-named context row), which are not classified business leaves (settled \
                 rows targeting `{krate}::{module}::<leaf>`, landed by relocation OR born-at-target) \
                 — unclassified"
            );
            for key in keys {
                let cfg = key.1 == module && cfg_test; // only the self-row carries lib.rs cfg
                let prior = universe.insert(key.clone(), cfg);
                assert!(
                    prior.is_none(),
                    "{krate}: namespace `{module}` yields duplicate universe key {key:?}"
                );
            }
        }
    }
    assert!(
        universe.len() > 130,
        "crate-root scan found only {} declarations — the walk is not reading the tree",
        universe.len()
    );
    universe
}

/// A settled map row's identity in the scanned universe: `crate::namespace::leaf` once it
/// has landed under its owner namespace, else its residual crate-root `module`. Derived from
/// the REAL tree via [`resolve_settled_location`], never from a stored flag. A `cfg_test`
/// row (a `#[cfg(test)]` / `#[path=…]` test-support declaration, e.g. `current_schema`) is
/// not a physically relocatable production module — it keeps its crate-root identity and is
/// never resolved against a namespace target (#task:2272).
fn row_universe_key(crate_src: &Path, row: &Value) -> (String, String) {
    let krate = as_str(row, "crate").to_owned();
    let module = as_str(row, "module");
    let cfg_test = row
        .get("cfg_test")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !cfg_test && row.get("target").is_some() {
        let pt = as_str(&row["migration"], "physical_target");
        let (is_landed, _base, _leaf) = resolve_settled_location(crate_src, module, pt);
        if is_landed && pt.split("::").count() >= 3 {
            // `crate::namespace::leaf` → universe key `namespace::leaf`.
            let tail = pt.split_once("::").unwrap().1.to_owned();
            return (krate, tail);
        }
    }
    (krate, module.to_owned())
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
    let root = rust_root();

    let mut seen: HashSet<(String, String)> = HashSet::new();
    for row in rows {
        let krate = as_str(row, "crate").to_owned();
        let module = as_str(row, "module").to_owned();
        // Match the row to the tree by its CURRENT location: a landed row appears in the
        // universe as `namespace::leaf`, a residual row as its crate-root `module`
        // (#task:2272). The map row's leaf identity stays `module`; only where it is found
        // moves.
        let crate_src = root.join("crates").join(&krate).join("src");
        let key = row_universe_key(&crate_src, row);
        assert!(
            seen.insert(key.clone()),
            "map lists {krate}::{module} more than once"
        );
        assert!(
            scanned.contains_key(&key),
            "map classifies {krate}::{module} (expected in the tree at `{}::{}`), which the \
             crate-root scan does not find there",
            key.0,
            key.1
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
fn accounting_is_derived_from_the_scanned_tree() {
    let map = load_map();
    let scanned = scanned_crate_roots();
    let production = scanned.values().filter(|cfg_test| !**cfg_test).count();
    let test_support = scanned.values().filter(|cfg_test| **cfg_test).count();
    let mut per_crate: BTreeMap<String, usize> = BTreeMap::new();
    for (krate, _module) in scanned.keys() {
        *per_crate.entry(krate.replace('-', "_")).or_default() += 1;
    }
    let accounting = &map["accounting"];
    assert_eq!(
        accounting["production_roots"].as_u64(),
        Some(production as u64),
        "accounting.production_roots drifted from the scanned tree"
    );
    assert_eq!(
        accounting["test_support_roots"].as_u64(),
        Some(test_support as u64),
        "accounting.test_support_roots drifted from the scanned tree"
    );
    assert_eq!(
        accounting["total_scanned"].as_u64(),
        Some(scanned.len() as u64),
        "accounting.total_scanned drifted from the scanned tree"
    );
    let recorded = accounting["per_crate"]
        .as_object()
        .expect("accounting.per_crate object");
    let actual: BTreeMap<String, usize> = recorded
        .iter()
        .map(|(krate, count)| {
            (
                krate.clone(),
                count.as_u64().expect("per-crate count") as usize,
            )
        })
        .collect();
    assert_eq!(actual, per_crate, "accounting.per_crate drifted");
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

        // source_shape is re-derived, never trusted — at the module's CURRENT location. A
        // settled row may have landed under its namespace (`src/<ns>/`); a split row is
        // residual by construction and still sits at the crate root (#task:2272).
        let declared_shape = as_str(row, "source_shape");
        let cfg_test = row
            .get("cfg_test")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !cfg_test {
            let (shape_base, shape_leaf) = if has_target {
                let pt = as_str(&row["migration"], "physical_target");
                let (_landed, base, leaf) = resolve_settled_location(&crate_src, module, pt);
                (base, leaf)
            } else {
                (crate_src.clone(), module.to_owned())
            };
            let derived = derive_source_shape(&shape_base, &shape_leaf);
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
/// The snapshot↔executable-migrations direction is guarded by the Rust startup
/// schema replay regression; this gate
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
        // must agree with the recorded evidence shape (a known Rust writer or no known writer). Exhaustive write ownership is a residual for a
        // future typed write-perimeter refactor, NOT enforced here.
        let status = as_str(t, "impl_status");
        assert!(
            matches!(status, "rust_writer_known" | "no_known_writer"),
            "{context}: impl_status `{status}` is not a legal audited-evidence value"
        );
        let has_rust = t["audited_rust_writers"]
            .as_array()
            .is_some_and(|a| !a.is_empty());
        let derived = if has_rust {
            "rust_writer_known"
        } else {
            "no_known_writer"
        };
        assert_eq!(
            status, derived,
            "{context}: impl_status disagrees with the recorded audited writers"
        );
        // Recorded writer paths must EXIST and be PRODUCTION (not a test file / not under a
        // tests/ directory). audited_rust_writers are {path, function} objects;
        // Only the current Rust writer evidence participates.
        for w in t["audited_rust_writers"].as_array().into_iter().flatten() {
            let rel = as_str(w, "path");
            assert_writer_path_is_production(rel, &context, "audited_rust_writers");
            // the recorded function name is non-empty evidence.
            let function = as_str(w, "function");
            assert!(
                !function.is_empty(),
                "{context}: audited_rust_writers entry `{rel}` has an empty function"
            );
            // The recorded function must actually EXIST at that path (Cindy R3-next
            // #12): a stale entry naming a deleted function must fail, not stay green.
            // A cheap symbol-existence set-diff against the file text — the function's
            // `fn <name>` definition must be present.
            assert_writer_function_exists(rel, function, &context);
        }
    }
}

/// A recorded writer function must physically exist as a PRODUCTION definition at its
/// recorded path (Cindy R3-next #12 / R4 P2): a `fn <name>` must appear on a
/// non-comment line that is NOT inside a `#[cfg(test)]` module, so a stale ledger
/// entry cannot stay green merely because the name appears in a comment or a test-only
/// helper. Heuristic (not a full parser): strip `//` line comments; track the brace
/// depth of any `#[cfg(test)]`-attributed `mod` and ignore `fn` matches within it.
fn assert_writer_function_exists(rel: &str, function: &str, context: &str) {
    let text = std::fs::read_to_string(repo_root().join(rel))
        .unwrap_or_else(|_| panic!("{context}: cannot read recorded writer path `{rel}`"));
    assert!(
        writer_function_is_defined_in_production(&text, function),
        "{context}: recorded audited_rust_writers function `{function}` has no PRODUCTION `fn` \
         definition in `{rel}` (a comment or a #[cfg(test)] helper does not count — stale/renamed \
         ledger entry)"
    );
}

/// Whether `function` has a PRODUCTION `fn <function>` definition in `text` — a
/// non-comment line outside any `#[cfg(test)]` module. Extracted so the guard's
/// comment/test-cfg exclusion is itself testable (Cindy R4 P2 counter-control).
fn writer_function_is_defined_in_production(text: &str, function: &str) -> bool {
    let matches_fn = |code: &str| -> bool {
        let needle = format!("fn {function}");
        let Some(idx) = code.find(&needle) else {
            return false;
        };
        let after = code[idx + needle.len()..].chars().next();
        !matches!(after, Some(c) if c.is_alphanumeric() || c == '_')
    };

    let mut in_test_mod_depth: Option<i32> = None;
    let mut depth: i32 = 0;
    let mut pending_cfg_test = false;
    let mut found_production = false;

    for raw_line in text.lines() {
        let code = match raw_line.find("//") {
            Some(i) => &raw_line[..i],
            None => raw_line,
        };
        let trimmed = code.trim();

        let is_cfg_test_line = trimmed.contains("#[cfg(test)]");
        let opens_mod = pending_cfg_test && trimmed.starts_with("mod ") && code.contains('{');
        if opens_mod {
            in_test_mod_depth = Some(depth);
            pending_cfg_test = false;
        } else if pending_cfg_test && !is_cfg_test_line && !trimmed.is_empty() {
            // The cfg(test) attribute applied to something other than a `mod` (e.g. a
            // single test fn) — not a whole test region; stop waiting. (The
            // `#[cfg(test)]` line itself must NOT clear the pending flag.)
            pending_cfg_test = false;
        }
        if is_cfg_test_line {
            pending_cfg_test = true;
        }

        if in_test_mod_depth.is_none() && matches_fn(code) {
            found_production = true;
        }

        depth += code.matches('{').count() as i32;
        depth -= code.matches('}').count() as i32;
        // Entering the mod added its own brace; the region closes when depth returns
        // to the level it opened at.
        if let Some(open_depth) = in_test_mod_depth
            && !opens_mod
            && depth <= open_depth
        {
            in_test_mod_depth = None;
        }
    }
    found_production
}

#[test]
fn writer_existence_guard_ignores_comments_and_test_cfg_functions() {
    // Cindy R4 P2 counter-control: a name that appears ONLY in a comment or ONLY in a
    // `#[cfg(test)]` module must NOT satisfy the guard; a real production fn does.
    assert!(writer_function_is_defined_in_production(
        "pub fn provision_workspace() {}",
        "provision_workspace"
    ));
    assert!(
        !writer_function_is_defined_in_production(
            "// calls fn provision_workspace here\n",
            "provision_workspace"
        ),
        "a comment mention must not count"
    );
    assert!(
        !writer_function_is_defined_in_production(
            "#[cfg(test)]\nmod tests {\n    fn provision_workspace() {}\n}\n",
            "provision_workspace"
        ),
        "a test-cfg helper must not count"
    );
    // A production fn PLUS a test helper of the same name still passes on the
    // production one.
    assert!(writer_function_is_defined_in_production(
        "fn provision_workspace() {}\n#[cfg(test)]\nmod tests {\n    fn provision_workspace() {}\n}\n",
        "provision_workspace"
    ));
    // Prefix collision: `fn provision_workspace_inner` must not satisfy a request for
    // `provision_workspace`.
    assert!(!writer_function_is_defined_in_production(
        "fn provision_workspace_inner() {}",
        "provision_workspace"
    ));
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
// workspace_data_plane / host_runtime and later context roots) targets its own path
// `crate::module`. landed is
// derived mechanically: a root is landed iff its CURRENT full path (`crate::module`) equals
// its physical_target — that is exactly the self-named context roots; every other root
// targets a namespaced path it does not yet occupy and is
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

/// The mechanically-landed roots: a settled row whose module physically RESIDES at its
/// full `physical_target` — derived from the real tree, never a stored flag (#task:2272).
/// At the #2265 anchor this is exactly the self-named top-level context roots
/// (embedded_bootstrap / workspace_data_plane / host_runtime); as relocation waves land
/// modules under their namespaces, each relocated leaf joins this set and leaves the
/// residual set. Keyed `(crate, full_path)` so a landed leaf is identified by where it now
/// lives (`namespace::leaf`), matching the scanned universe.
fn mechanically_landed(map: &Value) -> BTreeSet<(String, String)> {
    let root = rust_root();
    let mut landed = BTreeSet::new();
    for r in map["crate_roots"].as_array().expect("crate_roots array") {
        let cfg_test = r.get("cfg_test").and_then(Value::as_bool).unwrap_or(false);
        if !cfg_test && r.get("target").is_some() {
            let crate_name = as_str(r, "crate");
            let module = as_str(r, "module");
            let crate_src = root.join("crates").join(crate_name).join("src");
            let pt = as_str(&r["migration"], "physical_target");
            let (is_landed, _base, _leaf) = resolve_settled_location(&crate_src, module, pt);
            if is_landed {
                let key = row_universe_key(&crate_src, r);
                landed.insert(key);
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
fn landed_is_tree_derived_self_named_contexts_are_landed_and_nested_leaves_exist() {
    // The landed/residual split is derived ONLY by the resolver against the real tree — no
    // stored status, and (P1, #task:2272) no hand-maintained per-wave name list to keep in
    // sync with each git mv. This holds two GENERAL invariants instead:
    //
    //  (1) every self-named context row (module == its owner namespace) is landed — it
    //      resides at its own `crate::module` path by construction; and
    //  (2) at least one NESTED leaf (`crate::ns::leaf`) is landed — i.e. a real relocation
    //      has happened and the container path is exercised, not just the self-named roots.
    //
    // The full landed/residual sets themselves stay resolver+tree-derived (see
    // `residual_is_scanned_minus_landed_from_map_and_tree`); this test only proves the SHAPE
    // of what landing produces, so no second ledger is copied.
    let map = load_map();
    let ns_by_owner = validated_namespaces(&map, &load_axes(&map));
    let landed = mechanically_landed(&map);

    // (1) Every self-named context row is landed.
    let mut self_named_rows = 0usize;
    for r in map["crate_roots"].as_array().expect("crate_roots array") {
        let cfg_test = r.get("cfg_test").and_then(Value::as_bool).unwrap_or(false);
        if cfg_test || r.get("target").is_none() {
            continue;
        }
        let owner = as_str(&r["target"], "business_owner");
        let module = as_str(r, "module");
        if ns_by_owner[owner] == module {
            self_named_rows += 1;
            let crate_name = as_str(r, "crate").to_owned();
            assert!(
                landed.contains(&(crate_name.clone(), module.to_owned())),
                "self-named context {crate_name}::{module} must be tree-landed at its own path"
            );
        }
    }
    assert!(
        self_named_rows >= 3,
        "expected several self-named context rows, found {self_named_rows}"
    );

    // (2) At least one nested leaf `ns::leaf` has landed — a real relocation is exercised.
    let nested_landed: Vec<&(String, String)> =
        landed.iter().filter(|(_c, m)| m.contains("::")).collect();
    assert!(
        !nested_landed.is_empty(),
        "no nested landed leaf found — the relocation container path is unexercised; \
         landed={landed:?}"
    );
}

fn assert_declared_physical_target(target: &str, context: &str) {
    let segments: Vec<&str> = target.split("::").collect();
    assert!(
        segments.len() >= 3,
        "{context}: resolved target must be crate::namespace::leaf"
    );
    let crate_src = rust_root().join("crates").join(segments[0]).join("src");
    let mut declaring_file = crate_src.join("lib.rs");
    let mut module_prefix = crate_src;
    for segment in &segments[1..] {
        let declarations: BTreeSet<String> = module_declarations(&read(&declaring_file))
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert!(
            declarations.contains(*segment),
            "{context}: `{segment}` is not declared by {}",
            declaring_file.display()
        );
        module_prefix = module_prefix.join(segment);
        let flat = module_prefix.with_extension("rs");
        let directory = module_prefix.join("mod.rs");
        declaring_file = if flat.exists() {
            flat
        } else if directory.exists() {
            directory
        } else {
            panic!("{context}: declared leaf `{segment}` has no source file")
        };
    }
}

#[test]
fn every_resolved_split_closes_source_ruling_target_and_accounting_kind() {
    let map = load_map();
    let axes = load_axes(&map);
    let ns_by_owner = validated_namespaces(&map, &axes);
    let scanned = scanned_roots();
    let rows = map["resolved_splits"]
        .as_array()
        .expect("resolved_splits array");
    let open: BTreeSet<&str> = map["open_rulings"]
        .as_array()
        .expect("open_rulings array")
        .iter()
        .map(|value| value.as_str().expect("open ruling string"))
        .collect();
    let crate_rows = map["crate_roots"].as_array().expect("crate_roots array");
    let mut source_responsibilities = BTreeSet::new();
    let mut targets = BTreeSet::new();

    for row in rows {
        let source = as_str(row, "source");
        let responsibility = as_str(row, "responsibility");
        let context = format!("resolved {source}::{responsibility}");
        let source_segments: Vec<&str> = source.split("::").collect();
        assert_eq!(
            source_segments.len(),
            2,
            "{context}: source must name one removed crate root"
        );
        assert!(
            !scanned.contains(&(source_segments[0].to_owned(), source_segments[1].to_owned())),
            "{context}: resolved source root still exists in the scanned tree"
        );
        assert!(
            source_responsibilities.insert((source.to_owned(), responsibility.to_owned())),
            "{context}: duplicate (source, responsibility) evidence"
        );

        let owner = as_str(row, "business_owner");
        let role = as_str(row, "structural_role");
        assert_axis(&axes, owner, role, &context);
        let target = as_str(row, "physical_target");
        assert!(
            targets.insert(target.to_owned()),
            "{context}: resolved physical_target `{target}` is claimed more than once"
        );
        assert_full_target(target, source_segments[0], owner, &ns_by_owner, &context);
        assert_declared_physical_target(target, &context);

        let settled: Vec<&Value> = crate_rows
            .iter()
            .filter(|candidate| {
                candidate.get("target").is_some()
                    && candidate["migration"]
                        .get("physical_target")
                        .and_then(Value::as_str)
                        == Some(target)
            })
            .collect();
        match as_str(row, "kind") {
            "settled_crate_root" => {
                assert_eq!(
                    settled.len(),
                    1,
                    "{context}: settled_crate_root must have exactly one matching settled row"
                );
                let settled = settled[0];
                assert_eq!(as_str(settled, "crate"), source_segments[0], "{context}");
                assert_eq!(
                    as_str(settled, "module"),
                    target.rsplit("::").next().unwrap(),
                    "{context}: settled module must match the target leaf"
                );
                assert_eq!(
                    as_str(&settled["target"], "business_owner"),
                    owner,
                    "{context}: settled owner drifted from resolved evidence"
                );
                assert_eq!(
                    as_str(&settled["target"], "structural_role"),
                    role,
                    "{context}: settled role drifted from resolved evidence"
                );
            }
            "context_internal_leaf" => {
                assert!(
                    settled.is_empty(),
                    "{context}: context_internal_leaf must not gain a settled leaf row"
                );
                let target_segments: Vec<&str> = target.split("::").collect();
                let parent_target = format!("{}::{}", target_segments[0], target_segments[1]);
                let contexts: Vec<&Value> = crate_rows
                    .iter()
                    .filter(|candidate| {
                        candidate.get("target").is_some()
                            && candidate.get("crate").and_then(Value::as_str)
                                == Some(target_segments[0])
                            && candidate.get("module").and_then(Value::as_str)
                                == Some(target_segments[1])
                            && candidate["migration"]
                                .get("physical_target")
                                .and_then(Value::as_str)
                                == Some(parent_target.as_str())
                    })
                    .collect();
                assert_eq!(
                    contexts.len(),
                    1,
                    "{context}: context_internal_leaf must have one accounted self-context row"
                );
                assert_eq!(
                    as_str(&contexts[0]["target"], "business_owner"),
                    owner,
                    "{context}: parent context owner drifted from resolved evidence"
                );
            }
            other => panic!("{context}: unknown resolved split kind `{other}`"),
        }

        let ruling = format!("{source} split group '{responsibility}' final leaf module name");
        assert!(
            !open.contains(ruling.as_str()),
            "{context}: final leaf is still listed as an open ruling"
        );
    }
}

#[test]
fn resolved_scope_event_split_is_exact_and_every_leaf_is_declared() {
    let map = load_map();
    let axes = load_axes(&map);
    let ns_by_owner = validated_namespaces(&map, &axes);
    let rows = map["resolved_splits"]
        .as_array()
        .expect("resolved_splits array");
    let scope_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| as_str(row, "source") == "backend-server::scope_events")
        .collect();
    let expected: BTreeSet<String> = [
        "transport_substrate",
        "product_envelope",
        "user_presence_policy_effect",
        "agent_presence_availability_adapters",
        "identity_workspace_adapters",
        "messaging_notification_saved_reaction_attachment_direct_pair_adapters",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    let actual: BTreeSet<String> = scope_rows
        .iter()
        .map(|row| as_str(row, "responsibility").to_owned())
        .collect();
    assert_eq!(actual, expected, "scope-event resolved split drifted");
    assert_eq!(
        actual.len(),
        scope_rows.len(),
        "scope-event responsibility is recorded more than once"
    );
    assert!(
        !scanned_roots().contains(&("backend-server".to_owned(), "scope_events".to_owned())),
        "the resolved source aggregation must no longer be a crate root"
    );

    let open: BTreeSet<&str> = map["open_rulings"]
        .as_array()
        .expect("open_rulings array")
        .iter()
        .map(|value| value.as_str().expect("open ruling string"))
        .collect();
    for row in scope_rows {
        let responsibility = as_str(row, "responsibility");
        let context = format!("resolved scope_events::{responsibility}");
        let owner = as_str(row, "business_owner");
        let role = as_str(row, "structural_role");
        assert_axis(&axes, owner, role, &context);
        assert!(
            !open.contains(
                format!(
                    "backend-server::scope_events split group '{responsibility}' final leaf module name"
                )
                .as_str()
            ),
            "{context}: final leaf is still listed as an open ruling"
        );

        let target = as_str(row, "physical_target");
        assert_full_target(target, "backend-server", owner, &ns_by_owner, &context);
        assert_declared_physical_target(target, &context);
    }
}

#[test]
fn resolved_daemon_event_split_is_exact_and_every_leaf_is_declared() {
    let map = load_map();
    let rows = map["resolved_splits"]
        .as_array()
        .expect("resolved_splits array");
    let daemon_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| as_str(row, "source") == "backend-server::daemon_events")
        .collect();
    let expected: BTreeSet<(String, String, String, String)> = [
        (
            "runtime_settlement_state_codecs",
            "C2",
            "application",
            "backend-server::host_runtime::runtime_event_settlement",
        ),
        (
            "conversation_activity_projection_publisher",
            "C3",
            "adapter",
            "backend-server::conversation_messaging::runtime_activity_publisher",
        ),
        (
            "user_presence_publication",
            "viewer_read_model",
            "adapter",
            "backend-server::viewer_read_model::agent_presence_publisher",
        ),
        (
            "agent_host_status_presence_publication",
            "C2",
            "adapter",
            "backend-server::host_runtime::runtime_status_publisher",
        ),
    ]
    .into_iter()
    .map(|(responsibility, owner, role, target)| {
        (
            responsibility.to_owned(),
            owner.to_owned(),
            role.to_owned(),
            target.to_owned(),
        )
    })
    .collect();
    let actual: BTreeSet<(String, String, String, String)> = daemon_rows
        .iter()
        .map(|row| {
            assert_eq!(as_str(row, "kind"), "context_internal_leaf");
            (
                as_str(row, "responsibility").to_owned(),
                as_str(row, "business_owner").to_owned(),
                as_str(row, "structural_role").to_owned(),
                as_str(row, "physical_target").to_owned(),
            )
        })
        .collect();
    assert_eq!(actual, expected, "daemon-event resolved split drifted");
    assert_eq!(
        actual.len(),
        daemon_rows.len(),
        "daemon responsibility duplicated"
    );
    assert!(
        !scanned_roots().contains(&("backend-server".to_owned(), "daemon_events".to_owned())),
        "the resolved daemon_events aggregation must no longer be a crate root"
    );

    // First falsifier: deleting, duplicating, retargeting, or reclassifying any one row
    // breaks exact equality before a broader map invariant can accidentally mask it.
    let mut mutation = actual.clone();
    mutation.remove(&(
        "runtime_settlement_state_codecs".to_owned(),
        "C2".to_owned(),
        "application".to_owned(),
        "backend-server::host_runtime::runtime_event_settlement".to_owned(),
    ));
    assert_ne!(mutation, expected);
}

#[test]
fn resolved_host_agent_split_is_exact_and_every_leaf_is_declared() {
    let map = load_map();
    let rows = map["resolved_splits"]
        .as_array()
        .expect("resolved_splits array");
    let host_agent_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| as_str(row, "source") == "backend-server::host_agent")
        .collect();
    let expected: BTreeSet<(String, String, String, String)> = [
        (
            "agent_audit",
            "C1",
            "http",
            "backend-server::identity_access::agent_audit",
        ),
        (
            "agent_avatar",
            "C1",
            "http",
            "backend-server::identity_access::agent_avatar",
        ),
        (
            "agent_avatar_write",
            "C1",
            "http",
            "backend-server::identity_access::agent_avatar_write",
        ),
        (
            "agent_detail",
            "C1",
            "http",
            "backend-server::identity_access::agent_detail",
        ),
        (
            "agent_list",
            "C1",
            "http",
            "backend-server::identity_access::agent_list",
        ),
        (
            "agent_patch",
            "C1",
            "http",
            "backend-server::identity_access::agent_patch",
        ),
        (
            "public_profile_mcp",
            "C1",
            "http",
            "backend-server::identity_access::public_profile_mcp",
        ),
        (
            "agent_clear_session",
            "C2",
            "http",
            "backend-server::host_runtime::agent_clear_session",
        ),
        (
            "agent_presence",
            "C2",
            "http",
            "backend-server::host_runtime::agent_presence",
        ),
        (
            "agent_runtime_state",
            "C2",
            "http",
            "backend-server::host_runtime::agent_runtime_state",
        ),
        (
            "agent_runtime_switch",
            "C2",
            "http",
            "backend-server::host_runtime::agent_runtime_switch",
        ),
        (
            "agent_stop",
            "C2",
            "http",
            "backend-server::host_runtime::agent_stop",
        ),
        (
            "availability",
            "C2",
            "http",
            "backend-server::host_runtime::availability",
        ),
        (
            "host_attachment",
            "C2",
            "adapter",
            "backend-server::host_runtime::host_attachment",
        ),
        (
            "agent_create",
            "application_orchestration",
            "http",
            "backend-server::application_orchestration::agent_create",
        ),
        (
            "agent_delete",
            "application_orchestration",
            "http",
            "backend-server::application_orchestration::agent_delete",
        ),
        (
            "online_viewers",
            "viewer_read_model",
            "adapter",
            "backend-server::viewer_read_model::online_viewers",
        ),
        (
            "presence",
            "viewer_read_model",
            "http",
            "backend-server::viewer_read_model::user_presence_http",
        ),
        (
            "schedule_management",
            "C5",
            "http",
            "backend-server::scheduling::schedule_management",
        ),
    ]
    .into_iter()
    .map(|(responsibility, owner, role, target)| {
        (
            responsibility.to_owned(),
            owner.to_owned(),
            role.to_owned(),
            target.to_owned(),
        )
    })
    .collect();
    let actual: BTreeSet<(String, String, String, String)> = host_agent_rows
        .iter()
        .map(|row| {
            assert_eq!(as_str(row, "kind"), "context_internal_leaf");
            (
                as_str(row, "responsibility").to_owned(),
                as_str(row, "business_owner").to_owned(),
                as_str(row, "structural_role").to_owned(),
                as_str(row, "physical_target").to_owned(),
            )
        })
        .collect();
    assert_eq!(actual, expected, "host-agent resolved split drifted");
    assert_eq!(
        actual.len(),
        host_agent_rows.len(),
        "host-agent responsibility duplicated"
    );
    assert!(
        !scanned_roots().contains(&("backend-server".to_owned(), "host_agent".to_owned())),
        "the resolved host_agent aggregation must no longer be a crate root"
    );

    let scheduling_rows: Vec<&Value> = map["crate_roots"]
        .as_array()
        .expect("crate_roots array")
        .iter()
        .filter(|row| {
            as_str(row, "crate") == "backend-server" && as_str(row, "module") == "scheduling"
        })
        .collect();
    assert_eq!(scheduling_rows.len(), 1, "scheduling self-context row");
    let scheduling = scheduling_rows[0];
    assert_eq!(as_str(&scheduling["target"], "business_owner"), "C5");
    assert_eq!(as_str(&scheduling["target"], "structural_role"), "http");
    assert_eq!(
        as_str(&scheduling["migration"], "physical_target"),
        "backend-server::scheduling"
    );

    // First falsifier: the existing viewer-read-model presence policy occupies this target.
    // Retargeting the HTTP face there must break exact equality instead of creating a second
    // identity; only `user_presence_http` is the approved collision-free leaf.
    let mut occupied_presence_target = actual.clone();
    occupied_presence_target.remove(&(
        "presence".to_owned(),
        "viewer_read_model".to_owned(),
        "http".to_owned(),
        "backend-server::viewer_read_model::user_presence_http".to_owned(),
    ));
    occupied_presence_target.insert((
        "presence".to_owned(),
        "viewer_read_model".to_owned(),
        "http".to_owned(),
        "backend-server::viewer_read_model::presence".to_owned(),
    ));
    assert_ne!(occupied_presence_target, expected);
}

#[test]
fn resolved_internal_agent_split_is_exact_and_collision_free() {
    let map = load_map();
    let rows = map["resolved_splits"]
        .as_array()
        .expect("resolved_splits array");
    let internal_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| as_str(row, "source") == "backend-server::internal_agent")
        .collect();
    let expected: BTreeSet<(String, String, String, String)> = [
        (
            "wire",
            "C1",
            "wire",
            "backend-server::identity_access::agent_profile_wire",
        ),
        (
            "peer_profile",
            "C1",
            "http",
            "backend-server::identity_access::peer_profile",
        ),
        (
            "profile",
            "C1",
            "http",
            "backend-server::identity_access::self_profile",
        ),
        (
            "profile_mcp",
            "C1",
            "http",
            "backend-server::identity_access::self_profile_mcp",
        ),
        (
            "profile_write",
            "C1",
            "http",
            "backend-server::identity_access::self_profile_write",
        ),
        (
            "profile_write_admission",
            "C1",
            "wire",
            "backend-server::identity_access::self_profile_write_admission",
        ),
        (
            "cli_invoke",
            "foundation",
            "adapter",
            "backend-server::foundation::cli_invoke_observer",
        ),
        (
            "diagnostics",
            "foundation",
            "http",
            "backend-server::foundation::cli_preflight_trace",
        ),
    ]
    .into_iter()
    .map(|(responsibility, owner, role, target)| {
        (
            responsibility.to_owned(),
            owner.to_owned(),
            role.to_owned(),
            target.to_owned(),
        )
    })
    .collect();
    let actual: BTreeSet<(String, String, String, String)> = internal_rows
        .iter()
        .map(|row| {
            assert_eq!(as_str(row, "kind"), "context_internal_leaf");
            (
                as_str(row, "responsibility").to_owned(),
                as_str(row, "business_owner").to_owned(),
                as_str(row, "structural_role").to_owned(),
                as_str(row, "physical_target").to_owned(),
            )
        })
        .collect();
    assert_eq!(actual, expected, "internal-agent resolved split drifted");
    assert_eq!(
        actual.len(),
        internal_rows.len(),
        "internal-agent responsibility duplicated"
    );
    assert!(
        !scanned_roots().contains(&("backend-server".to_owned(), "internal_agent".to_owned())),
        "the resolved internal_agent aggregation must no longer be a crate root"
    );

    let root = rust_root().join("crates/backend-server/src");
    let identity_children: BTreeSet<String> =
        module_declarations(&read(&root.join("identity_access/mod.rs")))
            .into_iter()
            .map(|(name, _)| name)
            .collect();
    assert!(identity_children.contains("agent_wire"));
    assert!(identity_children.contains("agent_profile_wire"));
    assert!(!identity_children.contains("wire"));

    let open: BTreeSet<&str> = map["open_rulings"]
        .as_array()
        .expect("open_rulings array")
        .iter()
        .map(|value| value.as_str().expect("open ruling string"))
        .collect();
    assert!(!open.contains(
        "backend-server::internal_agent split group 'internal_agent_profile' final leaf module name"
    ));
    assert!(!open.contains(
        "backend-server::internal_agent split group 'cli_diagnostics' final leaf module name"
    ));

    // First falsifier: `agent_wire` is a real occupied sibling with a broader management
    // DTO. Retargeting the narrow internal profile projection there must break exact
    // equality instead of silently merging two wire contracts.
    let mut occupied_wire_target = actual.clone();
    occupied_wire_target.remove(&(
        "wire".to_owned(),
        "C1".to_owned(),
        "wire".to_owned(),
        "backend-server::identity_access::agent_profile_wire".to_owned(),
    ));
    occupied_wire_target.insert((
        "wire".to_owned(),
        "C1".to_owned(),
        "wire".to_owned(),
        "backend-server::identity_access::agent_wire".to_owned(),
    ));
    assert_ne!(occupied_wire_target, expected);
}

#[test]
fn resolved_ops_split_is_exact_and_keeps_local_and_remote_catalogues_separate() {
    use syn::visit::Visit as _;

    let map = load_map();
    let rows = map["resolved_splits"]
        .as_array()
        .expect("resolved_splits array");
    let ops_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| as_str(row, "source") == "backend-server::ops")
        .collect();
    let expected: BTreeSet<(String, String, String, String)> = [
        (
            "runtimes",
            "C2",
            "http",
            "backend-server::host_runtime::local_runtime_catalog",
        ),
        (
            "bind_address",
            "foundation",
            "domain",
            "backend-server::foundation::bind_address_scope",
        ),
        (
            "deployment",
            "foundation",
            "domain",
            "backend-server::foundation::deployment_profile",
        ),
        (
            "health",
            "foundation",
            "http",
            "backend-server::foundation::process_health",
        ),
        (
            "readiness",
            "foundation",
            "http",
            "backend-server::foundation::process_readiness",
        ),
        (
            "server_info",
            "foundation",
            "http",
            "backend-server::foundation::server_info",
        ),
    ]
    .into_iter()
    .map(|(responsibility, owner, role, target)| {
        (
            responsibility.to_owned(),
            owner.to_owned(),
            role.to_owned(),
            target.to_owned(),
        )
    })
    .collect();
    let actual: BTreeSet<(String, String, String, String)> = ops_rows
        .iter()
        .map(|row| {
            assert_eq!(as_str(row, "kind"), "context_internal_leaf");
            (
                as_str(row, "responsibility").to_owned(),
                as_str(row, "business_owner").to_owned(),
                as_str(row, "structural_role").to_owned(),
                as_str(row, "physical_target").to_owned(),
            )
        })
        .collect();
    assert_eq!(actual, expected, "ops resolved split drifted");
    assert_eq!(
        actual.len(),
        ops_rows.len(),
        "ops responsibility duplicated"
    );
    assert!(
        !scanned_roots().contains(&("backend-server".to_owned(), "ops".to_owned())),
        "the resolved ops aggregation must no longer be a crate root"
    );

    let root = rust_root().join("crates/backend-server/src");
    let foundation_children: BTreeSet<String> =
        module_declarations(&read(&root.join("foundation/mod.rs")))
            .into_iter()
            .map(|(name, _)| name)
            .collect();
    let host_runtime_children: BTreeSet<String> =
        module_declarations(&read(&root.join("host_runtime/mod.rs")))
            .into_iter()
            .map(|(name, _)| name)
            .collect();
    for child in [
        "bind_address_scope",
        "deployment_profile",
        "process_health",
        "process_readiness",
        "server_info",
    ] {
        assert!(
            foundation_children.contains(child),
            "missing foundation::{child}"
        );
    }
    assert!(host_runtime_children.contains("local_runtime_catalog"));
    assert!(!foundation_children.contains("ops"));
    assert!(!foundation_children.contains("operational_composition"));

    let open: BTreeSet<&str> = map["open_rulings"]
        .as_array()
        .expect("open_rulings array")
        .iter()
        .map(|value| value.as_str().expect("open ruling string"))
        .collect();
    assert!(!open.contains("backend-server::ops split group 'runtimes' final leaf module name"));
    assert!(!open.contains(
        "backend-server::ops split group 'operational_composition' final leaf module name"
    ));

    // The coordinate-free local detector face must never import the remote host-control
    // catalogue or a raw host/daemon coordinate. Walk every non-test top-level item, including
    // any production item placed after the test module.
    #[derive(Default)]
    struct LocalCatalogueFacts {
        forbidden: BTreeSet<String>,
    }
    impl<'ast> syn::visit::Visit<'ast> for LocalCatalogueFacts {
        fn visit_path(&mut self, path: &'ast syn::Path) {
            let segments: Vec<String> = path
                .segments
                .iter()
                .map(|segment| segment.ident.to_string())
                .collect();
            if segments
                .windows(2)
                .any(|pair| pair == ["host_runtime", "host_control"])
                || segments.iter().any(|segment| {
                    matches!(
                        segment.as_str(),
                        "ComputerId" | "DaemonInstanceId" | "HostId"
                    )
                })
            {
                self.forbidden.insert(segments.join("::"));
            }
            syn::visit::visit_path(self, path);
        }
    }
    let catalogue = syn::parse_file(&read(&root.join("host_runtime/local_runtime_catalog.rs")))
        .expect("local runtime catalogue parses");
    let mut facts = LocalCatalogueFacts::default();
    for item in &catalogue.items {
        if !item_attrs(item).iter().any(is_cfg_test) {
            facts.visit_item(item);
        }
    }
    assert_eq!(facts.forbidden, BTreeSet::new());
    let control_plane_factory = catalogue
        .items
        .iter()
        .find_map(|item| match item {
            syn::Item::Fn(function) if function.sig.ident == "control_plane_router" => {
                Some(function)
            }
            _ => None,
        })
        .expect("control_plane_router function");
    assert!(
        control_plane_factory.sig.inputs.is_empty(),
        "the control-plane refusal must have no detector/coordinate dependency"
    );

    // First falsifier: the remote catalogue is a real occupied identity. Retargeting the local
    // route there must break the exact set rather than merge coordinate-free and bound answers.
    let mut occupied_remote_target = actual.clone();
    occupied_remote_target.remove(&(
        "runtimes".to_owned(),
        "C2".to_owned(),
        "http".to_owned(),
        "backend-server::host_runtime::local_runtime_catalog".to_owned(),
    ));
    occupied_remote_target.insert((
        "runtimes".to_owned(),
        "C2".to_owned(),
        "http".to_owned(),
        "backend-server::host_runtime::host_control::runtime_catalog".to_owned(),
    ));
    assert_ne!(occupied_remote_target, expected);
}

#[test]
fn resolved_sqlite_host_agent_split_is_exact_and_keeps_one_store_authority() {
    let map = load_map();
    let rows = map["resolved_splits"]
        .as_array()
        .expect("resolved_splits array");
    let sqlite_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| as_str(row, "source") == "backend-sqlite::host_agent")
        .collect();
    let expected: BTreeSet<(String, String, String, String, String)> = [
        (
            "agent_graph_read",
            "context_internal_leaf",
            "application_orchestration",
            "adapter",
            "backend-sqlite::application_orchestration::agent_graph_read",
        ),
        (
            "agent_materialization",
            "context_internal_leaf",
            "application_orchestration",
            "adapter",
            "backend-sqlite::application_orchestration::agent_materialization",
        ),
        (
            "agent_teardown_cascade",
            "context_internal_leaf",
            "application_orchestration",
            "adapter",
            "backend-sqlite::application_orchestration::agent_teardown::cascade",
        ),
        (
            "agent_teardown_facts",
            "context_internal_leaf",
            "application_orchestration",
            "adapter",
            "backend-sqlite::application_orchestration::agent_teardown::facts",
        ),
        (
            "agent_deletion_intent",
            "context_internal_leaf",
            "application_orchestration",
            "adapter",
            "backend-sqlite::application_orchestration::agent_teardown::intent",
        ),
        (
            "agent_teardown_unit_of_work",
            "context_internal_leaf",
            "application_orchestration",
            "adapter",
            "backend-sqlite::application_orchestration::agent_teardown::unit_of_work",
        ),
        (
            "runtime_switch",
            "context_internal_leaf",
            "C2",
            "adapter",
            "backend-sqlite::host_runtime::runtime_switch",
        ),
        (
            "runtime_transition",
            "context_internal_leaf",
            "C2",
            "adapter",
            "backend-sqlite::host_runtime::runtime_transition",
        ),
        (
            "agent_bulk_stop_read",
            "context_internal_leaf",
            "C2",
            "adapter",
            "backend-sqlite::host_runtime::agent_bulk_stop_read",
        ),
        (
            "shared_store",
            "settled_crate_root",
            "foundation",
            "adapter",
            "backend-sqlite::foundation::host_agent_store",
        ),
        (
            "agent_profile_mcp_placement_read",
            "settled_crate_root",
            "C1",
            "adapter",
            "backend-sqlite::identity_access::agent_profile_mcp_placement_read",
        ),
    ]
    .into_iter()
    .map(|(responsibility, kind, owner, role, target)| {
        (
            responsibility.to_owned(),
            kind.to_owned(),
            owner.to_owned(),
            role.to_owned(),
            target.to_owned(),
        )
    })
    .collect();
    let actual: BTreeSet<(String, String, String, String, String)> = sqlite_rows
        .iter()
        .map(|row| {
            (
                as_str(row, "responsibility").to_owned(),
                as_str(row, "kind").to_owned(),
                as_str(row, "business_owner").to_owned(),
                as_str(row, "structural_role").to_owned(),
                as_str(row, "physical_target").to_owned(),
            )
        })
        .collect();
    assert_eq!(actual, expected, "sqlite host-agent split drifted");
    assert_eq!(actual.len(), sqlite_rows.len(), "responsibility duplicated");

    let source = rust_root().join("crates/backend-sqlite/src");
    assert!(
        !source.join("host_agent.rs").exists() && !source.join("host_agent").exists(),
        "the split umbrella must be deleted, not retained as a facade"
    );

    let store = source.join("foundation/host_agent_store/mod.rs");
    let store_children: BTreeSet<String> = module_declarations(&read(&store))
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    assert_eq!(
        store_children,
        BTreeSet::from(["decode".to_owned()]),
        "the settled store unit has exactly one internal decode child"
    );
    assert!(
        source
            .join("foundation/host_agent_store/decode.rs")
            .exists()
    );
    assert!(
        !sqlite_rows
            .iter()
            .any(|row| as_str(row, "physical_target").ends_with("::decode")),
        "decode is not an independently accounted authority"
    );

    fn collect_rs(directory: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(directory).expect("read sqlite source directory") {
            let path = entry.expect("source entry").path();
            if path.is_dir() {
                collect_rs(&path, out);
            } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }
    let mut sources = Vec::new();
    collect_rs(&source, &mut sources);
    let bodies: Vec<(PathBuf, String)> = sources
        .into_iter()
        .map(|path| {
            let body = read(&path);
            (path, body)
        })
        .collect();
    let containing = |needle: &str| -> Vec<PathBuf> {
        bodies
            .iter()
            .filter(|(_, body)| body.contains(needle))
            .map(|(path, _)| path.clone())
            .collect()
    };
    assert_eq!(
        containing("pub struct SqliteHostAgentStore"),
        vec![store.clone()],
        "the store/pool authority must have one definition"
    );
    assert_eq!(
        containing("impl AgentTeardownReadPort for SqliteHostAgentStore"),
        vec![source.join("application_orchestration/agent_teardown/facts.rs")],
        "application teardown facts own only the application read port"
    );
    assert_eq!(
        containing("impl AgentBulkStopReadPort for SqliteHostAgentStore"),
        vec![source.join("host_runtime/agent_bulk_stop_read.rs")],
        "C2 owns the bulk-stop read port"
    );
    assert_eq!(
        containing("impl AgentProfileMcpPlacementRead for SqliteHostAgentStore"),
        vec![source.join("identity_access/agent_profile_mcp_placement_read.rs")],
        "C1 owns the profile-MCP placement port"
    );
    for runtime in [
        "host_runtime/agent_bulk_stop_read.rs",
        "host_runtime/runtime_switch.rs",
        "host_runtime/runtime_transition.rs",
    ] {
        assert!(
            !read(&source.join(runtime)).contains("crate::application_orchestration"),
            "runtime adapter {runtime} must not depend on the application adapter"
        );
    }

    // First falsifier: the C1 placement trait cannot drift back into the application
    // teardown facts leaf without breaking the exact responsibility assignment.
    let mut wrong_trait_owner = actual.clone();
    wrong_trait_owner.remove(&(
        "agent_profile_mcp_placement_read".to_owned(),
        "settled_crate_root".to_owned(),
        "C1".to_owned(),
        "adapter".to_owned(),
        "backend-sqlite::identity_access::agent_profile_mcp_placement_read".to_owned(),
    ));
    wrong_trait_owner.insert((
        "agent_profile_mcp_placement_read".to_owned(),
        "context_internal_leaf".to_owned(),
        "application_orchestration".to_owned(),
        "adapter".to_owned(),
        "backend-sqlite::application_orchestration::agent_teardown::facts".to_owned(),
    ));
    assert_ne!(wrong_trait_owner, expected);
}

#[test]
fn root_compatibility_facades_are_forbidden() {
    // #task:2327: the five #2269 shims were migration scaffolding, not public compatibility
    // contracts. The terminal model has one canonical source path per business unit, so the
    // map may not reopen a compatibility field and none of the former root files/declarations
    // may return.
    let map = load_map();
    for r in map["crate_roots"].as_array().expect("crate_roots array") {
        assert!(
            r.get("migration")
                .and_then(|migration| migration.get("compatibility_facade"))
                .is_none(),
            "{}::{} reintroduced a forbidden compatibility_facade",
            as_str(r, "crate"),
            as_str(r, "module")
        );
    }
    let server_src = rust_root().join("crates/backend-server/src");
    let declarations: BTreeSet<String> = module_declarations(&read(&server_src.join("lib.rs")))
        .into_iter()
        .map(|(module, _)| module)
        .collect();
    for module in [
        "agent_materialize",
        "agent_profile_mcp_data_plane",
        "daemon_delivery",
        "runtime_control",
        "scope_runtime_stop",
    ] {
        assert!(
            !module_exists_in(&server_src, module),
            "backend-server::{module}: old root facade source returned"
        );
        assert!(
            !declarations.contains(module),
            "backend-server::{module}: old root facade declaration returned"
        );
    }
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
    // ONLY to confirm they still cover the current CRATE-ROOT tree exactly once (a
    // compatibility check), NOT as a landed/residual authority. No entry is reclassified.
    //
    // Per the #task:2272 layering: the scaffold seam ledger keys by the CURRENT OWNING ROOT
    // NAMESPACE. A landed leaf `ns::leaf` is owned at the crate root by its container `ns`
    // (a single seam entry), NOT re-inventoried leaf by leaf. So the coverage compares CP
    // against the scanned tree PROJECTED to its crate-root owner: a landed leaf collapses to
    // its namespace container, a residual root stays itself. The organization map/gate is the
    // authority for the leaves inside a container; the scaffold only sees the container.
    let map = load_map();
    let namespaces = target_namespaces(&map);
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
    // Project the scanned tree to its crate-root owner: `ns::leaf` (a landed leaf) → `ns`
    // (its root namespace); everything else is a crate-root module already. A self-named
    // context's own `(crate, ns)` entry projects to itself, so it and its landed leaves fold
    // into the SAME single owning-root entry — the scaffold sees one seam root, not leaves.
    let scanned_root_owners = project_to_root_owners(scanned_roots(), &namespaces);
    assert_eq!(
        cp_all,
        scanned_root_owners,
        "CP inventories do not cover the crate-root tree exactly: cp-only={:?} tree-only={:?}",
        &cp_all - &scanned_root_owners,
        &scanned_root_owners - &cp_all
    );
}

/// Collapse a scanned-tree universe to its CRATE-ROOT owners: a landed leaf `ns::leaf`
/// (whose `ns` is a target namespace) folds into its root namespace `ns`; every other entry
/// is already a crate-root module and stays itself. A self-named context's own `(crate, ns)`
/// entry stays `ns`, so it and any landed leaves beneath it collapse to ONE owning-root
/// entry. This is the projection the scaffold seam ledger is compared against — it sees
/// owning roots, never a namespace's leaves (#task:2272).
fn project_to_root_owners(
    universe: BTreeSet<(String, String)>,
    namespaces: &BTreeSet<String>,
) -> BTreeSet<(String, String)> {
    universe
        .into_iter()
        .map(|(krate, module)| match module.split_once("::") {
            Some((ns, _leaf)) if namespaces.contains(ns) => (krate, ns.to_owned()),
            _ => (krate, module),
        })
        .collect()
}

#[test]
fn falsifier_a_self_named_context_and_a_relocation_container_coexist_without_losing_leaves() {
    // #task:2272 P0 falsifier: a self-named context and a relocation container are NOT
    // mutually exclusive. A single root namespace (e.g. `host_runtime`) can be BOTH its own
    // landed business unit AND the container a wave relocates leaves into. Prove the pure
    // universe-key decision keeps both keys and never drops a landed leaf — driven
    // synthetically so it holds before the host_runtime wave exists. Note the deliberate
    // scope: the closed-set "stray child is red" check applies to PURE containers only; a
    // self-named context's non-leaf children are its own internals and are intentionally not
    // re-classified here.

    // (A) DUAL ROLE: self row present + a landed leaf. Both keys must appear. The context's
    // non-leaf children are absorbed as its internals — `unaccounted` is empty by design
    // (this function does NOT close a self-named context's internals; that is the trade-off).
    let dual = NamespaceRole {
        has_self_row: true,
        landed_leaves: ["agent_bulk_stop".to_owned()].into_iter().collect(),
    };
    let children = vec![
        "aftermath".to_owned(),       // context-internal submodule
        "computer".to_owned(),        // context-internal submodule
        "agent_bulk_stop".to_owned(), // relocated leaf
    ];
    let (keys, unaccounted) =
        namespace_universe_keys("backend-core", "host_runtime", &dual, &children);
    assert!(
        keys.contains(&("backend-core".to_owned(), "host_runtime".to_owned())),
        "the self-named context must remain its own root business unit"
    );
    assert!(
        keys.contains(&(
            "backend-core".to_owned(),
            "host_runtime::agent_bulk_stop".to_owned()
        )),
        "the relocated leaf must appear as its own ns::leaf unit and NOT be swallowed by the \
         context — the P0 regression"
    );
    assert!(
        unaccounted.is_empty(),
        "a self-named context absorbs its non-leaf children (by design, not a closed-set \
         check): {unaccounted:?}"
    );

    // (A') TRADE-OFF MADE EXPLICIT: even a genuinely stray child inside a self-named context
    // is absorbed, not flagged — the child scan does NOT close a context's internals. This
    // asserts the actual (weaker) behavior so the comments above cannot overclaim.
    let (_keys, unaccounted_with_stray) = namespace_universe_keys(
        "backend-core",
        "host_runtime",
        &dual,
        &[
            "aftermath".to_owned(),
            "totally_stray".to_owned(),
            "agent_bulk_stop".to_owned(),
        ],
    );
    assert!(
        unaccounted_with_stray.is_empty(),
        "a self-named context does NOT flag a stray internal child — that is the documented \
         trade-off, not a closed-set guarantee: {unaccounted_with_stray:?}"
    );

    // (B) PURE CONTAINER: no self row. A landed leaf is kept; ANY other child is unaccounted
    // (no context to absorb it) — a stray module in a PURE container turns the scan red. This
    // is the ONLY case the child scan flags; a real leaf's missing/coexistence is guarded by
    // the settled-row resolver, not here.
    let container = NamespaceRole {
        has_self_row: false,
        landed_leaves: ["participant_handle_availability".to_owned()]
            .into_iter()
            .collect(),
    };
    let (keys, unaccounted) = namespace_universe_keys(
        "backend-core",
        "identity_access",
        &container,
        &[
            "participant_handle_availability".to_owned(),
            "stray".to_owned(),
        ],
    );
    assert!(
        keys.contains(&(
            "backend-core".to_owned(),
            "identity_access::participant_handle_availability".to_owned()
        )),
        "a pure container's landed leaf is its own unit"
    );
    assert!(
        !keys.contains(&("backend-core".to_owned(), "identity_access".to_owned())),
        "a pure container has no self business row"
    );
    assert_eq!(
        unaccounted,
        vec!["stray".to_owned()],
        "a non-leaf child of a pure container is unclassified (turns the scan red)"
    );

    // (C) REAL TREE: `host_runtime` IS a self-named context directory in each crate that
    // declares it — proof the dual model reads the real tree, not just a synthetic role. As of
    // the first host_runtime relocation wave it now ALSO carries landed relocation leaves, so
    // branch (A)'s dual-role logic holds on the real tree. This asserts only the STABLE SHAPE
    // that must remain true across every host_runtime wave — a self row plus at least one
    // nested landed leaf — and deliberately does NOT enumerate which leaves have landed: the
    // map + real tree are the sole authority for the landed set (`resolve_settled_location` per
    // row, and the workspace-wide root/target XOR + coverage gates), so no per-wave landed
    // ledger is re-introduced here. Its many internal submodules do NOT leak into the universe
    // as unclassified, which the green `scanned_crate_roots` relies on.
    let map = load_map();
    let root = rust_root();
    let hr_core = namespace_role(
        &map,
        "backend-core",
        &root.join("crates/backend-core/src"),
        "host_runtime",
    );
    assert!(
        hr_core.has_self_row,
        "backend-core::host_runtime is a self-named context"
    );
    assert!(
        !hr_core.landed_leaves.is_empty(),
        "host_runtime now carries at least one nested landed relocation leaf, proving the \
         dual role on the real tree — the exact landed set is derived from the map + tree, \
         not asserted here"
    );
}

#[test]
fn falsifier_a_stale_flat_seam_entry_for_a_relocated_leaf_is_red() {
    // #task:2272 falsifier: once a leaf relocates under a container, the scaffold seam
    // ledger must key it by the CONTAINER, not keep the old flat leaf entry. Prove the
    // coverage check rejects a stale flat entry: with the leaf landed at
    // `identity_access::participant_handle_availability` in the tree, a CP set that still
    // lists the flat `participant_handle_availability` (and lacks the container) must
    // mismatch — the flat entry is cp-only and the container is tree-only.
    let containers: BTreeSet<String> = ["identity_access".to_owned()].into_iter().collect();
    let tree: BTreeSet<(String, String)> = [
        (
            "backend-core",
            "identity_access::participant_handle_availability",
        ),
        ("backend-core", "agents"),
    ]
    .into_iter()
    .map(|(c, m)| (c.to_owned(), m.to_owned()))
    .collect();
    let projected = project_to_root_owners(tree, &containers);
    let expected_ok: BTreeSet<(String, String)> = [
        ("backend-core", "identity_access"),
        ("backend-core", "agents"),
    ]
    .into_iter()
    .map(|(c, m)| (c.to_owned(), m.to_owned()))
    .collect();
    // The honest CP (keyed by the container) matches the projection.
    assert_eq!(
        projected, expected_ok,
        "projection must fold the leaf into its container"
    );
    // The stale CP (flat leaf, no container) does NOT match — the check turns red.
    let stale_cp: BTreeSet<(String, String)> = [
        ("backend-core", "participant_handle_availability"),
        ("backend-core", "agents"),
    ]
    .into_iter()
    .map(|(c, m)| (c.to_owned(), m.to_owned()))
    .collect();
    assert_ne!(
        stale_cp, projected,
        "a stale flat seam entry for a relocated leaf must fail CP coverage"
    );
    assert!(
        (&stale_cp - &projected).contains(&(
            "backend-core".to_owned(),
            "participant_handle_availability".to_owned()
        )),
        "the stale flat entry must be reported as cp-only"
    );
    assert!(
        (&projected - &stale_cp)
            .contains(&("backend-core".to_owned(), "identity_access".to_owned())),
        "the container must be reported as tree-only against a stale CP"
    );
}

#[test]
fn falsifier_a_missing_or_duplicate_namespace_root_is_red() {
    // #task:2272 falsifier: the namespace container must be declared exactly once at the
    // crate root. Prove both failure directions against the real tree via the same scanner
    // helpers the gate uses, from synthetic lib.rs fixtures — no reliance on another change.

    // (1) MISSING: a lib.rs that declares the container is required for the scan to descend;
    // a lib.rs WITHOUT `identity_access` would leave the landed leaf undiscovered and the
    // map row `participant_handle_availability` (expected at `identity_access::…`)
    // unmatched. Prove the container-recursion is what surfaces the leaf: parsing a lib.rs
    // that omits the container yields no `identity_access` root at all.
    let lib_without_container = "#![forbid(unsafe_code)]\n\npub mod agents;\npub mod identity;\n";
    let roots: BTreeSet<String> = module_declarations(lib_without_container)
        .into_iter()
        .map(|(m, _)| m)
        .collect();
    assert!(
        !roots.contains("identity_access"),
        "a lib.rs missing the namespace container declares no such root — the landed leaf \
         would be undiscovered and its map row unmatched (red)"
    );

    // (2) DUPLICATE: two `pub mod identity_access;` lines at one root. `scanned_crate_roots`
    // asserts a root is declared at most once ("declares `identity_access` more than once");
    // module_declarations returns both, so a dedup-free consumer sees the duplicate. Prove
    // the duplicate is observable (the scanner's more-than-once assertion fires on it).
    let lib_with_duplicate =
        "#![forbid(unsafe_code)]\n\npub mod identity_access;\npub mod identity_access;\n";
    let decls: Vec<String> = module_declarations(lib_with_duplicate)
        .into_iter()
        .map(|(m, _)| m)
        .collect();
    assert_eq!(
        decls.iter().filter(|m| *m == "identity_access").count(),
        2,
        "a duplicated namespace-root declaration is observable to the scan (its \
         more-than-once assertion turns the gate red)"
    );
}
