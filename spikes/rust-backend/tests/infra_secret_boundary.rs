//! Item 3 of the infra prototype: two independent negative type boundaries.
//!
//! * **Secret.** The plaintext has no implicit path to an output stream. There is
//!   no `Debug` derive, no `Serialize`, no `Display`, no `Deref`, no `AsRef`, so
//!   "it slipped into a log line" and "it slipped into a response body" are
//!   compile errors. Reading it requires a named accessor.
//! * **Driver containment.** Neither the application layer nor the infra modules
//!   name the database technology.
//!
//! Honest scope: the `Serialize` half is enforced by absence-of-impl plus this
//! source gate, not by a negative trait bound — stable Rust cannot express "this
//! type does not implement `Serialize`". A compile-fail harness would prove it
//! outright; that is deliberately out of scope for this minimal prototype and is
//! recorded as such rather than claimed.

use std::{fs, path::Path};

use silverhand_rust_backend_spike::infra::secret::{REDACTED, Secret};

const SECRET_SOURCE: &str = "src/infra/secret.rs";

#[test]
fn secret_debug_is_redacted_even_when_nested() {
    #[derive(Debug)]
    #[expect(dead_code, reason = "fields are read only through the Debug rendering")]
    struct HostCredentials {
        host_id: &'static str,
        token: Secret<String>,
    }

    let credentials = HostCredentials {
        host_id: "host-1",
        token: Secret::new("live-token-value".to_owned()),
    };

    let rendered = format!("{credentials:?}");

    assert!(rendered.contains("host-1"));
    assert!(rendered.contains(REDACTED));
    assert!(
        !rendered.contains("live-token-value"),
        "secret plaintext reached a Debug rendering: {rendered}"
    );
}

#[test]
fn secret_exposes_plaintext_only_through_the_named_accessor() {
    let secret = Secret::new("value".to_owned());

    assert_eq!(secret.expose(), "value");
    assert_eq!(Secret::new(7_u32).into_inner(), 7);
}

/// Traits whose presence on `Secret<T>` would hand out an implicit capability:
/// printing or serializing the plaintext, copying it by default, or comparing it
/// with ordinary (non-constant-time) equality.
const FORBIDDEN_TRAITS: [&str; 9] = [
    "Debug",
    "Serialize",
    "Deserialize",
    "Clone",
    "Copy",
    "PartialEq",
    "Eq",
    "Display",
    "Deref",
];

/// The negative gate. It must catch the capability however it arrives: a derive
/// in any order or across lines, or a hand-written impl.
#[test]
fn secret_grants_no_implicit_capability_over_the_plaintext() {
    let source = read_crate_file(SECRET_SOURCE);
    // Two exclusions before a source-text gate means anything here: test helpers
    // legitimately derive Debug for structs that *hold* a secret, and the doc
    // comment legitimately names the traits it deliberately omits.
    let production = source
        .split("#[cfg(test)]")
        .next()
        .expect("secret module has a production half");
    let code = collapse_whitespace(&strip_comment_lines(production));

    // (a) No derive may name a forbidden trait, whatever the order or line breaks.
    let derives = derive_lists(&code);
    assert!(
        !derives.is_empty() || !code.contains("#[derive("),
        "derive extraction failed while derives are present"
    );
    for list in &derives {
        for forbidden in FORBIDDEN_TRAITS {
            assert!(
                !names_trait(list, forbidden),
                "{SECRET_SOURCE} derives {forbidden:?} on a secret: #[derive({list})]"
            );
        }
    }

    // (b) No hand-written impl either. `Debug` is the one deliberate exception:
    // it exists precisely so the plaintext cannot be printed.
    for forbidden in FORBIDDEN_TRAITS {
        if forbidden == "Debug" {
            continue;
        }
        let hand_written = format!("{forbidden} for Secret");
        assert!(
            !code.contains(&hand_written),
            "{SECRET_SOURCE} hand-implements {forbidden:?} for Secret"
        );
    }
    assert!(
        !code.contains("AsRef"),
        "{SECRET_SOURCE} exposes the plaintext through AsRef"
    );

    // (c) Attribute macros that would serialize or export the type.
    for forbidden in ["serde", "ts_rs", "TS)]"] {
        assert!(
            !code.contains(forbidden),
            "{SECRET_SOURCE} reintroduces an implicit secret output path: {forbidden:?}"
        );
    }

    for required in [
        "impl<T> fmt::Debug for Secret<T>",
        "pub fn expose",
        REDACTED,
    ] {
        assert!(
            code.contains(required),
            "{SECRET_SOURCE} lost required detail {required:?}"
        );
    }
}

/// The second boundary: the technology name does not appear outside the adapter.
#[test]
fn application_and_infra_modules_name_no_database_technology() {
    const GUARDED: [&str; 4] = [
        "src/application.rs",
        "src/infra/mod.rs",
        "src/infra/error.rs",
        "src/infra/secret.rs",
    ];
    const MARKERS: [&str; 8] = [
        "sqlx",
        "sqlite",
        "pragma",
        "migrate",
        "last_insert_rowid",
        "journal_mode",
        "busy_timeout",
        "crate::adapters",
    ];

    for relative in GUARDED {
        let normalized = read_crate_file(relative).to_ascii_lowercase();
        for marker in MARKERS {
            assert!(
                !normalized.contains(marker),
                "{relative} leaks database technology marker {marker:?}"
            );
        }
    }
}

fn read_crate_file(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
}

/// Prose is not code. A gate that reads comments would flag a doc line for
/// naming the very thing it says is absent.
fn strip_comment_lines(source: &str) -> String {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Makes a multi-line `#[derive(...)]` and a single-line one the same shape, so
/// one pattern covers both.
fn collapse_whitespace(source: &str) -> String {
    source.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The contents of every `#[derive(...)]`, order preserved, delimiters dropped.
fn derive_lists(code: &str) -> Vec<String> {
    code.split("#[derive(")
        .skip(1)
        .filter_map(|rest| rest.split_once(')').map(|(list, _)| list.to_owned()))
        .collect()
}

/// Whether a derive list names this trait as one of its items — tolerating any
/// order, spacing, and a path prefix such as `serde::Serialize`.
fn names_trait(derive_list: &str, trait_name: &str) -> bool {
    derive_list.split(',').any(|item| {
        item.trim()
            .rsplit("::")
            .next()
            .is_some_and(|last| last == trait_name)
    })
}
