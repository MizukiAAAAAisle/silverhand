//! One ECMAScript `Number(string)` + integer classifier for query schemas.
//!
//! Saved and archived-channel filters both publish `z.coerce.number().int()`.
//! Keeping the radix-to-binary64 boundary here prevents two near-equivalent
//! parsers from drifting on values around `2^63` and finite overflow.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum NumberIssue {
    Nan,
    Float,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CoercedInteger {
    Persisted(i64),
    BeyondPersistedRange,
}

pub(super) fn coerce_integer(raw: &str) -> Result<CoercedInteger, NumberIssue> {
    let trimmed = crate::messaging::admission::ecmascript_trim(raw);
    let number = if trimmed.is_empty() {
        0.0
    } else if matches!(trimmed, "Infinity" | "+Infinity" | "-Infinity") {
        return Err(NumberIssue::Float);
    } else if let Some((digits, radix)) = prefixed_integer(trimmed) {
        return coerce_prefixed(digits, radix);
    } else {
        if !is_ecmascript_decimal_literal(trimmed) {
            return Err(NumberIssue::Nan);
        }
        trimmed.parse::<f64>().map_err(|_| NumberIssue::Nan)?
    };
    if number.is_nan() {
        return Err(NumberIssue::Nan);
    }
    if !number.is_finite() || number.fract() != 0.0 {
        return Err(NumberIssue::Float);
    }
    if number < 0.0 {
        return Ok(CoercedInteger::Persisted(-1));
    }
    if number >= 9_223_372_036_854_775_808.0 {
        return Ok(CoercedInteger::BeyondPersistedRange);
    }
    Ok(CoercedInteger::Persisted(number as i64))
}

fn is_ecmascript_decimal_literal(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut cursor = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let integer_start = cursor;
    while matches!(bytes.get(cursor), Some(b'0'..=b'9')) {
        cursor += 1;
    }
    let integer_digits = cursor - integer_start;
    let mut fraction_digits = 0;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let fraction_start = cursor;
        while matches!(bytes.get(cursor), Some(b'0'..=b'9')) {
            cursor += 1;
        }
        fraction_digits = cursor - fraction_start;
    }
    if integer_digits == 0 && fraction_digits == 0 {
        return false;
    }
    if matches!(bytes.get(cursor), Some(b'e' | b'E')) {
        cursor += 1;
        if matches!(bytes.get(cursor), Some(b'+' | b'-')) {
            cursor += 1;
        }
        let exponent_start = cursor;
        while matches!(bytes.get(cursor), Some(b'0'..=b'9')) {
            cursor += 1;
        }
        if cursor == exponent_start {
            return false;
        }
    }
    cursor == bytes.len()
}

fn coerce_prefixed(digits: &str, radix: u32) -> Result<CoercedInteger, NumberIssue> {
    let bits_per_digit = match radix {
        2 => 1,
        8 => 3,
        16 => 4,
        _ => return Err(NumberIssue::Nan),
    };
    if digits.is_empty() {
        return Err(NumberIssue::Nan);
    }
    let mut exact = Some(0_u64);
    let mut first_nonzero = None;
    for (index, byte) in digits.bytes().enumerate() {
        let Some(digit) = ascii_digit(byte, radix) else {
            return Err(NumberIssue::Nan);
        };
        if digit != 0 && first_nonzero.is_none() {
            first_nonzero = Some((index, digit));
        }
        exact = exact.and_then(|value| {
            value
                .checked_mul(u64::from(radix))
                .and_then(|value| value.checked_add(u64::from(digit)))
        });
    }
    let Some((first_index, first_digit)) = first_nonzero else {
        return Ok(CoercedInteger::Persisted(0));
    };
    if let Some(value) = exact.filter(|value| *value < (1_u64 << 63)) {
        let rounded = round_u64_to_binary64_integer(value);
        return if rounded < (1_u64 << 63) {
            Ok(CoercedInteger::Persisted(rounded as i64))
        } else {
            Ok(CoercedInteger::BeyondPersistedRange)
        };
    }
    let significant_digits = digits.len() - first_index;
    let first_bits = u32::BITS - first_digit.leading_zeros();
    let bit_length = (significant_digits - 1)
        .checked_mul(bits_per_digit)
        .and_then(|tail| tail.checked_add(first_bits as usize))
        .ok_or(NumberIssue::Float)?;
    match bit_length.cmp(&1024) {
        std::cmp::Ordering::Less => Ok(CoercedInteger::BeyondPersistedRange),
        std::cmp::Ordering::Greater => Err(NumberIssue::Float),
        std::cmp::Ordering::Equal => {
            if leading_significant_bits_are_ones(digits, radix, 54) {
                Err(NumberIssue::Float)
            } else {
                Ok(CoercedInteger::BeyondPersistedRange)
            }
        }
    }
}

fn ascii_digit(byte: u8, radix: u32) -> Option<u32> {
    let value = match byte {
        b'0'..=b'9' => u32::from(byte - b'0'),
        b'a'..=b'f' => 10 + u32::from(byte - b'a'),
        b'A'..=b'F' => 10 + u32::from(byte - b'A'),
        _ => return None,
    };
    (value < radix).then_some(value)
}

fn round_u64_to_binary64_integer(value: u64) -> u64 {
    let bit_length = u64::BITS - value.leading_zeros();
    if bit_length <= 53 {
        return value;
    }
    let shift = bit_length - 53;
    let unit = 1_u64 << shift;
    let retained = value >> shift;
    let remainder = value & (unit - 1);
    let halfway = unit >> 1;
    let round_up = remainder > halfway || (remainder == halfway && retained & 1 == 1);
    (retained + u64::from(round_up)) << shift
}

fn leading_significant_bits_are_ones(digits: &str, radix: u32, wanted: usize) -> bool {
    let bits_per_digit = match radix {
        2 => 1,
        8 => 3,
        16 => 4,
        _ => return false,
    };
    let mut started = false;
    let mut seen = 0;
    for byte in digits.bytes() {
        let digit = ascii_digit(byte, radix).expect("digits were validated before classification");
        for bit in (0..bits_per_digit).rev() {
            let set = digit & (1 << bit) != 0;
            if !started {
                if !set {
                    continue;
                }
                started = true;
            }
            if !set {
                return false;
            }
            seen += 1;
            if seen == wanted {
                return true;
            }
        }
    }
    false
}

fn prefixed_integer(raw: &str) -> Option<(&str, u32)> {
    raw.strip_prefix("0x")
        .or_else(|| raw.strip_prefix("0X"))
        .map(|digits| (digits, 16))
        .or_else(|| {
            raw.strip_prefix("0b")
                .or_else(|| raw.strip_prefix("0B"))
                .map(|digits| (digits, 2))
        })
        .or_else(|| {
            raw.strip_prefix("0o")
                .or_else(|| raw.strip_prefix("0O"))
                .map(|digits| (digits, 8))
        })
}
