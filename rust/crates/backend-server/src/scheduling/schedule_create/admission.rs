//! Inbound wire admission for `POST /internal/agents/{aid}/schedules`.
//!
//! Stage one of the create door, in the governance model the mounted write faces
//! share (frozen `#2236`): a typed Serde DTO owns structure and Zod's strict-vs-
//! strip behavior, a `garde` stateless rule owns the field predicates that need no
//! cross-field context, and the DTO's [`TryFrom`] owns normalization, the domain-id
//! parses, the numeric JS-safe bounds, and the cross-field `once` refinement. Any of
//! those failing is ONE semantic refusal ([`ScheduleAdmissionRefusal::Invalid`],
//! rendered `422 {"error":"invalid input"}`); the door never publishes a
//! validation-issue schema, and the order the rules fire in is not a wire contract.
//!
//! It cannot see a principal or the resolved destination — the address the wire
//! carries (`target_conversation`) rides through as the RAW STRING, because its
//! grammar has exactly one authority (the shared
//! [`TargetAddress`](silverhand_backend_core::conversation_messaging::messaging::pre_send::TargetAddress)
//! resolver the send door uses) and restating any of it here would give the system
//! two answers to "is this a legal address". The DTO's only rule for it is
//! non-emptiness, so an empty string never reaches resolution.
//!
//! What comes out is a [`ValidatedScheduleDefinition`]: the delivery payload as
//! value objects, the pre-canonical [`ScheduleSpecInput`], and the two caps + the
//! `allow_unbounded` opt-in — everything the core
//! [`ScheduleCreateRequest`](silverhand_backend_core::conversation_messaging::messaging::schedule::ScheduleCreateRequest)
//! needs EXCEPT the owner (from the principal) and the resolved target (from the
//! resolver). The Zod schema strips unknown keys (`z.object` without `.strict()`),
//! so the DTO does NOT `deny_unknown_fields`.

use garde::Validate;
use serde::Deserialize;
use silverhand_backend_core::conversation_messaging::messaging::schedule::{
    OnceWhen, ScheduleMessage, ScheduleSpecInput, ScheduleTitle,
};
use silverhand_backend_core::foundation::wire_number::JsSafeInteger;

use crate::conversation_messaging::messaging::admission::ecmascript_trim;
use crate::foundation::wire_patch::RequiredPatchField;

/// One semantic refusal for the whole admission stage. Rendered by the route as
/// the minimal `422 {"error":"invalid input"}`; the raw string address, the failing
/// field, and the rule that fired are deliberately NOT on the wire.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ScheduleAdmissionRefusal;

/// A JSON integer decoded as a native `i64` on the wire, then narrowed to a JS-safe
/// value in [`TryFrom`]. Serde owns the structural "is an integer" rule (a float or
/// a string is a native rejection); the exact-binary64 bound is the domain rule,
/// applied once here so no field re-spells `2^53-1`.
fn js_safe(value: i64) -> Result<i64, ScheduleAdmissionRefusal> {
    JsSafeInteger::new(value)
        .map(|v| v.get())
        .map_err(|_| ScheduleAdmissionRefusal)
}

fn positive_js_safe(value: i64) -> Result<i64, ScheduleAdmissionRefusal> {
    let value = js_safe(value)?;
    (value > 0).then_some(value).ok_or(ScheduleAdmissionRefusal)
}

fn positive_js_safe_opt(value: Option<i64>) -> Result<Option<i64>, ScheduleAdmissionRefusal> {
    value.map(positive_js_safe).transpose()
}

/// The `spec` union as it arrives, tagged by `kind`. `once` uses the CREATE input
/// shape (`fire_at`/`delay_seconds` both optional — exclusivity is the cross-field
/// refine), distinct from the persisted/read `spec` union. Integers are native
/// `i64` here and narrowed to JS-safe in [`TryFrom`], matching
/// `ScheduleSpecSchema`'s `z.number().int()`.
#[derive(Debug, Deserialize, Validate)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WireSpec {
    Once {
        #[garde(skip)]
        #[serde(default)]
        fire_at: RequiredPatchField<i64>,
        #[garde(skip)]
        #[serde(default)]
        delay_seconds: RequiredPatchField<i64>,
    },
    Interval {
        #[garde(skip)]
        every_seconds: i64,
        #[garde(skip)]
        #[serde(default)]
        start_at: RequiredPatchField<i64>,
    },
    Cron {
        #[garde(skip)]
        expression: String,
        #[garde(skip)]
        timezone: String,
    },
}

/// The create body. `title`/`message` keep their raw form here. The wire boundary
/// applies the reference's ECMAScript trim to `title` before the strict persisted
/// decoder validates the canonical result; `message` is never trimmed. Both
/// UTF-16 ceilings remain owned by the value objects. `spec` is the tagged union;
/// the caps and the unbounded opt-in are optional positives.
#[derive(Debug, Deserialize, Validate)]
pub(super) struct ScheduleCreateBody {
    #[garde(skip)]
    title: String,
    #[garde(skip)]
    message: String,
    #[garde(dive)]
    spec: WireSpec,
    #[garde(skip)]
    #[serde(default)]
    max_occurrences: RequiredPatchField<i64>,
    #[garde(skip)]
    #[serde(default)]
    until_at: RequiredPatchField<i64>,
    #[garde(skip)]
    #[serde(default)]
    allow_unbounded: RequiredPatchField<bool>,
    /// The absolute destination address, resolved by the shared target resolver at
    /// the route. Non-empty is the only wire rule (matching `z.string().min(1)`).
    #[garde(length(min = 1))]
    target_conversation: String,
}

/// A create request validated in domain vocabulary EXCEPT for the owner and the
/// resolved destination: the payload value objects, the pre-canonical spec, the
/// caps, the unbounded opt-in, and the raw address for the resolver. The route
/// completes it into a core `ScheduleCreateRequest` once it has the principal and
/// the resolved conversation id.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ValidatedScheduleDefinition {
    pub(super) title: ScheduleTitle,
    pub(super) message: ScheduleMessage,
    pub(super) spec: ScheduleSpecInput,
    pub(super) max_occurrences: Option<i64>,
    pub(super) until_at: Option<i64>,
    pub(super) allow_unbounded: bool,
    pub(super) target_conversation: String,
}

impl TryFrom<ScheduleCreateBody> for ValidatedScheduleDefinition {
    type Error = ScheduleAdmissionRefusal;

    fn try_from(body: ScheduleCreateBody) -> Result<Self, Self::Error> {
        // Wire title normalization and persisted decoding are deliberately two
        // different authorities. TS `.trim()` accepts padded input and persists
        // the canonical string; `ScheduleTitle` then proves that the value handed
        // to persistence is already canonical (and remains strict when decoding a
        // row). The shared helper is the exact ECMAScript set: FEFF trims, NEL does
        // not. UTF-16 length is checked after normalization by the value object.
        let canonical_title = ecmascript_trim(&body.title);
        let title = ScheduleTitle::parse(canonical_title).map_err(|_| ScheduleAdmissionRefusal)?;
        let message = ScheduleMessage::parse(body.message).map_err(|_| ScheduleAdmissionRefusal)?;

        let is_once = matches!(body.spec, WireSpec::Once { .. });

        // Cross-field: repeat-only knobs are REJECTED on `once` (strict-reject, not
        // silent-ignore — a `once` DTO that claimed `max_occurrences` would be a
        // row that can only fire once). Mirrors the wire `superRefine`.
        if is_once
            && (matches!(body.max_occurrences, RequiredPatchField::Value(_))
                || matches!(body.until_at, RequiredPatchField::Value(_))
                || matches!(body.allow_unbounded, RequiredPatchField::Value(_)))
        {
            return Err(ScheduleAdmissionRefusal);
        }

        let spec = match body.spec {
            WireSpec::Once {
                fire_at,
                delay_seconds,
            } => {
                // Exactly one of fire_at / delay_seconds (`!!fire_at === !!delay`).
                let when = match (fire_at.into_option(), delay_seconds.into_option()) {
                    (Some(fire_at), None) => OnceWhen::FireAt(positive_js_safe(fire_at)?),
                    (None, Some(delay)) => OnceWhen::DelaySeconds(positive_js_safe(delay)?),
                    _ => return Err(ScheduleAdmissionRefusal),
                };
                ScheduleSpecInput::Once(when)
            }
            WireSpec::Interval {
                every_seconds,
                start_at,
            } => ScheduleSpecInput::Interval {
                every_seconds: {
                    let every = positive_js_safe(every_seconds)?;
                    (every >= 60)
                        .then_some(every)
                        .ok_or(ScheduleAdmissionRefusal)?
                },
                start_at: positive_js_safe_opt(start_at.into_option())?,
            },
            WireSpec::Cron {
                expression,
                timezone,
            } => {
                // Zod string length is JavaScript `String.length` (UTF-16 code
                // units), not Unicode scalar count. Keep both fields at the wire
                // boundary so an astral-heavy invalid value never reaches target
                // resolution or the cron evaluator.
                if expression.is_empty()
                    || expression.encode_utf16().count() > 200
                    || timezone.is_empty()
                    || timezone.encode_utf16().count() > 64
                {
                    return Err(ScheduleAdmissionRefusal);
                }
                ScheduleSpecInput::Cron {
                    expression,
                    timezone,
                }
            }
        };

        Ok(ValidatedScheduleDefinition {
            title,
            message,
            spec,
            max_occurrences: positive_js_safe_opt(body.max_occurrences.into_option())?,
            until_at: positive_js_safe_opt(body.until_at.into_option())?,
            allow_unbounded: body.allow_unbounded.into_option().unwrap_or(false),
            target_conversation: body.target_conversation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Result<ValidatedScheduleDefinition, ()> {
        let body: ScheduleCreateBody = serde_json::from_str(json).map_err(|_| ())?;
        // Mirror the production `ValidatedJson` path: the garde stateless rules run
        // before the `TryFrom` normalization/refine.
        body.validate().map_err(|_| ())?;
        ValidatedScheduleDefinition::try_from(body).map_err(|_| ())
    }

    #[test]
    fn a_well_formed_once_with_fire_at_is_admitted() {
        let def = parse(
            r#"{"title":"digest","message":"hi","spec":{"kind":"once","fire_at":10000000},"target_conversation":"dm:@bob"}"#,
        )
        .expect("valid once");
        assert!(matches!(
            def.spec,
            ScheduleSpecInput::Once(OnceWhen::FireAt(10000000))
        ));
        assert_eq!(def.target_conversation, "dm:@bob");
        assert!(!def.allow_unbounded);
    }

    #[test]
    fn a_once_with_both_fire_at_and_delay_is_refused() {
        assert!(parse(
            r#"{"title":"d","message":"hi","spec":{"kind":"once","fire_at":10000000,"delay_seconds":60},"target_conversation":"c"}"#,
        )
        .is_err());
    }

    #[test]
    fn a_once_with_neither_fire_at_nor_delay_is_refused() {
        assert!(
            parse(
                r#"{"title":"d","message":"hi","spec":{"kind":"once"},"target_conversation":"c"}"#,
            )
            .is_err()
        );
    }

    #[test]
    fn repeat_only_knobs_on_a_once_are_refused() {
        for knob in [
            r#""max_occurrences":3"#,
            r#""until_at":99999999999"#,
            r#""allow_unbounded":true"#,
        ] {
            let json = format!(
                r#"{{"title":"d","message":"hi","spec":{{"kind":"once","fire_at":10000000}},{knob},"target_conversation":"c"}}"#,
            );
            assert!(parse(&json).is_err(), "once must reject {knob}");
        }
    }

    #[test]
    fn an_interval_carries_every_seconds_and_optional_start_at() {
        let def = parse(
            r#"{"title":"d","message":"hi","spec":{"kind":"interval","every_seconds":60},"allow_unbounded":true,"target_conversation":"c"}"#,
        )
        .expect("valid interval");
        assert!(matches!(
            def.spec,
            ScheduleSpecInput::Interval {
                every_seconds: 60,
                start_at: None
            }
        ));
        assert!(def.allow_unbounded);
    }

    #[test]
    fn an_empty_title_is_refused_by_the_value_object() {
        assert!(parse(
            r#"{"title":"","message":"hi","spec":{"kind":"once","fire_at":10000000},"target_conversation":"c"}"#,
        )
        .is_err());
    }

    #[test]
    fn title_is_ecmascript_trimmed_before_persisted_value_decoding() {
        for (raw, expected) in [
            ("  digest  ", "digest"),
            ("\u{feff}digest\u{feff}", "digest"),
        ] {
            let json = serde_json::json!({
                "title": raw,
                "message": "  message stays padded  ",
                "spec": {"kind": "once", "fire_at": 10_000_000},
                "target_conversation": "c"
            });
            let def = parse(&json.to_string()).expect("wire padding is normalized");
            assert_eq!(def.title.as_str(), expected);
            assert_eq!(def.message.as_str(), "  message stays padded  ");
        }
    }

    #[test]
    fn title_trim_uses_the_ecmascript_set_in_both_directions() {
        let all_whitespace = serde_json::json!({
            "title": " \u{feff}\t",
            "message": "hi",
            "spec": {"kind": "once", "fire_at": 10_000_000},
            "target_conversation": "c"
        });
        assert!(parse(&all_whitespace.to_string()).is_err());

        // U+0085 is Unicode White_Space but is not ECMAScript trim whitespace.
        // It is therefore retained as content and participates in the UTF-16
        // length contract.
        let nel = serde_json::json!({
            "title": "\u{0085}digest\u{0085}",
            "message": "hi",
            "spec": {"kind": "once", "fire_at": 10_000_000},
            "target_conversation": "c"
        });
        let def = parse(&nel.to_string()).expect("NEL is legal title content");
        assert_eq!(def.title.as_str(), "\u{0085}digest\u{0085}");
    }

    #[test]
    fn cron_string_bounds_count_utf16_units_like_javascript() {
        let json_for = |expression: String, timezone: String| {
            serde_json::json!({
                "title": "d",
                "message": "hi",
                "spec": {"kind": "cron", "expression": expression, "timezone": timezone},
                "allow_unbounded": true,
                "target_conversation": "c"
            })
            .to_string()
        };

        assert!(parse(&json_for("x".repeat(200), "x".repeat(64))).is_ok());
        assert!(parse(&json_for("😀".repeat(101), "UTC".to_owned())).is_err());
        assert!(parse(&json_for("* * * * *".to_owned(), "😀".repeat(33))).is_err());
    }

    #[test]
    fn an_empty_target_address_is_refused() {
        assert!(parse(
            r#"{"title":"d","message":"hi","spec":{"kind":"once","fire_at":10000000},"target_conversation":""}"#,
        )
        .is_err());
    }

    #[test]
    fn a_top_level_array_is_not_an_object_body() {
        // A JSON array does not deserialize into the named struct; the route's
        // ObjectOnly floor also rejects it before this point.
        assert!(parse(r#"[{"title":"d"}]"#).is_err());
    }

    #[test]
    fn an_unsafe_integer_fire_at_is_refused() {
        // 2^53 is not representable exactly in JavaScript; the JS-safe decoder
        // refuses it at the wire boundary.
        assert!(parse(
            r#"{"title":"d","message":"hi","spec":{"kind":"once","fire_at":9007199254740992},"target_conversation":"c"}"#,
        )
        .is_err());
    }

    #[test]
    fn all_six_create_numbers_consume_the_shared_positive_js_safe_corpus() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/shared/tests/fixtures/task-schedule-wire-canonicalization.json"
        )))
        .unwrap();
        for case in fixture["positive_js_safe"].as_array().unwrap() {
            let value = case["value"].clone();
            let accepted = case["accepted"].as_bool().unwrap();
            let bodies = [
                serde_json::json!({
                    "title":"d","message":"hi","target_conversation":"c",
                    "spec":{"kind":"once","fire_at":value.clone()}
                }),
                serde_json::json!({
                    "title":"d","message":"hi","target_conversation":"c",
                    "spec":{"kind":"once","delay_seconds":value.clone()}
                }),
                serde_json::json!({
                    "title":"d","message":"hi","target_conversation":"c",
                    "spec":{"kind":"interval","every_seconds":60,"start_at":value.clone()},
                    "max_occurrences":1
                }),
                serde_json::json!({
                    "title":"d","message":"hi","target_conversation":"c",
                    "spec":{"kind":"interval","every_seconds":60},
                    "until_at":value.clone()
                }),
                serde_json::json!({
                    "title":"d","message":"hi","target_conversation":"c",
                    "spec":{"kind":"interval","every_seconds":60},
                    "max_occurrences":value
                }),
            ];
            for body in bodies {
                assert_eq!(parse(&body.to_string()).is_ok(), accepted, "{case}: {body}");
            }
        }

        for (every, accepted) in [
            (60_i64, true),
            (59_i64, false),
            (9_007_199_254_740_992_i64, false),
        ] {
            let body = serde_json::json!({
                "title":"d","message":"hi","target_conversation":"c",
                "spec":{"kind":"interval","every_seconds":every},
                "max_occurrences":1
            });
            assert_eq!(parse(&body.to_string()).is_ok(), accepted, "{body}");
        }
    }

    #[test]
    fn unknown_top_level_keys_are_stripped_not_rejected() {
        // Zod `z.object` strips unknown keys; the DTO matches (no
        // `deny_unknown_fields`), so an extra key is ignored, not a 400.
        let def = parse(
            r#"{"title":"d","message":"hi","spec":{"kind":"once","fire_at":10000000},"target_conversation":"c","extra":true}"#,
        )
        .expect("unknown key stripped");
        assert_eq!(def.target_conversation, "c");
    }
}
