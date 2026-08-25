//! Human-session HTTP adapter for viewer-private attention preferences.

#[cfg(test)]
mod tests;

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, put},
};
use serde_json::{Map, Value, json};
use silverhand_backend_core::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::collaboration::attention_preference::{
        AttentionPreferenceAftermath, AttentionPreferencePort, AttentionPreferenceRefusal,
        ChannelAttentionMode, CommittedAttentionPreference, set_channel_attention_preference,
        set_workspace_attention_preference,
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
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        return internal();
    };
    let conversation = match ConversationId::parse(id) {
        Ok(value) => value,
        Err(_) => return error(StatusCode::BAD_REQUEST, "channel id required"),
    };
    // Product target/admission precedes body validation on this route. The port
    // therefore receives the parsed body only after the wire adapter has it,
    // while SQLite repeats the authoritative target/access checks in-lock.
    let value = body.map(|Json(value)| value).unwrap_or_else(|_| json!({}));
    let parsed = parse_channel_body(&value);
    let issues = parsed.as_ref().err().cloned();
    match set_channel_attention_preference(
        &state.0.port,
        &state.0.aftermath,
        viewer,
        conversation,
        parsed.ok(),
    )
    .await
    {
        Ok(Ok(done)) => {
            report_effect(done.first_failure());
            channel_success(done.committed())
        }
        Ok(Err(AttentionPreferenceRefusal::InvalidInput)) => invalid(issues.unwrap_or_default()),
        Ok(Err(reason)) => refusal(reason),
        Err(error) => {
            tracing::error!(error_chain=%crate::error::describe(&error),"channel attention preference failed");
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
        Ok(value) => value,
        Err(_) => return error(StatusCode::BAD_REQUEST, "workspace id required"),
    };
    match state.0.port.get_workspace(&viewer, workspace).await {
        Ok(Ok(preference)) => Json(json!({
            "workspace_id": preference.workspace().as_str(),
            "muted": preference.muted()
        }))
        .into_response(),
        Ok(Err(reason)) => refusal(reason),
        Err(error) => {
            tracing::error!(error_chain=%crate::error::describe(&error),"workspace attention preference read failed");
            internal()
        }
    }
}

async fn set_workspace<P: AttentionPreferencePort, A: AttentionPreferenceAftermath>(
    State(state): State<AttentionState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(id): Path<String>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Some(Extension(viewer)) = principal else {
        return internal();
    };
    let workspace = match WorkspaceId::parse(id) {
        Ok(value) => value,
        Err(_) => return error(StatusCode::BAD_REQUEST, "workspace id required"),
    };
    let value = body.map(|Json(value)| value).unwrap_or_else(|_| json!({}));
    let parsed = parse_workspace_body(&value);
    let issues = parsed.as_ref().err().cloned();
    match set_workspace_attention_preference(
        &state.0.port,
        &state.0.aftermath,
        viewer,
        workspace,
        parsed.ok(),
    )
    .await
    {
        Ok(Ok(done)) => {
            report_effect(done.first_failure());
            workspace_success(done.committed())
        }
        Ok(Err(AttentionPreferenceRefusal::InvalidInput)) => invalid(issues.unwrap_or_default()),
        Ok(Err(reason)) => refusal(reason),
        Err(error) => {
            tracing::error!(error_chain=%crate::error::describe(&error),"workspace attention preference failed");
            internal()
        }
    }
}

fn parse_channel_body(value: &Value) -> Result<ChannelAttentionMode, Vec<Value>> {
    let object = root_object(value)?;
    match object.get("mode") {
        Some(Value::String(raw)) => ChannelAttentionMode::parse(raw).ok_or_else(|| vec![json!({
            "received":raw,"code":"invalid_enum_value","options":["all","mentions","mute"],"path":["mode"],
            "message":format!("Invalid enum value. Expected 'all' | 'mentions' | 'mute', received '{raw}'")
        })]),
        Some(value) => Err(vec![type_issue("string", received(value), "mode")]),
        None => Err(vec![type_issue("string", "undefined", "mode")]),
    }
}

fn parse_workspace_body(value: &Value) -> Result<bool, Vec<Value>> {
    let object = root_object(value)?;
    match object.get("muted") {
        Some(Value::Bool(value)) => Ok(*value),
        Some(value) => Err(vec![type_issue("boolean", received(value), "muted")]),
        None => Err(vec![type_issue("boolean", "undefined", "muted")]),
    }
}

fn root_object(value: &Value) -> Result<&Map<String, Value>, Vec<Value>> {
    value.as_object().ok_or_else(|| {
        vec![json!({"code":"invalid_type","expected":"object","received":received(value),"path":[],"message":format!("Expected object, received {}",received(value))})]
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
fn refusal(value: AttentionPreferenceRefusal) -> Response {
    match value {
        AttentionPreferenceRefusal::ChannelNotFound => {
            error(StatusCode::NOT_FOUND, "channel not found")
        }
        AttentionPreferenceRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        AttentionPreferenceRefusal::WorkspaceNotFound => {
            error(StatusCode::NOT_FOUND, "workspace not found")
        }
        AttentionPreferenceRefusal::InvalidInput => invalid(Vec::new()),
    }
}
fn channel_success(fact: &CommittedAttentionPreference) -> Response {
    let preference = fact
        .channel_preference()
        .expect("channel write returns channel fact");
    Json(json!({"conversation_id":preference.conversation().as_str(),"mode":preference.mode().as_str()})).into_response()
}
fn workspace_success(fact: &CommittedAttentionPreference) -> Response {
    let preference = fact
        .workspace_preference()
        .expect("workspace write returns workspace fact");
    Json(json!({"workspace_id":preference.workspace().as_str(),"muted":preference.muted()}))
        .into_response()
}
fn report_effect(
    error: Option<&silverhand_backend_core::messaging::collaboration::attention_preference::AttentionPreferenceEffectFailure>,
) {
    if let Some(error) = error {
        tracing::error!(error_chain=%crate::error::describe(error),"attention preference effect failed");
    }
}
