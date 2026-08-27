//! The driver-free authority for a regular workspace's display name and the
//! folded uniqueness key derived from it.
//!
//! A stored regular-workspace name is a pair: the NFC + ECMAScript-trimmed
//! display `name` and the pinned Unicode case-fold `key`. Keeping both fields
//! private makes it impossible for a persistence adapter to pair one name with
//! another name's key.
//!
//! ## The Unicode capability is shared; the cap and the brand are ours
//!
//! The whole Unicode verdict — NFC, the ECMAScript trim set, the forbidden
//! code-point domain, and the pinned case fold — comes from the ONE neutral
//! [`crate::name_canonicalization`] primitive, the single table/normalizer/fold
//! in the backend. There is no second Unicode table and no second canonicalizer.
//! This module consumes that primitive with a 64-code-point cap and brands the
//! result as a [`CanonicalWorkspaceName`], so a workspace name's legality is
//! expressed in the workspace's OWN vocabulary — a consumer never speaks in
//! conversation-title terms, and the shared primitive returns neither a title
//! type nor a title issue.
//!
//! The shared pipeline checks the length cap BEFORE it scans for a forbidden
//! scalar, so a name that is both over 64 code points and carries a forbidden
//! scalar reports its length, not the interior scalar. That ordering is a
//! property of the shared primitive, inherited identically by every consumer;
//! only the 64 bound is this domain's.
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
/// NFC + trimmed display form. Narrower than the shared conversation-title cap.
pub const MAX_CODE_POINTS: usize = 64;

/// A canonical regular-workspace display name and the uniqueness key derived
/// from it. Agent-home workspaces carry a `NULL` name key and never mint one.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalWorkspaceName {
    name: String,
    key: String,
}

impl CanonicalWorkspaceName {
    /// Runs the shared name canonicalization (NFC, ECMAScript trim, empty check,
    /// the 64-code-point cap, the forbidden-scalar scan, and the pinned fold) and
    /// brands the neutral result as a workspace name. The Unicode verdict is the
    /// shared one; only the cap and the vocabulary are this domain's.
    pub fn parse(raw: &str) -> Result<Self, WorkspaceNameIssue> {
        let canonical = canonicalize_name(raw, MAX_CODE_POINTS)?;
        let (name, key) = canonical.into_parts();
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
/// measured code-point count so the boundary is observable; the empty and
/// forbidden arms carry the same shape the shared primitive reports.
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
            NameCanonicalizationIssue::TooLong { code_points, .. } => Self::TooLong { code_points },
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
    fn a_name_far_over_the_cap_reports_the_true_count() {
        assert_eq!(
            CanonicalWorkspaceName::parse(&"a".repeat(200)),
            Err(WorkspaceNameIssue::TooLong { code_points: 200 })
        );
    }

    #[test]
    fn a_forbidden_scalar_within_the_cap_is_reported_with_its_index() {
        // ≤ 64 code points, so the cap passes and the forbidden scan fires.
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
    fn the_cap_is_checked_before_the_forbidden_scan() {
        // 100 code points (> 64) AND a sequence-forming joiner: the shared
        // primitive checks the length cap before the forbidden scan, so the
        // length verdict wins — the same order every consumer inherits. (The
        // conversation-title owner, whose cap is 128, reports the joiner for this
        // same input, because 100 is within ITS cap; the divergence is the cap,
        // not the order.)
        let mut raw = "a".repeat(99);
        raw.push('\u{200D}');
        assert_eq!(
            CanonicalWorkspaceName::parse(&raw),
            Err(WorkspaceNameIssue::TooLong { code_points: 100 })
        );
    }

    #[test]
    fn reuses_the_shared_authority_fixture_recapped_at_sixty_four() {
        // Reconcile against the SAME production fixture the conversation-title
        // owner is pinned to, proving both domains fold on one shared table. Only
        // order-independent arms are asserted against the title verdict; where the
        // 64 cap reorders against the title's 128 cap (a title-legal name in
        // (64,128], or a forbidden scalar past position 64) the workspace verdict
        // is asserted on its own terms.
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
                    // Accepted ⇒ the shared parser accepted it (≤128, no forbidden)
                    // AND it is ≤64; the display and key are the shared ones.
                    assert_eq!(expected["ok"], true, "{name}");
                    assert!(actual.name().chars().count() <= 64, "{name}");
                    assert_eq!(expected["title"], actual.name(), "{name}");
                    assert_eq!(expected["key"], actual.key(), "{name}");
                }
                Err(WorkspaceNameIssue::Empty) => {
                    // Empty precedes the cap in both domains, so the title verdict
                    // agrees.
                    assert_eq!(expected["ok"], false, "{name}");
                    assert_eq!(expected["kind"], "empty", "{name}");
                }
                Err(WorkspaceNameIssue::ForbiddenCodePoint { code_point, index }) => {
                    // Reaching the forbidden scan means ≤64 ≤128, so the wider-cap
                    // title parser scanned too and found the SAME first forbidden
                    // scalar at the same index.
                    assert_eq!(expected["ok"], false, "{name}");
                    assert_eq!(expected["kind"], "forbidden_code_point", "{name}");
                    assert_eq!(expected["codePoint"], code_point, "{name}");
                    assert_eq!(expected["index"], index, "{name}");
                }
                Err(WorkspaceNameIssue::TooLong { code_points }) => {
                    // Over 64. The title verdict for the same input may be ok,
                    // too_long, or forbidden depending on where 128 falls; the only
                    // shared invariant is the measured count exceeds this cap.
                    assert!(code_points > 64, "{name}");
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
