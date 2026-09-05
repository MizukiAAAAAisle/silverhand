//! Explicit carrier for displayable values admitted to the production log sink.
//!
//! `tracing` routes both `%Display` and `?Debug` through `Visit::record_debug`, so
//! a formatter cannot distinguish a reviewed textual coordinate/error from an
//! opaque debug dump. Production call sites use this carrier instead: it records
//! through `record_str`, while unwrapped debug values remain fail-closed.

use std::fmt;

/// Formats a reviewed display value into a native `String` tracing value.
///
/// `String` is one of tracing's sealed typed values and records through
/// `Visit::record_str`; opaque `?Debug` values continue through
/// `Visit::record_debug` and remain fail-closed in the production sink.
pub fn safe_display<T: fmt::Display + ?Sized>(value: &T) -> String {
    value.to_string()
}
