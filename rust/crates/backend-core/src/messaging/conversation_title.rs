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
use unicode_normalization::UnicodeNormalization;

const MAX_CODE_POINTS: usize = 128;

mod pinned_unicode {
    include!(concat!(env!("OUT_DIR"), "/name_charset.rs"));
}

/// A canonical display title and the uniqueness key derived from it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalConversationTitle {
    title: String,
    key: String,
}

impl CanonicalConversationTitle {
    /// NFC-normalizes, ECMAScript-trims, validates, and derives the pinned key.
    pub fn parse(raw: &str) -> Result<Self, ConversationTitleIssue> {
        let normalized: String = raw.nfc().collect();
        let title = normalized
            .trim_matches(is_ecmascript_trim_whitespace)
            .to_owned();
        let code_points = title.chars().count();
        if code_points == 0 {
            return Err(ConversationTitleIssue::Empty);
        }
        if code_points > MAX_CODE_POINTS {
            return Err(ConversationTitleIssue::TooLong { code_points });
        }
        if let Some((index, character)) = title
            .chars()
            .enumerate()
            .find(|(_, character)| name_character_is_forbidden(*character))
        {
            return Err(ConversationTitleIssue::ForbiddenCodePoint {
                code_point: character as u32,
                index,
            });
        }
        let key = fold_name_key(&title);
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

/// The pinned Unicode 16 full case fold followed by NFC.
///
/// This is public for sibling persistence adapters that resolve already-
/// canonical name/address segments. It is the same primitive used by
/// [`CanonicalConversationTitle::parse`], not a second canonicalizer.
pub fn fold_name_key(raw: &str) -> String {
    let mut folded = String::with_capacity(raw.len());
    for character in raw.chars() {
        if let Ok(index) =
            pinned_unicode::CASE_FOLD.binary_search_by_key(&character, |(key, _)| *key)
        {
            folded.push_str(pinned_unicode::CASE_FOLD[index].1);
        } else {
            folded.push(character);
        }
    }
    folded.nfc().collect()
}

/// Whether a persisted/display name is already in NFC.
///
/// Address decoders use this check without importing a second normalization
/// engine or owning a parallel canonicalization rule.
pub fn name_is_nfc(raw: &str) -> bool {
    raw.nfc().eq(raw.chars())
}

/// Whether a code point is outside the pinned human-visible name domain or is a
/// sequence-forming emoji part.
pub fn name_character_is_forbidden(character: char) -> bool {
    let point = character as u32;
    !in_ranges(pinned_unicode::NAME_RENDERABLE_RANGES, point)
        || in_ranges(pinned_unicode::NAME_DEFAULT_IGNORABLE_RANGES, point)
        || in_ranges(pinned_unicode::NAME_ENCLOSING_MARK_RANGES, point)
        || in_ranges(pinned_unicode::NAME_EMOJI_MODIFIER_RANGES, point)
        || in_ranges(pinned_unicode::NAME_REGIONAL_INDICATOR_RANGES, point)
}

/// The pinned `Zs` set used by the canonical address-segment codec.
pub fn is_space_separator(character: char) -> bool {
    matches!(
        character,
        '\u{20}' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
    )
}

fn in_ranges(ranges: &[(u32, u32)], point: u32) -> bool {
    ranges
        .binary_search_by(|(first, last)| {
            if point < *first {
                std::cmp::Ordering::Greater
            } else if point > *last {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

// ECMA-262 WhiteSpace + LineTerminator. This deliberately differs from Rust's
// Unicode White_Space: FEFF is included and U+0085 is excluded.
fn is_ecmascript_trim_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}' | '\u{000B}' | '\u{000C}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
                | '\u{000A}'
                | '\u{000D}'
    )
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
