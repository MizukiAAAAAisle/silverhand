//! Auth-first HTTP boundary for channel archive, visibility and rename.
//!
//! The DEFERRED admission port is only a body-poll ordering optimization. Each
//! operation still enters its own writer-reserved SQLite unit, re-derives every
//! mutable authority and returns a bound committed fact before effects or wire.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::patch,
};
use serde_json::{Map, Value, json};
use silverhand_backend_core::{
    conversation_messaging::messaging::{
        collaboration::{
            channel_directory::ChannelVisibility,
            channel_lifecycle::{
                ChannelArchiveAftermath, ChannelArchivePort, ChannelArchiveRefusal,
                ChannelMutationAdmissionPort, ChannelMutationAdmissionRefusal,
                ChannelRenameAftermath, ChannelRenamePort, ChannelRenameRefusal,
                ChannelVisibilityAftermath, ChannelVisibilityPort, ChannelVisibilityRefusal,
                archive_channel, rename_channel, set_channel_visibility,
            },
        },
        conversation_title::{CanonicalConversationTitle, ConversationTitleIssue},
    },
    foundation::identity::{ConversationId, UserId},
};

use crate::messaging::collaboration::json_body::{BodyRead, payload_too_large, read_body};

use super::{channel, error, internal};

pub const CHANNEL_ARCHIVE_PATH: &str = "/api/channels/{id}/archive";

struct Inner<P, A> {
    port: P,
    aftermath: A,
}

struct MutationState<P, A>(Arc<Inner<P, A>>);

impl<P, A> Clone for MutationState<P, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

/// The mutation leaf stays separate from detail-read composition. The eventual
/// authenticated app mount may merge both routers without changing either port.
pub fn mutation_router<P, A>(port: P, aftermath: A) -> Router
where
    P: ChannelMutationAdmissionPort
        + ChannelArchivePort
        + ChannelVisibilityPort
        + ChannelRenamePort
        + Send
        + Sync
        + 'static,
    A: ChannelArchiveAftermath
        + ChannelVisibilityAftermath
        + ChannelRenameAftermath
        + Send
        + Sync
        + 'static,
{
    Router::new()
        .route(CHANNEL_ARCHIVE_PATH, patch(archive::<P, A>))
        .route(super::CHANNEL_DETAIL_PATH, patch(update::<P, A>))
        .with_state(MutationState(Arc::new(Inner { port, aftermath })))
}

async fn archive<P, A>(
    State(state): State<MutationState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(raw_conversation): Path<String>,
    request: Request,
) -> Response
where
    P: ChannelMutationAdmissionPort + ChannelArchivePort,
    A: ChannelArchiveAftermath,
{
    let (viewer, conversation) = match request_coordinates(principal, raw_conversation) {
        Ok(value) => value,
        Err(refusal) => return refusal.response(),
    };
    if let Err(refusal) = admit(&state.0.port, &viewer, &conversation).await {
        return refusal.response();
    }
    let value = match request_json(request).await {
        Ok(value) => value,
        Err(refusal) => return refusal.response(),
    };
    let archived = match parse_archive(value) {
        Ok(value) => value,
        Err(issues) => return invalid(issues),
    };

    match archive_channel(
        &state.0.port,
        &state.0.aftermath,
        viewer,
        conversation,
        archived,
    )
    .await
    {
        Ok(Ok(execution)) => {
            report_effect(execution.first_failure(), "archive");
            channel_success(execution.committed().row())
        }
        Ok(Err(refusal)) => archive_refusal(refusal),
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "channel archive failed"
            );
            internal()
        }
    }
}

async fn update<P, A>(
    State(state): State<MutationState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(raw_conversation): Path<String>,
    request: Request,
) -> Response
where
    P: ChannelMutationAdmissionPort + ChannelVisibilityPort + ChannelRenamePort,
    A: ChannelVisibilityAftermath + ChannelRenameAftermath,
{
    let (viewer, conversation) = match request_coordinates(principal, raw_conversation) {
        Ok(value) => value,
        Err(refusal) => return refusal.response(),
    };
    if let Err(refusal) = admit(&state.0.port, &viewer, &conversation).await {
        return refusal.response();
    }
    let value = match request_json(request).await {
        Ok(value) => value,
        Err(refusal) => return refusal.response(),
    };
    let update = match parse_update(value) {
        Ok(value) => value,
        Err(issues) => return invalid(issues),
    };

    match update {
        ChannelUpdate::Visibility(visibility) => {
            match set_channel_visibility(
                &state.0.port,
                &state.0.aftermath,
                viewer,
                conversation,
                visibility,
            )
            .await
            {
                Ok(Ok(execution)) => {
                    report_effect(execution.first_failure(), "visibility");
                    channel_success(execution.committed().row())
                }
                Ok(Err(refusal)) => visibility_refusal(refusal),
                Err(failure) => {
                    tracing::error!(
                        error_chain = %crate::error::describe(&failure),
                        "channel visibility mutation failed"
                    );
                    internal()
                }
            }
        }
        ChannelUpdate::Rename(title) => {
            let requested = title.title().to_owned();
            match rename_channel(
                &state.0.port,
                &state.0.aftermath,
                viewer,
                conversation,
                title,
            )
            .await
            {
                Ok(Ok(execution)) => {
                    report_effect(execution.first_failure(), "rename");
                    channel_success(execution.committed().row())
                }
                Ok(Err(refusal)) => rename_refusal(refusal, &requested),
                Err(failure) => {
                    tracing::error!(
                        error_chain = %crate::error::describe(&failure),
                        "channel rename failed"
                    );
                    internal()
                }
            }
        }
    }
}

fn request_coordinates(
    principal: Option<Extension<UserId>>,
    raw_conversation: String,
) -> Result<(UserId, ConversationId), CoordinateRefusal> {
    let Some(Extension(viewer)) = principal else {
        tracing::error!("channel mutation route reached without its human principal fact");
        return Err(CoordinateRefusal::MissingPrincipal);
    };
    let Ok(conversation) = ConversationId::parse(raw_conversation) else {
        return Err(CoordinateRefusal::InvalidConversation);
    };
    Ok((viewer, conversation))
}

enum CoordinateRefusal {
    MissingPrincipal,
    InvalidConversation,
}

impl CoordinateRefusal {
    fn response(self) -> Response {
        match self {
            Self::MissingPrincipal => internal(),
            Self::InvalidConversation => error(StatusCode::BAD_REQUEST, "channel id required"),
        }
    }
}

async fn admit<P: ChannelMutationAdmissionPort>(
    port: &P,
    viewer: &UserId,
    conversation: &ConversationId,
) -> Result<(), AdmissionRefusal> {
    match port.admit(viewer, conversation).await {
        Ok(Ok(value)) => value
            .bind(viewer, conversation)
            .map(|_| ())
            .map_err(|failure| {
                tracing::error!(
                    error_chain = %crate::error::describe(&failure),
                    "channel mutation admission identity seal failed"
                );
                AdmissionRefusal::Internal
            }),
        Ok(Err(ChannelMutationAdmissionRefusal::NotFound)) => Err(AdmissionRefusal::NotFound),
        Ok(Err(ChannelMutationAdmissionRefusal::Forbidden)) => Err(AdmissionRefusal::Forbidden),
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "channel mutation admission failed"
            );
            Err(AdmissionRefusal::Internal)
        }
    }
}

enum AdmissionRefusal {
    NotFound,
    Forbidden,
    Internal,
}

impl AdmissionRefusal {
    fn response(self) -> Response {
        match self {
            Self::NotFound => error(StatusCode::NOT_FOUND, "channel not found"),
            Self::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
            Self::Internal => internal(),
        }
    }
}

async fn request_json(request: Request) -> Result<Value, BodyRefusal> {
    let body = match read_body(request).await {
        BodyRead::Within(body) => body,
        BodyRead::OverLimit => return Err(BodyRefusal::OverLimit),
        BodyRead::Unreadable => return Ok(Value::Object(Map::new())),
    };
    let value = serde_json::from_slice(&body).unwrap_or_else(|_| Value::Object(Map::new()));
    drop(body);
    Ok(value)
}

enum BodyRefusal {
    OverLimit,
}

impl BodyRefusal {
    fn response(self) -> Response {
        match self {
            Self::OverLimit => payload_too_large(),
        }
    }
}

fn parse_archive(value: Value) -> Result<bool, Vec<Value>> {
    let Value::Object(mut object) = value else {
        return Err(vec![invalid_type("object", received(&value), vec![])]);
    };
    match object.remove("archived") {
        Some(Value::Bool(value)) => Ok(value),
        None => Err(vec![json!({
            "code":"invalid_type", "expected":"boolean", "received":"undefined",
            "path":["archived"], "message":"Required"
        })]),
        Some(value) => Err(vec![invalid_type(
            "boolean",
            received(&value),
            vec![json!("archived")],
        )]),
    }
}

enum ChannelUpdate {
    Rename(CanonicalConversationTitle),
    Visibility(ChannelVisibility),
}

fn parse_update(value: Value) -> Result<ChannelUpdate, Vec<Value>> {
    let Value::Object(mut object) = value else {
        return Err(vec![invalid_type("object", received(&value), vec![])]);
    };
    let mut issues = Vec::new();
    let title = match object.remove("title") {
        None => None,
        Some(Value::String(raw)) => match CanonicalConversationTitle::parse(&raw) {
            Ok(value) => Some(value),
            Err(issue) => {
                issues.push(title_issue(issue));
                None
            }
        },
        Some(value) => {
            issues.push(invalid_type(
                "string",
                received(&value),
                vec![json!("title")],
            ));
            None
        }
    };
    let visibility = match object.remove("visibility") {
        None => None,
        Some(Value::String(raw)) => match ChannelVisibility::parse(&raw) {
            Ok(value) => Some(value),
            Err(_) => {
                issues.push(json!({
                    "received": raw, "code":"invalid_enum_value",
                    "options":["private","public"], "path":["visibility"],
                    "message":format!("Invalid enum value. Expected 'private' | 'public', received '{raw}'")
                }));
                None
            }
        },
        Some(value) => {
            let kind = received(&value);
            issues.push(json!({
                "expected":"'private' | 'public'", "received":kind,
                "code":"invalid_type", "path":["visibility"],
                "message":format!("Expected 'private' | 'public', received {kind}")
            }));
            None
        }
    };
    if !issues.is_empty() {
        return Err(issues);
    }
    match (title, visibility) {
        (Some(title), None) => Ok(ChannelUpdate::Rename(title)),
        (None, Some(visibility)) => Ok(ChannelUpdate::Visibility(visibility)),
        _ => Err(vec![json!({
            "code":"custom",
            "message":"exactly one of `title` or `visibility` must be provided",
            "path":[],
        })]),
    }
}

fn invalid_type(expected: &str, received: &str, path: Vec<Value>) -> Value {
    json!({
        "code":"invalid_type", "expected":expected, "received":received,
        "path":path, "message":format!("Expected {expected}, received {received}")
    })
}

fn received(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn title_issue(issue: ConversationTitleIssue) -> Value {
    match issue {
        ConversationTitleIssue::Empty => json!({
            "code":"too_small", "minimum":1, "type":"string", "inclusive":true,
            "message":"title must not be empty", "path":["title"]
        }),
        ConversationTitleIssue::TooLong { code_points } => json!({
            "code":"too_big", "maximum":128, "type":"string", "inclusive":true,
            "message":format!("title must be at most 128 characters (got {code_points})"),
            "path":["title"]
        }),
        ConversationTitleIssue::ForbiddenCodePoint { code_point, index } => json!({
            "code":"custom",
            "message":format!(
                "title must not contain U+{code_point:04X} (position {}): invisible characters and multi-code-point emoji sequences are not addressable",
                index + 1
            ),
            "path":["title"]
        }),
    }
}

fn invalid(issues: Vec<Value>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":"invalid input", "issues":issues})),
    )
        .into_response()
}

fn channel_success(
    row: &silverhand_backend_core::conversation_messaging::messaging::collaboration::channel_lifecycle::ChannelLifecycleRow,
) -> Response {
    Json(json!({"channel":channel(row)})).into_response()
}

fn archive_refusal(refusal: ChannelArchiveRefusal) -> Response {
    match refusal {
        ChannelArchiveRefusal::NotFound => error(StatusCode::NOT_FOUND, "channel not found"),
        ChannelArchiveRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
    }
}

fn visibility_refusal(refusal: ChannelVisibilityRefusal) -> Response {
    match refusal {
        ChannelVisibilityRefusal::NotFound => error(StatusCode::NOT_FOUND, "channel not found"),
        ChannelVisibilityRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
    }
}

fn rename_refusal(refusal: ChannelRenameRefusal, title: &str) -> Response {
    match refusal {
        ChannelRenameRefusal::NotFound => error(StatusCode::NOT_FOUND, "channel not found"),
        ChannelRenameRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        ChannelRenameRefusal::NotAddressable => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error":"this conversation has no workspace to hold a title address",
                "code":"not_addressable",
            })),
        )
            .into_response(),
        ChannelRenameRefusal::TitleTaken => (
            StatusCode::CONFLICT,
            Json(json!({
                "error":format!("a channel titled {title} already exists in this workspace"),
                "code":"conversation_title_taken",
            })),
        )
            .into_response(),
    }
}

fn report_effect(
    failure: Option<&silverhand_backend_core::conversation_messaging::messaging::collaboration::channel_lifecycle::ChannelMutationEffectFailure>,
    operation: &'static str,
) {
    if let Some(failure) = failure {
        tracing::error!(
            error_chain = %crate::error::describe(failure),
            operation,
            "committed channel mutation aftermath failed"
        );
    }
}

#[cfg(test)]
mod tests;
