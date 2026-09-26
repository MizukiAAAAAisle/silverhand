//! The validated reaction-emoji value.
//!
//! The scalar tables are generated from the production TypeScript validator's
//! `Extended_Pictographic | Emoji_Component` and `\s` predicates. A normal TS
//! parity test regenerates the bytes, so this is a projection of that authority,
//! not an independently maintained Unicode opinion.

use thiserror::Error;

include!("emoji_ranges.rs");

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ReactionEmoji(String);

impl ReactionEmoji {
    pub fn parse(raw: &str) -> Result<Self, InvalidReactionEmoji> {
        let emoji = trim_ecmascript(raw);
        if emoji.is_empty() {
            return Err(InvalidReactionEmoji::Empty);
        }
        if emoji.chars().any(is_ecmascript_whitespace) {
            return Err(InvalidReactionEmoji::Whitespace);
        }
        if emoji.encode_utf16().count() > 16 {
            return Err(InvalidReactionEmoji::TooLong);
        }
        if !emoji.chars().all(is_reaction_emoji_scalar) {
            return Err(InvalidReactionEmoji::NotUnicodeEmoji);
        }
        Ok(Self(emoji.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum InvalidReactionEmoji {
    #[error("emoji is empty")]
    Empty,
    #[error("emoji must not contain whitespace")]
    Whitespace,
    #[error("emoji exceeds 16 chars")]
    TooLong,
    #[error("emoji must be a Unicode emoji")]
    NotUnicodeEmoji,
}

fn in_ranges(value: u32, ranges: &[(u32, u32)]) -> bool {
    ranges
        .binary_search_by(|(start, end)| {
            if value < *start {
                std::cmp::Ordering::Greater
            } else if value > *end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn is_reaction_emoji_scalar(value: char) -> bool {
    in_ranges(value as u32, REACTION_EMOJI_SCALAR_RANGES)
}

fn is_ecmascript_whitespace(value: char) -> bool {
    in_ranges(value as u32, ECMASCRIPT_WHITESPACE_RANGES)
}

fn trim_ecmascript(raw: &str) -> &str {
    raw.trim_matches(is_ecmascript_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_the_published_utf16_and_unicode_grammar() {
        assert_eq!(ReactionEmoji::parse("  👍  ").unwrap().as_str(), "👍");
        assert!(ReactionEmoji::parse("👨‍👩‍👧").is_ok());
        assert!(ReactionEmoji::parse("not-emoji").is_err());
        assert!(ReactionEmoji::parse("👍 👍").is_err());
        assert_eq!(
            ReactionEmoji::parse(&"👍".repeat(8)).unwrap().as_str(),
            "👍".repeat(8)
        );
        assert_eq!(
            ReactionEmoji::parse(&"👍".repeat(9)),
            Err(InvalidReactionEmoji::TooLong)
        );
    }
}
