//! Integers every JavaScript JSON consumer can represent exactly.
//!
//! This type owns only the binary64 precision boundary. Positivity, timestamp
//! meaning, sequence monotonicity, and other domain rules remain with their own
//! newtypes and command codecs.

/// One integer inside JavaScript's exact binary64 range.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct JsSafeInteger(i64);

impl JsSafeInteger {
    pub const MIN: i64 = -9_007_199_254_740_991;
    pub const MAX: i64 = 9_007_199_254_740_991;

    pub fn new(value: i64) -> Result<Self, JsSafeIntegerOutOfRange> {
        if (Self::MIN..=Self::MAX).contains(&value) {
            Ok(Self(value))
        } else {
            Err(JsSafeIntegerOutOfRange(value))
        }
    }

    pub fn get(self) -> i64 {
        self.0
    }
}

/// A signed integer that JSON can carry but a JavaScript number cannot preserve.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("integer is outside JavaScript's exact binary64 range")]
pub struct JsSafeIntegerOutOfRange(i64);

impl JsSafeIntegerOutOfRange {
    pub fn value(self) -> i64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_binary64_boundaries_are_admitted_in_both_directions() {
        for value in [-9_007_199_254_740_991, -1, 0, 1, 9_007_199_254_740_991] {
            assert_eq!(JsSafeInteger::new(value).unwrap().get(), value);
        }
        for value in [
            -9_007_199_254_740_992,
            9_007_199_254_740_992,
            i64::MIN,
            i64::MAX,
        ] {
            assert_eq!(JsSafeInteger::new(value).unwrap_err().value(), value);
        }
    }
}
