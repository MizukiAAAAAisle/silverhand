//! The driver-free authority for a regular workspace's display name and the
//! folded uniqueness key derived from it.
//!
//! A stored regular-workspace name is a pair: the NFC + ECMAScript-trimmed
//! display `name` and the pinned Unicode case-fold `key`. Keeping both fields
//! private makes it impossible for a persistence adapter to pair one name with
//! another name's key.
//!
//! ## Two stages: the shared base envelope, THEN the narrower 64 cap
//!
//! A workspace name is NOT the base envelope with a different cap — it is the full
//! base envelope FOLLOWED BY a 64-code-point cap, exactly as the TypeScript
//! `parseWorkspaceName` runs the whole `parseConversationTitle` (the 128 envelope:
//! NFC, trim, empty, 128 cap, forbidden scan, fold) and only then checks 64.
//!
//! [`CanonicalWorkspaceName::parse`] therefore calls the shared
//! [`crate::name_canonicalization`] primitive first — the ONE table/normalizer/fold
//! in the backend, so there is no second Unicode table and no second canonicalizer —
//! and applies its own 64 cap only to a name that already cleared the envelope. That
//! ordering is load-bearing: it makes the refusal PRECEDENCE match TS byte-for-byte.
//! A name of 65–128 code points carrying a forbidden scalar reports
//! `forbidden_code_point` (the envelope scans forbidden before this cap is ever
//! reached), and a name over 128 with a forbidden scalar reports `too_long` (the
//! envelope's 128 cap fires before its own forbidden scan). Collapsing this into a
//! single 64-capped pipeline would report `too_long` for the first case — a
//! different product contract.
//!
//! This module owns only the 64 cap and the workspace ubiquitous language — a
//! consumer of [`CanonicalWorkspaceName`] never speaks in conversation-title terms,
//! and the shared primitive returns neither a title type nor a title issue.
//!
//! ```
//! use silverhand_backend_core::workspace_name::CanonicalWorkspaceName;
//!
//! let name = CanonicalWorkspaceName::parse("  Straße  ").unwrap();
//! assert_eq!(name.name(), "Straße");
//! assert_eq!(name.key(), "strasse");
//! ```
//!
//! ```compile_fail
//! use silverhand_backend_core::workspace_name::CanonicalWorkspaceName;
//!
//! let _forged = CanonicalWorkspaceName {
//!     name: "Real".to_owned(),
//!     key: "another".to_owned(),
//! };
//! ```

use thiserror::Error;

use crate::name_canonicalization::{NameCanonicalizationIssue, canonicalize_name};

/// The maximum code-point length of a regular workspace name, measured on the
/// NFC + trimmed display form. Narrower than the shared base envelope's cap, and
/// applied only after the envelope has cleared.
pub const MAX_CODE_POINTS: usize = 64;

/// A canonical regular-workspace display name and the uniqueness key derived
/// from it. Agent-home workspaces carry a `NULL` name key and never mint one.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalWorkspaceName {
    name: String,
    key: String,
}

impl CanonicalWorkspaceName {
    /// Runs the shared base name envelope, then applies the narrower 64 cap — in
    /// that order, so the refusal precedence matches the delegated TypeScript
    /// `parseWorkspaceName` byte-for-byte (see the module docs).
    pub fn parse(raw: &str) -> Result<Self, WorkspaceNameIssue> {
        // Stage 1: the full base envelope (128 cap, then forbidden scan, then
        // fold). A refusal here is inherited verbatim, so a forbidden scalar in a
        // 65–128-code-point name is `forbidden_code_point`, not `too_long`.
        let canonical = canonicalize_name(raw)?;
        let (name, key) = canonical.into_parts();
        // Stage 2: only a name that cleared the envelope is measured against the
        // narrower workspace cap.
        let code_points = name.chars().count();
        if code_points > MAX_CODE_POINTS {
            return Err(WorkspaceNameIssue::TooLong { code_points });
        }
        Ok(Self { name, key })
    }

    /// The NFC + trimmed display name, carried verbatim onto the wire.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The pinned Unicode case-fold uniqueness key. Never reaches the wire; used
    /// only for collision detection among regular workspaces.
    pub fn key(&self) -> &str {
        &self.key
    }
}

/// Why a candidate workspace name is not canonical. `too_long` reports the
/// measured code-point count so the boundary is observable; it is raised by the
/// base envelope's 128 cap (over 128) or by the workspace 64 cap (a 65–128
/// envelope-legal name). The empty and forbidden arms carry the base envelope's
/// verdict verbatim.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum WorkspaceNameIssue {
    #[error("workspace name is empty")]
    Empty,
    #[error("workspace name contains {code_points} code points; the maximum is 64")]
    TooLong { code_points: usize },
    #[error("workspace name contains forbidden code point U+{code_point:04X} at index {index}")]
    ForbiddenCodePoint { code_point: u32, index: usize },
}

impl From<NameCanonicalizationIssue> for WorkspaceNameIssue {
    fn from(issue: NameCanonicalizationIssue) -> Self {
        match issue {
            NameCanonicalizationIssue::Empty => Self::Empty,
            // The base envelope's 128 cap; the workspace 64 cap raises its own
            // `TooLong` directly in `parse`.
            NameCanonicalizationIssue::TooLong { code_points } => Self::TooLong { code_points },
            NameCanonicalizationIssue::ForbiddenCodePoint { code_point, index } => {
                Self::ForbiddenCodePoint { code_point, index }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CanonicalWorkspaceName, MAX_CODE_POINTS, WorkspaceNameIssue};

    #[test]
    fn reuses_the_shared_trim_and_fold_and_owns_only_the_cap() {
        let value = CanonicalWorkspaceName::parse("\u{FEFF}Straße\u{3000}").unwrap();
        assert_eq!(value.name(), "Straße");
        assert_eq!(value.key(), "strasse");

        assert_eq!(
            CanonicalWorkspaceName::parse(""),
            Err(WorkspaceNameIssue::Empty)
        );
        assert_eq!(
            CanonicalWorkspaceName::parse("   \u{3000}  "),
            Err(WorkspaceNameIssue::Empty)
        );
    }

    #[test]
    fn caps_the_normalized_name_at_sixty_four_code_points() {
        // A decomposed scalar counts as one code point after NFC.
        let boundary = format!("{}{}", "a".repeat(MAX_CODE_POINTS - 1), "A\u{030A}");
        let accepted = CanonicalWorkspaceName::parse(&boundary).unwrap();
        assert_eq!(accepted.name().chars().count(), MAX_CODE_POINTS);
        assert!(accepted.name().ends_with('Å'));

        assert_eq!(
            CanonicalWorkspaceName::parse(&"a".repeat(MAX_CODE_POINTS + 1)),
            Err(WorkspaceNameIssue::TooLong {
                code_points: MAX_CODE_POINTS + 1
            })
        );
        // Astral scalars are one code point each (Array.from parity).
        assert_eq!(
            CanonicalWorkspaceName::parse(&"🚀".repeat(65)),
            Err(WorkspaceNameIssue::TooLong { code_points: 65 })
        );
        assert_eq!(
            CanonicalWorkspaceName::parse(&"🚀".repeat(64))
                .unwrap()
                .name()
                .chars()
                .count(),
            64
        );
    }

    #[test]
    fn a_clean_name_far_over_the_envelope_reports_the_true_count() {
        assert_eq!(
            CanonicalWorkspaceName::parse(&"a".repeat(200)),
            Err(WorkspaceNameIssue::TooLong { code_points: 200 })
        );
    }

    #[test]
    fn a_forbidden_scalar_within_the_cap_is_reported_with_its_index() {
        // ≤ 64 code points: the envelope's forbidden scan fires.
        let raw = format!("{}\u{200D}", "a".repeat(10));
        assert_eq!(
            CanonicalWorkspaceName::parse(&raw),
            Err(WorkspaceNameIssue::ForbiddenCodePoint {
                code_point: 0x200D,
                index: 10,
            })
        );
    }

    #[test]
    fn a_forbidden_scalar_between_65_and_128_is_forbidden_not_too_long() {
        // 101 code points: past the workspace 64 cap but WITHIN the 128 base
        // envelope. TS runs the full envelope first, so the forbidden scan fires
        // before the 64 cap is ever consulted. This is the regression Cindy caught:
        // it must be `ForbiddenCodePoint`, never `TooLong`.
        let raw = format!("{}\u{200D}", "a".repeat(100));
        assert_eq!(
            CanonicalWorkspaceName::parse(&raw),
            Err(WorkspaceNameIssue::ForbiddenCodePoint {
                code_point: 0x200D,
                index: 100,
            })
        );
    }

    #[test]
    fn beyond_128_with_a_forbidden_scalar_is_too_long() {
        // 201 code points with a forbidden joiner: the envelope's 128 cap fires
        // before its own forbidden scan, so the verdict is `TooLong` — matching TS,
        // where `parseConversationTitle`'s 128 cap short-circuits.
        let raw = format!("{}\u{200D}", "a".repeat(200));
        assert_eq!(
            CanonicalWorkspaceName::parse(&raw),
            Err(WorkspaceNameIssue::TooLong { code_points: 201 })
        );
    }

    #[test]
    fn reuses_the_shared_authority_fixture_recapped_at_sixty_four() {
        // Reconcile against the SAME production fixture the conversation-title owner
        // is pinned to, proving both domains fold on one shared table AND that the
        // two-stage envelope reproduces the title verdict for every arm except a
        // clean name in (64, 128], which the workspace 64 cap recaps to `too_long`.
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/shared/tests/fixtures/conversation-title-parity.json"
        ))
        .unwrap();
        for test_case in fixture["cases"].as_array().unwrap() {
            let name = test_case["name"].as_str().unwrap();
            let input = test_case["input"].as_str().unwrap();
            let expected = &test_case["expected"];
            match CanonicalWorkspaceName::parse(input) {
                Ok(actual) => {
                    // Accepted ⇒ the envelope accepted it (≤128, no forbidden) AND
                    // it is ≤64; the display and key are the shared ones.
                    assert_eq!(expected["ok"], true, "{name}");
                    let cp = actual.name().chars().count();
                    assert!(cp <= 64, "{name}");
                    assert_eq!(expected["title"], actual.name(), "{name}");
                    assert_eq!(expected["key"], actual.key(), "{name}");
                }
                Err(WorkspaceNameIssue::Empty) => {
                    assert_eq!(expected["ok"], false, "{name}");
                    assert_eq!(expected["kind"], "empty", "{name}");
                }
                Err(WorkspaceNameIssue::ForbiddenCodePoint { code_point, index }) => {
                    // The envelope's forbidden scan; the title owner reports the
                    // SAME scalar at the same index, because both inherit the same
                    // 128-envelope scan before any narrower cap.
                    assert_eq!(expected["ok"], false, "{name}");
                    assert_eq!(expected["kind"], "forbidden_code_point", "{name}");
                    assert_eq!(expected["codePoint"], code_point, "{name}");
                    assert_eq!(expected["index"], index, "{name}");
                }
                Err(WorkspaceNameIssue::TooLong { code_points }) => {
                    // Over 64. Either the envelope's 128 cap (the title owner also
                    // says too_long) or the workspace 64 cap on a title-legal name
                    // in (64, 128] (the title owner accepts it). Both exceed 64.
                    assert!(code_points > 64, "{name}");
                    if expected["ok"] == true {
                        assert!(
                            expected["title"].as_str().unwrap().chars().count() > 64,
                            "{name}"
                        );
                    } else {
                        assert_eq!(expected["kind"], "too_long", "{name}");
                    }
                }
            }
        }

        // The astral boundary the fixture pins at 128 for titles is re-verified at
        // 64 for workspace names.
        let astral = &fixture["astralBoundary"];
        let scalar = char::from_u32(astral["codePoint"].as_u64().unwrap() as u32).unwrap();
        assert!(CanonicalWorkspaceName::parse(&scalar.to_string().repeat(64)).is_ok());
        assert_eq!(
            CanonicalWorkspaceName::parse(&scalar.to_string().repeat(65)),
            Err(WorkspaceNameIssue::TooLong { code_points: 65 })
        );
    }
}
