//! Agent audit read port. Named `agent_audit_read` — kept distinct from the existing
//! `capability::agent_audit` decision vocabulary — so the two are not conflated: this
//! is the source-bound projection that answers the owner-audit routes, with a
//! same-named SQLite adapter.
//!
//! Three faces, one shape. Each is read on ONE deferred snapshot as a source-bound
//! bundle that carries BOTH the facts its gate is decided against ([`AuditSubjectFacts`],
//! and for the two per-conversation faces an [`AuditedConversation`]) AND the data it
//! projects. The route re-runs the `capability::agent_audit` gate on the bundle's own
//! freshly-read facts before it projects or reads a blob, so there is no window between
//! the gate and the read for the facts to change under — no TOCTOU, and no ACL/data
//! splice.

mod attachment;
mod chats;
mod floor;
mod port;
mod sink;
mod subject;
mod transcript;

pub use attachment::AuditAttachmentBundle;
pub use chats::{AuditChatSummary, AuditChatsBundle};
pub use floor::{AuditFloorVerdict, audit_chats_floor, audit_conversation_floor};
pub use port::AgentAuditReadModel;
pub use sink::{AgentAuditEvent, AgentAuditSink};
pub use subject::AuditSubjectFacts;
pub use transcript::{AuditTranscriptBundle, AuditTranscriptWindow};
