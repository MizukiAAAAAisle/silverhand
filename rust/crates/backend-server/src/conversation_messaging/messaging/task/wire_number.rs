//! Canonical numeric grammars shared by the task HTTP faces.

use silverhand_backend_core::conversation_messaging::messaging::task::TaskNumber;

/// Query coordinates use the canonical ASCII spelling of a positive base-10
/// integer. JSON numbers have no spelling once decoded, but query strings do:
/// exponent, hex, signs, whitespace, and leading zeroes are deliberately not
/// aliases for the canonical decimal coordinate.
pub(super) fn parse_canonical_task_number(raw: &str) -> Option<TaskNumber> {
    let bytes = raw.as_bytes();
    if bytes.is_empty() || bytes[0] == b'0' || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    TaskNumber::new(raw.parse::<i64>().ok()?).ok()
}

pub(super) fn parse_canonical_limit(raw: &str, max: usize) -> Option<usize> {
    let value = parse_canonical_task_number(raw)?.get();
    let value = usize::try_from(value).ok()?;
    (value <= max).then_some(value)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Fixture {
        canonical_query: Vec<QueryCase>,
    }

    #[derive(Deserialize)]
    struct QueryCase {
        raw: String,
        accepted: bool,
        value: Option<i64>,
    }

    #[test]
    fn canonical_decimal_has_one_spelling_and_a_js_safe_ceiling() {
        let fixture: Fixture = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/shared/tests/fixtures/task-schedule-wire-canonicalization.json"
        )))
        .unwrap();
        for case in fixture.canonical_query {
            let parsed = parse_canonical_task_number(&case.raw).map(TaskNumber::get);
            assert_eq!(parsed.is_some(), case.accepted, "{:?}", case.raw);
            if case.accepted {
                assert_eq!(parsed, case.value, "{:?}", case.raw);
            }
        }
    }
}
