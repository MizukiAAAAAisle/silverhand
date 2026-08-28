//! JavaScript-safe integer admission for host-control wire numbers.

use silverhand_backend_core::wire_number::JsSafeInteger;

pub(crate) fn js_safe_integer(value: i64) -> bool {
    JsSafeInteger::new(value).is_ok()
}
