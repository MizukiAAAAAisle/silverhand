//! Workspace-conversation identity projection.
//!
//! This is deliberately narrower than a generic conversation descriptor.  A
//! direct pair has its own complete identity face and cannot be represented by
//! this value, even when its human endpoint may read that conversation.

use std::{error::Error, future::Future};

use crate::identity::{ConversationId, UserId, WorkspaceId};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationRosterPolicy {
    Open,
    Fixed,
}

impl ConversationRosterPolicy {
    pub fn parse(value: &str) -> Result<Self, UnknownConversationRosterPolicy> {
        match value {
            "open" => Ok(Self::Open),
            "fixed" => Ok(Self::Fixed),
            _ => Err(UnknownConversationRosterPolicy),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Fixed => "fixed",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stored conversation roster policy is outside the published closed set")]
pub struct UnknownConversationRosterPolicy;

/// The workspace-only portion of a conversation reference.
///
/// The requested conversation id is intentionally not repeated here.  The
/// authenticated handler owns that coordinate, so a faulty port cannot answer a
/// lookup for conversation A with conversation B's identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceConversationRef {
    roster: ConversationRosterPolicy,
    title: String,
    workspace: WorkspaceId,
    closed_at: Option<i64>,
    archived_at: Option<i64>,
}

impl WorkspaceConversationRef {
    pub fn projected(
        roster: ConversationRosterPolicy,
        title: String,
        workspace: WorkspaceId,
        closed_at: Option<i64>,
        archived_at: Option<i64>,
    ) -> Self {
        Self {
            roster,
            title,
            workspace,
            closed_at,
            archived_at,
        }
    }

    pub const fn roster(&self) -> ConversationRosterPolicy {
        self.roster
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn workspace(&self) -> &WorkspaceId {
        &self.workspace
    }

    pub const fn closed_at(&self) -> Option<i64> {
        self.closed_at
    }

    pub const fn archived_at(&self) -> Option<i64> {
        self.archived_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ConversationRefRefusal {
    #[error("conversation not found")]
    NotFound,
    #[error("viewer cannot read conversation")]
    Forbidden,
}

pub trait ConversationRefReadPort {
    type Error: Error + Send + Sync + 'static;

    fn resolve(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> impl Future<
        Output = Result<Result<WorkspaceConversationRef, ConversationRefRefusal>, Self::Error>,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roster_tokens_are_one_owned_bijection() {
        for (token, policy) in [
            ("open", ConversationRosterPolicy::Open),
            ("fixed", ConversationRosterPolicy::Fixed),
        ] {
            assert_eq!(ConversationRosterPolicy::parse(token), Ok(policy));
            assert_eq!(policy.as_str(), token);
        }
        assert!(ConversationRosterPolicy::parse("public").is_err());
    }

    #[test]
    fn workspace_face_cannot_express_a_direct_pair_or_a_second_conversation_id() {
        let value = WorkspaceConversationRef::projected(
            ConversationRosterPolicy::Open,
            "General".to_owned(),
            WorkspaceId::parse("w").unwrap(),
            None,
            Some(7),
        );
        assert_eq!(value.workspace().as_str(), "w");
        assert_eq!(value.roster().as_str(), "open");
        assert_eq!(value.archived_at(), Some(7));
    }
}
