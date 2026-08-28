//! What time this process thinks it is.
//!
//! One port for the whole boundary, because "what time is it" belongs to no route
//! family. Reading it out of runtime-credential vocabulary made `/api/health`,
//! `/readyz` and agent presence each look like they were borrowing a runtime's clock
//! for a stamp none of them has anything to do with.
//!
//! The port answers in wire units — signed unix milliseconds, the domain the product's
//! `Date.now()` already sends — and names no domain type. A consumer that wants a
//! branded instant brands it at its own boundary, which is what the runtime credential
//! authority does with `RuntimeEventTime::from_unix_millis`: the meaning stays where it
//! is meaningful instead of being baked into the clock every other consumer shares.

use std::time::SystemTime;

/// The process's wall clock. `Clone` because every consumer holds it in router state.
pub trait ProcessClock: Clone + Send + Sync + 'static {
    fn now_unix_millis(&self) -> i64;
}

/// The clock of the machine this process runs on. The only production implementation.
///
/// Spelled after its port rather than as a bare `SystemClock`, which in this workspace
/// already names the fallible host-invite clock in
/// [`silverhand_backend_core::host_runtime`] — a different port with a different
/// contract, and one a composition root must never confuse this for.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemProcessClock;

impl ProcessClock for SystemProcessClock {
    fn now_unix_millis(&self) -> i64 {
        signed_unix_millis(SystemTime::now())
    }
}

/// The workspace-metadata write leaf states its write instant as a narrow per-slice
/// [`WorkspaceMetadataClock`] capability rather than depending on this hub directly, so
/// it stays unit-testable behind a pinned clock double. That capability is the SAME
/// contract this port already answers — signed Unix milliseconds, `Date.now()` parity —
/// so the one process-clock owner satisfies it directly. The composition injects
/// `SystemProcessClock`; it does NOT mint a second wall-clock reader for the leaf, so
/// every production `SystemTime::now()` for this contract stays in this one file.
impl crate::workspace_metadata_write::WorkspaceMetadataClock for SystemProcessClock {
    fn now_unix_millis(&self) -> i64 {
        signed_unix_millis(SystemTime::now())
    }
}

/// Unix milliseconds, signed and saturating.
///
/// A machine whose clock is set before 1970 reads negative rather than panicking or
/// wrapping into a plausible future, and an absurd setting saturates at the end of the
/// range instead of wrapping past the other. Every reading therefore stays ordered
/// against every other, which is the only property the consumers here rely on.
fn signed_unix_millis(time: SystemTime) -> i64 {
    let millis = match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => i128::try_from(duration.as_millis()).unwrap_or(i128::MAX),
        Err(error) => -i128::try_from(error.duration().as_millis()).unwrap_or(i128::MAX),
    };
    i64::try_from(millis).unwrap_or_else(|_| {
        if millis.is_negative() {
            i64::MIN
        } else {
            i64::MAX
        }
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// The epoch is the origin and a moment before it is negative — not a panic, and
    /// not a large positive stamp from an unsigned subtraction.
    #[test]
    fn the_epoch_is_the_origin_and_earlier_readings_are_negative() {
        assert_eq!(signed_unix_millis(SystemTime::UNIX_EPOCH), 0);
        assert_eq!(
            signed_unix_millis(SystemTime::UNIX_EPOCH - Duration::from_millis(1_500)),
            -1_500
        );
        assert_eq!(
            signed_unix_millis(SystemTime::UNIX_EPOCH + Duration::from_millis(1_700_000_000_123)),
            1_700_000_000_123
        );
    }

    /// An instant no `i64` can carry saturates towards its own end of the range, so
    /// ordering survives a nonsense clock setting.
    #[test]
    fn an_unrepresentable_instant_saturates_towards_its_own_side() {
        let beyond = Duration::from_millis(u64::MAX);
        if let Some(far_future) = SystemTime::UNIX_EPOCH.checked_add(beyond) {
            assert_eq!(signed_unix_millis(far_future), i64::MAX);
        }
        if let Some(far_past) = SystemTime::UNIX_EPOCH.checked_sub(beyond) {
            assert_eq!(signed_unix_millis(far_past), i64::MIN);
        }
    }
}
