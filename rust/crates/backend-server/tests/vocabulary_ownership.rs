//! One authority per closed vocabulary, held over the whole workspace source tree.
//!
//! A closed set has one owner or it has none: the moment a second module spells the
//! same tokens out, the two can disagree, and the disagreement surfaces as a wire
//! value one half accepts and the other refuses. That is the defect this file exists
//! to keep out — the workspace shipped both a `RuntimeKind` re-listed as a string
//! match in a persistence adapter and two same-named `NotificationId` types on two
//! public paths, and neither was visible to any compiler check.
//!
//! Deliberately source-text driven rather than type driven: what has to be proven is
//! that a SECOND definition does not exist, and a type-level test can only speak
//! about the definitions it already names.

use std::{
    fs,
    path::{Path, PathBuf},
};

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

/// Whether this line declares `item`, e.g. `enum RuntimeKind` or `struct NotificationId`.
///
/// Visibility-INDEPENDENT: `pub`, `pub(crate)`, `pub(super)`, `pub(in crate::x)` and no
/// visibility at all are all legal ways to define a second copy of a type, so keying on
/// one spelling would let the others through as a false green.
///
/// The declaration must START the line (after its indentation and that one visibility
/// token), which is what keeps a doc comment, a `//` comment and a string literal out:
/// each puts its own marker first. The name must then end on something that cannot
/// continue an identifier, so a longer name that merely starts the same way is a
/// different declaration.
fn defines(line: &str, item: &str) -> bool {
    let line = strip_visibility(line.trim_start());
    let Some(rest) = line.strip_prefix(item) else {
        return false;
    };
    !rest.starts_with(|character: char| character.is_alphanumeric() || character == '_')
}

/// One leading Rust visibility, in any of its spellings, or the line unchanged when it
/// carries none.
///
/// `pub` must itself end on a boundary — `(` for a restricted form, whitespace for the
/// bare one — so an identifier that merely begins with those letters (`published`) is
/// not mistaken for a visibility and does not expose the rest of the line to matching.
fn strip_visibility(line: &str) -> &str {
    let Some(rest) = line.strip_prefix("pub") else {
        return line;
    };
    let rest = if rest.starts_with('(') {
        // `pub(crate)`, `pub(super)`, `pub(in crate::path)`: the restriction is one
        // parenthesized group, so the visibility ends at its close.
        match rest.find(')') {
            Some(close) => &rest[close + 1..],
            None => return line,
        }
    } else {
        rest
    };
    if rest.starts_with(|character: char| character.is_alphanumeric() || character == '_') {
        return line;
    }
    rest.trim_start()
}

/// The files whose source defines `item`, e.g. `enum RuntimeKind`.
fn definitions_of(item: &str) -> Vec<String> {
    production_sources()
        .into_iter()
        .filter(|(_, source)| source.lines().any(|line| defines(line, item)))
        .map(|(path, _)| path)
        .collect()
}

/// The six spellings the runtime vocabulary carries on the wire.
const RUNTIME_TOKENS: [&str; 6] = ["claude", "codex", "cursor", "gemini", "qoder", "opencode"];

/// Whether this source knows the WHOLE runtime set — the shape a second authority
/// takes, whether it is written as a match, an array or a list of constants.
///
/// Naming one or two tokens is not that shape: a decode test and a seeded fixture
/// both do it legitimately, and forbidding it would say nothing about ownership.
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
        definitions_of("enum RuntimeKind"),
        vec![OWNER.to_owned()],
        "the runtime closed set must be defined exactly once, in the agents facade"
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

/// Both directions for the declaration predicate itself. A definition inventory is
/// only as good as what it RECOGNISES: a predicate blind to one legal visibility
/// reports "exactly one definition" while a second one sits in the tree, and the
/// mutation that would have caught it passes.
#[test]
fn the_definition_predicate_recognises_every_visibility_and_nothing_else() {
    // Every legal way to declare the type. All five are a second definition if a
    // second file carries one.
    for declaration in [
        "struct NotificationId(String);",
        "pub struct NotificationId(String);",
        "pub(crate) struct NotificationId(String);",
        "pub(super) struct NotificationId(String);",
        "pub(in crate::messaging) struct NotificationId(String);",
        "    pub(super) struct NotificationId(String);",
    ] {
        assert!(
            defines(declaration, "struct NotificationId"),
            "{declaration} declares the type"
        );
    }

    // And what must NOT count: a longer name, either comment form, a string literal,
    // and an identifier that merely begins with `pub`.
    for line in [
        "pub struct NotificationIdentity(String);",
        "/// pub struct NotificationId(String);",
        "// pub struct NotificationId(String);",
        "    let sample = \"pub struct NotificationId(String);\";",
        "published struct NotificationId(String);",
    ] {
        assert!(!defines(line, "struct NotificationId"), "{line} does not");
    }
}

/// Two same-named identity types are worse than two different ones: each half stays
/// internally consistent, so nothing fails, and the seam between them is paid for with
/// a `String` round trip that accepts values neither half would mint.
///
/// The predicate's own controls are one test up.
#[test]
fn the_notification_identity_has_exactly_one_definition() {
    assert_eq!(
        definitions_of("struct NotificationId"),
        vec!["crates/backend-core/src/messaging/identity.rs".to_owned()],
        "the notification identity must be defined once, where it is minted"
    );
}
