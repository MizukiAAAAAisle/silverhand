//! Internal agent acknowledgement that one stale draft became obsolete.
//!
//! This route has no message write, daemon command or domain aftermath. It
//! authenticates the runtime bearer, admits a bounded request against the
//! existing post authority and independent `send_messages` capability, then
//! synchronously emits the one warning record the TypeScript service owns.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Map, Value, json};
use silverhand_backend_core::{
    identity::{AgentId, ConversationId},
    messaging::{
        CapabilityDenied, SendCapability,
        collaboration::stale_message_resolution::{
            BoundStaleMessageResolutionAdmission, StaleMessageResolutionAdmissionPort,
            StaleMessageResolutionAdmissionRefusal,
        },
    },
    runtime_credential::RuntimePrincipal,
};

use super::json_body::{BodyRead, payload_too_large, read_body};

pub const STALE_MESSAGE_RESOLUTION_PATH: &str = "/internal/agents/{aid}/stale-message-resolution";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StaleMessageResolutionObservation {
    agent: AgentId,
    conversation: ConversationId,
    stale_event_id: String,
}

impl StaleMessageResolutionObservation {
    fn from_bound(admission: BoundStaleMessageResolutionAdmission, stale_event_id: String) -> Self {
        let (agent, conversation) = admission.into_parts();
        Self {
            agent,
            conversation,
            stale_event_id,
        }
    }

    pub fn agent(&self) -> &AgentId {
        &self.agent
    }

    pub fn source_conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn target_conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn stale_event_id(&self) -> &str {
        &self.stale_event_id
    }

    pub const fn resolution_reason(&self) -> &'static str {
        "obsolete"
    }

    pub const fn outcome(&self) -> &'static str {
        "obsolete"
    }
}

/// Synchronous and infallible by design: production is one `tracing::warn!`.
/// A durable or fallible port here would invent an aftermath the product does
/// not have.
pub trait StaleMessageResolutionObserver {
    fn stale_message_resolved(&self, observation: &StaleMessageResolutionObservation);
}

/// The production observer: the sole real effect is the one warning line whose
/// schema this module owns. The durable resolution record belongs to the
/// TypeScript service, so this stays synchronous, infallible and zero-state — a
/// durable or fallible observer would invent an aftermath the product lacks.
///
/// The TS durable record carries `messageId`/`messageSeq` as `null` for a stale
/// resolution (the draft never became a message). That is not a fact THIS route
/// produces, so the Rust observer projects those nulls as field ABSENCE — the
/// tracing-native shape for "no value" (stable `Option<T>: Value` skips a `None`
/// rather than emitting typed null). This is a named projection difference, not
/// exact-null parity, and it keeps the six real top-level fields queryable.
#[derive(Clone, Copy, Debug, Default)]
pub struct TracingStaleMessageResolutionObserver;

impl StaleMessageResolutionObserver for TracingStaleMessageResolutionObserver {
    fn stale_message_resolved(&self, observation: &StaleMessageResolutionObservation) {
        tracing::warn!(
            agent = observation.agent().as_str(),
            source_conversation = observation.source_conversation().as_str(),
            target_conversation = observation.target_conversation().as_str(),
            stale_event_id = observation.stale_event_id(),
            reason = observation.resolution_reason(),
            outcome = observation.outcome(),
            "stale message resolution recorded"
        );
    }
}

struct Inner<A, C, O> {
    admission: A,
    capability: C,
    observer: O,
}

struct ResolutionState<A, C, O>(Arc<Inner<A, C, O>>);

impl<A, C, O> Clone for ResolutionState<A, C, O> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<A, C, O>(admission: A, capability: C, observer: O) -> Router
where
    A: StaleMessageResolutionAdmissionPort + Send + Sync + 'static,
    C: SendCapability + Send + Sync + 'static,
    O: StaleMessageResolutionObserver + Send + Sync + 'static,
{
    Router::new()
        .route(STALE_MESSAGE_RESOLUTION_PATH, post(resolve::<A, C, O>))
        .with_state(ResolutionState(Arc::new(Inner {
            admission,
            capability,
            observer,
        })))
}

async fn resolve<A, C, O>(
    State(state): State<ResolutionState<A, C, O>>,
    principal: Option<Extension<RuntimePrincipal>>,
    Path(raw_agent): Path<String>,
    request: Request,
) -> Response
where
    A: StaleMessageResolutionAdmissionPort + Send + Sync,
    C: SendCapability + Send + Sync,
    O: StaleMessageResolutionObserver + Send + Sync,
{
    let Some(Extension(principal)) = principal else {
        tracing::error!("stale-message resolution route reached without runtime principal");
        return internal();
    };
    let Ok(path_agent) = AgentId::parse(raw_agent) else {
        return not_found();
    };
    if principal.agent() != &path_agent {
        return not_found();
    }

    let request = match request_json(request).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let admitted = match admit_request(request) {
        Ok(admitted) => admitted,
        Err(issues) => return invalid(issues),
    };

    let source = match state
        .0
        .admission
        .admit(principal.agent(), &admitted.conversation)
        .await
    {
        Ok(Ok(source)) => source,
        Ok(Err(StaleMessageResolutionAdmissionRefusal::Forbidden)) => return forbidden(),
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "stale-message resolution post authority failed"
            );
            return internal();
        }
    };
    let bound = match source.bind(principal.agent(), &admitted.conversation) {
        Ok(bound) => bound,
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "stale-message resolution admission identity seal failed"
            );
            return internal();
        }
    };

    match state
        .0
        .capability
        .may_send_messages(principal.agent(), &admitted.conversation)
        .await
    {
        Ok(Ok(())) => {}
        Ok(Err(CapabilityDenied)) => return capability_denied(),
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "stale-message resolution capability authority failed"
            );
            return internal();
        }
    }

    let observation = StaleMessageResolutionObservation::from_bound(bound, admitted.stale_event_id);
    state.0.observer.stale_message_resolved(&observation);
    (StatusCode::OK, Json(json!({"ok":true}))).into_response()
}

struct AdmittedRequest {
    conversation: ConversationId,
    stale_event_id: String,
}

async fn request_json(request: Request) -> Result<Value, Box<Response>> {
    match read_body(request).await {
        BodyRead::Within(body) => Ok(serde_json::from_slice(&body).unwrap_or_else(|_| json!({}))),
        BodyRead::OverLimit => Err(Box::new(payload_too_large())),
        BodyRead::Unreadable => Ok(json!({})),
    }
}

fn admit_request(value: Value) -> Result<AdmittedRequest, Vec<Value>> {
    let Value::Object(fields) = value else {
        return Err(vec![invalid_type_issue("object", json_type(&value), None)]);
    };
    let mut issues = Vec::new();
    let conversation = required_non_empty(&fields, "conversation_id", &mut issues);
    let stale_event_id = required_non_empty(&fields, "stale_event_id", &mut issues);
    let obsolete = required_obsolete(&fields, &mut issues);
    let (Some(conversation), Some(stale_event_id), true) = (conversation, stale_event_id, obsolete)
    else {
        return Err(issues);
    };
    let conversation = ConversationId::parse(conversation)
        .expect("non-empty conversation ids are the domain admission rule");
    Ok(AdmittedRequest {
        conversation,
        stale_event_id,
    })
}

fn required_non_empty(
    fields: &Map<String, Value>,
    key: &'static str,
    issues: &mut Vec<Value>,
) -> Option<String> {
    match fields.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        Some(Value::String(_)) => {
            issues.push(json!({
                "code":"too_small","minimum":1,"type":"string","inclusive":true,
                "exact":false,"message":"String must contain at least 1 character(s)",
                "path":[key]
            }));
            None
        }
        raw => {
            issues.push(invalid_type_issue(
                "string",
                raw.map_or("undefined", json_type),
                Some(key),
            ));
            None
        }
    }
}

fn required_obsolete(fields: &Map<String, Value>, issues: &mut Vec<Value>) -> bool {
    match fields.get("resolution_reason") {
        Some(Value::String(value)) if value == "obsolete" => true,
        raw => {
            let mut issue = Map::new();
            if let Some(value) = raw {
                issue.insert("received".to_owned(), value.clone());
            }
            issue.insert("code".to_owned(), json!("invalid_literal"));
            issue.insert("expected".to_owned(), json!("obsolete"));
            issue.insert("path".to_owned(), json!(["resolution_reason"]));
            issue.insert(
                "message".to_owned(),
                json!("Invalid literal value, expected \"obsolete\""),
            );
            issues.push(Value::Object(issue));
            false
        }
    }
}

fn invalid_type_issue(expected: &str, received: &str, field: Option<&str>) -> Value {
    let message = if received == "undefined" {
        "Required".to_owned()
    } else {
        format!("Expected {expected}, received {received}")
    };
    json!({
        "code":"invalid_type",
        "expected":expected,
        "received":received,
        "path":field.map_or_else(Vec::<&str>::new, |field| vec![field]),
        "message":message,
    })
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn invalid(issues: Vec<Value>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":"invalid input","issues":issues})),
    )
        .into_response()
}

fn capability_denied() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "code":"capability_denied",
            "capability":"send_messages",
            "message":"missing 'send_messages' capability in this workspace",
            "details":{"capability":"send_messages"}
        })),
    )
        .into_response()
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(json!({"error":"forbidden"}))).into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error":"not found"}))).into_response()
}

fn internal() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        "Internal Server Error",
    )
        .into_response()
}

#[cfg(test)]
mod tests;
