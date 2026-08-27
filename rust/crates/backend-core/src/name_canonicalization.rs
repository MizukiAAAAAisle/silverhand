//! The driver-free, DOMAIN-NEUTRAL name-canonicalization primitive shared by every
//! bounded context that mints a human-visible name and the uniqueness key it folds
//! to — conversation titles, regular-workspace names, and any future sibling.
//!
//! There is exactly ONE pinned Unicode 16 table and ONE normalizer/fold in the
//! backend, and it lives here. This module BRANDS nothing: [`canonicalize_name`]
//! returns a neutral [`CanonicalName`] and a neutral [`NameCanonicalizationIssue`],
//! never a conversation-title or workspace-name value. Each domain wraps the neutral
//! result in its own value type and applies its OWN length cap, so no domain's
//! legality, error vocabulary, or key mint is defined in another domain's language.
//! The shared thing is the Unicode capability (NFC, the ECMAScript trim set, the
//! forbidden code-point domain, the pinned case fold); the cap and the brand are the
//! consumer's.
//!
//! ## The pipeline order is the shared contract; the cap is the caller's
//!
//! [`canonicalize_name`] runs NFC → ECMAScript-trim → reject-empty →
//! reject-over-`max_code_points` → reject-forbidden → fold, in THAT order. The
//! length cap is checked BEFORE the forbidden scan, so a name that is both over the
//! cap and carries a forbidden scalar reports its length, not the interior scalar.
//! That ordering is a property every consumer inherits identically; only the
//! `max_code_points` value differs per domain (128 for a conversation title, 64 for
//! a workspace name).

use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

mod pinned_unicode {
    include!(concat!(env!("OUT_DIR"), "/name_charset.rs"));
}

/// A canonicalized display form and the uniqueness key derived from that exact
/// display, produced by [`canonicalize_name`].
///
/// Neutral and un-branded. The fields are private so a caller cannot pair one
/// name's display with another name's key; a consumer reads
/// [`display`](Self::display) / [`key`](Self::key) or takes both together with
/// [`into_parts`](Self::into_parts) to build its own branded value type.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalName {
    display: String,
    key: String,
}

impl CanonicalName {
    /// The NFC + ECMAScript-trimmed display form.
    pub fn display(&self) -> &str {
        &self.display
    }

    /// The pinned Unicode case-fold uniqueness key derived from the display.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Take the display and key together, so a domain value type is built from the
    /// pair the primitive produced and never from two separately sourced strings.
    pub fn into_parts(self) -> (String, String) {
        (self.display, self.key)
    }
}

/// Why a candidate name is not canonical. Neutral: a consumer maps this into its
/// own domain issue (adding, e.g., a domain-specific `too_long` message). The
/// `TooLong` arm reports both the measured count and the cap that refused it so the
/// neutral message is self-describing; a consumer forwarding only the count may
/// drop `max_code_points`.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum NameCanonicalizationIssue {
    #[error("name is empty after trimming")]
    Empty,
    #[error("name contains {code_points} code points; the maximum is {max_code_points}")]
    TooLong {
        code_points: usize,
        max_code_points: usize,
    },
    #[error("name contains forbidden code point U+{code_point:04X} at index {index}")]
    ForbiddenCodePoint { code_point: u32, index: usize },
}

/// NFC-normalize, ECMAScript-trim, reject empty, reject over `max_code_points`,
/// reject a forbidden code point, and derive the pinned fold key — in that order.
///
/// The length cap is applied before the forbidden scan (see the module docs). The
/// `max_code_points` bound is supplied by the calling domain; every other step is
/// the shared Unicode contract.
pub fn canonicalize_name(
    raw: &str,
    max_code_points: usize,
) -> Result<CanonicalName, NameCanonicalizationIssue> {
    let normalized: String = raw.nfc().collect();
    let display = normalized
        .trim_matches(is_ecmascript_trim_whitespace)
        .to_owned();
    let code_points = display.chars().count();
    if code_points == 0 {
        return Err(NameCanonicalizationIssue::Empty);
    }
    if code_points > max_code_points {
        return Err(NameCanonicalizationIssue::TooLong {
            code_points,
            max_code_points,
        });
    }
    if let Some((index, character)) = display
        .chars()
        .enumerate()
        .find(|(_, character)| name_character_is_forbidden(*character))
    {
        return Err(NameCanonicalizationIssue::ForbiddenCodePoint {
            code_point: character as u32,
            index,
        });
    }
    let key = fold_name_key(&display);
    Ok(CanonicalName { display, key })
}

/// The pinned Unicode 16 full case fold followed by NFC.
///
/// Public for sibling persistence adapters that resolve already-canonical
/// name/address segments. It is the same primitive [`canonicalize_name`] uses, not
/// a second canonicalizer.
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
/// Address decoders use this check without importing a second normalization engine
/// or owning a parallel canonicalization rule.
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
        CanonicalName, NameCanonicalizationIssue, canonicalize_name, name_character_is_forbidden,
        name_is_nfc,
    };

    #[test]
    fn canonicalizes_with_exact_ecmascript_trim_and_pinned_fold() {
        let value = canonicalize_name("\u{FEFF}Straße\u{3000}", 128).unwrap();
        assert_eq!(value.display(), "Straße");
        assert_eq!(value.key(), "strasse");
    }

    #[test]
    fn empty_after_trimming_is_reported_before_any_cap() {
        assert_eq!(
            canonicalize_name("   \u{3000}\u{FEFF}", 64),
            Err(NameCanonicalizationIssue::Empty)
        );
    }

    #[test]
    fn the_cap_is_the_callers_and_is_checked_before_the_forbidden_scan() {
        // Same input, two caps: accepted under 128, refused under 64 — the cap is a
        // parameter, not a shared constant.
        assert!(canonicalize_name(&"a".repeat(100), 128).is_ok());
        assert_eq!(
            canonicalize_name(&"a".repeat(100), 64),
            Err(NameCanonicalizationIssue::TooLong {
                code_points: 100,
                max_code_points: 64,
            })
        );

        // Over the cap AND carrying a forbidden joiner: the cap wins, because it is
        // checked first. This is the ordering every consumer inherits.
        let mut raw = "a".repeat(100);
        raw.push('\u{200D}');
        assert_eq!(
            canonicalize_name(&raw, 64),
            Err(NameCanonicalizationIssue::TooLong {
                code_points: 101,
                max_code_points: 64,
            })
        );
    }

    #[test]
    fn a_forbidden_scalar_within_the_cap_is_reported_with_its_index() {
        let raw = format!("{}\u{200D}", "a".repeat(10));
        assert_eq!(
            canonicalize_name(&raw, 64),
            Err(NameCanonicalizationIssue::ForbiddenCodePoint {
                code_point: 0x200D,
                index: 10,
            })
        );
    }

    #[test]
    fn into_parts_yields_the_pair_the_primitive_produced() {
        let value: CanonicalName = canonicalize_name("  Design Review  ", 128).unwrap();
        let (display, key) = value.into_parts();
        assert_eq!(display, "Design Review");
        assert_eq!(key, "design review");
    }

    #[test]
    fn the_character_domain_boundaries_are_the_pinned_ones() {
        assert!(!name_character_is_forbidden('🚀'));
        assert!(!name_character_is_forbidden('#'));
        assert!(name_character_is_forbidden('\u{200D}'));
        assert!(name_character_is_forbidden('\u{FE0F}'));
        assert!(name_is_nfc("Å"));
        assert!(!name_is_nfc("A\u{030A}"));
    }
}
