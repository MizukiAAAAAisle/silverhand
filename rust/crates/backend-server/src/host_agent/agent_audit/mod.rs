//! Owner-audit routes — a submodule of the public-agent management plane
//! (`host_agent`), not a new top-level concept (#task:2254).
//!
//! Three read faces, one owner, one ladder:
//!
//!  * `GET /api/agents/{id}/chats` — the list of every conversation the agent is a
//!    party to ([`chats`]).
//!  * `GET /api/agents/{id}/chats/{conversation_id}/messages` — one conversation's
//!    full transcript, `mode=all` ([`transcript`]).
//!  * `GET /api/agents/{id}/chats/{conversation_id}/attachments/{attachment_id}` —
//!    the raw bytes of one attachment inside an audited conversation ([`attachment`]).
//!
//! Each face runs the SAME two-stage source-bound gate. Stage A is a cheap
//! anti-enum floor read ([`AgentAuditReadModel::read_audit_subject`]) BEFORE any
//! query is parsed: an absent row and a caller outside the visibility ACL both
//! collapse to one `404 {"error":"agent not found"}` ([`owner_floor`] via
//! [`can_view_agent`]), and a viewer who is not the creator is refused `403` before
//! the expensive data read runs. Stage B reads the gate facts TOGETHER WITH the data
//! on ONE deferred snapshot and RE-RUNS the gate on those freshly-read facts, so
//! there is no window for the facts to change between the decision and the read — no
//! TOCTOU, and no ACL/data splice. Only an allowed read that also succeeds emits its
//! one typed audit event ([`AgentAuditSink`]); every refusal and every read/blob
//! failure emits none.
//!
//! The audit sink is composed UNMOUNTED here (#task:2254): no production backing is
//! wired, and #task:2256 owns the durable structured-audit representation this seam
//! will feed. The composition-root mount of [`router`] is the packaging context's
//! job, not this factory's.

use std::sync::Arc;

use axum::{
    Json, Router,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use silverhand_backend_core::{
    agent_audit_read::{
        AgentAuditReadModel, AgentAuditSink, AuditFloorVerdict, AuditSubjectFacts,
        audit_chats_floor, audit_conversation_floor,
    },
    blob_store::BlobStore,
    capability::agent_audit::AuditedConversation,
    identity::{AgentId, Principal},
};

mod attachment;
mod chats;
mod transcript;
mod wire;

#[cfg(test)]
mod tests;

/// Product route templates, in axum's `{name}` capture syntax.
pub const AGENT_CHATS_PATH: &str = "/api/agents/{id}/chats";
pub const AGENT_CHAT_TRANSCRIPT_PATH: &str = "/api/agents/{id}/chats/{conversation_id}/messages";
pub const AGENT_CHAT_ATTACHMENT_PATH: &str =
    "/api/agents/{id}/chats/{conversation_id}/attachments/{attachment_id}";

/// The anti-enumeration refusal string, pinned to the TypeScript handler
/// (`c.json({ error: 'agent not found' }, 404)`) so a fixture drift shows here.
const AGENT_NOT_FOUND: &str = "agent not found";

/// The owner-gate refusal string, pinned to the TypeScript audit handler
/// (`c.json({ error: 'forbidden' }, 403)`).
const FORBIDDEN: &str = "forbidden";

/// The attachment-absent refusal string, pinned to the TypeScript audit handler
/// (`c.json({ error: 'attachment not found' }, 404)`).
const ATTACHMENT_NOT_FOUND: &str = "attachment not found";

/// The unmapped-error body: the product route registers no `onError`, so an
/// unexpected failure falls to the framework default — a `500` with a bare
/// `text/plain` `Internal Server Error`, never a JSON envelope.
const INTERNAL_ERROR_BODY: &str = "Internal Server Error";

struct AgentAuditState<P, B, S> {
    pub(super) port: Arc<P>,
    pub(super) blobs: B,
    pub(super) audit: S,
}

impl<P, B: Clone, S: Clone> Clone for AgentAuditState<P, B, S> {
    fn clone(&self) -> Self {
        Self {
            port: Arc::clone(&self.port),
            blobs: self.blobs.clone(),
            audit: self.audit.clone(),
        }
    }
}

pub fn router<P, B, S>(port: P, blobs: B, audit: S) -> Router
where
    P: AgentAuditReadModel + Send + Sync + 'static,
    B: BlobStore,
    S: AgentAuditSink,
{
    Router::new()
        .route(AGENT_CHATS_PATH, get(chats::list::<P, B, S>))
        .route(AGENT_CHAT_TRANSCRIPT_PATH, get(transcript::read::<P, B, S>))
        .route(
            AGENT_CHAT_ATTACHMENT_PATH,
            get(attachment::download::<P, B, S>),
        )
        .with_state(AgentAuditState {
            port: Arc::new(port),
            blobs,
            audit,
        })
}

/// Maps the shared owner-audit floor verdict — source-bind (`500`), active-stage
/// `can_view_agent` (`404`), then `can_audit_agent_chats` (`403`) — to its wire refusal,
/// or `Ok(())` for the creator. The SAME [`audit_chats_floor`] the adapter gates its data
/// read with is re-run here on the bundle's own facts, so the projection is mapped by the
/// exact ladder it was read beside; this function only renders, it decides nothing new.
fn owner_floor(
    principal: &Principal,
    agent: &AgentId,
    subject: &AuditSubjectFacts,
) -> Result<(), Box<Response>> {
    floor_response(audit_chats_floor(principal, agent, subject), agent, subject)
}

/// The per-conversation analogue: the same source-bind/`404` prefix, then
/// `can_audit_agent_conversation` (`403`), which folds "conversation absent" and "agent
/// not a party" into ONE owner refusal so a guessed id is no existence oracle. Re-runs
/// the shared [`audit_conversation_floor`] the adapter gated its read with.
fn conversation_floor(
    principal: &Principal,
    agent: &AgentId,
    subject: &AuditSubjectFacts,
    audited: AuditedConversation,
) -> Result<(), Box<Response>> {
    floor_response(
        audit_conversation_floor(principal, agent, subject, audited),
        agent,
        subject,
    )
}

/// Renders one floor verdict to its wire refusal. A `SourceMismatch` is a resolver defect
/// — the gate would judge one row and the wire render another — so it takes the lane's
/// safe `500`, never a product `404`.
fn floor_response(
    verdict: AuditFloorVerdict,
    agent: &AgentId,
    subject: &AuditSubjectFacts,
) -> Result<(), Box<Response>> {
    match verdict {
        AuditFloorVerdict::Allow => Ok(()),
        AuditFloorVerdict::SourceMismatch => {
            tracing::error!(
                requested = agent.as_str(),
                resolved = subject.source().as_str(),
                "agent-audit bundle resolved for the wrong agent"
            );
            Err(Box::new(internal_error()))
        }
        AuditFloorVerdict::NotVisible => Err(Box::new(not_found())),
        AuditFloorVerdict::AuditDenied => Err(Box::new(forbidden())),
    }
}

/// The flat refusal body, mirroring the product `{ "error": ... }`.
#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: AGENT_NOT_FOUND,
        }),
    )
        .into_response()
}

fn attachment_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: ATTACHMENT_NOT_FOUND,
        }),
    )
        .into_response()
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(ErrorBody { error: FORBIDDEN })).into_response()
}

/// A `400 {"error": ...}` for a path coordinate that does not parse. A malformed
/// conversation or attachment id is malformed for every caller, so this reveals no
/// existence fact — unlike the agent id, whose parse failure folds into the anti-enum
/// `404` so an unparseable id is indistinguishable from an absent one.
fn bad_request(error: &'static str) -> Response {
    (StatusCode::BAD_REQUEST, Json(ErrorBody { error })).into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY).into_response()
}
