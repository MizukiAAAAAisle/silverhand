//! `GET /api/agents/{id}/chats` — the owner-audit list of an agent's conversations.

use axum::{
    Json,
    extract::{Extension, Path, State},
    response::{IntoResponse, Response},
};
use silverhand_backend_core::{
    foundation::blob_store::BlobStore,
    identity::{AgentId, Principal, UserId},
    identity_access::agent_audit_read::{AgentAuditEvent, AgentAuditReadModel, AgentAuditSink},
};

use super::{AgentAuditState, internal_error, not_found, owner_floor, wire};
use crate::error;

pub(super) async fn list<P, B, S>(
    State(state): State<AgentAuditState<P, B, S>>,
    principal: Option<Extension<UserId>>,
    Path(raw_agent): Path<String>,
) -> Response
where
    P: AgentAuditReadModel,
    B: BlobStore,
    S: AgentAuditSink,
{
    let Some(Extension(viewer)) = principal else {
        tracing::error!("agent-audit chats route reached without its human principal fact");
        return internal_error();
    };
    let principal = Principal::human(viewer.clone());

    // A malformed id names no agent — the same anti-enum 404 an absent row gets.
    let Ok(agent) = AgentId::parse(raw_agent) else {
        return not_found();
    };

    // Stage A: the cheap owner/visibility floor, so a stranger is refused before the
    // full chats read runs.
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

    // Stage B: the subject facts and every chat summary on ONE snapshot; the owner gate
    // is decided IN that transaction on the freshly-read facts and the list is read only
    // when it allows, so `principal` rides down. The floor re-runs here to MAP the
    // verdict to the wire (a fresh non-owner sees the empty list gate as `403`).
    let bundle = match state.port.read_audit_chats(&principal, &agent).await {
        Ok(Some(bundle)) => bundle,
        Ok(None) => return not_found(),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "agent-audit chats read failed"
            );
            return internal_error();
        }
    };
    if let Err(refusal) = owner_floor(&principal, &agent, bundle.subject()) {
        return *refusal;
    }

    let body = wire::chats_response(&bundle);
    // Success emits exactly one audit event; every refusal above emitted none.
    state.audit.record(AgentAuditEvent::ChatsListed {
        viewer,
        agent_id: agent,
        chat_count: bundle.chats().len() as u64,
    });
    Json(body).into_response()
}
