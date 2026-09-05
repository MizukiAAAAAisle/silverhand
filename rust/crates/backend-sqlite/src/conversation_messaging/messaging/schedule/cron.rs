//! Production five-field cron evaluator with IANA timezone semantics.
//!
//! Parsing and calendar search belong to `croner`; this adapter only seals the
//! narrower wire grammar exposed by the TypeScript `cron-parser@4.9.0` path.
//! In particular, seconds/year fields, aliases, and CroneR-only extensions are
//! refused rather than becoming accidental compatibility entry points.

use chrono::{Duration, Offset, TimeZone, Utc};
use chrono_tz::Tz;
use croner::{
    Cron,
    parser::{CronParser, Seconds, Year},
};
use silverhand_backend_core::conversation_messaging::messaging::schedule::{
    CronNextOccurrence, CronOutcome, CronQuery,
};
use silverhand_backend_core::foundation::name_canonicalization::is_ecmascript_trim_whitespace;

#[derive(Clone, Copy, Debug, Default)]
pub struct ProductionCronEvaluator;

fn parser() -> CronParser {
    CronParser::builder()
        .seconds(Seconds::Disallowed)
        .year(Year::Disallowed)
        // `cron-parser@4.9.0` accepts single-value steps (`1/5`). CroneR's
        // strict mode intentionally does not, so the compatibility adapter
        // opts into the legacy range expansion explicitly.
        .sloppy_ranges(true)
        .build()
}

/// CroneR deliberately supports a superset of the current TS grammar. Keep
/// only the differences that its parser would otherwise accept:
///
/// - aliases and seconds/year forms are outside the five-field contract;
/// - `?` is accepted by cron-parser only for day-of-month/day-of-week;
/// - closest-weekday `W`, DOM/DOW conjunction `+`, `#L`, and a leading `/step`
///   are CroneR extensions rejected by cron-parser@4.9.0.
fn canonicalize_ts_field(raw: &str, min: u8, max: u8, question_mark: bool) -> Option<String> {
    if raw.contains('?') && !question_mark {
        return None;
    }
    // cron-parser expands `?` to the field range before sequence/range/step
    // parsing. Replaying that normalization makes CroneR accept the same list
    // and step forms (`?,1`, `?/2`, `?,MON`). Keep ordinary `*` intact: CroneR
    // uses its wildcard marker to preserve DOM-vs-DOW OR semantics.
    let range = format!("{min}-{max}");
    let expanded = if raw == "?" {
        "*".to_owned()
    } else if raw.contains('?') {
        if raw.contains('*') {
            return None;
        }
        raw.replace('?', &range)
    } else {
        raw.to_owned()
    };
    Some(expanded)
}

fn canonicalize_ts_day_of_month_l(field: String) -> String {
    field
        .split(',')
        .map(|item| {
            // cron-parser treats any non-range DOM atom containing uppercase L
            // (`L`, `1L`, `15L`) as the same last-day sentinel. CroneR accepts
            // only canonical `L`, so erase the ignored numeric prefix.
            if item.contains('L') { "L" } else { item }
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn has_canonical_ts_day_of_month_l(field: &str) -> bool {
    if !field.contains('L') {
        return true;
    }
    // Keep the deliberate shared grammar narrower than cron-parser's accidental
    // acceptance of `L/2`, `*,L`, duplicate L, out-of-range prefixes, and other
    // ignored decorations. One canonical last-day atom may be combined with
    // ordinary numeric list members (`L,1` / `1L,2`).
    if field.contains(['*', '?', '/', '-']) {
        return false;
    }
    let mut last_atoms = 0;
    for item in field.split(',') {
        if !item.contains('L') {
            continue;
        }
        last_atoms += 1;
        let Some(prefix) = item.strip_suffix('L') else {
            return false;
        };
        if prefix.contains('L')
            || (!prefix.is_empty()
                && (prefix.len() > 1 && prefix.starts_with('0')
                    || !prefix.bytes().all(|byte| byte.is_ascii_digit())
                    || !matches!(prefix.parse::<u8>(), Ok(1..=31))))
        {
            return false;
        }
    }
    last_atoms == 1
}

fn canonicalize_ts_day_of_week_l(field: String) -> String {
    // cron-parser treats weekday 7 as Sunday everywhere. CroneR normalizes the
    // ordinary and nth bitsets but not LAST, so bind that one representation.
    field
        .split(',')
        .map(|item| if item == "7L" { "0L" } else { item })
        .collect::<Vec<_>>()
        .join(",")
}

fn canonical_typescript_expression(expression: &str) -> Option<String> {
    let trimmed = expression.trim_matches(is_ecmascript_trim_whitespace);
    if trimmed.starts_with('@') {
        return None;
    }
    // JS's `/\s+/` uses the ECMAScript whitespace set, which intentionally
    // differs from Rust `split_whitespace` (FEFF is included; U+0085 is not).
    // Canonicalizing recognized separators to ASCII spaces also keeps CroneR
    // from silently choosing Rust's host-language whitespace grammar.
    let fields: Vec<_> = trimmed
        .split(is_ecmascript_trim_whitespace)
        .filter(|field| !field.is_empty())
        .collect();
    if fields.len() != 5 {
        return None;
    }
    if fields
        .iter()
        .any(|field| field.starts_with('/') || field.contains('+'))
    {
        return None;
    }
    if fields[2].bytes().any(|byte| matches!(byte, b'W' | b'w')) {
        return None;
    }
    if fields[2].contains('l') || fields[4].contains('l') {
        return None;
    }
    if !has_canonical_ts_day_of_month_l(fields[2]) {
        return None;
    }
    if fields[4].contains('#') {
        // cron-parser's `parseNthDay` is intentionally narrower than CroneR:
        // nth-DOW cannot be composed with list, step, or range syntax.
        if fields[4].contains([',', '/', '-']) {
            return None;
        }
        let (weekday, nth) = fields[4].split_once('#')?;
        if weekday.is_empty()
            || nth.len() != 1
            || !matches!(nth.as_bytes()[0], b'1'..=b'5')
            || fields[4].matches('#').count() != 1
        {
            return None;
        }
    }
    let mut canonical = [
        canonicalize_ts_field(fields[0], 0, 59, false)?,
        canonicalize_ts_field(fields[1], 0, 23, false)?,
        canonicalize_ts_field(fields[2], 1, 31, true)?,
        canonicalize_ts_field(fields[3], 1, 12, false)?,
        canonicalize_ts_field(fields[4], 0, 7, true)?,
    ];
    canonical[2] = canonicalize_ts_day_of_month_l(std::mem::take(&mut canonical[2]));
    canonical[4] = canonicalize_ts_day_of_week_l(std::mem::take(&mut canonical[4]));
    Some(canonical.join(" "))
}

/// CroneR deliberately fires a fixed-time job at the first valid instant after
/// a DST gap. cron-parser/Luxon instead preserves the minute within the missing
/// hour (`02:30` becomes `03:30`). CroneR signals that special case by returning
/// an instant which does not itself match the parsed pattern. Translate only
/// that bounded gap window; ordinary occurrences stay entirely library-owned.
fn preserve_cron_parser_gap_offset(
    schedule: &Cron,
    next: chrono::DateTime<Tz>,
) -> chrono::DateTime<Tz> {
    if schedule.is_time_matching(&next).unwrap_or(false) {
        return next;
    }
    let Some(previous) = next.checked_sub_signed(Duration::minutes(1)) else {
        return next;
    };
    let jump = next.offset().fix().local_minus_utc() - previous.offset().fix().local_minus_utc();
    if jump <= 0 || jump % 60 != 0 {
        return next;
    }
    for minute in 0..jump.div_euclid(60) {
        let Some(actual) = next.checked_add_signed(Duration::minutes(i64::from(minute))) else {
            break;
        };
        let Some(virtual_local) = actual
            .naive_local()
            .checked_sub_signed(Duration::seconds(i64::from(jump)))
        else {
            break;
        };
        let virtual_time = Utc.from_utc_datetime(&virtual_local);
        if schedule.is_time_matching(&virtual_time).unwrap_or(false) {
            return actual;
        }
    }
    next
}

impl CronNextOccurrence for ProductionCronEvaluator {
    fn next_after(&self, query: CronQuery<'_>) -> CronOutcome {
        // TS validates repeat bounds before entering this adapter, then the
        // timezone before the expression. Keep the latter precedence here so
        // invalid-timezone × invalid-expression cannot flip error codes.
        let Ok(timezone) = query.timezone.parse::<Tz>() else {
            return CronOutcome::InvalidTimezone;
        };
        let Some(expression) = canonical_typescript_expression(query.expression) else {
            return CronOutcome::InvalidExpression;
        };
        let Ok(schedule) = parser().parse(&expression) else {
            return CronOutcome::InvalidExpression;
        };
        let Some(after) = Utc.timestamp_millis_opt(query.after).single() else {
            return CronOutcome::NoFutureOccurrence;
        };
        match schedule.find_next_occurrence(&after.with_timezone(&timezone), false) {
            Ok(next) => CronOutcome::NextInstant(
                preserve_cron_parser_gap_offset(&schedule, next).timestamp_millis(),
            ),
            Err(_) => CronOutcome::NoFutureOccurrence,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashSet,
        time::{Duration, Instant},
    };

    use serde::Deserialize;

    use super::*;

    const SHARED_FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/shared/tests/fixtures/schedule-cron-production-parity.json"
    ));

    #[derive(Debug, Deserialize)]
    struct Fixture {
        authority: FixtureAuthority,
        cases: Vec<Case>,
    }

    #[derive(Debug, Deserialize)]
    struct FixtureAuthority {
        signer: String,
        engine: String,
        consumer: String,
    }

    #[derive(Debug, Deserialize)]
    struct Case {
        name: String,
        expression: String,
        timezone: String,
        after: i64,
        expected: Expected,
    }

    #[derive(Debug, Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum Expected {
        Next { instant: i64 },
        Error { code: String },
    }

    fn outcome_code(outcome: CronOutcome) -> Expected {
        match outcome {
            CronOutcome::NextInstant(instant) => Expected::Next { instant },
            CronOutcome::InvalidTimezone => Expected::Error {
                code: "invalid_timezone".into(),
            },
            CronOutcome::InvalidExpression | CronOutcome::NoFutureOccurrence => Expected::Error {
                code: "invalid_cron_expression".into(),
            },
        }
    }

    #[test]
    fn production_adapter_consumes_the_ts_signed_shared_fixture() {
        let fixture: Fixture = serde_json::from_str(SHARED_FIXTURE).unwrap();
        assert_eq!(
            fixture.authority.signer,
            "packages/backend ScheduleService.create"
        );
        assert_eq!(fixture.authority.engine, "cron-parser@4.9.0");
        assert_eq!(
            fixture.authority.consumer,
            "rust backend-sqlite ProductionCronEvaluator"
        );
        assert_eq!(fixture.cases.len(), 32);
        assert_eq!(
            fixture
                .cases
                .iter()
                .map(|case| case.name.as_str())
                .collect::<HashSet<_>>()
                .len(),
            32,
            "shared cron case names must be unique"
        );
        for case in fixture.cases {
            let actual = outcome_code(ProductionCronEvaluator.next_after(CronQuery {
                expression: &case.expression,
                timezone: &case.timezone,
                after: case.after,
            }));
            match (actual, case.expected) {
                (Expected::Next { instant: actual }, Expected::Next { instant: expected }) => {
                    assert_eq!(actual, expected, "{}", case.name);
                }
                (Expected::Error { code: actual }, Expected::Error { code: expected }) => {
                    assert_eq!(actual, expected, "{}", case.name);
                }
                (actual, expected) => panic!("{}: {actual:?} != {expected:?}", case.name),
            }
        }
    }

    #[test]
    fn impossible_calendar_search_is_component_bounded_not_a_minute_scan() {
        let started = Instant::now();
        for _ in 0..8 {
            let outcome = ProductionCronEvaluator.next_after(CronQuery {
                expression: "0 0 31 2 *",
                timezone: "UTC",
                after: 1_767_225_600_000,
            });
            assert_eq!(outcome, CronOutcome::NoFutureOccurrence);
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "component search unexpectedly took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn adapter_does_not_expose_noncanonical_cron_parser_dom_l_quirks() {
        for expression in ["0 9 L/2 * *", "0 9 *,L * *", "0 9 L,L * *", "0 9 32L * *"] {
            assert_eq!(
                ProductionCronEvaluator.next_after(CronQuery {
                    expression,
                    timezone: "UTC",
                    after: 1_767_225_600_000,
                }),
                CronOutcome::InvalidExpression,
                "{expression}"
            );
        }
    }
}
