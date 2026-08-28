//! JavaScript-safe integer admission for host-control wire numbers.

/// Last integer every JavaScript client can receive without binary64 rounding.
const JS_SAFE_INTEGER_MAX: i64 = 9_007_199_254_740_991;

pub(crate) fn js_safe_integer(value: i64) -> bool {
    (-JS_SAFE_INTEGER_MAX..=JS_SAFE_INTEGER_MAX).contains(&value)
}
