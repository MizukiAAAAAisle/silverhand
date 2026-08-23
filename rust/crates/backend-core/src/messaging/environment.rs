//! Host-backed randomness for the identities this module publishes.
//!
//! `OsEntropy` is plumbing debt: it sits in this crate because this crate carries
//! the entropy dependency, not because any domain rule refers to it. Nothing here
//! is reached implicitly — the write unit depends on [`SendEntropy`], and this
//! type is a value a caller passes in.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

use super::{EnvironmentUnavailable, SendEntropy};

pub(super) fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The operating system's randomness.
pub struct OsEntropy;

impl SendEntropy for OsEntropy {
    fn fill(&self, buffer: &mut [u8]) -> Result<(), EnvironmentUnavailable> {
        getrandom::fill(buffer).map_err(EnvironmentUnavailable::from_source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The host source is exercised for reachability only. What it produces is not
    /// asserted: any claim about the bytes would be a claim about chance.
    #[test]
    fn the_host_source_answers() {
        let mut buffer = [0u8; 32];

        assert!(OsEntropy.fill(&mut buffer).is_ok());
    }
}
