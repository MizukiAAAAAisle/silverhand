//! The one shared UTF-16 length primitive.
//!
//! Whenever a text bound's product contract is JavaScript's `String.length` — UTF-16
//! code units, not bytes and not Unicode scalar values — it is measured here. A
//! `z.string().max(n)` in the shared Zod schemas counts code units, so a Rust admission
//! that measured bytes or `char`s would silently accept or reject strings the product
//! schema does not. This module owns that count in ONE place; every field rule whose
//! length contract comes from `String.length` delegates here rather than reimplementing
//! `encode_utf16().count()`.
//!
//! Bounds with a DIFFERENT contract are out of scope: byte/resource caps (payload
//! limits) and any non-Zod wire measure their own unit and do not route through here.
//!
//! It owns ONLY the code-unit count and the `<= max` comparison. What the maximum is
//! for a given field, and whether the field is trimmed or charset-restricted first,
//! belong to that field's own authority (its `parse`/`TryFrom`).

/// The length of `value` in UTF-16 code units — JavaScript's `String.length`.
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Whether `value` fits within `max` UTF-16 code units (JS `.length <= max`).
pub fn within_utf16_max(value: &str, max: usize) -> bool {
    utf16_len(value) <= max
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_code_units_not_bytes_or_scalars() {
        // ASCII: one code unit each.
        assert_eq!(utf16_len("abc"), 3);
        // A BMP multi-byte scalar is ONE UTF-16 unit but multiple UTF-8 bytes.
        assert_eq!(utf16_len("é"), 1);
        // An astral scalar is ONE Unicode scalar but a UTF-16 surrogate PAIR (two
        // units) — exactly what JS `.length` reports.
        assert_eq!(utf16_len("😀"), 2);
    }

    #[test]
    fn bound_is_inclusive_and_measured_in_code_units() {
        assert!(within_utf16_max("", 0));
        assert!(within_utf16_max("ab", 2));
        assert!(!within_utf16_max("abc", 2));
        // Two astral scalars = four code units: at the bound of four, over at three.
        assert!(within_utf16_max("😀😀", 4));
        assert!(!within_utf16_max("😀😀", 3));
    }
}
