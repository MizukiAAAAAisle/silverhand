//! Who a principal is, as one vocabulary for the whole boundary.
//!
//! Human and agent are two kinds of ONE principal model, not a local alphabet
//! belonging to whoever happens to ask. The same two names answer for a direct
//! pair's endpoint, for the write gate's participation question, for what a body
//! addressed and for a mention copy's recipient — so the type and the grammar live
//! here rather than inside any one of those consumers.

/// Which namespace names a principal. One vocabulary, because "which table
/// answers for this name" is the same question whether it is asked of a direct
/// pair's endpoint or of something a message addressed.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum PrincipalKind {
    Human,
    Agent,
}

/// A handle is at most this long wherever it is stored, so a longer one cannot be
/// a name this system holds.
const HANDLE_MAX_LENGTH: usize = 64;

/// A participant name, in the grammar every stored name obeys.
///
/// It exists as a type because a handle is interpolated into server-authored prose
/// that addresses people: raw text there could close a destination, open another
/// path segment, or start a new line. Anything outside the grammar is not a name
/// this system holds, so it is refused rather than escaped.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ParticipantHandle(String);

impl ParticipantHandle {
    pub fn parse(raw: impl Into<String>) -> Result<Self, InvalidHandle> {
        let raw = raw.into();
        if raw.is_empty() || raw.len() > HANDLE_MAX_LENGTH {
            return Err(InvalidHandle);
        }
        let mut characters = raw.chars();
        let first = characters.next().ok_or(InvalidHandle)?;
        if !first.is_ascii_alphabetic() {
            return Err(InvalidHandle);
        }
        if !characters.all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        }) {
            return Err(InvalidHandle);
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("handle is outside the grammar every stored name obeys")]
pub struct InvalidHandle;
