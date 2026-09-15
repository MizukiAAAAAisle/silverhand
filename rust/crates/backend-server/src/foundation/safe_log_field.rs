//! Explicit carrier for displayable values admitted to the production log sink.
//!
//! `tracing` routes both `%Display` and `?Debug` through `Visit::record_debug`, so
//! a formatter cannot distinguish a reviewed textual coordinate/error from an
//! opaque debug dump. Production call sites use this carrier instead: it records
//! through `record_str`. The production sink also preserves ordinary formatted
//! diagnostics; this helper does not sanitize or redact the supplied value.

use std::fmt;

/// Formats a reviewed display value into a native `String` tracing value.
///
/// `String` is one of tracing's sealed typed values and records through
/// `Visit::record_str`; ordinary `%Display` / `?Debug` diagnostics are also
/// supported by the production sink. Call sites remain responsible for not
/// embedding credentials in textual values.
pub fn safe_display<T: fmt::Display + ?Sized>(value: &T) -> String {
    value.to_string()
}
