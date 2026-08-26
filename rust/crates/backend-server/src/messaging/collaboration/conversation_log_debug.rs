//! Authenticated backend-local per-conversation log-debug windows.
//!
//! The public route deliberately has no daemon command or domain unit of work.
//! Strict conversation participation is admitted before the body is polled;
//! the only mutation is the server process's local log-control window. The
//! POST response retains `daemonSynced: true` solely as a legacy compatibility
//! field after the production daemon mirror was retired.

use std::{error::Error, future::Future, sync::Arc};

use axum::{
    Json, Router,
    extract::{Extension, Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Map, Value, json};
use silverhand_backend_core::identity::{ConversationId, UserId};

use super::json_body::{BodyRead, payload_too_large, read_body};

pub const CONVERSATION_LOG_DEBUG_PATH: &str = "/api/conversations/{id}/log-debug";
const TEMP_CONVERSATION_DEBUG_WINDOW_MS: i64 = 10 * 60 * 1_000;
const MAX_SAFE_ECMASCRIPT_INTEGER: i64 = 9_007_199_254_740_991;

pub trait ConversationLogDebugAdmissionPort {
    type Error: Error + Send + Sync + 'static;

    fn admit(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> impl Future<
        Output = Result<
            Result<ConversationLogDebugAdmissionFact, ConversationLogDebugAdmissionRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationLogDebugAdmissionFact {
    viewer: UserId,
    conversation: ConversationId,
}

impl ConversationLogDebugAdmissionFact {
    pub fn selected(viewer: UserId, conversation: ConversationId) -> Self {
        Self {
            viewer,
            conversation,
        }
    }

    fn bind(
        self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> Result<Self, ConversationLogDebugIdentityMismatch> {
        if &self.viewer != viewer || &self.conversation != conversation {
            return Err(ConversationLogDebugIdentityMismatch);
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationLogDebugAdmissionRefusal {
    NotFound,
    Forbidden,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ConversationLogDebugIdentityMismatch;

impl std::fmt::Display for ConversationLogDebugIdentityMismatch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("conversation log-debug admission source differs from the request")
    }
}

impl Error for ConversationLogDebugIdentityMismatch {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConversationLogDebugStatus {
    enabled: bool,
    expires_at: Option<i64>,
}

impl Default for ConversationLogDebugStatus {
    fn default() -> Self {
        Self::disabled()
    }
}

impl ConversationLogDebugStatus {
    pub const fn disabled() -> Self {
        Self {
            enabled: false,
            expires_at: None,
        }
    }

    pub fn enabled(expires_at: i64) -> Result<Self, InvalidConversationLogDebugExpiration> {
        if !(1..=MAX_SAFE_ECMASCRIPT_INTEGER).contains(&expires_at) {
            return Err(InvalidConversationLogDebugExpiration);
        }
        Ok(Self {
            enabled: true,
            expires_at: Some(expires_at),
        })
    }

    pub const fn is_enabled(self) -> bool {
        self.enabled
    }

    pub const fn expires_at(self) -> Option<i64> {
        self.expires_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidConversationLogDebugExpiration;

impl std::fmt::Display for InvalidConversationLogDebugExpiration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("conversation log-debug expiration is outside the wire domain")
    }
}

impl Error for InvalidConversationLogDebugExpiration {}

pub trait ConversationLogDebugControl {
    fn status(&self, conversation: &ConversationId) -> ConversationLogDebugControlFact;
    fn enable(
        &self,
        conversation: &ConversationId,
        expires_at: i64,
    ) -> ConversationLogDebugControlFact;
    fn disable(&self, conversation: &ConversationId) -> ConversationLogDebugControlFact;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationLogDebugControlFact {
    conversation: ConversationId,
    status: ConversationLogDebugStatus,
}

impl ConversationLogDebugControlFact {
    pub fn observed(conversation: ConversationId, status: ConversationLogDebugStatus) -> Self {
        Self {
            conversation,
            status,
        }
    }

    fn bind_read(
        self,
        requested: &ConversationId,
    ) -> Result<BoundConversationLogDebugControlFact, ConversationLogDebugControlMismatch> {
        if &self.conversation != requested {
            return Err(ConversationLogDebugControlMismatch::conversation(
                requested.clone(),
                self.conversation,
            ));
        }
        Ok(BoundConversationLogDebugControlFact(self))
    }

    fn bind_update(
        self,
        requested: &ConversationId,
        requested_status: ConversationLogDebugStatus,
    ) -> Result<BoundConversationLogDebugControlFact, ConversationLogDebugControlMismatch> {
        let bound = self.bind_read(requested)?;
        if bound.0.status != requested_status {
            return Err(ConversationLogDebugControlMismatch::state(
                requested.clone(),
                requested_status,
                bound.0.status,
            ));
        }
        Ok(bound)
    }
}

/// A local-control fact sealed to the requested conversation and state.
///
/// A bare status cannot cross the route's wire boundary.
///
/// ```compile_fail
/// use silverhand_backend_server::messaging::collaboration::conversation_log_debug::{
///     BoundConversationLogDebugControlFact, ConversationLogDebugStatus,
/// };
/// fn wire(_: &BoundConversationLogDebugControlFact) {}
/// wire(&ConversationLogDebugStatus::disabled());
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundConversationLogDebugControlFact(ConversationLogDebugControlFact);

impl BoundConversationLogDebugControlFact {
    fn conversation(&self) -> &ConversationId {
        &self.0.conversation
    }

    fn status(&self) -> ConversationLogDebugStatus {
        self.0.status
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConversationLogDebugControlMismatch {
    Conversation {
        requested: ConversationId,
        actual: ConversationId,
    },
    State {
        conversation: ConversationId,
        requested: ConversationLogDebugStatus,
        actual: ConversationLogDebugStatus,
    },
}

impl ConversationLogDebugControlMismatch {
    fn conversation(requested: ConversationId, actual: ConversationId) -> Self {
        Self::Conversation { requested, actual }
    }

    fn state(
        conversation: ConversationId,
        requested: ConversationLogDebugStatus,
        actual: ConversationLogDebugStatus,
    ) -> Self {
        Self::State {
            conversation,
            requested,
            actual,
        }
    }
}

impl std::fmt::Display for ConversationLogDebugControlMismatch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conversation { requested, actual } => write!(
                formatter,
                "conversation log-debug local-control conversation mismatch: requested {}, actual {}",
                requested.as_str(),
                actual.as_str()
            ),
            Self::State {
                conversation,
                requested,
                actual,
            } => write!(
                formatter,
                "conversation log-debug local-control state mismatch for {}: requested {:?}, actual {:?}",
                conversation.as_str(),
                requested,
                actual
            ),
        }
    }
}

impl Error for ConversationLogDebugControlMismatch {}

pub trait ConversationLogDebugClock {
    type Error: Error + Send + Sync + 'static;

    fn now_unix_ms(&self) -> Result<i64, Self::Error>;
}

struct Inner<P, C, K> {
    admission: P,
    control: C,
    clock: K,
}

struct LogDebugState<P, C, K>(Arc<Inner<P, C, K>>);

impl<P, C, K> Clone for LogDebugState<P, C, K> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

pub fn router<P, C, K>(admission: P, control: C, clock: K) -> Router
where
    P: ConversationLogDebugAdmissionPort + Send + Sync + 'static,
    C: ConversationLogDebugControl + Send + Sync + 'static,
    K: ConversationLogDebugClock + Send + Sync + 'static,
{
    Router::new()
        .route(
            CONVERSATION_LOG_DEBUG_PATH,
            get(read::<P, C, K>).post(update::<P, C, K>),
        )
        .with_state(LogDebugState(Arc::new(Inner {
            admission,
            control,
            clock,
        })))
}

async fn read<P, C, K>(
    State(state): State<LogDebugState<P, C, K>>,
    principal: Option<Extension<UserId>>,
    Path(raw_conversation): Path<String>,
) -> Response
where
    P: ConversationLogDebugAdmissionPort + Send + Sync + 'static,
    C: ConversationLogDebugControl + Send + Sync + 'static,
    K: Send + Sync + 'static,
{
    let (viewer, conversation) = match request_coordinates(principal, raw_conversation) {
        Ok(value) => value,
        Err(refusal) => return refusal.response(),
    };
    if let Err(response) = admit(&state.0.admission, &viewer, &conversation).await {
        return *response;
    }
    match state
        .0
        .control
        .status(&conversation)
        .bind_read(&conversation)
    {
        Ok(fact) => status_response(&fact, false),
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "conversation log-debug local status identity seal failed"
            );
            internal()
        }
    }
}

async fn update<P, C, K>(
    State(state): State<LogDebugState<P, C, K>>,
    principal: Option<Extension<UserId>>,
    Path(raw_conversation): Path<String>,
    request: Request,
) -> Response
where
    P: ConversationLogDebugAdmissionPort + Send + Sync + 'static,
    C: ConversationLogDebugControl + Send + Sync + 'static,
    K: ConversationLogDebugClock + Send + Sync + 'static,
{
    let (viewer, conversation) = match request_coordinates(principal, raw_conversation) {
        Ok(value) => value,
        Err(refusal) => return refusal.response(),
    };
    if let Err(response) = admit(&state.0.admission, &viewer, &conversation).await {
        return *response;
    }
    let value = match request_json(request).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let enabled = match parse_enabled(value) {
        Ok(value) => value,
        Err(issues) => return invalid(issues),
    };

    let status = if enabled {
        let now = match state.0.clock.now_unix_ms() {
            Ok(now) => now,
            Err(failure) => {
                tracing::error!(
                    error_chain = %crate::error::describe(&failure),
                    "conversation log-debug clock failed"
                );
                return internal();
            }
        };
        let Some(expires_at) = now.checked_add(TEMP_CONVERSATION_DEBUG_WINDOW_MS) else {
            tracing::error!("conversation log-debug clock overflowed");
            return internal();
        };
        let status = match ConversationLogDebugStatus::enabled(expires_at) {
            Ok(status) => status,
            Err(_) => {
                tracing::error!("conversation log-debug clock left the ECMAScript wire domain");
                return internal();
            }
        };
        match state
            .0
            .control
            .enable(&conversation, expires_at)
            .bind_update(&conversation, status)
        {
            Ok(fact) => fact,
            Err(failure) => {
                tracing::error!(
                    error_chain = %crate::error::describe(&failure),
                    "conversation log-debug local enable seal failed"
                );
                return internal();
            }
        }
    } else {
        let requested_status = ConversationLogDebugStatus::disabled();
        match state
            .0
            .control
            .disable(&conversation)
            .bind_update(&conversation, requested_status)
        {
            Ok(fact) => fact,
            Err(failure) => {
                tracing::error!(
                    error_chain = %crate::error::describe(&failure),
                    "conversation log-debug local disable seal failed"
                );
                return internal();
            }
        }
    };
    status_response(&status, true)
}

fn request_coordinates(
    principal: Option<Extension<UserId>>,
    raw_conversation: String,
) -> Result<(UserId, ConversationId), CoordinateRefusal> {
    let Some(Extension(viewer)) = principal else {
        tracing::error!("conversation log-debug route reached without its human principal fact");
        return Err(CoordinateRefusal::MissingPrincipal);
    };
    let conversation = ConversationId::parse(raw_conversation)
        .map_err(|_| CoordinateRefusal::InvalidConversation)?;
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
            Self::InvalidConversation => error(StatusCode::BAD_REQUEST, "conversation id required"),
        }
    }
}

async fn admit<P: ConversationLogDebugAdmissionPort>(
    port: &P,
    viewer: &UserId,
    conversation: &ConversationId,
) -> Result<(), Box<Response>> {
    match port.admit(viewer, conversation).await {
        Ok(Ok(fact)) => fact
            .bind(viewer, conversation)
            .map(|_| ())
            .map_err(|failure| {
                tracing::error!(
                    error_chain = %crate::error::describe(&failure),
                    "conversation log-debug admission identity seal failed"
                );
                Box::new(internal())
            }),
        Ok(Err(ConversationLogDebugAdmissionRefusal::NotFound)) => Err(Box::new(error(
            StatusCode::NOT_FOUND,
            "conversation not found",
        ))),
        Ok(Err(ConversationLogDebugAdmissionRefusal::Forbidden)) => {
            Err(Box::new(error(StatusCode::FORBIDDEN, "forbidden")))
        }
        Err(failure) => {
            tracing::error!(
                error_chain = %crate::error::describe(&failure),
                "conversation log-debug admission failed"
            );
            Err(Box::new(internal()))
        }
    }
}

async fn request_json(request: Request) -> Result<Value, Box<Response>> {
    let body = match read_body(request).await {
        BodyRead::Within(body) => body,
        BodyRead::OverLimit => return Err(Box::new(payload_too_large())),
        BodyRead::Unreadable => return Ok(Value::Object(Map::new())),
    };
    let value = serde_json::from_slice(&body).unwrap_or_else(|_| Value::Object(Map::new()));
    drop(body);
    Ok(value)
}

fn parse_enabled(value: Value) -> Result<bool, Vec<Value>> {
    let Value::Object(mut object) = value else {
        return Err(vec![invalid_type("object", received(&value), vec![])]);
    };
    let mut issues = Vec::new();
    let enabled = match object.remove("enabled") {
        Some(Value::Bool(value)) => Some(value),
        None => {
            issues.push(json!({
                "code":"invalid_type", "expected":"boolean", "received":"undefined",
                "path":["enabled"], "message":"Required"
            }));
            None
        }
        Some(value) => {
            issues.push(invalid_type(
                "boolean",
                received(&value),
                vec![json!("enabled")],
            ));
            None
        }
    };
    if !object.is_empty() {
        let keys = object.keys().cloned().collect::<Vec<_>>();
        let quoted = keys
            .iter()
            .map(|key| format!("'{key}'"))
            .collect::<Vec<_>>()
            .join(", ");
        issues.push(json!({
            "code":"unrecognized_keys", "keys":keys, "path":[],
            "message":format!("Unrecognized key(s) in object: {quoted}")
        }));
    }
    if issues.is_empty() {
        Ok(enabled.expect("an issue-free input has a boolean enabled field"))
    } else {
        Err(issues)
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

fn status_response(
    fact: &BoundConversationLogDebugControlFact,
    include_legacy_daemon_field: bool,
) -> Response {
    let status = fact.status();
    let mut value = json!({
        "conversationId":fact.conversation().as_str(),
        "enabled":status.is_enabled(),
        "expiresAt":status.expires_at(),
    });
    if include_legacy_daemon_field {
        value["daemonSynced"] = Value::Bool(true);
    }
    Json(value).into_response()
}

fn invalid(issues: Vec<Value>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":"invalid input", "issues":issues})),
    )
        .into_response()
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}

fn internal() -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

#[cfg(test)]
mod tests;
