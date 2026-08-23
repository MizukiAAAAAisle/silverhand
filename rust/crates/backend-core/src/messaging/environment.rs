//! The host facts a send depends on, as narrow ports rather than ambient reach.
//!
//! Randomness and the clock are capabilities a caller passes in, so a failure to
//! answer stays reportable instead of becoming a panic somewhere inside the write.
//! The ports and that failure are the durable part of this module.
//!
//! `OsEntropy` is plumbing debt by comparison: it sits in this crate because this
//! crate carries the entropy dependency, not because any domain rule refers to it.
//! When it leaves (R2), what remains here is exactly the ports and the failure.

use std::error::Error;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

/// Randomness, as a capability rather than an ambient fact of the process. A
/// failure keeps its cause: "no identity could be minted" is only actionable with
/// the reason attached.
pub trait SendEntropy {
    fn fill(&self, buffer: &mut [u8]) -> Result<(), EnvironmentUnavailable>;
}

/// The moment a send happened, likewise a capability. The unit reads it once and
/// reports the same value it stored.
pub trait SendClock {
    fn now_unix_ms(&self) -> Result<i64, EnvironmentUnavailable>;
}

/// The environment could not answer. Not a refusal: the caller did nothing wrong,
/// and nothing about the request would change the outcome.
#[derive(Debug, thiserror::Error)]
#[error("the environment this send depends on could not answer")]
pub struct EnvironmentUnavailable {
    #[source]
    source: Box<dyn Error + Send + Sync + 'static>,
}

impl EnvironmentUnavailable {
    pub fn from_source<E>(source: E) -> Self
    where
        E: Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

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
