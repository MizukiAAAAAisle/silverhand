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
    let (display, key) = canonicalize_stored_name(raw);
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
    Ok(CanonicalName { display, key })
}

/// Total keying for persisted legacy names and migration/audit use. Unlike new
/// name admission this must not reject characters or lengths legal in old data.
pub fn canonicalize_stored_name(raw: &str) -> (String, String) {
    let normalized: String = raw.nfc().collect();
    let display = normalized
        .trim_matches(is_ecmascript_trim_whitespace)
        .to_owned();
    let key = fold_name_key(&display);
    (display, key)
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

/// Unicode 16 FULL case fold ONLY — NO normalization. This is the exact
/// isomorph of TS `unicode-case-fold.ts::foldCase`: the same pinned `CASE_FOLD`
/// table [`fold_name_key`] uses, but WITHOUT the trailing NFC, so it preserves the
/// un-normalized `toLocaleLowerCase`-equivalent semantics needed by case-insensitive
/// text MATCHING (search candidate selection + excerpt) where a folded-unit →
/// original-UTF-16-span mapping must stay derivable per code point. Do NOT use
/// [`fold_name_key`] for matching — its NFC can compose across code points and break
/// the span map.
///
/// Returns the folded string AND, for each ORIGINAL `char` (in order), the number of
/// UTF-16 code units its fold produced — so a matcher can map a folded-offset back to
/// the original text's UTF-16 offset without `from_utf16_lossy`.
pub fn fold_case_only_with_spans(raw: &str) -> (String, Vec<FoldSpan>) {
    let mut folded = String::with_capacity(raw.len());
    let mut spans = Vec::new();
    for character in raw.chars() {
        let original_utf16 = character.len_utf16() as u32;
        let folded_str =
            match pinned_unicode::CASE_FOLD.binary_search_by_key(&character, |(key, _)| *key) {
                Ok(index) => pinned_unicode::CASE_FOLD[index].1,
                Err(_) => {
                    // No fold row: the char folds to itself. Push it and record its own
                    // UTF-16 width on both sides.
                    let start = folded.len();
                    folded.push(character);
                    let folded_utf16 = folded[start..].encode_utf16().count() as u32;
                    spans.push(FoldSpan {
                        original_utf16,
                        folded_utf16,
                    });
                    continue;
                }
            };
        let folded_utf16 = folded_str.encode_utf16().count() as u32;
        folded.push_str(folded_str);
        spans.push(FoldSpan {
            original_utf16,
            folded_utf16,
        });
    }
    (folded, spans)
}

/// One original code point's contribution to a full case fold: how many UTF-16 code
/// units it occupied in the ORIGINAL text and how many its fold produced. A full fold
/// can EXPAND (e.g. `ß` → `ss`), so the two differ; the running sums let a matcher
/// translate a folded UTF-16 offset back to the original UTF-16 offset.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FoldSpan {
    pub original_utf16: u32,
    pub folded_utf16: u32,
}

/// Convenience: the full case fold ONLY (no NFC), discarding the span map — for
/// callers that only need the folded haystack/needle for a contains check.
pub fn fold_case_only(raw: &str) -> String {
    fold_case_only_with_spans(raw).0
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

/// Collapse every run of ECMAScript `\s` whitespace to a single space and trim the
/// ends — the ONE production authority mirroring TS `content.replace(/\s+/g, ' ')
/// .trim()`. Uses `is_ecmascript_trim_whitespace`, NOT Rust's
/// `char::is_whitespace()`, so U+FEFF collapses (JS `\s` includes it) and U+0085 NEL
/// does NOT (JS `\s` excludes it) — both the read-history snippet and the search
/// excerpt share this exact set.
pub fn collapse_ecmascript_whitespace(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut in_ws = false;
    for ch in content.chars() {
        if is_ecmascript_trim_whitespace(ch) {
            in_ws = true;
        } else {
            if in_ws && !out.is_empty() {
                out.push(' ');
            }
            in_ws = false;
            out.push(ch);
        }
    }
    out
}

/// Truncate an already-compacted string to at most `max` UTF-16 code units, mirroring
/// TS `s.length <= max ? s : s.slice(0, max - 1) + '…'` but SCALAR-SAFE: a
/// cut that would land inside a surrogate pair shrinks inward by one unit so the
/// ellipsis never replaces half a pair with U+FFFD. `max` must be ≥ 1.
pub fn truncate_utf16_scalar_safe(compact: &str, max: usize) -> String {
    let units: Vec<u16> = compact.encode_utf16().collect();
    if units.len() <= max {
        return compact.to_owned();
    }
    // Keep `max - 1` units for the body, then append the one-unit ellipsis. If the
    // body would end on a high surrogate (lead half of a pair), drop it (shrink
    // inward) so we never split the pair.
    let mut end = max - 1;
    if end > 0 && (0xD800..=0xDBFF).contains(&units[end - 1]) {
        end -= 1;
    }
    let mut truncated = String::from_utf16_lossy(&units[..end]);
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::{
        CanonicalName, NameCanonicalizationIssue, canonicalize_name, name_character_is_forbidden,
        name_is_nfc,
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
        assert!(canonicalize_name(&"a".repeat(128)).is_ok());
        assert_eq!(
            canonicalize_name(&"a".repeat(129)),
            Err(NameCanonicalizationIssue::TooLong { code_points: 129 })
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
        assert!(name_character_is_forbidden('\u{1F3FB}'));
        assert!(name_is_nfc("Å"));
        assert!(!name_is_nfc("A\u{030A}"));
    }
}
