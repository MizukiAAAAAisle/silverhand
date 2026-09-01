//! The chats-list bundle: the audited agent's conversations, each summarized as one
//! discriminated arm, read on the SAME snapshot as the subject facts that gate them.
//!
//! The summary is a closed union on placement, NOT one wide row with nullable
//! workspace/counterpart fields: a workspace chat has a title, roster policy and
//! workspace coordinates; a direct-pair chat has a counterpart and a read-only flag.
//! A single struct with everything nullable could express a workspace arm beside a
//! counterpart, which the contract does not admit.

use crate::{
    direct_pair_read::DirectPairCounterpart,
    foundation::identity::{ConversationId, WorkspaceId},
    messaging::collaboration::conversation_ref::ConversationRosterPolicy,
};

use super::subject::AuditSubjectFacts;

/// One conversation the audited agent takes part in, summarized for the owner list.
///
/// Order is the SQL's creation order (oldest first); no arm carries an activity or
/// unread fact, because the audit list is viewer-neutral.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuditChatSummary {
    /// A workspace channel the agent is a roster member of.
    Workspace {
        conversation_id: ConversationId,
        roster_policy: ConversationRosterPolicy,
        title: String,
        workspace_id: WorkspaceId,
        workspace_name: String,
        archived_at: Option<i64>,
        created_at: i64,
    },
    /// A direct pair one of whose endpoints is the agent. The `counterpart` is the
    /// OTHER endpoint, resolved to its active profile or its deleted coordinate.
    DirectPair {
        conversation_id: ConversationId,
        counterpart: DirectPairCounterpart,
        read_only: bool,
        archived_at: Option<i64>,
        created_at: i64,
    },
}

/// The chats-list read, sealed to the subject facts it is gated against.
///
/// The handler re-runs `can_audit_agent_chats` on [`subject`](Self::subject) —
/// freshly read on the same snapshot as [`chats`](Self::chats) — before it projects
/// a single row, so a subject that changed owner between the anti-enum floor and this
/// read is judged on this read's facts, not the floor's.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditChatsBundle {
    subject: AuditSubjectFacts,
    chats: Vec<AuditChatSummary>,
}

impl AuditChatsBundle {
    pub fn from_source(subject: AuditSubjectFacts, chats: Vec<AuditChatSummary>) -> Self {
        Self { subject, chats }
    }

    pub fn subject(&self) -> &AuditSubjectFacts {
        &self.subject
    }

    pub fn chats(&self) -> &[AuditChatSummary] {
        &self.chats
    }
}
