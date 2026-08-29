//! Human-session wire boundary for per-conversation runtime control.

mod wire;

/// The canonical placement-refusal → HTTP mapper, re-exported so the agent-scoped
/// bulk stop reuses this ONE authority instead of re-minting the status/code map.
pub(crate) use wire::placement_refusal;

/// The ONE clear-session success projection, re-exported so the agent-scope
/// clear-session face renders the same body without re-minting it.
pub(crate) use wire::clear_session_success;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use axum::{
    Router,
    body::Bytes,
    extract::{Extension, Path, State},
    response::Response,
    routing::post,
};
use serde::Deserialize;
use serde_json::Value;
use silverhand_backend_core::{
    identity::{AgentId, ConversationId, UserId},
    messaging::collaboration::{
        ClearSessionRefusal, HardStopRuntimeRefusal, RuntimeControlAdmission, RuntimeControlPort,
        RuntimeStartTarget, StartRuntimeRefusal, check_runtime_control_admission,
        clear_conversation_session, hard_stop_runtime, start_runtime,
    },
};

use wire::{
    admission_refusal, clear_session_refusal, hard_stop_refusal, internal_error, invalid_target,
    legacy_stop_refusal, operation_success, start_refusal,
};

pub const START_PATH: &str = "/api/channels/{id}/agents/{aid}/start";
pub const HARD_STOP_PATH: &str = "/api/channels/{id}/agents/{aid}/stop";
pub const CLEAR_SESSION_PATH: &str = "/api/channels/{id}/agents/{aid}/clear-session";

struct StateInner<A, P> {
    admission: A,
    provider: P,
}

struct RuntimeControlState<A, P>(Arc<StateInner<A, P>>);

impl<A, P> Clone for RuntimeControlState<A, P> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<A, P>(admission: A, provider: P) -> Router
where
    A: RuntimeControlAdmission + Send + Sync + 'static,
    P: RuntimeControlPort + Send + Sync + 'static,
{
    let state = RuntimeControlState(Arc::new(StateInner {
        admission,
        provider,
    }));
    Router::new()
        .route(START_PATH, post(start::<A, P>))
        .route(HARD_STOP_PATH, post(hard_stop::<A, P>))
        .route(CLEAR_SESSION_PATH, post(clear_session::<A, P>))
        // Request-size admission belongs to the app-owned global perimeter.
        // This product router neither disables nor replaces that one authority.
        .with_state(state)
}

#[derive(Deserialize)]
struct RuntimePath {
    id: String,
    aid: String,
}

struct InvalidTarget;

/// Parse the path coordinates. The route layer no longer decides a scope arm:
/// it forwards the conversation candidate and agent, and the core resolves the
/// row-owned seat (for seat ops) or the read-derived presentation origin (start).
fn coordinates(path: RuntimePath) -> Result<(ConversationId, AgentId), InvalidTarget> {
    let conversation = ConversationId::parse(path.id).map_err(|_| InvalidTarget)?;
    let agent = AgentId::parse(path.aid).map_err(|_| InvalidTarget)?;
    Ok((conversation, agent))
}

async fn start<A, P>(
    State(state): State<RuntimeControlState<A, P>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<RuntimePath>,
) -> Response
where
    A: RuntimeControlAdmission,
    P: RuntimeControlPort,
{
    let Some(Extension(actor)) = principal else {
        return internal_error_message("runtime-control route reached without its human principal");
    };
    let (conversation, agent) = match coordinates(path) {
        Ok(coordinates) => coordinates,
        Err(InvalidTarget) => return invalid_target(),
    };
    let target = RuntimeStartTarget::new(actor, agent, conversation);
    match start_runtime(&state.0.admission, &state.0.provider, target).await {
        Ok(Ok(_)) => operation_success(),
        Ok(Err(StartRuntimeRefusal::Admission(refusal))) => admission_refusal(refusal),
        Ok(Err(StartRuntimeRefusal::Provider(refusal))) => start_refusal(refusal),
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "conversation runtime start failed"
            );
            internal_error()
        }
    }
}

async fn hard_stop<A, P>(
    State(state): State<RuntimeControlState<A, P>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<RuntimePath>,
    body: Bytes,
) -> Response
where
    A: RuntimeControlAdmission,
    P: RuntimeControlPort,
{
    let Some(Extension(actor)) = principal else {
        return internal_error_message("runtime-control route reached without its human principal");
    };
    let (conversation, agent) = match coordinates(path) {
        Ok(coordinates) => coordinates,
        Err(InvalidTarget) => return invalid_target(),
    };
    if legacy_stop_body(&body) {
        // TS performs all five product checks before it inspects this legacy
        // body. Run the same one-snapshot admission, but construct no provider
        // command for a request that must be refused.
        return match check_runtime_control_admission(
            &state.0.admission,
            &actor,
            &agent,
            &conversation,
        )
        .await
        {
            Ok(Some(refusal)) => admission_refusal(refusal),
            Ok(None) => legacy_stop_refusal(),
            Err(failure) => {
                tracing::error!(
                    error_chain = %crate::error::describe(&failure),
                    "conversation runtime-stop admission failed"
                );
                internal_error()
            }
        };
    }
    match hard_stop_runtime(
        &state.0.admission,
        &state.0.provider,
        actor,
        agent,
        conversation,
    )
    .await
    {
        Ok(Ok(_)) => operation_success(),
        Ok(Err(HardStopRuntimeRefusal::Admission(refusal))) => admission_refusal(refusal),
        Ok(Err(HardStopRuntimeRefusal::Provider(refusal))) => hard_stop_refusal(refusal),
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "conversation runtime hard-stop failed"
            );
            internal_error()
        }
    }
}

async fn clear_session<A, P>(
    State(state): State<RuntimeControlState<A, P>>,
    principal: Option<Extension<UserId>>,
    Path(path): Path<RuntimePath>,
) -> Response
where
    A: RuntimeControlAdmission,
    P: RuntimeControlPort,
{
    let Some(Extension(actor)) = principal else {
        return internal_error_message("runtime-control route reached without its human principal");
    };
    let (conversation, agent) = match coordinates(path) {
        Ok(coordinates) => coordinates,
        Err(InvalidTarget) => return invalid_target(),
    };
    match clear_conversation_session(
        &state.0.admission,
        &state.0.provider,
        actor,
        agent.clone(),
        conversation.clone(),
    )
    .await
    {
        Ok(Ok(outcome)) => clear_session_success(&outcome),
        Ok(Err(ClearSessionRefusal::Admission(refusal))) => admission_refusal(refusal),
        Ok(Err(ClearSessionRefusal::Provider(refusal))) => {
            clear_session_refusal(refusal, &conversation, &agent)
        }
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "conversation runtime clear-session failed"
            );
            internal_error()
        }
    }
}

fn legacy_stop_body(body: &[u8]) -> bool {
    let value =
        serde_json::from_slice::<Value>(body).unwrap_or_else(|_| Value::Object(Default::default()));
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("mode").and_then(Value::as_str) == Some("soft") || object.contains_key("directive")
}

fn internal_error_message(message: &'static str) -> Response {
    tracing::error!("{message}");
    internal_error()
}
