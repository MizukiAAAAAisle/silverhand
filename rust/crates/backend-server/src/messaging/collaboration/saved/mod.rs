//! Human-session HTTP adapters for the viewer-private saved-message capability.

mod wire;

pub use wire::{SAVED_CHANGED_EVENT, changed_event};

#[cfg(test)]
mod tests;

use std::sync::Arc;

use axum::{
    Router,
    extract::{Extension, Path, Query, State, rejection::QueryRejection},
    response::Response,
    routing::{get, post},
};
use serde::Deserialize;
use silverhand_backend_core::{
    identity::{AgentId, UserId, WorkspaceId},
    messaging::{
        MessageId,
        collaboration::saved::{
            SavedAftermath, SavedListQuery, SavedMutationPort, SavedReadPort, SavedSender,
            SavedSince, save_message, unsave_message,
        },
    },
};

use wire::{
    internal_error, internal_error_response, invalid_input, list_refusal, list_success,
    message_not_found, save_success, unsave_success,
};

pub const LIST_PATH: &str = "/api/saved";
pub const MUTATION_PATH: &str = "/api/messages/{id}/save";

struct Inner<R, M, A> {
    reads: R,
    mutations: M,
    aftermath: A,
}

struct SavedState<R, M, A>(Arc<Inner<R, M, A>>);

impl<R, M, A> Clone for SavedState<R, M, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<R, M, A>(reads: R, mutations: M, aftermath: A) -> Router
where
    R: SavedReadPort + Send + Sync + 'static,
    M: SavedMutationPort + Send + Sync + 'static,
    A: SavedAftermath + Send + Sync + 'static,
{
    let state = SavedState(Arc::new(Inner {
        reads,
        mutations,
        aftermath,
    }));
    Router::new()
        .route(LIST_PATH, get(list::<R, M, A>))
        .route(
            MUTATION_PATH,
            post(save::<R, M, A>).delete(unsave::<R, M, A>),
        )
        .with_state(state)
}

#[derive(Deserialize)]
struct MessagePath {
    id: String,
}

#[derive(Default, Deserialize)]
struct ListQueryWire {
    workspace_id: Option<String>,
    since: Option<String>,
    user_id: Option<String>,
    agent_id: Option<String>,
}

async fn list<R, M, A>(
    State(state): State<SavedState<R, M, A>>,
    principal: Option<Extension<UserId>>,
    query: Result<Query<ListQueryWire>, QueryRejection>,
) -> Response
where
    R: SavedReadPort,
    M: SavedMutationPort,
    A: SavedAftermath,
{
    let Some(Extension(viewer)) = principal else {
        return internal_error("saved route reached without human principal");
    };
    let query = match query {
        Ok(Query(query)) => match list_query(query) {
            Ok(query) => query,
            Err(issues) => return invalid_input(issues),
        },
        Err(_) => return invalid_input(Vec::new()),
    };
    match state.0.reads.list(&viewer, query).await {
        Ok(Ok(entries)) => list_success(&entries),
        Ok(Err(refusal)) => list_refusal(refusal),
        Err(error) => {
            tracing::error!(error_chain = %crate::error::describe(&error), "saved list read failed");
            internal_error_response()
        }
    }
}

fn list_query(raw: ListQueryWire) -> Result<SavedListQuery, Vec<serde_json::Value>> {
    // The workspace member uses a blank-only preprocessor but deliberately does
    // not trim a nonblank value. Sender ids use SearchOptionalStringSchema and
    // therefore return the ECMAScript-trimmed value. These are two distinct TS
    // production contracts despite looking similar at the wire edge.
    let workspace = blank_to_none(raw.workspace_id)
        .map(WorkspaceId::parse)
        .transpose()
        .map_err(|_| Vec::new())?;
    let since = match raw.since.filter(|value| !value.is_empty()) {
        None => None,
        Some(raw) => {
            let parsed = coerce_integer(&raw).map_err(|issue| {
                vec![match issue {
                    NumberIssue::Nan => json_issue(
                        "invalid_type",
                        "Expected number, received nan",
                        "nan",
                        "since",
                    ),
                    NumberIssue::Float => json_issue(
                        "invalid_type",
                        "Expected integer, received float",
                        "float",
                        "since",
                    ),
                }]
            })?;
            Some(match parsed {
                CoercedInteger::Persisted(value) => SavedSince::new(value).ok_or_else(|| {
                    vec![json_issue(
                        "too_small",
                        "Number must be greater than or equal to 0",
                        "number",
                        "since",
                    )]
                })?,
                CoercedInteger::BeyondPersistedRange => SavedSince::beyond_persisted_range(),
            })
        }
    };
    let human = search_optional(raw.user_id)
        .map(UserId::parse)
        .transpose()
        .map_err(|_| Vec::new())?;
    let agent = search_optional(raw.agent_id)
        .map(AgentId::parse)
        .transpose()
        .map_err(|_| Vec::new())?;
    let sender = match (human, agent) {
        (Some(_), Some(_)) => {
            return Err(vec![serde_json::json!({
                "code":"custom","message":"user_id and agent_id cannot both be set","path":["user_id"]
            })]);
        }
        (Some(human), None) => Some(SavedSender::Human(human)),
        (None, Some(agent)) => Some(SavedSender::Agent(agent)),
        (None, None) => None,
    };
    Ok(SavedListQuery {
        workspace,
        since,
        sender,
    })
}

fn json_issue(
    code: &'static str,
    message: &'static str,
    received: &'static str,
    member: &'static str,
) -> serde_json::Value {
    if code == "too_small" {
        return serde_json::json!({
            "code":"too_small","minimum":0,"type":"number","inclusive":true,
            "exact":false,"message":message,"path":[member]
        });
    }
    serde_json::json!({"code":code,"expected":if received == "float" { "integer" } else { "number" },"received":received,"path":[member],"message":message})
}

fn blank_to_none(raw: Option<String>) -> Option<String> {
    raw.filter(|value| !crate::messaging::admission::ecmascript_trim(value).is_empty())
}

fn search_optional(raw: Option<String>) -> Option<String> {
    raw.and_then(|value| {
        let trimmed = crate::messaging::admission::ecmascript_trim(&value);
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NumberIssue {
    Nan,
    Float,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CoercedInteger {
    Persisted(i64),
    BeyondPersistedRange,
}

/// The published query uses `z.coerce.number().int()`. Decimal spellings use
/// Rust's correctly-rounded binary64 parser. Power-of-two prefixes are parsed as
/// exact integers and rounded once, matching ECMAScript rather than repeatedly
/// rounding an accumulator.
fn coerce_integer(raw: &str) -> Result<CoercedInteger, NumberIssue> {
    let trimmed = crate::messaging::admission::ecmascript_trim(raw);
    let number = if trimmed.is_empty() {
        0.0
    } else if matches!(trimmed, "Infinity" | "+Infinity" | "-Infinity") {
        return Err(NumberIssue::Float);
    } else if let Some((digits, radix)) = prefixed_integer(trimmed) {
        return coerce_prefixed(digits, radix);
    } else {
        if !is_ecmascript_decimal_literal(trimmed) {
            return Err(NumberIssue::Nan);
        }
        trimmed.parse::<f64>().map_err(|_| NumberIssue::Nan)?
    };
    if number.is_nan() {
        return Err(NumberIssue::Nan);
    }
    if !number.is_finite() {
        return Err(NumberIssue::Float);
    }
    if number.fract() != 0.0 {
        return Err(NumberIssue::Float);
    }
    if number < 0.0 {
        return Ok(CoercedInteger::Persisted(-1));
    }
    // 2^63 is the first nonnegative integer outside SQLite's signed timestamp
    // domain. Comparing against this exact power-of-two avoids the lossy
    // `i64::MAX as f64` boundary, which is itself rounded up to 2^63.
    if number >= 9_223_372_036_854_775_808.0 {
        return Ok(CoercedInteger::BeyondPersistedRange);
    }
    Ok(CoercedInteger::Persisted(number as i64))
}

/// `f64::from_str` deliberately accepts Rust spellings such as `inf` and is
/// case-insensitive for several non-finite values. `Number(string)` does not:
/// after trimming and the exact `Infinity` spellings above, only the ECMAScript
/// decimal grammar may reach the binary64 parser.
fn is_ecmascript_decimal_literal(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut cursor = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let integer_start = cursor;
    while matches!(bytes.get(cursor), Some(b'0'..=b'9')) {
        cursor += 1;
    }
    let integer_digits = cursor - integer_start;

    let mut fraction_digits = 0;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let fraction_start = cursor;
        while matches!(bytes.get(cursor), Some(b'0'..=b'9')) {
            cursor += 1;
        }
        fraction_digits = cursor - fraction_start;
    }
    if integer_digits == 0 && fraction_digits == 0 {
        return false;
    }

    if matches!(bytes.get(cursor), Some(b'e' | b'E')) {
        cursor += 1;
        if matches!(bytes.get(cursor), Some(b'+' | b'-')) {
            cursor += 1;
        }
        let exponent_start = cursor;
        while matches!(bytes.get(cursor), Some(b'0'..=b'9')) {
            cursor += 1;
        }
        if cursor == exponent_start {
            return false;
        }
    }
    cursor == bytes.len()
}

fn coerce_prefixed(digits: &str, radix: u32) -> Result<CoercedInteger, NumberIssue> {
    let bits_per_digit = match radix {
        2 => 1,
        8 => 3,
        16 => 4,
        _ => return Err(NumberIssue::Nan),
    };
    if digits.is_empty() {
        return Err(NumberIssue::Nan);
    }

    let mut exact = Some(0_u64);
    let mut first_nonzero = None;
    for (index, byte) in digits.bytes().enumerate() {
        let Some(digit) = ascii_digit(byte, radix) else {
            return Err(NumberIssue::Nan);
        };
        if digit != 0 && first_nonzero.is_none() {
            first_nonzero = Some((index, digit));
        }
        exact = exact.and_then(|value| {
            value
                .checked_mul(u64::from(radix))
                .and_then(|value| value.checked_add(u64::from(digit)))
        });
    }
    let Some((first_index, first_digit)) = first_nonzero else {
        return Ok(CoercedInteger::Persisted(0));
    };

    if let Some(value) = exact.filter(|value| *value < (1_u64 << 63)) {
        let rounded = round_u64_to_binary64_integer(value);
        return if rounded < (1_u64 << 63) {
            Ok(CoercedInteger::Persisted(rounded as i64))
        } else {
            Ok(CoercedInteger::BeyondPersistedRange)
        };
    }

    let significant_digits = digits.len() - first_index;
    let first_bits = u32::BITS - first_digit.leading_zeros();
    let bit_length = (significant_digits - 1)
        .checked_mul(bits_per_digit)
        .and_then(|tail| tail.checked_add(first_bits as usize))
        .ok_or(NumberIssue::Float)?;
    match bit_length.cmp(&1024) {
        std::cmp::Ordering::Less => Ok(CoercedInteger::BeyondPersistedRange),
        std::cmp::Ordering::Greater => Err(NumberIssue::Float),
        std::cmp::Ordering::Equal => {
            // The round-to-infinity threshold is 2^1024 - 2^970: its leading
            // 54 bits are ones and every lower bit is zero. At the exact tie,
            // round-to-nearest-even chooses Infinity. Any 1024-bit integer whose
            // first 54 significant bits are not all one remains finite.
            if leading_significant_bits_are_ones(digits, radix, 54) {
                Err(NumberIssue::Float)
            } else {
                Ok(CoercedInteger::BeyondPersistedRange)
            }
        }
    }
}

fn ascii_digit(byte: u8, radix: u32) -> Option<u32> {
    let value = match byte {
        b'0'..=b'9' => u32::from(byte - b'0'),
        b'a'..=b'f' => 10 + u32::from(byte - b'a'),
        b'A'..=b'F' => 10 + u32::from(byte - b'A'),
        _ => return None,
    };
    (value < radix).then_some(value)
}

fn round_u64_to_binary64_integer(value: u64) -> u64 {
    let bit_length = u64::BITS - value.leading_zeros();
    if bit_length <= 53 {
        return value;
    }
    let shift = bit_length - 53;
    let unit = 1_u64 << shift;
    let retained = value >> shift;
    let remainder = value & (unit - 1);
    let halfway = unit >> 1;
    let round_up = remainder > halfway || (remainder == halfway && retained & 1 == 1);
    (retained + u64::from(round_up)) << shift
}

fn leading_significant_bits_are_ones(digits: &str, radix: u32, wanted: usize) -> bool {
    let bits_per_digit = match radix {
        2 => 1,
        8 => 3,
        16 => 4,
        _ => return false,
    };
    let mut started = false;
    let mut seen = 0;
    for byte in digits.bytes() {
        let digit = ascii_digit(byte, radix).expect("digits were validated before classification");
        for bit in (0..bits_per_digit).rev() {
            let set = digit & (1 << bit) != 0;
            if !started {
                if !set {
                    continue;
                }
                started = true;
            }
            if !set {
                return false;
            }
            seen += 1;
            if seen == wanted {
                return true;
            }
        }
    }
    false
}

fn prefixed_integer(raw: &str) -> Option<(&str, u32)> {
    raw.strip_prefix("0x")
        .or_else(|| raw.strip_prefix("0X"))
        .map(|digits| (digits, 16))
        .or_else(|| {
            raw.strip_prefix("0b")
                .or_else(|| raw.strip_prefix("0B"))
                .map(|digits| (digits, 2))
        })
        .or_else(|| {
            raw.strip_prefix("0o")
                .or_else(|| raw.strip_prefix("0O"))
                .map(|digits| (digits, 8))
        })
}

async fn save<R, M, A>(
    State(state): State<SavedState<R, M, A>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<MessagePath>,
) -> Response
where
    R: SavedReadPort,
    M: SavedMutationPort,
    A: SavedAftermath,
{
    let Some(Extension(viewer)) = principal else {
        return internal_error("saved route reached without human principal");
    };
    let Ok(message) = MessageId::parse(path.id) else {
        return message_not_found();
    };
    match save_message(&state.0.mutations, &state.0.aftermath, viewer, message).await {
        Ok(Ok(execution)) => save_success(execution),
        Ok(Err(_)) => message_not_found(),
        Err(error) => {
            tracing::error!(error_chain = %crate::error::describe(&error), "save message failed");
            internal_error_response()
        }
    }
}

async fn unsave<R, M, A>(
    State(state): State<SavedState<R, M, A>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<MessagePath>,
) -> Response
where
    R: SavedReadPort,
    M: SavedMutationPort,
    A: SavedAftermath,
{
    let Some(Extension(viewer)) = principal else {
        return internal_error("saved route reached without human principal");
    };
    let Ok(message) = MessageId::parse(path.id) else {
        return message_not_found();
    };
    match unsave_message(&state.0.mutations, &state.0.aftermath, viewer, message).await {
        Ok(Ok(execution)) => unsave_success(execution),
        Ok(Err(_)) => message_not_found(),
        Err(error) => {
            tracing::error!(error_chain = %crate::error::describe(&error), "unsave message failed");
            internal_error_response()
        }
    }
}
