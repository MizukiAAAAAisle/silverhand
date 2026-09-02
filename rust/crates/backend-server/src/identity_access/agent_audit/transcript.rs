//! `GET /api/agents/{id}/chats/{conversation_id}/messages` — the read-only full
//! transcript of one of the agent's conversations, `mode=all`.

use axum::{
    Json,
    extract::{Extension, Path, Query, State},
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
};
use serde_json::json;
use silverhand_backend_core::{
    foundation::blob_store::BlobStore,
    foundation::identity::{AgentId, ConversationId, Principal, UserId},
    identity_access::agent_audit_read::{AgentAuditEvent, AgentAuditReadModel, AgentAuditSink},
};

use super::{
    AgentAuditState, bad_request, conversation_floor, internal_error, not_found, owner_floor, wire,
};
use crate::conversation_messaging::messaging::collaboration::conversation_message_window::{
    MessageWindowQueryWire, query_refusal_wire, request,
};
use crate::foundation::error;

pub(super) async fn read<P, B, S>(
    State(state): State<AgentAuditState<P, B, S>>,
    principal: Option<Extension<UserId>>,
    Path((raw_agent, raw_conversation)): Path<(String, String)>,
    uri: Uri,
) -> Response
where
    P: AgentAuditReadModel,
    B: BlobStore,
    S: AgentAuditSink,
{
    let Some(Extension(viewer)) = principal else {
        tracing::error!("agent-audit transcript route reached without its human principal fact");
        return internal_error();
    };
    let principal = Principal::human(viewer.clone());

    let Ok(agent) = AgentId::parse(raw_agent) else {
        return not_found();
    };
    let conversation = match ConversationId::parse(raw_conversation) {
        Ok(value) => value,
        Err(_) => return bad_request("conversation id required"),
    };

    // Stage A: the cheap owner/visibility floor, before the cursor is parsed. A
    // non-owner is refused here — the per-conversation participation fact is not yet
    // read, so it cannot leak.
    match state.port.read_audit_subject(&agent).await {
        Ok(Some(subject)) => {
            if let Err(refusal) = owner_floor(&principal, &agent, &subject) {
                return *refusal;
            }
        }
        Ok(None) => return not_found(),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "agent-audit subject floor read failed"
            );
            return internal_error();
        }
    }

    // The cursor is parsed ONLY after the Stage A owner floor has passed: the query is
    // an axum extractor no longer, so a malformed or duplicate cursor cannot pre-empt
    // the owner refusal — a non-owner with a broken query still sees the owner `403`,
    // never a query `400`. The raw-query admission then uses the SAME form/first-
    // occurrence grammar as the authenticated window.
    let mut query = match Query::<MessageWindowQueryWire>::try_from_uri(&uri) {
        Ok(Query(value)) => value,
        Err(rejection) => return rejection.into_response(),
    };
    // The audit transcript is `mode=all` and carries no thread-stream selector, so a
    // client's `thread_root_id` (even an empty one) is dropped rather than rejected —
    // matching the TypeScript audit route, which never reads the token.
    query.thread_root_id = None;
    let request = match request(&query) {
        Ok(value) => value,
        Err(refusal) => return query_refusal_wire(refusal),
    };

    // Stage B: the subject and participation facts and the window on ONE snapshot; the
    // shared per-conversation gate is decided IN that transaction on the freshly-read
    // facts, and the window is read only when it allows — so `principal` rides down.
    let bundle = match state
        .port
        .read_audit_transcript(&principal, &agent, &conversation, &request)
        .await
    {
        Ok(Some(bundle)) => bundle,
        Ok(None) => return not_found(),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "agent-audit transcript read failed"
            );
            return internal_error();
        }
    };

    // Map the fresh verdict to the wire FIRST: an absent conversation (`exists: false`)
    // or a non-owner folds into the one owner `403`/`404` here, decided before the
    // coordinate or window is inspected, so a denied caller never depends on either.
    if let Err(refusal) = conversation_floor(&principal, &agent, bundle.subject(), bundle.audited())
    {
        return *refusal;
    }

    // The gate allowed ⟹ the conversation exists ⟹ its coordinate was decoded from the
    // stored `conversations.id`. Bind that decoded id to the requested one: a mismatch
    // (or a missing coordinate behind an allow) is a resolver defect — the gate would
    // judge one row and the wire render another — so it takes the lane's safe `500`.
    match bundle.conversation() {
        Some(resolved) if resolved == &conversation => {}
        _ => {
            tracing::error!(
                requested = conversation.as_str(),
                resolved = bundle.conversation().map(ConversationId::as_str),
                "agent-audit transcript resolved for the wrong conversation"
            );
            return internal_error();
        }
    }

    // The gate has allowed: only now is an out-of-conversation anchor revealed, as the
    // post-gate 404 — never a probe a non-owner could reach.
    let Some(window) = bundle.window() else {
        return anchor_not_found();
    };
    let body = match wire::transcript_response(window) {
        Ok(value) => value,
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "agent-audit transcript wire projection failed"
            );
            return internal_error();
        }
    };

    // Success emits exactly one audit event; every refusal above emitted none.
    state.audit.record(AgentAuditEvent::TranscriptRead {
        viewer,
        agent_id: agent,
        conversation_id: conversation,
        message_count: window.messages().len() as u64,
    });
    Json(body).into_response()
}

/// The post-gate 404 for an `around_message_id` that is not in the conversation,
/// coded identically to the authenticated message-window face.
fn anchor_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": "around_message_id not found in this conversation",
            "code": "message_not_found",
        })),
    )
        .into_response()
}
