//! Authenticated HTTP adapter for one conversation's persisted message window.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use silverhand_backend_core::{
    identity::{ConversationId, UserId},
    messaging::{
        MessageId, MessageSeq, PrincipalIdentity,
        collaboration::conversation_message_window::{
            BoundConversationMessageWindow, ConversationMessageWindowReadPort,
            ConversationMessageWindowRequest, InvalidMessageWindowQuery, MessageWindowAnchor,
            MessageWindowRefusal, MessageWindowStreamRequest, WindowLinkedTask, WindowTaskAssignee,
        },
    },
};

use crate::messaging::{
    author_wire::author_dto,
    message_wire::{attachment_list, from_kind_word},
};

use super::query_number::{CoercedInteger, NumberIssue, coerce_integer};

pub const CONVERSATION_MESSAGE_WINDOW_PATH: &str = "/api/channels/{id}/messages";

struct MessageWindowState<P>(Arc<P>);

impl<P> Clone for MessageWindowState<P> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<P>(port: P) -> Router
where
    P: ConversationMessageWindowReadPort + Send + Sync + 'static,
{
    Router::new()
        .route(CONVERSATION_MESSAGE_WINDOW_PATH, get(read::<P>))
        .with_state(MessageWindowState(Arc::new(port)))
}

async fn read<P: ConversationMessageWindowReadPort>(
    State(state): State<MessageWindowState<P>>,
    principal: Option<Extension<UserId>>,
    Path(raw_conversation): Path<String>,
    Query(raw_query): Query<MessageWindowQueryWire>,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        tracing::error!("conversation-message-window route reached without human principal");
        return internal();
    };
    let conversation = match ConversationId::parse(raw_conversation) {
        Ok(value) => value,
        Err(_) => return error(StatusCode::BAD_REQUEST, "channel id required"),
    };

    // TypeScript establishes conversation existence/readability before parsing
    // any cursor. This is rejection-only: the snapshot read repeats the gate.
    match state.0.admit(&viewer, &conversation).await {
        Ok(Ok(())) => {}
        Ok(Err(refusal)) => return refusal_wire(refusal),
        Err(error) => {
            tracing::error!(
                error_chain=%crate::error::describe(&error),
                "conversation-message-window admission failed"
            );
            return internal();
        }
    }

    let request = match request(&raw_query) {
        Ok(value) => value,
        Err(refusal) => return query_refusal_wire(refusal),
    };
    match state.0.read(&viewer, &conversation, request.clone()).await {
        Ok(Ok(window)) => match window.bind(&viewer, &conversation, &request) {
            Ok(bound) => match success(&bound) {
                Ok(response) => response,
                Err(error) => {
                    tracing::error!(
                        error_chain=%crate::error::describe(&error),
                        "conversation-message-window wire projection failed"
                    );
                    internal()
                }
            },
            Err(error) => {
                tracing::error!(
                    error_chain=%crate::error::describe(&error),
                    "conversation-message-window identity seal failed"
                );
                internal()
            }
        },
        Ok(Err(refusal)) => refusal_wire(refusal),
        Err(error) => {
            tracing::error!(
                error_chain=%crate::error::describe(&error),
                "conversation-message-window projection failed"
            );
            internal()
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct MessageWindowQueryWire {
    limit: Option<String>,
    before_seq: Option<String>,
    after_seq: Option<String>,
    around_message_id: Option<String>,
    thread_root_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum QueryRefusal {
    Limit,
    Before,
    After,
    Around,
    MultipleAnchors,
    ThreadRoot,
}

fn request(
    wire: &MessageWindowQueryWire,
) -> Result<ConversationMessageWindowRequest, QueryRefusal> {
    let limit = match wire.limit.as_deref() {
        None => 200,
        Some(raw) => match coerce_integer(raw) {
            Ok(CoercedInteger::Persisted(value)) => value.clamp(1, 500) as u16,
            Ok(CoercedInteger::BeyondPersistedRange) => 500,
            // Production TS falls back to 200 for non-finite/NaN limits. Its
            // finite-fraction path reaches SQLite and faults; Rust closes that
            // undefined edge as an explicit invalid limit instead of silently
            // widening the requested page.
            Err(NumberIssue::Nan | NumberIssue::NonFinite) => 200,
            Err(NumberIssue::Float) => return Err(QueryRefusal::Limit),
        },
    };
    let before = wire
        .before_seq
        .as_deref()
        .map(|raw| cursor(raw, QueryRefusal::Before))
        .transpose()?;
    let after = wire
        .after_seq
        .as_deref()
        .map(|raw| cursor(raw, QueryRefusal::After))
        .transpose()?;
    let around = wire
        .around_message_id
        .as_deref()
        .map(|raw| {
            if raw.is_empty() {
                return Err(QueryRefusal::Around);
            }
            MessageId::parse(raw).map_err(|_| QueryRefusal::Around)
        })
        .transpose()?;
    if usize::from(before.is_some()) + usize::from(after.is_some()) + usize::from(around.is_some())
        > 1
    {
        return Err(QueryRefusal::MultipleAnchors);
    }
    let anchor = match (before, after, around) {
        (Some(value), None, None) => MessageWindowAnchor::Before(value),
        (None, Some(value), None) => MessageWindowAnchor::After(value),
        (None, None, Some(value)) => MessageWindowAnchor::Around(value),
        (None, None, None) => MessageWindowAnchor::Latest,
        _ => unreachable!("multiple anchors were rejected above"),
    };
    let stream = match wire.thread_root_id.as_deref() {
        None => MessageWindowStreamRequest::Mainline,
        Some("") => return Err(QueryRefusal::ThreadRoot),
        Some(raw) => MessageWindowStreamRequest::Thread(
            MessageId::parse(raw).map_err(|_| QueryRefusal::ThreadRoot)?,
        ),
    };
    let invalid_cursor = match &anchor {
        MessageWindowAnchor::Before(_) => QueryRefusal::Before,
        MessageWindowAnchor::After(_) => QueryRefusal::After,
        MessageWindowAnchor::Latest | MessageWindowAnchor::Around(_) => QueryRefusal::Limit,
    };
    ConversationMessageWindowRequest::new(stream, limit, anchor).map_err(|error| match error {
        InvalidMessageWindowQuery::Limit => QueryRefusal::Limit,
        InvalidMessageWindowQuery::UnsafeCursor => invalid_cursor,
    })
}

fn cursor(raw: &str, refusal: QueryRefusal) -> Result<MessageSeq, QueryRefusal> {
    match coerce_integer(raw).map_err(|_| refusal)? {
        CoercedInteger::Persisted(value) if value >= 0 => {
            MessageSeq::try_from(value).map_err(|_| refusal)
        }
        CoercedInteger::Persisted(_) | CoercedInteger::BeyondPersistedRange => Err(refusal),
    }
}

#[derive(Debug)]
pub(super) enum MessageWindowWireError {
    Metadata,
}

impl std::fmt::Display for MessageWindowWireError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("stored message metadata is not a JSON object")
    }
}

impl std::error::Error for MessageWindowWireError {}

fn success(window: &BoundConversationMessageWindow) -> Result<Response, MessageWindowWireError> {
    let messages = window
        .messages()
        .iter()
        .map(|selected| message(selected.projection()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut reply_counts = Map::new();
    let mut reply_summaries = Map::new();
    let mut reply_previews = Map::new();
    for root in window.roots() {
        reply_counts.insert(root.root().as_str().to_owned(), json!(root.count().get()));
        if let Some(summary) = root.summary() {
            reply_summaries.insert(
                root.root().as_str().to_owned(),
                json!({
                    "reply_count": summary.count().get(),
                    "last_reply_at": summary.last_reply_at(),
                    "repliers": summary.repliers().iter().map(|row| author_dto(row.author())).collect::<Vec<_>>(),
                    "replier_total": summary.replier_total().get(),
                }),
            );
        }
        if !root.previews().is_empty() {
            reply_previews.insert(
                root.root().as_str().to_owned(),
                Value::Array(root.previews().iter().map(reply_preview).collect()),
            );
        }
    }
    Ok(Json(json!({
        "messages": messages,
        "reply_counts_by_root": reply_counts,
        "reply_summaries_by_root": reply_summaries,
        "reply_previews_by_root": reply_previews,
        "has_more_before": window.has_more_before(),
        "stream_head_seq": window.stream_head().get(),
        "has_more_after": window.has_more_after(),
    }))
    .into_response())
}

pub(super) fn message(
    projection: &silverhand_backend_core::messaging::collaboration::conversation_message_window::WindowMessageProjection,
) -> Result<Value, MessageWindowWireError> {
    let metadata = match projection.metadata.json() {
        None => Value::Null,
        Some(raw) => {
            let value: Value =
                serde_json::from_str(raw).map_err(|_| MessageWindowWireError::Metadata)?;
            if !value.is_object() {
                return Err(MessageWindowWireError::Metadata);
            }
            value
        }
    };
    let reactions = if projection.reactions.is_empty() {
        Value::Null
    } else {
        Value::Array(
            projection
                .reactions
                .iter()
                .map(|reaction| {
                    let aggregate = reaction.aggregate();
                    json!({
                        "emoji": aggregate.emoji().as_str(),
                        "count": aggregate.count().value(),
                        "viewer_reacted": aggregate.viewer_reacted(),
                    })
                })
                .collect(),
        )
    };
    Ok(json!({
        "id": projection.id.as_str(),
        "conversation_id": projection.conversation.as_str(),
        "from_kind": from_kind_word(projection.author.from_kind()),
        "from_agent_id": projection.author.from_agent().map(|id| id.as_str()),
        "from_user_id": projection.author.from_user().map(|id| id.as_str()),
        "author": projection.author.author().map(author_dto),
        "content": projection.content,
        "metadata": metadata,
        "attachments": attachment_list(projection.metadata.attachments()),
        "reactions": reactions,
        "seq": projection.seq.get(),
        "created_at": projection.created_at_ms,
        "thread_root_id": projection.thread_root.as_ref().map(|id| id.as_str()),
        "linked_task": projection.linked_task.as_ref().map(linked_task),
    }))
}

fn linked_task(task: &WindowLinkedTask) -> Value {
    json!({
        "task_id": task.id(),
        "task_number": task.number().get(),
        "title": task.title(),
        "status": task.status().as_str(),
        "assignee": task.assignee().map(task_assignee),
    })
}

fn task_assignee(assignee: &WindowTaskAssignee) -> Value {
    json!({
        "type": match assignee.principal() {
            PrincipalIdentity::Agent(_) => "agent",
            PrincipalIdentity::Human(_) => "user",
        },
        "id": assignee.principal().as_str(),
        "name": assignee.name(),
    })
}

fn reply_preview(
    preview: &silverhand_backend_core::messaging::collaboration::conversation_message_window::WindowReplyPreview,
) -> Value {
    json!({
        "message_id": preview.message().as_str(),
        "seq": preview.seq().get(),
        "author": author_dto(preview.author()),
        "preview": preview.preview(),
        "attachment_count": preview.attachment_count().get(),
        "first_attachment_label": preview.first_attachment_label().map(|label| label.to_string()),
    })
}

fn refusal_wire(refusal: MessageWindowRefusal) -> Response {
    match refusal {
        MessageWindowRefusal::NotFound => error(StatusCode::NOT_FOUND, "channel not found"),
        MessageWindowRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        MessageWindowRefusal::ThreadRootNotFound => coded_error(
            StatusCode::NOT_FOUND,
            "thread root message not found",
            "thread_root_not_found",
        ),
        MessageWindowRefusal::AnchorNotFound => coded_error(
            StatusCode::NOT_FOUND,
            "around_message_id not found in this conversation",
            "message_not_found",
        ),
    }
}

fn query_refusal_wire(refusal: QueryRefusal) -> Response {
    match refusal {
        QueryRefusal::Limit => coded_error(
            StatusCode::BAD_REQUEST,
            "limit must be an integer",
            "invalid_limit",
        ),
        QueryRefusal::Before => coded_error(
            StatusCode::BAD_REQUEST,
            "before_seq must be a non-negative integer",
            "invalid_cursor",
        ),
        QueryRefusal::After => coded_error(
            StatusCode::BAD_REQUEST,
            "after_seq must be a non-negative integer",
            "invalid_cursor",
        ),
        QueryRefusal::Around => coded_error(
            StatusCode::BAD_REQUEST,
            "around_message_id must be a non-empty message id",
            "invalid_cursor",
        ),
        QueryRefusal::MultipleAnchors => coded_error(
            StatusCode::BAD_REQUEST,
            "before_seq, after_seq and around_message_id are mutually exclusive",
            "mutually_exclusive_cursors",
        ),
        QueryRefusal::ThreadRoot => coded_error(
            StatusCode::BAD_REQUEST,
            "thread_root_id must be a non-empty message id",
            "invalid_thread_root_id",
        ),
    }
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

fn coded_error(status: StatusCode, message: &'static str, code: &'static str) -> Response {
    (status, Json(json!({"error": message, "code": code}))).into_response()
}

fn internal() -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

#[cfg(test)]
mod tests;
