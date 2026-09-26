//! Non-negative reaction aggregate carried by ACK, cold reads, and live facts.

/// JavaScript's largest exactly representable integer. Reaction counts cross the
/// TS/Rust wire, so values above this boundary are persistence corruption rather
/// than numbers the server may round for clients.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("reaction count is outside the published non-negative safe-integer domain")]
pub struct InvalidReactionCount;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReactionCount(i64);

impl ReactionCount {
    pub fn new(value: i64) -> Result<Self, InvalidReactionCount> {
        if !(0..=MAX_SAFE_INTEGER).contains(&value) {
            return Err(InvalidReactionCount);
        }
        Ok(Self(value))
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_is_non_negative_and_exact_on_the_javascript_wire() {
        assert_eq!(ReactionCount::new(0).unwrap().value(), 0);
        assert!(ReactionCount::new(-1).is_err());
        assert!(ReactionCount::new(9_007_199_254_740_991).is_ok());
        assert!(ReactionCount::new(9_007_199_254_740_992).is_err());
    }
}
