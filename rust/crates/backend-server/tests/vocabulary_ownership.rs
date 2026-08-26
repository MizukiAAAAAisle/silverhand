//! One authority per closed vocabulary, held over the whole workspace source tree.
//!
//! A closed set has one owner or it has none: the moment a second module declares the
//! same type name, the two can disagree, and the disagreement surfaces as a wire value
//! one half accepts and the other refuses. That is the defect this file exists to keep
//! out — the workspace shipped both a `RuntimeKind` re-listed as a string match in a
//! persistence adapter and two same-named `NotificationId` types on two public paths,
//! and neither was visible to any compiler check.
//!
//! Deliberately source driven rather than type driven: what has to be proven is that a
//! SECOND declaration does not exist, and a type-level test can only speak about the
//! definitions it already names.
//!
//! Read through a real Rust parser, because the property is a property of the
//! declaration grammar and nothing less recognises that grammar. A hand-written scanner
//! answered "no declaration" for `struct r#NotificationId`, whose semantic name IS
//! `NotificationId`, and it could only ever search the item kinds it had been told to
//! search, so `pub type NotificationId = String;` and `pub struct RuntimeKind(String);`
//! were second authorities invisible to it. Every one of those spellings is legal and
//! `cargo fmt --check` clean, and answering each with one more special case just moves
//! the same false green one notch along — a second, permanently incomplete parser.
//!
//! `syn` is therefore a dev-dependency of this crate. It parses text: `#[cfg]` is not
//! evaluated, so a gated duplicate still counts, which is what ownership requires.
//! What a parser cannot see through is macro expansion, so token trees the walk skips
//! are checked for the watched name and reported as an unprovable declaration rather
//! than passed over.

use std::{
    fs,
    path::{Path, PathBuf},
};

use syn::{Item, ext::IdentExt};

fn rust_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("rust workspace root")
}

/// Every `.rs` file under every crate's `src`, as (workspace-relative path, source).
///
/// `src` and not `tests`: a fixture may legitimately name whatever tokens it drives,
/// while production code may not hold a second copy of the set.
fn production_sources() -> Vec<(String, String)> {
    let root = rust_root();
    let mut sources = Vec::new();
    let crates = fs::read_dir(root.join("crates")).expect("crates directory");
    for entry in crates {
        let source_dir = entry.expect("crate entry").path().join("src");
        if source_dir.is_dir() {
            collect(&root, &source_dir, &mut sources);
        }
    }
    assert!(
        sources.len() > 50,
        "the walk found only {} files, so it is not reading the tree",
        sources.len()
    );
    sources.sort();
    sources
}

fn collect(root: &Path, directory: &Path, sources: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(directory).expect("source directory") {
        let path = entry.expect("source entry").path();
        if path.is_dir() {
            collect(root, &path, sources);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            let relative = path
                .strip_prefix(root)
                .expect("a source under the workspace root")
                .to_string_lossy()
                .into_owned();
            sources.push((relative, fs::read_to_string(&path).expect("source file")));
        }
    }
}

/// Reported in place of an item keyword when the name appears inside token trees the
/// parser hands over unexpanded. Ownership cannot be proven there, and an unprovable
/// declaration must read as a failure, never as an absence.
const UNEXPANDED: &str = "macro tokens";

/// Reported for a source that is not a module at all — an `include!` fragment holding an
/// expression — when the watched name appears in it anyway.
///
/// A fragment that does not parse as items cannot be included at item position either, so
/// it binds no module-level name; the name check is what makes that reasoning observable
/// instead of a skip, and `the_only_sources_that_are_not_modules_are_named` pins which
/// files take this path so a parser that failed on a REAL module cannot hide here.
const UNPARSED: &str = "unparsed fragment";

/// Every module-level declaration of the type name `name` in `source`, as the keyword
/// that declared it.
///
/// The type namespace, not one item kind: `struct`, `enum`, `type`, `union`, `trait` and
/// `trait` aliases all bind a name that a use site can reach, so any of them can be the
/// second authority. Names are compared unrawed, because `r#NotificationId` and
/// `NotificationId` are the same name to the compiler.
///
/// Inline `mod` blocks are walked recursively — `mod foo;` needs no recursion, since the
/// file it names is walked in its own right.
///
/// Two positions are deliberately NOT declarations here: an item inside a function body
/// is reachable by no path, so it cannot sit between two halves of a seam, and an
/// associated type is `<Store as Repo>::Name` rather than a name in a module.
fn declarations_in(source: &str, name: &str) -> Vec<&'static str> {
    let Ok(parsed) = syn::parse_file(source) else {
        return if names(source, name) {
            vec![UNPARSED]
        } else {
            Vec::new()
        };
    };
    let contents = contents_of(&parsed.items);
    let mut declared: Vec<&'static str> = contents
        .declared
        .iter()
        .filter(|(declared, _)| declared == name)
        .map(|(_, kind)| *kind)
        .collect();
    if contents
        .unexpandable
        .iter()
        .any(|tokens| names(tokens, name))
    {
        declared.push(UNEXPANDED);
    }
    declared
}

/// What a module holds, before any question about a particular name is asked.
#[derive(Default)]
struct Contents {
    /// Unrawed type name and the keyword that bound it.
    declared: Vec<(String, &'static str)>,
    /// Token text no parser can expand: `macro_rules!` rules, and syntax syn hands back
    /// verbatim.
    unexpandable: Vec<String>,
    /// Names of the `macro_rules!` definitions here, whose rules are in `unexpandable`.
    defined: Vec<String>,
    /// Paths of macros invoked at item position, whose expansions this walk cannot see.
    invoked: Vec<String>,
}

fn contents_of(items: &[Item]) -> Contents {
    let mut contents = Contents::default();
    walk(items, &mut contents);
    contents
}

fn walk(items: &[Item], contents: &mut Contents) {
    for item in items {
        let (kind, ident) = match item {
            Item::Struct(declaration) => ("struct", &declaration.ident),
            Item::Enum(declaration) => ("enum", &declaration.ident),
            Item::Type(declaration) => ("type", &declaration.ident),
            Item::Union(declaration) => ("union", &declaration.ident),
            Item::Trait(declaration) => ("trait", &declaration.ident),
            Item::TraitAlias(declaration) => ("trait alias", &declaration.ident),
            Item::Mod(module) => {
                if let Some((_, nested)) = &module.content {
                    walk(nested, contents);
                }
                continue;
            }
            // Both halves of a macro have to be answered, and they are answered
            // differently. A `macro_rules!` DEFINITION (`ident` is its name) carries rules
            // no parser expands, so its tokens are checked for the watched name and its
            // name is recorded — that is how an invocation elsewhere can be shown to feed
            // rules this tree reads. An INVOCATION only feeds arguments to such a body, so
            // `opaque_id!(NotificationId)` declares nothing; reading arguments as
            // declarations would report the owner's own file as a duplicate.
            Item::Macro(macro_item) => {
                match &macro_item.ident {
                    Some(name) => {
                        contents.defined.push(name.unraw().to_string());
                        contents
                            .unexpandable
                            .push(macro_item.mac.tokens.to_string());
                    }
                    None => contents.invoked.push(path_of(&macro_item.mac.path)),
                }
                continue;
            }
            Item::Verbatim(tokens) => {
                contents.unexpandable.push(tokens.to_string());
                continue;
            }
            _ => continue,
        };
        contents.declared.push((ident.unraw().to_string(), kind));
    }
}

fn path_of(path: &syn::Path) -> String {
    path.segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

/// Whether `tokens` holds `name` as a whole identifier.
///
/// Only ever applied to unexpanded token trees, where the conservative direction is to
/// over-report: a macro that merely mentions the name fails this gate and has to be
/// answered, which is the opposite of a declaration hiding inside one. Token text, so a
/// raw identifier arrives as `r#Name` and the `#` ends the identifier before it.
fn names(tokens: &str, name: &str) -> bool {
    tokens.match_indices(name).any(|(at, _)| {
        !tokens[..at]
            .chars()
            .next_back()
            .is_some_and(continues_identifier)
            && !tokens[at + name.len()..]
                .chars()
                .next()
                .is_some_and(continues_identifier)
    })
}

fn continues_identifier(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

/// Where the type name `name` is declared across the production tree, as
/// (file, item keyword) so a failure names both the duplicate and the kind it took.
fn declarations_of(name: &str) -> Vec<(String, &'static str)> {
    production_sources()
        .into_iter()
        .flat_map(|(path, source)| {
            declarations_in(&source, name)
                .into_iter()
                .map(move |kind| (path.clone(), kind))
        })
        .collect()
}

/// The six spellings the runtime vocabulary carries on the wire.
const RUNTIME_TOKENS: [&str; 6] = ["claude", "codex", "cursor", "gemini", "qoder", "opencode"];

/// Whether this source knows the WHOLE runtime set — the shape a second authority
/// takes, whether it is written as a match, an array or a list of constants.
///
/// Naming one or two tokens is not that shape: a decode test and a seeded fixture
/// both do it legitimately, and forbidding it would say nothing about ownership.
///
/// Raw text, unlike the declaration reader: this predicate is ABOUT quoted literals, so
/// the tree it wants is the one the file was written with. A prose list of all six in a
/// comment would be reported, which is the harmless direction — a name to answer, not a
/// second authority admitted.
fn names_the_whole_runtime_set(source: &str) -> bool {
    RUNTIME_TOKENS
        .iter()
        .all(|token| source.contains(&format!("\"{token}\"")))
}

#[test]
fn the_runtime_closed_set_has_exactly_one_owner() {
    // Control, both directions, so a predicate that answered "no" to everything
    // cannot pass this gate silently.
    assert!(names_the_whole_runtime_set(
        "match raw { \"claude\" | \"codex\" | \"cursor\" | \"gemini\" | \"qoder\" | \"opencode\" => () }"
    ));
    assert!(!names_the_whole_runtime_set(
        "\"claude\" and \"codex\" only"
    ));

    const OWNER: &str = "crates/backend-core/src/agents/runtime.rs";
    assert_eq!(
        declarations_of("RuntimeKind"),
        vec![(OWNER.to_owned(), "enum")],
        "the runtime closed set must be declared exactly once, as the enum in the agents \
         facade: any other declaration of that name is a second domain for the same column"
    );

    let second_authorities: Vec<String> = production_sources()
        .into_iter()
        .filter(|(path, source)| path != OWNER && names_the_whole_runtime_set(source))
        .map(|(path, _)| path)
        .collect();
    assert!(
        second_authorities.is_empty(),
        "{second_authorities:?} restate the whole runtime set: a closed vocabulary spelled \
         out twice can disagree with its owner, and the disagreement reaches the wire"
    );
}

/// Two same-named identity types are worse than two different ones: each half stays
/// internally consistent, so nothing fails, and the seam between them is paid for with
/// a `String` round trip that accepts values neither half would mint.
///
/// The reader's own controls are one test down.
#[test]
fn the_notification_identity_has_exactly_one_declaration() {
    assert_eq!(
        declarations_of("NotificationId"),
        vec![(
            "crates/backend-core/src/messaging/identity.rs".to_owned(),
            "struct"
        )],
        "the notification identity must be declared once, where it is minted"
    );
}

/// What the reader must recognise as a declaration of a watched name, and what it must
/// not. An inventory is only as good as its reader: one blind to a legal spelling
/// reports "exactly one declaration" while a second one sits in the tree, and the
/// mutation that should have caught it passes.
///
/// Every row expecting a declaration is a spelling rustfmt leaves alone, so each is a
/// way for a second authority to enter a tree that is `cargo fmt --check` clean. The
/// rows carrying the property are the ones a text scanner cannot answer: a raw
/// identifier, whose semantic name has no `r#` in it, and the item kinds other than the
/// one a search string happens to name.
#[test]
fn the_declaration_reader_follows_rust_declaration_grammar() {
    let cases: [(&str, &str, &[&str], &str); 19] = [
        (
            "pub struct NotificationId(String);",
            "NotificationId",
            &["struct"],
            "the plain declaration",
        ),
        (
            "pub struct r#NotificationId(String);",
            "NotificationId",
            &["struct"],
            "a raw identifier declares the unrawed name: to the compiler this IS \
             NotificationId, while text carrying `r#` matches no search string",
        ),
        (
            "pub enum r#RuntimeKind {\n    Claude,\n}",
            "RuntimeKind",
            &["enum"],
            "the same for the runtime set",
        ),
        (
            "pub type NotificationId = String;",
            "NotificationId",
            &["type"],
            "an alias binds the same name in the same namespace, so it is a second \
             authority even though no `struct` keyword appears",
        ),
        (
            "pub struct RuntimeKind(String);",
            "RuntimeKind",
            &["struct"],
            "and a struct can restate a name the owner holds as an enum, which is \
             exactly how a closed set is reopened",
        ),
        (
            "pub union RuntimeKind {\n    tag: u8,\n}",
            "RuntimeKind",
            &["union"],
            "unions are in the type namespace too",
        ),
        (
            "pub trait NotificationId {}",
            "NotificationId",
            &["trait"],
            "so are traits",
        ),
        (
            "pub mod inner {\n    pub mod deeper {\n        pub struct NotificationId(String);\n    }\n}",
            "NotificationId",
            &["struct"],
            "inline modules are walked recursively, or a duplicate hides one brace deep",
        ),
        (
            "pub /* gap */ struct NotificationId(String);",
            "NotificationId",
            &["struct"],
            "trivia between visibility and item is not the parser's problem at all",
        ),
        (
            "#[cfg(test)]\npub struct NotificationId(String);",
            "NotificationId",
            &["struct"],
            "cfg is not evaluated, and must not be: a gated duplicate can still \
             disagree with the owner",
        ),
        (
            "macro_rules! shorthand {\n    () => {\n        pub struct NotificationId(String);\n    };\n}",
            "NotificationId",
            &[UNEXPANDED],
            "no parser sees through expansion, so a macro naming a watched type is \
             reported as unprovable rather than silently absent",
        ),
        (
            "opaque_id!(NotificationId);",
            "NotificationId",
            &[],
            "an invocation only feeds arguments to a body read in its own right: the \
             owner's own file invokes exactly this, and counting arguments would report \
             the owner as its own duplicate",
        ),
        (
            "pub struct NotificationIdentity(String);",
            "NotificationId",
            &[],
            "a longer name is a different name: identifiers are compared, not substrings",
        ),
        (
            "/* outer /* inner */ pub struct NotificationId(String); */",
            "NotificationId",
            &[],
            "nested comments close by depth in the grammar, so the tail of an outer \
             comment is not code",
        ),
        (
            "const SAMPLE: &str = r#\"pub struct NotificationId(String);\"#;",
            "NotificationId",
            &[],
            "a raw string literal declares nothing, whatever its body spells",
        ),
        (
            "fn build() {\n    pub struct NotificationId(String);\n}",
            "NotificationId",
            &[],
            "a body-local item is reachable by no path, so it cannot be the far side \
             of a seam",
        ),
        (
            "impl Repo for Store {\n    type NotificationId = String;\n}",
            "NotificationId",
            &[],
            "an associated type is <Store as Repo>::NotificationId, not a name bound \
             in a module",
        ),
        (
            "&[Case {\n    name: \"once_terminal\",\n}]",
            "NotificationId",
            &[],
            "an include! fragment holds an expression, not items, and this one names \
             nothing watched",
        ),
        (
            "&[Case {\n    name: \"NotificationId\",\n}]",
            "NotificationId",
            &[UNPARSED],
            "the same fragment naming a watched type is reported rather than skipped: \
             a source the reader cannot parse must never read as an absence",
        ),
    ];

    for (source, name, expected, reason) in cases {
        assert_eq!(
            declarations_in(source, name),
            expected,
            "{reason}\n{source}"
        );
    }
}

/// Which production sources the reader cannot parse as modules, pinned by name.
///
/// A parse failure is handled conservatively one function up, but "conservatively" is
/// only true while the failures are the two generated `include!` fragments: if a real
/// module ever stopped parsing — new syntax, an older parser — it would take the same
/// path with far more to hide. Pinning the set turns that into a red gate and a name to
/// answer instead of a silent narrowing.
#[test]
fn the_only_sources_that_are_not_modules_are_named() {
    let fragments: Vec<String> = production_sources()
        .into_iter()
        .filter(|(_, source)| syn::parse_file(source).is_err())
        .map(|(path, _)| path)
        .collect();
    assert_eq!(
        fragments,
        vec![
            "crates/backend-core/src/messaging/schedule/recurrence_ts_fixture.rs".to_owned(),
            "crates/backend-core/src/messaging/schedule/settlement_ts_fixture.rs".to_owned(),
        ],
        "these sources are read by identifier rather than by declaration, so the set \
         has to stay the two TS-signed expression fixtures"
    );
}

/// The names this file holds to one owner each.
const WATCHED: [&str; 2] = ["NotificationId", "RuntimeKind"];

/// Nothing at item position may bind a type name this inventory cannot read.
///
/// Expansion is the one thing a parser cannot follow, so each item-position macro has to
/// be answered. A macro whose `macro_rules!` lives in this tree is answered already: its
/// rules are scanned as unexpandable tokens wherever they are defined. `include!` is the
/// exception, and it has two targets — a path under `src`, which this walk reads as a
/// source in its own right, and build-script output, which is generated rather than
/// written. The second target is closed here rather than described: a build script that
/// never names a watched type cannot emit a declaration of one.
#[test]
fn nothing_at_item_position_hides_declarations_from_this_inventory() {
    let mut invoked = Vec::new();
    let mut defined = Vec::new();
    for (_, source) in production_sources() {
        if let Ok(parsed) = syn::parse_file(&source) {
            let contents = contents_of(&parsed.items);
            invoked.extend(contents.invoked);
            defined.extend(contents.defined);
        }
    }
    let mut unreadable: Vec<String> = invoked
        .into_iter()
        .filter(|invocation| !defined.contains(invocation))
        .collect();
    unreadable.sort();
    unreadable.dedup();
    assert_eq!(
        unreadable,
        vec!["include".to_owned()],
        "a macro invoked at item position whose rules are not in this tree can expand \
         into a declaration nothing here reads"
    );

    let generators: Vec<String> = fs::read_dir(rust_root().join("crates"))
        .expect("crates directory")
        .filter_map(|entry| {
            let script = entry.expect("crate entry").path().join("build.rs");
            let source = fs::read_to_string(&script).ok()?;
            WATCHED
                .iter()
                .any(|name| names(&source, name))
                .then(|| script.to_string_lossy().into_owned())
        })
        .collect();
    assert!(
        generators.is_empty(),
        "{generators:?} name a watched type, so what they generate into OUT_DIR and \
         include! at item position could declare it out of this inventory's reach"
    );
}
