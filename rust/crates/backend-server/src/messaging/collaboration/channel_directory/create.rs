//! Human channel-creation wire boundary.
//!
//! JSON/title admission completes before the persistence operation receives a
//! bounded typed request. Mutable governance, membership and title uniqueness
//! remain the writer-reserved SQLite unit's authority.

use std::sync::Arc;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Map, Value, json};
use silverhand_backend_core::{
    identity::{UserId, WorkspaceId},
    messaging::{
        collaboration::channel_directory::{
            BoundHumanChannelCreation, ChannelVisibility, HumanChannelCreateAftermath,
            HumanChannelCreatePort, HumanChannelCreateRefusal, HumanChannelCreateRequest,
            create_human_channel,
        },
        conversation_title::{CanonicalConversationTitle, ConversationTitleIssue},
    },
};

use super::{ACTIVE_PATH, error, identity_channel, internal};

struct Inner<P, A> {
    port: P,
    aftermath: A,
}

struct CreateState<P, A>(Arc<Inner<P, A>>);

impl<P, A> Clone for CreateState<P, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

/// The POST leaf is kept physically separate from the three read operations.
/// Application composition may merge the routers at the owned mount seam.
pub fn create_router<P, A>(port: P, aftermath: A) -> Router
where
    P: HumanChannelCreatePort + Send + Sync + 'static,
    A: HumanChannelCreateAftermath + Send + Sync + 'static,
{
    Router::new()
        .route(ACTIVE_PATH, post(create::<P, A>))
        .with_state(CreateState(Arc::new(Inner { port, aftermath })))
}

async fn create<P, A>(
    State(state): State<CreateState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(raw_workspace): Path<String>,
    body: Bytes,
) -> Response
where
    P: HumanChannelCreatePort,
    A: HumanChannelCreateAftermath,
{
    let Some(Extension(viewer)) = principal else {
        tracing::error!("channel-directory create route reached without human principal");
        return internal();
    };
    let Ok(workspace) = WorkspaceId::parse(raw_workspace) else {
        return error(StatusCode::BAD_REQUEST, "workspace id required");
    };

    // Hono maps JSON parse failure to `{}` before invoking the production Zod
    // schema. Preserve that distinction from a valid non-object JSON value.
    let value = serde_json::from_slice(&body).unwrap_or_else(|_| Value::Object(Map::new()));
    drop(body);
    let request = match parse_request(value) {
        Ok(value) => value,
        Err(issues) => return invalid(issues),
    };
    let requested_title = request.title().title().to_owned();

    match create_human_channel(
        &state.0.port,
        &state.0.aftermath,
        viewer,
        workspace,
        request,
    )
    .await
    {
        Ok(Ok(execution)) => {
            if let Some(failure) = execution.publication_failure() {
                tracing::error!(
                    error_chain = %crate::error::describe(failure),
                    "committed channel creation publication failed"
                );
            }
            success(execution.committed())
        }
        Ok(Err(reason)) => refusal(reason, &requested_title),
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "channel creation failed"
            );
            internal()
        }
    }
}

fn parse_request(value: Value) -> Result<HumanChannelCreateRequest, Vec<Value>> {
    let Value::Object(mut object) = value else {
        return Err(vec![invalid_type("object", received(&value), vec![])]);
    };
    let mut issues = Vec::new();

    let title = match object.remove("title") {
        None => {
            issues.push(json!({
                "code": "invalid_type", "expected": "string", "received": "undefined",
                "path": ["title"], "message": "Required"
            }));
            None
        }
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

    let agents = string_array(
        object.remove("member_agent_ids"),
        "member_agent_ids",
        true,
        &mut issues,
    );
    let users = string_array(
        object.remove("member_user_ids"),
        "member_user_ids",
        false,
        &mut issues,
    );
    let visibility = match object.remove("visibility") {
        None => None,
        Some(Value::String(raw)) => match ChannelVisibility::parse(&raw) {
            Ok(value) => Some(value),
            Err(_) => {
                issues.push(json!({
                    "received": raw,
                    "code": "invalid_enum_value",
                    "options": ["private", "public"],
                    "path": ["visibility"],
                    "message": format!("Invalid enum value. Expected 'private' | 'public', received '{raw}'")
                }));
                None
            }
        },
        Some(value) => {
            let kind = received(&value);
            issues.push(json!({
                "expected": "'private' | 'public'", "received": kind,
                "code": "invalid_type", "path": ["visibility"],
                "message": format!("Expected 'private' | 'public', received {kind}")
            }));
            None
        }
    };

    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(HumanChannelCreateRequest::new(
        title.expect("title exists when issue set is empty"),
        agents.unwrap_or_default(),
        users,
        visibility,
    ))
}

fn string_array(
    value: Option<Value>,
    field: &'static str,
    default_empty: bool,
    issues: &mut Vec<Value>,
) -> Option<Vec<String>> {
    let Some(value) = value else {
        return default_empty.then(Vec::new);
    };
    let Value::Array(values) = value else {
        issues.push(invalid_type("array", received(&value), vec![json!(field)]));
        return None;
    };
    let mut output = Vec::with_capacity(values.len());
    for (index, value) in values.into_iter().enumerate() {
        match value {
            Value::String(value) => output.push(value),
            value => issues.push(invalid_type(
                "string",
                received(&value),
                vec![json!(field), json!(index)],
            )),
        }
    }
    Some(output)
}

fn invalid_type(expected: &str, received: &str, path: Vec<Value>) -> Value {
    json!({
        "code": "invalid_type", "expected": expected, "received": received,
        "path": path, "message": format!("Expected {expected}, received {received}")
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
            "code": "too_small", "minimum": 1, "type": "string", "inclusive": true,
            "message": "title must not be empty", "path": ["title"]
        }),
        ConversationTitleIssue::TooLong { code_points } => json!({
            "code": "too_big", "maximum": 128, "type": "string", "inclusive": true,
            "message": format!("title must be at most 128 characters (got {code_points})"),
            "path": ["title"]
        }),
        ConversationTitleIssue::ForbiddenCodePoint { code_point, index } => json!({
            "code": "custom",
            "message": format!(
                "title must not contain U+{code_point:04X} (position {}): invisible characters and multi-code-point emoji sequences are not addressable",
                index + 1
            ),
            "path": ["title"]
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

fn refusal(refusal: HumanChannelCreateRefusal, requested_title: &str) -> Response {
    match refusal {
        HumanChannelCreateRefusal::WorkspaceNotFound => {
            error(StatusCode::NOT_FOUND, "workspace not found")
        }
        HumanChannelCreateRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        HumanChannelCreateRefusal::AgentHomePublic => error(
            StatusCode::BAD_REQUEST,
            "agent_home DM channels cannot be public",
        ),
        HumanChannelCreateRefusal::AgentHomeExplicitMembers => error(
            StatusCode::BAD_REQUEST,
            "agent_home channels always use the home owner/current user as members",
        ),
        HumanChannelCreateRefusal::AgentHomeOwnerNotFound => {
            error(StatusCode::NOT_FOUND, "agent_home owner not found")
        }
        HumanChannelCreateRefusal::AgentNotFound(id) => coded(
            StatusCode::BAD_REQUEST,
            format!("agent {id} not found"),
            "agent_not_found",
        ),
        HumanChannelCreateRefusal::AgentNotWorkspaceMember(id) => coded(
            StatusCode::BAD_REQUEST,
            format!("agent {id} is not a member of this workspace"),
            "agent_not_workspace_member",
        ),
        HumanChannelCreateRefusal::UserNotWorkspaceMember(id) => coded(
            StatusCode::BAD_REQUEST,
            format!("user {id} is not a human member of this workspace"),
            "user_not_workspace_member",
        ),
        HumanChannelCreateRefusal::TitleTaken => coded(
            StatusCode::CONFLICT,
            format!("a channel titled {requested_title} already exists in this workspace"),
            "conversation_title_taken",
        ),
    }
}

fn coded(status: StatusCode, message: String, code: &'static str) -> Response {
    (status, Json(json!({"error":message,"code":code}))).into_response()
}

fn success(value: &BoundHumanChannelCreation) -> Response {
    (
        StatusCode::CREATED,
        Json(json!({"channel": identity_channel(value.channel(), value.workspace())})),
    )
        .into_response()
}

#[cfg(test)]
mod tests;
