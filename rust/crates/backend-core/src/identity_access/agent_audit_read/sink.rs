//! The audit-evidence emission seam.
//!
//! Each owner-audit face, on a SUCCESS that both passed the gate and read its data,
//! emits exactly one typed event; any refusal or read/blob failure emits none. This
//! is the functional audit-evidence contract (#task:2254), not incidental logging.
//!
//! The sink is a typed port, deliberately NOT a raw `tracing` call. Backend-app injects
//! the production `silverhand_backend_filesystem::audit_sink::AgentAuditFileSink`, whose
//! flat, queryable JSONL projection reuses the shared categorized writer. This core crate
//! retains only the event and port contract; counting fakes remain available to prove the
//! route effect without importing filesystem policy.

use crate::conversation_messaging::messaging::AttachmentId;
use crate::foundation::identity::{AgentId, ConversationId, UserId};

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
