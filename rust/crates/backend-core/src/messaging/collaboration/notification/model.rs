use crate::{
    identity::{AgentId, ConversationId, UserId, WorkspaceId},
    messaging::{MessageId, ThreadRootId},
};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NotificationId(String);
impl NotificationId {
    pub fn parse(raw: impl Into<String>) -> Option<Self> {
        let raw = raw.into();
        (!raw.is_empty()).then_some(Self(raw))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotificationKind {
    MentionExternal,
    MentionSelf,
    AgentStartFailed,
}
impl NotificationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MentionExternal => "mention_external",
            Self::MentionSelf => "mention_self",
            Self::AgentStartFailed => "agent_start_failed",
        }
    }
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "mention_external" => Some(Self::MentionExternal),
            "mention_self" => Some(Self::MentionSelf),
            "agent_start_failed" => Some(Self::AgentStartFailed),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NotificationTimestamp(i64);
impl NotificationTimestamp {
    pub fn new(value: i64) -> Option<Self> {
        (value >= 0).then_some(Self(value))
    }
    pub fn get(self) -> i64 {
        self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Notification {
    pub id: NotificationId,
    pub kind: NotificationKind,
    pub user: Option<UserId>,
    pub agent: Option<AgentId>,
    pub workspace: Option<WorkspaceId>,
    pub conversation: Option<ConversationId>,
    pub message: Option<MessageId>,
    pub thread_root: Option<ThreadRootId>,
    pub source_workspace: Option<WorkspaceId>,
    pub source_conversation: Option<ConversationId>,
    pub source_message: Option<MessageId>,
    /// Canonical JSON object text, validated by the persistence adapter.
    pub payload_json: Option<String>,
    pub read_at: Option<NotificationTimestamp>,
    pub created_at: NotificationTimestamp,
}
