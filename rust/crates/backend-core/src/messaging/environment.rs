//! Host-backed implementations of the capabilities a send needs.
//!
//! They live in this crate only because it already carries the entropy
//! dependency, and they are values a caller passes in rather than functions the
//! domain reaches for. When a composition root can own them, they move outward
//! without any domain change: the traits, not these types, are what the write
//! unit depends on.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

use super::{EnvironmentUnavailable, SendClock, SendEntropy};

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

/// The host's wall clock, in Unix milliseconds.
pub struct SystemClock;

impl SendClock for SystemClock {
    fn now_unix_ms(&self) -> Result<i64, EnvironmentUnavailable> {
        let since_epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(EnvironmentUnavailable::from_source)?;
        i64::try_from(since_epoch.as_millis()).map_err(EnvironmentUnavailable::from_source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_clock_answers_in_unix_milliseconds() {
        let first = SystemClock.now_unix_ms().unwrap();
        let second = SystemClock.now_unix_ms().unwrap();

        // Sometime after 2020 and monotonic enough that two reads do not go
        // backwards; the point is the unit, not the precision.
        assert!(first > 1_577_836_800_000);
        assert!(second >= first);
    }

    #[test]
    fn host_entropy_fills_the_buffer_it_is_given() {
        let mut buffer = [0u8; 32];

        OsEntropy.fill(&mut buffer).unwrap();

        assert!(buffer.iter().any(|byte| *byte != 0));
    }
}
