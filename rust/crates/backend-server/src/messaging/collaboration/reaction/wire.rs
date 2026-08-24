use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use silverhand_backend_core::messaging::collaboration::reaction::{
    InvalidReactionEmoji, ReactionChange, ReactionChangedFact, ReactionDetail,
    ReactionMutationOutcome, ReactionMutationRefusal,
};

pub const MESSAGE_REACTION_CHANGED_EVENT: &str = "message_reaction_changed";

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    code: &'static str,
}

#[derive(Serialize)]
struct MutationBody<'a> {
    changed: bool,
    emoji: &'a str,
    count: i64,
}

#[derive(Serialize)]
struct DetailEnvelope<'a> {
    reactions: Vec<DetailBody<'a>>,
}

#[derive(Serialize)]
struct DetailBody<'a> {
    emoji: &'a str,
    reactors: Vec<ReactorBody<'a>>,
}

#[derive(Serialize)]
struct ReactorBody<'a> {
    kind: &'static str,
    id: &'a str,
    display_name: &'a str,
}

#[derive(Serialize)]
pub struct ReactionChangedBody<'a> {
    message_id: &'a str,
    conversation_id: &'a str,
    thread_root_id: Option<&'a str>,
    emoji: &'a str,
    op: &'static str,
    reactor_kind: &'static str,
    reactor_id: &'a str,
    count: i64,
}

pub fn changed_event(fact: &ReactionChangedFact) -> ReactionChangedBody<'_> {
    ReactionChangedBody {
        message_id: fact.message().as_str(),
        conversation_id: fact.conversation().as_str(),
        thread_root_id: fact.thread_root().map(|id| id.as_str()),
        emoji: fact.emoji().as_str(),
        op: match fact.change() {
            ReactionChange::Add => "add",
            ReactionChange::Remove => "remove",
        },
        reactor_kind: fact.reactor().kind(),
        reactor_id: fact.reactor().id(),
        count: fact.count().value(),
    }
}

pub(super) fn mutation_success(outcome: &ReactionMutationOutcome) -> Response {
    Json(MutationBody {
        changed: outcome.changed(),
        emoji: outcome.emoji().as_str(),
        count: outcome.count().value(),
    })
    .into_response()
}

pub(super) fn detail_success(detail: &[ReactionDetail]) -> Response {
    Json(DetailEnvelope {
        reactions: detail
            .iter()
            .map(|detail| DetailBody {
                emoji: detail.emoji().as_str(),
                reactors: detail
                    .reactors()
                    .iter()
                    .map(|reactor| ReactorBody {
                        kind: reactor.principal().kind(),
                        id: reactor.principal().id(),
                        display_name: reactor.display_name(),
                    })
                    .collect(),
            })
            .collect(),
    })
    .into_response()
}

pub(super) fn mutation_refusal(refusal: ReactionMutationRefusal) -> Response {
    match refusal {
        ReactionMutationRefusal::InvalidReaction(error) => invalid_reaction(error),
        ReactionMutationRefusal::TargetHidden => not_found(),
        ReactionMutationRefusal::MessageNotFound => coded(
            StatusCode::NOT_FOUND,
            "message not found",
            "message_not_found",
        ),
        ReactionMutationRefusal::SystemMessageNotReactable => coded(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cannot react to a system message",
            "system_message_not_reactable",
        ),
        ReactionMutationRefusal::ConversationNotFound => coded(
            StatusCode::NOT_FOUND,
            "conversation not found",
            "conversation_not_found",
        ),
        ReactionMutationRefusal::Forbidden => coded(
            StatusCode::FORBIDDEN,
            "cannot react in this conversation",
            "forbidden",
        ),
        ReactionMutationRefusal::CapabilityDenied => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "code": "capability_denied",
                "capability": "send_messages",
                "message": "missing 'send_messages' capability in this workspace",
                "details": { "capability": "send_messages" }
            })),
        )
            .into_response(),
        ReactionMutationRefusal::ConversationClosed => coded(
            StatusCode::CONFLICT,
            "conversation is closed",
            "conversation_closed",
        ),
        ReactionMutationRefusal::ConversationArchived => coded(
            StatusCode::CONFLICT,
            "conversation is archived",
            "conversation_archived",
        ),
    }
}

pub(super) fn invalid_reaction(error: InvalidReactionEmoji) -> Response {
    let message = match error {
        InvalidReactionEmoji::Empty => "emoji is empty",
        InvalidReactionEmoji::Whitespace => "emoji must not contain whitespace",
        InvalidReactionEmoji::TooLong => "emoji exceeds 16 chars",
        InvalidReactionEmoji::NotUnicodeEmoji => "emoji must be a Unicode emoji",
    };
    coded(
        StatusCode::UNPROCESSABLE_ENTITY,
        message,
        "invalid_reaction",
    )
}
pub(super) struct InvalidInput(Vec<serde_json::Value>);

impl InvalidInput {
    pub(super) fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error":"invalid input","issues":self.0})),
        )
            .into_response()
    }
}

pub(super) fn parse_human_body(bytes: &[u8]) -> Result<String, InvalidInput> {
    let value = serde_json::from_slice::<serde_json::Value>(bytes)
        .unwrap_or_else(|_| serde_json::json!({}));
    let object = match value.as_object() {
        Some(object) => object,
        None => return Err(invalid_root(&value)),
    };
    required_string(object.get("emoji"), "emoji").map_err(|issue| invalid_issues(vec![issue]))
}

pub(super) fn parse_agent_body(bytes: &[u8]) -> Result<(String, String), InvalidInput> {
    let value = serde_json::from_slice::<serde_json::Value>(bytes)
        .unwrap_or_else(|_| serde_json::json!({}));
    let object = match value.as_object() {
        Some(object) => object,
        None => return Err(invalid_root(&value)),
    };
    let mut issues = Vec::new();
    let message = match required_string(object.get("message_id"), "message_id") {
        Ok(message) if message.is_empty() => {
            issues.push(serde_json::json!({
                "code":"too_small",
                "minimum":1,
                "type":"string",
                "inclusive":true,
                "exact":false,
                "message":"String must contain at least 1 character(s)",
                "path":["message_id"]
            }));
            None
        }
        Ok(message) => Some(message),
        Err(issue) => {
            issues.push(issue);
            None
        }
    };
    let emoji = match required_string(object.get("emoji"), "emoji") {
        Ok(emoji) => Some(emoji),
        Err(issue) => {
            issues.push(issue);
            None
        }
    };
    match (message, emoji) {
        (Some(message), Some(emoji)) => Ok((message, emoji)),
        _ => Err(invalid_issues(issues)),
    }
}

fn required_string(
    value: Option<&serde_json::Value>,
    member: &'static str,
) -> Result<String, serde_json::Value> {
    match value {
        Some(serde_json::Value::String(value)) => Ok(value.clone()),
        value => {
            let received = value.map(json_type).unwrap_or("undefined");
            let message = if value.is_none() {
                "Required".to_owned()
            } else {
                format!("Expected string, received {received}")
            };
            Err(serde_json::json!({
                "code":"invalid_type",
                "expected":"string",
                "received":received,
                "path":[member],
                "message":message
            }))
        }
    }
}

fn invalid_root(value: &serde_json::Value) -> InvalidInput {
    let received = json_type(value);
    invalid_issues(vec![serde_json::json!({
        "code":"invalid_type",
        "expected":"object",
        "received":received,
        "path":[],
        "message":format!("Expected object, received {received}")
    })])
}

fn invalid_issues(issues: Vec<serde_json::Value>) -> InvalidInput {
    InvalidInput(issues)
}

fn json_type(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}
pub(super) fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({"error":"message not found"})),
    )
        .into_response()
}

pub(super) fn internal_error(message: &'static str) -> Response {
    tracing::error!("{message}");
    internal_error_response()
}

pub(super) fn internal_error_response() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
}

fn coded(status: StatusCode, error: &'static str, code: &'static str) -> Response {
    (status, Json(ErrorBody { error, code })).into_response()
}
