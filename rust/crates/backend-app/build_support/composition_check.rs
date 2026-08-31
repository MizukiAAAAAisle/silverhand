//! Composition checker (#task:2265, contract from #2266).
//!
//! A `syn` whole-crate production module-graph checker, invoked from `build.rs`, that
//! replaces the former `include_str!`+string-count gate. It proves the three composition
//! semantic doors of `backend-app` are each reached by exactly one production path, and is
//! FAIL-CLOSED: any construction it cannot resolve to a plain direct call in the one
//! allowlisted function — an `as`/type alias that could rebind a guarded name, a
//! function-value or wrapper, an occurrence inside a loop / closure / nested fn, or a
//! macro whose tokens do not parse as an expression — is reported as a violation rather
//! than silently passing. A violation fails `cargo check -p silverhand-backend-app` with
//! the offending symbol, its enclosing function, and a `path:line` span.
//!
//! Production only: every `#[cfg(test)]` item is dropped before analysis, so a bind in a
//! test module is invisible here regardless of its file path. All production items are
//! walked, including inside inline modules and `impl` blocks.
//!
//! Doors (current anchor tree; owners move wholesale when #2266 splits composition):
//!
//! 1. bind — `TcpListener::bind` : one production reference, direct callee of
//!    `bind_and_prepare`; `bind_and_prepare` called once, by `run`.
//! 2. bootstrap — `write_bootstrap_token_file` : one production call, direct callee of
//!    `prepare_for_bound_listener_observed`.
//! 3. finalize — one production `PreparedApp { .. }` struct literal in
//!    `prepare_for_bound_listener_observed`, with exactly one root `Router::new` inside it.
//!    The merge chain is NOT pinned.

use std::{
    fs,
    path::{Path, PathBuf},
};

use syn::{
    Expr, Item, Macro,
    spanned::Spanned,
    visit::{self, Visit},
};

/// A parsed production file with its repo-relative path (for diagnostics).
pub struct Crate {
    files: Vec<(String, syn::File)>,
}

/// The composition call-chain: each intermediate link `(fn, expected_caller)`. Sealing
/// walks this from the terminal outward. This SAME list feeds `guarded_names()` so alias
/// rejection and occurrence sealing can never drift onto two different name sets.
const CHAIN_LINKS: &[(&str, &str)] = &[
    ("bind_and_prepare", "run"),
    ("prepare_bound_listener", "bind_and_prepare"),
    ("prepare_bound_listener_observed", "prepare_bound_listener"),
    (
        "prepare_for_bound_listener_observed",
        "prepare_bound_listener_observed",
    ),
];

/// The terminal identifiers the doors match directly.
const TERMINAL_NAMES: &[&str] = &[
    "bind",
    "TcpListener",
    "write_bootstrap_token_file",
    "PreparedApp",
    "Router",
];

/// The single guarded-name set — terminals plus every intermediate chain fn — that drives
/// BOTH alias rejection and occurrence sealing. A `use … as` / `type` rebinding of any of
/// these, anywhere in production, fails closed.
fn guarded_names() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = TERMINAL_NAMES.to_vec();
    v.extend(CHAIN_LINKS.iter().map(|(f, _)| *f));
    v
}

pub fn check(src_dir: &Path) {
    let krate = load_crate(src_dir);
    // Fail closed on any alias that could rebind a guarded terminal OR chain-fn name.
    krate.reject_guarded_aliases();
    check_bind(&krate);
    check_bootstrap(&krate);
    check_finalize(&krate);
    // Seal every intermediate composition fn of the chain (driven by CHAIN_LINKS, the same
    // list guarded against aliases): each must be exactly one direct call in its expected
    // caller — a function-value / import-or-type alias / loop / closure / macro second path
    // is red even though the terminal only appears once.
    for (link_fn, caller) in CHAIN_LINKS {
        assert_single_sealed_occurrence(
            &krate,
            RefKind::NamedFn(link_fn),
            "chain",
            link_fn,
            caller,
        );
    }
}

// --- source loading (production module graph, cfg-test dropped) --------------

pub fn load_crate(src_dir: &Path) -> Crate {
    let mut files = Vec::new();
    for entry in ["lib.rs", "main.rs"] {
        let path = src_dir.join(entry);
        if path.exists() {
            load_file(&path, &mut files);
        }
    }
    Crate { files }
}

fn is_cfg_test(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        if !attr.path().is_ident("cfg") {
            return false;
        }
        let mut hit = false;
        let _ = attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("test") {
                hit = true;
            }
            Ok(())
        });
        hit
    })
}

fn load_file(path: &Path, out: &mut Vec<(String, syn::File)>) {
    println!("cargo:rerun-if-changed={}", path.display());
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let mut file: syn::File =
        syn::parse_file(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
    // Drop cfg-test items at the top level.
    file.items.retain(|item| {
        let attrs: &[syn::Attribute] = match item {
            Item::Fn(f) => &f.attrs,
            Item::Mod(m) => &m.attrs,
            Item::Impl(i) => &i.attrs,
            Item::Const(c) => &c.attrs,
            Item::Static(s) => &s.attrs,
            Item::Use(u) => &u.attrs,
            _ => return true,
        };
        !is_cfg_test(attrs)
    });
    // Discover out-of-line child modules — including those declared inside INLINE modules
    // (`mod outer { mod child; }`), whose child files would otherwise never enter the graph.
    let mut children: Vec<PathBuf> = Vec::new();
    discover_out_of_line_children(&file.items, &child_dir(path), &mut children);
    let rel = repo_relative(path);
    out.push((rel, file));
    for child in children {
        load_file(&child, out);
    }
}

/// Walk items (recursing into inline modules) and collect the file paths of every
/// out-of-line `mod name;` declaration, skipping `#[cfg(test)]` modules. `base` is the
/// directory that out-of-line children in the CURRENT item scope resolve against — for an
/// inline `mod outer { .. }` the base for its children is `base/outer/`.
fn discover_out_of_line_children(items: &[Item], base: &Path, out: &mut Vec<PathBuf>) {
    for item in items {
        let Item::Mod(m) = item else { continue };
        if is_cfg_test(&m.attrs) {
            continue;
        }
        let name = m.ident.to_string();
        match &m.content {
            Some((_, inner)) => {
                // inline module: its out-of-line children resolve under base/<name>/.
                let explicit = mod_path_attr(&m.attrs);
                let inner_base = match explicit {
                    Some(p) => base.join(p),
                    None => base.join(&name),
                };
                discover_out_of_line_children(inner, &inner_base, out);
            }
            None => {
                let explicit = mod_path_attr(&m.attrs);
                let candidates = if let Some(p) = explicit {
                    vec![base.join(p)]
                } else {
                    vec![
                        base.join(format!("{name}.rs")),
                        base.join(&name).join("mod.rs"),
                    ]
                };
                if let Some(found) = candidates.into_iter().find(|c| c.exists()) {
                    out.push(found);
                }
            }
        }
    }
}

/// Extract a `#[path = "..."]` attribute value if present.
fn mod_path_attr(attrs: &[syn::Attribute]) -> Option<PathBuf> {
    attrs.iter().find_map(|a| {
        if !a.path().is_ident("path") {
            return None;
        }
        if let syn::Meta::NameValue(nv) = &a.meta
            && let Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Str(s),
                ..
            }) = &nv.value
        {
            return Some(PathBuf::from(s.value()));
        }
        None
    })
}

fn child_dir(path: &Path) -> PathBuf {
    let name = path.file_name().and_then(|n| n.to_str());
    if matches!(name, Some("mod.rs") | Some("lib.rs") | Some("main.rs")) {
        path.parent().unwrap().to_path_buf()
    } else {
        path.with_extension("")
    }
}

/// A stable diagnostic path: everything from `crates/` onward, else the file name.
fn repo_relative(path: &Path) -> String {
    let s = path.to_string_lossy();
    match s.find("crates/") {
        Some(i) => s[i..].to_string(),
        None => path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| s.into_owned()),
    }
}

// --- guarded name alias rejection --------------------------------

impl Crate {
    fn reject_guarded_aliases(&self) {
        let guarded = guarded_names();
        struct AliasScan<'a> {
            path: &'a str,
            guarded: &'a [&'static str],
            violations: Vec<String>,
        }
        impl<'ast, 'a> Visit<'ast> for AliasScan<'a> {
            fn visit_item_use(&mut self, node: &'ast syn::ItemUse) {
                let mut renames = Vec::new();
                collect_use_renames(&node.tree, &mut renames);
                for (original, alias) in renames {
                    // A rebinding `use … X as Y` (Y != X) of a guarded name is a second
                    // spelling for the same chain link/terminal. An identity `use … X` (no
                    // rename) is a consumer reaching the one owner and is fine.
                    if self.guarded.contains(&original.as_str()) && alias != original {
                        self.violations.push(format!(
                            "{}: `use … {original} as {alias}` rebinds a guarded name",
                            self.path
                        ));
                    }
                }
                visit::visit_item_use(self, node);
            }
            fn visit_item_type(&mut self, node: &'ast syn::ItemType) {
                // `type Alias = Path::To::Guarded;` — if the RHS terminal is guarded, the
                // alias is a second spelling.
                if let syn::Type::Path(tp) = &*node.ty
                    && let Some(seg) = tp.path.segments.last()
                    && self.guarded.contains(&seg.ident.to_string().as_str())
                {
                    self.violations.push(format!(
                        "{}: `type {} = … {}` aliases a guarded name",
                        self.path, node.ident, seg.ident
                    ));
                }
                visit::visit_item_type(self, node);
            }
        }
        let mut all = Vec::new();
        for (path, file) in &self.files {
            let mut scan = AliasScan {
                path,
                guarded: &guarded,
                violations: Vec::new(),
            };
            scan.visit_file(file);
            all.extend(scan.violations);
        }
        assert!(
            all.is_empty(),
            "composition: guarded-name alias(es) present — a door could be reached under a \
             different spelling (fail closed): {all:#?}"
        );
    }
}

fn collect_use_renames(tree: &syn::UseTree, out: &mut Vec<(String, String)>) {
    match tree {
        syn::UseTree::Path(p) => collect_use_renames(&p.tree, out),
        syn::UseTree::Name(n) => {
            let id = n.ident.to_string();
            out.push((id.clone(), id));
        }
        syn::UseTree::Rename(r) => {
            out.push((r.ident.to_string(), r.rename.to_string()));
        }
        syn::UseTree::Glob(_) => {}
        syn::UseTree::Group(g) => {
            for t in &g.items {
                collect_use_renames(t, out);
            }
        }
    }
}

// --- reference collection with ancestry (fail-closed) ------------------------

/// One occurrence of a guarded reference, with the enclosing fn and a rejection reason if
/// its ancestry is not a plain direct call.
#[derive(Debug)]
struct Occurrence {
    function: String,
    path: String,
    line: usize,
    rejected: Option<String>,
}

/// Walks every production item, tracking the enclosing fn and whether the current position
/// is inside a loop / closure / nested fn / unresolved macro — any of which makes a guarded
/// occurrence non-direct and therefore a fail-closed violation.
struct RefWalker<'a> {
    file_path: &'a str,
    kind: RefKind,
    fn_stack: Vec<String>,
    in_loop: usize,
    in_closure: usize,
    nested_fn_depth: usize,
    occurrences: Vec<Occurrence>,
}

#[derive(Clone, Copy, PartialEq)]
enum RefKind {
    /// A `TcpListener::bind(...)` path-call.
    TcpListenerBind,
    /// Any reference to `write_bootstrap_token_file` (call or function value).
    BootstrapWrite,
    /// Any reference to a plain intermediate composition function by its terminal name
    /// (e.g. `bind_and_prepare`) — a direct call is the one legitimate form; a
    /// function-value / aliased use, or a call inside loop/closure/nested-fn/unresolvable
    /// macro, is a fail-closed bypass of the sealed call-chain.
    NamedFn(&'static str),
}

impl<'a> RefWalker<'a> {
    fn context_reject(&self) -> Option<String> {
        if self.nested_fn_depth > 0 {
            Some("inside a nested fn".into())
        } else if self.in_closure > 0 {
            Some("inside a closure".into())
        } else if self.in_loop > 0 {
            Some("inside a loop".into())
        } else {
            None
        }
    }
    fn record(&mut self, span_line: usize) {
        let function = self
            .fn_stack
            .last()
            .cloned()
            .unwrap_or_else(|| "<item>".into());
        let rejected = self.context_reject();
        self.occurrences.push(Occurrence {
            function,
            path: self.file_path.to_owned(),
            line: span_line,
            rejected,
        });
    }
}

impl<'ast, 'a> Visit<'ast> for RefWalker<'a> {
    fn visit_item_fn(&mut self, f: &'ast syn::ItemFn) {
        self.fn_stack.push(f.sig.ident.to_string());
        visit::visit_item_fn(self, f);
        self.fn_stack.pop();
    }
    fn visit_impl_item_fn(&mut self, f: &'ast syn::ImplItemFn) {
        // an impl method is a second entry surface; track it as a function context.
        self.fn_stack.push(f.sig.ident.to_string());
        visit::visit_impl_item_fn(self, f);
        self.fn_stack.pop();
    }
    fn visit_expr_closure(&mut self, c: &'ast syn::ExprClosure) {
        self.in_closure += 1;
        visit::visit_expr_closure(self, c);
        self.in_closure -= 1;
    }
    fn visit_expr_for_loop(&mut self, l: &'ast syn::ExprForLoop) {
        self.in_loop += 1;
        visit::visit_expr_for_loop(self, l);
        self.in_loop -= 1;
    }
    fn visit_expr_while(&mut self, l: &'ast syn::ExprWhile) {
        self.in_loop += 1;
        visit::visit_expr_while(self, l);
        self.in_loop -= 1;
    }
    fn visit_expr_loop(&mut self, l: &'ast syn::ExprLoop) {
        self.in_loop += 1;
        visit::visit_expr_loop(self, l);
        self.in_loop -= 1;
    }
    fn visit_item_mod(&mut self, m: &'ast syn::ItemMod) {
        // inline modules are walked; a nested item fn inside is still production surface.
        visit::visit_item_mod(self, m);
    }
    fn visit_expr_call(&mut self, node: &'ast syn::ExprCall) {
        if self.kind == RefKind::TcpListenerBind
            && let Expr::Path(p) = &*node.func
        {
            let segs: Vec<String> = p
                .path
                .segments
                .iter()
                .map(|s| s.ident.to_string())
                .collect();
            if segs.len() >= 2
                && segs[segs.len() - 2] == "TcpListener"
                && segs[segs.len() - 1] == "bind"
            {
                let line = node.span().start().line;
                self.record(line);
            }
        }
        if self.kind == RefKind::BootstrapWrite
            && let Expr::Path(p) = &*node.func
            && p.path
                .segments
                .last()
                .is_some_and(|s| s.ident == "write_bootstrap_token_file")
        {
            // This is the LEGITIMATE direct call. Record it, then visit only the arguments
            // (NOT the callee path) so `visit_expr_path` below does not double-count the
            // callee — leaving `visit_expr_path` to catch only function-VALUE uses.
            let line = node.span().start().line;
            self.record(line);
            for arg in &node.args {
                self.visit_expr(arg);
            }
            return;
        }
        if let RefKind::NamedFn(name) = self.kind
            && let Expr::Path(p) = &*node.func
            && p.path.segments.last().is_some_and(|s| s.ident == name)
        {
            // legitimate direct call: record, then visit only args so the callee path is
            // not double-counted by visit_expr_path (which catches function-value uses).
            let line = node.span().start().line;
            self.record(line);
            for arg in &node.args {
                self.visit_expr(arg);
            }
            return;
        }
        visit::visit_expr_call(self, node);
    }
    fn visit_expr_path(&mut self, node: &'ast syn::ExprPath) {
        // A guarded name used as a path expression that is NOT the direct callee of a call
        // is a function-VALUE bypass vector (the callee case returned early above).
        let guarded_value = match self.kind {
            RefKind::BootstrapWrite => Some("write_bootstrap_token_file"),
            RefKind::NamedFn(name) => Some(name),
            RefKind::TcpListenerBind => None,
        };
        if let Some(name) = guarded_value
            && node.path.segments.last().is_some_and(|s| s.ident == name)
        {
            let function = self
                .fn_stack
                .last()
                .cloned()
                .unwrap_or_else(|| "<item>".into());
            self.occurrences.push(Occurrence {
                function,
                path: self.file_path.to_owned(),
                line: node.span().start().line,
                rejected: Some("used as a function value, not a direct call".into()),
            });
        }
        visit::visit_expr_path(self, node);
    }
    fn visit_macro(&mut self, node: &'ast Macro) {
        // Try to parse the macro tokens as an expression (or comma-list); if it does not
        // parse, a guarded call could hide inside — fail closed by recording a rejected
        // pseudo-occurrence ONLY if the raw tokens name the guarded terminal.
        match macro_exprs(node) {
            Some(exprs) => {
                for e in exprs {
                    self.visit_expr(&e);
                }
            }
            None => {
                let raw = node.tokens.to_string();
                let names = match self.kind {
                    RefKind::TcpListenerBind => raw.contains("TcpListener") && raw.contains("bind"),
                    RefKind::BootstrapWrite => raw.contains("write_bootstrap_token_file"),
                    RefKind::NamedFn(name) => raw.contains(name),
                };
                if names {
                    let line = node.span().start().line;
                    self.occurrences.push(Occurrence {
                        function: self
                            .fn_stack
                            .last()
                            .cloned()
                            .unwrap_or_else(|| "<item>".into()),
                        path: self.file_path.to_owned(),
                        line,
                        rejected: Some("inside an unresolvable macro".into()),
                    });
                }
            }
        }
        visit::visit_macro(self, node);
    }
}

/// Parse a macro's tokens as an expression or comma-separated expressions; `None` if it
/// does not parse (an unresolvable macro).
fn macro_exprs(mac: &Macro) -> Option<Vec<Expr>> {
    let tokens = mac.tokens.clone();
    if let Ok(expr) = syn::parse2::<Expr>(tokens.clone()) {
        return Some(vec![expr]);
    }
    if let Ok(list) = syn::parse2::<CommaExprs>(tokens) {
        return Some(list.0);
    }
    None
}

struct CommaExprs(Vec<Expr>);
impl syn::parse::Parse for CommaExprs {
    fn parse(input: syn::parse::ParseStream) -> syn::Result<Self> {
        let punct = syn::punctuated::Punctuated::<Expr, syn::Token![,]>::parse_terminated(input)?;
        Ok(CommaExprs(punct.into_iter().collect()))
    }
}

fn occurrences(krate: &Crate, kind: RefKind) -> Vec<Occurrence> {
    let mut all = Vec::new();
    for (path, file) in &krate.files {
        let mut w = RefWalker {
            file_path: path,
            kind,
            fn_stack: Vec::new(),
            in_loop: 0,
            in_closure: 0,
            nested_fn_depth: 0,
            occurrences: Vec::new(),
        };
        w.visit_file(file);
        all.extend(w.occurrences);
    }
    all
}

// --- the three doors ---------------------------------------------------------

/// Assert a guarded reference kind has EXACTLY ONE occurrence, in the expected enclosing
/// function, and that no occurrence is rejected (function-value / loop / closure /
/// nested-fn / unresolvable macro). This seals a link of a call-chain: the terminal, the
/// intermediate fn, and its caller are each checked with the same rule.
fn assert_single_sealed_occurrence(
    krate: &Crate,
    kind: RefKind,
    door: &str,
    what: &str,
    expected_fn: &str,
) {
    let occ = occurrences(krate, kind);
    for o in &occ {
        assert!(
            o.rejected.is_none(),
            "composition[{door}]: `{what}` at {}:{} in `{}` is {} — not a plain direct call \
             (the call-chain is sealed against function-value/alias/loop/closure/macro bypass)",
            o.path,
            o.line,
            o.function,
            o.rejected.as_deref().unwrap()
        );
    }
    assert!(
        occ.len() == 1,
        "composition[{door}]: expected exactly one production `{what}`, found {}: {:#?}",
        occ.len(),
        occ
    );
    assert!(
        occ[0].function == expected_fn,
        "composition[{door}]: `{what}` must be a direct callee of `{expected_fn}`, found in \
         `{}` at {}:{}",
        occ[0].function,
        occ[0].path,
        occ[0].line
    );
}

fn check_bind(krate: &Crate) {
    // Terminal: one TcpListener::bind, direct callee of bind_and_prepare.
    assert_single_sealed_occurrence(
        krate,
        RefKind::TcpListenerBind,
        "bind",
        "TcpListener::bind",
        "bind_and_prepare",
    );
    // Intermediate link: bind_and_prepare called exactly once, sealed, by `run`. Using the
    // NamedFn kind seals `bind_and_prepare` itself against a function-value/alias second
    // path (e.g. `let second = bind_and_prepare; second(config).await`).
    assert_single_sealed_occurrence(
        krate,
        RefKind::NamedFn("bind_and_prepare"),
        "bind",
        "bind_and_prepare",
        "run",
    );
}

fn check_bootstrap(krate: &Crate) {
    assert_single_sealed_occurrence(
        krate,
        RefKind::BootstrapWrite,
        "bootstrap",
        "write_bootstrap_token_file",
        "prepare_for_bound_listener_observed",
    );
}

fn check_finalize(krate: &Crate) {
    struct C<'a> {
        path: &'a str,
        fn_stack: Vec<String>,
        in_loop: usize,
        in_closure: usize,
        owners: Vec<(String, String, usize, Option<String>)>,
        router_new: usize,
    }
    impl<'ast, 'a> Visit<'ast> for C<'a> {
        fn visit_item_fn(&mut self, f: &'ast syn::ItemFn) {
            self.fn_stack.push(f.sig.ident.to_string());
            visit::visit_item_fn(self, f);
            self.fn_stack.pop();
        }
        fn visit_impl_item_fn(&mut self, f: &'ast syn::ImplItemFn) {
            self.fn_stack.push(f.sig.ident.to_string());
            visit::visit_impl_item_fn(self, f);
            self.fn_stack.pop();
        }
        fn visit_expr_closure(&mut self, c: &'ast syn::ExprClosure) {
            self.in_closure += 1;
            visit::visit_expr_closure(self, c);
            self.in_closure -= 1;
        }
        fn visit_expr_for_loop(&mut self, l: &'ast syn::ExprForLoop) {
            self.in_loop += 1;
            visit::visit_expr_for_loop(self, l);
            self.in_loop -= 1;
        }
        fn visit_expr_while(&mut self, l: &'ast syn::ExprWhile) {
            self.in_loop += 1;
            visit::visit_expr_while(self, l);
            self.in_loop -= 1;
        }
        fn visit_expr_loop(&mut self, l: &'ast syn::ExprLoop) {
            self.in_loop += 1;
            visit::visit_expr_loop(self, l);
            self.in_loop -= 1;
        }
        fn visit_expr_struct(&mut self, node: &'ast syn::ExprStruct) {
            if node
                .path
                .segments
                .last()
                .is_some_and(|s| s.ident == "PreparedApp")
            {
                let f = self
                    .fn_stack
                    .last()
                    .cloned()
                    .unwrap_or_else(|| "<item>".into());
                let rejected = if self.in_closure > 0 {
                    Some("inside a closure".to_owned())
                } else if self.in_loop > 0 {
                    Some("inside a loop".to_owned())
                } else {
                    None
                };
                self.owners
                    .push((f, self.path.to_owned(), node.span().start().line, rejected));
                self.router_new += RouterNewCounter::count_in_struct_fields(node);
            }
            visit::visit_expr_struct(self, node);
        }
        fn visit_macro(&mut self, node: &'ast Macro) {
            if let Some(exprs) = macro_exprs(node) {
                for e in exprs {
                    self.visit_expr(&e);
                }
            } else {
                // An unresolvable macro naming PreparedApp/Router could hide a second
                // finalize path — fail closed.
                let raw = node.tokens.to_string();
                if raw.contains("PreparedApp") || raw.contains("Router") {
                    let f = self
                        .fn_stack
                        .last()
                        .cloned()
                        .unwrap_or_else(|| "<item>".into());
                    self.owners.push((
                        f,
                        self.path.to_owned(),
                        node.span().start().line,
                        Some("inside an unresolvable macro".to_owned()),
                    ));
                }
            }
            visit::visit_macro(self, node);
        }
    }
    let mut c = C {
        path: "",
        fn_stack: Vec::new(),
        in_loop: 0,
        in_closure: 0,
        owners: Vec::new(),
        router_new: 0,
    };
    for (path, file) in &krate.files {
        c.path = path;
        c.visit_file(file);
    }
    for o in &c.owners {
        assert!(
            o.3.is_none(),
            "composition[finalize]: a `PreparedApp` construction at {}:{} in `{}` is {} — not a \
             plain direct construction",
            o.1,
            o.2,
            o.0,
            o.3.as_deref().unwrap()
        );
    }
    assert!(
        c.owners.len() == 1,
        "composition[finalize]: expected exactly one production `PreparedApp {{ .. }}` literal, \
         found {}: {:#?}",
        c.owners.len(),
        c.owners
    );
    assert!(
        c.owners[0].0 == "prepare_for_bound_listener_observed",
        "composition[finalize]: the `PreparedApp` literal must sit in \
         `prepare_for_bound_listener_observed`, found in `{}` at {}:{}",
        c.owners[0].0,
        c.owners[0].1,
        c.owners[0].2
    );
    assert!(
        c.router_new == 1,
        "composition[finalize]: expected exactly one root `Router::new` inside the `PreparedApp` \
         literal, found {}",
        c.router_new
    );
}

struct RouterNewCounter {
    count: usize,
}
impl RouterNewCounter {
    fn count_in_struct_fields(node: &syn::ExprStruct) -> usize {
        let mut rn = RouterNewCounter { count: 0 };
        for field in &node.fields {
            rn.visit_expr(&field.expr);
        }
        if let Some(rest) = &node.rest {
            rn.visit_expr(rest);
        }
        rn.count
    }
}
impl<'ast> Visit<'ast> for RouterNewCounter {
    fn visit_expr_call(&mut self, node: &'ast syn::ExprCall) {
        if let Expr::Path(p) = &*node.func {
            let segs: Vec<String> = p
                .path
                .segments
                .iter()
                .map(|s| s.ident.to_string())
                .collect();
            if segs.len() >= 2 && segs[segs.len() - 2] == "Router" && segs[segs.len() - 1] == "new"
            {
                self.count += 1;
            }
        }
        visit::visit_expr_call(self, node);
    }
    fn visit_macro(&mut self, node: &'ast Macro) {
        if let Some(exprs) = macro_exprs(node) {
            for e in exprs {
                self.visit_expr(&e);
            }
        }
        visit::visit_macro(self, node);
    }
}
