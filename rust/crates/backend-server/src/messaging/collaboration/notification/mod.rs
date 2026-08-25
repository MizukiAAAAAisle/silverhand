//! Human-session HTTP adapter for directed notifications.

#[cfg(test)]
mod tests;

use axum::{
    Json, Router,
    extract::{Extension, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use silverhand_backend_core::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::collaboration::notification::*,
};
use std::{collections::HashMap, sync::Arc};

pub const LIST_PATH: &str = "/api/notifications";
pub const UNREAD_PATH: &str = "/api/notifications/unread";
pub const READ_PATH: &str = "/api/notifications/read";

struct Inner<R, C, A> {
    reads: R,
    clears: C,
    aftermath: A,
}
struct NotificationState<R, C, A>(Arc<Inner<R, C, A>>);
impl<R, C, A> Clone for NotificationState<R, C, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}
pub fn router<R, C, A>(reads: R, clears: C, aftermath: A) -> Router
where
    R: NotificationReadPort + Send + Sync + 'static,
    C: NotificationClearPort + Send + Sync + 'static,
    A: NotificationAftermath + Send + Sync + 'static,
{
    let state = NotificationState(Arc::new(Inner {
        reads,
        clears,
        aftermath,
    }));
    Router::new()
        .route(LIST_PATH, get(list::<R, C, A>))
        .route(UNREAD_PATH, get(unread::<R, C, A>))
        .route(READ_PATH, post(clear::<R, C, A>))
        .with_state(state)
}
fn viewer(principal: Option<Extension<UserId>>) -> Option<UserId> {
    principal.map(|Extension(v)| v)
}
async fn list<R: NotificationReadPort, C: NotificationClearPort, A: NotificationAftermath>(
    State(s): State<NotificationState<R, C, A>>,
    principal: Option<Extension<UserId>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(viewer) = viewer(principal) else {
        return internal();
    };
    let unread = query.get("unread").is_some_and(|v| v == "1");
    let limit = parse_limit(query.get("limit").map(String::as_str));
    match s
        .0
        .reads
        .list(
            &viewer,
            NotificationListQuery {
                unread_only: unread,
                limit,
            },
        )
        .await
    {
        Ok(items) => {
            Json(json!({"notifications":items.iter().map(notification_wire).collect::<Vec<_>>()}))
                .into_response()
        }
        Err(e) => {
            tracing::error!(error_chain=%crate::error::describe(&e),"notification list failed");
            internal()
        }
    }
}
async fn unread<R: NotificationReadPort, C: NotificationClearPort, A: NotificationAftermath>(
    State(s): State<NotificationState<R, C, A>>,
    principal: Option<Extension<UserId>>,
) -> Response {
    let Some(viewer) = viewer(principal) else {
        return internal();
    };
    match s.0.reads.unread_summary(&viewer).await{Ok(v)=>Json(json!({"total":v.total,"by_workspace":v.by_workspace.iter().map(|(k,v)|(k.as_str(),v)).collect::<HashMap<_,_>>(),"latest_by_workspace":v.latest_by_workspace.iter().map(|(k,v)|(k.as_str(),json!({"conversation_id":v.conversation.as_str(),"message_id":v.message.as_str(),"thread_root_id":v.thread_root.as_ref().map(|x|x.as_str())}))).collect::<HashMap<_,_>>() })).into_response(),Err(e)=>{tracing::error!(error_chain=%crate::error::describe(&e),"notification summary failed");internal()}}
}
async fn clear<R: NotificationReadPort, C: NotificationClearPort, A: NotificationAftermath>(
    State(s): State<NotificationState<R, C, A>>,
    principal: Option<Extension<UserId>>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let value = match body {
        Ok(Json(v)) => v,
        Err(_) => return invalid(),
    };
    let Some(o) = value.as_object() else {
        return invalid();
    };
    for key in ["id", "workspace_id", "conversation_id"] {
        if o.get(key).is_some_and(|value| !value.is_string()) {
            return invalid();
        }
    }
    if o.get("all").is_some_and(|value| !value.is_boolean()) {
        return invalid();
    }
    let selector = if let Some(v) = o
        .get("id")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    {
        NotificationId::parse(v).map(NotificationClearSelector::Id)
    } else if let Some(v) = o
        .get("workspace_id")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    {
        WorkspaceId::parse(v)
            .ok()
            .map(NotificationClearSelector::Workspace)
    } else if let Some(v) = o
        .get("conversation_id")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    {
        ConversationId::parse(v)
            .ok()
            .map(NotificationClearSelector::Conversation)
    } else if o.get("all") == Some(&Value::Bool(true)) {
        Some(NotificationClearSelector::All)
    } else {
        None
    };
    let Some(selector) = selector else {
        return invalid();
    };
    let Some(viewer) = viewer(principal) else {
        return internal();
    };
    match clear_notifications(&s.0.clears, &s.0.aftermath, viewer, selector).await {
        Ok(done) => {
            if let Some(e) = done.first_failure() {
                tracing::error!(error_chain=%crate::error::describe(e),"notification clear effect failed");
            }
            Json(json!({"marked":done.committed().marked()})).into_response()
        }
        Err(e) => {
            tracing::error!(error_chain=%crate::error::describe(&e),"notification clear failed");
            internal()
        }
    }
}
fn parse_limit(raw: Option<&str>) -> u16 {
    let Some(raw) = raw else { return 100 };
    let raw = raw.trim_start();
    let (negative, digits) = if let Some(v) = raw.strip_prefix('-') {
        (true, v)
    } else {
        (false, raw.strip_prefix('+').unwrap_or(raw))
    };
    let prefix: String = digits.chars().take_while(char::is_ascii_digit).collect();
    if negative || prefix.is_empty() {
        return 100;
    }
    prefix
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0)
        .map(|v| v.min(500) as u16)
        .unwrap_or(100)
}
fn notification_wire(n: &Notification) -> Value {
    json!({"id":n.id.as_str(),"kind":n.kind.as_str(),"user_id":n.user.as_ref().map(|v|v.as_str()),"agent_id":n.agent.as_ref().map(|v|v.as_str()),"workspace_id":n.workspace.as_ref().map(|v|v.as_str()),"conversation_id":n.conversation.as_ref().map(|v|v.as_str()),"message_id":n.message.as_ref().map(|v|v.as_str()),"thread_root_id":n.thread_root.as_ref().map(|v|v.as_str()),"source_workspace_id":n.source_workspace.as_ref().map(|v|v.as_str()),"source_conversation_id":n.source_conversation.as_ref().map(|v|v.as_str()),"source_message_id":n.source_message.as_ref().map(|v|v.as_str()),"payload":n.payload_json.as_deref().and_then(|v|serde_json::from_str::<Value>(v).ok()),"read_at":n.read_at.map(NotificationTimestamp::get),"created_at":n.created_at.get()})
}
fn invalid() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":"invalid input"})),
    )
        .into_response()
}
fn internal() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal server error"})),
    )
        .into_response()
}
