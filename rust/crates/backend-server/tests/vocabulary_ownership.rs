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
//!
//! Reading source text means the reader must be trivia-independent. Rust lets comments
//! sit anywhere between two tokens, and rustfmt leaves them there, so a predicate that
//! matches raw text answers "no declaration" for a declaration that is really present
//! and a second definition enters the tree with `cargo fmt --check` clean. Everything
//! here therefore matches against the token stream produced by `without_trivia`.

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

/// Whether `source` declares `item`, e.g. `enum RuntimeKind` or `struct NotificationId`.
///
/// Visibility-INDEPENDENT and trivia-INDEPENDENT: `pub`, `pub(crate)`, `pub(super)`,
/// `pub(in crate::x)`, no visibility at all, an attribute above, a line break or a
/// comment in between are all legal ways to define a second copy of a type, so keying
/// on one spelling would let the others through as a false green. What remains after
/// `without_trivia` is a token stream in which every one of those spellings reads the
/// same.
///
/// The match must fall on identifier boundaries at both ends, so a longer name that
/// merely starts the same way (`NotificationIdentity`) is a different declaration, and
/// the `struct` of some other item cannot be glued to this name.
fn declares(source: &str, item: &str) -> bool {
    let tokens = without_trivia(source);
    tokens.match_indices(item).any(|(at, _)| {
        let before = tokens[..at].chars().next_back();
        let after = tokens[at + item.len()..].chars().next();
        before.is_none_or(|character| !continues_identifier(character))
            && after.is_none_or(|character| !continues_identifier(character))
    })
}

/// The source's tokens, with every comment and every literal replaced by a single space
/// and every whitespace run collapsed to one space.
///
/// Replaced by a space rather than deleted, so two tokens on either side of the removed
/// text can never fuse into a third one.
///
/// Three things the walk has to get right; each one skipped is a hole of its own:
/// - block comments NEST, so their close is found by depth and never by the first `*/`,
///   which would leave the tail of an outer comment reading as code;
/// - a literal body may hold `/*` or a quote of its own, so literals are consumed as
///   literals instead of being scanned for comment openers — a raw string is closed only
///   by a quote followed by its own number of hashes;
/// - `'` opens a char literal only when a single character or an escape closes it, and
///   otherwise begins a lifetime, where consuming to the next `'` would swallow every
///   token in between.
fn without_trivia(source: &str) -> String {
    let characters: Vec<char> = source.chars().collect();
    let mut tokens = String::with_capacity(source.len());
    let mut index = 0;
    while index < characters.len() {
        if let Some(resume) = end_of_trivia(&characters, index) {
            push_gap(&mut tokens);
            index = resume;
        } else if characters[index].is_whitespace() {
            push_gap(&mut tokens);
            index += 1;
        } else {
            tokens.push(characters[index]);
            index += 1;
        }
    }
    tokens
}

fn push_gap(tokens: &mut String) {
    if !tokens.ends_with(' ') && !tokens.is_empty() {
        tokens.push(' ');
    }
}

/// The index just past the comment or literal starting at `index`, or `None` when what
/// starts there is an ordinary token character.
fn end_of_trivia(characters: &[char], index: usize) -> Option<usize> {
    match (characters[index], characters.get(index + 1)) {
        ('/', Some('/')) => {
            let mut end = index + 2;
            while end < characters.len() && characters[end] != '\n' {
                end += 1;
            }
            Some(end)
        }
        ('/', Some('*')) => Some(end_of_block_comment(characters, index)),
        ('"', _) => Some(end_of_quoted(characters, index + 1, '"')),
        ('\'', _) if opens_char_literal(characters, index) => {
            Some(end_of_quoted(characters, index + 1, '\''))
        }
        _ => end_of_raw_string(characters, index),
    }
}

/// The index just past the block comment opening at `index`, counting depth.
///
/// `/* outer /* inner */ still commented */` is one comment: a reader that stopped at
/// the first `*/` would hand back `still commented */` as code, and a declaration parked
/// in an outer comment would count.
fn end_of_block_comment(characters: &[char], index: usize) -> usize {
    let mut depth = 0usize;
    let mut cursor = index;
    while cursor < characters.len() {
        if characters[cursor] == '/' && characters.get(cursor + 1) == Some(&'*') {
            depth += 1;
            cursor += 2;
        } else if characters[cursor] == '*' && characters.get(cursor + 1) == Some(&'/') {
            depth -= 1;
            cursor += 2;
            if depth == 0 {
                return cursor;
            }
        } else {
            cursor += 1;
        }
    }
    characters.len()
}

/// The index just past a `"…"` or `'…'` body that starts at `start`, honouring escapes.
fn end_of_quoted(characters: &[char], start: usize, terminator: char) -> usize {
    let mut cursor = start;
    while cursor < characters.len() {
        if characters[cursor] == '\\' {
            cursor += 2;
        } else if characters[cursor] == terminator {
            return cursor + 1;
        } else {
            cursor += 1;
        }
    }
    characters.len()
}

/// Whether the `'` at `index` opens a char literal rather than a lifetime.
fn opens_char_literal(characters: &[char], index: usize) -> bool {
    match characters.get(index + 1) {
        Some('\\') => true,
        Some(_) => characters.get(index + 2) == Some(&'\''),
        None => false,
    }
}

/// The index just past the raw string starting at `index`, or `None` when none does.
///
/// `r"…"`, `r#"…"#`, `br##"…"##`: the body is verbatim, so nothing but a quote followed
/// by the same number of hashes closes it, and a quote inside the body is content.
/// Recognised only where a token can start, so the `r` inside an identifier cannot open
/// one.
fn end_of_raw_string(characters: &[char], index: usize) -> Option<usize> {
    if index > 0 && continues_identifier(characters[index - 1]) {
        return None;
    }
    let mut cursor = index;
    if characters.get(cursor) == Some(&'b') {
        cursor += 1;
    }
    if characters.get(cursor) != Some(&'r') {
        return None;
    }
    cursor += 1;
    let hashes = characters[cursor..]
        .iter()
        .take_while(|character| **character == '#')
        .count();
    cursor += hashes;
    if characters.get(cursor) != Some(&'"') {
        return None;
    }
    cursor += 1;
    while cursor < characters.len() {
        if characters[cursor] == '"'
            && characters[cursor + 1..]
                .iter()
                .take(hashes)
                .filter(|character| **character == '#')
                .count()
                == hashes
        {
            return Some(cursor + 1 + hashes);
        }
        cursor += 1;
    }
    Some(characters.len())
}

fn continues_identifier(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

/// The files whose source declares `item`, e.g. `enum RuntimeKind`.
fn definitions_of(item: &str) -> Vec<String> {
    production_sources()
        .into_iter()
        .filter(|(_, source)| declares(source, item))
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
///
/// Reads the RAW source, and must keep doing so: this predicate is ABOUT quoted
/// literals, while `without_trivia` replaces every literal with a space, so a token
/// stream would answer "no" for every file in the tree — a false green over the whole
/// sweep rather than a single missed file.
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

/// What the reader must RECOGNISE, and what it must not, with the reason each case is
/// in the table. A definition inventory is only as good as its reader: one blind to a
/// legal spelling reports "exactly one definition" while a second one sits in the tree,
/// and the mutation that should have caught it passes.
///
/// Every `declares == true` row below is a spelling rustfmt leaves alone, so each is a
/// way for a second definition to enter a tree that is `cargo fmt --check` clean.
#[test]
fn the_declaration_reader_is_visibility_and_trivia_independent() {
    const ITEM: &str = "struct NotificationId";
    let cases: [(&str, bool, &str); 17] = [
        ("struct NotificationId(String);", true, "no visibility"),
        ("pub struct NotificationId(String);", true, "bare pub"),
        (
            "pub(crate) struct NotificationId(String);",
            true,
            "restricted visibility",
        ),
        (
            "pub(super) struct NotificationId(String);",
            true,
            "parent visibility",
        ),
        (
            "pub(in crate::messaging) struct NotificationId(String);",
            true,
            "path visibility",
        ),
        (
            "    pub(super) struct NotificationId(String);",
            true,
            "indented",
        ),
        (
            "pub /* gap */ struct NotificationId(String);",
            true,
            "a comment between visibility and item still declares the type",
        ),
        (
            "pub(crate) /* outer /* inner */ tail */ struct NotificationId(String);",
            true,
            "a nested comment between visibility and item likewise",
        ),
        (
            "pub /* gap\n    across lines */ struct NotificationId(String);",
            true,
            "the gap may span lines, so no line-local reader can see this one",
        ),
        (
            "#[derive(Debug)]\npub struct NotificationId(String);",
            true,
            "an attribute above the declaration",
        ),
        (
            "fn borrow<'x>(_: &str) {}\npub struct NotificationId(String);",
            true,
            "a lifetime is not a char literal: consuming to the next quote would \
             swallow the declaration behind it",
        ),
        (
            "const QUOTE: char = '\"';\npub struct NotificationId(String);",
            true,
            "a quote inside a char literal must not open a string and swallow the \
             declaration behind it",
        ),
        (
            "pub struct NotificationIdentity(String);",
            false,
            "a longer name is a different declaration",
        ),
        (
            "/// pub struct NotificationId(String);",
            false,
            "a doc comment declares nothing",
        ),
        (
            "/* outer /* inner */ pub struct NotificationId(String); */",
            false,
            "still inside the outer comment: a reader that stopped at the first close \
             would read this as code",
        ),
        (
            "let sample = \"pub struct NotificationId(String);\";",
            false,
            "a string literal declares nothing",
        ),
        (
            r##"let sample = r#"a " pub struct NotificationId(String);"#;"##,
            false,
            "a quote inside a raw string is content, not the close of the literal",
        ),
    ];

    for (source, expected, reason) in cases {
        assert_eq!(
            declares(source, ITEM),
            expected,
            "{reason}\n{source}\ntokens: {}",
            without_trivia(source)
        );
    }
}

/// Two same-named identity types are worse than two different ones: each half stays
/// internally consistent, so nothing fails, and the seam between them is paid for with
/// a `String` round trip that accepts values neither half would mint.
///
/// The reader's own controls are one test up.
#[test]
fn the_notification_identity_has_exactly_one_definition() {
    assert_eq!(
        definitions_of("struct NotificationId"),
        vec!["crates/backend-core/src/messaging/identity.rs".to_owned()],
        "the notification identity must be defined once, where it is minted"
    );
}
