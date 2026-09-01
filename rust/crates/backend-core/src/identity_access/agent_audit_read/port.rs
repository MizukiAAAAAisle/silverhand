//! The agent-audit read port trait.
//!
//! Kept out of the namespace `mod.rs` (which declares and re-exports only): the
//! three faces are read on ONE deferred snapshot that carries BOTH the facts its gate
//! is decided against AND the data it projects. The gate is decided INSIDE that
//! snapshot — the shared `capability::agent_audit` verdict runs against the
//! freshly-read facts BEFORE any window/list/attachment row is read — so a refusal can
//! never be rewritten into a `500` by a fault in the data layer of a target the caller
//! may not audit, and there is no TOCTOU or ACL/data splice. The route re-runs the same
//! capability to MAP the verdict to the wire (404 vs 403), never to reach the data.

use std::future::Future;

use crate::{
    foundation::identity::{AgentId, ConversationId, Principal},
    foundation::persistence::PersistenceFailure,
    messaging::{
        AttachmentId, collaboration::conversation_message_window::ConversationMessageWindowRequest,
    },
};

use super::{AuditAttachmentBundle, AuditChatsBundle, AuditSubjectFacts, AuditTranscriptBundle};

/// Loads the source-bound facts each owner-audit face needs, one snapshot per read.
///
/// Every method returns `None` when the agent row is absent — a fact the route renders
/// as the anti-enum 404, never a failed read. The three data reads take the `principal`
/// so the shared core capability can be decided IN the read's own transaction: the
/// sensitive data (chat list, message window, attachment row) is read only when that
/// verdict allows, so a denied caller reaches zero of it. The per-conversation faces
/// still return a bundle when the agent exists but the conversation does not: the bundle
/// carries `exists: false`, and the route folds that into the one 403 an owner sees for
/// any conversation they may not audit.
pub trait AgentAuditReadModel {
    /// Stage A: the cheap owner/visibility floor read, before any query is parsed. This
    /// carries no principal — it returns facts the route's floor decides against.
    fn read_audit_subject(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Option<AuditSubjectFacts>, PersistenceFailure>> + Send;

    /// Stage B (list): the subject facts, plus every chat summary ONLY when
    /// `can_audit_agent_chats` allows on this snapshot's facts — otherwise the list is
    /// left unread and empty, so a fresh non-owner reaches no row.
    fn read_audit_chats(
        &self,
        principal: &Principal,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Option<AuditChatsBundle>, PersistenceFailure>> + Send;

    /// Stage B (transcript): the subject and participation facts, plus the message
    /// window ONLY when `can_audit_agent_conversation` allows on this snapshot's facts.
    fn read_audit_transcript(
        &self,
        principal: &Principal,
        agent: &AgentId,
        conversation: &ConversationId,
        request: &ConversationMessageWindowRequest,
    ) -> impl Future<Output = Result<Option<AuditTranscriptBundle>, PersistenceFailure>> + Send;

    /// Stage B (attachment): the subject and participation facts, plus the attachment
    /// row bound to the conversation ONLY when `can_audit_agent_conversation` allows on
    /// this snapshot's facts. The blob bytes are NOT read here — only the coordinate —
    /// so the store is never touched before the gate.
    fn read_audit_attachment(
        &self,
        principal: &Principal,
        agent: &AgentId,
        conversation: &ConversationId,
        attachment: &AttachmentId,
    ) -> impl Future<Output = Result<Option<AuditAttachmentBundle>, PersistenceFailure>> + Send;
}
