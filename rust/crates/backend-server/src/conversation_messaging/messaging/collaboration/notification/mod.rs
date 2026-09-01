//! Human-session HTTP adapter for directed notifications.

#[cfg(test)]
mod tests;

use axum::{
    Json, Router,
    extract::{Extension, Query, State},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use garde::Validate;
use serde::Deserialize;
use serde_json::json;
use silverhand_backend_core::{
    conversation_messaging::messaging::{NotificationId, collaboration::notification::*},
    foundation::identity::{ConversationId, UserId, WorkspaceId},
};
use std::{collections::HashMap, sync::Arc};

use crate::foundation::wire_admission::ValidatedJson;

pub const LIST_PATH: &str = "/api/notifications";
pub const UNREAD_PATH: &str = "/api/notifications/unread";
pub const READ_PATH: &str = "/api/notifications/read";

/// The mark-read request body — the closed object mirroring the TypeScript
/// `MarkNotificationsReadInputSchema`. It is an OPEN object exactly as the Zod
/// schema is (no `deny_unknown_fields`): an unknown key is stripped, never a `422`.
/// Serde owns the structure (a non-object shape or a wrong field type is a native
/// decode fault via [`ValidatedJson`]'s object-only path); the single garde rule
/// carries only the schema-level `.refine` — "specify at least one selector" — as a
/// stateless semantic refusal. Selector PRECEDENCE and the empty-string
/// falls-through are the route's derivation, not a field rule, so they are not
/// spelled twice.
#[derive(Debug, Default, Deserialize, Validate)]
#[garde(context(()))]
#[garde(allow_unvalidated)]
#[garde(custom(requires_a_selector))]
struct MarkNotificationsRead {
    id: Option<String>,
    workspace_id: Option<String>,
    conversation_id: Option<String>,
    all: Option<bool>,
}

/// The schema-level refine: at least one selector must be present and truthy. As a
/// CONTAINER rule it reads the whole struct, mirroring the TypeScript truthiness
/// exactly — an empty-string id/workspace/conversation is NOT a selector (falsy),
/// and `all` counts only when literally `true`. A blank body, an all-empty body, or
/// `{"all":false}` fails this one rule → the minimal semantic `422`.
fn requires_a_selector(body: &MarkNotificationsRead, _: &()) -> garde::Result {
    if body.selector().is_some() {
        Ok(())
    } else {
        Err(garde::Error::new(
            "must specify id, workspace_id, conversation_id, or all",
        ))
    }
}

impl MarkNotificationsRead {
    /// Resolve the committed selector by TypeScript precedence: `id`, then
    /// `workspace_id`, then `conversation_id`, then `all`. A present-but-empty string
    /// is falsy and skipped (matching the TS `if (id)` truthiness), so a
    /// higher-priority empty field falls through to the next selector rather than
    /// winning as a malformed id. A syntactically present but unparseable id yields
    /// `None` at that arm and likewise falls through — the same as an empty string —
    /// so the selector is only ever a well-formed coordinate.
    fn selector(&self) -> Option<NotificationClearSelector> {
        if let Some(value) = self.id.as_deref().filter(|value| !value.is_empty()) {
            NotificationId::parse(value)
                .ok()
                .map(NotificationClearSelector::Id)
        } else if let Some(value) = self
            .workspace_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            WorkspaceId::parse(value)
                .ok()
                .map(NotificationClearSelector::Workspace)
        } else if let Some(value) = self
            .conversation_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            ConversationId::parse(value)
                .ok()
                .map(NotificationClearSelector::Conversation)
        } else if self.all == Some(true) {
            Some(NotificationClearSelector::All)
        } else {
            None
        }
    }
}

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
            tracing::error!(error_chain=%crate::foundation::error::describe(&e),"notification list failed");
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
    match s.0.reads.unread_summary(&viewer).await{Ok(v)=>Json(json!({"total":v.total,"by_workspace":v.by_workspace.iter().map(|(k,v)|(k.as_str(),v)).collect::<HashMap<_,_>>(),"latest_by_workspace":v.latest_by_workspace.iter().map(|(k,v)|(k.as_str(),json!({"conversation_id":v.conversation.as_str(),"message_id":v.message.as_str(),"thread_root_id":v.thread_root.as_ref().map(|x|x.as_str())}))).collect::<HashMap<_,_>>() })).into_response(),Err(e)=>{tracing::error!(error_chain=%crate::foundation::error::describe(&e),"notification summary failed");internal()}}
}
async fn clear<R: NotificationReadPort, C: NotificationClearPort, A: NotificationAftermath>(
    State(s): State<NotificationState<R, C, A>>,
    principal: Option<Extension<UserId>>,
    body: Result<
        ValidatedJson<MarkNotificationsRead>,
        crate::foundation::wire_admission::ValidatedJsonRejection,
    >,
) -> Response {
    // Structure and content-type are axum's native verdict (object-only decode →
    // 400/415/422); the one garde rule collapses to the minimal semantic 422. Both
    // planes are decided BEFORE any principal or authority is touched — a
    // well-formed selector is required to reach the write, but a request that fails
    // admission never reaches the clear port or the aftermath.
    let ValidatedJson(request) = match body {
        Ok(request) => request,
        Err(rejection) => return rejection.into_response(),
    };
    // Admission guaranteed a selector exists (the refine), so this is infallible;
    // resolving it here keeps the precedence in one place.
    let Some(selector) = request.selector() else {
        return crate::foundation::wire_admission::invalid_input();
    };
    let Some(viewer) = viewer(principal) else {
        return internal();
    };
    match clear_notifications(&s.0.clears, &s.0.aftermath, viewer, selector).await {
        Ok(done) => {
            if let Some(e) = done.first_failure() {
                tracing::error!(error_chain=%crate::foundation::error::describe(e),"notification clear effect failed");
            }
            Json(json!({"marked":done.committed().marked()})).into_response()
        }
        Err(e) => {
            tracing::error!(error_chain=%crate::foundation::error::describe(&e),"notification clear failed");
            internal()
        }
    }
}
fn parse_limit(raw: Option<&str>) -> u16 {
    let Some(raw) = raw else { return 100 };
    let raw = raw.trim_start_matches(is_ecmascript_trim_whitespace);
    let (negative, digits) = if let Some(v) = raw.strip_prefix('-') {
        (true, v)
    } else {
        (false, raw.strip_prefix('+').unwrap_or(raw))
    };
    let prefix = digits
        .as_bytes()
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .copied()
        .collect::<Vec<_>>();
    if negative || prefix.is_empty() {
        return 100;
    }
    let significant = prefix
        .iter()
        .skip_while(|byte| **byte == b'0')
        .copied()
        .collect::<Vec<_>>();
    if significant.is_empty() {
        return 100;
    }
    if significant.len() > 3 || (significant.len() == 3 && significant.as_slice() > &b"500"[..]) {
        return 500;
    }
    significant
        .iter()
        .fold(0_u16, |value, byte| value * 10 + u16::from(*byte - b'0'))
}

/// ECMA-262 `StringNumericLiteral` trims exactly WhiteSpace plus
/// LineTerminator before `Number.parseInt` scans the decimal prefix. Rust's
/// Unicode whitespace set differs at FEFF and U+0085, both reachable in a URL.
fn is_ecmascript_trim_whitespace(value: char) -> bool {
    matches!(
        value,
        '\u{0009}' | '\u{000B}' | '\u{000C}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
                | '\n'
                | '\r'
    )
}
fn notification_wire(n: &Notification) -> serde_json::Value {
    json!({"id":n.id.as_str(),"kind":n.kind.as_str(),"user_id":n.user.as_ref().map(|v|v.as_str()),"agent_id":n.agent.as_ref().map(|v|v.as_str()),"workspace_id":n.workspace.as_ref().map(|v|v.as_str()),"conversation_id":n.conversation.as_ref().map(|v|v.as_str()),"message_id":n.message.as_ref().map(|v|v.as_str()),"thread_root_id":n.thread_root.as_ref().map(|v|v.as_str()),"source_workspace_id":n.source_workspace.as_ref().map(|v|v.as_str()),"source_conversation_id":n.source_conversation.as_ref().map(|v|v.as_str()),"source_message_id":n.source_message.as_ref().map(|v|v.as_str()),"payload":n.payload_json.as_deref().and_then(|v|serde_json::from_str::<serde_json::Value>(v).ok()),"read_at":n.read_at.map(NotificationTimestamp::get),"created_at":n.created_at.get()})
}
fn internal() -> Response {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal server error"})),
    )
        .into_response()
}
