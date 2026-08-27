//! The driver-free, DOMAIN-NEUTRAL name-canonicalization primitive shared by every
//! bounded context that mints a human-visible name and the uniqueness key it folds
//! to — conversation titles, regular-workspace names, and any future sibling.
//!
//! There is exactly ONE pinned Unicode 16 table and ONE normalizer/fold in the
//! backend, and it lives here. This module BRANDS nothing: [`canonicalize_name`]
//! returns a neutral [`CanonicalName`] and a neutral [`NameCanonicalizationIssue`],
//! never a conversation-title or workspace-name value. Each domain wraps the neutral
//! result in its own value type, so no domain's legality, error vocabulary, or key
//! mint is defined in another domain's language.
//!
//! ## The neutral primitive is the whole BASE ENVELOPE, not a cap-parameterized step
//!
//! [`canonicalize_name`] runs the entire base envelope every human-visible name must
//! satisfy: NFC → ECMAScript-trim → reject-empty → reject over
//! [`MAX_NAME_CODE_POINTS`] → reject-forbidden → fold, in THAT fixed order. The
//! `128` envelope cap is checked BEFORE the forbidden scan, so a name that is both
//! over the envelope and carries a forbidden scalar reports its length, not the
//! interior scalar.
//!
//! A domain does NOT canonicalize with a different cap — the refusal precedence is
//! not a per-domain parameter, it is the shared contract. A domain that wants a
//! NARROWER limit (a regular workspace name caps at 64) applies that cap only AFTER
//! a successful base canonicalization, so it inherits the full envelope verdict —
//! including forbidden-before-its-own-cap — exactly as the TypeScript
//! `parseWorkspaceName` inherits the full `parseConversationTitle` verdict before it
//! checks 64. Collapsing the two into one cap-parameterized pipeline would reorder
//! the refusals (a 65–128-code-point name with a forbidden scalar would report its
//! length instead of the scalar); the base envelope stays whole precisely so it
//! cannot.

use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

mod pinned_unicode {
    include!(concat!(env!("OUT_DIR"), "/name_charset.rs"));
}

/// The base name envelope's maximum length, in NFC + trimmed code points. Every
/// human-visible name in the product must fit it; a domain may NARROW it (a regular
/// workspace name caps at 64) but never widen it. It is checked before the forbidden
/// scan, which is why the refusal precedence — empty, then over-envelope length,
/// then forbidden scalar — is fixed for every consumer.
pub const MAX_NAME_CODE_POINTS: usize = 128;

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

/// Why a candidate name fails the base envelope. Neutral: a consumer maps this into
/// its own domain issue. `TooLong` reports the measured count; the cap that refused
/// it is the fixed [`MAX_NAME_CODE_POINTS`].
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum NameCanonicalizationIssue {
    #[error("name is empty after trimming")]
    Empty,
    #[error("name contains {code_points} code points; the maximum is 128")]
    TooLong { code_points: usize },
    #[error("name contains forbidden code point U+{code_point:04X} at index {index}")]
    ForbiddenCodePoint { code_point: u32, index: usize },
}

/// Run the base name envelope: NFC-normalize, ECMAScript-trim, reject empty, reject
/// over [`MAX_NAME_CODE_POINTS`], reject a forbidden code point, and derive the
/// pinned fold key — in that fixed order.
///
/// A domain with a narrower limit applies it to the returned display AFTER a
/// success; it does not re-run this with a different cap (see the module docs).
pub fn canonicalize_name(raw: &str) -> Result<CanonicalName, NameCanonicalizationIssue> {
    let normalized: String = raw.nfc().collect();
    let display = normalized
        .trim_matches(is_ecmascript_trim_whitespace)
        .to_owned();
    let code_points = display.chars().count();
    if code_points == 0 {
        return Err(NameCanonicalizationIssue::Empty);
    }
    if code_points > MAX_NAME_CODE_POINTS {
        return Err(NameCanonicalizationIssue::TooLong { code_points });
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
//
// Exposed so any bounded context whose admission mirrors a Zod `.trim()` (the
// display-name value object, for one) folds against the SAME whitespace set the
// name envelope uses, rather than minting a second trim authority that could
// drift from `String.prototype.trim()`.
pub fn is_ecmascript_trim_whitespace(character: char) -> bool {
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
        CanonicalName, MAX_NAME_CODE_POINTS, NameCanonicalizationIssue, canonicalize_name,
        name_character_is_forbidden, name_is_nfc,
    };

    #[test]
    fn canonicalizes_with_exact_ecmascript_trim_and_pinned_fold() {
        let value = canonicalize_name("\u{FEFF}Straße\u{3000}").unwrap();
        assert_eq!(value.display(), "Straße");
        assert_eq!(value.key(), "strasse");
    }

    #[test]
    fn empty_after_trimming_is_reported_before_the_cap() {
        assert_eq!(
            canonicalize_name("   \u{3000}\u{FEFF}"),
            Err(NameCanonicalizationIssue::Empty)
        );
    }

    #[test]
    fn the_envelope_caps_at_128_before_the_forbidden_scan() {
        assert!(canonicalize_name(&"a".repeat(MAX_NAME_CODE_POINTS)).is_ok());
        assert_eq!(
            canonicalize_name(&"a".repeat(MAX_NAME_CODE_POINTS + 1)),
            Err(NameCanonicalizationIssue::TooLong {
                code_points: MAX_NAME_CODE_POINTS + 1
            })
        );

        // Over the 128 envelope AND carrying a forbidden joiner: the cap wins,
        // because it is checked first. This is the ordering every consumer inherits.
        let mut raw = "a".repeat(200);
        raw.push('\u{200D}');
        assert_eq!(
            canonicalize_name(&raw),
            Err(NameCanonicalizationIssue::TooLong { code_points: 201 })
        );
    }

    #[test]
    fn a_forbidden_scalar_within_the_envelope_is_reported_with_its_index() {
        // 101 code points: within the 128 envelope, so the forbidden scan fires and
        // reports the joiner rather than a length verdict.
        let raw = format!("{}\u{200D}", "a".repeat(100));
        assert_eq!(
            canonicalize_name(&raw),
            Err(NameCanonicalizationIssue::ForbiddenCodePoint {
                code_point: 0x200D,
                index: 100,
            })
        );
    }

    #[test]
    fn into_parts_yields_the_pair_the_primitive_produced() {
        let value: CanonicalName = canonicalize_name("  Design Review  ").unwrap();
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
