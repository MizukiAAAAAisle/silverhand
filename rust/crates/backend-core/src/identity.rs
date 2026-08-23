//! Identities shared across application capabilities.

use thiserror::Error;

/// The one user identity used by authentication and every product module.
///
/// User ids are opaque coordinates. The system has historically minted more
/// than one shape, so the stable invariant at a read boundary is only that the
/// coordinate is not empty.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct UserId(String);

impl UserId {
    pub fn parse(raw: impl Into<String>) -> Result<Self, EmptyUserId> {
        let raw = raw.into();
        if raw.is_empty() {
            return Err(EmptyUserId);
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

#[derive(Debug, Error)]
#[error("user id must not be empty")]
pub struct EmptyUserId;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_id_is_opaque_but_never_empty() {
        assert!(UserId::parse("").is_err());
        let user = UserId::parse("legacy:user/1").unwrap();
        assert_eq!(user.as_str(), "legacy:user/1");
        assert_eq!(user.into_inner(), "legacy:user/1");
    }
}
