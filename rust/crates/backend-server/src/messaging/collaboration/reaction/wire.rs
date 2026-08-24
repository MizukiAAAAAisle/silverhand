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
        count: fact.count(),
    }
}

pub(super) fn mutation_success(outcome: &ReactionMutationOutcome) -> Response {
    Json(MutationBody {
        changed: outcome.changed(),
        emoji: outcome.emoji().as_str(),
        count: outcome.count(),
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
pub(super) fn invalid_input() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error":"invalid input"})),
    )
        .into_response()
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
