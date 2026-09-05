//! Randomness and the clock, as capabilities this domain is given rather than
//! facts it reaches for.
//!
//! Both can fail, and both failures are infrastructure failures — nothing about the
//! request would change the outcome — so they are named here once and reported the
//! same way by every operation that needs them. The implementations that answer them
//! live with whichever crate owns the dependency; this module owns the capability and
//! its failure.

use std::error::Error;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use thiserror::Error as ThisError;

pub trait EntropySource: Send + Sync {
    type Error: Error + Send + Sync + 'static;
    fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error>;
}

pub trait Clock: Send + Sync {
    type Error: Error + Send + Sync + 'static;
    fn unix_time_ms(&self) -> Result<i64, Self::Error>;
}

/// The secure random source failed.
///
/// Erases the source's own error type so that one operation can mint a host id, a
/// host name and a credential and still report a single failure — the caller has
/// nothing to decide between them, and the cause stays attached for the operator.
#[derive(Debug, ThisError)]
#[error("secure random source failed")]
pub struct EntropyFailure(#[source] Box<dyn Error + Send + Sync>);

#[derive(Debug, ThisError)]
#[error("system clock failed")]
pub struct ClockFailure(#[source] Box<dyn Error + Send + Sync>);

pub(super) fn random_base64url<R: EntropySource>(
    entropy: &R,
    length: usize,
) -> Result<String, EntropyFailure> {
    let mut bytes = vec![0_u8; length];
    entropy
        .fill(&mut bytes)
        .map_err(|error| EntropyFailure(Box::new(error)))?;
    Ok(base64url(&bytes))
}

pub(super) fn random_hex<R: EntropySource>(
    entropy: &R,
    length: usize,
) -> Result<String, EntropyFailure> {
    let mut bytes = vec![0_u8; length];
    entropy
        .fill(&mut bytes)
        .map_err(|error| EntropyFailure(Box::new(error)))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) fn now_ms<C: Clock>(clock: &C) -> Result<i64, ClockFailure> {
    clock
        .unix_time_ms()
        .map_err(|error| ClockFailure(Box::new(error)))
}

/// Unpadded base64url — the encoding every identifier and verifier in this domain is
/// written in, matching Node's `base64url` digest encoding.
pub(super) fn base64url(input: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(input)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct OsEntropy;

impl EntropySource for OsEntropy {
    type Error = getrandom::Error;
    fn fill(&self, destination: &mut [u8]) -> Result<(), Self::Error> {
        getrandom::fill(destination)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

#[derive(Debug, ThisError)]
pub enum SystemClockError {
    #[error("system time precedes the Unix epoch")]
    BeforeUnixEpoch(#[source] std::time::SystemTimeError),
    #[error("system Unix-millisecond timestamp exceeds i64")]
    TimestampOutOfRange(#[source] std::num::TryFromIntError),
}

impl Clock for SystemClock {
    type Error = SystemClockError;

    fn unix_time_ms(&self) -> Result<i64, Self::Error> {
        let milliseconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(SystemClockError::BeforeUnixEpoch)?
            .as_millis();
        i64::try_from(milliseconds).map_err(SystemClockError::TimestampOutOfRange)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_matches_the_unpadded_node_contract() {
        assert_eq!(base64url(&[]), "");
        assert_eq!(base64url(&[0]), "AA");
        assert_eq!(base64url(&[0xff, 0xee, 0xdd]), "_-7d");
        assert_eq!(base64url(&[0_u8; 32]).len(), 43);
    }
}
