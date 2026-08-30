//! The audit-evidence emission seam.
//!
//! Each owner-audit face, on a SUCCESS that both passed the gate and read its data,
//! emits exactly one typed event; any refusal or read/blob failure emits none. This
//! is the functional audit-evidence contract (#task:2254), not incidental logging.
//!
//! The sink is a typed port, deliberately NOT a raw `tracing` call: a durable,
//! queryable structured-audit backing is owned by #task:2256, and this trait is the
//! consumption seam it will implement. In #task:2254 the route is composed with this
//! port UNMOUNTED — no production backing is wired — and the effect is proven with a
//! counting fake. The event shape is minimal on purpose; #task:2256 owns the durable
//! representation and may adapt this seam when it lands.

use crate::identity::{AgentId, ConversationId, UserId};
use crate::messaging::AttachmentId;

/// One audit-evidence record, emitted after a face succeeds.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentAuditEvent {
    /// `GET /api/agents/{id}/chats` succeeded: the owner listed the agent's chats.
    ChatsListed {
        viewer: UserId,
        agent_id: AgentId,
        chat_count: u64,
    },
    /// `GET /api/agents/{id}/chats/{conversation}/messages` succeeded.
    TranscriptRead {
        viewer: UserId,
        agent_id: AgentId,
        conversation_id: ConversationId,
        message_count: u64,
    },
    /// `GET /api/agents/{id}/chats/{conversation}/attachments/{attachment}` served bytes.
    AttachmentRead {
        viewer: UserId,
        agent_id: AgentId,
        conversation_id: ConversationId,
        attachment_id: AttachmentId,
    },
}

/// Records one audit-evidence event. Cloneable and shareable so it can live in an
/// axum router's state; the recording itself is fire-and-forget from the route's
/// point of view — a durable sink (#task:2256) buffers or persists behind this call.
pub trait AgentAuditSink: Clone + Send + Sync + 'static {
    fn record(&self, event: AgentAuditEvent);
}
