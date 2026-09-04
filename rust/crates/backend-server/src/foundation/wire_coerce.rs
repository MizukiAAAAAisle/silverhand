//! A wire-admission carrier mirroring the reference `z.preprocess(empty→absent,
//! z.coerce.number())` used by the agent read/search numeric inputs (`before_seq`,
//! `after_seq`, `limit`) — Cindy #12/#26/#47.
//!
//! The reference schema is NOT a `string|number` union: after mapping `'' | undefined`
//! to absent, the remaining value goes through ECMAScript `Number(value)` (`z.coerce`),
//! then `.int()` and the domain gate (`nonnegative` / `positive().max(100)`). Rust's
//! `RequiredPatchField<i64>` rejects a numeric string / bool / null at the serde shape
//! layer, so an accepted TS cell would be a Rust 4xx — a wire drift. This carrier
//! reproduces the exact accepted/rejected matrix and adds the migration-wide
//! JS-safe-integer gate (#47): a coerced value outside the ±MAX_SAFE_INTEGER domain is
//! rejected (JS `z.coerce.number()` would silently round it, so echoing it would not be
//! the same value on both wires).

use serde::{Deserialize, Deserializer};
use serde_json::Value;

use silverhand_backend_core::foundation::name_canonicalization::is_ecmascript_trim_whitespace;
use silverhand_backend_core::viewer_read_model::presence::MAX_SAFE_INTEGER;

/// One decoded coercion cell: absent (`'' | undefined | null-absent`), a coerced
/// integer, or a structural reject (non-numeric / non-integer / non-JS-safe).
#[derive(Clone, Debug, Default)]
pub enum CoercedNumber {
    /// The key was absent, or an empty string (mapped to absent by the preprocess).
    #[default]
    Absent,
    /// A value that coerced to an exact JS-safe integer.
    Value(i64),
    /// A present value that could not coerce to a JS-safe integer (`Number(value)` is
    /// `NaN`/non-integer/out of the safe domain). The route renders this as its
    /// structural `invalid input`.
    Invalid,
}

impl CoercedNumber {
    /// The coerced integer, or `None` when absent. `Invalid` also yields `None` — the
    /// route MUST check [`CoercedNumber::is_invalid`] first (the domain gate cannot
    /// distinguish absent from invalid otherwise).
    pub fn value(&self) -> Option<i64> {
        match self {
            Self::Value(v) => Some(*v),
            _ => None,
        }
    }

    pub fn is_invalid(&self) -> bool {
        matches!(self, Self::Invalid)
    }
}

/// ECMAScript `ToString` for the JSON values that can reach `Number(value)`'s
/// object→primitive path (an array with a number hint has no primitive `valueOf`, so
/// `ToPrimitive` falls to `toString` = `Array.prototype.join(',')`). `null`/absent
/// elements stringify to the empty string. Only implemented for the shapes that
/// actually appear inside a coerced array cell.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(true) => "true".to_owned(),
        Value::Bool(false) => "false".to_owned(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        // `String([a, b]) === a.join(',')`; a nested array stringifies recursively.
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        // A plain object stringifies to "[object Object]" → NaN under Number(); we
        // never need its exact text, only that it is non-numeric, so return a sentinel.
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// ECMAScript `StringToNumber` (the string arm of `ToNumber`): trim the ECMAScript
/// whitespace set; `""` (after trim) is `0`; `0x`/`0o`/`0b` are radix literals;
/// `Infinity` (optionally signed) is infinite; otherwise a decimal parse, else `NaN`.
fn string_to_number(raw: &str) -> f64 {
    let trimmed = raw.trim_matches(is_ecmascript_trim_whitespace);
    if trimmed.is_empty() {
        return 0.0;
    }
    // Radix literals (unsigned only, matching the spec's NumericLiteral forms).
    let radix = |body: &str, base: u32| -> f64 {
        if body.is_empty() {
            return f64::NAN;
        }
        match i64::from_str_radix(body, base) {
            Ok(v) => v as f64,
            Err(_) => f64::NAN,
        }
    };
    if let Some(body) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return radix(body, 16);
    }
    if let Some(body) = trimmed
        .strip_prefix("0o")
        .or_else(|| trimmed.strip_prefix("0O"))
    {
        return radix(body, 8);
    }
    if let Some(body) = trimmed
        .strip_prefix("0b")
        .or_else(|| trimmed.strip_prefix("0B"))
    {
        return radix(body, 2);
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// Coerce a JSON value the way ECMAScript `Number(value)` does, then require an EXACT
/// JS-safe integer (#47). Returns `None` for a value that does not coerce to such an
/// integer.
fn coerce_js_number(value: &Value) -> Option<i64> {
    let n: f64 = match value {
        Value::Number(num) => num.as_f64()?,
        // `Number(string)` = StringToNumber (NOT Rust's f64 parse: handles radix
        // literals + the ECMAScript trim set + `""`→0).
        Value::String(s) => string_to_number(s),
        // `Number(null)` = 0, `Number(false)` = 0, `Number(true)` = 1.
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        // `Number(array)` = `Number(String(array))` — the array has no primitive
        // valueOf, so ToPrimitive(number) falls to toString/join. This is NOT a
        // recurse-by-element-type: `Number([true])` is `Number("true")` = NaN (whereas
        // `Number(true)` would be 1), `[null]`/`[[]]` → `Number("")` = 0, `["5"]` → 5.
        Value::Array(_) => string_to_number(&js_string(value)),
        Value::Object(_) => return None,
    };
    // `.int()`: must be an integer; JS-safe: within the exact-integer domain (#47).
    if !n.is_finite() || n.fract() != 0.0 {
        return None;
    }
    let as_i64 = n as i64;
    if !(-(MAX_SAFE_INTEGER)..=MAX_SAFE_INTEGER).contains(&as_i64) {
        return None;
    }
    // Round-trip guard: an f64 beyond 2^53 loses precision, so confirm exactness.
    if as_i64 as f64 != n {
        return None;
    }
    Some(as_i64)
}

impl<'de> Deserialize<'de> for CoercedNumber {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        // The preprocess maps `'' | undefined` to absent — ONLY the EXACT empty string
        // (`s === ''`), NOT a whitespace-only string. `Number("   ")` is 0, so a
        // whitespace-only cell must fall through to coercion (→ 0), never Absent.
        if let Value::String(s) = &value
            && s.is_empty()
        {
            return Ok(Self::Absent);
        }
        Ok(match coerce_js_number(&value) {
            Some(v) => Self::Value(v),
            None => Self::Invalid,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coerce(json: &str) -> CoercedNumber {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn coerces_the_full_z_coerce_number_matrix() {
        // Plain integer / numeric string.
        assert_eq!(coerce("5").value(), Some(5));
        assert_eq!(coerce("\"5\"").value(), Some(5));
        // EXACT empty string → absent (the preprocess); a WHITESPACE-only string is
        // NOT absent — Number("   ") = 0.
        assert!(matches!(coerce("\"\""), CoercedNumber::Absent));
        assert_eq!(coerce("\"   \"").value(), Some(0));
        // null → 0, false → 0, true → 1 (Number()).
        assert_eq!(coerce("null").value(), Some(0));
        assert_eq!(coerce("false").value(), Some(0));
        assert_eq!(coerce("true").value(), Some(1));
        // Radix literals JS accepts but Rust's f64 parse would reject.
        assert_eq!(coerce("\"0x10\"").value(), Some(16));
        assert_eq!(coerce("\"0o10\"").value(), Some(8));
        assert_eq!(coerce("\"0b10\"").value(), Some(2));
        // ECMAScript-trimmed numeric string (leading/trailing JS whitespace).
        assert_eq!(coerce("\" 42 \"").value(), Some(42));
        // Singleton-array coercion goes via String(array), NOT recurse-by-element:
        // Number([true]) = Number("true") = NaN (NOT 1); Number([false]) = NaN;
        // Number([null]) = Number("") = 0; Number([[]]) = 0; Number(["5"]) = 5.
        assert!(coerce("[true]").is_invalid());
        assert!(coerce("[false]").is_invalid());
        assert_eq!(coerce("[null]").value(), Some(0));
        assert_eq!(coerce("[[]]").value(), Some(0));
        assert_eq!(coerce("[\"5\"]").value(), Some(5));
        // Plain numeric singleton + empty + multi.
        assert_eq!(coerce("[7]").value(), Some(7));
        assert_eq!(coerce("[]").value(), Some(0));
        assert!(coerce("[1,2]").is_invalid());
        // Non-numeric string / object / fraction → invalid.
        assert!(coerce("\"x\"").is_invalid());
        assert!(coerce("{}").is_invalid());
        assert!(coerce("1.5").is_invalid());
        // JS-safe boundary (#47): MAX_SAFE ok, MAX_SAFE+1 rejected (JS would round).
        assert_eq!(coerce("9007199254740991").value(), Some(MAX_SAFE_INTEGER));
        assert!(coerce("9007199254740993").is_invalid());
    }

    /// Replay the Zod-SIGNED fixture (Cindy #26): every cell's outcome must match what
    /// the real `z.coerce.number().int().refine(isSafeInteger)` produced (regenerated
    /// by `packages/backend/tests/read-model/coerce-number-rust-parity.test.ts`), so
    /// the Rust `Number()` reimplementation cannot drift on the radix/trim/empty/
    /// singleton-array-NaN cells.
    #[test]
    fn replays_the_zod_signed_coercion_fixture() {
        #[derive(serde::Deserialize)]
        struct Cell {
            label: String,
            input: serde_json::Value,
            outcome: String,
            #[serde(default)]
            value: Option<i64>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            cells: Vec<Cell>,
        }
        const FIXTURE: &str = include_str!("../../tests/fixtures/coerce-number.parity.json");
        let fixture: Fixture = serde_json::from_str(FIXTURE).unwrap();
        for cell in fixture.cells {
            // Deserialize the raw JSON value THROUGH CoercedNumber the same way serde
            // would from a request body.
            let coerced: CoercedNumber = serde_json::from_value(cell.input.clone()).unwrap();
            match cell.outcome.as_str() {
                "absent" => assert!(
                    matches!(coerced, CoercedNumber::Absent),
                    "{}: expected absent, got {coerced:?}",
                    cell.label
                ),
                "invalid" => assert!(
                    coerced.is_invalid(),
                    "{}: expected invalid, got {coerced:?}",
                    cell.label
                ),
                "value" => assert_eq!(
                    coerced.value(),
                    cell.value,
                    "{}: coerced value mismatch",
                    cell.label
                ),
                other => panic!("{}: unknown outcome {other}", cell.label),
            }
        }
    }
}
