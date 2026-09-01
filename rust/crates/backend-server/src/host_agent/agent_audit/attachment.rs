//! `GET /api/agents/{id}/chats/{conversation_id}/attachments/{attachment_id}` — the
//! raw bytes of one attachment inside an audited conversation, read-only.

use axum::{
    extract::{Extension, Path, State},
    response::Response,
};
use silverhand_backend_core::{
    conversation_messaging::messaging::AttachmentId,
    foundation::blob_store::{BlobReadOutcome, BlobStore},
    foundation::identity::{AgentId, ConversationId, Principal, UserId},
    identity_access::agent_audit_read::{AgentAuditEvent, AgentAuditReadModel, AgentAuditSink},
};

use super::{
    AgentAuditState, attachment_not_found, bad_request, conversation_floor, internal_error,
    not_found, owner_floor,
};
use crate::foundation::error;
use crate::messaging::collaboration::attachment::download_success;

pub(super) async fn download<P, B, S>(
    State(state): State<AgentAuditState<P, B, S>>,
    principal: Option<Extension<UserId>>,
    Path((raw_agent, raw_conversation, raw_attachment)): Path<(String, String, String)>,
) -> Response
where
    P: AgentAuditReadModel,
    B: BlobStore,
    S: AgentAuditSink,
{
    let Some(Extension(viewer)) = principal else {
        tracing::error!("agent-audit attachment route reached without its human principal fact");
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
    let attachment = match AttachmentId::parse(raw_attachment) {
        Ok(value) => value,
        Err(_) => return bad_request("attachment id required"),
    };

    // Stage A: the cheap owner/visibility floor, before the row coordinate is read.
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

    // Stage B: the subject and participation facts and the attachment row bound to the
    // conversation on ONE snapshot; the shared per-conversation gate is decided IN that
    // transaction on the freshly-read facts and the row is loaded only when it allows,
    // so `principal` rides down and the blob store is never touched before the gate.
    let bundle = match state
        .port
        .read_audit_attachment(&principal, &agent, &conversation, &attachment)
        .await
    {
        Ok(Some(bundle)) => bundle,
        Ok(None) => return not_found(),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "agent-audit attachment read failed"
            );
            return internal_error();
        }
    };

    // Map the fresh verdict to the wire FIRST: an absent conversation (`exists: false`)
    // or a non-owner folds into the one owner `403`/`404` here, decided before the
    // coordinate or row is inspected, so a denied caller never depends on either.
    if let Err(refusal) = conversation_floor(&principal, &agent, bundle.subject(), bundle.audited())
    {
        return *refusal;
    }

    // The gate allowed ⟹ the conversation exists ⟹ its coordinate was decoded from the
    // stored `conversations.id`. Bind that decoded id to the requested one: a mismatch
    // (or a missing coordinate behind an allow) is a resolver defect — the lane's safe
    // `500`, never a product `404`.
    match bundle.conversation() {
        Some(resolved) if resolved == &conversation => {}
        _ => {
            tracing::error!(
                requested = conversation.as_str(),
                resolved = bundle.conversation().map(ConversationId::as_str),
                "agent-audit attachment resolved for the wrong conversation"
            );
            return internal_error();
        }
    }

    // Only now — after the gate allows — is the row's presence revealed. A row that is
    // absent or belongs to another conversation is ONE post-gate 404 with the blob
    // store never touched, so this face reaches no bytes outside the audited chat.
    let Some(record) = bundle.attachment() else {
        return attachment_not_found();
    };

    // The row is legal; a blob-storage fault is a lane 500, distinct from the row-level
    // 404 above.
    let read = match state.blobs.read(record.blob()).await {
        Ok(BlobReadOutcome::Found(read)) => read,
        Ok(BlobReadOutcome::Missing) => {
            tracing::error!(
                attachment = attachment.as_str(),
                "audited attachment blob is missing"
            );
            return internal_error();
        }
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "agent-audit attachment blob read failed"
            );
            return internal_error();
        }
    };
    if i64::try_from(read.actual_size()).ok() != Some(record.size().get()) {
        tracing::error!(
            attachment = attachment.as_str(),
            expected = record.size().get(),
            actual = read.actual_size(),
            "audited attachment blob size differs from committed row"
        );
        return internal_error();
    }

    let response = download_success(record, read.into_bytes());
    // Success emits exactly one audit event; every refusal and failure above emitted
    // none.
    state.audit.record(AgentAuditEvent::AttachmentRead {
        viewer,
        agent_id: agent,
        conversation_id: conversation,
        attachment_id: attachment,
    });
    response
}
