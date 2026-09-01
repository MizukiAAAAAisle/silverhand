//! Human-session HTTP adapter for viewer-private attention preferences.

#[cfg(test)]
mod tests;

use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Extension, Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, put},
};
use serde_json::{Map, Value, json};
use silverhand_backend_core::{
    foundation::identity::{ConversationId, UserId, WorkspaceId},
    messaging::collaboration::attention_preference::{
        AttentionPreferenceAftermath, AttentionPreferencePort, ChannelAttentionAdmissionRefusal,
        ChannelAttentionCommit, ChannelAttentionMode, ChannelAttentionWriteRefusal,
        WorkspaceAttentionAdmissionRefusal, WorkspaceAttentionCommit,
        WorkspaceAttentionReadRefusal, WorkspaceAttentionWriteRefusal,
        commit_channel_attention_preference, commit_workspace_attention_preference,
    },
};
use std::sync::Arc;

pub const CHANNEL_PATH: &str = "/api/conversations/{id}/attention-preference";
pub const WORKSPACE_PATH: &str = "/api/workspaces/{id}/attention-preference";

struct Inner<P, A> {
    port: P,
    aftermath: A,
}
struct AttentionState<P, A>(Arc<Inner<P, A>>);
impl<P, A> Clone for AttentionState<P, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}
pub fn router<P, A>(port: P, aftermath: A) -> Router
where
    P: AttentionPreferencePort + Send + Sync + 'static,
    A: AttentionPreferenceAftermath + Send + Sync + 'static,
{
    let state = AttentionState(Arc::new(Inner { port, aftermath }));
    Router::new()
        .route(CHANNEL_PATH, put(set_channel::<P, A>))
        .route(
            WORKSPACE_PATH,
            get(get_workspace::<P, A>).put(set_workspace::<P, A>),
        )
        .with_state(state)
}

async fn set_channel<P: AttentionPreferencePort, A: AttentionPreferenceAftermath>(
    State(state): State<AttentionState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        return internal();
    };
    let conversation = match ConversationId::parse(id) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, "channel id required"),
    };
    // Target/access is resolved before the body is polled. The body therefore
    // cannot be retained across a SQLite writer reservation.
    let target = match state.0.port.admit_channel(&viewer, &conversation).await {
        Ok(Ok(v)) => v,
        Ok(Err(r)) => return channel_admission_refusal(r),
        Err(e) => {
            tracing::error!(error_chain=%crate::error::describe(&e),"channel attention admission failed");
            return internal();
        }
    };
    let value = read_json(request).await;
    let mode = match parse_channel_body(&value) {
        Ok(v) => v,
        Err(issues) => return invalid(issues),
    };
    drop(value);
    match commit_channel_attention_preference(&state.0.port, &state.0.aftermath, target, mode).await
    {
        Ok(Ok(done)) => {
            report_effect(done.first_failure());
            channel_success(done.committed())
        }
        Ok(Err(r)) => channel_write_refusal(r),
        Err(e) => {
            tracing::error!(error_chain=%crate::error::describe(&e),"channel attention write failed");
            internal()
        }
    }
}

async fn get_workspace<P: AttentionPreferencePort, A: AttentionPreferenceAftermath>(
    State(state): State<AttentionState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(id): Path<String>,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        return internal();
    };
    let workspace = match WorkspaceId::parse(id) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, "workspace id required"),
    };
    match state.0.port.get_workspace(&viewer, workspace).await {
        Ok(Ok(v)) => {
            Json(json!({"workspace_id":v.workspace().as_str(),"muted":v.muted()})).into_response()
        }
        Ok(Err(r)) => workspace_read_refusal(r),
        Err(e) => {
            tracing::error!(error_chain=%crate::error::describe(&e),"workspace attention read failed");
            internal()
        }
    }
}

async fn set_workspace<P: AttentionPreferencePort, A: AttentionPreferenceAftermath>(
    State(state): State<AttentionState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        return internal();
    };
    let workspace = match WorkspaceId::parse(id) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, "workspace id required"),
    };
    let target = match state
        .0
        .port
        .admit_workspace_write(&viewer, &workspace)
        .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(r)) => return workspace_admission_refusal(r),
        Err(e) => {
            tracing::error!(error_chain=%crate::error::describe(&e),"workspace attention admission failed");
            return internal();
        }
    };
    let value = read_json(request).await;
    let muted = match parse_workspace_body(&value) {
        Ok(v) => v,
        Err(issues) => return invalid(issues),
    };
    drop(value);
    match commit_workspace_attention_preference(&state.0.port, &state.0.aftermath, target, muted)
        .await
    {
        Ok(Ok(done)) => {
            report_effect(done.first_failure());
            workspace_success(done.committed())
        }
        Ok(Err(r)) => workspace_write_refusal(r),
        Err(e) => {
            tracing::error!(error_chain=%crate::error::describe(&e),"workspace attention write failed");
            internal()
        }
    }
}

async fn read_json(request: Request) -> Value {
    match to_bytes(request.into_body(), usize::MAX)
        .await
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
    {
        Some(value) => value,
        None => json!({}),
    }
}
fn parse_channel_body(value: &Value) -> Result<ChannelAttentionMode, Vec<Value>> {
    let object = root_object(value)?;
    match object.get("mode"){
        Some(Value::String(raw))=>ChannelAttentionMode::parse(raw).ok_or_else(||vec![json!({"received":raw,"code":"invalid_enum_value","options":["all","mentions","mute"],"path":["mode"],"message":format!("Invalid enum value. Expected 'all' | 'mentions' | 'mute', received '{raw}'")})]),
        Some(value)=>Err(vec![type_issue("string",received(value),"mode")]),None=>Err(vec![type_issue("string","undefined","mode")])
    }
}
fn parse_workspace_body(value: &Value) -> Result<bool, Vec<Value>> {
    let object = root_object(value)?;
    match object.get("muted") {
        Some(Value::Bool(v)) => Ok(*v),
        Some(value) => Err(vec![type_issue("boolean", received(value), "muted")]),
        None => Err(vec![type_issue("boolean", "undefined", "muted")]),
    }
}
fn root_object(value: &Value) -> Result<&Map<String, Value>, Vec<Value>> {
    value.as_object().ok_or_else(||vec![json!({"code":"invalid_type","expected":"object","received":received(value),"path":[],"message":format!("Expected object, received {}",received(value))})])
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
fn type_issue(expected: &str, actual: &str, path: &str) -> Value {
    let message = if actual == "undefined" {
        "Required".to_owned()
    } else {
        format!("Expected {expected}, received {actual}")
    };
    json!({"code":"invalid_type","expected":expected,"received":actual,"path":[path],"message":message})
}
fn invalid(issues: Vec<Value>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":"invalid input","issues":issues})),
    )
        .into_response()
}
fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}
fn internal() -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}
fn channel_admission_refusal(value: ChannelAttentionAdmissionRefusal) -> Response {
    match value {
        ChannelAttentionAdmissionRefusal::ChannelNotFound => {
            error(StatusCode::NOT_FOUND, "channel not found")
        }
        ChannelAttentionAdmissionRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
    }
}
fn channel_write_refusal(value: ChannelAttentionWriteRefusal) -> Response {
    match value {
        ChannelAttentionWriteRefusal::ChannelNotFound => {
            error(StatusCode::NOT_FOUND, "channel not found")
        }
        ChannelAttentionWriteRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
    }
}
fn workspace_read_refusal(value: WorkspaceAttentionReadRefusal) -> Response {
    match value {
        WorkspaceAttentionReadRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        WorkspaceAttentionReadRefusal::WorkspaceNotFound => {
            error(StatusCode::NOT_FOUND, "workspace not found")
        }
    }
}
fn workspace_admission_refusal(value: WorkspaceAttentionAdmissionRefusal) -> Response {
    match value {
        WorkspaceAttentionAdmissionRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        WorkspaceAttentionAdmissionRefusal::WorkspaceNotFound => {
            error(StatusCode::NOT_FOUND, "workspace not found")
        }
    }
}
fn workspace_write_refusal(value: WorkspaceAttentionWriteRefusal) -> Response {
    match value {
        WorkspaceAttentionWriteRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        WorkspaceAttentionWriteRefusal::WorkspaceNotFound => {
            error(StatusCode::NOT_FOUND, "workspace not found")
        }
    }
}
fn channel_success(value: &impl ChannelAttentionCommit) -> Response {
    Json(json!({"conversation_id":value.conversation().as_str(),"mode":value.mode().as_str()}))
        .into_response()
}
fn workspace_success(value: &impl WorkspaceAttentionCommit) -> Response {
    Json(json!({"workspace_id":value.workspace().as_str(),"muted":value.muted()})).into_response()
}
fn report_effect(
    error:Option<&silverhand_backend_core::messaging::collaboration::attention_preference::AttentionPreferenceEffectFailure>,
) {
    if let Some(error) = error {
        tracing::error!(error_chain=%crate::error::describe(error),"attention preference effect failed");
    }
}
