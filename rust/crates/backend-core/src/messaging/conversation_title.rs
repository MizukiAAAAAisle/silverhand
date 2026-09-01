//! The single driver-free authority for conversation titles and name characters.
//!
//! A stored conversation address is a pair: the display title and the pinned
//! Unicode case-fold key derived from that exact title. Keeping both fields
//! private makes it impossible for persistence adapters to pair one title with
//! another title's key.
//!
//! ```
//! use silverhand_backend_core::messaging::conversation_title::CanonicalConversationTitle;
//!
//! let title = CanonicalConversationTitle::parse("  Design Review  ").unwrap();
//! assert_eq!(title.title(), "Design Review");
//! assert_eq!(title.key(), "design review");
//! ```
//!
//! ```compile_fail
//! use silverhand_backend_core::messaging::conversation_title::CanonicalConversationTitle;
//!
//! let _forged = CanonicalConversationTitle {
//!     title: "General".to_owned(),
//!     key: "another-title".to_owned(),
//! };
//! ```

use thiserror::Error;

use crate::foundation::name_canonicalization::{NameCanonicalizationIssue, canonicalize_name};

// The shared Unicode capability — NFC, the ECMAScript trim set, the forbidden
// code-point domain, and the pinned case fold — lives in
// [`crate::foundation::name_canonicalization`], the ONE table/normalizer/fold in the backend.
// These primitives are re-exported here so every sibling that has always resolved
// them through `messaging::conversation_title` keeps working unchanged; the
// implementation is not owned here, only surfaced under this historical path.
pub use crate::foundation::name_canonicalization::{
    fold_name_key, is_space_separator, name_character_is_forbidden, name_is_nfc,
};

/// A canonical display title and the uniqueness key derived from it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalConversationTitle {
    title: String,
    key: String,
}

impl CanonicalConversationTitle {
    /// Runs the shared base name envelope (NFC, ECMAScript trim, empty check, the
    /// 128-code-point cap, the forbidden-scalar scan, and the pinned fold) and
    /// brands the neutral result as a conversation title. A conversation title IS
    /// the full base envelope — it applies no narrower cap — so it simply brands
    /// the neutral verdict.
    pub fn parse(raw: &str) -> Result<Self, ConversationTitleIssue> {
        let canonical = canonicalize_name(raw)?;
        let (title, key) = canonical.into_parts();
        Ok(Self { title, key })
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn key(&self) -> &str {
        &self.key
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ConversationTitleIssue {
    #[error("conversation title is empty")]
    Empty,
    #[error("conversation title contains {code_points} code points; the maximum is 128")]
    TooLong { code_points: usize },
    #[error("conversation title contains forbidden code point U+{code_point:04X} at index {index}")]
    ForbiddenCodePoint { code_point: u32, index: usize },
}

impl From<NameCanonicalizationIssue> for ConversationTitleIssue {
    fn from(issue: NameCanonicalizationIssue) -> Self {
        match issue {
            NameCanonicalizationIssue::Empty => Self::Empty,
            NameCanonicalizationIssue::TooLong { code_points } => Self::TooLong { code_points },
            NameCanonicalizationIssue::ForbiddenCodePoint { code_point, index } => {
                Self::ForbiddenCodePoint { code_point, index }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CanonicalConversationTitle, ConversationTitleIssue, fold_name_key,
        name_character_is_forbidden, name_is_nfc,
    };
    use unicode_normalization::UnicodeNormalization;

    #[test]
    fn canonicalizes_with_exact_ecmascript_trim_and_pinned_fold() {
        let value = CanonicalConversationTitle::parse("\u{FEFF}Straße\u{3000}").unwrap();
        assert_eq!(value.title(), "Straße");
        assert_eq!(value.key(), "strasse");

        assert_eq!(
            CanonicalConversationTitle::parse("\u{0085}title"),
            Err(ConversationTitleIssue::ForbiddenCodePoint {
                code_point: 0x85,
                index: 0,
            })
        );
    }

    #[test]
    fn measures_the_normalized_title_in_code_points() {
        let decomposed = format!("{}{}", "🚀".repeat(127), "A\u{030A}");
        let accepted = CanonicalConversationTitle::parse(&decomposed).unwrap();
        assert_eq!(accepted.title().chars().count(), 128);
        assert!(accepted.title().ends_with('Å'));

        assert_eq!(
            CanonicalConversationTitle::parse(&"🚀".repeat(129)),
            Err(ConversationTitleIssue::TooLong { code_points: 129 })
        );
    }

    #[test]
    fn rejects_every_pinned_sequence_forming_representative() {
        for (input, point, index) in [
            ("👨\u{200D}👩", 0x200D, 1),
            ("❤\u{FE0F}", 0xFE0F, 1),
            ("1\u{20E3}", 0x20E3, 1),
            ("👍\u{1F3FB}", 0x1F3FB, 1),
            ("\u{1F1E8}\u{1F1F3}", 0x1F1E8, 0),
        ] {
            assert_eq!(
                CanonicalConversationTitle::parse(input),
                Err(ConversationTitleIssue::ForbiddenCodePoint {
                    code_point: point,
                    index,
                })
            );
        }
    }

    #[test]
    fn pinned_case_fold_matches_the_typescript_authority_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/shared/tests/fixtures/unicode-case-fold.json"
        ))
        .unwrap();
        assert_eq!(fixture["unicodeVersion"], "16.0.0");
        for (from, to) in fixture["mappings"].as_object().unwrap() {
            let input = char::from_u32(u32::from_str_radix(from, 16).unwrap())
                .unwrap()
                .to_string();
            let expected: String = to
                .as_str()
                .unwrap()
                .split_whitespace()
                .map(|point| char::from_u32(u32::from_str_radix(point, 16).unwrap()).unwrap())
                .collect();
            assert_eq!(
                fold_name_key(&input),
                expected.nfc().collect::<String>(),
                "U+{from}"
            );
        }
    }

    #[test]
    fn parser_matches_the_typescript_production_authority_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/shared/tests/fixtures/conversation-title-parity.json"
        ))
        .unwrap();
        for test_case in fixture["cases"].as_array().unwrap() {
            let name = test_case["name"].as_str().unwrap();
            let input = test_case["input"].as_str().unwrap();
            let expected = &test_case["expected"];
            match CanonicalConversationTitle::parse(input) {
                Ok(actual) => {
                    assert_eq!(expected["ok"], true, "{name}");
                    assert_eq!(expected["title"], actual.title(), "{name}");
                    assert_eq!(expected["key"], actual.key(), "{name}");
                }
                Err(ConversationTitleIssue::Empty) => {
                    assert_eq!(expected["ok"], false, "{name}");
                    assert_eq!(expected["kind"], "empty", "{name}");
                }
                Err(ConversationTitleIssue::TooLong { code_points }) => {
                    assert_eq!(expected["ok"], false, "{name}");
                    assert_eq!(expected["kind"], "too_long", "{name}");
                    assert_eq!(expected["codePoints"], code_points, "{name}");
                }
                Err(ConversationTitleIssue::ForbiddenCodePoint { code_point, index }) => {
                    assert_eq!(expected["ok"], false, "{name}");
                    assert_eq!(expected["kind"], "forbidden_code_point", "{name}");
                    assert_eq!(expected["codePoint"], code_point, "{name}");
                    assert_eq!(expected["index"], index, "{name}");
                }
            }
        }

        for point in fixture["trimCodePoints"].as_array().unwrap() {
            let point = point.as_u64().unwrap() as u32;
            let whitespace = char::from_u32(point).unwrap();
            for input in [format!("{whitespace}title"), format!("title{whitespace}")] {
                let actual = CanonicalConversationTitle::parse(&input).unwrap();
                assert_eq!(actual.title(), "title", "U+{point:04X}");
                assert_eq!(actual.key(), "title", "U+{point:04X}");
            }
        }

        for point in fixture["nonTrimCodePoints"].as_array().unwrap() {
            let point = point.as_u64().unwrap() as u32;
            let nonmember = char::from_u32(point).unwrap();
            for (input, index) in [
                (format!("{nonmember}title"), 0),
                (format!("title{nonmember}"), 5),
            ] {
                assert_eq!(
                    CanonicalConversationTitle::parse(&input),
                    Err(ConversationTitleIssue::ForbiddenCodePoint {
                        code_point: point,
                        index,
                    }),
                    "U+{point:04X}"
                );
            }
        }

        let astral = &fixture["astralBoundary"];
        let scalar = char::from_u32(astral["codePoint"].as_u64().unwrap() as u32).unwrap();
        let accepted = astral["accepted"].as_u64().unwrap() as usize;
        let refused = astral["refused"].as_u64().unwrap() as usize;
        let actual =
            CanonicalConversationTitle::parse(&scalar.to_string().repeat(accepted)).unwrap();
        assert_eq!(actual.title().chars().count(), accepted);
        assert_eq!(
            CanonicalConversationTitle::parse(&scalar.to_string().repeat(refused)),
            Err(ConversationTitleIssue::TooLong {
                code_points: refused,
            })
        );
    }

    #[test]
    fn generated_character_domain_contains_the_expected_boundaries() {
        assert!(!name_character_is_forbidden('🚀'));
        assert!(!name_character_is_forbidden('#'));
        assert!(name_character_is_forbidden('\u{200D}'));
        assert!(name_character_is_forbidden('\u{FE0F}'));
        assert!(name_character_is_forbidden('\u{1F3FB}'));
        assert!(name_is_nfc("Å"));
        assert!(!name_is_nfc("A\u{030A}"));
    }
}
